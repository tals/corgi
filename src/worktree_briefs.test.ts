import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Briefs, decide, fingerprint, trimmed, validLabel, type Config } from "./worktree_briefs";
import { Tracker } from "./trackers/worktrees";
import * as worktrees from "./worktrees";
import type { Request } from "./inference/harness";
import type { Runtime } from "./runtime";

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (status !== 0) throw Error(err);
  return out;
}
/** A repository with a worktree one commit ahead of main, and its tracker snapshot. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corgi-briefs-")));
  const repo = join(root, "project"),
    topic = join(root, "project-search");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  for (const [k, v] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ])
    await git(repo, "config", k, v);
  await writeFile(join(repo, "base"), "base\n");
  await git(repo, "add", "base");
  await git(repo, "commit", "-m", "base");
  await git(repo, "worktree", "add", "-b", "search", topic);
  await writeFile(join(topic, "search.ts"), "export const search = (q: string) => q;\n");
  await git(topic, "add", "search.ts");
  await git(topic, "commit", "-m", "search: match queries");
  const tracker = new Tracker();
  const ws = { id: 1, worktrees: (await tracker.refresh(repo, true)) as worktrees.Snapshot };
  const runtime = { workspaces: { items: [ws], get: (id: number) => (id === 1 ? ws : null) } } as unknown as Runtime;
  const config: Config = { enabled: true, provider: "claude", model: "", file: join(root, "settings.json") };
  return {
    root,
    repo,
    topic,
    ws,
    runtime,
    config,
    async rescan() {
      ws.worktrees = (await tracker.refresh(repo, true, Date.now() + 60000)) as worktrees.Snapshot;
    },
    close: async () => {
      tracker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
/** A model that answers each request with the next reply. */
function model(replies: string[]) {
  const asked: Request[] = [];
  return {
    asked,
    infer: async (_pool: unknown, request: Request) => {
      asked.push(request);
      return { text: replies.shift() ?? "{}", fresh: true };
    },
  };
}
const settle = async (briefs: Briefs, f: Awaited<ReturnType<typeof fixture>>, now: number) => {
  for (let i = 0; i < 200 && briefs.view(f.ws.worktrees).some(b => b.phase === "writing"); i++) {
    await Bun.sleep(10);
    briefs.tick(f.runtime, new Set([1]), f.config, now);
  }
};

test("labels keep a few words, and a kept label stays as it was", () => {
  expect(validLabel(' "Search queries." ')).toBe("Search queries");
  expect(validLabel("one two three four five six seven eight nine")).toBeNull();
  expect(validLabel(null)).toBeNull();
  expect(decide('{"action":"keep","label":null}', "Search queries")).toBe("Search queries");
  expect(decide('{"action":"replace","label":"Fuzzy search"}', "Search queries")).toBe("Fuzzy search");
  expect(decide("not json", "Search queries")).toBeNull();
});

test("a trimmed diff shows small files whole and shares the rest", () => {
  const file = (path: string, lines: number) => ({
    path,
    added: lines,
    removed: 0,
    body: Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n"),
    untracked: false,
  });
  const text = trimmed([file("src/small.ts", 3), file("src/big.ts", 2000), file("src/big.test.ts", 2000)], 4096);
  expect(text).toContain("--- src/small.ts\n+line 0\n+line 1\n+line 2");
  expect(text).toContain("[… 2000 changed lines in all]");
  expect(Buffer.byteLength(text)).toBeLessThan(4096 + 400);
});

test("opening the overview writes a brief once; later changes wait for r", async () => {
  const f = await fixture();
  const ai = model(['{"action":"new","label":"Search queries"}', '{"action":"replace","label":"Search and filters"}']);
  const briefs = new Briefs(undefined, ai.infer);
  try {
    const opened = 1000;
    briefs.tick(f.runtime, new Set([1]), f.config, opened);
    expect(briefs.view(f.ws.worktrees)).toEqual([{ path: f.topic, label: null, phase: "writing" }]);
    await settle(briefs, f, opened + 10);
    expect(briefs.view(f.ws.worktrees)).toEqual([{ path: f.topic, label: "Search queries", phase: "ready" }]);
    expect(ai.asked[0].content).toContain("- search: match queries");
    expect(ai.asked[0].conversation).toBe(`worktree:${f.topic}`);
    // The worktree changes while the overview stays open: no new request.
    await writeFile(join(f.topic, "filters.ts"), "export const filters = [];\n");
    await f.rescan();
    const later = opened + 60000;
    briefs.tick(f.runtime, new Set([1]), f.config, later);
    expect(briefs.view(f.ws.worktrees)[0]).toMatchObject({ label: "Search queries", phase: "ready" });
    expect(ai.asked).toHaveLength(1);
    // r amends in the same conversation, with the fresh content to fall back on.
    briefs.refresh(f.runtime, 1);
    await settle(briefs, f, later);
    expect(ai.asked).toHaveLength(2);
    expect(ai.asked[1].conversation).toBe(`worktree:${f.topic}`);
    expect(ai.asked[1].content).toContain("The worktree has changed since your label.");
    expect(ai.asked[1].content).toContain("filters.ts  +1 −0  (new, untracked)");
    expect(ai.asked[1].fresh_content).toStartWith("Previous label: Search queries\n");
    expect(briefs.view(f.ws.worktrees)[0]).toMatchObject({ label: "Search and filters", phase: "ready" });
    // Saved beside settings.json, and read back by the next daemon.
    const saved = JSON.parse(await readFile(join(f.root, "worktree-briefs.json"), "utf8"));
    expect(saved.briefs[f.topic].label).toBe("Search and filters");
    const next = new Briefs(undefined, model([]).infer);
    next.tick(f.runtime, new Set(), f.config, later);
    expect(next.view(f.ws.worktrees)[0]).toMatchObject({ label: "Search and filters", phase: "ready" });
    next.close();
  } finally {
    briefs.close();
    await f.close();
  }
}, 20000);

test("with briefs off nothing is asked and nothing shows; a failed try fades and is retried on refresh", async () => {
  const f = await fixture();
  const ai = model(["not json", '{"action":"new","label":"Search queries"}']);
  const briefs = new Briefs(undefined, ai.infer);
  try {
    briefs.tick(f.runtime, new Set([1]), { ...f.config, enabled: false }, 1000);
    expect(briefs.view(f.ws.worktrees)).toEqual([]);
    expect(ai.asked).toHaveLength(0);
    // Off and on again: the next opening asks.
    briefs.tick(f.runtime, new Set(), f.config, 2000);
    briefs.tick(f.runtime, new Set([1]), f.config, 3000);
    await settle(briefs, f, 3010);
    expect(briefs.view(f.ws.worktrees)[0]).toMatchObject({ label: null, phase: "failed" });
    // The same opening doesn't ask again.
    briefs.tick(f.runtime, new Set([1]), f.config, 3500);
    expect(ai.asked).toHaveLength(1);
    briefs.refresh(f.runtime, 1);
    await settle(briefs, f, 3600);
    expect(briefs.view(f.ws.worktrees)[0]).toMatchObject({ label: "Search queries", phase: "ready" });
  } finally {
    briefs.close();
    await f.close();
  }
}, 20000);

test("a fingerprint follows what the overview shows of a checkout", () => {
  const checkout = {
    head: "abc",
    comparison: { ahead: 1n, behind: 0n },
    changes: { total: 2, staged: 0, modified: 2, untracked: 0, conflicted: 0, added: 5, removed: 1 },
    edited: 1000,
  } as worktrees.Checkout;
  expect(fingerprint(checkout)).toBe(fingerprint({ ...checkout }));
  expect(fingerprint({ ...checkout, edited: 2000 })).not.toBe(fingerprint(checkout));
});
