/**
 * The build-time half: reads the migration files in the order Wrangler applies them, splits each
 * into statements with Wrangler's own splitter, and writes a module the Worker imports and passes
 * to `migrateD1()`. Runs in Node, with `wrangler` installed in the project.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listMigrationFiles, type MigrationFile, type MigrationsSource } from "./files.js";
import { DEFAULT_MIGRATIONS_TABLE, type D1Migration } from "./index.js";

export { compareMigrationPaths, listMigrationFiles } from "./files.js";
export type { MigrationFile, MigrationFiles, MigrationsSource } from "./files.js";

export type ReadD1MigrationsOptions = MigrationsSource & {
  /** The binding's `migrations_table`. Default `d1_migrations`. */
  table?: string;
};

export type BundleD1MigrationsOptions = ReadD1MigrationsOptions & {
  /**
   * The module to write, relative to `cwd`. A `.ts` file gets type annotations; any other gets
   * plain JavaScript with a JSDoc type.
   */
  out: string;
};

export type BundleD1MigrationsResult = {
  /** The module's absolute path. */
  out: string;
  table: string;
  migrations: D1Migration[];
  /** Whether the module changed. An unchanged module is not written, so no watcher wakes. */
  changed: boolean;
};

/**
 * The migrations of `options`, in the order `wrangler d1 migrations apply` applies them, each split
 * into the statements that command runs. Throws when a migration's last statement is not complete
 * (a missing semicolon, or an unclosed comment, string or trigger body): Wrangler would run it
 * together with the statement that records the migration.
 */
export async function readD1Migrations(
  options: ReadD1MigrationsOptions = {},
): Promise<D1Migration[]> {
  return readFiles(listMigrationFiles(options).files, options.table ?? DEFAULT_MIGRATIONS_TABLE);
}

/**
 * Reads the migrations ({@link readD1Migrations}) and writes them to `out` as a module whose default
 * export goes straight to `migrateD1()`: `{ table, migrations }`. It also exports `table` and
 * `migrations` by name, the shape `applyD1Migrations()` from `cloudflare:test` takes.
 */
export async function bundleD1Migrations(
  options: BundleD1MigrationsOptions,
): Promise<BundleD1MigrationsResult> {
  const cwd = path.resolve(options.cwd ?? ".");
  const out = path.resolve(cwd, options.out);
  const table = options.table ?? DEFAULT_MIGRATIONS_TABLE;
  const { dir, files } = listMigrationFiles({ ...options, cwd });
  const migrations = await readFiles(files, table);
  const source = renderModule({
    table,
    migrations,
    from: `${(path.relative(cwd, dir) || ".").replace(/\\/g, "/")}/`,
    typescript: /\.[cm]?tsx?$/.test(out),
  });
  const previous = await readFile(out, "utf8").catch(() => undefined);
  if (previous !== source) {
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, source);
  }
  return { out, table, migrations, changed: previous !== source };
}

type SplitSql = (sql: string) => string[];

async function readFiles(files: MigrationFile[], table: string): Promise<D1Migration[]> {
  const split = await wranglerSplitter();
  const migrations: D1Migration[] = [];
  for (const file of files)
    migrations.push({
      name: file.name,
      queries: splitMigration(split, file.name, await readFile(file.path, "utf8"), table),
    });
  return migrations;
}

async function wranglerSplitter(): Promise<SplitSql> {
  let wrangler: { unstable_splitSqlQuery?: unknown };
  try {
    wrangler = await import("wrangler");
  } catch (error) {
    throw new Error(
      "@rivi-software/d1-migrations splits migrations with Wrangler's splitter: install wrangler 4 in this project.",
      { cause: error },
    );
  }
  if (typeof wrangler.unstable_splitSqlQuery !== "function")
    throw new Error(
      "This version of Wrangler does not export unstable_splitSqlQuery, which @rivi-software/d1-migrations splits migrations with. Install the Wrangler version the package's README names, and report the issue at https://github.com/rivi-software/tools/issues.",
    );
  return wrangler.unstable_splitSqlQuery as SplitSql;
}

/**
 * The statements `wrangler d1 migrations apply --local` runs for a migration, without the one that
 * records it. Wrangler adds `INSERT INTO <table> (name) values ('<name>');` on a new line after the
 * migration's text and splits the two together, so this does too, then takes the INSERT off again.
 */
function splitMigration(split: SplitSql, name: string, sql: string, table: string): string[] {
  const record = `INSERT INTO "${table.replace(/"/g, '""')}" (name)\nvalues ('${name.replace(/'/g, "''")}')`;
  const statements = split(`${sql}\n${record};`);
  // A text with one statement comes back whole, its semicolon included; several come back trimmed,
  // without theirs. A comment after the migration's last statement stays with the INSERT.
  const last = (statements.pop() ?? "").trim().replace(/;$/, "");
  if (!last.endsWith(record) || !isBlank(last.slice(0, -record.length)))
    throw new Error(
      `Migration ${name} does not end with a complete statement: its last statement lacks a semicolon, or a comment, string or trigger body is left open. wrangler d1 migrations apply would run it together with the INSERT that records the migration.`,
    );
  return statements;
}

/** Whether `sql` holds nothing but whitespace and comments. */
function isBlank(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) index++;
    else if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 2;
    } else return false;
  }
  return true;
}

function renderModule(input: {
  table: string;
  migrations: D1Migration[];
  from: string;
  typescript: boolean;
}): string {
  const string = (value: string) => JSON.stringify(value);
  const items = input.migrations.map((migration) => {
    const queries = migration.queries.map((query) => `      ${string(query)},\n`).join("");
    return `  {\n    name: ${string(migration.name)},\n    queries: [${queries ? `\n${queries}    ` : ""}],\n  },\n`;
  });
  const list = `[${items.length ? `\n${items.join("")}` : ""}]`;
  return [
    `// Generated by @rivi-software/d1-migrations from ${input.from}. Do not edit: change the`,
    `// migrations and bundle them again.`,
    ``,
    ...(input.typescript
      ? [`import type { D1Migration } from "@rivi-software/d1-migrations";`, ``]
      : []),
    `export const table = ${string(input.table)};`,
    ``,
    input.typescript
      ? `export const migrations: D1Migration[] = ${list};`
      : `/** @type {import("@rivi-software/d1-migrations").D1Migration[]} */\nexport const migrations = ${list};`,
    ``,
    `export default { table, migrations };`,
    ``,
  ].join("\n");
}
