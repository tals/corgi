import { test, expect } from "bun:test";
import { version } from "./updates";
import * as machine_build from "./machine_build";
const a = "a".repeat(40),
  b = "b".repeat(40);
const build = (values: Partial<machine_build.Build> = {}): machine_build.Build => ({
  version: "0.1.0-dev",
  commit: a,
  target: "linux-x64",
  executable: "/bin/corgi",
  build_id: "",
  source_hash: "",
  socket: "/tmp/corgi.sock",
  update_abi: "1",
  delta_transfer: "rsync-zstd-v1",
  ...values,
});
test("machine setup selects the invoking release in either direction", () => {
  const old = build({ version: "1.0.0" }),
    next = build({ version: "1.0.1", commit: b });
  expect(machine_build.matches(next, old)).toBe(false);
  expect(machine_build.matches(old, next)).toBe(false);
  expect(machine_build.matches(next, next)).toBe(true);
  expect(() => machine_build.matches(next, { ...next, commit: a })).toThrow("ConflictingReleaseBuilds");
});
test("branches and dirty builds compare source identity without Git ancestry", () => {
  const local = build({ commit: a + "-dirty", source_hash: "a".repeat(64) });
  expect(machine_build.matches(local, { ...local, commit: b, target: "darwin-arm64" })).toBe(true);
  expect(machine_build.matches(local, { ...local, source_hash: "b".repeat(64) })).toBe(false);
  expect(machine_build.matches(local, build({ commit: b + "-dirty" }))).toBe(false);
  expect(machine_build.matches(build({ build_id: "c".repeat(64) }), build({ build_id: "c".repeat(64) }))).toBe(true);
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
    expect(machine_build.matches(pair[0], pair[1])).toBe(false);
    expect(machine_build.matches(pair[1], pair[0])).toBe(false);
  }
  expect(machine_build.matches(old, { ...old, target: "darwin-arm64", build_id: "e".repeat(64) })).toBe(true);
  expect(() => machine_build.matches(old, { ...old, commit: b })).toThrow("ConflictingReleaseBuilds");
});
test("remote metadata accepts old additive fields and rejects unsafe paths and hashes", () => {
  expect(
    machine_build.parse({ version: "1.0.0", commit: a, update_abi: "1" }, "linux-x64", "/bin/corgi").delta_transfer,
  ).toBe("");
  expect(
    machine_build.parse({ ...build(), delta_transfer: "future-protocol" }, "linux-x64", "/bin/corgi").delta_transfer,
  ).toBe("");
  expect(machine_build.parse(build(), "linux-x64", "/bin/corgi").delta_transfer).toBe("rsync-zstd-v1");
  expect(
    machine_build.parse({ version: "1.0.0", commit: a, update_abi: "1" }, "linux-x64", "/bin/corgi").executable,
  ).toBe("/bin/corgi");
  expect(() => machine_build.parse(build({ executable: "relative" }), "linux-x64", "/bin/corgi")).toThrow(
    "InvalidRemotePath",
  );
  expect(() => machine_build.parse(build({ build_id: "bad" }), "linux-x64", "/bin/corgi")).toThrow(
    "InvalidRemoteBuild",
  );
});

test("development installation slots remain compatible with the existing updater", () => {
  const id = machine_build.slot(build({ build_id: "f".repeat(64) }));
  expect(version(id)).toEqual([0, 0, 281474976710655]);
  expect(machine_build.slot(build({ version: "1.2.3" }))).toBe("1.2.3");
});

test("dev builds compare source identity across targets and leave missing revisions unknown", () => {
  const a = { version: "0.1.0-dev", commit: "abc1234-dirty", source_hash: "a".repeat(64) };
  expect(machine_build.compare(a, { ...a })).toBe("match");
  expect(machine_build.compare(a, { ...a, commit: "1234abc" })).toBe("match");
  expect(machine_build.compare(a, { ...a, source_hash: "b".repeat(64) })).toBe("mismatch");
  expect(machine_build.compare(a, { ...a, source_hash: "" })).toBe("unknown");
  const release = { ...a, version: "1.0.0" };
  expect(machine_build.compare(release, { ...release, commit: "1234abc" })).toBe("mismatch");
});
