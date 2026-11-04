import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { expect, test } from "vitest";
import { activeBuilds, deletePreview, listPreviews, workerTag } from "../src/cloudflare.js";
import { ACCOUNT, fakeApis, preview, TOKEN, type FakeState } from "./fake.js";

function setup(state: Partial<FakeState> = {}) {
  const fake = fakeApis({
    workers: { app: { tag: "f".repeat(32), previews: [] } },
    builds: {},
    repositories: {},
    ...state,
  });
  return { ...fake, api: cloudflareApi({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch }) };
}

test("lists every Preview of the Worker, page by page", async () => {
  const previews = Array.from({ length: 150 }, (_, index) => preview(`p-${index}`));
  const { api, calls } = setup({ workers: { app: { tag: "t", previews } } });
  const listed = await listPreviews(api, "app");
  expect(listed.map((item) => item.name)).toEqual(previews.map((item) => item.name));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("/workers/workers/app/previews?page=1&per_page=100");
});

test("says so when the Worker does not exist, rather than listing nothing", async () => {
  const { api } = setup();
  await expect(listPreviews(api, "typo")).rejects.toThrow(
    "The Worker typo does not exist in this account",
  );
  await expect(deletePreview(api, "typo", "b-x")).rejects.toThrow("does not exist");
});

test("deletes a Preview by its encoded name, and answers false for one that is gone", async () => {
  const { api, calls, state } = setup({
    workers: { app: { tag: "t", previews: [preview("feature/x")] } },
  });
  expect(await deletePreview(api, "app", "feature/x")).toBe(true);
  expect(calls.at(-1)).toBe(
    "DELETE api.cloudflare.com/client/v4/accounts/" +
      ACCOUNT +
      "/workers/workers/app/previews/feature%2Fx",
  );
  expect(state.workers.app.previews).toEqual([]);
  expect(await deletePreview(api, "app", "feature/x")).toBe(false);
});

test("finds the Worker's tag, which the Builds API knows it by", async () => {
  const { api } = setup();
  expect(await workerTag(api, "app")).toBe("f".repeat(32));
  await expect(workerTag(api, "other")).rejects.toThrow("does not exist");
});

test("finds the builds that have not finished, of one branch or of any", async () => {
  const builds = [
    ...Array.from({ length: 200 }, (_, index) => ({
      build_uuid: `old-${index}`,
      status: "stopped" as const,
      build_trigger_metadata: { branch: "feature/x" },
    })),
    {
      build_uuid: "x",
      status: "running" as const,
      build_trigger_metadata: { branch: "feature/x" },
    },
    { build_uuid: "y", status: "queued" as const, build_trigger_metadata: { branch: "feature/y" } },
    { build_uuid: "z", status: "initializing" as const },
  ];
  const { api, calls } = setup({ builds: { t: builds } });
  expect((await activeBuilds(api, "t", "feature/x")).map((build) => build.build_uuid)).toEqual([
    "x",
    "z",
  ]);
  expect(calls).toHaveLength(2);
  expect((await activeBuilds(api, "t")).map((build) => build.build_uuid)).toEqual(["x", "y", "z"]);
  expect(await activeBuilds(api, "t", "feature/z")).toHaveLength(1);
});

test("a Worker that Workers Builds never built has no builds", async () => {
  const { api } = setup();
  expect(await activeBuilds(api, "never-built")).toEqual([]);
});
