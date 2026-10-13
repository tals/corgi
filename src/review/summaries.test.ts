import { expect, test } from "bun:test";
import type * as dropdown from "../dropdown";
import { Summaries, fresh_ms, slow_ms } from "./summaries";

/** A Summaries over fake checkouts: `/repo/sub` is in `/repo`, `/tmp` is in none,
 * and each read waits until the test lets it answer. */
function fake() {
  let clock = 0;
  const reads: { root: string; answer: (runs: dropdown.Run[], took?: number) => void }[] = [];
  let changes = 0;
  const s = new Summaries(
    root =>
      new Promise(resolve =>
        reads.push({
          root,
          answer: (runs, took = 0) => {
            clock += took;
            resolve(runs);
          },
        }),
      ),
    async cwd => (cwd.startsWith("/repo") ? "/repo" : cwd.startsWith("/other") ? "/other" : null),
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

test("a checkout is read once until it goes stale or old", async () => {
  const { s, reads, tick } = fake();
  s.want("/repo");
  await settle();
  expect(reads.map(r => r.root)).toEqual(["/repo"]);
  reads[0].answer(line(1));
  await settle();
  expect(s.get("/repo")).toEqual(line(1));
  // Another directory in the same checkout shares its line.
  s.want("/repo/sub");
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(1);
  expect(s.get("/repo/sub")).toEqual(line(1));
  // A turn in it marks it stale.
  s.invalidate("/repo");
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(2);
  reads[1].answer(line(2));
  await settle();
  tick(fresh_ms);
  s.want("/repo");
  await settle();
  expect(reads.length).toBe(3);
});

test("one read at a time, with a menu's ask ahead of what was wanted", async () => {
  const { s, reads } = fake();
  s.want("/repo");
  s.want("/other");
  s.want("/repo");
  await settle();
  expect(reads.map(r => r.root)).toEqual(["/repo"]);
  s.ask("/elsewhere");
  reads[0].answer(line(1));
  await settle();
  // Outside git there is nothing to read; it answers at once, then /other.
  expect(s.get("/elsewhere")).toEqual([["Not in a git checkout", "faint"]]);
  expect(reads.map(r => r.root)).toEqual(["/repo", "/other"]);
  // A menu asks even when the line is fresh.
  s.ask("/repo");
  reads[1].answer(line(2));
  await settle();
  expect(reads.map(r => r.root)).toEqual(["/repo", "/other", "/repo"]);
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
