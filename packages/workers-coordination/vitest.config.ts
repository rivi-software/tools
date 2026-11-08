import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The tests in Node have no Workers runtime; the classes extend this stand-in there. The tests
  // in workerd.test.ts run the built package in workerd instead.
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(
        import.meta.dirname,
        "tests/cloudflare-workers.ts"
      ),
    },
  },
  // workerd.test.ts waits up to 10 s for an alarm to run, which a busy CI machine can delay.
  test: { testTimeout: 20_000 },
});
