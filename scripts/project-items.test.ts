import { describe, expect, it } from "vitest";
import {
  belongsOnProject,
  searchQuery,
  startingStatus,
  statusOptionIds,
  type Item,
} from "./project-items.ts";

function item(overrides: Partial<Item> = {}): Item {
  return {
    __typename: "Issue",
    id: "I_kwDOexample",
    number: 57,
    title: "deploy-watch: a reload that does not happen leaves the tab stuck",
    url: "https://github.com/rivi-software/tools/issues/57",
    author: { __typename: "User", login: "someone" },
    repository: { nameWithOwner: "rivi-software/tools" },
    ...overrides,
  };
}

describe("searchQuery", () => {
  it("asks for open items in public, unarchived repositories, off the project", () => {
    expect(searchQuery("rivi-software", 2)).toBe(
      "org:rivi-software is:public is:open archived:false -project:rivi-software/2",
    );
  });
});

describe("belongsOnProject", () => {
  it("takes what a person opened", () => {
    expect(belongsOnProject(item())).toBe(true);
    expect(belongsOnProject(item({ __typename: "PullRequest", isDraft: false }))).toBe(true);
  });

  it("takes an item whose author's account is gone", () => {
    expect(belongsOnProject(item({ author: null }))).toBe(true);
  });

  it("leaves off what a bot opened", () => {
    const bot = { __typename: "Bot", login: "github-actions" };
    expect(belongsOnProject(item({ __typename: "PullRequest", author: bot }))).toBe(false);
    expect(belongsOnProject(item({ author: { __typename: "Bot", login: "rivi-bot" } }))).toBe(
      false,
    );
  });
});

describe("startingStatus", () => {
  it("puts an issue in Triage", () => {
    expect(startingStatus(item())).toBe("Triage");
  });

  it("puts a pull request in In Review, and a draft in In Progress", () => {
    expect(startingStatus(item({ __typename: "PullRequest", isDraft: false }))).toBe("In Review");
    expect(startingStatus(item({ __typename: "PullRequest", isDraft: true }))).toBe("In Progress");
  });
});

describe("statusOptionIds", () => {
  const options = [
    { id: "a", name: "Triage" },
    { id: "b", name: "Backlog" },
    { id: "c", name: "Todo" },
    { id: "d", name: "In Progress" },
    { id: "e", name: "In Review" },
    { id: "f", name: "Done" },
  ];

  it("maps each starting status to its option", () => {
    expect(statusOptionIds(options)).toEqual({
      Triage: "a",
      "In Progress": "d",
      "In Review": "e",
    });
  });

  it("names the statuses the project lacks", () => {
    expect(() => statusOptionIds(options.filter(({ name }) => !name.startsWith("In")))).toThrow(
      "The project's Status field lacks In Progress, In Review.",
    );
  });
});
