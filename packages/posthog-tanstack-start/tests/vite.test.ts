import type { PostHogRollupPluginOptions } from "@posthog/rollup-plugin";
import type { Environment } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { posthogSourcemaps } from "../src/vite.js";

// SAFETY: the stand-in plugin below pushes the options it was called with, and nothing else writes here.
const created = vi.hoisted(() => [] as PostHogRollupPluginOptions[]);

// oxlint-disable-next-line anti-slop/no-module-mocking -- the plugin's only seam is the module it imports: `posthogSourcemaps` takes no injection point and the real plugin would upload
vi.mock(import("@posthog/rollup-plugin"), () => ({
  default: (options: PostHogRollupPluginOptions) => {
    created.push(options);

    return { name: "posthog" };
  },
}));

const environment = (name: string, consumer: "client" | "server") =>
  // SAFETY: `applyToEnvironment` reads `config.consumer` alone, so the rest of a vite Environment is never touched.
  ({ name, config: { consumer } }) as Environment;

/** The two plugins for a build that uploads, with the release the tests below expect. */
const uploadingBuild = () => {
  vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
  vi.stubEnv("POSTHOG_PROJECT_ID", "321986");
  vi.stubEnv("POSTHOG_API_HOST", "");
  vi.stubEnv("GITHUB_SHA", "abc123");

  return posthogSourcemaps({ releaseName: "web" });
};

describe(posthogSourcemaps, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    created.length = 0;
  });

  it("adds nothing without a personal API key, as in local and verify builds", () => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "");
    expect(posthogSourcemaps({ releaseName: "web" })).toStrictEqual([]);
  });

  it("applies one plugin to the browser's environments and the other to the server's", () => {
    const [client, server] = uploadingBuild();

    expect(
      client?.applyToEnvironment?.(environment("client", "client"))
    ).toBeTruthy();
    expect(
      client?.applyToEnvironment?.(environment("ssr", "server"))
    ).toBeFalsy();
    expect(
      server?.applyToEnvironment?.(environment("ssr", "server"))
    ).toBeTruthy();
    // The Cloudflare Vite plugin names a Worker's environment after the Worker.
    expect(
      server?.applyToEnvironment?.(environment("my_worker", "server"))
    ).toBeTruthy();
    expect(
      server?.applyToEnvironment?.(environment("client", "client"))
    ).toBeFalsy();
  });

  it("uploads both under the same release, and deletes only the browser's maps after", () => {
    uploadingBuild();

    const release = { releaseName: "web", releaseVersion: "abc123" };

    expect(created).toStrictEqual([
      expect.objectContaining({
        host: "https://us.posthog.com",
        projectId: "321986",
        sourcemaps: { ...release, deleteAfterUpload: true },
      }),
      expect.objectContaining({
        sourcemaps: { ...release, deleteAfterUpload: false },
      }),
    ]);
  });

  it("takes the region's host, the Workers Builds commit, or a version of the app's own", () => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
    vi.stubEnv("POSTHOG_API_HOST", "https://eu.posthog.com");
    vi.stubEnv("GITHUB_SHA", "");
    vi.stubEnv("WORKERS_CI_COMMIT_SHA", "def456");
    posthogSourcemaps({ releaseName: "web" });
    posthogSourcemaps({ releaseName: "web", releaseVersion: "1.2.3" });
    expect(
      created.map(({ host, sourcemaps }) => [host, sourcemaps?.releaseVersion])
    ).toStrictEqual([
      ["https://eu.posthog.com", "def456"],
      ["https://eu.posthog.com", "def456"],
      ["https://eu.posthog.com", "1.2.3"],
      ["https://eu.posthog.com", "1.2.3"],
    ]);
  });
});
