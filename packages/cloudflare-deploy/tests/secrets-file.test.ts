import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fileExists } from "../src/index.js";
import { runCommand } from "../src/process.js";
import { secretsFromEnv, withSecretsFile } from "../src/secrets-file.js";

vi.mock(import("../src/process.js"), async (original) => ({
  ...(await original()),
  runCommand: vi.fn(),
}));

const env = {
  WORKER_SECRET_API_KEY: "key",
  WORKER_SECRET_SESSION_SECRET: 's3cret with spaces and "quotes"',
  WORKER_SECRET: "not a secret: no name after the prefix",
  WORKER_SECRET_: "not a secret either",
  WORKER_SECRETS_OTHER: "another prefix",
  UNSET: undefined,
  CLOUDFLARE_API_TOKEN: "token",
};

afterEach(() => {
  vi.mocked(runCommand).mockReset();
  vi.restoreAllMocks();
});

describe("secretsFromEnv", () => {
  test("turns each <PREFIX>_<NAME> into the secret <NAME>, and nothing else", () => {
    const secrets = { API_KEY: "key", SESSION_SECRET: env.WORKER_SECRET_SESSION_SECRET };
    expect(secretsFromEnv("WORKER_SECRET", env)).toEqual(secrets);
    expect(secretsFromEnv("WORKER_SECRET_", env)).toEqual(secrets);
    expect(secretsFromEnv("NONE", env)).toEqual({});
  });

  test("refuses empty variables, as GitHub Actions passes a secret that does not exist", () => {
    expect(() =>
      secretsFromEnv("WORKER_SECRET", { WORKER_SECRET_B: "", WORKER_SECRET_A: "" }),
    ).toThrow("Empty secret variables: WORKER_SECRET_A, WORKER_SECRET_B.");
  });
});

describe("withSecretsFile", () => {
  test("hands run a JSON file only its owner can read, deletes it, and returns run's result", async () => {
    let seen = "";
    const result = await withSecretsFile({ prefix: "WORKER_SECRET", env }, async (path) => {
      seen = path;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        API_KEY: "key",
        SESSION_SECRET: env.WORKER_SECRET_SESSION_SECRET,
      });
      return "deployed";
    });
    expect(result).toBe("deployed");
    expect(await fileExists(seen)).toBe(false);
  });

  test("deletes the file when run throws, and passes the error on", async () => {
    let seen = "";
    const failure = new Error("wrangler deploy failed (exit 1)");
    await expect(
      withSecretsFile({ prefix: "WORKER_SECRET", env }, (path) => {
        seen = path;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(seen).not.toBe("");
    expect(await fileExists(seen)).toBe(false);
  });

  test("writes no file and runs nothing when a variable is empty", async () => {
    const run = vi.fn();
    await expect(
      withSecretsFile({ prefix: "WORKER_SECRET", env: { WORKER_SECRET_A: "" } }, run),
    ).rejects.toThrow("Empty secret variables");
    expect(run).not.toHaveBeenCalled();
  });

  test("warns about secrets on the Worker that no variable sets, after run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { name: "API_KEY", type: "secret_text" },
        { name: "OLD_TOKEN", type: "secret_text" },
        { name: "LEGACY", type: "secret_text" },
      ]),
      stderr: "",
    });
    const run = vi.fn(() => {
      expect(runCommand).not.toHaveBeenCalled();
    });
    await withSecretsFile(
      { prefix: "WORKER_SECRET", env, listSecrets: ["--config", "dist/server/wrangler.json"] },
      run,
    );
    expect(run).toHaveBeenCalledOnce();
    const [args, options] = vi.mocked(runCommand).mock.calls[0];
    expect(args.slice(1)).toEqual(["secret", "list", "--config", "dist/server/wrangler.json"]);
    expect(options).toEqual({ capture: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      "Secrets on the Worker that no WORKER_SECRET_* variable sets: LEGACY, OLD_TOKEN.",
    );
  });

  test("stays quiet when the Worker has no other secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: `⛅️ wrangler\n${JSON.stringify([{ name: "API_KEY", type: "secret_text" }])}`,
      stderr: "",
    });
    await withSecretsFile({ prefix: "WORKER_SECRET", env, listSecrets: [] }, () => {});
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns, without failing the deploy, when the list cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runCommand).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Not logged in" });
    await expect(
      withSecretsFile({ prefix: "WORKER_SECRET", env, listSecrets: [] }, () => "deployed"),
    ).resolves.toBe("deployed");
    expect(warn.mock.calls[0][0]).toBe(
      "Could not compare the Worker's secrets with WORKER_SECRET_*: wrangler secret list failed (exit 1)\nNot logged in",
    );

    vi.mocked(runCommand).mockResolvedValueOnce({ code: 0, stdout: "no json", stderr: "" });
    await withSecretsFile({ prefix: "WORKER_SECRET", env, listSecrets: [] }, () => {});
    expect(warn.mock.calls[1][0]).toContain("printed no list of secrets");
  });

  test("never lists secrets without listSecrets", async () => {
    await withSecretsFile({ prefix: "WORKER_SECRET", env }, () => {});
    expect(runCommand).not.toHaveBeenCalled();
  });
});
