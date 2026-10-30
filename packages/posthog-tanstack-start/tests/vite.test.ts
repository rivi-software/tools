import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "vite";
import { posthogSourcemaps } from "../src/vite.js";

type PluginOptions = {
  host: string;
  projectId?: string;
  sourcemaps: { releaseName: string; releaseVersion?: string; deleteAfterUpload: boolean };
};

const created = vi.hoisted(() => [] as PluginOptions[]);
vi.mock("@posthog/rollup-plugin", () => ({
  default: (options: PluginOptions) => {
    created.push(options);
    return { name: "posthog" };
  },
}));

const environment = (name: string, consumer: "client" | "server") =>
  ({ name, config: { consumer } }) as unknown as Environment;

afterEach(() => {
  vi.unstubAllEnvs();
  created.length = 0;
});

describe("posthogSourcemaps", () => {
  it("adds nothing without a personal API key, as in local and verify builds", () => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "");
    expect(posthogSourcemaps({ releaseName: "web" })).toEqual([]);
  });

  it("uploads the browser's maps and the server's, one plugin for each kind of environment", () => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
    vi.stubEnv("POSTHOG_PROJECT_ID", "321986");
    vi.stubEnv("POSTHOG_API_HOST", "");
    vi.stubEnv("GITHUB_SHA", "abc123");
    const [client, server] = posthogSourcemaps({ releaseName: "web" });
    expect(client?.applyToEnvironment?.(environment("client", "client"))).toBe(true);
    expect(client?.applyToEnvironment?.(environment("ssr", "server"))).toBe(false);
    expect(server?.applyToEnvironment?.(environment("ssr", "server"))).toBe(true);
    // The Cloudflare Vite plugin names a Worker's environment after the Worker.
    expect(server?.applyToEnvironment?.(environment("my_worker", "server"))).toBe(true);
    expect(server?.applyToEnvironment?.(environment("client", "client"))).toBe(false);
    const release = { releaseName: "web", releaseVersion: "abc123" };
    expect(created).toEqual([
      expect.objectContaining({
        host: "https://us.posthog.com",
        projectId: "321986",
        sourcemaps: { ...release, deleteAfterUpload: true },
      }),
      expect.objectContaining({ sourcemaps: { ...release, deleteAfterUpload: false } }),
    ]);
  });

  it("takes the region's host, the Workers Builds commit, or a version of the app's own", () => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
    vi.stubEnv("POSTHOG_API_HOST", "https://eu.posthog.com");
    vi.stubEnv("GITHUB_SHA", "");
    vi.stubEnv("WORKERS_CI_COMMIT_SHA", "def456");
    posthogSourcemaps({ releaseName: "web" });
    posthogSourcemaps({ releaseName: "web", releaseVersion: "1.2.3" });
    expect(created.map(({ host, sourcemaps }) => [host, sourcemaps.releaseVersion])).toEqual([
      ["https://eu.posthog.com", "def456"],
      ["https://eu.posthog.com", "def456"],
      ["https://eu.posthog.com", "1.2.3"],
      ["https://eu.posthog.com", "1.2.3"],
    ]);
  });
});
