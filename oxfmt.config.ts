import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "**/*.md",
    "**/*.json",
    "**/*.jsonc",
  ],
  // Keep the line breaks of YAML's folded scalars, such as the one flag per line of RIVI Bot's
  // `claude_args`, which Ultracite's "never" joins into one line.
  proseWrap: "preserve",
});
