#!/usr/bin/env node
// The `cf-previews` command (./run-cli.ts). Node runs this file only as the command, so it runs
// without an `if (import.meta.main)` check.
import { runCli } from "./run-cli.js";

process.exitCode = await runCli(process.argv.slice(2));
