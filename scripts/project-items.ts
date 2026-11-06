/**
 * What scripts/add-to-project.ts asks GitHub for, and what it does with each answer: which open
 * issues and pull requests belong on the organization's open-source project, and the Status each
 * one starts in.
 */

/** An issue or a pull request, as GitHub returns it now. */
export interface Item {
  __typename: "Issue" | "PullRequest";
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Pull requests only. */
  isDraft?: boolean;
  /** null when the account is gone. */
  author: { __typename: string; login: string } | null;
  repository: { nameWithOwner: string };
}

/** The Status options an item starts in. The project must have each. */
export const STARTING_STATUSES = ["Triage", "In Progress", "In Review"] as const;
export type StartingStatus = (typeof STARTING_STATUSES)[number];

/**
 * The open issues and pull requests in the owner's public repositories that are not on the
 * project yet. A private or archived repository's never match.
 */
export function searchQuery(owner: string, project: number): string {
  return `org:${owner} is:public is:open archived:false -project:${owner}/${project}`;
}

/**
 * The project's open cards that have no Status: one whose Status could not be set when it was
 * added, or one someone added by hand.
 */
export const MISSING_STATUS_QUERY = "no:status is:open";

/**
 * Why the item stays off the project, or undefined when it goes on. The search index can lag
 * behind an item that closed a moment ago, so this reads the state GitHub returns with the item.
 * What a bot opened stays off, such as Dependabot's updates, the release pull request and RIVI
 * Bot's housekeeping reports.
 */
export function leaveOffReason(item: Item): string | undefined {
  if (item.state !== "OPEN") return `it is ${item.state.toLowerCase()}`;
  if (item.author?.__typename === "Bot") return `${item.author.login} opened it`;
  return undefined;
}

/** Whether a card's content is an issue or a pull request, rather than a draft issue. */
export function isIssueOrPullRequest(content: { __typename: string } | null): content is Item {
  return content?.__typename === "Issue" || content?.__typename === "PullRequest";
}

/** An issue waits for triage; a pull request is in review, or in progress while a draft. */
export function startingStatus(item: Item): StartingStatus {
  if (item.__typename === "Issue") return "Triage";
  return item.isDraft ? "In Progress" : "In Review";
}

/** The option ID for each starting status, or an error naming the ones the project lacks. */
export function statusOptionIds(
  options: { id: string; name: string }[],
): Record<StartingStatus, string> {
  const ids = Object.fromEntries(options.map(({ id, name }) => [name, id]));
  const missing = STARTING_STATUSES.filter((name) => !ids[name]);
  if (missing.length) {
    throw new Error(`The project's Status field lacks ${missing.join(", ")}.`);
  }
  return Object.fromEntries(STARTING_STATUSES.map((name) => [name, ids[name]])) as Record<
    StartingStatus,
    string
  >;
}
