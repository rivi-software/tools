import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The tests run in Node, which has no Workers runtime; `sendRawWithBinding` builds its messages from this
  // stand-in there.
  resolve: {
    alias: {
      "cloudflare:email": path.resolve(
        import.meta.dirname,
        "tests/cloudflare-email.ts"
      ),
    },
  },
});
