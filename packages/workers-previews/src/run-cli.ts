import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  cloudflareApiToken,
  requireCloudflareAccountId,
  runCommand,
  type RunOptions,
  type RunResult,
} from "@rivi-software/cloudflare-deploy";
import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { deployPreview } from "./deploy.js";
import { githubRepository } from "./github.js";
import { previewName } from "./name.js";
import {
  previewInventory,
  sweepPreviews,
  deleteBranchPreviews,
  targetLabel,
  type PreviewEntry,
  type PreviewsTarget,
} from "./previews.js";

export const USAGE = `Usage:
  cf-previews deploy [--branch <name>] [--worker <name>] [-- <wrangler preview options>]
  cf-previews delete [--branch <name>] [--worker <name>] [--skip-build-check]
  cf-previews list   [--worker <name>] [--repository <owner/name>] [--json]
  cf-previews sweep  [--apply] [--worker <name>] [--repository <owner/name>]
                     [--keep <preview>]... [--skip-build-check]
  cf-previews name   [--branch <name>]

  deploy   Runs wrangler preview for the branch, under the branch's Preview name.
  delete   Deletes the branch's Previews: the one under its Preview name, and the one
           named after the branch itself. Refuses while a Workers Build of the branch runs.
  list     Lists the Worker's Previews, each with its branch, its last deployment and
           whether the branch still exists.
  sweep    Lists the Previews whose branch is deleted or whose pull requests are all
           closed. With --apply, deletes them.
  name     Prints the branch's Preview name.

  --branch              The branch (default: Workers Builds', GitHub Actions' or
                        GitLab CI's branch variable, else Git's current branch)
  --production-branch   The branch that gets no Preview (default: main)
  --worker              The Worker (default: WRANGLER_CI_OVERRIDE_NAME; for deploy,
                        else the name in Wrangler's config)
  --repository          The GitHub repository, owner/name (default: GITHUB_REPOSITORY)
  --keep                A Preview the sweep never deletes; repeat it for more
  --apply               Delete the stale Previews, rather than only list them
  --skip-build-check    Delete without asking Workers Builds whether a build runs
  --json                Print the list as JSON

It reads CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (else wrangler login's token),
CLOUDFLARE_BUILDS_API_TOKEN (for Workers Builds; default CLOUDFLARE_API_TOKEN),
GITHUB_TOKEN and GITHUB_API_URL.`;

type Env = Record<string, string | undefined>;

export type CliContext = {
  env: Env;
  /** The directory Wrangler and Git run in. */
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** The transport for Cloudflare and GitHub; tests pass a fake. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Runs Wrangler and Git; tests pass a fake. Default `runCommand`. */
  run?: (args: string[], options: RunOptions) => Promise<RunResult>;
};

const OPTIONS = {
  branch: { type: "string" },
  "production-branch": { type: "string" },
  worker: { type: "string" },
  repository: { type: "string" },
  keep: { type: "string", multiple: true },
  apply: { type: "boolean" },
  "skip-build-check": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Option = keyof typeof OPTIONS;

/** The options each command takes, besides `--help`. */
const COMMANDS: Record<string, Option[]> = {
  deploy: ["branch", "production-branch", "worker"],
  delete: ["branch", "production-branch", "worker", "skip-build-check"],
  list: ["production-branch", "worker", "repository", "json"],
  sweep: ["production-branch", "worker", "repository", "keep", "apply", "skip-build-check"],
  name: ["branch", "production-branch"],
};

/** Runs `cf-previews` with `args` and returns its exit code: 0, 1 when it failed, 2 for bad usage. */
export async function runCli(
  args: string[],
  context: CliContext = {
    env: process.env,
    cwd: process.cwd(),
    log: console.log,
    error: console.error,
  },
): Promise<number> {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const wrangler = separator === -1 ? [] : args.slice(separator + 1);
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: own,
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    context.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    context.log(USAGE);
    return 0;
  }
  const [command, ...extra] = positionals;
  const allowed = COMMANDS[command ?? ""];
  const misplaced = Object.keys(values).find((option) => !allowed?.includes(option as Option));
  if (!allowed || misplaced || extra.length || (wrangler.length && command !== "deploy")) {
    context.error(allowed && misplaced ? `${command} takes no --${misplaced}\n\n${USAGE}` : USAGE);
    return 2;
  }

  const env = context.env;
  const productionBranch = values["production-branch"];
  try {
    switch (command) {
      case "name": {
        context.log(previewName(await branchOf(values.branch, context), { productionBranch }));
        return 0;
      }
      case "deploy": {
        const branch = await branchOf(values.branch, context);
        const deployed = await deployPreview({
          branch,
          productionBranch,
          worker: workerOf(values.worker, env, false),
          args: wrangler,
          cwd: context.cwd,
          env,
          run: context.run,
        });
        context.log(`Preview ${deployed.name} of ${branch} on ${deployed.worker}`);
        for (const url of deployed.urls) context.log(url);
        if (!deployed.urls.length)
          context.error(
            `The Preview has no URL: turn on Preview URLs for ${deployed.worker} (preview_urls in Wrangler's config, deployed with wrangler deploy).`,
          );
        await githubOutputs(env, deployed.name, deployed.urls[0], branch);
        return 0;
      }
      case "delete": {
        const branch = await branchOf(values.branch, context);
        const target = await cloudflare(values, context, true);
        const deleted = await deleteBranchPreviews(target, branch);
        if (!deleted.length) context.log(`No Preview of ${branch} to delete`);
        return 0;
      }
      case "list": {
        const target = await cloudflare(values, context, false);
        const entries = await previewInventory({ ...target, repository: github(values, context) });
        if (values.json)
          context.log(JSON.stringify({ worker: target.worker, previews: entries }, null, 2));
        else if (!entries.length) context.log(`${target.worker} has no Previews`);
        else
          context.log(
            table([
              ["Preview", "Branch", "Last deployment", "Branch exists"],
              ...entries.map((entry) => [
                entry.name,
                owner(entry),
                entry.deployedOn ?? "never",
                entry.branchExists === undefined ? "?" : entry.branchExists ? "yes" : "no",
              ]),
            ]),
          );
        return 0;
      }
      case "sweep": {
        const target = await cloudflare(values, context, true);
        const apply = values.apply ?? false;
        const result = await sweepPreviews({
          ...target,
          repository: github(values, context),
          keep: values.keep,
          apply,
        });
        const rows = result.entries.map((entry) => [
          entry.action,
          entry.name,
          owner(entry),
          entry.reason,
        ]);
        const stale = result.entries.filter((entry) => entry.action === "delete").length;
        const total = `${stale} of ${result.entries.length} Previews of ${target.worker} are stale`;
        const outcome = !apply
          ? stale
            ? "Nothing was deleted: run the sweep with --apply to delete them."
            : undefined
          : result.failed.length
            ? `${result.failed.length} of ${result.targets.length} deletes failed; ${result.deleted.length} Previews were deleted`
            : `Deleted ${result.deleted.length} Previews`;
        if (rows.length) context.log(table([["Action", "Preview", "Branch", "Reason"], ...rows]));
        context.log(total);
        await stepSummary(env, [
          `### Preview sweep of ${target.worker}${apply ? "" : " (dry run)"}`,
          "",
          total,
          ...(rows.length
            ? [
                "",
                "| Action | Preview | Branch | Reason |",
                "| --- | --- | --- | --- |",
                ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
              ]
            : []),
          ...(outcome ? ["", outcome] : []),
          ...result.failed.map(
            (failure) =>
              `- Could not delete ${cell(targetLabel(failure.target))}: ${cell(failure.error)}`,
          ),
          "",
        ]);
        if (!outcome) return 0;
        if (result.failed.length) {
          context.error(outcome);
          return 1;
        }
        context.log(outcome);
        return 0;
      }
    }
  } catch (error) {
    context.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return 2;
}

/** `--branch`, else the branch the CI run is for, else Git's current branch. */
async function branchOf(option: string | undefined, context: CliContext): Promise<string> {
  const env = context.env;
  const branch =
    option ||
    env.WORKERS_CI_BRANCH ||
    env.GITHUB_HEAD_REF ||
    (env.GITHUB_REF_TYPE === "branch" ? env.GITHUB_REF_NAME : undefined) ||
    env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ||
    env.CI_COMMIT_BRANCH;
  if (branch) return branch;
  const git = await (context.run ?? runCommand)(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd: context.cwd,
      capture: true,
    },
  ).catch(() => undefined);
  const current = git?.code === 0 ? git.stdout.trim() : "";
  if (!current) throw new Error("No branch: pass --branch <name>");
  return current;
}

/**
 * `--worker`, else the Worker Workers Builds is building. Wrangler deploys to the latter whatever
 * `--worker-name` says, so the two must agree.
 */
function workerOf(option: string | undefined, env: Env, required: true): string;
function workerOf(option: string | undefined, env: Env, required: false): string | undefined;
function workerOf(option: string | undefined, env: Env, required: boolean) {
  const override = env.WRANGLER_CI_OVERRIDE_NAME;
  if (option && override && option !== override)
    throw new Error(
      `--worker ${option} is not the Worker Workers Builds is building (WRANGLER_CI_OVERRIDE_NAME=${override})`,
    );
  const worker = option || override;
  if (required && !worker) throw new Error("No Worker: pass --worker <name>");
  return worker;
}

/** The Cloudflare clients for a command, from the environment. */
async function cloudflare(
  values: { worker?: string; "production-branch"?: string; "skip-build-check"?: boolean },
  context: CliContext,
  deletes: boolean,
): Promise<PreviewsTarget> {
  const env = context.env;
  const worker = workerOf(values.worker, env, true);
  const accountId = requireCloudflareAccountId(env);
  const options = { accountId, fetch: context.fetch, retry: { attempts: 5 } };
  const api = cloudflareApi({ ...options, token: await cloudflareApiToken(env) });
  const buildsToken = env.CLOUDFLARE_BUILDS_API_TOKEN;
  return {
    api,
    worker,
    builds:
      !deletes || values["skip-build-check"]
        ? false
        : buildsToken
          ? cloudflareApi({ ...options, token: buildsToken })
          : api,
    productionBranch: values["production-branch"],
    log: context.log,
  };
}

/** The repository's state from GitHub. */
function github(values: { repository?: string }, context: CliContext) {
  const repository = values.repository || context.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("No repository: pass --repository <owner/name>");
  return githubRepository({
    repository,
    token: context.env.GITHUB_TOKEN || undefined,
    apiUrl: context.env.GITHUB_API_URL || undefined,
    fetch: context.fetch,
  });
}

/** Text for a Markdown table cell or list item, its pipes escaped. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function owner(entry: PreviewEntry): string {
  if (entry.kind === "pull-request")
    return `#${entry.number}${entry.branch === undefined ? "" : ` (${entry.branch})`}`;
  return entry.branch ?? "(unknown)";
}

/** Rows as columns padded to their widest cell. */
function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
        .join("  "),
    )
    .join("\n");
}

/** The Preview's name and first URL as step outputs, and a line in the job summary, on GitHub Actions. */
async function githubOutputs(env: Env, name: string, url: string | undefined, branch: string) {
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, `preview_name=${name}\npreview_url=${url ?? ""}\n`);
  await stepSummary(env, [`Preview \`${name}\` of \`${branch}\`: ${url ?? "no URL"}`, ""]);
}

async function stepSummary(env: Env, lines: string[]) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
