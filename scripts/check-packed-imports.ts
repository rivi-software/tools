/**
 * Checks the publishable packages as a consumer gets them from npm. Each is packed the way
 * `pnpm publish` packs it; arethetypeswrong then reads every entry point's types under Node's ESM
 * and bundler resolution, and plain Node (no TypeScript, no bundler, no workspace links) installs
 * the tarballs, with each package's peers at the versions its tests use, and imports every entry
 * point and checks every `bin`. A `cloudflare:` module resolves to an empty stand-in, so entry
 * points meant for Workers load too. Run it after `pnpm run build`.
 *   node scripts/check-packed-imports.ts
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** An export's target: a file, conditions to pick one, or null to block the subpath. */
type ExportTarget = string | { [condition: string]: ExportTarget } | null;

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, ExportTarget>;
  bin?: string | Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// What an entry point for Workers may import from the runtime's own modules.
const WORKERS_MODULES = {
  "cloudflare:workers": [
    "export const env = {};",
    "export function waitUntil() {}",
    "export class WorkerEntrypoint {}",
    "export class DurableObject {}",
    "export class WorkflowEntrypoint {}",
    "export class RpcTarget {}",
  ].join("\n"),
  "cloudflare:sockets":
    "export function connect() { throw new Error('no sockets in Node'); }",
  "cloudflare:email": "export class EmailMessage {}",
};

const IMPORT_SCRIPT = `
import { registerHooks } from "node:module";
const modules = ${JSON.stringify(WORKERS_MODULES)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in modules)
      return { url: "data:text/javascript," + encodeURIComponent(modules[specifier]), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
for (const specifier of process.argv.slice(2)) {
  await import(specifier);
  console.log("ok  import " + specifier);
}
`;

const root = path.join(import.meta.dirname, "..");
const packagesDir = path.join(root, "packages");

// SAFETY: every package.json in the workspace is a manifest with at least a name.
const packages = (
  existsSync(packagesDir) ? readdirSync(packagesDir).toSorted() : []
)
  .map((dir) => path.join(packagesDir, dir))
  .filter((dir) => existsSync(path.join(dir, "package.json")))
  .map((dir) => ({
    dir,
    manifest: JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf-8")
    ) as Manifest,
  }))
  .filter(({ manifest }) => manifest.private !== true);

if (packages.length === 0) {
  console.log("No publishable packages to check.");
  process.exit(0);
}

/** Whether a manifest's `bin` is the short form, the one command named after the package. */
const isSingleBin = (bin: Manifest["bin"]): bin is string =>
  typeof bin === "string";

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

const work = mkdtempSync(path.join(tmpdir(), "packed-imports-"));

try {
  const tarballs: string[] = [];

  for (const { dir, manifest } of packages) {
    const destination = path.join(
      work,
      "tarballs",
      manifest.name.replace("/", "+")
    );

    mkdirSync(destination, { recursive: true });
    run("pnpm", ["pack", "--pack-destination", destination], dir);
    const tarball = path.join(destination, readdirSync(destination)[0]);
    run(
      path.join(root, "node_modules", ".bin", "attw"),
      [tarball, "--profile", "esm-only"],
      root
    );
    tarballs.push(tarball);
  }

  // Each peer at the version the package's own tests run against.
  const peers = new Map<string, string>();

  for (const { manifest } of packages) {
    for (const [name, range] of Object.entries(
      manifest.peerDependencies ?? {}
    )) {
      if (!peers.has(name)) {
        peers.set(name, manifest.devDependencies?.[name] ?? range);
      }
    }
  }

  const project = path.join(work, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "packed-import-check",
      private: true,
      type: "module",
    })
  );
  writeFileSync(path.join(project, "import.mjs"), IMPORT_SCRIPT);
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      // Like pnpm's minimumReleaseAge for the workspace: no release younger than a day, which can
      // be listed before its tarball is served, or turn out to be a bad release.
      `--before=${new Date(Date.now() - 86_400_000).toISOString()}`,
      ...tarballs,
      ...[...peers].map(([name, version]) => `${name}@${version}`),
    ],
    project
  );

  for (const { manifest } of packages) {
    const specifiers = Object.keys(manifest.exports ?? {})
      .filter((subpath) => subpath !== "./package.json")
      .map((subpath) =>
        subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`
      );

    run(process.execPath, ["import.mjs", ...specifiers], project);

    const bins = isSingleBin(manifest.bin)
      ? { [manifest.name]: manifest.bin }
      : manifest.bin;

    for (const [command, target] of Object.entries(bins ?? {})) {
      const file = path.join(project, "node_modules", manifest.name, target);

      if (
        !existsSync(path.join(project, "node_modules", ".bin", command)) ||
        !existsSync(file)
      ) {
        throw new Error(`${manifest.name}: bin "${command}" was not installed`);
      }

      if (!readFileSync(file, "utf-8").startsWith("#!/usr/bin/env node\n")) {
        throw new Error(
          `${manifest.name}: bin "${command}" does not start with a node shebang`
        );
      }

      console.log(`ok  bin ${command}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
