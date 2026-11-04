import { afterEach, describe, expect, it } from "vitest";
import { D1MigrationError, migrateD1, type D1DatabaseLike } from "../src/index.js";
import { openDatabase } from "./helpers.js";

const MIGRATIONS = [
  { name: "0001_init.sql", queries: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)"] },
  {
    name: "0002_seed.sql",
    queries: ["INSERT INTO a (v) VALUES ('x')", "INSERT INTO a (v) VALUES ('y')"],
  },
  { name: "0003_index.sql", queries: ["CREATE INDEX a_v ON a (v)"] },
];

let open: Awaited<ReturnType<typeof openDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(open.map((database) => database.dispose()));
  open = [];
});
async function database() {
  const opened = await openDatabase();
  open.push(opened);
  return opened.db;
}

async function recorded(db: Awaited<ReturnType<typeof database>>, table = "d1_migrations") {
  const { results } = await db
    .prepare(`SELECT id, name FROM "${table.replace(/"/g, '""')}" ORDER BY id`)
    .all<{ id: number; name: string }>();
  return results;
}

describe("migrateD1", () => {
  it("applies every migration in order to a new database, and records each", async () => {
    const db = await database();
    expect(await migrateD1(db, { migrations: MIGRATIONS })).toEqual({
      applied: ["0001_init.sql", "0002_seed.sql", "0003_index.sql"],
    });
    expect(await recorded(db)).toEqual([
      { id: 1, name: "0001_init.sql" },
      { id: 2, name: "0002_seed.sql" },
      { id: 3, name: "0003_index.sql" },
    ]);
    expect((await db.prepare("SELECT v FROM a ORDER BY id").all()).results).toEqual([
      { v: "x" },
      { v: "y" },
    ]);
  });

  it("applies only what the database lacks, and nothing on a second call", async () => {
    const db = await database();
    await migrateD1(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(await migrateD1(db, { migrations: MIGRATIONS })).toEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
    expect(await migrateD1(db, { migrations: MIGRATIONS })).toEqual({ applied: [] });
    expect(await recorded(db)).toHaveLength(3);
  });

  it("records in the table it is given", async () => {
    const db = await database();
    await migrateD1(db, { table: 'schema "migrations"', migrations: MIGRATIONS.slice(0, 1) });
    expect(await recorded(db, 'schema "migrations"')).toEqual([{ id: 1, name: "0001_init.sql" }]);
  });

  it("leaves nothing of a migration that fails, and says which one failed", async () => {
    const db = await database();
    const broken = {
      name: "0002_broken.sql",
      queries: ["CREATE TABLE b (id INTEGER)", "INSERT INTO missing VALUES (1)"],
    };
    const error = await migrateD1(db, {
      migrations: [MIGRATIONS[0]!, broken, MIGRATIONS[2]!],
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(D1MigrationError);
    expect(error).toMatchObject({
      name: "D1MigrationError",
      migration: "0002_broken.sql",
      applied: ["0001_init.sql"],
      message: expect.stringContaining(
        "D1 migration 0002_broken.sql failed: D1_ERROR: no such table: missing",
      ),
    });
    expect(await recorded(db)).toEqual([{ id: 1, name: "0001_init.sql" }]);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all();
    expect(tables.results).toEqual([]);

    // Once the migration is fixed, the next call picks up where this one stopped.
    expect(await migrateD1(db, { migrations: MIGRATIONS })).toEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
  });

  it("goes on when another call applied a migration between its read and its batch", async () => {
    const db = await database();
    await migrateD1(db, { migrations: MIGRATIONS });
    // A call that read the table before the first one wrote it: its first read finds nothing.
    let stale = true;
    const late: D1DatabaseLike = {
      prepare: (query) => {
        const statement = db.prepare(query);
        if (!query.startsWith("SELECT name FROM")) return statement;
        return {
          bind: (...values) => statement.bind(...values),
          run: () => statement.run(),
          all: async () => {
            if (!stale) return statement.all();
            stale = false;
            return { results: [] };
          },
        };
      },
      batch: (statements) => db.batch(statements as Parameters<typeof db.batch>[0]),
    };
    expect(await migrateD1(late, { migrations: MIGRATIONS })).toEqual({ applied: [] });
    expect(await recorded(db)).toHaveLength(3);
  });

  it("applies each migration once when calls overlap", async () => {
    const db = await database();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => migrateD1(db, { migrations: MIGRATIONS })),
    );
    expect(results.flatMap((result) => result.applied).sort()).toEqual(
      MIGRATIONS.map((migration) => migration.name),
    );
    expect(await recorded(db)).toEqual(
      MIGRATIONS.map((migration, index) => ({ id: index + 1, name: migration.name })),
    );
    expect((await db.prepare("SELECT count(*) AS rows FROM a").all()).results).toEqual([
      { rows: 2 },
    ]);
  });

  it("leaves alone a migration the database records and the list lacks", async () => {
    const db = await database();
    await migrateD1(db, {
      migrations: [...MIGRATIONS.slice(0, 1), { name: "0009_newer.sql", queries: [] }],
    });
    expect(await migrateD1(db, { migrations: MIGRATIONS })).toEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
    expect((await recorded(db)).map((row) => row.name)).toEqual([
      "0001_init.sql",
      "0009_newer.sql",
      "0002_seed.sql",
      "0003_index.sql",
    ]);
  });
});
