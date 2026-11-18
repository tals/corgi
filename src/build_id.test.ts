import { test, expect } from "bun:test";
import { executablePath } from "./build_id";
test("a compiled binary runs as itself; a source checkout keeps its wrapper's executable override", () => {
  expect(executablePath("/$bunfs/root/corgi", "/new/corgi", "/source/corgi", "/old/corgi")).toBe("/new/corgi");
  expect(executablePath("/source/src/main.ts", "/bin/bun", "/source/corgi", "/wrapper/corgi")).toBe("/wrapper/corgi");
  expect(executablePath("/source/src/main.ts", "/bin/bun", "/source/corgi")).toBe("/source/corgi");
});
