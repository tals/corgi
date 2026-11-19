import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { text } from "./licenses";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("names every dependency built into the binary", () => {
  const npm = Object.keys(JSON.parse(read("../package.json")).dependencies);
  const zig = [...read("../native/build.zig.zon").matchAll(/\.(\w+) = \.\{\s*\.url/g)].map(match => match[1]);
  expect(zig).toContain("ghostty");
  for (const name of [...npm.map(name => name.split("/").at(-1)!), ...zig])
    expect(text.toLowerCase()).toContain(name.toLowerCase());
});
