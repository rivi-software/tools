import type { Plugin } from "vite";

export type DeployWatchOptions = {
  /** The build's id; by default the commit CI builds. Empty turns the watch off. */
  buildId?: string;
};

/** This package and its entry points, as a server build's `resolve.noExternal` names them. */
export const PACKAGE_PATTERN = /^@rivi-software\/deploy-watch(?:\/|$)/;

/**
 * Where the client output's `build.json` is served, under Vite's `base`: `/app/build.json` for
 * `base: "/app/"`. A relative `base` (`./`) or one on another host cannot be named here, so the
 * tab reads `/build.json` unless the app passes `buildFile` to `startDeployWatch`.
 */
export function buildFileUnder(base: string | undefined): string {
  if (!base?.startsWith("/") || base.startsWith("//")) return "/build.json";
  return `${base.endsWith("/") ? base : `${base}/`}build.json`;
}

/**
 * Gives a build its id for `@rivi-software/deploy-watch`. The server bundles get it (`BuildMeta`
 * writes it into every page) and the browser's assets get `/build.json`, which the open tabs read.
 * The id is the commit CI builds: `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds, GitHub's
 * own `GITHUB_SHA` otherwise. The dev server and a local build have none, so the watch stays off.
 *
 * The browser bundle never holds the id: a commit that changes no browser code renames no chunk,
 * and builds of one commit (one app deployed as several Workers) stay byte for byte the same.
 */
export function deployWatch({
  buildId = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || "",
}: DeployWatchOptions = {}): Plugin {
  let id = "";
  let buildFile = "/build.json";
  return {
    name: "deploy-watch",
    config(config, { command }) {
      id = command === "build" ? buildId : "";
      buildFile = buildFileUnder(config.base);
    },
    configEnvironment(name) {
      // The browser gets where `build.json` is served, which is the same in every build of the
      // app, so it renames no chunk; never the id.
      if (name === "client")
        return { define: { __DEPLOY_WATCH_BUILD_FILE__: JSON.stringify(buildFile) } };
      // The id reaches `pageBuildId` as a define, and a define only rewrites code the build
      // bundles; a server build leaves a dependency in node_modules external by default.
      return {
        define: { __DEPLOY_WATCH_BUILD_ID__: JSON.stringify(id) },
        resolve: { noExternal: [PACKAGE_PATTERN] },
      };
    },
    generateBundle() {
      if (!id || this.environment.name !== "client") return;
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify({ id })}\n`,
      });
    },
  };
}
