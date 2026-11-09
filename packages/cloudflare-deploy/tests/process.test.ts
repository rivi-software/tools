import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommand, runOrThrow } from "../src/process.js";

// Fails its first `failures` runs, printing `message` to stderr, then passes. With `echo`, it
// reads stdin first and prints it when it passes.
const FAKE_COMMAND = `
const fs = require("node:fs");
const [counter, failures, message, echo] = process.argv.slice(1);
const input = echo === "echo" ? fs.readFileSync(0, "utf8") : "";
const runs = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
fs.writeFileSync(counter, String(runs));
if (runs <= Number(failures)) {
  process.stderr.write(message + "\\n");
  process.exitCode = 1;
} else {
  process.stdout.write("passed on run " + runs + input + "\\n");
}
`;

const directories: string[] = [];

const fakeCommand = async (failures: number, message: string, echo = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-command-"));
  directories.push(directory);
  const counter = path.join(directory, "runs");

  return {
    args: [
      process.execPath,
      "-e",
      FAKE_COMMAND,
      counter,
      String(failures),
      message,
      ...(echo ? ["echo"] : []),
    ],
    runs: async () => Number(await readFile(counter, "utf-8")),
  };
};

const pauses = () =>
  vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

// What Wrangler prints when Cloudflare, not the command, failed.
const TRANSIENT = [
  "✘ [ERROR] Failed to fetch /accounts/***/r2/buckets/assets/objects/manifest.json - 502: Bad Gateway",
  "✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/dispatch/namespaces) failed.\n\n  Internal authentication error: internal server error [code: 10500]",
  "✘ [ERROR] Received a malformed response from the API\n\n  <!DOCTYPE html>…",
  "  POST /accounts/***/workers/scripts/app/versions -> 503 Service Unavailable",
  "✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/scripts/app) failed.\n\n  HTTP 500 with no error message",
  "✘ [ERROR] fetch failed",
  "✘ [ERROR] The request to Cloudflare's API timed out.",
  "Error: read ECONNRESET",
];

// Failures that a second run would repeat.
const PERMANENT = [
  "✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/scripts/app) failed.\n\n  Authentication error [code: 10000]",
  "✘ [ERROR] Failed to fetch /accounts/***/r2/buckets/assets/objects/missing.json - 404: Not Found",
  "Total Upload: 502.31 KiB / gzip: 120.04 KiB\n✘ [ERROR] Your Worker exceeded the size limit. [code: 10027]",
];

// Each describe quiets the retry warnings and removes its commands' directories.
const cleanUp = () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });
};

describe(runCommand, () => {
  cleanUp();

  it.each(TRANSIENT)(
    "runs again after a transient failure: %s",
    async (message) => {
      const command = await fakeCommand(1, message);
      const sleep = pauses();

      const result = await runCommand(command.args, {
        capture: true,
        retry: { attempts: 3, sleep },
      });

      expect(result).toStrictEqual({
        code: 0,
        stdout: "passed on run 2\n",
        stderr: "",
      });
      await expect(command.runs()).resolves.toBe(2);
      expect(sleep.mock.calls).toStrictEqual([[1000]]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "hit a transient Cloudflare failure (exit 1); running it again in 1 s (attempt 2 of 3)"
        )
      );
    }
  );

  it.each(PERMANENT)(
    "does not run again after any other failure: %s",
    async (message) => {
      const command = await fakeCommand(1, message);
      const sleep = pauses();

      const result = await runCommand(command.args, {
        capture: true,
        retry: { attempts: 3, sleep },
      });

      expect(result).toStrictEqual({
        code: 1,
        stdout: "",
        stderr: `${message}\n`,
      });
      await expect(command.runs()).resolves.toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    }
  );

  it("runs once without retry", async () => {
    const command = await fakeCommand(1, TRANSIENT[0]);

    const result = await runCommand(command.args, { capture: true });

    expect(result.code).toBe(1);
    await expect(command.runs()).resolves.toBe(1);
  });

  it("waits delayMs, then twice as long each time, and stops after attempts runs", async () => {
    const command = await fakeCommand(5, TRANSIENT[0]);
    const sleep = pauses();

    const result = await runCommand(command.args, {
      capture: true,
      retry: { attempts: 3, delayMs: 250, sleep },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`${TRANSIENT[0]}\n`);
    await expect(command.runs()).resolves.toBe(3);
    expect(sleep.mock.calls).toStrictEqual([[250], [500]]);
  });

  it("passes the output on as it comes when it does not capture it, and returns none", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const command = await fakeCommand(1, TRANSIENT[1]);

    const result = await runCommand(command.args, {
      retry: { attempts: 2, sleep: pauses() },
    });

    const written = (spy: typeof stdout) =>
      spy.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(result).toStrictEqual({ code: 0, stdout: "", stderr: "" });
    await expect(command.runs()).resolves.toBe(2);
    expect(written(stderr)).toContain(TRANSIENT[1]);
    expect(written(stdout)).toContain("passed on run 2\n");
  });

  it("writes input to every run", async () => {
    const command = await fakeCommand(1, TRANSIENT[0], true);

    const result = await runCommand(command.args, {
      capture: true,
      input: ": the input",
      retry: { attempts: 2, sleep: pauses() },
    });

    expect(result.stdout).toBe("passed on run 2: the input\n");
  });
});

describe(runOrThrow, () => {
  cleanUp();

  it("returns the run that passed after a transient failure", async () => {
    const command = await fakeCommand(1, TRANSIENT[0]);

    const result = await runOrThrow(command.args, {
      capture: true,
      retry: { attempts: 2, sleep: pauses() },
    });

    expect(result.stdout).toBe("passed on run 2\n");
  });

  it("throws once the last run fails", async () => {
    const command = await fakeCommand(2, TRANSIENT[0]);

    await expect(
      runOrThrow(command.args, {
        capture: true,
        retry: { attempts: 2, sleep: pauses() },
      })
    ).rejects.toThrow("failed (exit 1)");
    await expect(command.runs()).resolves.toBe(2);
  });

  it("throws at once on any other failure", async () => {
    const command = await fakeCommand(1, PERMANENT[0]);

    await expect(
      runOrThrow(command.args, {
        capture: true,
        retry: { attempts: 3, sleep: pauses() },
      })
    ).rejects.toThrow("failed (exit 1)");
    await expect(command.runs()).resolves.toBe(1);
  });
});
