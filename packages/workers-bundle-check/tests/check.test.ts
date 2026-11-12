import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { checkWorkerBundle, WorkerBundleCheckError } from "../src/index.js";
import type {
  ForbiddenRule,
  WorkerBundleCheckOptions,
  WorkerBundleProblem,
} from "../src/index.js";
import { fingerprint } from "../src/secrets.js";
import {
  STRIPE_TEST_KEY,
  temporaryDirectory,
  viteBuild,
  workerProject,
  wranglerBuild,
  write,
} from "./helpers.js";

/** The problems the check finds, or none when it passes. */
const problems = async (
  options: WorkerBundleCheckOptions
): Promise<WorkerBundleProblem[]> => {
  try {
    await checkWorkerBundle(options);

    return [];
  } catch (error) {
    if (error instanceof WorkerBundleCheckError) {
      return error.report.problems;
    }

    throw error;
  }
};

/** A project whose Worker has a map, with the asset files `files` adds. */
const assetsProject = (files: Record<string, string>) => {
  const dir = temporaryDirectory();
  write(dir, {
    "dist/server/index.js":
      "export default {};\n//# sourceMappingURL=index.js.map",
    "dist/server/index.js.map": JSON.stringify({
      version: 3,
      sources: [],
      mappings: "",
    }),
    ...files,
  });

  return { cwd: dir, serverDir: "dist/server", assetsDir: "dist/client" };
};

const STRIPE = {
  secret: STRIPE_TEST_KEY,
  fingerprint: fingerprint(STRIPE_TEST_KEY),
};

const ALLOW_MOCK_KEY = [
  { fingerprint: STRIPE.fingerprint, reason: "Stripe's published example key" },
];

let project: string;

describe(checkWorkerBundle, () => {
  beforeAll(async () => {
    project = workerProject();
    await viteBuild(project);
    await wranglerBuild(project);
  }, 60_000);

  describe.for([
    {
      builder: "Vite (Rolldown)",
      serverDir: "dist/server",
      entry: "dist/server/index.mjs",
    },
    {
      builder: "Wrangler (esbuild)",
      serverDir: "dist/wrangler",
      entry: "dist/wrangler/index.js",
    },
  ])("a Worker built by $builder", ({ serverDir, entry }) => {
    it("names the modules a rule forbids, with the file they are in", async () => {
      const rules: ForbiddenRule[] = [
        { module: "fake-mock", reason: "test-only" },
        { module: "**/icons/all.js", reason: "import single icons" },
      ];

      const found = await problems({
        cwd: project,
        serverDir,
        forbidden: rules,
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      expect(found).toStrictEqual([
        expect.objectContaining({
          kind: "forbidden-module",
          rule: rules[0],
          file: entry,
          modules: [
            {
              path: "node_modules/fake-mock/lib/index.js",
              bytes: expect.any(Number),
            },
          ],
          message: expect.stringMatching(
            new RegExp(
              `^${entry} holds node_modules/fake-mock/lib/index\\.js \\(\\d+ B\\), which "fake-mock" forbids: test-only\\.$`,
              "u"
            )
          ),
        }),
        expect.objectContaining({
          kind: "forbidden-module",
          rule: rules[1],
          file: entry,
          // The symlinked package, by its real path in pnpm's store.
          modules: [
            {
              path: "node_modules/.pnpm/icons@1.0.0/node_modules/icons/dist/icons/all.js",
              bytes: expect.any(Number),
            },
          ],
        }),
      ]);
    });

    it("finds a marker in the code, whichever module it comes from", async () => {
      const rule = { marker: /FAKE_MOCK_[A-Z]+/gu, reason: "test-only" };

      const found = await problems({
        cwd: project,
        serverDir,
        forbidden: [rule, rule],
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      // A global regular expression keeps no state between files and rules.
      expect(found.map(({ message }) => message)).toStrictEqual([
        `${entry} contains the marker /FAKE_MOCK_[A-Z]+/gu, which is forbidden: test-only.`,
        `${entry} contains the marker /FAKE_MOCK_[A-Z]+/gu, which is forbidden: test-only.`,
      ]);
    });

    it("passes a module the build tree-shook away, and one nothing imports", async () => {
      const report = await checkWorkerBundle({
        cwd: project,
        serverDir,
        forbidden: [
          {
            module: "src/shaken.ts",
            marker: "SHAKEN_AWAY",
            reason: "never used",
          },
          { module: "src/mocks/**", reason: "dev only" },
          { module: "unused-dep", reason: "server only" },
        ],
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      expect(report.modules).toBe(5);
      expect(report.allowedSecrets).toBe(1);
    });

    it("names the module a value shaped like a secret comes from", async () => {
      const found = await problems({ cwd: project, serverDir });
      expect(found).toStrictEqual([
        {
          kind: "secret",
          file: entry,
          name: "Stripe secret key",
          fingerprint: STRIPE.fingerprint,
          line: 1,
          module: "node_modules/fake-mock/lib/index.js",
          message: `${entry}:1 holds a value shaped like a Stripe secret key, from node_modules/fake-mock/lib/index.js (fingerprint ${STRIPE.fingerprint}).`,
        },
      ]);
      expect(JSON.stringify(found)).not.toContain(STRIPE.secret);
    });
  });

  describe("rules that guard nothing", () => {
    it("reports a package that is not installed, and a glob no file matches", async () => {
      const found = await problems({
        cwd: project,
        serverDir: "dist/server",
        forbidden: [
          { module: "msw", reason: "test-only" },
          { module: "@scope/gone", reason: "removed" },
          { module: "**/icons/every.js", reason: "renamed" },
          { module: /\/does-not-exist\//u, reason: "never there" },
        ],
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      expect(found.map(({ message }) => message)).toStrictEqual([
        'The rule against module "msw" (test-only) guards nothing: no package "msw" is installed. Update the rule or remove it.',
        'The rule against module "@scope/gone" (removed) guards nothing: no package "@scope/gone" is installed. Update the rule or remove it.',
        'The rule against module "**/icons/every.js" (renamed) guards nothing: no file matches "**/icons/every.js". Update the rule or remove it.',
        "The rule against module /\\/does-not-exist\\//u (never there) guards nothing: no file matches /\\/does-not-exist\\//u. Update the rule or remove it.",
      ]);
    });

    it("reports a marker no file of the project contains", async () => {
      const found = await problems({
        cwd: project,
        serverDir: "dist/server",
        forbidden: [
          { marker: "DEV_ONLY_HANDLERS", reason: "dev only" },
          { marker: "NOWHERE", reason: "gone" },
          {
            module: "src/mocks/**",
            marker: "DEV_ONLY_HANDLERS",
            reason: "dev only",
          },
          {
            module: "src/mocks/**",
            marker: "SHAKEN_AWAY",
            reason: "wrong module",
          },
          // A marker only a package has counts with that package's module pattern, not on its own.
          { marker: "UNUSED_DEP", reason: "server only" },
          { module: "unused-dep", marker: "UNUSED_DEP", reason: "server only" },
        ],
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      expect(found.map(({ message }) => message)).toStrictEqual([
        'The rule against marker "NOWHERE" (gone) guards nothing: no file of the project, outside node_modules, contains "NOWHERE". Update the rule or remove it.',
        'The rule against module "src/mocks/**" and marker "SHAKEN_AWAY" (wrong module) guards nothing: no file that "src/mocks/**" matches contains "SHAKEN_AWAY". Update the rule or remove it.',
        'The rule against marker "UNUSED_DEP" (server only) guards nothing: no file of the project, outside node_modules, contains "UNUSED_DEP". Update the rule or remove it.',
      ]);
    });

    it("does not call a marker stale while the Worker holds it", async () => {
      const found = await problems({
        cwd: project,
        serverDir: "dist/server",
        forbidden: [
          {
            module: "src/mocks/**",
            marker: "FAKE_MOCK_ACTIVE",
            reason: "test-only",
          },
        ],
        allowedSecrets: ALLOW_MOCK_KEY,
      });

      expect(found.map(({ kind }) => kind)).toStrictEqual(["forbidden-marker"]);
    });

    it("finds a package a monorepo installs in its root", async () => {
      const root = temporaryDirectory();
      write(root, {
        "node_modules/.pnpm/hoisted@1.0.0/node_modules/hoisted/package.json":
          "{}",
        "node_modules/.pnpm/hoisted@1.0.0/node_modules/hoisted/dist/all.js": "",
        "apps/web/dist/server/index.js":
          "export default {};\n//# sourceMappingURL=index.js.map",
        "apps/web/dist/server/index.js.map": JSON.stringify({
          version: 3,
          sources: [],
          mappings: "",
        }),
      });

      const options = {
        cwd: path.join(root, "apps/web"),
        serverDir: "dist/server",
      };

      await expect(
        problems({
          ...options,
          forbidden: [{ module: "hoisted", reason: "server only" }],
        })
      ).resolves.toStrictEqual([]);
      await expect(
        problems({
          ...options,
          forbidden: [{ module: "**/hoisted/dist/all.js", reason: "x" }],
        })
      ).resolves.toStrictEqual([]);
    });
  });

  describe("the Worker's source maps", () => {
    it("reports a Worker file without a map when a rule names a module", async () => {
      const dir = workerProject();
      await viteBuild(dir, { sourcemap: false });

      const options = {
        cwd: dir,
        serverDir: "dist/server",
        allowedSecrets: ALLOW_MOCK_KEY,
      };

      const withoutMaps = await problems({
        ...options,
        forbidden: [{ module: "fake-mock", reason: "test-only" }],
      });

      expect(withoutMaps.map(({ message }) => message)).toStrictEqual([
        "dist/server/assets/lazy-DkoKwvvB.mjs has no source map, so the rules cannot see the modules in it. Build the Worker with source maps.",
        "dist/server/index.mjs has no source map, so the rules cannot see the modules in it. Build the Worker with source maps.",
      ]);

      // Markers need no map.
      const byMarker = await problems({
        ...options,
        forbidden: [{ marker: "FAKE_MOCK_ACTIVE", reason: "x" }],
      });

      expect(byMarker.map(({ kind }) => kind)).toStrictEqual([
        "forbidden-marker",
      ]);
    }, 30_000);

    it("reads hidden and inline maps", async () => {
      for (const sourcemap of ["hidden", "inline"] as const) {
        const dir = workerProject();
        // oxlint-disable-next-line eslint/no-await-in-loop -- the two builds run one after the other, so they do not compete for the machine
        await viteBuild(dir, { sourcemap });

        // oxlint-disable-next-line eslint/no-await-in-loop -- each check reads the build the line above just wrote
        const found = await problems({
          cwd: dir,
          serverDir: "dist/server",
          forbidden: [{ module: "fake-mock", reason: "test-only" }],
          allowedSecrets: ALLOW_MOCK_KEY,
        });

        expect(found.map(({ kind }) => kind)).toStrictEqual([
          "forbidden-module",
        ]);
      }
    }, 30_000);
  });

  describe("the assets", () => {
    it("reports the source maps Wrangler would serve", async () => {
      const options = assetsProject({
        "dist/client/.assetsignore": "assets/*.js.map\n",
        "dist/client/assets/app.js": "app()\n//# sourceMappingURL=app.js.map",
        "dist/client/assets/app.js.map": "{}",
        "dist/client/assets/app.css":
          "a{}\n/*# sourceMappingURL=app.css.map */",
        "dist/client/assets/app.css.map": "{}",
        "dist/client/assets/nested/chunk.js.map": "{}",
        "dist/client/inline.js": `x()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from("{}").toString("base64")}\n`,
        "dist/client/mentions.js":
          'const s = "//# sourceMappingURL=data:"; x(s);',
      });

      await expect(problems(options)).resolves.toStrictEqual([
        {
          kind: "served-source-map",
          file: "dist/client/assets/app.css.map",
          message:
            "dist/client/assets/app.css.map is a source map Wrangler would serve: leave it out with dist/client/.assetsignore, or delete it before the deploy.",
        },
        expect.objectContaining({
          kind: "served-source-map",
          file: "dist/client/assets/nested/chunk.js.map",
        }),
        {
          kind: "inline-source-map",
          file: "dist/client/inline.js",
          message:
            "dist/client/inline.js would be served with its source map inline. Build it with external or hidden source maps.",
        },
      ]);
      await expect(checkWorkerBundle(options).catch(String)).resolves.toMatch(
        /^WorkerBundleCheckError: The Worker bundle check found 3 problems:\n {2}dist\/client\/assets\/app\.css\.map is/u
      );
    });

    it("passes a build whose .assetsignore leaves out every map", async () => {
      const options = assetsProject({
        "dist/client/.assetsignore":
          "# Source maps go to the error tracker.\r\n*.map\r\n",
        "dist/client/assets/app.js": "app()",
        "dist/client/assets/app.js.map": "{}",
        "dist/client/index.html": "<!doctype html>",
      });

      await expect(checkWorkerBundle(options)).resolves.toStrictEqual({
        serverDir: "dist/server",
        workerFiles: ["dist/server/index.js"],
        modules: 0,
        assetsDir: "dist/client",
        servedAssets: 2,
        ignoredAssets: 2,
        allowedSecrets: 0,
        problems: [],
      });
    });

    it("looks for secrets in what the assets serve, not in what they leave out", async () => {
      const options = assetsProject({
        "dist/client/.assetsignore": "private/\n",
        "dist/client/index.html": `<script>window.key = "${STRIPE.secret}"</script>`,
        "dist/client/.env": `\nSTRIPE_KEY=${STRIPE.secret}\n`,
        "dist/client/private/notes.txt": STRIPE.secret,
        "dist/client/logo.png": STRIPE.secret,
        "dist/client/data.bin.txt": `\0${STRIPE.secret}`,
      });

      const found = await problems(options);

      expect(found.map(({ message }) => message)).toStrictEqual([
        `dist/client/.env:2 holds a value shaped like a Stripe secret key (fingerprint ${STRIPE.fingerprint}).`,
        `dist/client/index.html:1 holds a value shaped like a Stripe secret key (fingerprint ${STRIPE.fingerprint}).`,
      ]);
    });

    it("names the module a served script's value comes from, by a map that is not served", async () => {
      const code = `const k="${STRIPE.secret}";`;

      const options = assetsProject({
        "src/config.ts": "",
        "dist/client/.assetsignore": "*.map\n",
        "dist/client/assets/app.js": `${code}\n//# sourceMappingURL=app.js.map`,
        "dist/client/assets/app.js.map": JSON.stringify({
          version: 3,
          sources: ["../../../src/config.ts"],
          mappings: "AAAA",
        }),
      });

      const found = await problems(options);

      expect(found.map(({ message }) => message)).toStrictEqual([
        `dist/client/assets/app.js:1 holds a value shaped like a Stripe secret key, from src/config.ts (fingerprint ${STRIPE.fingerprint}).`,
      ]);
    });
  });

  describe("links", () => {
    it("serves a link to a file as that file, and names it by its path in the assets", async () => {
      const options = assetsProject({
        ".env": `STRIPE_KEY=${STRIPE.secret}\n`,
        "build/maps/app.js.map": "{}",
        "dist/client/assets/app.js": "app()",
      });

      const client = path.join(options.cwd, "dist/client");
      symlinkSync(
        "../../../build/maps/app.js.map",
        path.join(client, "assets/app.js.map")
      );
      symlinkSync("../../.env", path.join(client, ".env"));
      // A link to nothing serves nothing: Wrangler fails the deploy on it itself.
      symlinkSync("missing.txt", path.join(client, "dangling.txt"));

      const found = await problems(options);

      expect(found.map(({ message }) => message)).toStrictEqual([
        "dist/client/assets/app.js.map is a source map Wrangler would serve: leave it out with dist/client/.assetsignore, or delete it before the deploy.",
        `dist/client/.env:1 holds a value shaped like a Stripe secret key (fingerprint ${STRIPE.fingerprint}).`,
      ]);
    });

    it("follows a link to a directory in the assets, as Wrangler does", async () => {
      const options = assetsProject({
        "shared/fonts/font.css.map": "{}",
        "shared/fonts/notes.txt": STRIPE.secret,
        "dist/client/index.html": "<!doctype html>",
      });

      const client = path.join(options.cwd, "dist/client");
      symlinkSync("../../shared/fonts", path.join(client, "fonts"), "dir");

      const found = await problems(options);

      expect(found.map(({ message }) => message)).toStrictEqual([
        "dist/client/fonts/font.css.map is a source map Wrangler would serve: leave it out with dist/client/.assetsignore, or delete it before the deploy.",
        `dist/client/fonts/notes.txt:1 holds a value shaped like a Stripe secret key (fingerprint ${STRIPE.fingerprint}).`,
      ]);

      write(options.cwd, { "dist/client/.assetsignore": "fonts/\n" });

      await expect(checkWorkerBundle(options)).resolves.toMatchObject({
        servedAssets: 1,
        ignoredAssets: 3,
        problems: [],
      });
    });

    it("reads a link to a file in the Worker's build, and does not follow a link to a directory there", async () => {
      const options = assetsProject({
        "vendor/extra.js": `export const key = "${STRIPE.secret}";`,
        "vendor/lib/inner.js": `export const key = "${STRIPE.secret}";`,
      });

      const server = path.join(options.cwd, "dist/server");
      symlinkSync("../../vendor/extra.js", path.join(server, "extra.js"));
      symlinkSync("../../vendor/lib", path.join(server, "lib"), "dir");

      // Wrangler's walk for a Worker's modules takes the first link and not the second.
      await expect(
        checkWorkerBundle({
          cwd: options.cwd,
          serverDir: options.serverDir,
          allowedSecrets: ALLOW_MOCK_KEY,
        })
      ).resolves.toMatchObject({
        workerFiles: ["dist/server/extra.js", "dist/server/index.js"],
        allowedSecrets: 1,
      });
    });
  });

  describe("allowed secrets", () => {
    it("lets a finding through by its fingerprint or its module, and reports an entry that matches none", async () => {
      const options = { cwd: project, serverDir: "dist/wrangler" };
      await expect(
        problems({
          ...options,
          allowedSecrets: [
            { fingerprint: STRIPE.fingerprint, reason: "Stripe's example key" },
          ],
        })
      ).resolves.toStrictEqual([]);
      await expect(
        problems({
          ...options,
          allowedSecrets: [{ module: /fake-mock/u, reason: "example" }],
        })
      ).resolves.toStrictEqual([]);

      const mixed = await problems({
        ...options,
        allowedSecrets: [
          {
            module: "fake-mock",
            fingerprint: "0000000000000000",
            reason: "another key",
          },
          { module: "icons", reason: "no keys there" },
        ],
      });

      expect(mixed.map(({ kind, message }) => [kind, message])).toStrictEqual([
        ["secret", expect.stringContaining("Stripe secret key")],
        [
          "stale-allowed-secret",
          'The allowed secret with fingerprint 0000000000000000 and module "fake-mock" (another key) matches no finding. Remove it.',
        ],
        [
          "stale-allowed-secret",
          'The allowed secret with module "icons" (no keys there) matches no finding. Remove it.',
        ],
      ]);
    });

    it("looks for the patterns it is given too", async () => {
      const found = await problems({
        cwd: project,
        serverDir: "dist/wrangler",
        allowedSecrets: ALLOW_MOCK_KEY,
        secretPatterns: [
          { name: "fake mock marker", pattern: /FAKE_MOCK_ACTIVE/u },
        ],
      });

      expect(found).toStrictEqual([
        expect.objectContaining({
          kind: "secret",
          name: "fake mock marker",
          module: "node_modules/fake-mock/lib/index.js",
        }),
      ]);
    });
  });

  describe("its options", () => {
    it("refuses a rule without a module or marker, or without a reason", async () => {
      const options = { cwd: project, serverDir: "dist/server" };
      await expect(
        checkWorkerBundle({ ...options, forbidden: [{ reason: "nothing" }] })
      ).rejects.toThrow(
        'A forbidden rule names neither a module nor a marker: {"reason":"nothing"}.'
      );
      await expect(
        checkWorkerBundle({
          ...options,
          forbidden: [{ module: /x/u, reason: " " }],
        })
      ).rejects.toThrow(
        'A forbidden rule has no reason: {"module":"/x/u","reason":" "}.'
      );
      await expect(
        checkWorkerBundle({ ...options, allowedSecrets: [{ reason: "all" }] })
      ).rejects.toThrow(
        "An allowed secret names neither a fingerprint nor a module (all)."
      );
      await expect(
        checkWorkerBundle({
          ...options,
          secretPatterns: [{ name: "any", pattern: /x*/u }],
        })
      ).rejects.toThrow("The secret pattern any matches an empty string.");
      await expect(
        checkWorkerBundle({
          ...options,
          // @ts-expect-error A configuration file in JavaScript can pass a verify of any type.
          secretPatterns: [{ name: "any", pattern: /x/u, verify: true }],
        })
      ).rejects.toThrow(
        "The secret pattern any has a verify that is not a function."
      );
    });

    it("says when the build is missing", async () => {
      const dir = temporaryDirectory();
      await expect(
        checkWorkerBundle({ cwd: dir, serverDir: "dist/server" })
      ).rejects.toThrow(
        "There is no Worker build at dist/server: run the build first."
      );
      write(dir, { "dist/server/wrangler.json": "{}" });
      await expect(
        checkWorkerBundle({ cwd: dir, serverDir: "dist/server" })
      ).rejects.toThrow(
        "dist/server holds no JavaScript. Pass the directory the Worker's build writes its modules to, such as dist/server."
      );
      write(dir, { "dist/server/index.js": "" });
      await expect(
        checkWorkerBundle({
          cwd: dir,
          serverDir: "dist/server",
          assetsDir: "dist/client",
        })
      ).rejects.toThrow(
        "There are no assets at dist/client: run the build first."
      );
      rmSync(path.join(dir, "dist"), { recursive: true });
    });
  });
});
