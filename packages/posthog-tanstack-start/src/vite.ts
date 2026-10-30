import posthogRollupPlugin from "@posthog/rollup-plugin";
import type { Plugin } from "vite";

export type PostHogSourcemapOptions = {
  /** The release the maps belong to in PostHog, such as the app's name. */
  releaseName: string;
  /**
   * The release's version: by default the commit CI builds, `GITHUB_SHA`, or
   * `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds.
   */
  releaseVersion?: string;
};

/**
 * Source maps for PostHog error tracking, uploaded when POSTHOG_PERSONAL_API_KEY is set (on the
 * build that deploys; a local or verify build without it uploads nothing) under `releaseName` and
 * `releaseVersion`. POSTHOG_PROJECT_ID names the project and POSTHOG_API_HOST its app host, US Cloud
 * by default. The browser's maps are deleted after the upload so they are never served; the
 * server's maps stay on disk, because Wrangler uploads a Worker's too (`upload_source_maps`).
 */
export function posthogSourcemaps({
  releaseName,
  releaseVersion = process.env.GITHUB_SHA || process.env.WORKERS_CI_COMMIT_SHA,
}: PostHogSourcemapOptions): Plugin[] {
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!personalApiKey) return [];
  const options = {
    personalApiKey,
    projectId: process.env.POSTHOG_PROJECT_ID,
    host: process.env.POSTHOG_API_HOST || "https://us.posthog.com",
  };
  const release = { releaseName, releaseVersion };
  return [
    {
      ...(posthogRollupPlugin({
        ...options,
        sourcemaps: { ...release, deleteAfterUpload: true },
      }) as Plugin),
      applyToEnvironment: (environment) => environment.config.consumer === "client",
    },
    {
      ...(posthogRollupPlugin({
        ...options,
        sourcemaps: { ...release, deleteAfterUpload: false },
      }) as Plugin),
      applyToEnvironment: (environment) => environment.config.consumer === "server",
    },
  ];
}
