import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareMigrationPaths, listMigrationFiles } from "../src/files.js";
import { FIXTURES } from "./helpers.js";

const sorted = (names: string[]) => names.toSorted(compareMigrationPaths);

describe(compareMigrationPaths, () => {
  it("orders by the leading number, not the text", () => {
    expect(sorted(["10_ten.sql", "2_two.sql", "1_one.sql"])).toStrictEqual([
      "1_one.sql",
      "2_two.sql",
      "10_ten.sql",
    ]);
  });

  it("breaks a tie on the number by the text", () => {
    expect(sorted(["10_ten.sql", "010_ten_b.sql"])).toStrictEqual([
      "010_ten_b.sql",
      "10_ten.sql",
    ]);
  });

  it("puts a name without a number after the numbered ones, by its text", () => {
    expect(sorted(["init.sql", "base.sql", "3_three.sql"])).toStrictEqual([
      "3_three.sql",
      "base.sql",
      "init.sql",
    ]);
  });

  it("orders nested paths segment by segment, the number in the directory first", () => {
    expect(
      sorted([
        "0010_b/migration.sql",
        "0002_a/migration.sql",
        "0002_a/extra.sql",
        "0002_a",
      ])
    ).toStrictEqual([
      "0002_a",
      "0002_a/extra.sql",
      "0002_a/migration.sql",
      "0010_b/migration.sql",
    ]);
  });
});

describe(listMigrationFiles, () => {
  it("lists the *.sql files in Wrangler's order, leaving out dotfiles and other files", () => {
    const { dir, files } = listMigrationFiles({
      cwd: path.join(FIXTURES, "order"),
    });

    expect(dir).toBe(path.join(FIXTURES, "order", "migrations"));
    expect(files.map((file) => file.name)).toStrictEqual([
      "1_one.sql",
      "2_two.sql",
      "010_ten_b.sql",
      "10_ten.sql",
      "init.sql",
    ]);
    expect(files[0]?.path).toBe(path.join(dir, "1_one.sql"));
  });

  it("follows migrations_pattern into subdirectories, naming each file by its path", () => {
    const { files } = listMigrationFiles({
      cwd: path.join(FIXTURES, "drizzle"),
      dir: "./drizzle/",
      pattern: "drizzle/*/migration.sql",
    });

    expect(files.map((file) => file.name)).toStrictEqual([
      "0000_init/migration.sql",
      "0001_posts/migration.sql",
    ]);
    expect(files[1]?.path).toBe(
      path.join(FIXTURES, "drizzle", "drizzle", "0001_posts", "migration.sql")
    );
  });

  it("refuses a pattern outside the migrations directory, as Wrangler does", () => {
    expect(() =>
      listMigrationFiles({
        cwd: path.join(FIXTURES, "drizzle"),
        pattern: "drizzle/*/migration.sql",
      })
    ).toThrow(
      'The migrations pattern "drizzle/*/migration.sql" must start with "migrations/"'
    );
  });

  it("fails when the migrations directory is missing", () => {
    expect(() => listMigrationFiles({ cwd: FIXTURES })).toThrow(
      `No migrations directory at ${path.join(FIXTURES, "migrations")}`
    );
  });
});
