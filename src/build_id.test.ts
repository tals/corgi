import { test, expect } from "bun:test";
import { executablePath } from "./build_id";
test("compiled handoff candidates ignore the source daemon's executable override", () => {
  expect(executablePath("/$bunfs/root/corgi", "/new/corgi", "/source/corgi", "/old/corgi")).toBe("/new/corgi");
});
test("source wrappers retain their explicit executable override", () => {
  expect(executablePath("/source/src/main.ts", "/bin/bun", "/source/corgi", "/wrapper/corgi")).toBe("/wrapper/corgi");
  expect(executablePath("/source/src/main.ts", "/bin/bun", "/source/corgi")).toBe("/source/corgi");
});
