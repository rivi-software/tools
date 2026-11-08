import { describe, expect, it } from "vitest";

import {
  MISSING_STATUS_QUERY,
  isIssueOrPullRequest,
  leaveOffReason,
  searchQuery,
  startingStatus,
  statusOptionIds,
} from "./project-items.ts";
import type { Item } from "./project-items.ts";

const item = (overrides: Partial<Item> = {}): Item => ({
  __typename: "Issue",
  id: "I_kwDOexample",
  number: 57,
  title: "deploy-watch: a reload that does not happen leaves the tab stuck",
  url: "https://github.com/rivi-software/tools/issues/57",
  state: "OPEN",
  author: { __typename: "User", login: "someone" },
  repository: { nameWithOwner: "rivi-software/tools" },
  ...overrides,
});

describe(searchQuery, () => {
  it("asks for open items in public, unarchived repositories, off the project", () => {
    expect(searchQuery("rivi-software", 2)).toBe(
      "org:rivi-software is:public is:open archived:false -project:rivi-software/2"
    );
  });
});

// oxlint-disable-next-line vitest/prefer-describe-function-title -- MISSING_STATUS_QUERY is a query string, not a function: passing it would name the suite "no:status is:open"
describe("MISSING_STATUS_QUERY", () => {
  it("asks for the open cards that have no Status", () => {
    expect(MISSING_STATUS_QUERY).toBe("no:status is:open");
  });
});

describe(leaveOffReason, () => {
  it("takes an open item a person opened", () => {
    expect(leaveOffReason(item())).toBeUndefined();
    expect(
      leaveOffReason(item({ __typename: "PullRequest", isDraft: false }))
    ).toBeUndefined();
  });

  it("takes an item whose author's account is gone", () => {
    expect(leaveOffReason(item({ author: null }))).toBeUndefined();
  });

  it("leaves off what a bot opened", () => {
    const bot = { __typename: "Bot", login: "github-actions" };
    expect(
      leaveOffReason(item({ __typename: "PullRequest", author: bot }))
    ).toBe("github-actions opened it");
    expect(
      leaveOffReason(item({ author: { __typename: "Bot", login: "rivi-bot" } }))
    ).toBe("rivi-bot opened it");
  });

  // The search index still listed tools#83 as open six seconds after it merged.
  it("leaves off an item that closed or merged after the search indexed it", () => {
    expect(
      leaveOffReason(item({ __typename: "PullRequest", state: "MERGED" }))
    ).toBe("it is merged");
    expect(leaveOffReason(item({ state: "CLOSED" }))).toBe("it is closed");
  });
});

describe(isIssueOrPullRequest, () => {
  it("is true for an issue or a pull request", () => {
    expect(isIssueOrPullRequest(item())).toBeTruthy();
    expect(
      isIssueOrPullRequest(item({ __typename: "PullRequest" }))
    ).toBeTruthy();
  });

  it("is false for a draft issue, or content the token cannot see", () => {
    expect(isIssueOrPullRequest({ __typename: "DraftIssue" })).toBeFalsy();
    expect(isIssueOrPullRequest(null)).toBeFalsy();
  });
});

describe(startingStatus, () => {
  it("puts an issue in Triage", () => {
    expect(startingStatus(item())).toBe("Triage");
  });

  it("puts a pull request in In Review, and a draft in In Progress", () => {
    expect(
      startingStatus(item({ __typename: "PullRequest", isDraft: false }))
    ).toBe("In Review");
    expect(
      startingStatus(item({ __typename: "PullRequest", isDraft: true }))
    ).toBe("In Progress");
  });
});

describe(statusOptionIds, () => {
  const options = [
    { id: "a", name: "Triage" },
    { id: "b", name: "Backlog" },
    { id: "c", name: "Todo" },
    { id: "d", name: "In Progress" },
    { id: "e", name: "In Review" },
    { id: "f", name: "Done" },
  ];

  it("maps each starting status to its option", () => {
    expect(statusOptionIds(options)).toStrictEqual({
      Triage: "a",
      "In Progress": "d",
      "In Review": "e",
    });
  });

  it("names the statuses the project lacks", () => {
    expect(() =>
      statusOptionIds(options.filter(({ name }) => !name.startsWith("In")))
    ).toThrow("The project's Status field lacks In Progress, In Review.");
  });
});
