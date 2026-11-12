import { beforeEach, describe, expect, it } from "vitest";

import { D1MigrationError, migrateD1 } from "../src/index.js";
import type { D1DatabaseLike } from "../src/index.js";
import { openDatabase } from "./helpers.js";

const INIT = {
  name: "0001_init.sql",
  queries: ["CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)"],
};

const SEED = {
  name: "0002_seed.sql",
  queries: ["INSERT INTO a (v) VALUES ('x')", "INSERT INTO a (v) VALUES ('y')"],
};

const INDEX = {
  name: "0003_index.sql",
  queries: ["CREATE INDEX a_v ON a (v)"],
};

const MIGRATIONS = [INIT, SEED, INDEX];

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];

/** The test's own new database. */
let db: Database;

const recorded = async (database: Database, table = "d1_migrations") => {
  const { results } = await database
    .prepare(
      `SELECT id, name FROM "${table.replaceAll('"', '""')}" ORDER BY id`
    )
    .all<{ id: number; name: string }>();

  return results;
};

/**
 * Starting Miniflare for a database takes a few hundred milliseconds on a laptop and has passed five
 * seconds on a busy CI runner, the first start most of all. A test's own migrations take about as
 * long as a start, so the tests get more than Vitest's 5 s default too.
 */
describe(migrateD1, { timeout: 30_000 }, () => {
  /**
   * The start has a limit of its own in the hook. The cleanup it returns runs only after an open
   * that succeeded, so a failed open reports its own error and nothing else.
   */
  beforeEach(async () => {
    const opened = await openDatabase();
    ({ db } = opened);

    return () => opened.dispose();
  }, 60_000);

  it("applies every migration in order to a new database, and records each", async () => {
    await expect(
      migrateD1(db, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: ["0001_init.sql", "0002_seed.sql", "0003_index.sql"],
    });
    await expect(recorded(db)).resolves.toStrictEqual([
      { id: 1, name: "0001_init.sql" },
      { id: 2, name: "0002_seed.sql" },
      { id: 3, name: "0003_index.sql" },
    ]);
    const rows = await db.prepare("SELECT v FROM a ORDER BY id").all();
    expect(rows.results).toStrictEqual([{ v: "x" }, { v: "y" }]);
  });

  it("applies only what the database lacks, and nothing on a second call", async () => {
    await migrateD1(db, { migrations: MIGRATIONS.slice(0, 1) });
    await expect(
      migrateD1(db, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
    await expect(
      migrateD1(db, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: [],
    });
    await expect(recorded(db)).resolves.toHaveLength(3);
  });

  it("records in the table it is given", async () => {
    await migrateD1(db, {
      table: 'schema "migrations"',
      migrations: MIGRATIONS.slice(0, 1),
    });
    await expect(recorded(db, 'schema "migrations"')).resolves.toStrictEqual([
      { id: 1, name: "0001_init.sql" },
    ]);
  });

  it("leaves nothing of a migration that fails, and says which one failed", async () => {
    const broken = {
      name: "0002_broken.sql",
      queries: [
        "CREATE TABLE b (id INTEGER)",
        "INSERT INTO missing VALUES (1)",
      ],
    };

    const failure = await migrateD1(db, {
      migrations: [INIT, broken, INDEX],
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is unknown until this test says what it is
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(D1MigrationError);
    expect(failure).toMatchObject({
      name: "D1MigrationError",
      migration: "0002_broken.sql",
      applied: ["0001_init.sql"],
      message: expect.stringContaining(
        "D1 migration 0002_broken.sql failed: D1_ERROR: no such table: missing"
      ),
    });
    await expect(recorded(db)).resolves.toStrictEqual([
      { id: 1, name: "0001_init.sql" },
    ]);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'b'")
      .all();

    expect(tables.results).toStrictEqual([]);

    // Once the migration is fixed, the next call picks up where this one stopped.
    await expect(
      migrateD1(db, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
  });

  it("goes on when another call applied a migration between its read and its batch", async () => {
    await migrateD1(db, { migrations: MIGRATIONS });
    // A call that read the table before the first one wrote it: its first read finds nothing.
    let stale = true;

    const late: D1DatabaseLike = {
      prepare: (query) => {
        const statement = db.prepare(query);

        if (!query.startsWith("SELECT name FROM")) {
          return statement;
        }

        return {
          bind: (...values) => statement.bind(...values),
          run: () => statement.run(),
          all: () => {
            if (!stale) {
              return statement.all();
            }

            stale = false;

            return Promise.resolve({ results: [] });
          },
        };
      },
      // SAFETY: every statement here came from `db.prepare` just above, so they are this database's own.
      batch: (statements) =>
        db.batch(statements as Parameters<typeof db.batch>[0]),
    };

    await expect(
      migrateD1(late, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: [],
    });
    await expect(recorded(db)).resolves.toHaveLength(3);
  });

  it("applies each migration once when calls overlap", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => migrateD1(db, { migrations: MIGRATIONS }))
    );

    expect(
      results.flatMap((result) => result.applied).toSorted()
    ).toStrictEqual(MIGRATIONS.map((migration) => migration.name));
    await expect(recorded(db)).resolves.toStrictEqual(
      MIGRATIONS.map((migration, index) => ({
        id: index + 1,
        name: migration.name,
      }))
    );
    const counted = await db.prepare("SELECT count(*) AS rows FROM a").all();
    expect(counted.results).toStrictEqual([{ rows: 2 }]);
  });

  it("leaves alone a migration the database records and the list lacks", async () => {
    await migrateD1(db, {
      migrations: [
        ...MIGRATIONS.slice(0, 1),
        { name: "0009_newer.sql", queries: [] },
      ],
    });
    await expect(
      migrateD1(db, { migrations: MIGRATIONS })
    ).resolves.toStrictEqual({
      applied: ["0002_seed.sql", "0003_index.sql"],
    });
    const rows = await recorded(db);
    expect(rows.map((row) => row.name)).toStrictEqual([
      "0001_init.sql",
      "0009_newer.sql",
      "0002_seed.sql",
      "0003_index.sql",
    ]);
  });
});
