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
import { compareMigrationPaths, listMigrationFiles, type MigrationsSource } from "./files.js";

export type { MigrationsSource } from "./files.js";

/** The journal's file name in the migrations directory, unless `journal` names another file. */
export const JOURNAL_FILE = "JOURNAL.json";

export type JournalOptions = MigrationsSource & {
  /** The journal, relative to `cwd`. Default `JOURNAL.json` in the migrations directory. */
  journal?: string;
};

export type JournalEntry = {
  /** The migration's name, as its migrations table records it. */
  name: string;
  /** The SHA-256 of its text with CRLF line endings read as LF, in hexadecimal. */
  sha256: string;
};

/** What the journal's file holds. */
export type Journal = {
  version: 1;
  migrations: JournalEntry[];
};

/**
 * A migration that disagrees with the journal: `edited` (its text changed after it was recorded),
 * `deleted` (recorded, but its file is gone) or `unrecorded` (a file the journal lacks).
 */
export type JournalProblem = {
  name: string;
  kind: "edited" | "deleted" | "unrecorded";
};

export type JournalCheck = {
  /** The journal's absolute path. */
  journal: string;
  /** Empty when every migration matches the journal. */
  problems: JournalProblem[];
};

export type JournalUpdate = {
  /** The journal's absolute path. */
  journal: string;
  /** The migrations this call recorded, in order. */
  added: string[];
  /**
   * Recorded migrations that were edited or deleted. When there are any, the journal is left as it
   * was: a migration that may have run never changes, so a change belongs in a new migration.
   */
  problems: JournalProblem[];
};

/** The SHA-256 the journal records for a migration's text. */
export function hashMigration(sql: string): string {
  // A checkout with Git's autocrlf has CRLF line endings: still the same migration.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Compares the migrations with the journal. A missing journal records nothing. */
export async function checkJournal(options: JournalOptions = {}): Promise<JournalCheck> {
  const { journal, recorded, current } = await load(options);
  return { journal, problems: compare(recorded, current) };
}

function compare(recorded: Map<string, string>, current: Map<string, string>): JournalProblem[] {
  const problems: JournalProblem[] = [];
  for (const [name, sha256] of recorded) {
    const actual = current.get(name);
    if (actual === undefined) problems.push({ name, kind: "deleted" });
    else if (actual !== sha256) problems.push({ name, kind: "edited" });
  }
  for (const name of current.keys())
    if (!recorded.has(name)) problems.push({ name, kind: "unrecorded" });
  return problems.sort((a, b) => compareMigrationPaths(a.name, b.name));
}

/**
 * Records the migrations the journal lacks, and writes it. It never changes or drops an entry: when
 * a recorded migration was edited or deleted, it returns those problems and writes nothing. To
 * accept an edit to a migration that has run nowhere yet, delete its entry from the journal first.
 */
export async function updateJournal(options: JournalOptions = {}): Promise<JournalUpdate> {
  const { journal, exists, recorded, current } = await load(options);
  const problems = compare(recorded, current);
  const blocking = problems.filter((problem) => problem.kind !== "unrecorded");
  if (blocking.length) return { journal, added: [], problems: blocking };

  const added = problems.map((problem) => problem.name);
  for (const name of added) recorded.set(name, current.get(name)!);
  if (added.length || !exists) {
    const content: Journal = {
      version: 1,
      migrations: [...recorded]
        .sort(([a], [b]) => compareMigrationPaths(a, b))
        .map(([name, sha256]) => ({ name, sha256 })),
    };
    await writeFile(journal, `${JSON.stringify(content, null, 2)}\n`);
  }
  return { journal, added, problems: [] };
}

async function load(options: JournalOptions) {
  const cwd = path.resolve(options.cwd ?? ".");
  const { dir, files } = listMigrationFiles({ ...options, cwd });
  const journal = options.journal
    ? path.resolve(cwd, options.journal)
    : path.join(dir, JOURNAL_FILE);
  const text = await readFile(journal, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const recorded = new Map(
    (text === undefined ? [] : parseJournal(text, journal).migrations).map(
      (entry) => [entry.name, entry.sha256] as const,
    ),
  );
  const current = new Map<string, string>();
  for (const file of files)
    current.set(file.name, hashMigration(await readFile(file.path, "utf8")));
  return { journal, exists: text !== undefined, recorded, current };
}

function parseJournal(text: string, file: string): Journal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON.`, { cause: error });
  }
  const migrations = (value as { migrations?: unknown } | null)?.migrations;
  if (
    !Array.isArray(migrations) ||
    !migrations.every(
      (entry) =>
        typeof entry?.name === "string" &&
        typeof entry?.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
    )
  )
    throw new Error(
      `${file} is not a migrations journal: it needs a "migrations" list of { "name", "sha256" } entries.`,
    );
  return { version: 1, migrations };
}
