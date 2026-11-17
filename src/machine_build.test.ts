import { test, expect } from "bun:test";
import { version } from "./updates";
import { matches, parse, slot, type Build } from "./machine_build";
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
test("machine setup selects the invoking release in either direction", () => {
  const old = build({ version: "1.0.0" }),
    next = build({ version: "1.0.1", commit: b });
  expect(matches(next, old)).toBe(false);
  expect(matches(old, next)).toBe(false);
  expect(matches(next, next)).toBe(true);
  expect(() => matches(next, { ...next, commit: a })).toThrow("ConflictingReleaseBuilds");
});
test("branches and dirty builds compare source identity without Git ancestry", () => {
  const local = build({ commit: a + "-dirty", source_hash: "a".repeat(64) });
  expect(matches(local, { ...local, commit: b, target: "darwin-arm64" })).toBe(true);
  expect(matches(local, { ...local, source_hash: "b".repeat(64) })).toBe(false);
  expect(matches(local, build({ commit: b + "-dirty" }))).toBe(false);
  expect(matches(build({ build_id: "c".repeat(64) }), build({ build_id: "c".repeat(64) }))).toBe(true);
});
test("release identity takes precedence over identical source and binary hashes", () => {
  const old = build({ version: "1.0.0", source_hash: "c".repeat(64), build_id: "d".repeat(64) }),
    next = { ...old, version: "1.0.1" },
    development = { ...old, version: "0.1.0-dev" };
  for (const pair of [
    [old, next],
    [old, development],
    [next, development],
  ]) {
    expect(matches(pair[0], pair[1])).toBe(false);
    expect(matches(pair[1], pair[0])).toBe(false);
  }
  expect(matches(old, { ...old, target: "darwin-arm64", build_id: "e".repeat(64) })).toBe(true);
  expect(() => matches(old, { ...old, commit: b })).toThrow("ConflictingReleaseBuilds");
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
