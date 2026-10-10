import { test, expect } from "bun:test";
import { Tracker } from "./resources";
import type { Runtime } from "../runtime";
import * as clock from "../clock";

test("resource Worker preserves counters and rejects samples after ownership changes", async () => {
  const tracker = new Tracker();
  let workspace = 1;
  const runtime = {
    panes: [
      {
        id: 1,
        terminal: { pid: process.pid, exited: false },
        detection: { pid: 0 },
        agent: () => ({ provider: null }),
      },
    ],
    sessions: [],
    workspaces: { items: [{ id: 1 }], owner: () => ({ id: workspace }) },
  } as unknown as Runtime;
  try {
    tracker.tick(runtime, false);
    await tracker.thread;
    expect(tracker.tick(runtime, false)).toBe(true);
    const first = tracker.current.workspace(1);
    expect(first.known).toBe(true);
    expect(first.processes.some(p => p.pid === process.pid)).toBe(true);
    expect(typeof first.memory).toBe("bigint");
    expect(tracker.current.forViewer(null).workspace(1).processes).toEqual([]);
    clock.advance(2100);
    tracker.tick(runtime, false);
    await tracker.thread;
    expect(tracker.tick(runtime, false)).toBe(true);
    expect(tracker.current.workspace(1).cpu).not.toBeNull();
    expect(tracker.current.workspace(1).history).toHaveLength(2);
    const previous = tracker.current;
    clock.advance(2100);
    tracker.tick(runtime, false);
    workspace = 2;
    await tracker.thread;
    expect(tracker.tick(runtime, false)).toBe(false);
    expect(tracker.current).toBe(previous);
  } finally {
    tracker.close();
    clock.reset();
  }
}, 10000);
