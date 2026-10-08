import { test, expect } from "bun:test";
import { settle } from "./trackers";

test("settle applies in-flight port and git scans without awaiting pushes", async () => {
  let collectCount = 0,
    resolvePort!: () => void,
    resolveGit!: () => void;
  const ports: any = {
      thread: new Promise<void>(r => (resolvePort = r)),
      busy() {
        return this.thread !== null;
      },
    },
    git_status: any = {
      thread: new Promise<void>(r => (resolveGit = r)),
      busy() {
        return this.thread !== null;
      },
    },
    git_push = { thread: new Promise(() => {}) };
  const completed = settle({ ports, git_status, git_push } as any, async () => {
    collectCount++;
    if (collectCount === 1) {
      resolvePort();
      resolveGit();
    } else {
      ports.thread = null;
      git_status.thread = null;
    }
  });
  await completed;
  expect(collectCount).toBe(3);
  expect(git_push.thread).toBeInstanceOf(Promise);
});
