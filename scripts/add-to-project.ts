/**
 * Adds the open issues and pull requests of the owner's public repositories to its open-source
 * project, each with a first Status (.github/workflows/oss-project.yml). It finds them with a
 * search that leaves out what is on the project already, so a run adds only what is new, and a
 * public repository needs nothing to take part. Then it gives a starting Status to each open card
 * that has none, which takes care of a card whose Status could not be set when it was added: the
 * search no longer finds that one. scripts/project-items.ts says which items go on and the Status
 * each starts in.
 *
 * One item that fails does not stop the others. The run fails at the end when an item could not
 * be added or still has no Status, and the next run tries again.
 *
 * Needs GITHUB_TOKEN (organization projects: write), PROJECT_OWNER and PROJECT_NUMBER.
 */

import { appendFileSync } from "node:fs";

import {
  MISSING_STATUS_QUERY,
  isIssueOrPullRequest,
  leaveOffReason,
  searchQuery,
  startingStatus,
  statusOptionIds,
} from "./project-items.ts";
import type { Item, StartingStatus } from "./project-items.ts";

const { env } = process;

/** The fields read for an issue or a pull request, in a search or on a card. */
const ITEM_FIELDS = `
  __typename
  ... on Issue {
    id number title url state
    author { __typename login }
    repository { nameWithOwner }
  }
  ... on PullRequest {
    id number title url state isDraft
    author { __typename login }
    repository { nameWithOwner }
  }
`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** One page of the items a search finds. */
interface SearchPage {
  search: { nodes: Item[]; pageInfo: PageInfo };
}

/** A card on the project, with the issue or pull request it holds. */
interface Card {
  id: string;
  content: { __typename: string } | null;
}

/** One page of the project's cards. */
interface CardPage {
  node: { items: { nodes: Card[]; pageInfo: PageInfo } };
}

/** A value a GraphQL variable takes: this script passes scalars only. */
type Variable = string | number | boolean | null;

const graphql = async <T>(
  query: string,
  variables: Record<string, Variable>
): Promise<T> => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  // SAFETY: GitHub's GraphQL API answers JSON with data, errors, or both.
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };

  if (body.errors?.length) {
    throw new Error(
      `GitHub GraphQL: ${body.errors.map((error) => error.message).join("; ")}`
    );
  }

  // SAFETY: a response without errors carries the data the query asked for.
  return body.data as T;
};

interface Project {
  id: string;
  title: string;
  fieldId: string;
  optionIds: Record<StartingStatus, string>;
}

const project = async (owner: string, number: number): Promise<Project> => {
  const data = await graphql<{
    organization: {
      projectV2: {
        id: string;
        title: string;
        field: { id: string; options: { id: string; name: string }[] } | null;
      } | null;
    };
  }>(
    `
      query ($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            title
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { owner, number }
  );

  const found = data.organization.projectV2;

  if (!found) {
    throw new Error(
      `${owner} has no project ${number}, or the token cannot see it.`
    );
  }

  if (!found.field) {
    throw new Error(`${found.title} has no single-select Status field.`);
  }

  return {
    id: found.id,
    title: found.title,
    fieldId: found.field.id,
    optionIds: statusOptionIds(found.field.options),
  };
};

/** Every item the search finds, a page of a hundred at a time. Search stops at a thousand. */
const search = async (query: string): Promise<Item[]> => {
  const items: Item[] = [];

  for (let after: string | null = null; ;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the cursor of the page before
    const data: SearchPage = await graphql(
      `query ($query: String!, $after: String) {
        search(type: ISSUE, query: $query, first: 100, after: $after) {
          nodes { ${ITEM_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query, after }
    );

    items.push(...data.search.nodes);

    if (!data.search.pageInfo.hasNextPage) {
      return items;
    }

    after = data.search.pageInfo.endCursor;
  }
};

/**
 * The project's open cards without a Status. Read in full before any changes, since setting a
 * Status takes a card out of the filter and would shift the pages.
 */
const cardsWithoutStatus = async (target: Project): Promise<Card[]> => {
  const cards: Card[] = [];

  for (let after: string | null = null; ;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the cursor of the page before
    const data: CardPage = await graphql(
      `query ($project: ID!, $query: String!, $after: String) {
        node(id: $project) {
          ... on ProjectV2 {
            items(first: 100, query: $query, after: $after) {
              nodes { id content { ${ITEM_FIELDS} } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { project: target.id, query: MISSING_STATUS_QUERY, after }
    );

    cards.push(...data.node.items.nodes);

    if (!data.node.items.pageInfo.hasNextPage) {
      return cards;
    }

    after = data.node.items.pageInfo.endCursor;
  }
};

/**
 * Adds the item and returns its card, with the Status the card has. Adding one that is on the
 * project already, which a search that lags can still return, gives back its card as it is.
 */
const addItem = async (
  target: Project,
  item: Item
): Promise<{ id: string; status?: string }> => {
  const data = await graphql<{
    addProjectV2ItemById: {
      item: { id: string; fieldValueByName: { name?: string } | null };
    };
  }>(
    `
      mutation ($project: ID!, $content: ID!) {
        addProjectV2ItemById(
          input: { projectId: $project, contentId: $content }
        ) {
          item {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
        }
      }
    `,
    { project: target.id, content: item.id }
  );

  const card = data.addProjectV2ItemById.item;

  return { id: card.id, status: card.fieldValueByName?.name };
};

const setStatus = async (
  target: Project,
  card: string,
  status: StartingStatus
): Promise<void> => {
  await graphql(
    `
      mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $project
            itemId: $item
            fieldId: $field
            value: { singleSelectOptionId: $option }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      project: target.id,
      item: card,
      field: target.fieldId,
      option: target.optionIds[status],
    }
  );
};

const link = (item: Item): string =>
  `[${item.repository.nameWithOwner}#${item.number}](${item.url})`;

// SAFETY: fetch, JSON.parse and this script throw Errors.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch binding is whatever was thrown
const message = (error: unknown): string => (error as Error).message;

interface Report {
  lines: string[];
  /** Items that could not be added. */
  notAdded: number;
  /** Cards still without a Status, by card ID. */
  withoutStatus: Set<string>;
}

const addNewItems = async (
  target: Project,
  owner: string,
  number: number,
  report: Report
) => {
  for (const item of await search(searchQuery(owner, number))) {
    const reason = leaveOffReason(item);

    if (reason) {
      report.lines.push(`Left off ${link(item)}: ${reason}.`);
      continue;
    }

    let card: { id: string; status?: string };

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one item at a time, so one failure leaves the others alone
      card = await addItem(target, item);
    } catch (error) {
      report.notAdded += 1;
      report.lines.push(`Could not add ${link(item)}: ${message(error)}`);
      continue;
    }

    if (card.status) {
      report.lines.push(
        `${link(item)} was on the project already, in ${card.status}.`
      );
      continue;
    }

    const status = startingStatus(item);

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one item at a time, so one failure leaves the others alone
      await setStatus(target, card.id, status);
      report.lines.push(`Added ${link(item)} in ${status}: ${item.title}`);
    } catch (error) {
      report.withoutStatus.add(card.id);
      report.lines.push(
        `Added ${link(item)}, but could not set its Status: ${message(error)}`
      );
    }
  }
};

const fillMissingStatuses = async (target: Project, report: Report) => {
  for (const card of await cardsWithoutStatus(target)) {
    // A draft issue, or what a bot opened that someone added by hand, keeps the Status it has.
    if (!isIssueOrPullRequest(card.content) || leaveOffReason(card.content)) {
      continue;
    }

    const item = card.content;
    const status = startingStatus(item);

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one card at a time, so one failure leaves the others alone
      await setStatus(target, card.id, status);
      report.withoutStatus.delete(card.id);
      report.lines.push(
        `Set the missing Status of ${link(item)} to ${status}.`
      );
    } catch (error) {
      report.withoutStatus.add(card.id);
      report.lines.push(
        `Could not set the Status of ${link(item)}: ${message(error)}`
      );
    }
  }
};

/** The value of an environment variable the run needs; it names the missing one and stops. */
const required = (name: string): string => {
  const value = env[name];

  if (!value) {
    console.log(`::error title=Add to project::Set ${name}.`);
    process.exit(1);
  }

  return value;
};

required("GITHUB_TOKEN");

const owner = required("PROJECT_OWNER");
const number = Number(required("PROJECT_NUMBER"));

try {
  const target = await project(owner, number);
  const report: Report = { lines: [], notAdded: 0, withoutStatus: new Set() };

  await addNewItems(target, owner, number, report);
  await fillMissingStatuses(target, report);

  const summary = `## ${target.title}\n\n${
    report.lines.length
      ? report.lines.map((line) => `- ${line}`).join("\n")
      : "Nothing new."
  }\n`;

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  }

  console.log(summary);

  const failed = report.notAdded + report.withoutStatus.size;

  if (failed) {
    console.log(
      `::error title=Add to project::${failed} item(s) could not be added or have no Status yet. The next run tries again.`
    );
    process.exit(1);
  }
} catch (error) {
  console.log(
    `::error title=Add to project::${message(error).replaceAll("%", "%25")}`
  );
  process.exit(1);
}
