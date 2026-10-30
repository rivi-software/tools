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
import { join } from "node:path";

type Manifest = {
  name: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  bin?: string | Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// What an entry point for Workers may import from the runtime's own modules.
const WORKERS_MODULES: Record<string, string> = {
  "cloudflare:workers": [
    "export const env = {};",
    "export function waitUntil() {}",
    "export class WorkerEntrypoint {}",
    "export class DurableObject {}",
    "export class WorkflowEntrypoint {}",
    "export class RpcTarget {}",
  ].join("\n"),
  "cloudflare:sockets": "export function connect() { throw new Error('no sockets in Node'); }",
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

const root = join(import.meta.dirname, "..");
const packagesDir = join(root, "packages");
const packages = (existsSync(packagesDir) ? readdirSync(packagesDir).sort() : [])
  .map((dir) => join(packagesDir, dir))
  .filter((dir) => existsSync(join(dir, "package.json")))
  .map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest,
  }))
  .filter(({ manifest }) => manifest.private !== true);

if (packages.length === 0) {
  console.log("No publishable packages to check.");
  process.exit(0);
}

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

const work = mkdtempSync(join(tmpdir(), "packed-imports-"));
try {
  const tarballs: string[] = [];
  for (const { dir, manifest } of packages) {
    const destination = join(work, "tarballs", manifest.name.replace("/", "+"));
    mkdirSync(destination, { recursive: true });
    run("pnpm", ["pack", "--pack-destination", destination], dir);
    const tarball = join(destination, readdirSync(destination)[0]);
    run(join(root, "node_modules", ".bin", "attw"), [tarball, "--profile", "esm-only"], root);
    tarballs.push(tarball);
  }

  // Each peer at the version the package's own tests run against.
  const peers = new Map<string, string>();
  for (const { manifest } of packages)
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {}))
      if (!peers.has(name)) peers.set(name, manifest.devDependencies?.[name] ?? range);

  const project = join(work, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "packed-import-check", private: true, type: "module" }),
  );
  writeFileSync(join(project, "import.mjs"), IMPORT_SCRIPT);
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
    project,
  );

  for (const { manifest } of packages) {
    const specifiers = Object.keys(manifest.exports ?? {})
      .filter((subpath) => subpath !== "./package.json")
      .map((subpath) => (subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`));
    run(process.execPath, ["import.mjs", ...specifiers], project);

    const bins =
      typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin;
    for (const [command, target] of Object.entries(bins ?? {})) {
      const file = join(project, "node_modules", manifest.name, target);
      if (!existsSync(join(project, "node_modules", ".bin", command)) || !existsSync(file))
        throw new Error(`${manifest.name}: bin "${command}" was not installed`);
      if (!readFileSync(file, "utf8").startsWith("#!/usr/bin/env node\n"))
        throw new Error(`${manifest.name}: bin "${command}" does not start with a node shebang`);
      console.log(`ok  bin ${command}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
