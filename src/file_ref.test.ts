import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as fileRef from "./file_ref";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("reads a found path's line and column", () => {
  expect(fileRef.parse("src/a.ts", true)).toEqual({ path: "src/a.ts", line: null, column: null });
  expect(fileRef.parse("src/a.ts:12", true)).toEqual({ path: "src/a.ts", line: 12, column: null });
  expect(fileRef.parse("src/a.ts:12:3", true)).toEqual({ path: "src/a.ts", line: 12, column: 3 });
  expect(fileRef.parse("~/x.py:4", true)).toEqual({ path: "~/x.py", line: 4, column: null });
});

test("reads file links on this machine, with lines after the path or in the fragment", () => {
  expect(fileRef.parse("file:///tmp/a%20b.ts", false)).toEqual({ path: "/tmp/a b.ts", line: null, column: null });
  expect(fileRef.parse("file:///tmp/a.ts:7:2", false)).toEqual({ path: "/tmp/a.ts", line: 7, column: 2 });
  expect(fileRef.parse("file:///tmp/a.ts#L9", false)).toEqual({ path: "/tmp/a.ts", line: 9, column: null });
  // Lines count from 1: a line 0 names none.
  expect(fileRef.parse("file:///tmp/a.log#L0", false)).toEqual({ path: "/tmp/a.log", line: null, column: null });
  expect(fileRef.parse("file:///tmp/a.log:0:0", false)).toEqual({ path: "/tmp/a.log", line: null, column: null });
  expect(fileRef.parse(`file://${hostname()}/tmp/a.ts`, false)?.path).toBe("/tmp/a.ts");
  expect(fileRef.parse("file://elsewhere.example/tmp/a.ts", false)).toBeNull();
  expect(fileRef.parse("https://example.com/a.ts", false)).toBeNull();
  // Another computer's daemon checks a link names its file.
  expect(fileRef.parse("file://elsewhere.example/tmp/a.ts", false, null)?.path).toBe("/tmp/a.ts");
});

test("resolves from the pane's folder and home, and tries a diff's a/ and b/ off", () => {
  expect(fileRef.absolute("src/a.ts", "/work", "/home/me")).toBe("/work/src/a.ts");
  expect(fileRef.absolute("../a.ts", "/work/sub", "/home/me")).toBe("/work/a.ts");
  expect(fileRef.absolute("~/notes.md", "/work", "/home/me")).toBe("/home/me/notes.md");
  expect(fileRef.absolute("/etc/hosts", "/work", "/home/me")).toBe("/etc/hosts");
  expect(fileRef.candidates("b/src/a.ts", "/work", "/home/me")).toEqual(["/work/b/src/a.ts", "/work/src/a.ts"]);
});

test("checks names in the background and only files count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-ref-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "x");
  let woke = 0;
  const resolver = new fileRef.Resolver(() => woke++, fileAccess.local("/nowhere"));
  const ask = (path: string) => resolver.get({ path, line: null, column: null }, dir, 0);
  expect(ask("src/a.ts").kind).toBe("pending");
  expect(ask("src").kind).toBe("pending");
  expect(ask("nope.ts").kind).toBe("pending");
  await Promise.all(resolver.checks);
  expect(ask("src/a.ts")).toEqual({ kind: "file", path: join(dir, "src", "a.ts"), size: 1 });
  expect(ask("src").kind).toBe("missing");
  expect(ask("nope.ts").kind).toBe("missing");
  expect(woke).toBe(3);
  expect(resolver.get({ path: "a/src/a.ts", line: 3, column: null }, dir, 0).kind).toBe("pending");
  await Promise.all(resolver.checks);
  expect(resolver.get({ path: "a/src/a.ts", line: 3, column: null }, dir, 0).kind).toBe("file");
});
