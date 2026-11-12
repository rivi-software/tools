// The read-only tools the review's model looks at the code with: search, read and list the files of
// a checkout of the commit under review, and search and read the repository's issues. The checkout
// may come from anyone, so every path stays inside it, a symlink is followed before a file is read
// and must still land inside it, and local secret files are never read. Nothing in it runs: git
// only lists and searches it. Node built-ins only.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { clip, messageOf } from "./common.ts";
import type { Api, JsonObject, JsonValue, Label } from "./common.ts";
import type { ToolDefinition } from "./workers-ai.ts";

// Never read: local secrets, and git's own files.
const SECRET_FILE = /(?:^|\/)(?:\.dev\.vars[^/]*|\.env[^/]*|\.git)(?:\/|$)/u;

// Noise that buries a match in a search, and the secret files. `glob` makes `**/` match no
// directory as well, so the files at the root are left out too.
const SEARCH_EXCLUDES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "*.snap",
  ".dev.vars*",
  ".env*",
].map((file) => `:(exclude,glob)**/${file}`);

/** A `git grep -n` line's path: what comes before its line number. */
const GREP_PATH = /^(?<path>.*?):\d+:/u;

// A search names this repository. A qualifier that reaches past it is refused as a hint to the
// model; what keeps other repositories out is that every result from one is dropped, since
// GitHub's search syntax (`OR`, parentheses) has more ways to name one than a pattern can catch.
const OTHER_REPOSITORY = /(?:^|\s)-?(?:repo|org|user|owner):/iu;

type Exec = typeof execFileSync;

/** What the model passes a tool for one argument: JSON, or nothing when it leaves it out. */
type ToolArgument = JsonValue | undefined;

type ToolHandler = (args: JsonObject) => string | Promise<string>;

interface Issue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  labels: Label[];
}

interface SearchResults {
  items: {
    number: number;
    state: string;
    title: string;
    pull_request?: unknown;
    repository_url?: string;
  }[];
}

/**
 * A repository-relative path inside `root`, or an error for anything outside it or secret. This
 * reads the path as written; `realFile` also follows symlinks before a file is read.
 */
export const safePath = (root: string, given: ToolArgument): string => {
  const relative =
    path.normalize(String(given ?? ".").replace(/^\.?\/+/u, "")) || ".";

  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${given} is outside the repository.`);
  }

  if (SECRET_FILE.test(relative)) {
    throw new Error(`${given} is not readable.`);
  }

  const full = path.resolve(root, relative);

  if (
    full !== path.resolve(root) &&
    !full.startsWith(path.resolve(root) + path.sep)
  ) {
    throw new Error(`${given} is outside the repository.`);
  }

  return relative;
};

/**
 * The real file behind a path inside `root`. A pull request can commit a symlink (to
 * `/proc/self/environ`, or to a `.env`), so the link is followed first and the target must still lie
 * inside the checkout and outside the secret files; null when nothing is there.
 */
export const realFile = (root: string, given: ToolArgument): string | null => {
  const full = path.resolve(root, safePath(root, given));

  if (!existsSync(full)) {
    return null;
  }

  const realRoot = realpathSync(root);
  const real = realpathSync(full);

  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`${given} is outside the repository.`);
  }

  if (SECRET_FILE.test(path.relative(realRoot, real))) {
    throw new Error(`${given} is not readable.`);
  }

  return real;
};

/**
 * A reader of the checkout's files for what the model is given unasked, such as the AGENTS.md
 * files, through `realFile`: a symlink a pull request commits out of the checkout or onto a secret
 * file reads as no file, and so does a directory. A symlink to another file inside the checkout
 * reads as that file, which `read_file` reads as well.
 */
export const checkoutFile = (root: string) =>
  function read(file: string): string | null {
    try {
      const real = realFile(root, file);

      return real ? readFileSync(real, "utf-8") : null;
    } catch {
      return null;
    }
  };

/** At most `max` non-empty lines of a tool's output, and how many more there were. */
const lines = (text: string, max: number): string => {
  const all = text.split("\n").filter(Boolean);

  return all.length > max
    ? `${all.slice(0, max).join("\n")}\n[… ${all.length - max} more]`
    : all.join("\n");
};

const DEFINITIONS = [
  [
    "search_code",
    "Search the repository's tracked files with git grep (extended regex). Returns path:line: text.",
    {
      path: {
        description:
          "Directory or file to search, default the whole repository",
        type: "string",
      },
      pattern: {
        description: "Extended regular expression",
        type: "string",
      },
    },
    ["pattern"],
  ],
  [
    "read_file",
    "Read lines of a file, numbered (at most 400 lines per call).",
    {
      end_line: { type: "integer" },
      path: { type: "string" },
      start_line: { type: "integer" },
    },
    ["path"],
  ],
  [
    "list_files",
    "List tracked files under a directory.",
    { path: { type: "string" } },
    ["path"],
  ],
  [
    "search_issues",
    "Search this repository's issues and pull requests (GitHub search syntax).",
    { query: { type: "string" } },
    ["query"],
  ],
  [
    "read_issue",
    "Read an issue or pull request by number: title, state, labels and description.",
    { number: { type: "integer" } },
    ["number"],
  ],
] as const;

export interface CodeTools {
  definitions: ToolDefinition[];
  call: (name: string, args: JsonObject) => Promise<string>;
}

/** Read-only tools over the checkout at `root` and the issues of `repo`. */
export const codeTools = (
  root: string,
  api: Api,
  { exec = execFileSync, repo }: { exec?: Exec; repo?: string } = {}
): CodeTools => {
  const git = (args: string[]): string => {
    try {
      return exec("git", ["-C", root, ...args], {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      // git grep exits 1 when nothing matches; execFileSync's error carries the status and stderr.
      const failure = error instanceof Error ? error : new Error(String(error));

      if ("status" in failure && failure.status === 1) {
        return "";
      }

      const stderr = "stderr" in failure ? failure.stderr : undefined;

      throw new Error(
        String(stderr || failure.message)
          .trim()
          .slice(0, 300),
        { cause: error }
      );
    }
  };

  const handlers = new Map<string, ToolHandler>([
    [
      "list_files",
      ({ path: dir }) =>
        lines(git(["ls-files", "--", safePath(root, dir)]), 300) || "No files.",
    ],
    [
      "read_file",
      ({ path: given, start_line, end_line }) => {
        const file = safePath(root, given);
        const full = realFile(root, given);

        if (!full) {
          return `${file} does not exist.`;
        }

        const all = readFileSync(full, "utf-8").split("\n");
        const start = Math.max(1, Number(start_line) || 1);

        const end = Math.min(
          all.length,
          Number(end_line) || start + 299,
          start + 399
        );

        const numbered = all
          .slice(start - 1, end)
          .map((line, n) => `${start + n}: ${line}`);

        return clip(
          `${file} lines ${start}-${end} of ${all.length}\n${numbered.join("\n")}`,
          24_000
        );
      },
    ],
    [
      "read_issue",
      async ({ number }) => {
        const issue: Issue = await api("GET", `/issues/${Number(number)}`);

        return clip(
          `#${issue.number} [${issue.state}] ${issue.title}\nLabels: ${issue.labels.map((l) => l.name).join(", ") || "none"}\n\n${issue.body ?? ""}`,
          8000
        );
      },
    ],
    [
      "search_code",
      ({ pattern, path: dir }) => {
        const found = git([
          "grep",
          "-n",
          "-I",
          "-E",
          "--max-count=20",
          "-e",
          String(pattern),
          "--",
          safePath(root, dir),
          ...SEARCH_EXCLUDES,
        ]);

        // The excludes leave the secret files out; a match in one is dropped all the same.
        const shown = found
          .split("\n")
          .filter(
            (line) =>
              !SECRET_FILE.test(GREP_PATH.exec(line)?.groups?.path ?? "")
          )
          .join("\n");

        return clip(lines(shown, 150), 14_000) || "No matches.";
      },
    ],
    [
      "search_issues",
      async ({ query }) => {
        if (OTHER_REPOSITORY.test(String(query))) {
          return "Search this repository only: leave out repo:, org:, user: and owner:.";
        }

        const found: SearchResults = await api(
          "GET",
          `/search/issues?per_page=10&q=${encodeURIComponent(`repo:${repo} ${query}`)}`
        );

        const own = `https://api.github.com/repos/${repo}`.toLowerCase();

        return (
          found.items
            .filter((i) => i.repository_url?.toLowerCase() === own)
            .map(
              (i) =>
                `#${i.number} [${i.state}${i.pull_request ? ", pull request" : ""}] ${i.title}`
            )
            .join("\n") || "No issues."
        );
      },
    ],
  ]);

  return {
    call: async (name, args) => {
      const handler = handlers.get(name);

      if (!handler) {
        return `Unknown tool ${name}.`;
      }

      try {
        return await handler(args);
      } catch (error) {
        return `Error: ${messageOf(error)}`;
      }
    },
    definitions: DEFINITIONS.map(
      ([name, description, properties, required]) => ({
        function: {
          description,
          name,
          parameters: { properties, required, type: "object" },
        },
        type: "function",
      })
    ),
  };
};
