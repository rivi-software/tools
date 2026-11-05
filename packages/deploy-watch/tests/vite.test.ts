import { afterEach, expect, test, vi } from "vitest";
import { PACKAGE_PATTERN, buildFileUnder, deployWatch } from "../src/vite.js";

type Hook = (this: unknown, ...args: unknown[]) => unknown;

const call = (hook: unknown, self: unknown, ...args: unknown[]) =>
  (hook as Hook).call(self, ...args);

/** Runs the plugin's hooks as a build (or the dev server) would, and collects what it emits. */
function run(command: "build" | "serve", buildId: string | undefined, base?: string) {
  const plugin = deployWatch({ buildId });
  call(plugin.config, null, { base }, { command, mode: "production" });
  const emitted: unknown[] = [];
  const bundle = (environment: string) =>
    call(plugin.generateBundle, {
      environment: { name: environment },
      emitFile: (file: unknown) => emitted.push(file),
    });
  return {
    define: (environment: string, config = {}) =>
      call(plugin.configEnvironment, null, environment, config, {}),
    bundle,
    emitted,
  };
}

test("a build gives the server its id and the browser's assets /build.json and the build's own copy", () => {
  const build = run("build", "abc123");
  expect(build.define("ssr")).toEqual({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"abc123"' },
    resolve: { noExternal: [PACKAGE_PATTERN] },
  });
  // The browser bundle never holds the id, only where to read the files; the page has its own id.
  expect(build.define("client")).toEqual({
    define: {
      __DEPLOY_WATCH_BUILD_FILE__: '"/build.json"',
      __DEPLOY_WATCH_ASSETS_DIR__: '"assets"',
    },
  });
  build.bundle("ssr");
  build.bundle("client");
  // With the id, the browser code's fingerprint: here, of an empty bundle.
  const source = '{"id":"abc123","client":"e3b0c44298fc1c14"}\n';
  expect(build.emitted).toEqual([
    { type: "asset", fileName: "build.json", source },
    { type: "asset", fileName: "assets/deploy-watch-abc123.json", source },
  ]);
});

test("the build's own copy goes into the browser build's assets directory, for a plain id only", () => {
  const build = run("build", "abc123");
  expect(build.define("client", { build: { assetsDir: "/static/" } })).toMatchObject({
    define: { __DEPLOY_WATCH_ASSETS_DIR__: '"/static/"' },
  });
  build.bundle("client");
  expect(build.emitted).toMatchObject([
    { fileName: "build.json" },
    { fileName: "static/deploy-watch-abc123.json" },
  ]);
  const unplain = run("build", "feature/x");
  unplain.bundle("client");
  expect(unplain.emitted).toMatchObject([{ fileName: "build.json" }]);
});

test("the dev server and a build without an id leave the watch off", () => {
  const dev = run("serve", "abc123");
  expect(dev.define("ssr")).toEqual({
    define: { __DEPLOY_WATCH_BUILD_ID__: '""' },
    resolve: { noExternal: [PACKAGE_PATTERN] },
  });
  dev.bundle("client");
  const local = run("build", "");
  local.bundle("client");
  expect([...dev.emitted, ...local.emitted]).toEqual([]);
});

test("under another base, the browser reads build.json where that base serves it", () => {
  expect(run("build", "abc123", "/app/").define("client")).toMatchObject({
    define: { __DEPLOY_WATCH_BUILD_FILE__: '"/app/build.json"' },
  });
  expect(buildFileUnder(undefined)).toBe("/build.json");
  expect(buildFileUnder("/")).toBe("/build.json");
  expect(buildFileUnder("/app")).toBe("/app/build.json");
  expect(buildFileUnder("/docs/v2/")).toBe("/docs/v2/build.json");
  // Neither names a path on this origin; the app passes `buildFile` to startDeployWatch.
  for (const base of ["./", "", "https://cdn.example.com/app/", "//cdn.example.com/app/"])
    expect(buildFileUnder(base)).toBe("/build.json");
});

test("server builds bundle this package and each of its entry points, and nothing else", () => {
  for (const id of ["@rivi-software/deploy-watch", "@rivi-software/deploy-watch/react"])
    expect(PACKAGE_PATTERN.test(id)).toBe(true);
  for (const id of [
    "@rivi-software/deploy-watcher",
    "@rivi-software/cloudflare-deploy",
    "deploy-watch",
  ])
    expect(PACKAGE_PATTERN.test(id)).toBe(false);
});

const COMMIT_VARIABLES = [
  "WORKERS_CI_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "GITHUB_SHA",
  "CI_COMMIT_SHA",
];

/** An environment with only `variables` set of the ones the plugin reads (CI sets some itself). */
function environment(variables: Record<string, string> = {}) {
  for (const name of [...COMMIT_VARIABLES, "CI"]) vi.stubEnv(name, variables[name] ?? "");
}

afterEach(() => vi.unstubAllEnvs());

test("the id is the commit Workers Builds, Pages, GitHub Actions or GitLab CI builds", () => {
  const idOf = (variables: Record<string, string>) => {
    environment(variables);
    return run("build", undefined).define("ssr");
  };
  for (const name of COMMIT_VARIABLES)
    expect(idOf({ [name]: "4f1c9e2" })).toMatchObject({
      define: { __DEPLOY_WATCH_BUILD_ID__: '"4f1c9e2"' },
    });
  // A service's own name for its commit comes before the generic one.
  const all = Object.fromEntries(COMMIT_VARIABLES.map((name) => [name, name.toLowerCase()]));
  expect(idOf(all)).toMatchObject({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"workers_ci_commit_sha"' },
  });
  expect(idOf({ ...all, WORKERS_CI_COMMIT_SHA: "" })).toMatchObject({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"cf_pages_commit_sha"' },
  });
  expect(idOf({ GITHUB_SHA: "github_sha", CI_COMMIT_SHA: "ci_commit_sha" })).toMatchObject({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"github_sha"' },
  });
  // The app's own id comes first of all.
  environment(all);
  expect(run("build", "release-42").define("ssr")).toMatchObject({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"release-42"' },
  });
});

/**
 * The warnings a fresh copy of the plugin gives over `builds` resolved configs, which share the
 * module as the builds of one `vite build` do.
 */
async function warnings(
  options: Parameters<typeof deployWatch>[0],
  { command = "build", isProduction = true, builds = 1 } = {},
) {
  vi.resetModules();
  const fresh = await import("../src/vite.js");
  const warned: string[] = [];
  const logger = { warn: (message: string) => warned.push(message) };
  for (let build = 0; build < builds; build++) {
    const plugin = fresh.deployWatch(options);
    call(plugin.config, null, {}, { command, mode: "production" });
    call(plugin.configResolved, null, { command, isProduction, root: "/app", logger });
  }
  return warned;
}

test("a production build in CI that finds no id warns, once", async () => {
  environment({ CI: "true" });
  const warned = await warnings({}, { builds: 3 });
  expect(warned).toHaveLength(1);
  for (const name of COMMIT_VARIABLES) expect(warned[0]).toContain(name);
  expect(warned[0]).toContain("buildId");
  environment({ CI: "1" });
  expect(await warnings({})).toHaveLength(1);
});

test("a build that has an id, or is not a production build in CI, does not warn", async () => {
  environment({ CI: "true", CI_COMMIT_SHA: "4f1c9e2" });
  expect(await warnings({})).toEqual([]);
  environment({ CI: "true" });
  // An empty `buildId` turns the watch off on purpose.
  expect(await warnings({ buildId: "" })).toEqual([]);
  expect(await warnings({ buildId: "release-42" })).toEqual([]);
  expect(await warnings({}, { command: "serve" })).toEqual([]);
  expect(await warnings({}, { isProduction: false })).toEqual([]);
  for (const ci of ["", "false", "0"]) {
    environment({ CI: ci });
    expect(await warnings({})).toEqual([]);
  }
});
