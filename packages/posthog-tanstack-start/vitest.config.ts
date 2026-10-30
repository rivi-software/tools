import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The tests run in Node, which has no Workers runtime; `src/server.ts` reads its vars from this stand-in.
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(import.meta.dirname, "tests/cloudflare-workers.ts"),
    },
  },
});
