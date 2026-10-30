#!/usr/bin/env node
// The `semgrep-github-report` command. Node runs this file only as the command, so it calls main()
// without an `if (import.meta.main)` check: Node 22 before 22.18 reads that as undefined, and the
// command would exit 0 having posted nothing.
import { main } from "./main.js";

main(process.argv.slice(2), process.env).then(
  (output) => console.log(output),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
