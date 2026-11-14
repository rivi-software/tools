import { setTimeout as sleep } from "node:timers/promises";

import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { previewName } from "../src/name.js";
import { sweepPreviews } from "../src/previews.js";
import type { RepositoryState } from "../src/sweep.js";
import { ACCOUNT, fakeApis, preview, TOKEN } from "./fake.js";
import type { FakeBuild } from "./fake.js";

const TAG = "f".repeat(32);

/** A Worker with `count` stale Previews, each named after a deleted branch, and their finished builds. */
const staleWorld = (count: number) => {
  const stale = Array.from(
    { length: count },
    (_, index) => `stale-${String(index).padStart(2, "0")}`
  );

  const finished: FakeBuild[] = stale.map((branch) => ({
    build_uuid: `done-${branch}`,
    status: "stopped",
    build_trigger_metadata: { branch },
  }));

  const fake = fakeApis({
    workers: {
      app: {
        tag: TAG,
        previews: [preview("main"), ...stale.map((name) => preview(name))],
      },
    },
    builds: { [TAG]: finished },
    repositories: {},
  });

  return { fake, stale };
};

/** How many times the sweep asked the Builds API for the Worker's builds. */
const buildReads = (calls: string[]) =>
  calls.filter((call) => call.includes("/builds/")).length;

/** A repository where only the production branch lives. */
const onlyMain = (): Promise<RepositoryState> =>
  Promise.resolve({ branches: ["main"], pullRequests: [] });

describe(sweepPreviews, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the Worker's builds once for a sweep of 20 branches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fake, stale } = staleWorld(20);

    const result = await sweepPreviews({
      api: cloudflareApi({
        accountId: ACCOUNT,
        token: TOKEN,
        fetch: fake.fetch,
      }),
      worker: "app",
      repository: onlyMain,
      apply: true,
    });

    expect(result.targets).toHaveLength(20);
    expect(result.failed).toStrictEqual([]);
    expect(result.deleted.toSorted()).toStrictEqual(stale);
    expect(buildReads(fake.calls)).toBe(1);
  });

  it("reads the builds again once its list is older than 30 seconds, so a build that started since stops its branch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fake } = staleWorld(10);
    let deletes = 0;
    let late: string | undefined;

    // Each delete takes 10 seconds. Once five are done, a build starts on a branch the sweep has
    // not reached yet.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await fake.fetch(input, init);

      if (init?.method === "DELETE" && response.ok) {
        deletes += 1;
        vi.setSystemTime(Date.now() + 10_000);
      }

      if (deletes === 5 && late === undefined) {
        late = fake.state.workers.app.previews.at(-1)?.name;
        fake.state.builds[TAG].push({
          build_uuid: "late",
          status: "running",
          build_trigger_metadata: { branch: late },
        });
      }

      return response;
    };

    const result = await sweepPreviews({
      api: cloudflareApi({ accountId: ACCOUNT, token: TOKEN, fetch }),
      worker: "app",
      repository: onlyMain,
      apply: true,
    });

    expect(result.failed).toStrictEqual([
      {
        target: { branch: late },
        error: `A Workers Build of ${late} is running (late): wait for it to finish, then delete again`,
      },
    ]);
    expect(result.deleted).toHaveLength(9);
    expect(
      fake.state.workers.app.previews.map((item) => item.name)
    ).toStrictEqual(["main", late]);
    expect(buildReads(fake.calls)).toBeGreaterThan(1);
    expect(buildReads(fake.calls)).toBeLessThan(10);
  });

  it("keeps a Preview deployed after the repository was read, while the Previews were still being listed", async () => {
    const fake = fakeApis({
      workers: {
        app: {
          tag: "f".repeat(32),
          previews: [preview("main"), preview(previewName("feature/live"))],
        },
      },
      builds: {},
      repositories: {},
    });

    // Cloudflare answers slowly, as a list of many pages does. The fake reads its state when it
    // answers, so the list holds every Preview made until then.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      await sleep(10);

      return fake.fetch(input, init);
    };

    const branches = ["main", "feature/live"];

    const repository = (): Promise<RepositoryState> => {
      const read = { branches: [...branches], pullRequests: [] };

      // Just after the read, someone pushes feature/new, and a deploy in GitHub Actions makes its
      // Preview.
      branches.push("feature/new");
      fake.state.workers.app.previews.push(preview(previewName("feature/new")));

      return Promise.resolve(read);
    };

    const result = await sweepPreviews({
      api: cloudflareApi({ accountId: ACCOUNT, token: TOKEN, fetch }),
      worker: "app",
      builds: false,
      repository,
      apply: true,
    });

    expect(result.deleted).toStrictEqual([]);
    expect(fake.state.workers.app.previews.map((item) => item.name)).toContain(
      previewName("feature/new")
    );
  });
});
