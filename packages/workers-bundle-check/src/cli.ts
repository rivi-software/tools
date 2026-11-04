#!/usr/bin/env node
import { runCli } from "./run-cli.js";

/** `workers-bundle-check [--config <file>] [--server <dir>] [--assets <dir>]` (./run-cli.ts). */
process.exitCode = await runCli(process.argv.slice(2).filter((arg) => arg !== "--"));
