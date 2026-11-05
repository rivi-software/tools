/**
 * Labels the issue `ISSUE_NUMBER` with Clef through the AI Gateway (.github/workflows/issue-labels.yml):
 * its type, a `scope:*` label, topic labels, and the organization's Priority and Effort fields, each
 * only while the issue lacks it. scripts/issue-labels.ts says what is asked and what is added.
 *
 * Needs GITHUB_TOKEN (issues: write), GITHUB_REPOSITORY, ISSUE_NUMBER, CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_AI_API_TOKEN (Workers AI Read); CLOUDFLARE_AI_GATEWAY_TOKEN when the gateway takes a
 * token of its own, and AI_GATEWAY for a gateway other than github-rivi-tools.
 */

import { appendFileSync } from "node:fs";
import { askClef, planChanges, questionsFor, stateFor } from "./issue-labels.ts";
import type { Issue, Label } from "./issue-labels.ts";

const env = process.env;

async function github<T>(method: string, path: string, body?: object): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}

/** What it did, and what it left for a maintainer: a line each. */
async function labelIssue(number: number): Promise<string[]> {
  const issue = await github<Issue>("GET", `/issues/${number}`);
  if (issue.pull_request) throw new Error(`#${number} is a pull request.`);

  const labels = await github<Label[]>("GET", "/labels?per_page=100");
  const questions = questionsFor(issue, labels);
  if (Object.keys(questions).length === 0) return ["It has a type, a scope, topics and fields."];

  const answers = await askClef(env, stateFor(issue), questions);

  // Read the issue again after Clef answers, so what someone set in the meantime stays.
  const current = await github<Issue>("GET", `/issues/${number}`);
  const plan = planChanges(current, labels, questions, answers);
  const done = [...plan.notes];

  if (plan.labels.length) {
    await github("POST", `/issues/${number}/labels`, { labels: plan.labels });
    done.push(`Added ${plan.labels.map((name) => `\`${name}\``).join(", ")}.`);
  }
  if (plan.type) {
    await github("PATCH", `/issues/${number}`, { type: plan.type });
    done.push(`Set the type to ${plan.type}.`);
  }
  // Never an empty list: GitHub reads that as clearing every field the issue has.
  if (plan.fields.length) {
    await github("POST", `/issues/${number}/issue-field-values`, {
      issue_field_values: plan.fields.map(({ field, value }) => ({ field_id: field.id, value })),
    });
    done.push(
      `Set ${plan.fields.map(({ field, value }) => `${field.name} to ${value}`).join(", ")}.`,
    );
  }
  return done;
}

for (const name of [
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "ISSUE_NUMBER",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_API_TOKEN",
]) {
  if (!env[name]) {
    console.log(`::error title=Issue labels::Set ${name}.`);
    process.exit(1);
  }
}

try {
  const done = await labelIssue(Number(env.ISSUE_NUMBER));
  const summary = `## Issue #${env.ISSUE_NUMBER}\n\n${done.map((line) => `- ${line}`).join("\n")}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
} catch (error) {
  console.log(`::error title=Issue labels::${(error as Error).message.replaceAll("%", "%25")}`);
  process.exit(1);
}
