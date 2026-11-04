/**
 * The two paths agree: the same migrations applied once with `wrangler d1 migrations apply --local`
 * and once with `bundleD1Migrations()` and `migrateD1()`, on fresh local databases, leave the same
 * schema (as SQLite keeps it), the same rows and the same migrations table. Either path can then
 * apply the migrations the other has not.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleD1Migrations } from "../src/bundle.js";
import { migrateD1, type D1Migrations } from "../src/index.js";
import {
  addMigrations,
  dump,
  openDatabase,
  project,
  temporaryDirectory,
  wranglerApply,
  type D1Config,
} from "./helpers.js";

const PROJECTS: { fixture: string; d1: D1Config }[] = [
  // Comments, strings, a trigger with BEGIN … END and CASE … END, a view, seed rows.
  { fixture: "flat", d1: {} },
  // migrations_dir, migrations_pattern and migrations_table, with names that hold a `/`.
  {
    fixture: "drizzle",
    d1: {
      migrations_dir: "drizzle",
      migrations_pattern: "drizzle/*/migration.sql",
      migrations_table: "schema_migrations",
    },
  },
  // Wrangler's order: numbers before text, ties broken by text, dotfiles and other files left out.
  { fixture: "order", d1: {} },
];

/** The project's migrations, bundled and imported the way a Worker gets them. */
async function bundled(dir: string, d1: D1Config): Promise<D1Migrations> {
  const { out } = await bundleD1Migrations({
    cwd: dir,
    dir: d1.migrations_dir,
    pattern: d1.migrations_pattern,
    table: d1.migrations_table,
    out: path.join(temporaryDirectory(), "migrations.js"),
  });
  return (await import(pathToFileURL(out).href)).default;
}

/** Runs `migrateD1()` on the database Wrangler keeps in `state`. */
async function migrateState(state: string, migrations: D1Migrations) {
  const { db, dispose } = await openDatabase(state);
  try {
    return await migrateD1(db, migrations);
  } finally {
    await dispose();
  }
}

async function dumpState(state: string, table?: string) {
  const { db, dispose } = await openDatabase(state);
  try {
    return await dump(db, table);
  } finally {
    await dispose();
  }
}

describe.each(PROJECTS)("the $fixture migrations", { timeout: 120_000 }, ({ fixture, d1 }) => {
  let expected: Awaited<ReturnType<typeof dump>>;

  beforeAll(async () => {
    const state = temporaryDirectory();
    await wranglerApply(project(fixture, d1), state);
    expected = await dumpState(state, d1.migrations_table);
  }, 120_000);

  it("leave the same database through migrateD1 as through Wrangler", async () => {
    const dir = project(fixture, d1);
    const migrations = await bundled(dir, d1);
    const { db, dispose } = await openDatabase();
    try {
      const { applied } = await migrateD1(db, migrations);
      expect(applied).toEqual(migrations.migrations.map((migration) => migration.name));
      const actual = await dump(db, d1.migrations_table);
      expect(actual).toEqual(expected);
      expect(actual.migrations).toHaveLength(applied.length);
    } finally {
      await dispose();
    }
  });
});

describe("the two paths together", { timeout: 120_000 }, () => {
  const all = [
    "migrations/0001_init.sql",
    "migrations/0002_triggers.sql",
    "migrations/0003_seed.sql",
  ];
  let expected: Awaited<ReturnType<typeof dump>>;

  beforeAll(async () => {
    const state = temporaryDirectory();
    await wranglerApply(project("flat"), state);
    expected = await dumpState(state);
  }, 120_000);

  it("let migrateD1 apply what Wrangler has not, after which Wrangler finds nothing to apply", async () => {
    const dir = project("flat", {}, all.slice(0, 1));
    const state = temporaryDirectory();
    await wranglerApply(dir, state);

    addMigrations(dir, "flat", all.slice(1));
    expect(await migrateState(state, await bundled(dir, {}))).toEqual({
      applied: ["0002_triggers.sql", "0003_seed.sql"],
    });
    expect(await wranglerApply(dir, state)).toContain("No migrations to apply!");
    expect(await dumpState(state)).toEqual(expected);
  });

  it("let Wrangler apply what migrateD1 has not", async () => {
    const dir = project("flat", {}, all.slice(0, 1));
    const state = temporaryDirectory();
    expect(await migrateState(state, await bundled(dir, {}))).toEqual({
      applied: ["0001_init.sql"],
    });

    addMigrations(dir, "flat", all.slice(1));
    const output = await wranglerApply(dir, state);
    expect(output).not.toContain("0001_init.sql");
    expect(output).toContain("0002_triggers.sql");
    expect(await dumpState(state)).toEqual(expected);
  });
});
