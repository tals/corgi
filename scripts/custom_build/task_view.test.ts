import { expect, test } from "bun:test";
import { TaskView } from "./task_view";
import * as term from "./term";

function fake() {
  const out: string[] = [],
    clock = { now: 0 };
  const view = new TaskView({
    write: s => out.push(s),
    rows: () => 24,
    cols: () => 80,
    color: false,
    command: "rollback",
    branch: "integration",
    now: () => clock.now,
    hooks: false,
  });
  return { out, clock, view, all: () => out.join("") };
}

test("tasks redraw in place and the finish leaves the list and the card", () => {
  const { all, clock, out, view } = fake();
  view.task("undo", "running");
  clock.now = 100;
  view.task("undo", "done", "integration back at 3b35a04");
  view.task("install", "running", "restoring dependencies");
  // Each draw after the first moves up over the frame before it.
  expect(out[1]).toContain("\x1b[2A\x1b[0J");
  clock.now = 3100;
  view.task("install", "done", "dependencies restored");
  view.finish({ t: "end", ok: true, code: 0, headline: "rolled back to integration", lines: [], report: null });
  const tail = all().slice(all().lastIndexOf("\x1b[3A"));
  expect(tail).toContain("custom-build rollback · integration\n" + " ✓ undo      integration back at 3b35a04");
  expect(tail).toContain("dependencies restored");
  expect(tail).toContain("\n\n✓ rolled back to integration in 0:03\n");
  expect(all().endsWith(term.restore())).toBe(true);
  // Nothing is drawn after the finish.
  const n = out.length;
  view.task("late", "running");
  expect(out).toHaveLength(n);
});

test("a failed rollback ends in a card with the error", () => {
  const { all, view } = fake();
  view.task("install", "running");
  view.task("install", "failed", "failed; see /tmp/log");
  view.finish({
    t: "end",
    ok: false,
    code: 1,
    headline: "dependency restore failed after rollback; see /tmp/log",
    lines: [],
    report: null,
  });
  expect(all()).toContain(" ✗ install");
  expect(all()).toContain("✗ custom-build rollback: dependency restore failed after rollback; see /tmp/log\n");
});
