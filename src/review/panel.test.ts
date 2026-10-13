import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "../pane/terminal";
import { Writer } from "../text";
import * as panel from "./panel";

let root = "";
const run = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-panel-")));
  run("init", "-q", "-b", "main");
  write(
    "app.ts",
    lines(40, i => `export const v${i} = ${i};`),
  );
  write("notes.md", "# Notes\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "topic");
  write("notes.md", "# Notes\n\nMore.\n");
  run("commit", "-qam", "docs: more notes");
  write(
    "app.ts",
    lines(40, i =>
      i === 5 ? "export const v5 = 50;" : i === 30 ? "export const v30 = 300;" : `export const v${i} = ${i};`,
    ),
  );
  write("bun.lock", "{}\n{}\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The panel as a terminal shows it, row by row. */
function screen(p: panel.Panel, width = 70, height = 34): string[] {
  const w = new Writer(),
    terminal = new Terminal(width, height);
  try {
    p.draw(w, 0, 0, width, height);
    terminal.feed(w.buffered());
    return terminal.text().split("\n");
  } finally {
    terminal.destroy();
  }
}
const settle = async (p: panel.Panel) => {
  for (let i = 0; i < 4; i++) {
    await p.refresh();
    await Bun.sleep(10);
  }
};
const key = (p: panel.Panel, k: string | panel.Named) =>
  p.key(k.length === 1 ? { text: k } : { named: k as panel.Named });

test("opens on all: commits and working copy together", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 1, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  const rows = screen(p);
  expect(rows[0]).toContain("Review");
  // The title is the panel's own; the pane it follows isn't named.
  expect(rows[0]).not.toContain("Fix app");
  expect(rows[0]).toContain("Review p pin");
  expect(rows.slice(0, 34).every(row => row.startsWith("│"))).toBe(true);
  // The scope tabs sit beside the title, and what the scope compares under it.
  expect(rows[0]).toContain(" all │ uncommitted │ commits ▾ 1 ");
  expect(rows[1]).toContain("topic vs main  1 commit + uncommitted");
  expect(rows[1]).toContain("3 files");
  // Too narrow to share the title row, the tabs take their own.
  const narrow = screen(p, 44);
  expect(narrow[1]).toContain(" all │ uncommitted │ commits ▾ 1 ");
  expect(narrow[2]).toContain("topic vs main");
  // How to close it stays at the bottom right when the other keys run out of room.
  expect(rows.at(-2)).toMatch(/\? keys +q close $/);
  expect(narrow.at(-2)).toMatch(/q close $/);
  expect(narrow.at(-2)).not.toContain("? keys");
  const tree = rows.slice(3, 7).join("\n");
  expect(tree).toContain("app.ts");
  expect(tree).toContain("bun.lock");
  expect(tree).toContain("gen");
  expect(tree).toContain("notes.md");
  // The first file opens with its first change in view, folded around it.
  const body = rows.join("\n");
  expect(body).toContain("export const v5 = 50;");
  expect(body).toMatch(/⋯ {2}\d+ unmodified lines/);
  p.hide();
});

test("walks hunks across files and writes a note that sends", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 7, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  key(p, "tab");
  key(p, "]");
  let body = screen(p).join("\n");
  expect(body).toContain("export const v30 = 300;");
  // ] lands on the hunk's first line, the removed one; the note goes on the added line.
  key(p, "j");
  key(p, "c");
  for (const ch of "why 300?") key(p, ch);
  key(p, "enter");
  body = screen(p).join("\n");
  expect(body).toContain("1 note");
  expect(body).toContain("why 300?");
  expect(p.noteCount(7)).toBe(1);
  const sent = key(p, "s");
  expect(sent.kind).toBe("send");
  if (sent.kind === "send") {
    expect(sent.pane).toBe(7);
    expect(sent.text).toBe("app.ts:31\n+export const v30 = 300;\nwhy 300?");
  }
  expect(p.noteCount(7)).toBe(0);
  // ] past the last hunk moves to the next file.
  key(p, "]");
  key(p, "]");
  await settle(p);
  expect(screen(p).join("\n")).toMatch(/bun\.lock|notes\.md/);
  p.hide();
});

test("a generated file waits for Enter, and scopes and commits switch", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 2, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  key(p, "j");
  await settle(p);
  expect(screen(p).join("\n")).toContain("Its diff starts collapsed. Enter loads it.");
  key(p, "tab");
  key(p, "enter");
  await settle(p);
  expect(screen(p).join("\n")).toContain("{}");
  key(p, "u");
  await settle(p);
  let rows = screen(p);
  expect(rows[1]).toContain("topic vs HEAD");
  expect(rows.join("\n")).not.toContain("notes.md");
  key(p, "g");
  // The menu hangs from the commits tab and says what each commit touched.
  const menu = screen(p);
  expect(menu.find(row => row.includes("commit") && row.includes("files  lines  age"))).toBeDefined();
  expect(menu.find(row => row.includes("docs: more notes"))).toContain("1  +2 −0");
  key(p, "enter");
  await settle(p);
  rows = screen(p);
  expect(rows[0]).toMatch(/[0-9a-f]{7} ▾/);
  expect(rows[1]).toContain("docs: more notes");
  expect(rows.join("\n")).toContain("More.");
  p.hide();
});

test("find opens the fold its match is in", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 3, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  key(p, "tab");
  expect(screen(p).join("\n")).not.toContain("export const v18 = 18;");
  key(p, "/");
  for (const ch of "v18 ") key(p, ch);
  expect(screen(p).join("\n")).toContain("export const v18 = 18;");
  p.hide();
});

test("outside a checkout it says so", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 4, cwd: tmpdir(), name: "shell" });
  p.show();
  await settle(p);
  expect(screen(p).join("\n")).toContain("Not in a git checkout");
  p.hide();
});

test("the panel fits beside the panes or not at all", () => {
  expect(panel.Panel.fit(80, 200)).toBe(80);
  expect(panel.Panel.fit(80, 100)).toBe(70);
  expect(panel.Panel.fit(80, 60)).toBe(0);
});

test("files sort by last edit, newest first, with how long ago", async () => {
  const now = Date.now() / 1000;
  utimesSync(join(root, "notes.md"), now - 2 * 86400, now - 2 * 86400);
  utimesSync(join(root, "app.ts"), now - 3 * 3600, now - 3 * 3600);
  utimesSync(join(root, "bun.lock"), now - 300, now - 300);
  const p = new panel.Panel();
  p.follow({ pane: 9, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  let rows = screen(p);
  expect(rows[2]).toContain("sort: name ↑ · last edit");
  expect(rows.find(row => row.includes("app.ts"))).toContain("3 h");
  key(p, "o");
  await settle(p);
  rows = screen(p);
  const at = ["bun.lock", "app.ts", "notes.md"].map(name => rows.findIndex(row => row.includes(name)));
  expect(at.every(i => i > 2)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(rows[at[0]]).toContain("5 min");
  expect(rows[at[2]]).toContain("2 d");
  expect(rows[2]).toContain("sort: name · last edit ↓");
  // Asked again, the same sort runs the other way.
  key(p, "O");
  rows = screen(p);
  const back = ["notes.md", "app.ts", "bun.lock"].map(name => rows.findIndex(row => row.includes(name)));
  expect(back).toEqual([...back].sort((a, b) => a - b));
  expect(rows[2]).toContain("last edit ↑");
  p.hide();
});

test("pinned, the review stays put and its notes go to the focused pane", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 11, cwd: root, name: "Fix app" });
  p.show();
  p.focused = true;
  await settle(p);
  expect(screen(p)[0]).not.toContain("→");
  key(p, "p");
  p.dest = { pane: 12, cwd: "/elsewhere", name: "Reviewer" };
  const top = screen(p, 90)[0];
  expect(top).toContain("Review p pin → Reviewer");
  // Pinned, the panel's edge turns heavy.
  expect(
    screen(p)
      .slice(0, 34)
      .every(row => row.startsWith("┃")),
  ).toBe(true);
  key(p, "tab");
  key(p, "]");
  key(p, "j");
  key(p, "c");
  for (const ch of "why?") key(p, ch);
  key(p, "enter");
  expect(screen(p).at(-2)).toContain("send 1 to Reviewer");
  const sent = key(p, "s");
  expect(sent).toMatchObject({ kind: "send", pane: 12, from: 11 });
  // A failed send puts the notes back on the review they came from.
  if (sent.kind === "send") p.restore(sent.from, sent.notes, "kept");
  expect(p.noteCount(11)).toBe(1);
  p.hide();
  expect(p.pinned).toBe(false);
});

test("the wheel scrolls the file list under the pointer", async () => {
  const extra = Array.from({ length: 6 }, (_, i) => `z${i}.txt`);
  for (const name of extra) write(name, "new\n");
  try {
    const p = new panel.Panel();
    p.follow({ pane: 13, cwd: root, name: "Fix app" });
    p.show();
    p.focused = true;
    await settle(p);
    const list = () => screen(p, 70, 20).slice(3, 9).join("\n");
    expect(list()).toContain("app.ts");
    expect(list()).not.toContain("z5.txt");
    // Over a file's row, the list scrolls, and stays off the selected file.
    p.mouse("wheel_down", 5, 4);
    expect(list()).not.toContain("app.ts");
    expect(list()).toContain("z5.txt");
    // Moving the selection brings it back into view.
    key(p, "j");
    expect(list()).toContain("bun.lock");
    p.hide();
  } finally {
    for (const name of extra) rmSync(join(root, name));
  }
});
