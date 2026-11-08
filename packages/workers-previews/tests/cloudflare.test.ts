import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { describe, expect, it } from "vitest";

import {
  activeBuilds,
  deletePreview,
  listPreviews,
  workerTag,
} from "../src/cloudflare.js";
import { ACCOUNT, fakeApis, preview, TOKEN } from "./fake.js";
import type { FakeState } from "./fake.js";

const setup = (state: Partial<FakeState> = {}) => {
  const fake = fakeApis({
    workers: { app: { tag: "f".repeat(32), previews: [] } },
    builds: {},
    repositories: {},
    ...state,
  });

  return {
    ...fake,
    api: cloudflareApi({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch }),
  };
};

describe("the Cloudflare calls for Previews and builds", () => {
  it("lists every Preview of the Worker, page by page", async () => {
    const previews = Array.from({ length: 150 }, (_, index) =>
      preview(`p-${index}`)
    );

    const { api, calls } = setup({ workers: { app: { tag: "t", previews } } });
    const listed = await listPreviews(api, "app");
    expect(listed.map((item) => item.name)).toStrictEqual(
      previews.map((item) => item.name)
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(
      "/workers/workers/app/previews?page=1&per_page=100"
    );
  });

  it("says so when the Worker does not exist, rather than listing nothing", async () => {
    const { api } = setup();
    await expect(listPreviews(api, "typo")).rejects.toThrow(
      "The Worker typo does not exist in this account"
    );
    await expect(deletePreview(api, "typo", "b-x")).rejects.toThrow(
      "does not exist"
    );
  });

  it("deletes a Preview by its encoded name, and answers false for one that is gone", async () => {
    const { api, calls, state } = setup({
      workers: { app: { tag: "t", previews: [preview("feature/x")] } },
    });

    await expect(deletePreview(api, "app", "feature/x")).resolves.toBeTruthy();
    expect(calls.at(-1)).toBe(
      `DELETE api.cloudflare.com/client/v4/accounts/${
        ACCOUNT
      }/workers/workers/app/previews/feature%2Fx`
    );
    expect(state.workers.app.previews).toStrictEqual([]);
    await expect(deletePreview(api, "app", "feature/x")).resolves.toBeFalsy();
  });

  it("finds the Worker's tag, which the Builds API knows it by", async () => {
    const { api } = setup();
    await expect(workerTag(api, "app")).resolves.toBe("f".repeat(32));
    await expect(workerTag(api, "other")).rejects.toThrow("does not exist");
  });

  it("finds the builds that have not finished, of one branch or of any", async () => {
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
      {
        build_uuid: "y",
        status: "queued" as const,
        build_trigger_metadata: { branch: "feature/y" },
      },
      { build_uuid: "z", status: "initializing" as const },
    ];

    const { api, calls } = setup({ builds: { t: builds } });
    const ofBranch = await activeBuilds(api, "t", "feature/x");
    expect(ofBranch.map((build) => build.build_uuid)).toStrictEqual(["x", "z"]);
    expect(calls).toHaveLength(2);

    const ofAny = await activeBuilds(api, "t");
    expect(ofAny.map((build) => build.build_uuid)).toStrictEqual([
      "x",
      "y",
      "z",
    ]);
    await expect(activeBuilds(api, "t", "feature/z")).resolves.toHaveLength(1);
  });

  it("a Worker that Workers Builds never built has no builds", async () => {
    const { api } = setup();
    await expect(activeBuilds(api, "never-built")).resolves.toStrictEqual([]);
  });
});
