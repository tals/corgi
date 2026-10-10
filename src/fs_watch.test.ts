import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Watcher, Changes } from "./fs_watch";
test("a file written under a watched folder is reported in its root's spelling", async () => {
  const base = mkdtempSync("/tmp/corgi-watch-"),
    root = base + "/projects";
  mkdirSync(root + "/one", { recursive: true });
  const w = Watcher.init([{ path: root, depth: 2 }], 50),
    changes = new Changes();
  try {
    await Bun.sleep(50);
    mkdirSync(root + "/two");
    writeFileSync(root + "/one/a.jsonl", "{}\n");
    writeFileSync(root + "/two/b.jsonl", "{}\n");
    const done = () =>
      changes.paths.has(root + "/one/a.jsonl") &&
      (changes.paths.has(root + "/two/b.jsonl") || changes.paths.has(root + "/two"));
    for (let i = 0; i < 50 && !done(); i++) await w.wait(100, changes);
    expect(done()).toBe(true);
  } finally {
    w.close();
    rmSync(base, { recursive: true, force: true });
  }
});
