/**
 * What scripts/label-issue.ts asks Clef, Cloudflare's decision model on Workers AI, about an issue,
 * and what it changes from the answers. Clef reads the issue and answers typed questions with a
 * probability for every option it was given:
 *
 * - the issue type (Bug, Feature or Task), as a `choice`;
 * - its `scope:*` label, as a `choice` between the repository's scope labels;
 * - each topic label, as a `noul` (yes or no);
 * - the organization's Priority and Effort fields, as a `score` on a rubric.
 *
 * An answer can only be one of the options asked for, and one below its threshold is left for a
 * maintainer. Only what the issue lacks is asked and added: a label, type or field value someone
 * set stays, nothing is taken off, and a label someone took off is never added again. An issue
 * from outside the team also gets `needs-triage` when it opens.
 * The candidates are the repository's labels with their descriptions, so a new package needs only
 * a new `scope:*` label.
 */

export type Env = Record<string, string | undefined>;

export interface Label {
  name: string;
  description?: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body?: string | null;
  /** An issue made through the API may name its labels instead of giving them as objects. */
  labels: (Label | string)[];
  type?: { name: string } | null;
  author_association?: string;
  pull_request?: unknown;
  /** The organization's issue fields set on it. */
  issue_field_values?: { issue_field_id: number }[] | null;
}

/** A Clef question: https://developers.cloudflare.com/workers-ai/models/clef/ */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** The questions asked about one issue, by question id. */
export type Questions = Record<string, Question>;

/** Clef's answer to a question of the same type. `score` is probability-weighted, from 0. */
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number };

/** Clef's answers to the questions, by question id. */
export type Answers = Record<string, Answer>;

/** An answer as Clef returns it, before checkAnswers holds it to its question. */
export interface RawAnswer {
  type?: unknown;
  noul?: unknown;
  score?: unknown;
  choice?: unknown;
  probabilities?: unknown;
}

/** Clef's answers as they come back, by question id. */
export type RawAnswers = Record<string, RawAnswer>;

/** One of the organization's single-select issue fields, with its options lowest first. */
export interface IssueField {
  id: number;
  name: string;
  levels: string[];
}

/** One of an issue's timeline events, as GitHub's REST API lists them. */
export interface IssueEvent {
  event: string;
  label?: { name: string } | null;
}

/** Where the run stands: whether the issue just opened, and the labels someone took off it. */
export interface Context {
  opened: boolean;
  removed: ReadonlySet<string>;
}

/** What Clef reads about the issue: the repository, and the issue as its author wrote it. */
export interface IssueState {
  repository: string;
  issue: { title: string; body: string; labels: string[] };
}

/** What to change on the issue, and a line for each answer that was asked. */
export interface Plan {
  labels: string[];
  type: string | null;
  fields: { field: IssueField; value: string }[];
  notes: string[];
}

export const MODEL = "@cf/cloudflare/clef";

/** The gateway the calls go through unless `AI_GATEWAY` names another. */
export const GATEWAY = "github-rivi-tools";

/** The lowest probability at which an answer is acted on. */
export const THRESHOLDS = { type: 0.6, scope: 0.5, topic: 0.8 };

/** The organization's issue types, and when each applies. */
export const TYPES = {
  Bug: "Something is broken, or behaves differently from what its README or types say",
  Feature:
    "New behaviour, or a change to existing behaviour, that the users of a package would notice",
  Task: "A chore, refactor, docs, CI, dependency or tooling change that users would not notice",
} satisfies Record<string, string>;

/** The topic labels Clef may add. `breaking-change` is a maintainer's call, so it is not here. */
export const TOPICS = [
  "security",
  "performance",
  "documentation",
  "accessibility",
  "question",
];

// The organization's fields (`gh api /orgs/rivi-software/issue-fields`). The app's token may set
// an issue's field values but not list the organization's fields, so their ids live here.
export const PRIORITY: IssueField = {
  id: 47_186_122,
  name: "Priority",
  levels: ["Low", "Medium", "High", "Urgent"],
};

export const EFFORT: IssueField = {
  id: 47_186_125,
  name: "Effort",
  levels: ["Low", "Medium", "High"],
};

/** What each level means to Clef, lowest first. */
const RUBRICS = new Map<IssueField, string[]>([
  [
    PRIORITY,
    [
      "Low: polish, ideas, refactors and chores nobody is waiting on",
      "Medium: a bug with a workaround, or a planned improvement users would notice",
      "High: a bug people hit with no workaround, a regression, or a security weakness",
      "Urgent: a release is broken for everyone, data is lost or exposed, or a security hole can be exploited now",
    ],
  ],
  [
    EFFORT,
    [
      "Low: up to a day, a change in one place",
      "Medium: a few days, several files in one package",
      "High: a week or more: a new package, a change across packages, or open design questions",
    ],
  ],
]);

const REPOSITORY =
  "rivi-software/tools: small npm packages for Cloudflare Workers, Vite, React and TanStack Start, and rivi-bot, Claude in GitHub Actions";

const TEAM = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Clef reads up to 64K tokens; a longer body says nothing more about its labels. */
const MAX_BODY = 16_000;

/** Whether a label is given as its name alone, rather than as an object. */
const isLabelName = (label: Label | string): label is string =>
  typeof label === "string";

const labelName = (label: Label | string): string =>
  isLabelName(label) ? label : label.name;

/** The question id for a topic: ids take letters, digits, `_`, `.` and `-` only. */
const topicId = (topic: string): string =>
  `topic.${topic.replaceAll(/[^A-Za-z0-9_.-]/gu, "-")}`;

/**
 * The questions about what the issue lacks: its type, a scope, each topic label the repository
 * has, and each field it has no value for. None when it lacks nothing.
 */
export const questionsFor = (issue: Issue, repoLabels: Label[]) => {
  const has = new Set(issue.labels.map(labelName));
  const questions: Questions = {};

  if (!issue.type) {
    questions.type = {
      type: "choice",
      instructions: "What kind of issue is this?",
      criteria: TYPES,
    };
  }

  const scopes = repoLabels.filter((label) => label.name.startsWith("scope:"));

  if (
    scopes.length > 1 &&
    ![...has].some((name) => name.startsWith("scope:"))
  ) {
    questions.scope = {
      type: "choice",
      instructions: "Which part of the repository is this issue about?",
      criteria: Object.fromEntries(
        scopes.map((label) => [
          label.name,
          label.description || label.name.slice(6),
        ])
      ),
    };
  }

  for (const label of repoLabels) {
    if (TOPICS.includes(label.name) && !has.has(label.name)) {
      questions[topicId(label.name)] = {
        type: "noul",
        instructions: `Is this issue clearly about this topic? ${label.name}: ${label.description || label.name}`,
      };
    }
  }

  const set = new Set(
    (issue.issue_field_values ?? []).map((value) => value.issue_field_id)
  );

  for (const [field, rubric] of RUBRICS) {
    if (!set.has(field.id)) {
      questions[field.name.toLowerCase()] = {
        type: "score",
        instructions:
          field === PRIORITY
            ? "How soon should this work happen? When torn between two levels, pick the lower."
            : "How much work is this for one developer with a coding agent, including tests and docs?",
        criteria: rubric,
      };
    }
  }

  return questions;
};

/** What Clef reads: the repository, and the issue as its author wrote it. */
export const stateFor = (issue: Issue): IssueState => {
  const body = issue.body ?? "";

  return {
    repository: REPOSITORY,
    issue: {
      title: issue.title,
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
      labels: issue.labels.map(labelName),
    },
  };
};

const isNumber = (value: unknown): value is number => typeof value === "number";

const isString = (value: unknown): value is string => typeof value === "string";

/** Whether a value is a JSON object, as `typeof` reads it: null counts, as it did before. */
const isObjectLike = (value: unknown): value is object =>
  typeof value === "object";

/** Whether Clef answered a question with an object, rather than leaving it out. */
const isRawAnswer = (answer: RawAnswer | undefined): answer is RawAnswer =>
  typeof answer === "object" && answer !== null;

/** Whether an answer has the shape of the question it answers, with a choice among its options. */
const answersQuestion = (question: Question, answer: RawAnswer): boolean => {
  if (answer.type !== question.type) {
    return false;
  }

  if (question.type === "noul") {
    return isNumber(answer.noul);
  }

  if (question.type === "score") {
    return isNumber(answer.score);
  }

  return (
    isString(answer.choice) &&
    Object.hasOwn(question.criteria, answer.choice) &&
    isObjectLike(answer.probabilities)
  );
};

/** Throws unless every question has an answer of its own type, and a choice one of its options. */
export const checkAnswers: (
  questions: Questions,
  answers: RawAnswers
) => asserts answers is Answers = (questions, answers) => {
  for (const [id, question] of Object.entries(questions)) {
    const answer: RawAnswer | undefined = answers[id];

    if (!isRawAnswer(answer) || !answersQuestion(question, answer)) {
      throw new Error(
        `Clef answered "${id}" outside its question: ${JSON.stringify(answer)}`
      );
    }
  }
};

/** The level a probability-weighted score lands on; halfway between two is the lower. */
export const levelOf = (score: number, levels: number): number =>
  Math.min(levels - 1, Math.max(0, Math.ceil(score - 0.5)));

const percent = (probability: number): string =>
  `${Math.round(probability * 100)}%`;

/** The labels someone took off the issue, from its events: a run never adds them again. */
export const removedLabels = (events: IssueEvent[]): Set<string> =>
  new Set(
    events.flatMap((event) =>
      event.event === "unlabeled" && event.label ? [event.label.name] : []
    )
  );

/** Adds the topic labels whose answer clears the topic threshold, with a note for each. */
const planTopics = (
  questions: Questions,
  answers: Answers,
  plan: Plan
): void => {
  for (const topic of TOPICS) {
    const answer = answers[topicId(topic)];

    if (!questions[topicId(topic)] || answer?.type !== "noul") {
      continue;
    }

    if (answer.noul >= THRESHOLDS.topic) {
      plan.labels.push(topic);
      plan.notes.push(`${topic}: yes at ${percent(answer.noul)}`);
    }
  }
};

/** Adds a level for each field the issue has no value for, with a note for each. */
const planFields = (
  questions: Questions,
  answers: Answers,
  set: ReadonlySet<number>,
  plan: Plan
): void => {
  for (const field of RUBRICS.keys()) {
    const id = field.name.toLowerCase();
    const answer = answers[id];

    if (!questions[id] || answer?.type !== "score" || set.has(field.id)) {
      continue;
    }

    const value = field.levels[levelOf(answer.score, field.levels.length)];
    plan.fields.push({ field, value });
    plan.notes.push(`${id}: ${value} (score ${answer.score.toFixed(2)})`);
  }
};

/**
 * What to change: the labels and the type whose answer clears its threshold, a level for each
 * field, and `needs-triage` for an author outside the team when the issue just opened, not on a
 * later run by hand. Only labels the repository has, none someone took off, and nothing the issue
 * has by now: `issue` is read again after Clef answers, so a type, scope or field value someone
 * set in the meantime stays.
 */
export const planChanges = (
  issue: Issue,
  repoLabels: Label[],
  questions: Questions,
  answers: Answers,
  context: Context
): Plan => {
  const exists = new Set(repoLabels.map((label) => label.name));
  const has = new Set(issue.labels.map(labelName));

  const set = new Set(
    (issue.issue_field_values ?? []).map((value) => value.issue_field_id)
  );

  const plan: Plan = { labels: [], type: null, fields: [], notes: [] };

  const choose = (id: string, threshold: number): string | null => {
    const answer = answers[id];

    if (!questions[id] || answer?.type !== "choice") {
      return null;
    }

    const probability = answer.probabilities[answer.choice] ?? 0;
    const taken = probability >= threshold;
    plan.notes.push(
      `${id}: ${answer.choice} at ${percent(probability)}${taken ? "" : `, under ${percent(threshold)}: left for a maintainer`}`
    );

    return taken ? answer.choice : null;
  };

  const type = choose("type", THRESHOLDS.type);

  if (type && Object.hasOwn(TYPES, type) && !issue.type) {
    plan.type = type;
  }

  const scope = choose("scope", THRESHOLDS.scope);

  if (scope && ![...has].some((name) => name.startsWith("scope:"))) {
    plan.labels.push(scope);
  }

  planTopics(questions, answers, plan);
  planFields(questions, answers, set, plan);

  if (context.opened && !TEAM.has(issue.author_association ?? "")) {
    plan.labels.push("needs-triage");
  }

  const add = [...new Set(plan.labels)].filter(
    (name) => exists.has(name) && !has.has(name)
  );

  for (const label of add.filter((name) => context.removed.has(name))) {
    plan.notes.push(`${label}: taken off before, so not added again`);
  }

  plan.labels = add.filter((name) => !context.removed.has(name));

  return plan;
};

/** Asks Clef the questions about the state, through the AI Gateway. */
export const askClef = async (
  env: Env,
  state: IssueState,
  questions: Questions,
  fetchImpl: typeof fetch = fetch
): Promise<Answers> => {
  const metadata = Object.fromEntries(
    Object.entries({
      workflow: env.GITHUB_WORKFLOW,
      run: env.GITHUB_RUN_ID,
      issue: env.ISSUE_NUMBER,
    }).filter(([, value]) => value)
  );

  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_AI_API_TOKEN}`,
        // An authenticated gateway takes a token of its own; one token can also serve both.
        "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN || env.CLOUDFLARE_AI_API_TOKEN}`,
        "cf-aig-gateway-id": env.AI_GATEWAY || GATEWAY,
        "cf-aig-metadata": JSON.stringify(metadata),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL.slice(MODEL.lastIndexOf("/") + 1),
        state,
        questions,
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Clef returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  // The REST API wraps the model's output in Cloudflare's envelope, as `result`.
  // SAFETY: a 2xx answer from the REST API is JSON, with the model's own output under result.
  const json = JSON.parse(text) as {
    result?: { answers?: unknown };
    answers?: unknown;
  };

  const { answers } = json.result ?? json;

  if (!isObjectLike(answers) || answers === null) {
    throw new Error(`Clef answered without answers: ${text.slice(0, 500)}`);
  }

  // SAFETY: checkAnswers holds every answer to the question it answers, right below.
  const record = answers as RawAnswers;
  checkAnswers(questions, record);

  return record;
};
