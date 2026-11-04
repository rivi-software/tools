import path from "node:path";
import { parseArgs } from "node:util";
import { bundleD1Migrations } from "./bundle.js";
import { checkJournal, updateJournal, type JournalProblem } from "./journal.js";

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

type Context = {
  /** The directory paths are relative to. */
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
};

/** Runs `d1-migrations` with `args` and returns its exit code. */
export async function runCli(
  args: string[],
  context: Context = { cwd: process.cwd(), log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  let values;
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
    context.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
    return 2;
  }
  const source = { cwd: context.cwd, dir: values.dir, pattern: values.pattern };
  const shown = (file: string) => path.relative(context.cwd, file) || file;

  try {
    if (command === "bundle" && values.out && !values.journal && !values.check) {
      const result = await bundleD1Migrations({ ...source, table: values.table, out: values.out });
      const count = `${result.migrations.length} migration${result.migrations.length === 1 ? "" : "s"}`;
      context.log(
        result.changed
          ? `Bundled ${count} into ${shown(result.out)}.`
          : `${shown(result.out)} already holds the ${count}.`,
      );
      return 0;
    }
    if (command === "journal" && !values.out && !values.table) {
      const options = { ...source, journal: values.journal };
      if (values.check) {
        const { journal, problems } = await checkJournal(options);
        if (!problems.length) {
          context.log(`Every migration matches ${shown(journal)}.`);
          return 0;
        }
        context.error(`The migrations disagree with ${shown(journal)}:`);
        for (const problem of problems) context.error(`  ${describe(problem)}`);
        context.error(advice(problems));
        return 1;
      }
      const { journal, added, problems } = await updateJournal(options);
      if (problems.length) {
        context.error(`${shown(journal)} is unchanged. These recorded migrations changed:`);
        for (const problem of problems) context.error(`  ${describe(problem)}`);
        context.error(advice(problems));
        return 1;
      }
      context.log(
        added.length
          ? `Recorded in ${shown(journal)}: ${added.join(", ")}.`
          : `${shown(journal)} already records every migration.`,
      );
      return 0;
    }
  } catch (error) {
    context.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  context.error(USAGE);
  return 2;
}

function describe(problem: JournalProblem): string {
  switch (problem.kind) {
    case "edited":
      return `${problem.name} was edited after it was recorded.`;
    case "deleted":
      return `${problem.name} was recorded, and its file is gone.`;
    case "unrecorded":
      return `${problem.name} is not recorded: run d1-migrations journal.`;
  }
}

function advice(problems: JournalProblem[]): string {
  return problems.some((problem) => problem.kind !== "unrecorded")
    ? "A migration that may have run must stay as it is: put the change in a new migration. If it has run on no database yet, delete its entry from the journal and run d1-migrations journal."
    : "Run d1-migrations journal, and commit the journal with the migrations.";
}
