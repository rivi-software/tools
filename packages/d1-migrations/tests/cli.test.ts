import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, USAGE } from "../src/run-cli.js";
import { loadWrangler, project } from "./helpers.js";

loadWrangler();

async function run(cwd: string, args: string[]) {
  const log: string[] = [];
  const error: string[] = [];
  const code = await runCli(args, {
    cwd,
    log: (line) => log.push(line),
    error: (line) => error.push(line),
  });
  return { code, log: log.join("\n"), error: error.join("\n") };
}

describe("d1-migrations bundle", () => {
  it("writes the module, then says when it is already up to date", async () => {
    const dir = project("drizzle");
    const args = [
      "bundle",
      "--dir",
      "drizzle",
      "--pattern",
      "drizzle/*/migration.sql",
      "--table",
      "schema_migrations",
      "--out",
      "src/generated/migrations.ts",
    ];
    expect(await run(dir, args)).toEqual({
      code: 0,
      log: "Bundled 2 migrations into src/generated/migrations.ts.",
      error: "",
    });
    const source = readFileSync(path.join(dir, "src", "generated", "migrations.ts"), "utf8");
    expect(source).toContain('export const table = "schema_migrations";');
    expect(source).toContain('name: "0001_posts/migration.sql"');
    expect((await run(dir, args)).log).toBe(
      "src/generated/migrations.ts already holds the 2 migrations.",
    );
  });

  it("needs --out", async () => {
    expect(await run(project("flat"), ["bundle"])).toEqual({ code: 2, log: "", error: USAGE });
  });

  it("fails on a migration it cannot split as Wrangler would apply it", async () => {
    const dir = project("flat");
    writeFileSync(path.join(dir, "migrations", "0004_open.sql"), "CREATE TABLE open (id INTEGER)");
    const result = await run(dir, ["bundle", "--out", "migrations.js"]);
    expect(result.code).toBe(1);
    expect(result.error).toContain(
      "Migration 0004_open.sql does not end with a complete statement",
    );
  });
});

describe("d1-migrations journal", () => {
  it("records the migrations, then passes --check", async () => {
    const dir = project("flat");
    expect(await run(dir, ["journal"])).toEqual({
      code: 0,
      log: `Recorded in ${path.join("migrations", "JOURNAL.json")}: 0001_init.sql, 0002_triggers.sql, 0003_seed.sql.`,
      error: "",
    });
    expect(await run(dir, ["journal", "--check"])).toEqual({
      code: 0,
      log: `Every migration matches ${path.join("migrations", "JOURNAL.json")}.`,
      error: "",
    });
    expect((await run(dir, ["journal"])).log).toBe(
      `${path.join("migrations", "JOURNAL.json")} already records every migration.`,
    );
  });

  it("fails --check on a migration that was never recorded, and says what to run", async () => {
    const dir = project("flat");
    const result = await run(dir, ["journal", "--check"]);
    expect(result.code).toBe(1);
    expect(result.error).toContain("0003_seed.sql is not recorded: run d1-migrations journal.");
    expect(result.error).toContain(
      "Run d1-migrations journal, and commit the journal with the migrations.",
    );
  });

  it("fails on an edited migration, with or without --check, and leaves the journal alone", async () => {
    const dir = project("flat");
    await run(dir, ["journal"]);
    writeFileSync(path.join(dir, "migrations", "0002_triggers.sql"), "-- gone\n");
    const check = await run(dir, ["journal", "--check"]);
    expect(check.code).toBe(1);
    expect(check.error).toContain("0002_triggers.sql was edited after it was recorded.");
    expect(check.error).toContain("put the change in a new migration");

    const update = await run(dir, ["journal"]);
    expect(update.code).toBe(1);
    expect(update.error).toContain("is unchanged. These recorded migrations changed:");
  });

  it("refuses an unknown option or command", async () => {
    const dir = project("flat");
    const unknown = await run(dir, ["journal", "--force"]);
    expect(unknown.code).toBe(2);
    expect(unknown.error).toContain("Unknown option '--force'");
    expect(await run(dir, ["apply"])).toEqual({ code: 2, log: "", error: USAGE });
    expect((await run(dir, ["journal", "--out", "x.js"])).code).toBe(2);
  });
});
