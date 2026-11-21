import { expect, test } from "bun:test";
import type * as dropdown from "../dropdown";
import { Summaries, fresh_ms, slow_ms } from "./summaries";

/** A Summaries over fake checkouts: `/repo/sub` is in `/repo`, `/tmp` is in none,
 * and each read in a checkout waits until the test lets it answer. */
function fake() {
  let clock = 0;
  const reads: { cwd: string; answer: (runs: dropdown.Run[], took?: number) => void }[] = [];
  let changes = 0;
  const rootOf = (cwd: string) => (cwd.startsWith("/repo") ? "/repo" : cwd.startsWith("/other") ? "/other" : null);
  const s = new Summaries(
    async cwd => {
      const root = rootOf(cwd);
      if (!root) return { root, runs: [] };
      return new Promise(resolve =>
        reads.push({
          cwd,
          answer: (runs, took = 0) => {
            clock += took;
            resolve({ root, runs });
          },
        }),
      );
    },
    () => clock,
  );
  s.changed = () => changes++;
  return {
    s,
    reads,
    tick: (ms: number) => (clock += ms),
    changes: () => changes,
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const line = (n: number): dropdown.Run[] => [[`${n} files`, "faint"]];

test("a directory is known to be in a checkout or not once a read says", async () => {
  const { s, reads } = fake();
  expect(s.inCheckout("/repo/sub")).toBeNull();
  s.want("/repo/sub");
  s.want("/tmp");
  await settle();
  reads[0].answer(line(1));
  await settle();
  expect(s.inCheckout("/repo/sub")).toBe(true);
  expect(s.inCheckout("/tmp")).toBe(false);
});

test("a directory outside git is checked again when a menu asks or its line goes old", async () => {
  let clock = 0,
    inited = false,
    checks = 0;
  const s = new Summaries(
    async () => (checks++, inited ? { root: "/tmp", runs: line(1) } : { root: null, runs: [] }),
    () => clock,
  );
  s.want("/tmp");
  await settle();
  expect(s.inCheckout("/tmp")).toBe(false);
  s.want("/tmp");
  await settle();
  expect(checks).toBe(1);
  clock += fresh_ms;
  s.want("/tmp");
  await settle();
  expect(checks).toBe(2);
  // After `git init`, a menu's ask finds the checkout.
  inited = true;
  s.ask("/tmp");
  await settle();
  expect(s.inCheckout("/tmp")).toBe(true);
  expect(s.get("/tmp")).toEqual(line(1));
});

test("a checkout is read once until it goes stale or old", async () => {
  const { s, reads, tick } = fake();
  s.want("/repo/sub");
  await settle();
  expect(reads.map(r => r.cwd)).toEqual(["/repo/sub"]);
  reads[0].answer(line(1));
  await settle();
  expect(s.get("/repo/sub")).toEqual(line(1));
  // A directory read in a checkout gives the checkout its line.
  expect(s.get("/repo")).toBeNull();
  s.want("/repo");
  await settle();
  reads[1].answer(line(1));
  await settle();
  expect(s.get("/repo")).toEqual(line(1));
  s.want("/repo/sub");
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(2);
  // A turn in it marks it stale.
  s.invalidate("/repo");
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(3);
  reads[2].answer(line(2));
  await settle();
  tick(fresh_ms);
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(4);
});

test("one read at a time, with a menu's ask ahead of what was wanted", async () => {
  const { s, reads } = fake();
  s.want("/repo");
  s.want("/other");
  s.want("/repo");
  await settle();
  expect(reads.map(r => r.cwd)).toEqual(["/repo"]);
  s.ask("/elsewhere");
  reads[0].answer(line(1));
  await settle();
  // Outside git there is nothing to read; it answers at once, then /other.
  expect(s.get("/elsewhere")).toEqual([["Not in a git checkout", "faint"]]);
  expect(reads.map(r => r.cwd)).toEqual(["/repo", "/other"]);
  // A menu asks even when the line is fresh.
  s.ask("/repo");
  reads[1].answer(line(2));
  await settle();
  expect(reads.map(r => r.cwd)).toEqual(["/repo", "/other", "/repo"]);
});

test("a slow checkout is read only when a menu asks", async () => {
  const { s, reads, tick } = fake();
  s.want("/repo");
  await settle();
  reads[0].answer(line(1), slow_ms + 1);
  await settle();
  tick(fresh_ms);
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(1);
  s.ask("/repo");
  await settle();
  expect(reads.length).toBe(2);
  // Quick again, it is read ahead again.
  reads[1].answer(line(1));
  await settle();
  tick(fresh_ms);
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(3);
});

test("a line read elsewhere is kept, and only a different one tells", async () => {
  const { s, reads, changes } = fake();
  s.want("/repo");
  await settle();
  reads[0].answer(line(1));
  await settle();
  expect(changes()).toBe(1);
  s.put("/repo", line(1));
  expect(changes()).toBe(1);
  s.put("/repo", line(4));
  expect(changes()).toBe(2);
  expect(s.get("/repo/sub")).toBeNull();
  expect(s.get("/repo")).toEqual(line(4));
  // The panel's read counts as fresh.
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(1);
});

test("a daemon that can't answer says so", async () => {
  const down = new Summaries(async () => {
    throw Object.assign(Error("ConnectionClosed"), { name: "ConnectionClosed" });
  });
  down.ask("/repo");
  await settle();
  expect(down.get("/repo")).toEqual([["git didn't answer", "faint"]]);
  // A failed read doesn't say the directory is outside git.
  expect(down.inCheckout("/repo")).toBeNull();
});
