import { test, expect } from "bun:test";
import { validName, max_name } from "./agent_rename";

test("names are one printable line", () => {
  expect(validName("refactor ⑂")).toBe(true);
  expect(validName(new Uint8Array([0xff]))).toBe(false);
  for (const name of ["", "two\nlines", "bell\x07", "\udfff", "x".repeat(max_name + 1)])
    expect(validName(name)).toBe(false);
});
