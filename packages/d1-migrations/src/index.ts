/**
 * Applies D1 migrations from inside a Worker, to a database the Worker holds: one created at
 * runtime, such as one database per customer, as well as one in the Wrangler config. It records them
 * in Wrangler's own migrations table, so `wrangler d1 migrations apply` and the Worker agree on what
 * has run. The migrations come from `bundleD1Migrations()` (`@rivi-software/d1-migrations/bundle`),
 * which reads and splits the files at build time.
 */

/** The table Wrangler records applied migrations in when the binding sets no `migrations_table`. */
export const DEFAULT_MIGRATIONS_TABLE = "d1_migrations";

/** One migration: its name in the migrations table, and its SQL statements in order. */
export interface D1Migration {
  readonly name: string;
  readonly queries: readonly string[];
}

/** The migrations to apply, in order, and the table that records them. */
export interface D1Migrations {
  /** The migrations table. Default {@link DEFAULT_MIGRATIONS_TABLE}. */
  readonly table?: string;
  readonly migrations: readonly D1Migration[];
}

/** The part of a prepared statement `migrateD1` uses. A `D1PreparedStatement` has it. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all(): Promise<{ results: unknown[] }>;
}

/** The part of a database `migrateD1` uses. A `D1Database` binding has it, and so does a session. */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

export type MigrateD1Result = {
  /** The migrations this call applied, in order. Empty when the database was up to date. */
  applied: string[];
};

/** A migration failed. The database keeps the migrations before it, and nothing of this one. */
export class D1MigrationError extends Error {
  override readonly name = "D1MigrationError";
  /** The migration that failed. */
  readonly migration: string;
  /** The migrations this call applied before it. */
  readonly applied: string[];

  constructor(migration: string, applied: string[], cause: unknown) {
    super(
      `D1 migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.migration = migration;
    this.applied = applied;
  }
}

/**
 * Applies the migrations `db` has not run yet, in order, and returns their names.
 *
 * - It creates the migrations table as Wrangler does, and records each migration in it as Wrangler
 *   does, so either can apply the next one.
 * - Each migration and the row that records it go in one `batch()`, which D1 runs as a transaction:
 *   a migration that fails leaves neither behind, and throws a {@link D1MigrationError}.
 * - Calls that overlap on one database are safe. The table's `name` is unique, so when another call
 *   applies a migration first, this call's batch rolls back; it then finds the migration recorded
 *   and goes on to the next one.
 * - A migration the table records but `migrations` lacks, such as one a newer deploy applied, is
 *   left alone.
 */
export async function migrateD1(
  db: D1DatabaseLike,
  migrations: D1Migrations,
): Promise<MigrateD1Result> {
  const table = quoteIdentifier(migrations.table ?? DEFAULT_MIGRATIONS_TABLE);
  // Byte for byte Wrangler's statement: SQLite keeps its text in sqlite_schema, so a database
  // migrated here has the same schema as one `wrangler d1 migrations apply` migrated.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${table}(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
    )
    .run();

  const recorded = async () => {
    const { results } = await db.prepare(`SELECT name FROM ${table}`).all();
    return new Set(results.map((row) => (row as { name: unknown }).name));
  };
  const done = await recorded();
  const record = db.prepare(`INSERT INTO ${table} (name) values (?)`);
  const applied: string[] = [];
  for (const migration of migrations.migrations) {
    if (done.has(migration.name)) continue;
    try {
      await db.batch([
        ...migration.queries.map((query) => db.prepare(query)),
        record.bind(migration.name),
      ]);
      applied.push(migration.name);
    } catch (error) {
      // Another call applied it first, and this batch rolled back.
      const recordedNow = await recorded().catch(() => undefined);
      if (recordedNow?.has(migration.name)) continue;
      throw new D1MigrationError(migration.name, applied, error);
    }
  }
  return { applied };
}

/** An SQL identifier in double quotes, as Wrangler quotes the migrations table's name. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
