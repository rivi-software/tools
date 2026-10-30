import { describe, expect, it } from "vitest";
import { parseMailAddress } from "../src/address.js";

describe("parseMailAddress", () => {
  it("reads an address alone, with a name, or with a quoted name", () => {
    expect(parseMailAddress(" jane@example.com ")).toEqual({
      email: "jane@example.com",
      name: null,
    });
    expect(parseMailAddress("Jane <jane@example.com>")).toEqual({
      email: "jane@example.com",
      name: "Jane",
    });
    expect(parseMailAddress('  "Doe, Jane"  < Jane@Example.com > ')).toEqual({
      email: "Jane@Example.com",
      name: "Doe, Jane",
    });
    expect(parseMailAddress('"" <jane@example.com>')).toEqual({
      email: "jane@example.com",
      name: null,
    });
  });

  it("reads anything else as an address alone", () => {
    for (const raw of [
      'Jane "J" Doe <jane@example.com>',
      "Jane <>",
      "Jane <a> <b>",
      "Jane <jane@example.com",
    ])
      expect(parseMailAddress(raw)).toEqual({ email: raw, name: null });
  });

  it("reads a name of spaces in linear time", () => {
    // A regex that lets the name and the space before `<` take the same whitespace takes seconds on this.
    const spaces = " ".repeat(30_000);
    const started = performance.now();
    expect(parseMailAddress(`a${spaces}x`)).toEqual({ email: `a${spaces}x`, name: null });
    expect(parseMailAddress(`"a${spaces}x" <jane@example.com>`)).toEqual({
      email: "jane@example.com",
      name: `a${spaces}x`,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
