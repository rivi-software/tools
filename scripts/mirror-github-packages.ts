/**
 * Copies to GitHub Packages every release of the publishable packages that npm has and GitHub
 * Packages lacks, so each installs from either registry. A copy is npm's own tarball, checked
 * against the integrity npm lists for it, so both registries serve the same bytes. The first run
 * copies each package's releases from its first one; after that, a run copies what the release
 * workflow just published. github-packages-plan.ts picks the versions and their dist-tags.
 *   NODE_AUTH_TOKEN=<a token that writes packages> node scripts/mirror-github-packages.ts
 *   node scripts/mirror-github-packages.ts --dry-run    lists the copies and publishes nothing
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { planCopies } from "./github-packages-plan.ts";
import type { Packument } from "./github-packages-plan.ts";

const NPM = "https://registry.npmjs.org";
const GITHUB = "https://npm.pkg.github.com";

interface Dist {
  tarball: string;
  integrity: string;
}

type NpmPackument = Packument & { versions: Record<string, { dist: Dist }> };

/** The registry's packument for a package, or undefined when the registry has no such package. */
const packument = async (
  registry: string,
  name: string,
  token?: string
): Promise<Packument | undefined> => {
  const response = await fetch(`${registry}/${name.replace("/", "%2f")}`, {
    headers: {
      accept: "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `${registry} answered ${response.status}: ${await response.text()}`
    );
  }

  // SAFETY: a registry answers a packument as JSON; the plan reads only the fields it has.
  return (await response.json()) as Packument;
};

/** npm's tarball for a version, once its bytes match the sha512 integrity npm lists for it. */
const tarball = async (dist: Dist): Promise<Buffer> => {
  const response = await fetch(dist.tarball);

  if (!response.ok) {
    throw new Error(`${dist.tarball} answered ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  const expected = dist.integrity
    .split(/\s+/u)
    .find((hash) => hash.startsWith("sha512-"));

  if (
    expected !== `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  ) {
    throw new Error(
      `${dist.tarball} does not match the integrity npm lists for it`
    );
  }

  return bytes;
};

const dryRun = process.argv.includes("--dry-run");
const token = process.env.NODE_AUTH_TOKEN || undefined;

if (!token && !dryRun) {
  console.error(
    "NODE_AUTH_TOKEN must hold a token that writes packages: in the release workflow, the job's GITHUB_TOKEN with packages: write."
  );
  process.exit(1);
}

if (!token) {
  console.log(
    "No NODE_AUTH_TOKEN: taking GitHub Packages to have no releases yet."
  );
}

const packagesDir = path.join(import.meta.dirname, "..", "packages");

// SAFETY: a package.json is a JSON object with a name; private is optional.
const names = readdirSync(packagesDir)
  .toSorted()
  .map((dir) => path.join(packagesDir, dir, "package.json"))
  .filter((file) => existsSync(file))
  .map(
    (file) =>
      JSON.parse(readFileSync(file, "utf-8")) as {
        name: string;
        private?: boolean;
      }
  )
  .filter((manifest) => manifest.private !== true)
  .map((manifest) => manifest.name);

const work = mkdtempSync(path.join(tmpdir(), "github-packages-"));

// npm reads the token from the environment as it publishes, so it is never written to disk.
const npmrc = path.join(work, "npmrc");

writeFileSync(
  npmrc,
  `@rivi-software:registry=${GITHUB}/\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`
);

let failed = false;

try {
  for (const name of names) {
    let current = "";

    try {
      // SAFETY: npm lists dist on every version of a packument it serves.
      // oxlint-disable-next-line eslint/no-await-in-loop -- one package at a time, so a failure stops at the package it happened on
      const npm = (await packument(NPM, name)) as NpmPackument | undefined;

      if (!npm) {
        console.log(`${name}: not on npm yet`);
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- the plan for this package needs its npm packument first
      const github = token ? await packument(GITHUB, name, token) : undefined;

      const { copies, leftOut } = planCopies(
        npm,
        new Set(Object.keys(github?.versions ?? {}))
      );

      for (const version of leftOut) {
        console.log(
          `::warning::${name}@${version} is not copied to GitHub Packages: no dist-tag on npm points at it or at a later release still to copy, and publishing it with another would move that tag on GitHub Packages for good.`
        );
      }

      if (copies.length === 0) {
        console.log(`${name}: GitHub Packages has every release`);
      }

      // In order, and no further after a copy fails: a later copy can take back a tag an
      // earlier one was published with, and a failed one would leave that tag behind.
      for (const { version, tag } of copies) {
        current = `${name}@${version}`;

        if (dryRun) {
          console.log(`${current}: would copy, tagged ${tag}`);
          continue;
        }

        const file = path.join(
          work,
          `${name.replace("/", "+")}-${version}.tgz`
        );

        // oxlint-disable-next-line eslint/no-await-in-loop -- copies go in order: a later one takes back a tag an earlier one set
        writeFileSync(file, await tarball(npm.versions[version].dist));
        execFileSync(
          "npm",
          [
            "publish",
            file,
            "--tag",
            tag,
            "--ignore-scripts",
            "--userconfig",
            npmrc,
          ],
          { cwd: work, stdio: "inherit" }
        );
        console.log(`${current}: copied, tagged ${tag}`);
      }
    } catch (error) {
      failed = true;
      // SAFETY: fetch, npm publish and this script throw Errors.
      console.log(`::error::${current || name}: ${(error as Error).message}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
