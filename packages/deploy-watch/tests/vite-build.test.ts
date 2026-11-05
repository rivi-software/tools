import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder, createLogger, type Plugin } from "vite";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { deployWatch } from "../src/vite.js";

const packageDir = join(import.meta.dirname, "..");
const tsc = join(packageDir, "..", "..", "node_modules", ".bin", "tsc");
const IMPORT = /from\s*["']@rivi-software\/deploy-watch["']/;
let root: string;

// A consumer's project with the package as npm installs it: built files in a real node_modules
// directory, which a server build leaves external unless told otherwise. (A workspace link
// resolves outside node_modules, is bundled as source, and hides the difference.)
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-watch-build-"));
  const installed = join(root, "node_modules", "@rivi-software", "deploy-watch");
  mkdirSync(installed, { recursive: true });
  execFileSync(tsc, [
    "-p",
    join(packageDir, "tsconfig.build.json"),
    "--outDir",
    join(installed, "dist"),
  ]);
  cpSync(join(packageDir, "package.json"), join(installed, "package.json"));
  writeFileSync(
    join(root, "entry.js"),
    'import { pageBuildId } from "@rivi-software/deploy-watch";\nexport const id = pageBuildId();\n',
  );
  writeFileSync(
    join(root, "client.js"),
    'import { startDeployWatch } from "@rivi-software/deploy-watch";\nstartDeployWatch();\n',
  );
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The code of a server build of `entry.js` with `plugin`. */
async function serverBuild(plugin: Plugin): Promise<string> {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [plugin],
    build: { ssr: "entry.js", write: false },
  });
  return (Array.isArray(result) ? result : [result])
    .flatMap((output) => ("output" in output ? output.output : []))
    .map((chunk) => ("code" in chunk ? chunk.code : ""))
    .join("\n");
}

test("a server build bundles the installed package, so the page gets the build's id", async () => {
  const code = await serverBuild(deployWatch({ buildId: "abc123" }));
  expect(code).not.toMatch(IMPORT);
  expect(code).toContain('"abc123"');
});

test("left external, as a define alone leaves it, the package never sees the id", async () => {
  const plugin = deployWatch({ buildId: "abc123" });
  const defineOnly: Plugin = {
    ...plugin,
    configEnvironment: (name) =>
      name === "client" ? undefined : { define: { __DEPLOY_WATCH_BUILD_ID__: '"abc123"' } },
  };
  const code = await serverBuild(defineOnly);
  expect(code).toMatch(IMPORT);
  expect(code).not.toContain('"abc123"');
});

test("a browser build under another base reads build.json there, and never holds the id", async () => {
  const result = await build({
    root,
    base: "/app/",
    configFile: false,
    logLevel: "silent",
    plugins: [deployWatch({ buildId: "abc123" })],
    build: { write: false, rollupOptions: { input: join(root, "client.js") } },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap((output) =>
    "output" in output ? output.output : [],
  );
  const code = files.map((file) => ("code" in file ? file.code : "")).join("\n");
  expect(code).toContain("/app/build.json");
  expect(code).not.toContain("abc123");
  const read = (name: string) => {
    const asset = files.find((file) => file.fileName === name);
    return JSON.parse(asset && "source" in asset ? String(asset.source) : "{}");
  };
  const file = read("build.json");
  expect(file).toEqual({ id: "abc123", client: expect.stringMatching(/^[0-9a-f]{16}$/) });
  // The build's own copy, which a tab on it reads once a deploy replaced `build.json`.
  expect(read("assets/deploy-watch-abc123.json")).toEqual(file);
});

test("a production build in CI that finds no id warns once, across its environments", async () => {
  for (const name of [
    "WORKERS_CI_COMMIT_SHA",
    "CF_PAGES_COMMIT_SHA",
    "GITHUB_SHA",
    "CI_COMMIT_SHA",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("CI", "true");
  // Vitest's own NODE_ENV (test) makes no production build.
  vi.stubEnv("NODE_ENV", "production");
  const warned: string[] = [];
  const logger = { ...createLogger("silent"), warn: (message: string) => warned.push(message) };
  try {
    // `vite build` resolves the config once for the app and again for each environment.
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      customLogger: logger,
      plugins: [deployWatch()],
      environments: {
        client: { build: { write: false, rollupOptions: { input: join(root, "client.js") } } },
        ssr: { build: { write: false, ssr: "entry.js" } },
      },
    });
    await builder.buildApp();
  } finally {
    vi.unstubAllEnvs();
  }
  expect(warned.filter((message) => message.includes("deploy-watch"))).toEqual([
    expect.stringContaining("no id"),
  ]);
}, 60_000);

/**
 * An app with a shell and two lazily loaded modules, each of which loads a dialog lazily. Inbox
 * and its dialog share a helper with the help center, which also imports what the shell has.
 */
const APP: Record<string, string> = {
  "main.js": [
    'import { greet } from "./shared.js";',
    'const open = (name) => name === "inbox" ? import("./modules/inbox.js") : import("./modules/kb.js");',
    "document.body.onclick = () => open(location.hash).then((module) => module.render());",
    "console.log(greet('shell'));",
  ].join("\n"),
  "shared.js": "export const greet = (who) => `hello ${who}`;",
  "modules/inbox.js": [
    'import { greet } from "../shared.js";',
    'import { format } from "./format.js";',
    "export const render = () => format(greet('inbox'));",
    'export const dialog = () => import("./inbox-dialog.js");',
  ].join("\n"),
  "modules/inbox-dialog.js": 'export const text = "Inbox dialog";',
  "modules/kb.js": [
    'import { format } from "./format.js";',
    "export const render = () => format('Help center');",
  ].join("\n"),
  "modules/format.js": "export const format = (text) => `[${text}]`;",
};

type BuildFileBody = { id: string; client: string; modules?: Record<string, string> };

/** Builds `APP` with `changes` applied, and reads its `build.json`; `seen` collects what `modules` saw. */
async function buildApp(
  changes: Record<string, string> = {},
  seen: { id: string; importers: readonly string[] }[] = [],
  buildId = "abc123",
): Promise<BuildFileBody> {
  const app = mkdtempSync(join(tmpdir(), "deploy-watch-app-"));
  try {
    for (const [file, code] of Object.entries({ ...APP, ...changes })) {
      mkdirSync(join(app, file, ".."), { recursive: true });
      writeFileSync(join(app, file), code);
    }
    const result = await build({
      root: app,
      configFile: false,
      logLevel: "silent",
      plugins: [
        deployWatch({
          buildId,
          modules: (file) => {
            seen.push(file);
            return /^modules\/(inbox|kb)\.js$/.exec(file.id)?.[1];
          },
        }),
      ],
      build: { write: false, minify: true, rollupOptions: { input: join(app, "main.js") } },
    });
    const files = (Array.isArray(result) ? result : [result]).flatMap((output) =>
      "output" in output ? output.output : [],
    );
    const asset = files.find((file) => file.fileName === "build.json");
    return JSON.parse(asset && "source" in asset ? String(asset.source) : "{}");
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

test("each named module's fingerprint changes only with the code it adds to the page", async () => {
  const seen: { id: string; importers: readonly string[] }[] = [];
  const before = await buildApp({}, seen);
  // `modules` sees each lazily loaded file from the project root, with its lazy importers.
  expect(seen).toEqual(
    expect.arrayContaining([
      { id: "modules/inbox.js", importers: ["main.js"] },
      { id: "modules/kb.js", importers: ["main.js"] },
      { id: "modules/inbox-dialog.js", importers: ["modules/inbox.js"] },
    ]),
  );
  expect(Object.keys(before.modules ?? {})).toEqual(["inbox", "kb"]);
  // Another build of the same code has the same fingerprints, from another commit too: the copy
  // under the build's own name is in no fingerprint.
  expect(await buildApp()).toEqual(before);
  expect(await buildApp({}, [], "def456")).toEqual({ ...before, id: "def456" });

  // The inbox's lazily loaded dialog belongs to the inbox.
  const dialog = await buildApp({ "modules/inbox-dialog.js": 'export const text = "Reply";' });
  expect(dialog.client).not.toBe(before.client);
  expect(dialog.modules?.inbox).not.toBe(before.modules?.inbox);
  expect(dialog.modules?.kb).toBe(before.modules?.kb);

  // Code the two modules share is part of both.
  const shared = await buildApp({
    "modules/format.js": "export const format = (text) => `<${text}>`;",
  });
  expect(shared.modules?.inbox).not.toBe(before.modules?.inbox);
  expect(shared.modules?.kb).not.toBe(before.modules?.kb);

  // The shell's own code, which every page has already, changes the client only.
  const shell = await buildApp({ "shared.js": "export const greet = (who) => `hi ${who}`;" });
  expect(shell.client).not.toBe(before.client);
  expect(shell.modules).toEqual(before.modules);
}, 60_000);

test("the build's id in the browser code changes the client, but no module's fingerprint", async () => {
  // As an app writes its commit, whole and short, into the code that tags its error reports.
  const releasing = (commit: string) => ({
    "modules/kb.js": [
      'import { format } from "./format.js";',
      `const release = "v1+${commit}", version = "${commit.slice(0, 7)}";`,
      "export const render = () => format(`Help center ${release} ${version}`);",
    ].join("\n"),
  });
  const first = await buildApp(releasing("4f1c9e2aa07"), [], "4f1c9e2aa07");
  const second = await buildApp(releasing("b83d05f6c1e"), [], "b83d05f6c1e");
  expect(second.id).toBe("b83d05f6c1e");
  // The chunk with the commit, and every chunk that imports it, has another name, and a tab on the
  // first build may need files the second no longer serves: its browser code is not the same.
  expect(second.client).not.toBe(first.client);
  // What the code does is the same, so no notice is due.
  expect(second.modules).toEqual(first.modules);
}, 60_000);

test("a short build id, such as a CI build number, hides no change", async () => {
  const numbered = (count: string) => ({
    "modules/kb.js": [
      'import { format } from "./format.js";',
      `export const render = () => format("Help center: ${count} articles");`,
    ].join("\n"),
  });
  const first = await buildApp(numbered("142"), [], "42");
  const second = await buildApp(numbered("242"), [], "42");
  expect(second.modules?.kb).not.toBe(first.modules?.kb);
  expect(second.modules?.inbox).toBe(first.modules?.inbox);
}, 60_000);
