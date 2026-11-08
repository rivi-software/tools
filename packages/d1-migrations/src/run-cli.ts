import path from "node:path";
import { parseArgs } from "node:util";

import { bundleD1Migrations } from "./bundle.js";
import { checkJournal, updateJournal } from "./journal.js";
import type { JournalProblem } from "./journal.js";

export const USAGE = `Usage:
  d1-migrations bundle --out <file> [--dir <dir>] [--pattern <glob>] [--table <name>]
  d1-migrations journal [--check] [--dir <dir>] [--pattern <glob>] [--journal <file>]

  bundle    Writes the migrations to a module for migrateD1(), split into statements.
  journal   Records new migrations in the journal. With --check, writes nothing and
            fails when a migration was edited, deleted or never recorded.

  --dir       The binding's migrations_dir (default: migrations)
  --pattern   The binding's migrations_pattern (default: <dir>/*.sql)
  --table     The binding's migrations_table (default: d1_migrations)
  --journal   The journal (default: <dir>/JOURNAL.json)

Paths are relative to the current directory, the one with the Wrangler config.`;

interface Context {
  /** The directory paths are relative to. */
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The command line's flags, as `parseArgs` reads them. */
interface Flags {
  out?: string | undefined;
  dir?: string | undefined;
  pattern?: string | undefined;
  table?: string | undefined;
  journal?: string | undefined;
  check?: boolean | undefined;
}

const defaultContext = (): Context => ({
  cwd: process.cwd(),
  log: console.log,
  error: console.error,
});

const describe = (problem: JournalProblem): string => {
  if (problem.kind === "edited") {
    return `${problem.name} was edited after it was recorded.`;
  }

  if (problem.kind === "deleted") {
    return `${problem.name} was recorded, and its file is gone.`;
  }

  return `${problem.name} is not recorded: run d1-migrations journal.`;
};

const advice = (problems: JournalProblem[]): string =>
  problems.some((problem) => problem.kind !== "unrecorded")
    ? "A migration that may have run must stay as it is: put the change in a new migration. If it has run on no database yet, delete its entry from the journal and run d1-migrations journal."
    : "Run d1-migrations journal, and commit the journal with the migrations.";

/** Reports the problems and the way out of them, and returns the exit code for them. */
const reportProblems = (
  context: Context,
  heading: string,
  problems: JournalProblem[]
): number => {
  context.error(heading);

  for (const problem of problems) {
    context.error(`  ${describe(problem)}`);
  }

  context.error(advice(problems));

  return 1;
};

const runBundle = async (
  context: Context,
  flags: Flags,
  out: string,
  shown: (file: string) => string
): Promise<number> => {
  const result = await bundleD1Migrations({
    cwd: context.cwd,
    dir: flags.dir,
    pattern: flags.pattern,
    table: flags.table,
    out,
  });

  const count = `${result.migrations.length} migration${result.migrations.length === 1 ? "" : "s"}`;
  context.log(
    result.changed
      ? `Bundled ${count} into ${shown(result.out)}.`
      : `${shown(result.out)} already holds the ${count}.`
  );

  return 0;
};

const runJournal = async (
  context: Context,
  flags: Flags,
  shown: (file: string) => string
): Promise<number> => {
  const options = {
    cwd: context.cwd,
    dir: flags.dir,
    pattern: flags.pattern,
    journal: flags.journal,
  };

  if (flags.check) {
    const { journal, problems } = await checkJournal(options);

    if (!problems.length) {
      context.log(`Every migration matches ${shown(journal)}.`);

      return 0;
    }

    return reportProblems(
      context,
      `The migrations disagree with ${shown(journal)}:`,
      problems
    );
  }

  const { journal, added, problems } = await updateJournal(options);

  if (problems.length) {
    return reportProblems(
      context,
      `${shown(journal)} is unchanged. These recorded migrations changed:`,
      problems
    );
  }

  context.log(
    added.length
      ? `Recorded in ${shown(journal)}: ${added.join(", ")}.`
      : `${shown(journal)} already records every migration.`
  );

  return 0;
};

/** Runs `d1-migrations` with `args` and returns its exit code. */
export const runCli = async (
  args: string[],
  context: Context = defaultContext()
): Promise<number> => {
  const [command, ...rest] = args;
  let values: Flags;

  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        out: { type: "string" },
        dir: { type: "string" },
        pattern: { type: "string" },
        table: { type: "string" },
        journal: { type: "string" },
        check: { type: "boolean" },
      },
    }));
  } catch (error) {
    context.error(
      `${error instanceof Error ? error.message : error}\n\n${USAGE}`
    );

    return 2;
  }

  const shown = (file: string) => path.relative(context.cwd, file) || file;

  try {
    if (
      command === "bundle" &&
      values.out &&
      !values.journal &&
      !values.check
    ) {
      return await runBundle(context, values, values.out, shown);
    }

    if (command === "journal" && !values.out && !values.table) {
      return await runJournal(context, values, shown);
    }
  } catch (error) {
    context.error(error instanceof Error ? error.message : String(error));

    return 1;
  }

  context.error(USAGE);

  return 2;
};
