import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
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
  const asset = files.find((file) => file.fileName === "build.json");
  expect(asset && "source" in asset ? String(asset.source) : "").toBe('{"id":"abc123"}\n');
});
