import { describe, expect, it } from "vitest";

import { parseMailAddress } from "../src/address.js";

describe(parseMailAddress, () => {
  it("reads an address alone, with a name, or with a quoted name", () => {
    expect(parseMailAddress(" jane@example.com ")).toStrictEqual({
      email: "jane@example.com",
      name: null,
    });
    expect(parseMailAddress("Jane <jane@example.com>")).toStrictEqual({
      email: "jane@example.com",
      name: "Jane",
    });
    expect(
      parseMailAddress('  "Doe, Jane"  < Jane@Example.com > ')
    ).toStrictEqual({
      email: "Jane@Example.com",
      name: "Doe, Jane",
    });
    expect(parseMailAddress('"" <jane@example.com>')).toStrictEqual({
      email: "jane@example.com",
      name: null,
    });
  });

  it("takes the address from the last angle brackets, so a name may hold its own", () => {
    expect(
      parseMailAddress('"Acme <Support>" <support@example.com>')
    ).toStrictEqual({
      email: "support@example.com",
      name: "Acme <Support>",
    });
    expect(parseMailAddress('"a<b" <c@example.com>')).toStrictEqual({
      email: "c@example.com",
      name: "a<b",
    });
    expect(parseMailAddress("Jane <a> <b>")).toStrictEqual({
      email: "b",
      name: "Jane <a>",
    });
  });

  it("reads anything else as an address alone", () => {
    for (const raw of [
      'Jane "J" Doe <jane@example.com>',
      "Jane <>",
      "Jane <jane@example.com",
    ]) {
      expect(parseMailAddress(raw)).toStrictEqual({ email: raw, name: null });
    }
  });

  it("reads a name of spaces in linear time", () => {
    // A regex that lets the name and the space before `<` take the same whitespace takes seconds on this.
    const spaces = " ".repeat(30_000);
    const started = performance.now();
    expect(parseMailAddress(`a${spaces}x`)).toStrictEqual({
      email: `a${spaces}x`,
      name: null,
    });
    expect(parseMailAddress(`"a${spaces}x" <jane@example.com>`)).toStrictEqual({
      email: "jane@example.com",
      name: `a${spaces}x`,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
