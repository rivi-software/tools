/**
 * Adds the open issues and pull requests of the owner's public repositories to its open-source
 * project, each with a first Status (.github/workflows/oss-project.yml). It finds them with a
 * search that leaves out what is on the project already, so a run adds only what is new, and a
 * public repository needs nothing to take part. scripts/project-items.ts says which items go on
 * and the Status each starts in.
 *
 * Needs GITHUB_TOKEN (organization projects: write), PROJECT_OWNER and PROJECT_NUMBER.
 */

import { appendFileSync } from "node:fs";
import { belongsOnProject, searchQuery, startingStatus, statusOptionIds } from "./project-items.ts";
import type { Item } from "./project-items.ts";

const env = process.env;

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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
    throw new Error(`GitHub GraphQL returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  return body.data as T;
}

interface Project {
  id: string;
  title: string;
  url: string;
  field: { id: string; options: { id: string; name: string }[] } | null;
}

async function project(owner: string, number: number): Promise<Project> {
  const data = await graphql<{ organization: { projectV2: Project | null } }>(
    `
      query ($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            title
            url
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
    { owner, number },
  );
  const found = data.organization.projectV2;
  if (!found) throw new Error(`${owner} has no project ${number}, or the token cannot see it.`);
  if (!found.field) throw new Error(`${found.title} has no single-select Status field.`);
  return found;
}

/** Every item the search finds, a page of a hundred at a time. Search stops at a thousand. */
async function search(query: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let after: string | null = null; ;) {
    const data: {
      search: { nodes: Item[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await graphql(
      `
        query ($query: String!, $after: String) {
          search(type: ISSUE, query: $query, first: 100, after: $after) {
            nodes {
              __typename
              ... on Issue {
                id
                number
                title
                url
                author {
                  __typename
                  login
                }
                repository {
                  nameWithOwner
                }
              }
              ... on PullRequest {
                id
                number
                title
                url
                isDraft
                author {
                  __typename
                  login
                }
                repository {
                  nameWithOwner
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { query, after },
    );
    items.push(...data.search.nodes);
    if (!data.search.pageInfo.hasNextPage) return items;
    after = data.search.pageInfo.endCursor;
  }
}

/** A line for each item it added or left off. */
async function addNewItems(owner: string, number: number): Promise<string[]> {
  const target = await project(owner, number);
  const field = target.field!;
  const optionIds = statusOptionIds(field.options);
  const found = await search(searchQuery(owner, number));
  const lines: string[] = [];

  for (const item of found) {
    const name = `${item.repository.nameWithOwner}#${item.number}`;
    if (!belongsOnProject(item)) {
      lines.push(`Left off [${name}](${item.url}), which ${item.author?.login} opened.`);
      continue;
    }
    // Adding an item that is on the project already returns it, so a run that overlaps another
    // cannot add one twice.
    const added = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `
        mutation ($project: ID!, $content: ID!) {
          addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
            item {
              id
            }
          }
        }
      `,
      { project: target.id, content: item.id },
    );
    const status = startingStatus(item);
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
        item: added.addProjectV2ItemById.item.id,
        field: field.id,
        option: optionIds[status],
      },
    );
    lines.push(`Added [${name}](${item.url}) in ${status}: ${item.title}`);
  }
  return lines;
}

for (const name of ["GITHUB_TOKEN", "PROJECT_OWNER", "PROJECT_NUMBER"]) {
  if (!env[name]) {
    console.log(`::error title=Add to project::Set ${name}.`);
    process.exit(1);
  }
}

try {
  const owner = env.PROJECT_OWNER!;
  const number = Number(env.PROJECT_NUMBER);
  const lines = await addNewItems(owner, number);
  const summary = `## ${owner} project ${number}\n\n${
    lines.length ? lines.map((line) => `- ${line}`).join("\n") : "Nothing new."
  }\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
} catch (error) {
  console.log(`::error title=Add to project::${(error as Error).message.replaceAll("%", "%25")}`);
  process.exit(1);
}
