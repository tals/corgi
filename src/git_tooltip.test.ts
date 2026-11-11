import * as viewerRef from "./viewer_ref";
import { expect, setSystemTime, test } from "bun:test";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";
import * as gitTooltip from "./git_tooltip";
import { workspaceEntry } from "./sidebar";
import * as viewer from "./viewer";

const commit = (hash: string, subject: string) => ({ hash, subject, author: "A", date: "d", timestamp: 0 });
const ws = workspaceEntry({
  id: viewerRef.workspace(1, 1),
  name: "w",
  cwd: "/tmp",
  active: true,
  git_ahead: 3,
  git_commits: [commit("abc1234", "Grow"), commit("def5678", "Shrink")].map(c => ({
    ...c,
    diff: { files: 0, insertions: 0, deletions: 0 },
  })),
});

test("the push card's rows are its heading, then two lines per commit", () => {
  const rect = gitTooltip.geometry(ws, 100, 30, 10, 2)!;
  expect([rect.x, rect.y, rect.h]).toEqual([12, 3, 8]);
  const at = (y: number) => gitTooltip.rowAt(rect, ws, 30, rect.x + 4, y);
  expect([3, 4, 5, 6, 7, 8, 9].map(at)).toEqual([null, 0, 1, 1, 2, 2, null]);
  expect(gitTooltip.rowAt(rect, ws, 30, rect.x, 4)).toBeNull();
  expect(gitTooltip.review(ws, 0)).toEqual({ scope: "all", pick: null });
  expect(gitTooltip.review(ws, 2)).toEqual({ scope: "commits", pick: "def5678" });
  const card = new gitTooltip.State();
  card.move(1, 3);
  expect(card.selected).toBe(0);
  card.move(5, 3);
  expect(card.selected).toBe(2);
});

const mouse = (button: number, x: number, y: number) => Buffer.from(`\x1b[<${button};${x + 1};${y + 1}M`);

test("hovering the push card shows a row's review dimmed, and Enter opens it", async () => {
  const s = new Controller({
    request: transport(async () => {
      throw Error("UnexpectedRequest");
    }).request,
  });
  s.width = 120;
  s.height = 30;
  s.input_state.attached = true;
  s.receiveSnapshot({
    workspaces: [
      {
        id: 1,
        name: "test",
        cwd: "/tmp",
        git_ahead: 2,
        git_commits: [commit("abc1234", "Grow"), commit("def5678", "Shrink")],
        model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 },
      },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 80,
        rows: 29,
        cwd: "/tmp",
        agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
      },
    ],
    conversations: [],
    headless_sessions: [],
  } as any);
  try {
    // The push label "↑2" ends the first workspace's row, at columns 24 and 25.
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 25, 2));
    s.frame();
    setSystemTime(new Date(5000));
    expect(s.frame()).toContain("unpushed commits");
    // A step down and right, short of the card, keeps it while it aims there.
    await s.input(mouse(35, 26, 3));
    expect(s.git_aim).not.toBeNull();
    expect(s.frame()).toContain("unpushed commits");
    await s.input(mouse(35, 30, 4));
    expect(s.git_card.selected).toBe(0);
    expect(s.frame()).toContain("┆");
    expect(s.review.open).toBe(false);
    await s.input(mouse(35, 30, 5));
    expect(s.git_card.selected).toBe(1);
    // An arrow holds the card for the keyboard, moving from the hovered row.
    await s.input(Buffer.from("\x1b[B"));
    expect([s.git_card.pinned, s.git_card.selected]).toEqual([true, 2]);
    await s.input(Buffer.from("\r"));
    expect(s.git_card.pinned).toBe(false);
    expect(s.review.open).toBe(true);
    expect(s.review.ghosted).toBe(false);
    const r = s.review.review(1);
    expect([r.scope, r.pick]).toEqual(["commits", "def5678"]);
    // Off the card and its label, a hovered card closes and takes its ghost with it.
    s.review.hide();
    setSystemTime(new Date(10_000));
    await s.input(mouse(35, 25, 2));
    s.frame();
    setSystemTime(new Date(15_000));
    s.frame();
    await s.input(mouse(35, 30, 4));
    expect(s.frame()).toContain("┆");
    await s.input(mouse(35, 60, 20));
    const away = s.frame();
    expect(away).not.toContain("unpushed commits");
    expect(away).not.toContain("┆");
  } finally {
    setSystemTime();
    s.review.hide();
    viewer.close(s);
  }
});
