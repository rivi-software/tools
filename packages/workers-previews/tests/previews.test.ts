import { setTimeout as sleep } from "node:timers/promises";

import { cloudflareApi } from "@rivi-software/cloudflare-deploy/cloudflare-api";
import { describe, expect, it } from "vitest";

import { previewName } from "../src/name.js";
import { sweepPreviews } from "../src/previews.js";
import type { RepositoryState } from "../src/sweep.js";
import { ACCOUNT, fakeApis, preview, TOKEN } from "./fake.js";

describe(sweepPreviews, () => {
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
