import path from "node:path";

import { defineConfig } from "vitest/config";

// The tests run before any build, so they import cloudflare-deploy's sources (as tsconfig.json's
// `paths` does for the type check), not the built files the package's exports name.
const cloudflareDeploy = path.resolve(
  import.meta.dirname,
  "../cloudflare-deploy/src"
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@rivi-software\/cloudflare-deploy$/u,
        replacement: path.join(cloudflareDeploy, "index.ts"),
      },
      {
        find: /^@rivi-software\/cloudflare-deploy\/(?<entry>.+)$/u,
        replacement: path.join(cloudflareDeploy, "$<entry>.ts"),
      },
    ],
  },
});
