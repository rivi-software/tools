import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { Minimatch } from "minimatch";

/** Where the migration files are, as a D1 binding in the Wrangler config says it. */
export interface MigrationsSource {
  /**
   * The directory that holds the migrations, relative to `cwd`: the binding's `migrations_dir`.
   * Default `migrations`.
   */
  dir?: string;
  /**
   * A glob for the migration files, relative to `cwd` and under `dir`: the binding's
   * `migrations_pattern`, such as `migrations/*\/migration.sql` for Drizzle's layout. Default
   * `<dir>/*.sql`.
   */
  pattern?: string;
  /**
   * The directory `dir` and `pattern` are relative to: the one that holds the Wrangler config.
   * Default `process.cwd()`.
   */
  cwd?: string;
}

/** A migration file: its name in the migrations table, and where it is on disk. */
export interface MigrationFile {
  /** Its path under the migrations directory, with `/` between segments: `0001_init.sql`. */
  name: string;
  /** Its absolute path. */
  path: string;
}

/** The resolved directory of a {@link MigrationsSource}, with its migration files in order. */
export interface MigrationFiles {
  /** The migrations directory, absolute. */
  dir: string;
  files: MigrationFile[];
}

const isDirectory = (file: string): boolean => {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

/** Forward slashes, no `./` and no trailing `/`, as Wrangler normalizes the two config fields. */
const normalizeRelativePath = (value: string): string => {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));

  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const compareSegments = (a: string, b: string): number => {
  const [aLead = ""] = a.split("_");
  const [bLead = ""] = b.split("_");
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads the leading digits of a segment such as "0001init"; Number would read the whole segment and sort it as unnumbered
  const aNumber = Number.parseInt(aLead, 10);
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads the leading digits of a segment such as "0001init"; Number would read the whole segment and sort it as unnumbered
  const bNumber = Number.parseInt(bLead, 10);
  const aNumbered = Number.isFinite(aNumber);
  const bNumbered = Number.isFinite(bNumber);

  if (aNumbered && bNumbered && aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  if (aNumbered !== bNumbered) {
    return aNumbered ? -1 : 1;
  }

  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

/**
 * Wrangler's order for migration names. Segment by segment, a segment's leading number (the digits
 * before its first `_`) sorts first, then the segment's text. A segment with a number sorts before
 * one without. A shorter path sorts before a longer one that starts with it.
 */
export const compareMigrationPaths = (a: string, b: string): number => {
  const aSegments = a.split("/");
  const bSegments = b.split("/");
  const shared = Math.min(aSegments.length, bSegments.length);

  for (let i = 0; i < shared; i += 1) {
    const order = compareSegments(aSegments[i] ?? "", bSegments[i] ?? "");

    if (order !== 0) {
      return order;
    }
  }

  return aSegments.length - bSegments.length;
};

/**
 * The migration files of `source`, in the order `wrangler d1 migrations apply` applies them. The
 * names are the ones Wrangler records in its migrations table. Throws when the directory is
 * missing, or when `pattern` is not under `dir`, as Wrangler does.
 */
export const listMigrationFiles = (
  source: MigrationsSource = {}
): MigrationFiles => {
  const cwd = path.resolve(source.cwd ?? ".");
  const dir = normalizeRelativePath(source.dir ?? "migrations");
  const pattern = normalizeRelativePath(source.pattern ?? `${dir}/*.sql`);

  if (dir !== "." && !pattern.startsWith(`${dir}/`)) {
    throw new Error(
      `The migrations pattern "${pattern}" must start with "${dir}/", the migrations directory.`
    );
  }

  const root = path.resolve(cwd, dir);

  if (!isDirectory(root)) {
    throw new Error(`No migrations directory at ${root}.`);
  }

  // Wrangler matches each path relative to the migrations directory, skipping dotfiles.
  const matcher = new Minimatch(
    dir === "." ? pattern : pattern.slice(dir.length + 1),
    {
      dot: false,
    }
  );

  const names: string[] = [];

  const walk = (absolute: string, relative: string) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (matcher.match(name, true)) {
          walk(path.join(absolute, entry.name), name);
        }
        // oxlint-disable-next-line unicorn/prefer-regexp-test -- Minimatch#match tests a path against the glob; it is not String#match
      } else if (entry.isFile() && matcher.match(name)) {
        names.push(name);
      }
    }
  };

  walk(root, "");
  names.sort(compareMigrationPaths);

  return {
    dir: root,
    files: names.map((name) => ({
      name,
      path: path.join(root, ...name.split("/")),
    })),
  };
};
