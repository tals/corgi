import { test, expect } from "bun:test";
import { version } from "./updates";
import { compare, parse, slot, type Build } from "./machine_build";
const a = "a".repeat(40),
  b = "b".repeat(40);
const build = (values: Partial<Build> = {}): Build => ({
  version: "0.1.0-dev",
  commit: a,
  target: "linux-x64",
  executable: "/bin/corgi",
  build_id: "",
  source_hash: "",
  socket: "/tmp/corgi.sock",
  update_abi: "1",
  ...values,
});
test("machine setup upgrades the older release in either direction", async () => {
  const old = build({ version: "1.0.0" }),
    next = build({ version: "1.0.1", commit: b });
  expect(await compare(next, old, async () => false)).toBeGreaterThan(0);
  expect(await compare(old, next, async () => false)).toBeLessThan(0);
  await expect(compare(next, { ...next, commit: a }, async () => false)).rejects.toThrow("ConflictingReleaseBuilds");
});
test("development builds need identity or proved ancestry", async () => {
  const older = build(),
    newer = build({ commit: b });
  expect(await compare(newer, older, async (x, y) => x === a && y === b)).toBe(1);
  expect(await compare(older, newer, async (x, y) => x === a && y === b)).toBe(-1);
  await expect(compare(newer, older, async () => false)).rejects.toThrow("UnorderedDevelopmentBuilds");
  await expect(
    compare({ ...older, commit: a + "-dirty" }, { ...newer, commit: b + "-dirty" }, async () => true),
  ).rejects.toThrow("UnorderedDevelopmentBuilds");
});
test("dirty cross-platform copies use source identity and cannot overwrite divergent work", async () => {
  const local = build({ commit: a + "-dirty", source_hash: "a".repeat(64) });
  expect(await compare(local, { ...local, target: "darwin-arm64" }, async () => false)).toBe(0);
  await expect(compare(local, { ...local, source_hash: "b".repeat(64) }, async () => false)).rejects.toThrow(
    "UnorderedDevelopmentBuilds",
  );
});
test("remote metadata accepts old additive fields and rejects unsafe paths and hashes", () => {
  expect(parse({ version: "1.0.0", commit: a, update_abi: "1" }, "linux-x64", "/bin/corgi").executable).toBe(
    "/bin/corgi",
  );
  expect(() => parse(build({ executable: "relative" }), "linux-x64", "/bin/corgi")).toThrow("InvalidRemotePath");
  expect(() => parse(build({ build_id: "bad" }), "linux-x64", "/bin/corgi")).toThrow("InvalidRemoteBuild");
});

test("development installation slots remain compatible with the existing updater", () => {
  const id = slot(build({ build_id: "f".repeat(64) }));
  expect(version(id)).toEqual([0, 0, 281474976710655]);
  expect(slot(build({ version: "1.2.3" }))).toBe("1.2.3");
});
