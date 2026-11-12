/**
 * The labels rivi-bot's describe, triage and housekeeping add: the shared filter
 * (rivi-bot/labels.jq), its default deny list wherever it is written down, and each action's step
 * that adds labels, run as the action runs it, with a stand-in for gh that records what it would
 * send.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf-8");

/** The default deny list, as the issue that asked for it set it out (#122), and `invalid`. */
const DEFAULT_DENY = [
  "needs-*",
  "ready-for-*",
  "duplicate",
  "wontfix",
  "invalid",
  "breaking-change",
  "good first issue",
  "help wanted",
];

const ACTIONS = ["describe", "triage", "housekeeping"] as const;

type Action = (typeof ACTIONS)[number];

const runs = (command: string) => {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
};

// CI has both; elsewhere the tests that need them wait until they are installed.
const hasTools = Boolean(process.env.CI) || (runs("jq") && runs("bash"));

const indentOf = (line: string) => line.search(/\S/u);

/** The block under the first line matching `key` after line `from`, without its indent. */
const blockAfter = (lines: string[], from: number, key: RegExp) => {
  const start = lines.findIndex((line, i) => i > from && key.test(line));

  if (start === -1) {
    throw new Error(`no line matches ${key}`);
  }

  const indent = indentOf(lines[start] ?? "");
  const body: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) <= indent) {
      break;
    }

    body.push(line);
  }

  const strip = Math.min(
    ...body.flatMap((line) => (line.trim() === "" ? [] : [indentOf(line)]))
  );

  return body.map((line) => line.slice(strip)).join("\n");
};

const actionLines = (action: Action) =>
  read(`rivi-bot/${action}/action.yml`).split("\n");

/** The default of the action's labels-deny input, as GitHub passes it. */
const denyInput = (action: Action) => {
  const lines = actionLines(action);

  return blockAfter(
    lines,
    lines.indexOf("  labels-deny:"),
    /^\s+default: \|$/u
  );
};

/** The script of the action's step that adds labels. */
const applyStep = (action: Action) => {
  const lines = actionLines(action);
  const step = lines.findIndex((line) => /^\s+id: apply$/u.test(line));

  return blockAfter(lines, step, /^\s+run: \|$/u);
};

const patterns = (list: string) =>
  list.split("\n").flatMap((line) => (line.trim() === "" ? [] : [line.trim()]));

interface Picked {
  add: string[];
  held: string[];
}

const pick = (
  answer: string[],
  known: string[],
  on: string[],
  deny: string
): Picked =>
  JSON.parse(
    execFileSync(
      "jq",
      [
        "-c",
        "-L",
        path.join(root, "rivi-bot"),
        "--arg",
        "deny",
        deny,
        "--argjson",
        "known",
        JSON.stringify(known),
        "--argjson",
        "on",
        JSON.stringify(on),
        'include "labels"; labels_to_add($known; $on; $deny | deny_patterns)',
      ],
      { input: JSON.stringify(answer), encoding: "utf-8" }
    )
  );

describe("the default deny list", () => {
  it.each(ACTIONS)("is the default of %s's labels-deny input", (action) => {
    expect(patterns(denyInput(action))).toStrictEqual(DEFAULT_DENY);
  });

  it("is the reusable workflow's default", () => {
    const line = read(".github/workflows/rivi-bot.yml").match(
      /"labels-deny": (?<list>\[.*\]),$/mu
    );

    expect(JSON.parse(line?.groups?.list ?? "null")).toStrictEqual(
      DEFAULT_DENY
    );
  });

  it("is the README's", () => {
    const lines = read("rivi-bot/README.md").split("\n");
    const start = lines.findIndex((line) => line.startsWith("labels-deny:"));
    const listed: string[] = [];

    for (const line of lines.slice(start + 1)) {
      const item = line.match(/^ {2}- (?<name>.+)$/u)?.groups?.name;

      if (item === undefined) {
        break;
      }

      listed.push(item);
    }

    expect(listed).toStrictEqual(DEFAULT_DENY);
  });
});

describe.skipIf(!hasTools)("labels.jq", () => {
  const known = [
    "ready-for-agent",
    "Ready-For-Human",
    "breaking-change",
    "needs-info",
    "good first issue",
    "help wanted",
    "wontfix",
    "security",
    "scope:rivi-bot",
    "rivi-bot:review",
    "a.b",
    "axb",
  ];

  const deny = DEFAULT_DENY.join("\n");

  it("holds back the labels the default list names, in any case", () => {
    expect(
      pick(
        [
          "ready-for-agent",
          "Ready-For-Human",
          "breaking-change",
          "needs-info",
          "good first issue",
          "help wanted",
          "wontfix",
          "security",
        ],
        known,
        [],
        deny
      )
    ).toStrictEqual({
      add: ["security"],
      held: [
        "Ready-For-Human",
        "breaking-change",
        "good first issue",
        "help wanted",
        "needs-info",
        "ready-for-agent",
        "wontfix",
      ],
    });
  });

  it("adds only labels the repository has and that are not on yet, once each", () => {
    expect(
      pick(
        ["security", "security", "scope:rivi-bot", "not-a-label"],
        known,
        ["scope:rivi-bot"],
        deny
      )
    ).toStrictEqual({ add: ["security"], held: [] });
  });

  it("holds back rivi-bot's own labels with an empty list", () => {
    expect(
      pick(["rivi-bot:review", "ready-for-agent"], known, [], "")
    ).toStrictEqual({ add: ["ready-for-agent"], held: ["rivi-bot:review"] });
  });

  it("reads * as any run of characters and every other character as itself", () => {
    expect(pick(["a.b", "axb"], known, [], "a.b")).toStrictEqual({
      add: ["axb"],
      held: ["a.b"],
    });
    expect(pick(["a.b", "security"], known, [], "*")).toStrictEqual({
      add: [],
      held: ["a.b", "security"],
    });
  });

  it("reads a pattern a line, leaving out spaces around it and blank lines", () => {
    expect(
      pick(["help wanted", "wontfix"], known, [], "\n  help wanted  \n\n")
    ).toStrictEqual({ add: ["wontfix"], held: ["help wanted"] });
  });
});

interface Label {
  name: string;
  description: string;
}

interface Call {
  args: string[];
  input: string;
}

// The repository's labels, and what Claude answers with: two the default list holds back, one of
// rivi-bot's own, one the repository lacks, and two that fit.
const LABELS: Label[] = [
  "ready-for-agent",
  "breaking-change",
  "rivi-bot:review",
  "security",
  "scope:rivi-bot",
  "documentation",
].map((name) => ({ name, description: "" }));

const ANSWER = [
  "ready-for-agent",
  "breaking-change",
  "rivi-bot:review",
  "not-a-label",
  "security",
  "scope:rivi-bot",
];

// gh, as far as the steps use it: it records each call, and answers the reads they make.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("--input") ? fs.readFileSync(0, "utf-8") : "";
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ args, input }) + "\\n");
const call = args.join(" ");
if (call.includes("--paginate") || call.includes("issues?labels=")) process.stdout.write("[]");
else if (call.includes("--jq .number")) process.stdout.write("900");
`;

/** An open issue as housekeeping lists it, active today. */
const openIssue = (number: number, labels: string[]) => ({
  number,
  title: `Issue ${number}`,
  labels,
  author: "someone",
  updatedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
});

/** What a step reads from its directory, as the action's first step writes it. */
interface Fixtures {
  "labels.json": Label[];
  "pull-request.json"?: { labels: { name: string }[] };
  "issue.json"?: { labels: { name: string }[] };
  "issues.json"?: ReturnType<typeof openIssue>[];
  "pull-requests.json"?: [];
  "merged.json"?: [];
}

/** The body of the report housekeeping wrote. */
const reportOf = (sent: Call[]) =>
  sent.flatMap(({ args }) => args).find((arg) => arg.startsWith("body=")) ?? "";

describe.skipIf(!hasTools)("the steps that add labels", () => {
  const work = mkdtempSync(path.join(tmpdir(), "rivi-bot-labels-"));

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Runs the action's step as GitHub would, and returns what gh was asked to send. */
  const runStep = (
    action: Action,
    files: Fixtures,
    env: Record<string, string>
  ) => {
    const dir = mkdtempSync(path.join(work, `${action}-`));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), FAKE_GH);
    chmodSync(path.join(bin, "gh"), 0o755);

    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), JSON.stringify(content));
    }

    const script = path.join(dir, "step.sh");
    writeFileSync(script, applyStep(action));
    const calls = path.join(dir, "calls.jsonl");
    writeFileSync(calls, "");

    const log = execFileSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", script],
      {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          GH_CALLS: calls,
          GH_TOKEN: "token",
          GITHUB_REPOSITORY: "rivi-software/example",
          GITHUB_ACTION_PATH: path.join(root, "rivi-bot", action),
          GITHUB_OUTPUT: path.join(dir, "output"),
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
          DIR: dir,
          LABELS_DENY: denyInput(action),
          ...env,
        },
      }
    );

    const sent: Call[] = readFileSync(calls, "utf-8")
      .split("\n")
      .flatMap((line) => (line === "" ? [] : [JSON.parse(line)]));

    /** The labels each POST to an issue's labels added, by issue. */
    const labeled = Object.fromEntries(
      sent.flatMap(({ args, input }) => {
        const issue = args
          .join(" ")
          .match(/--method POST repos\/\S+\/issues\/(?<n>\d+)\/labels(?= |$)/u)
          ?.groups?.n;

        return issue === undefined ? [] : [[issue, JSON.parse(input).labels]];
      })
    );

    return { log, sent, labeled };
  };

  const housekeeping = (labels: "true" | "false") =>
    runStep(
      "housekeeping",
      {
        "labels.json": LABELS,
        "issues.json": [
          openIssue(5, []),
          openIssue(6, []),
          openIssue(7, ["security"]),
        ],
        "pull-requests.json": [],
        "merged.json": [],
      },
      {
        LOGIN: "github-actions[bot]",
        STALE_DAYS: "30",
        LABELS: labels,
        RESULT: JSON.stringify({
          overview: "",
          duplicates: [],
          fixed: [],
          labels: [
            { number: 5, labels: ANSWER },
            { number: 6, labels: ["ready-for-agent", "breaking-change"] },
            { number: 7, labels: ["scope:rivi-bot"] },
          ],
        }),
      }
    );

  it("describe adds neither ready-for-agent nor breaking-change", () => {
    const { log, labeled } = runStep(
      "describe",
      {
        "labels.json": LABELS,
        "pull-request.json": { labels: [{ name: "documentation" }] },
      },
      {
        PR_NUMBER: "12",
        HEAD_SHA: "0123456789abcdef",
        RESULT: JSON.stringify({
          summary: "",
          labels: [...ANSWER, "documentation"],
        }),
        WRITE_SUMMARY: "false",
        ADD_LABELS: "true",
      }
    );

    expect(labeled).toStrictEqual({ 12: ["scope:rivi-bot", "security"] });
    expect(log).toContain(
      "Left for a maintainer (labels-deny): breaking-change, ready-for-agent, rivi-bot:review."
    );
  });

  it("triage adds neither ready-for-agent nor breaking-change", () => {
    const { labeled } = runStep(
      "triage",
      {
        "labels.json": LABELS,
        "issue.json": { labels: [] },
        "issues.json": [],
      },
      {
        LOGIN: "github-actions[bot]",
        ISSUE: "34",
        RESULT: JSON.stringify({
          summary: "A report.",
          labels: ANSWER,
          duplicates: [],
          questions: [],
          files: [],
          plan: "",
          prompt: "",
        }),
        LABELS: "true",
        DUPLICATES: "true",
        QUESTIONS: "true",
        PLAN: "true",
        PROMPT: "true",
      }
    );

    expect(labeled).toStrictEqual({ 34: ["scope:rivi-bot", "security"] });
  });

  it("housekeeping adds neither ready-for-agent nor breaking-change", () => {
    const { log, sent, labeled } = housekeeping("true");
    expect(labeled).toStrictEqual({ 5: ["scope:rivi-bot", "security"] });
    expect(reportOf(sent)).toContain("#5: scope:rivi-bot, security");
    expect(log).toContain(
      "Left for a maintainer on #6 (labels-deny): breaking-change, ready-for-agent."
    );
  });

  it("housekeeping suggests neither ready-for-agent nor breaking-change", () => {
    const { sent, labeled } = housekeeping("false");
    expect(labeled).toStrictEqual({});
    expect(reportOf(sent)).toContain("#5: scope:rivi-bot, security");
    expect(reportOf(sent)).not.toMatch(/ready-for-agent|breaking-change/u);
  });
});
