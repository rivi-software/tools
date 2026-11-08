#!/usr/bin/env node
import { runCli } from "./run-cli.js";

/** `d1-migrations bundle` and `d1-migrations journal [--check]` (./run-cli.ts). */
process.exitCode = await runCli(
  process.argv.slice(2).filter((arg) => arg !== "--")
);
