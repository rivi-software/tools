import { describe, expect, it } from "vitest";

import {
  EFFORT,
  PRIORITY,
  askClef,
  checkAnswers,
  levelOf,
  planChanges,
  questionsFor,
  removedLabels,
  stateFor,
} from "./issue-labels.ts";
import type { Answers, Issue, Label } from "./issue-labels.ts";

const labels: Label[] = [
  {
    name: "scope:deploy-watch",
    description: "Moves browser tabs open across a deploy onto the new build",
  },
  { name: "scope:workers-mail", description: "Mail from Workers" },
  {
    name: "scope:repo",
    description: "CI, releases, scripts, tooling and repository-wide docs",
  },
  { name: "security", description: "A security weakness, or hardening" },
  {
    name: "documentation",
    description: "A README is missing, wrong or unclear",
  },
  {
    name: "needs-triage",
    description: "A maintainer needs to evaluate this issue",
  },
  { name: "good first issue", description: "Good for newcomers" },
];

const issue = (overrides: Partial<Issue> = {}): Issue => ({
  number: 57,
  title: "deploy-watch: a reload that does not happen leaves the tab stuck",
  body: "### Package and version\n\n@rivi-software/deploy-watch 0.2.1",
  labels: [],
  type: null,
  author_association: "MEMBER",
  issue_field_values: [],
  ...overrides,
});

/** What Cloudflare's REST API answers with: the envelope, with Clef's answers in `result`. */
interface ClefEnvelope {
  success?: boolean;
  errors?: { code: number; message: string }[];
  messages?: string[];
  result?: {
    model?: string;
    answers?: Answers;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

/** A fetch that answers with `body` at `status`, and the calls it was made with. */
const fakeFetch = (status: number, body: ClefEnvelope) => {
  const calls: { url: string; init: RequestInit }[] = [];

  const impl: typeof fetch = (input, init = {}) => {
    calls.push({ url: String(input), init });

    return Promise.resolve(Response.json(body, { status }));
  };

  return { calls, impl };
};

/** Clef's answers to issue #57, trimmed to the labels above. */
const answers = {
  type: {
    type: "choice",
    choice: "Bug",
    probabilities: { Bug: 0.9552, Feature: 0.0258, Task: 0.019 },
  },
  scope: {
    type: "choice",
    choice: "scope:deploy-watch",
    probabilities: {
      "scope:deploy-watch": 0.9395,
      "scope:workers-mail": 0.0045,
      "scope:repo": 0.056,
    },
  },
  "topic.security": { type: "noul", noul: 0.0047 },
  "topic.documentation": { type: "noul", noul: 0.0208 },
  priority: { type: "score", score: 1.786 },
  effort: { type: "score", score: 0.6359 },
} satisfies Answers;

describe(questionsFor, () => {
  it("asks everything an issue lacks", () => {
    const questions = questionsFor(issue(), labels);
    expect(Object.keys(questions)).toStrictEqual([
      "type",
      "scope",
      "topic.security",
      "topic.documentation",
      "priority",
      "effort",
    ]);
    expect(questions.scope).toMatchObject({
      type: "choice",
      criteria: {
        "scope:deploy-watch":
          "Moves browser tabs open across a deploy onto the new build",
        "scope:workers-mail": "Mail from Workers",
        "scope:repo": "CI, releases, scripts, tooling and repository-wide docs",
      },
    });
    expect(questions.priority).toMatchObject({ type: "score" });
    expect(
      questions.priority.type === "score" && questions.priority.criteria
    ).toHaveLength(4);
  });

  it("leaves out what the issue has: a type, a scope, a topic, a field value", () => {
    const questions = questionsFor(
      issue({
        type: { name: "Feature" },
        labels: [{ name: "scope:repo" }, "security"],
        issue_field_values: [{ issue_field_id: PRIORITY.id }],
      }),
      labels
    );

    expect(Object.keys(questions)).toStrictEqual([
      "topic.documentation",
      "effort",
    ]);
  });

  it("asks no scope when the repository has fewer than two to choose from", () => {
    const questions = questionsFor(issue(), [{ name: "scope:repo" }]);
    expect(questions.scope).toBeUndefined();
  });

  it("asks nothing of an issue that has it all", () => {
    const questions = questionsFor(
      issue({
        type: { name: "Bug" },
        labels: ["scope:repo", "security", "documentation"],
        issue_field_values: [
          { issue_field_id: PRIORITY.id },
          { issue_field_id: EFFORT.id },
        ],
      }),
      labels
    );

    expect(questions).toStrictEqual({});
  });
});

describe(stateFor, () => {
  it("gives Clef the issue's title, body and labels, with a long body cut", () => {
    const state = stateFor(
      issue({ body: "x".repeat(20_000), labels: ["security"] })
    );

    expect(state.issue.title).toBe(
      "deploy-watch: a reload that does not happen leaves the tab stuck"
    );
    expect(state.issue.body).toHaveLength(16_000);
    expect(state.issue.labels).toStrictEqual(["security"]);
  });
});

describe(levelOf, () => {
  it("rounds a score to its nearest level, the lower when halfway", () => {
    expect(levelOf(1.786, 4)).toBe(2);
    expect(levelOf(1.5, 4)).toBe(1);
    expect(levelOf(1.51, 4)).toBe(2);
    expect(levelOf(0.4, 3)).toBe(0);
  });

  it("stays within the levels", () => {
    expect(levelOf(-0.3, 3)).toBe(0);
    expect(levelOf(7, 3)).toBe(2);
  });
});

describe(checkAnswers, () => {
  const questions = questionsFor(issue(), labels);

  it("takes answers of each question's own type and options", () => {
    expect(() => checkAnswers(questions, answers)).not.toThrow();
  });

  it("refuses a missing answer, another type, or a choice outside the options", () => {
    const { effort: _, ...missing } = answers;
    expect(() => checkAnswers(questions, missing)).toThrow(/"effort"/u);
    expect(() =>
      checkAnswers(questions, { ...answers, effort: { type: "noul", noul: 1 } })
    ).toThrow(/"effort"/u);
    expect(() =>
      checkAnswers(questions, {
        ...answers,
        scope: { type: "choice", choice: "scope:invented", probabilities: {} },
      })
    ).toThrow(/"scope"/u);
  });
});

/** A new issue, as the `issues: opened` event runs on it. */
const opened = { opened: true, removed: new Set<string>() };

describe(planChanges, () => {
  it("takes the answers that clear their thresholds", () => {
    const plan = planChanges(
      issue(),
      labels,
      questionsFor(issue(), labels),
      answers,
      opened
    );

    expect(plan.type).toBe("Bug");
    expect(plan.labels).toStrictEqual(["scope:deploy-watch"]);
    expect(plan.fields).toStrictEqual([
      { field: PRIORITY, value: "High" },
      { field: EFFORT, value: "Medium" },
    ]);
    expect(plan.notes).toContain("type: Bug at 96%");
  });

  it("leaves an unsure type or scope for a maintainer, and says so", () => {
    const unsure = {
      ...answers,
      type: {
        type: "choice",
        choice: "Feature",
        probabilities: { Bug: 0.45, Feature: 0.46, Task: 0.09 },
      },
      scope: {
        type: "choice",
        choice: "scope:repo",
        probabilities: {
          "scope:deploy-watch": 0.4,
          "scope:workers-mail": 0.1,
          "scope:repo": 0.49,
        },
      },
    } satisfies Answers;

    const plan = planChanges(
      issue(),
      labels,
      questionsFor(issue(), labels),
      unsure,
      opened
    );

    expect(plan.type).toBeNull();
    expect(plan.labels).toStrictEqual([]);
    expect(plan.notes).toContain(
      "type: Feature at 46%, under 60%: left for a maintainer"
    );
    expect(plan.notes).toContain(
      "scope: scope:repo at 49%, under 50%: left for a maintainer"
    );
  });

  it("adds a topic only when Clef is sure of it", () => {
    const plan = planChanges(
      issue(),
      labels,
      questionsFor(issue(), labels),
      {
        ...answers,
        "topic.security": { type: "noul", noul: 0.85 },
        "topic.documentation": { type: "noul", noul: 0.6 },
      },
      opened
    );

    expect(plan.labels).toStrictEqual(["scope:deploy-watch", "security"]);
  });

  it("adds needs-triage for an author outside the team, when the issue opens", () => {
    const outside = issue({ author_association: "NONE" });

    const plan = planChanges(
      outside,
      labels,
      questionsFor(outside, labels),
      answers,
      opened
    );

    expect(plan.labels).toStrictEqual(["scope:deploy-watch", "needs-triage"]);
  });

  it("adds no needs-triage on a run by hand", () => {
    const outside = issue({ author_association: "NONE" });

    const plan = planChanges(
      outside,
      labels,
      questionsFor(outside, labels),
      answers,
      {
        opened: false,
        removed: new Set(),
      }
    );

    expect(plan.labels).toStrictEqual(["scope:deploy-watch"]);
  });

  it("never adds again a label someone took off, and says so", () => {
    const outside = issue({ author_association: "NONE" });

    const plan = planChanges(
      outside,
      labels,
      questionsFor(outside, labels),
      { ...answers, "topic.security": { type: "noul", noul: 0.9 } },
      {
        opened: true,
        removed: new Set(["security", "needs-triage", "scope:deploy-watch"]),
      }
    );

    expect(plan.labels).toStrictEqual([]);
    expect(plan.notes).toContain(
      "security: taken off before, so not added again"
    );
    expect(plan.notes).toContain(
      "needs-triage: taken off before, so not added again"
    );
    expect(plan.notes).toContain(
      "scope:deploy-watch: taken off before, so not added again"
    );
  });

  it("adds only labels the repository has", () => {
    const bare = labels.filter((label) => label.name !== "needs-triage");
    const outside = issue({ author_association: "NONE" });

    const plan = planChanges(
      outside,
      bare,
      questionsFor(outside, bare),
      answers,
      opened
    );

    expect(plan.labels).toStrictEqual(["scope:deploy-watch"]);
  });

  it("keeps what someone set while Clef answered", () => {
    const questions = questionsFor(issue(), labels);

    const meanwhile = issue({
      type: { name: "Feature" },
      labels: ["scope:repo"],
      issue_field_values: [{ issue_field_id: EFFORT.id }],
    });

    const plan = planChanges(meanwhile, labels, questions, answers, opened);
    expect(plan.type).toBeNull();
    expect(plan.labels).toStrictEqual([]);
    expect(plan.fields).toStrictEqual([{ field: PRIORITY, value: "High" }]);
  });

  it("acts only on questions it asked", () => {
    const typed = issue({ type: { name: "Task" } });

    const plan = planChanges(
      typed,
      labels,
      questionsFor(typed, labels),
      answers,
      opened
    );

    expect(plan.type).toBeNull();
    expect(plan.notes.some((note) => note.startsWith("type:"))).toBeFalsy();
  });
});

describe(removedLabels, () => {
  it("names each label an unlabeled event took off, and nothing else", () => {
    const removed = removedLabels([
      { event: "labeled", label: { name: "security" } },
      { event: "unlabeled", label: { name: "security" } },
      { event: "labeled", label: { name: "security" } },
      { event: "unlabeled", label: { name: "needs-triage" } },
      { event: "renamed" },
      { event: "unlabeled", label: null },
    ]);

    expect([...removed]).toStrictEqual(["security", "needs-triage"]);
  });
});

describe(askClef, () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_AI_API_TOKEN: "api-token",
    GITHUB_WORKFLOW: "Issue labels",
    GITHUB_RUN_ID: "42",
    ISSUE_NUMBER: "57",
  };

  const questions = questionsFor(issue(), labels);

  it("asks Clef through the gateway, and reads the answers out of Cloudflare's envelope", async () => {
    const { calls, impl } = fakeFetch(200, {
      success: true,
      errors: [],
      messages: [],
      result: {
        model: "clef",
        answers,
        usage: { input_tokens: 1716, output_tokens: 0 },
      },
    });

    await expect(
      askClef(env, stateFor(issue()), questions, impl)
    ).resolves.toStrictEqual(answers);

    const [{ url, init }] = calls;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/cloudflare/clef"
    );
    expect(init.headers).toMatchObject({
      authorization: "Bearer api-token",
      "cf-aig-authorization": "Bearer api-token",
      "cf-aig-gateway-id": "github-rivi-tools",
      "cf-aig-metadata": JSON.stringify({
        workflow: "Issue labels",
        run: "42",
        issue: "57",
      }),
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "clef",
      questions,
    });
  });

  it("sends the gateway's own token, and another gateway, when they are set", async () => {
    const { calls, impl } = fakeFetch(200, { result: { answers } });
    await askClef(
      {
        ...env,
        CLOUDFLARE_AI_GATEWAY_TOKEN: "gateway-token",
        AI_GATEWAY: "elsewhere",
      },
      stateFor(issue()),
      questions,
      impl
    );
    expect(calls[0].init.headers).toMatchObject({
      "cf-aig-authorization": "Bearer gateway-token",
      "cf-aig-gateway-id": "elsewhere",
    });
  });

  it("fails on an error from Cloudflare, or answers outside the questions", async () => {
    const refused = fakeFetch(401, {
      success: false,
      errors: [{ code: 10_000, message: "Authentication error" }],
    });

    await expect(
      askClef(env, stateFor(issue()), questions, refused.impl)
    ).rejects.toThrow(/HTTP 401.*Authentication error/u);

    const wrong = fakeFetch(200, {
      result: { answers: { ...answers, type: { type: "noul", noul: 1 } } },
    });

    await expect(
      askClef(env, stateFor(issue()), questions, wrong.impl)
    ).rejects.toThrow(/"type"/u);
  });
});
