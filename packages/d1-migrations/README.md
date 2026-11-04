# @rivi-software/d1-migrations

[![npm version](https://img.shields.io/npm/v/@rivi-software/d1-migrations?label=npm&color=0b6b3a)](https://www.npmjs.com/package/@rivi-software/d1-migrations) [![CI status](https://img.shields.io/github/actions/workflow/status/rivi-software/tools/ci.yml?branch=main&label=CI)](https://github.com/rivi-software/tools/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-0b6b3a)](LICENSE)

D1 migrations from inside a Worker, for the databases an app creates at runtime, such as one database per customer.

`wrangler d1 migrations apply` runs from the command line, and only on the databases the Wrangler config names. This package applies the same migrations from a Worker, to any database the Worker holds:
- the same files, in the same order
- the same statements
- the same migrations table

Wrangler and the Worker can then each apply the migrations the other has not.

It has three parts:
- `bundleD1Migrations()` (Node, at build time) reads the migration files and writes a module the Worker imports.
- `migrateD1(db, migrations)` (in a Worker) applies the migrations a database has not run yet.
- `d1-migrations journal` (command line, in CI) keeps a SHA-256 of each migration, and fails when a migration that was recorded is edited or deleted. Wrangler records a migration by its name only, so an edit after a migration ran goes unnoticed: databases migrated before and after the edit differ.

## Install

```bash
npm install @rivi-software/d1-migrations
```

The bundle step splits each migration with your project's own Wrangler, so it needs `wrangler` 4 installed. Wrangler is an optional peer dependency: the Worker never imports it. The tests run against Wrangler 4.156.2.

The bundle step and the `d1-migrations` command need Node 22 or later. `migrateD1` uses only the D1 binding, so it runs in any Worker. The package is ESM only.

## Usage

### At build time

Bundle the migrations before the Worker builds. Either run the command from a `package.json` script:

```json
{
  "scripts": {
    "prebuild": "d1-migrations bundle --out src/generated/migrations.ts"
  }
}
```

or call the function from a build script:

```ts
import { bundleD1Migrations } from "@rivi-software/d1-migrations/bundle";

await bundleD1Migrations({ dir: "migrations", out: "src/generated/migrations.ts" });
```

Pass the same settings the binding has in the Wrangler config:

| Option | Command line | Wrangler config field | Default |
| --- | --- | --- | --- |
| `dir` | `--dir` | `migrations_dir` | `migrations` |
| `pattern` | `--pattern` | `migrations_pattern` | `<dir>/*.sql` |
| `table` | `--table` | `migrations_table` | `d1_migrations` |
| `cwd` | (the current directory) | | `process.cwd()` |

Paths are relative to `cwd`, which should be the directory that holds the Wrangler config. For Drizzle's layout, pass `--dir drizzle --pattern "drizzle/*/migration.sql"`.

The module holds each migration's statements and the table's name. It only changes when a migration does, and the bundle step leaves an unchanged module unwritten, so no watcher wakes up. Commit it, or have Git ignore it and bundle before every build and test run.

### In the Worker

Pass `migrateD1` the binding of a database the Worker holds. For example, the binding of a Workers for Platforms script that was uploaded with its customer's database:

```ts
import { migrateD1 } from "@rivi-software/d1-migrations";
import migrations from "./generated/migrations";

let migrated: Promise<unknown> | undefined;

export default {
  async fetch(request, env) {
    // Once per isolate. A failed migration is tried again on the next request.
    migrated ??= migrateD1(env.DB, migrations).catch((error) => {
      migrated = undefined;
      throw error;
    });
    await migrated;
    // …
  },
} satisfies ExportedHandler<Env>;
```

`migrateD1` resolves to `{ applied }`, the names of the migrations it applied. On a database that is up to date, it costs two queries and applies nothing. A migration that fails throws a `D1MigrationError` with these fields:
- `migration`: the migration that failed
- `applied`: the migrations this call applied before it
- `cause`: D1's error

The database keeps the migrations before it, and nothing of the one that failed.

### In CI

Record each new migration in the journal, and commit the journal with it:

```bash
npx d1-migrations journal
```

In CI, check the migrations against it:

```bash
npx d1-migrations journal --check
```

`--check` writes nothing, and fails in three cases:
- **Edited.** A recorded migration's text changed.
- **Deleted.** A recorded migration's file is gone.
- **Unrecorded.** A migration is missing from the journal.

`journal` without `--check` adds new migrations, and never changes or drops an entry. A migration that may have run on any database must stay as it is, so a change belongs in a new migration. To change a migration that has run on no database yet, delete its entry from the journal, then run `journal` again.

The journal is `JOURNAL.json` in the migrations directory. `--journal <file>` picks another file, and `--dir` and `--pattern` work as they do for `bundle`.

### In tests with `@cloudflare/vitest-pool-workers`

The module also exports `migrations` and `table` by name, which is the shape `applyD1Migrations()` from `cloudflare:test` takes:

```ts
import { applyD1Migrations, env } from "cloudflare:test";
import { migrations, table } from "../src/generated/migrations";

await applyD1Migrations(env.DB, migrations, table);
```

## How it works

- **Which files, in which order.** It finds the files the way Wrangler does: the files under `dir` that `pattern` matches, without dotfiles. It sorts them the way Wrangler does, one path segment at a time:
  - a segment's leading number (`0010` in `0010_users.sql`) comes first
  - a tie, or two segments without a number, sorts by text
  - a numbered segment sorts before one without a number

  A migration's name is its path under `dir`, such as `0001_init.sql` or `0000_init/migration.sql`. That is the name Wrangler records.
- **Splitting.** `wrangler d1 migrations apply --local` adds the row that records the migration to the end of the migration's text, as `INSERT INTO <table> (name) values ('<name>');` on a new line. It then splits the whole text with its splitter, and runs the statements in one batch.

  The bundle step splits that same text with that same function (`unstable_splitSqlQuery`), then takes the INSERT off again. Comments, strings, triggers with `BEGIN … END` and `CASE … END`, and a leading `BEGIN TRANSACTION`/`COMMIT` pair therefore come out exactly as Wrangler splits them.

  When a migration's last statement is not complete, the bundle step fails instead. That is a missing semicolon, or a comment, string or trigger body left open. Wrangler would run that statement together with its INSERT.
- **Applying.** `migrateD1` creates the migrations table with Wrangler's statement, byte for byte. SQLite keeps that text in its schema, so the two schemas match exactly. It then reads which migrations the table records.

  Each migration the table lacks goes in one `batch()` with the INSERT that records it. D1 runs a batch as a transaction, so a failed migration leaves nothing behind.

  Calls can overlap, such as the first requests to a new database. The table's `name` is unique, so when another call applies a migration first, this call's batch rolls back. The call then finds the migration recorded, and goes on to the next one. A migration the table records but the bundle lacks, such as one a newer deploy applied, is left alone.
- **The journal.** It hashes each migration's text with CRLF line endings read as LF, so a Windows checkout with Git's `autocrlf` matches. The hashes stay in the repository. The migrations table stays exactly as Wrangler makes it, with no hash column.

The tests prove the two paths agree:
- They apply the same migrations to fresh local databases, once with `wrangler d1 migrations apply --local` and once with `bundleD1Migrations` and `migrateD1`.
- They compare the schemas (each object's `CREATE` text), every table's rows, and the migrations table's names in the order they were applied.
- They do that for three sets of migrations:
  - a set with comments, strings, a trigger, a view and seed rows
  - Drizzle's layout with a custom table
  - a set of file names that tests the order
- Wrangler and `migrateD1` then each apply what the other has not.

## Limits

- **Wrangler's splitter is an unstable export.** The bundle step needs a Wrangler 4 that still exports `unstable_splitSqlQuery`. Cloudflare's own `@cloudflare/vitest-pool-workers` imports it too. A Wrangler without it makes the bundle step fail with an error that says so. Workers already built are unaffected. When a Wrangler upgrade changes how it splits the cases in this package's tests, those tests fail.
- **Compared with the local path only.** `wrangler d1 migrations apply --remote` sends the migration's text to D1's API, which splits it on Cloudflare's side. The tests run locally, so they compare `migrateD1` with `--local`.
- **A database the Worker holds.** `migrateD1` takes a D1 binding, or anything with its `prepare` and `batch`, such as a session. A database the Worker has no binding for needs the REST API, which this version does not cover.
- **One batch per migration.** D1's limits apply to each migration as they do under Wrangler. A statement can be at most 100 KB, and a statement that rewrites very many rows can exceed D1's execution limits. Split a large data change over several migrations.
- **Forward only.** No down migrations, as with Wrangler.
- **The journal guards the repository.** It catches an edited migration before it merges, not on a database where it already ran.
- **The Worker carries the migrations.** Every migration's SQL ends up in the Worker's bundle, and counts toward its size.

## Exports

From `@rivi-software/d1-migrations` (Workers):

| Export | What |
| --- | --- |
| `migrateD1(db, migrations)` | Applies the migrations `db` lacks: `{ applied }` |
| `D1MigrationError` | A failed migration: `migration`, `applied`, `cause` |
| `DEFAULT_MIGRATIONS_TABLE` | `d1_migrations` |
| Types | `D1Migration` (`{ name, queries }`), `D1Migrations` (`{ table?, migrations }`), `MigrateD1Result`, `D1DatabaseLike`, `D1StatementLike` |

From `@rivi-software/d1-migrations/bundle` (Node):

| Export | What |
| --- | --- |
| `bundleD1Migrations(options)` | Writes the module: `{ out, table, migrations, changed }`. Options `out`, `dir`, `pattern`, `table`, `cwd` |
| `readD1Migrations(options?)` | The migrations, split, without writing anything |
| `listMigrationFiles(source?)` | The migration files in Wrangler's order: `{ dir, files: [{ name, path }] }` |
| `compareMigrationPaths(a, b)` | Wrangler's order for two migration names |
| Types | `BundleD1MigrationsOptions`, `BundleD1MigrationsResult`, `ReadD1MigrationsOptions`, `MigrationsSource`, `MigrationFile`, `MigrationFiles` |

From `@rivi-software/d1-migrations/journal` (Node):

| Export | What |
| --- | --- |
| `updateJournal(options?)` | Records new migrations: `{ journal, added, problems }`. It writes nothing when `problems` holds an edited or deleted migration |
| `checkJournal(options?)` | `{ journal, problems }`, each problem `{ name, kind }`, where `kind` is `edited`, `deleted` or `unrecorded` |
| `hashMigration(sql)` | The hash the journal records |
| `JOURNAL_FILE` | `JOURNAL.json` |
| Types | `JournalOptions` (`dir`, `pattern`, `cwd`, `journal`), `Journal`, `JournalEntry`, `JournalProblem`, `JournalCheck`, `JournalUpdate`, `MigrationsSource` |

The `d1-migrations` command runs `bundle` and `journal [--check]`. `d1-migrations` with no command prints its options. It exits with `1` when the bundle step fails or the journal disagrees, and with `2` on a usage error.

## Development

The tests in `tests/` cover:
- the order and the file matching
- the splitting, pinned against the installed Wrangler
- the generated module
- `migrateD1` on Miniflare's D1: a failed migration, overlapping calls, a custom table
- the journal and the command
- the agreement with `wrangler d1 migrations apply --local`

They run Wrangler and Miniflare locally, and call no Cloudflare API. In this directory, run `pnpm run test`, `pnpm run check` and `pnpm run build`.

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/tools/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>Part of <a href="https://github.com/rivi-software/tools#readme">RIVI tools</a>, the packages <a href="https://rivi.software">RIVI Software</a> builds its own apps with.</sub>
</p>
