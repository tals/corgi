import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as instructions from "./instructions";
test("instructions sit in a file only this user reads, which goes with its folder", () => {
  const file = instructions.write("Remember corgis.");
  expect(readFileSync(file, "utf8")).toBe("Remember corgis.");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  instructions.remove(file);
  expect(existsSync(dirname(file))).toBe(false);
});
test("removing touches only a file instructions wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-other-")),
    file = join(dir, "instructions.md");
  writeFileSync(file, "keep");
  try {
    instructions.remove(file);
    instructions.remove("");
    expect(readFileSync(file, "utf8")).toBe("keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
