import { expect, test } from "vitest";
import { PACKAGE_PATTERN, deployWatch } from "../src/vite.js";

type Hook = (this: unknown, ...args: unknown[]) => unknown;

/** Runs the plugin's hooks as a build (or the dev server) would, and collects what it emits. */
function run(command: "build" | "serve", buildId: string) {
  const plugin = deployWatch({ buildId });
  const call = (hook: unknown, self: unknown, ...args: unknown[]) =>
    (hook as Hook).call(self, ...args);
  call(plugin.config, null, {}, { command, mode: "production" });
  const emitted: unknown[] = [];
  const bundle = (environment: string) =>
    call(plugin.generateBundle, {
      environment: { name: environment },
      emitFile: (file: unknown) => emitted.push(file),
    });
  return {
    define: (environment: string) => call(plugin.configEnvironment, null, environment, {}, {}),
    bundle,
    emitted,
  };
}

test("a build gives the server its id and the browser's assets /build.json", () => {
  const build = run("build", "abc123");
  expect(build.define("ssr")).toEqual({
    define: { __DEPLOY_WATCH_BUILD_ID__: '"abc123"' },
    resolve: { noExternal: [PACKAGE_PATTERN] },
  });
  // The browser bundle never holds the id; it reads it from the page.
  expect(build.define("client")).toBeUndefined();
  build.bundle("ssr");
  build.bundle("client");
  expect(build.emitted).toEqual([
    { type: "asset", fileName: "build.json", source: '{"id":"abc123"}\n' },
  ]);
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
