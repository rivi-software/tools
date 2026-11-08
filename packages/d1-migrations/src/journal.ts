/**
 * The journal: a JSON file beside the migrations with a SHA-256 of each one. Wrangler records an
 * applied migration by its name only, so an edit to a migration after it ran goes unnoticed, and
 * databases migrated before and after the edit differ. The journal records each migration once;
 * `checkJournal()`, in CI, fails when a recorded migration is edited or deleted, or when a new one
 * was never recorded.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { compareMigrationPaths, listMigrationFiles } from "./files.js";
import type { MigrationsSource } from "./files.js";

export type { MigrationsSource } from "./files.js";

/** The journal's file name in the migrations directory, unless `journal` names another file. */
export const JOURNAL_FILE = "JOURNAL.json";

/** Where the migrations are, as the D1 binding in the Wrangler config says, and the journal. */
export type JournalOptions = MigrationsSource & {
  /** The journal, relative to `cwd`. Default `JOURNAL.json` in the migrations directory. */
  journal?: string;
};

/** One recorded migration: its name, and the hash of its text when it was recorded. */
export interface JournalEntry {
  /** The migration's name, as its migrations table records it. */
  name: string;
  /** The SHA-256 of its text with CRLF line endings read as LF, in hexadecimal. */
  sha256: string;
}

/** What the journal's file holds. */
export interface Journal {
  version: 1;
  migrations: JournalEntry[];
}

/**
 * A migration that disagrees with the journal: `edited` (its text changed after it was recorded),
 * `deleted` (recorded, but its file is gone) or `unrecorded` (a file the journal lacks).
 */
export interface JournalProblem {
  name: string;
  kind: "edited" | "deleted" | "unrecorded";
}

/** What {@link checkJournal} found. It writes nothing. */
export interface JournalCheck {
  /** The journal's absolute path. */
  journal: string;
  /** Empty when every migration matches the journal. */
  problems: JournalProblem[];
}

/** What {@link updateJournal} recorded, or the problems that kept it from writing anything. */
export interface JournalUpdate {
  /** The journal's absolute path. */
  journal: string;
  /** The migrations this call recorded, in order. */
  added: string[];
  /**
   * Recorded migrations that were edited or deleted. When there are any, the journal is left as it
   * was: a migration that may have run never changes, so a change belongs in a new migration.
   */
  problems: JournalProblem[];
}

/** The SHA-256 the journal records for a migration's text. */
export const hashMigration = (sql: string): string =>
  // A checkout with Git's autocrlf has CRLF line endings: still the same migration.
  createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");

const isJournalEntry = (value: unknown): value is JournalEntry => {
  // SAFETY: a property read through `?.` is safe on any value; the typeof checks below decide what it is.
  const entry = value as { name?: unknown; sha256?: unknown } | null;

  return (
    typeof entry?.name === "string" &&
    typeof entry?.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(entry.sha256)
  );
};

const parseJournal = (text: string, file: string): Journal => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON.`, { cause: error });
  }

  // SAFETY: a property read through `?.` is safe on any parsed JSON value.
  const migrations = (value as { migrations?: unknown } | null)?.migrations;

  if (!Array.isArray(migrations) || !migrations.every(isJournalEntry)) {
    throw new Error(
      `${file} is not a migrations journal: it needs a "migrations" list of { "name", "sha256" } entries.`
    );
  }

  return { version: 1, migrations };
};

const compare = (
  recorded: Map<string, string>,
  current: Map<string, string>
): JournalProblem[] => {
  const problems: JournalProblem[] = [];

  for (const [name, sha256] of recorded) {
    const actual = current.get(name);

    if (actual === undefined) {
      problems.push({ name, kind: "deleted" });
    } else if (actual !== sha256) {
      problems.push({ name, kind: "edited" });
    }
  }

  for (const name of current.keys()) {
    if (!recorded.has(name)) {
      problems.push({ name, kind: "unrecorded" });
    }
  }

  return problems.toSorted((a, b) => compareMigrationPaths(a.name, b.name));
};

const load = async (options: JournalOptions) => {
  const cwd = path.resolve(options.cwd ?? ".");
  const { dir, files } = listMigrationFiles({ ...options, cwd });

  const journal = options.journal
    ? path.resolve(cwd, options.journal)
    : path.join(dir, JOURNAL_FILE);

  const text = await readFile(journal, "utf-8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  );

  const recorded = new Map(
    (text === undefined ? [] : parseJournal(text, journal).migrations).map(
      (entry) => [entry.name, entry.sha256] as const
    )
  );

  const current = new Map<string, string>();

  for (const file of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, so a large migrations directory cannot run the process out of file handles
    current.set(file.name, hashMigration(await readFile(file.path, "utf-8")));
  }

  return { journal, exists: text !== undefined, recorded, current };
};

/** Compares the migrations with the journal. A missing journal records nothing. */
export const checkJournal = async (
  options: JournalOptions = {}
): Promise<JournalCheck> => {
  const { journal, recorded, current } = await load(options);

  return { journal, problems: compare(recorded, current) };
};

/**
 * Records the migrations the journal lacks, and writes it. It never changes or drops an entry: when
 * a recorded migration was edited or deleted, it returns those problems and writes nothing. To
 * accept an edit to a migration that has run nowhere yet, delete its entry from the journal first.
 */
export const updateJournal = async (
  options: JournalOptions = {}
): Promise<JournalUpdate> => {
  const { journal, exists, recorded, current } = await load(options);
  const problems = compare(recorded, current);
  const blocking = problems.filter((problem) => problem.kind !== "unrecorded");

  if (blocking.length) {
    return { journal, added: [], problems: blocking };
  }

  // Every problem left is `unrecorded`, so `current` holds the hash of each.
  const unrecorded = problems.map(
    (problem) => [problem.name, current.get(problem.name) ?? ""] as const
  );

  const added = unrecorded.map(([name]) => name);

  for (const [name, sha256] of unrecorded) {
    recorded.set(name, sha256);
  }

  if (added.length || !exists) {
    const content: Journal = {
      version: 1,
      migrations: [...recorded]
        .toSorted(([a], [b]) => compareMigrationPaths(a, b))
        .map(([name, sha256]) => ({ name, sha256 })),
    };

    await writeFile(journal, `${JSON.stringify(content, null, 2)}\n`);
  }

  return { journal, added, problems: [] };
};
