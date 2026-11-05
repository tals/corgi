import { expect, test } from "bun:test";
import * as reference from "./reference";

test("references separate a revision or range from its repository", () => {
  expect(reference.parse("abc1234@../repo")).toEqual({
    folder: "../repo",
    source: { kind: "commit", hash: "abc1234" },
  });
  expect(reference.parse("main..feature/fix@/work/my repo")).toEqual({
    folder: "/work/my repo",
    source: { kind: "range", from: "main", to: "feature/fix" },
  });
  expect(reference.parse("HEAD~2..HEAD@~/repo@home")?.folder).toBe("~/repo@home");
  for (const value of [
    "HEAD",
    "HEAD@",
    "@repo",
    "a...b@repo",
    "..b@repo",
    "a..@repo",
    "a..b..c@repo",
    "--stat@repo",
    "HEAD@repo\nother",
    "https://host/user@repo",
  ])
    expect(reference.parse(value)).toBeNull();
});

test("code spans recognize hashes and ranges without turning emails into reviews", () => {
  for (const value of ["ABC1234@/repo", "HEAD^@.", "main..topic@../repo"]) expect(reference.code(value)).not.toBeNull();
  for (const value of ["user@example.com", "@workspace", "name@1.0.0"]) expect(reference.code(value)).toBeNull();
  expect(reference.code("7165f82b")).toEqual({
    folder: ".",
    source: { kind: "commit", hash: "7165f82b" },
    implicit: true,
  });
  expect(reference.code("7165f82b..ee11c852")).toEqual({
    folder: ".",
    source: { kind: "range", from: "7165f82b", to: "ee11c852" },
    implicit: true,
  });
  for (const value of ["main", "HEAD", "123abc", "7165f82b is recent", "7165f82b...ee11c852"])
    expect(reference.code(value)).toBeNull();
});

test("prose considers all standalone hashes, including digits or letters alone", () => {
  const text = "Compare (7165f82b) to ee11c852. Range: 7165f82b..ee11c852!";
  expect(reference.mentions(text).map(m => text.slice(m.start, m.end))).toEqual([
    "7165f82b",
    "ee11c852",
    "7165f82b..ee11c852",
  ]);
  expect(reference.mentions("12345678 decafbad").map(m => m.ref.source)).toEqual([
    { kind: "commit", hash: "12345678" },
    { kind: "commit", hash: "decafbad" },
  ]);
  for (const value of [
    "abc1234.ts",
    "foo-abc1234",
    "foo_abc1234",
    "abc1234_more",
    "src/abc1234",
    "abc1234/path",
    "abc1234@host",
    "commit-7165f82b",
    "a".repeat(65),
    "7165f82b...ee11c852",
  ])
    expect(reference.mentions(value)).toEqual([]);
});

test("recognition batches duplicate candidates and caches hits and misses between redraws", async () => {
  const calls: [string, string[]][] = [];
  let exists = false;
  const full = "12345678" + "a".repeat(32);
  const cache = new reference.Recognizer(async (cwd, hashes) => {
    calls.push([cwd, hashes]);
    return new Map(hashes.flatMap(hash => (cwd === "/repo" && (hash === "12345678" || exists) ? [[hash, full]] : [])));
  });
  const commit = { kind: "commit", hash: "12345678" } as const;
  const missing = { kind: "commit", hash: "00000000" } as const;
  const range = { kind: "range", from: "12345678", to: "00000000" } as const;
  expect(cache.resolve("/repo", commit, true)).toBeNull();
  cache.resolve("/repo", commit, true);
  cache.resolve("/repo", range, true);
  await cache.settled();
  expect(calls).toEqual([["/repo", ["12345678", "00000000"]]]);
  expect(cache.resolve("/repo", commit)).toEqual({ kind: "commit", hash: full });
  expect(cache.resolve("/repo", range)).toBeNull();
  for (let i = 0; i < 20; i++) {
    cache.resolve("/repo", commit, true);
    cache.resolve("/repo", missing, true);
  }
  await cache.settled();
  expect(calls).toHaveLength(1);
  cache.resolve("/other", commit, true);
  await cache.settled();
  expect(cache.resolve("/other", commit)).toBeNull();
  exists = true;
  cache.forgetMissing();
  cache.resolve("/repo", range, true);
  await cache.settled();
  expect(cache.resolve("/repo", range)).toEqual({ kind: "range", from: full, to: full });
  expect(calls.at(-1)).toEqual(["/repo", ["00000000"]]);
});

test("candidates arriving during a lookup are read afterwards, and failed reads stay quiet", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => {
    release = done;
  });
  const calls: string[][] = [];
  const cache = new reference.Recognizer(async (_cwd, hashes) => {
    calls.push(hashes);
    if (calls.length === 1) await gate;
    throw Error("not a repository");
  });
  const first = { kind: "commit", hash: "12345678" } as const;
  const second = { kind: "commit", hash: "deadbeef" } as const;
  cache.resolve("/repo", first, true);
  await Promise.resolve();
  cache.resolve("/repo", first, true);
  cache.resolve("/repo", second, true);
  release();
  await cache.settled();
  expect(calls).toEqual([["12345678"], ["deadbeef"]]);
  expect(cache.resolve("/repo", first)).toBeNull();
  cache.resolve("/repo", first, true);
  await cache.settled();
  expect(calls).toHaveLength(2);
});
