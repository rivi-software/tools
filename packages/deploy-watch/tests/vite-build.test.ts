import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { build, createBuilder, createLogger } from "vite";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deployWatch } from "../src/vite.js";

const packageDir = path.join(import.meta.dirname, "..");
const tsc = path.join(packageDir, "..", "..", "node_modules", ".bin", "tsc");
const IMPORT = /from\s*["']@rivi-software\/deploy-watch["']/u;
let root: string;

/** The code of a server build of `entry.js` with `plugin`. */
const serverBuild = async (plugin: Plugin): Promise<string> => {
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
};

/**
 * An app with a shell and two lazily loaded modules, each of which loads a dialog lazily. Inbox
 * and its dialog share a helper with the help center, which also imports what the shell has.
 */
const APP = {
  "main.js": [
    'import { greet } from "./shared.js";',
    'const open = (name) => name === "inbox" ? import("./modules/inbox.js") : import("./modules/kb.js");',
    "document.body.onclick = () => open(location.hash).then((module) => module.render());",
    "console.log(greet('shell'));",
  ].join("\n"),
  // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
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
  // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
  "modules/format.js": "export const format = (text) => `[${text}]`;",
};

/** The help centre's code with the build's commit, whole and short, written into it. */
const releasing = (commit: string) => ({
  "modules/kb.js": [
    'import { format } from "./format.js";',
    `const release = "v1+${commit}", version = "${commit.slice(0, 7)}";`,
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
    "export const render = () => format(`Help center ${release} ${version}`);",
  ].join("\n"),
});

/** The help centre's code with a count in it, which a short build id could hide. */
const numbered = (count: string) => ({
  "modules/kb.js": [
    'import { format } from "./format.js";',
    `export const render = () => format("Help center: ${count} articles");`,
  ].join("\n"),
});

interface BuildFileBody {
  id: string;
  client: string;
  modules?: Record<string, string>;
}

/** Builds `APP` with `changes` applied, and reads its `build.json`; `seen` collects what `modules` saw. */
const buildApp = async (
  changes: Record<string, string> = {},
  seen: { id: string; importers: readonly string[] }[] = [],
  buildId = "abc123"
): Promise<BuildFileBody> => {
  const app = mkdtempSync(path.join(tmpdir(), "deploy-watch-app-"));

  try {
    for (const [file, code] of Object.entries({ ...APP, ...changes })) {
      mkdirSync(path.join(app, file, ".."), { recursive: true });
      writeFileSync(path.join(app, file), code);
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

            return /^modules\/(?<module>inbox|kb)\.js$/u.exec(file.id)?.groups
              ?.module;
          },
        }),
      ],
      build: {
        write: false,
        minify: true,
        rollupOptions: { input: path.join(app, "main.js") },
      },
    });

    const files = (Array.isArray(result) ? result : [result]).flatMap(
      (output) => ("output" in output ? output.output : [])
    );

    const asset = files.find((file) => file.fileName === "build.json");

    return JSON.parse(asset && "source" in asset ? String(asset.source) : "{}");
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
};

describe("the Vite plugin in a real build", () => {
  // A consumer's project with the package as npm installs it: built files in a real node_modules
  // directory, which a server build leaves external unless told otherwise. (A workspace link
  // resolves outside node_modules, is bundled as source, and hides the difference.)
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "deploy-watch-build-"));

    const installed = path.join(
      root,
      "node_modules",
      "@rivi-software",
      "deploy-watch"
    );

    mkdirSync(installed, { recursive: true });
    execFileSync(tsc, [
      "-p",
      path.join(packageDir, "tsconfig.build.json"),
      "--outDir",
      path.join(installed, "dist"),
    ]);
    cpSync(
      path.join(packageDir, "package.json"),
      path.join(installed, "package.json")
    );
    writeFileSync(
      path.join(root, "entry.js"),
      'import { pageBuildId } from "@rivi-software/deploy-watch";\nexport const id = pageBuildId();\n'
    );
    writeFileSync(
      path.join(root, "client.js"),
      'import { startDeployWatch } from "@rivi-software/deploy-watch";\nstartDeployWatch();\n'
    );
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a server build bundles the installed package, so the page gets the build's id", async () => {
    const code = await serverBuild(deployWatch({ buildId: "abc123" }));
    expect(code).not.toMatch(IMPORT);
    expect(code).toContain('"abc123"');
  });

  it("left external, as a define alone leaves it, the package never sees the id", async () => {
    const plugin = deployWatch({ buildId: "abc123" });

    const defineOnly: Plugin = {
      ...plugin,
      configEnvironment: (name) =>
        name === "client"
          ? undefined
          : { define: { __DEPLOY_WATCH_BUILD_ID__: '"abc123"' } },
    };

    const code = await serverBuild(defineOnly);
    expect(code).toMatch(IMPORT);
    expect(code).not.toContain('"abc123"');
  });

  it("a browser build under another base reads build.json there, and never holds the id", async () => {
    const result = await build({
      root,
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: [deployWatch({ buildId: "abc123" })],
      build: {
        write: false,
        rollupOptions: { input: path.join(root, "client.js") },
      },
    });

    const files = (Array.isArray(result) ? result : [result]).flatMap(
      (output) => ("output" in output ? output.output : [])
    );

    const code = files
      .map((file) => ("code" in file ? file.code : ""))
      .join("\n");

    expect(code).toContain("/app/build.json");
    expect(code).not.toContain("abc123");

    const read = (name: string) => {
      const asset = files.find((file) => file.fileName === name);

      return JSON.parse(
        asset && "source" in asset ? String(asset.source) : "{}"
      );
    };

    const file = read("build.json");
    expect(file).toStrictEqual({
      id: "abc123",
      client: expect.stringMatching(/^[0-9a-f]{16}$/u),
    });
    // The build's own copy, which a tab on it reads once a deploy replaced `build.json`.
    expect(read("assets/deploy-watch-abc123.json")).toStrictEqual(file);
  });

  it("a production build in CI that finds no id warns once, across its environments", async () => {
    for (const name of [
      "WORKERS_CI_COMMIT_SHA",
      "CF_PAGES_COMMIT_SHA",
      "GITHUB_SHA",
      "CI_COMMIT_SHA",
    ]) {
      vi.stubEnv(name, "");
    }

    vi.stubEnv("CI", "true");
    // Vitest's own NODE_ENV (test) makes no production build.
    vi.stubEnv("NODE_ENV", "production");
    const warned: string[] = [];

    const logger = {
      ...createLogger("silent"),
      warn: (message: string) => warned.push(message),
    };

    try {
      // `vite build` resolves the config once for the app and again for each environment.
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        customLogger: logger,
        plugins: [deployWatch()],
        environments: {
          client: {
            build: {
              write: false,
              rollupOptions: { input: path.join(root, "client.js") },
            },
          },
          ssr: { build: { write: false, ssr: "entry.js" } },
        },
      });

      await builder.buildApp();
    } finally {
      vi.unstubAllEnvs();
    }

    expect(
      warned.filter((message) => message.includes("deploy-watch"))
    ).toStrictEqual([expect.stringContaining("no id")]);
  }, 60_000);

  it("each named module's fingerprint changes only with the code it adds to the page", async () => {
    const seen: { id: string; importers: readonly string[] }[] = [];
    const before = await buildApp({}, seen);
    // `modules` sees each lazily loaded file from the project root, with its lazy importers.
    expect(seen).toStrictEqual(
      expect.arrayContaining([
        { id: "modules/inbox.js", importers: ["main.js"] },
        { id: "modules/kb.js", importers: ["main.js"] },
        { id: "modules/inbox-dialog.js", importers: ["modules/inbox.js"] },
      ])
    );
    expect(Object.keys(before.modules ?? {})).toStrictEqual(["inbox", "kb"]);
    // Another build of the same code has the same fingerprints, from another commit too: the copy
    // under the build's own name is in no fingerprint.
    await expect(buildApp()).resolves.toStrictEqual(before);
    await expect(buildApp({}, [], "def456")).resolves.toStrictEqual({
      ...before,
      id: "def456",
    });

    const dialog = await buildApp({
      // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
      "modules/inbox-dialog.js": 'export const text = "Reply";',
    });

    const shared = await buildApp({
      // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
      "modules/format.js": "export const format = (text) => `<${text}>`;",
    });

    const shell = await buildApp({
      // oxlint-disable-next-line eslint/no-template-curly-in-string -- the fixture's own source, written to a file as it stands
      "shared.js": "export const greet = (who) => `hi ${who}`;",
    });

    expect({
      // The inbox's lazily loaded dialog belongs to the inbox.
      dialogClient: dialog.client === before.client,
      dialogInbox: dialog.modules?.inbox === before.modules?.inbox,
      dialogKb: dialog.modules?.kb === before.modules?.kb,
      // Code the two modules share is part of both.
      sharedInbox: shared.modules?.inbox === before.modules?.inbox,
      sharedKb: shared.modules?.kb === before.modules?.kb,
      // The shell's own code, which every page has already, changes the client only.
      shellClient: shell.client === before.client,
      shellModules: shell.modules,
    }).toStrictEqual({
      dialogClient: false,
      dialogInbox: false,
      dialogKb: true,
      sharedInbox: false,
      sharedKb: false,
      shellClient: false,
      shellModules: before.modules,
    });
  }, 60_000);

  it("the build's id in the browser code changes the client, but no module's fingerprint", async () => {
    const first = await buildApp(releasing("4f1c9e2aa07"), [], "4f1c9e2aa07");
    const second = await buildApp(releasing("b83d05f6c1e"), [], "b83d05f6c1e");
    expect(second.id).toBe("b83d05f6c1e");
    // The chunk with the commit, and every chunk that imports it, has another name, and a tab on the
    // first build may need files the second no longer serves: its browser code is not the same.
    expect(second.client).not.toBe(first.client);
    // What the code does is the same, so no notice is due.
    expect(second.modules).toStrictEqual(first.modules);
  }, 60_000);

  it("a short build id, such as a CI build number, hides no change", async () => {
    const first = await buildApp(numbered("142"), [], "42");
    const second = await buildApp(numbered("242"), [], "42");
    expect(second.modules?.kb).not.toBe(first.modules?.kb);
    expect(second.modules?.inbox).toBe(first.modules?.inbox);
  }, 60_000);
});
