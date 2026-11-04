import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll } from "vitest";

export const FIXTURES = path.join(import.meta.dirname, "fixtures");
export const DATABASE_ID = "00000000-0000-4000-8000-000000000001";

/** A directory removed after the test file's tests. */
export function temporaryDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "d1-migrations-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The D1 binding's migration fields in a Wrangler config. */
export type D1Config = {
  migrations_dir?: string;
  migrations_pattern?: string;
  migrations_table?: string;
};

/**
 * A copy of `fixtures/<fixture>` with a Wrangler config whose `DB` binding has `d1`'s fields.
 * `only` keeps just the migration files it names, by their path in the fixture.
 */
export function project(fixture: string, d1: D1Config = {}, only?: string[]): string {
  const dir = temporaryDirectory();
  cpSync(path.join(FIXTURES, fixture), dir, {
    recursive: true,
    filter: (source) =>
      !only ||
      statSync(source).isDirectory() ||
      only.includes(path.relative(path.join(FIXTURES, fixture), source).replace(/\\/g, "/")),
  });
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "d1-migrations-test",
      compatibility_date: "2026-11-01",
      d1_databases: [{ binding: "DB", database_name: "test", database_id: DATABASE_ID, ...d1 }],
    }),
  );
  return dir;
}

/** Copies a fixture's migration files into an existing project copy. */
export function addMigrations(dir: string, fixture: string, files: string[]): void {
  for (const file of files)
    cpSync(path.join(FIXTURES, fixture, file), path.join(dir, file), { recursive: true });
}

const wranglerBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** Runs the project's Wrangler in `cwd` and returns its output. */
export async function wrangler(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [wranglerBin, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: path.join(cwd, ".wrangler-logs"),
    },
  });
  return stdout + stderr;
}

/** `wrangler d1 migrations apply DB --local`, persisting to `state`. */
export function wranglerApply(cwd: string, state: string): Promise<string> {
  return wrangler(cwd, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
}

/**
 * The `DB` database in Miniflare: in memory, or the one `wrangler --local --persist-to <state>`
 * keeps there.
 */
export async function openDatabase(state?: string) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "",
      d1Databases: { DB: DATABASE_ID },
      ...(state ? { resourcePersistencePath: path.join(state, "v3") } : {}),
    }),
  );
  const db = await mf.getD1Database("DB");
  return { db, dispose: () => mf.dispose() };
}

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];

/**
 * Everything two migrated databases must agree on: the schema as SQLite keeps it (each object's
 * CREATE text), every table's rows, and the migrations table's names in the order they were applied.
 * It leaves out `applied_at`, and D1's own `_cf_` tables.
 */
export async function dump(db: Database, table = "d1_migrations") {
  const { results: schema } = await db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name",
    )
    .all<{ type: string; name: string; sql: string | null }>();
  const rows: Record<string, unknown[]> = {};
  for (const object of schema)
    if (object.type === "table" && object.name !== table)
      rows[object.name] = (
        await db.prepare(`SELECT * FROM "${object.name}" ORDER BY rowid`).all()
      ).results;
  const { results: migrations } = await db
    .prepare(`SELECT id, name FROM "${table}" ORDER BY id`)
    .all();
  return { schema, rows, migrations };
}
