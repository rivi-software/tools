import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkJournal, hashMigration, updateJournal } from "../src/journal.js";
import { project } from "./helpers.js";

const journalOf = (dir: string) =>
  JSON.parse(
    readFileSync(path.join(dir, "migrations", "JOURNAL.json"), "utf-8")
  );

describe(hashMigration, () => {
  it("is the SHA-256 of the text, the same with CRLF line endings", () => {
    expect(hashMigration("a")).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
    expect(hashMigration("a\r\nb")).toBe(hashMigration("a\nb"));
    expect(hashMigration("a\nb")).not.toBe(hashMigration("a\n b"));
  });
});

describe(updateJournal, () => {
  it("records every migration, in order, in JOURNAL.json in the migrations directory", async () => {
    const dir = project("flat");
    const result = await updateJournal({ cwd: dir });
    expect(result).toStrictEqual({
      journal: path.join(dir, "migrations", "JOURNAL.json"),
      added: ["0001_init.sql", "0002_triggers.sql", "0003_seed.sql"],
      problems: [],
    });
    const journal = journalOf(dir);
    expect(journal.version).toBe(1);
    expect(
      journal.migrations.map((entry: { name: string }) => entry.name)
    ).toStrictEqual(result.added);
    expect(journal.migrations[0].sha256).toBe(
      hashMigration(
        readFileSync(path.join(dir, "migrations", "0001_init.sql"), "utf-8")
      )
    );
    expect(
      readFileSync(path.join(dir, "migrations", "JOURNAL.json"), "utf-8")
    ).toMatch(/\n$/u);
  });

  it("adds a new migration and keeps the entries it had", async () => {
    const dir = project("flat", {}, ["migrations/0001_init.sql"]);
    await updateJournal({ cwd: dir });
    const [before] = journalOf(dir).migrations;
    writeFileSync(
      path.join(dir, "migrations", "0002_more.sql"),
      "CREATE TABLE more (id INTEGER);\n"
    );
    const added = await updateJournal({ cwd: dir });
    expect(added.added).toStrictEqual(["0002_more.sql"]);
    expect(journalOf(dir).migrations).toStrictEqual([
      before,
      {
        name: "0002_more.sql",
        sha256: hashMigration("CREATE TABLE more (id INTEGER);\n"),
      },
    ]);
    const again = await updateJournal({ cwd: dir });
    expect(again.added).toStrictEqual([]);
  });

  it("refuses to change a recorded migration that was edited or deleted, and writes nothing", async () => {
    const dir = project("flat");
    await updateJournal({ cwd: dir });

    const before = readFileSync(
      path.join(dir, "migrations", "JOURNAL.json"),
      "utf-8"
    );

    writeFileSync(
      path.join(dir, "migrations", "0001_init.sql"),
      "CREATE TABLE changed (id INTEGER);\n"
    );
    rmSync(path.join(dir, "migrations", "0002_triggers.sql"));
    writeFileSync(
      path.join(dir, "migrations", "0004_new.sql"),
      "CREATE TABLE new (id INTEGER);\n"
    );
    await expect(updateJournal({ cwd: dir })).resolves.toMatchObject({
      added: [],
      problems: [
        { name: "0001_init.sql", kind: "edited" },
        { name: "0002_triggers.sql", kind: "deleted" },
      ],
    });
    expect(
      readFileSync(path.join(dir, "migrations", "JOURNAL.json"), "utf-8")
    ).toBe(before);
  });

  it("writes the journal it is given, for the migrations of migrations_pattern", async () => {
    const dir = project("drizzle");

    const { journal, added } = await updateJournal({
      cwd: dir,
      dir: "drizzle",
      pattern: "drizzle/*/migration.sql",
      journal: "drizzle/meta/d1-journal.json",
    });

    expect(journal).toBe(path.join(dir, "drizzle", "meta", "d1-journal.json"));
    expect(added).toStrictEqual([
      "0000_init/migration.sql",
      "0001_posts/migration.sql",
    ]);
  });
});

describe(checkJournal, () => {
  it("passes when every migration matches, CRLF line endings included", async () => {
    const dir = project("flat");
    await updateJournal({ cwd: dir });
    const file = path.join(dir, "migrations", "0001_init.sql");
    writeFileSync(file, readFileSync(file, "utf-8").replaceAll("\n", "\r\n"));
    const check = await checkJournal({ cwd: dir });
    expect(check.problems).toStrictEqual([]);
  });

  it("names each migration that was edited, deleted or never recorded", async () => {
    const dir = project("flat");
    await updateJournal({ cwd: dir });
    writeFileSync(
      path.join(dir, "migrations", "0003_seed.sql"),
      "-- emptied\n"
    );
    rmSync(path.join(dir, "migrations", "0001_init.sql"));
    writeFileSync(
      path.join(dir, "migrations", "0004_new.sql"),
      "CREATE TABLE new (id INTEGER);\n"
    );
    const check = await checkJournal({ cwd: dir });
    expect(check.problems).toStrictEqual([
      { name: "0001_init.sql", kind: "deleted" },
      { name: "0003_seed.sql", kind: "edited" },
      { name: "0004_new.sql", kind: "unrecorded" },
    ]);
  });

  it("finds every migration unrecorded when there is no journal", async () => {
    const dir = project("order");
    const check = await checkJournal({ cwd: dir });
    expect(check.problems.map((problem) => problem.kind)).toStrictEqual(
      Array.from({ length: 5 }, () => "unrecorded")
    );
  });

  it("refuses a file that is not a journal", async () => {
    const dir = project("flat");
    writeFileSync(
      path.join(dir, "migrations", "JOURNAL.json"),
      '{ "migrations": [{ "name": 1 }] }'
    );
    await expect(checkJournal({ cwd: dir })).rejects.toThrow(
      "is not a migrations journal"
    );
    writeFileSync(path.join(dir, "migrations", "JOURNAL.json"), "{");
    await expect(checkJournal({ cwd: dir })).rejects.toThrow(
      "is not valid JSON"
    );
  });
});
