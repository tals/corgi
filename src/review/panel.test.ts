import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "../pane/terminal";
import { Writer } from "../text";
import * as panel from "./panel";
import * as i18n from "../i18n";

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
    p.draw(w, 0, 0, width, height, true);
    terminal.feed(w.buffered());
    return terminal.text().split("\n");
  } finally {
    terminal.destroy();
  }
}
const settle = async (p: panel.Panel) => {
  // A refresh already in flight queues another; wait for that one too.
  await p.refresh();
  await p.refresh();
};
const key = (p: panel.Panel, k: string | panel.Named) =>
  p.key(k.length === 1 ? { text: k } : { named: k as panel.Named });

test("opens on all: commits and working copy together", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 1, cwd: root, name: "Fix app" });
  p.show();
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
  expect(rows[3]).toContain("≡ All files");
  expect(tree).toContain("app.ts");
  expect(tree).toContain("bun.lock");
  expect(tree).toContain("gen");
  expect(tree).toContain("notes.md");
  // The first file opens with its first change in view, folded around it.
  const body = rows.join("\n");
  expect(body).toContain("export const v5 = 50;");
  expect(body).toMatch(/⋯ {2}\d+ unmodified lines/);
  // A fold before a change names the line that holds it, like git's hunk header.
  expect(body).toMatch(/⋯ {2}\d+ unmodified lines {2}· {2}export const v\d+ = \d+;/);
  p.hide();
});

test("walks hunks across files and writes a note that sends", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 7, cwd: root, name: "Fix app" });
  p.show();
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
  await settle(p);
  key(p, "j");
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

test("last-edit ages use the current language for hours and days", async () => {
  const now = Date.now() / 1000,
    original = i18n.language(),
    p = new panel.Panel();
  utimesSync(join(root, "notes.md"), now - 2 * 86400, now - 2 * 86400);
  utimesSync(join(root, "app.ts"), now - 3 * 3600, now - 3 * 3600);
  try {
    p.follow({ pane: 10, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      const rows = screen(p),
        hours = 3,
        days = 2;
      expect(rows[0]).toContain(i18n.t`Review` + " p " + i18n.t`pin`);
      expect(rows.find(row => row.includes("app.ts"))).toContain(i18n.t`${hours} h`);
      expect(rows.find(row => row.includes("notes.md"))).toContain(i18n.t`${days} d`);
      if (locale !== "en") {
        expect(rows.find(row => row.includes("app.ts"))).not.toContain("3 h");
        expect(rows.find(row => row.includes("notes.md"))).not.toContain("2 d");
      }
    }
  } finally {
    p.hide();
    i18n.setLanguage(original);
  }
});

test("pinned, the review stays put and its notes go to the focused pane", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 11, cwd: root, name: "Fix app" });
  p.show();
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

test("up and down move between the file list and the diff under it, and stop past either", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 15, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const inList = () => screen(p).at(-2)!.includes("j/k file");
  expect(inList()).toBe(true);
  expect(p.move("up")).toBe(false);
  expect(p.move("right")).toBe(false);
  expect(p.move("down")).toBe(true);
  expect(inList()).toBe(false);
  expect(p.move("down")).toBe(false);
  expect(p.move("up")).toBe(true);
  expect(inList()).toBe(true);
  // With the list hidden, the diff is all there is.
  key(p, "z");
  expect(p.move("up")).toBe(false);
  expect(p.move("down")).toBe(false);
  p.hide();
});

test("the wheel scrolls the file list under the pointer", async () => {
  const extra = Array.from({ length: 6 }, (_, i) => `z${i}.txt`);
  for (const name of extra) write(name, "new\n");
  try {
    const p = new panel.Panel();
    p.tree_rows = 6;
    p.follow({ pane: 13, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    const list = () => screen(p, 70, 20).slice(3, 9).join("\n");
    expect(list()).toContain("app.ts");
    expect(list()).not.toContain("z5.txt");
    // Over a file's row, the list scrolls, and stays off the selected file.
    p.mouse("wheel_down", 5, 4);
    p.mouse("wheel_down", 5, 4);
    expect(list()).not.toContain("app.ts");
    expect(list()).toContain("z5.txt");
    // Moving the selection brings it back into view.
    key(p, "j");
    expect(list()).toContain("app.ts");
    p.hide();
  } finally {
    for (const name of extra) rmSync(join(root, name));
  }
});

test("all files reads every file in one flow, each under its heading", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 21, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  // Under the list's rule, the files in the list's order.
  const flow = () => screen(p, 70, 60).slice(8);
  let rows = flow();
  const at = (text: string) => rows.findIndex(row => row.includes(text));
  expect(rows[0]).toMatch(/M app\.ts +working copy  \+2 −2/);
  expect(rows[at("A bun.lock")]).toContain("untracked  gen +2");
  expect(rows[at("A bun.lock") + 1]).toContain("Generated file · enter loads its diff");
  expect(rows[at("M notes.md")]).toContain("committed  +2");
  expect(at("export const v30 = 300;")).toBeLessThan(at("A bun.lock"));
  expect(at("More.")).toBeGreaterThan(at("M notes.md"));
  // f walks to the next file; Enter there loads a generated diff in place.
  key(p, "tab");
  key(p, "f");
  key(p, "enter");
  await settle(p);
  rows = flow();
  expect(rows[at("A bun.lock") + 1]).toContain("{}");
  // A note goes on the file the cursor is in.
  key(p, "f");
  key(p, "c");
  for (const ch of "why?") key(p, ch);
  key(p, "enter");
  rows = flow();
  expect(rows[at("M notes.md")]).toContain("•");
  expect(rows.join("\n")).toContain("notes.md:2");
  p.hide();
});

test("a file picked in the list shows alone, and all files comes back on it", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 22, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  screen(p);
  p.mouse("press", 10, 6);
  p.mouse("release", 10, 6);
  await settle(p);
  let rows = screen(p);
  expect(rows[7]).toContain(" notes.md ");
  expect(rows.slice(8).join("\n")).not.toContain("app.ts");
  p.mouse("press", 10, 3);
  p.mouse("release", 10, 3);
  await settle(p);
  // Back on the flow, it's on the file last shown, not its top.
  rows = screen(p, 70, 20).slice(8);
  expect(rows.some(row => /M notes\.md +committed/.test(row))).toBe(true);
  expect(rows.join("\n")).toContain("More.");
  expect(rows.join("\n")).not.toContain("v5 = 50");
  p.hide();
});

test("find on all files reaches into every file", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 23, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "/");
  for (const ch of "more.") key(p, ch);
  const rows = screen(p, 70, 20);
  expect(rows.join("\n")).toContain("More.");
  expect(rows.at(-2)).toContain("1/1");
  p.hide();
});

test("dragging the rule under the file list sets its height", async () => {
  const p = new panel.Panel();
  let saved = 0;
  p.resized = rows => (saved = rows);
  p.follow({ pane: 24, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  screen(p);
  expect(p.splitRow).toBe(7);
  p.mouse("press", 10, 7);
  expect(p.splitting).toBe(true);
  p.mouse("drag", 10, 5);
  p.mouse("release", 10, 5);
  expect(saved).toBe(2);
  const rows = screen(p);
  expect(rows[3]).toContain("All files");
  expect(rows[5]).toMatch(/^│─+$/);
  expect(rows[3]).toMatch(/▐$/);
  expect(p.splitRow).toBe(5);
  // Dragged down, the list stops short of the diff's last rows.
  p.mouse("press", 10, 5);
  p.mouse("drag", 10, 40);
  p.mouse("release", 10, 40);
  expect(saved).toBe(34 - 3 - 2 - 5);
  p.hide();
});

test("a file's heading folds it to its counts, and unfolds it", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 25, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const flow = () => screen(p, 70, 60).slice(8).join("\n");
  expect(flow()).toMatch(/▾ M app\.ts/);
  // A click on the heading folds the file away, leaving what it held.
  p.mouse("press", 10, 8);
  p.mouse("release", 10, 8);
  let body = flow();
  expect(body).toMatch(/▸ M app\.ts +2 hunks  working copy  \+2 −2/);
  expect(body).not.toContain("v30 = 300");
  expect(body).toContain("More.");
  // Folded files are passed over by ] and unfold with Enter.
  key(p, "]");
  expect(screen(p, 70, 60).at(-2)).not.toContain("unfold");
  key(p, "[");
  expect(screen(p, 70, 60).at(-2)).not.toContain("unfold");
  key(p, "home");
  expect(screen(p, 70, 60).at(-2)).toContain("enter unfold");
  key(p, "enter");
  body = flow();
  expect(body).toMatch(/▾ M app\.ts/);
  expect(body).toContain("v30 = 300");
  // x folds the file the cursor is in.
  key(p, "x");
  expect(flow()).toMatch(/▸ M app\.ts/);
  p.hide();
});

test("test diffs fold at the ratio for the current scope, and explicit choices survive refresh", async () => {
  const p = new panel.Panel();
  const testLines = (n: number) =>
    write(
      "app.test.ts",
      lines(n, i => `test_only_${i}();`),
    );
  const body = () => screen(p, 70, 60).join("\n");
  testLines(25);
  try {
    p.follow({ pane: 30, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    // The branch has six non-test edits, excluding the generated lockfile.
    expect(body()).toContain("▾ A app.test.ts");
    testLines(24);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    expect(body()).not.toContain("test_only_0();");

    // Only four of those non-test edits are uncommitted.
    p.showScope("uncommitted", null);
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    p.showScope("all", null);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");

    key(p, "tab");
    expect(screen(p).at(-2)).toContain("enter unfold");
    key(p, "enter");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("test_only_0();");

    key(p, "x");
    testLines(25);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    key(p, "enter");
    expect(body()).toContain("▾ A app.test.ts");
  } finally {
    p.hide();
    rmSync(join(root, "app.test.ts"));
  }
});

test("single-file view, find and note navigation reveal automatically folded tests", async () => {
  const p = new panel.Panel();
  write(
    "app.test.ts",
    lines(24, i => `test_only_${i}();`),
  );
  const body = () => screen(p, 70, 60).join("\n");
  try {
    p.follow({ pane: 31, cwd: root, name: "Fix app" });
    p.show();
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");
    const row = screen(p).findIndex(row => row.includes("app.test.ts"));
    p.mouse("press", 10, row);
    p.mouse("release", 10, row);
    await settle(p);
    expect(body()).toContain("test_only_0();");
    p.mouse("press", 10, 3);
    p.mouse("release", 10, 3);
    await settle(p);
    expect(body()).toContain("▸ A app.test.ts");

    key(p, "tab");
    key(p, "/");
    for (const ch of "test_only_0") key(p, ch);
    key(p, "escape");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("test_only_0();");

    key(p, "c");
    for (const ch of "check this test") key(p, ch);
    key(p, "enter");
    key(p, "x");
    expect(body()).toContain("▸ A app.test.ts");
    key(p, "n");
    await settle(p);
    expect(body()).toContain("▾ A app.test.ts");
    expect(body()).toContain("check this test");
  } finally {
    p.hide();
    rmSync(join(root, "app.test.ts"));
  }
});

test("? shows every key in one box of groups over a dimmed panel, and any key closes it", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 26, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  const before = screen(p, 80, 34);
  key(p, "?");
  expect(p.keysOpen).toBe(true);
  const rows = screen(p, 80, 34),
    at = (text: string) => rows.findIndex(row => row.includes(text));
  expect(rows[at("Keys")]).toMatch(/╭─ Keys ─+╮/);
  // Two columns of groups, each key at the end of what it does.
  expect(rows[at("Move")]).toMatch(/Move +Show/);
  expect(rows[at("Page")]).toMatch(/Page +space - +Uncommitted +u/);
  expect(rows[at("Pin review")]).toMatch(/Pin review +p/);
  expect(at("File list")).toBeGreaterThan(at("Move"));
  expect(at("Leave")).toBeGreaterThan(at("File list"));
  expect(rows[at("any key closes")]).toMatch(/╰─+ any key closes ─╯/);
  key(p, "j");
  expect(p.keysOpen).toBe(false);
  expect(screen(p, 80, 34)[4]).toBe(before[4]);
  // A click closes it too, and does nothing else.
  key(p, "?");
  p.mouse("press", 10, 4);
  expect(p.keysOpen).toBe(false);
  expect(screen(p, 80, 34)[3]).toContain("≡ All files");
  p.hide();
});

test("space pages down and - pages up, as in tig", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 27, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  const top = screen(p, 70, 20).slice(8).join("\n");
  key(p, " ");
  key(p, " ");
  const paged = screen(p, 70, 20).slice(8).join("\n");
  expect(paged).not.toBe(top);
  expect(paged).toContain("More.");
  key(p, "-");
  key(p, "-");
  key(p, "-");
  expect(screen(p, 70, 20).slice(8).join("\n")).toContain("v5 = 50");
  p.hide();
});

test("shift and an arrow select lines as a drag does", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 28, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "select_down");
  key(p, "select_down");
  expect(screen(p).at(-2)).toContain("c comment on 3 rows");
  key(p, "select_up");
  expect(screen(p).at(-2)).toContain("c comment on 2 rows");
  // Back where it started, there's no selection.
  key(p, "select_up");
  expect(screen(p).at(-2)).not.toContain("comment on");
  // A plain move after it ends the selection and moves, as letting go of shift would.
  key(p, "select_down");
  key(p, "down");
  expect(screen(p).at(-2)).not.toContain("comment on");
  // v's selection keeps growing with plain moves.
  key(p, "v");
  key(p, "down");
  expect(screen(p).at(-2)).toContain("c comment on 2 rows");
  key(p, "escape");
  key(p, "up");
  key(p, "up");
  key(p, "select_up");
  key(p, "c");
  for (const ch of "both") key(p, ch);
  key(p, "enter");
  const body = screen(p).join("\n");
  expect(body).toMatch(/╭─ app\.ts:\d+ /);
  expect(body).toContain("both");
  p.hide();
});

test("the note box edits like a text box: words, lines, selection and paste", async () => {
  const p = new panel.Panel();
  p.follow({ pane: 29, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  key(p, "tab");
  key(p, "c");
  expect(p.typing).toBe(true);
  for (const ch of "why is this here") key(p, ch);
  key(p, "word_backspace");
  key(p, "word_backspace");
  key(p, "newline");
  for (const ch of "50?") key(p, ch);
  // Back to the first line's start, and a word selected and typed over.
  key(p, "up");
  key(p, "line_start");
  key(p, "select_word_right");
  for (const ch of "what") key(p, ch);
  for (const byte of Buffer.from(" — pasted\r\nline")) p.pasteByte(byte);
  // The paste goes in at the caret, its line break as one.
  let rows = screen(p);
  const y = rows.findIndex(row => row.includes("│ what — pasted ")),
    x = rows[y].indexOf("what");
  expect(rows[y + 1]).toContain("│ line is ");
  expect(rows[y + 2]).toContain("│ 50? ");
  // A click in the box places the caret; a drag selects.
  p.mouse("press", x, y);
  p.mouse("drag", x + 5, y);
  p.mouse("release", x + 5, y);
  key(p, "backspace");
  key(p, "enter");
  const body = screen(p).join("\n");
  expect(body).toContain("— pasted");
  expect(body).not.toContain("what");
  expect(p.typing).toBe(false);
  p.hide();
});

/** The ghost as a terminal shows it, row by row. */
function ghostScreen(p: panel.Panel, width = 70, height = 34): string[] {
  const w = new Writer(),
    terminal = new Terminal(width, height);
  try {
    p.drawGhost(w, 0, 0, width, height);
    terminal.feed(w.buffered());
    return terminal.text().split("\n");
  } finally {
    terminal.destroy();
  }
}
test("a ghost shows another scope dimmed and leaves the followed review alone", async () => {
  const p = new panel.Panel();
  const hash = run("rev-parse", "--short", "HEAD").trim();
  // Closed, a ghost still reads and draws its checkout.
  p.preview({ cwd: root, name: "w", scope: "commits", pick: hash });
  await settle(p);
  let rows = ghostScreen(p);
  expect(rows.slice(0, 34).every(row => row.startsWith("┆"))).toBe(true);
  expect(rows[1]).toContain(`${hash}  docs: more notes`);
  // The next ghost takes its place only once read, never through a blank.
  p.preview({ cwd: root, name: "w", scope: "all", pick: null });
  expect(ghostScreen(p)[1]).toContain(`${hash}  docs: more notes`);
  await settle(p);
  expect(ghostScreen(p)[1]).toContain("topic vs main");
  p.follow({ pane: 3, cwd: root, name: "Fix app" });
  p.show();
  await settle(p);
  p.preview(null);
  expect(p.ghosted).toBe(false);
  rows = screen(p);
  expect(rows[0].startsWith("│")).toBe(true);
  expect(rows[1]).toContain("topic vs main");
  // Opened from elsewhere, a short hash names the full commit.
  p.showScope("commits", hash);
  await settle(p);
  expect(screen(p)[1]).toContain(`${hash}  docs: more notes`);
  expect(p.review(3).pick).toHaveLength(40);
  p.hide();
});

test("wide source wraps and scrolls in cells without writing into the pane beside it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-wide-")));
  const p = new panel.Panel();
  try {
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    writeFileSync(
      join(dir, "wide.ts"),
      [
        'export const languages = ["English", "中文", "日本語", "한국어", "Русский"];',
        'export const combining = "e\u0301";',
        "界".repeat(210),
        "export const afterWideLine = true;",
      ].join("\n") + "\n",
    );
    p.follow({ pane: 88, cwd: dir, name: "Wide source" });
    p.show();
    await settle(p);
    const review = p.review(88);
    review.all = false;
    review.path = "wide.ts";
    review.free = true;
    for (const width of [40, 53]) {
      for (const [wrap, shift] of [
        [true, 0],
        [false, 0],
        [false, 9],
      ] as const) {
        review.wrap = wrap;
        review.shift = shift;
        review.top = 0;
        const left = "L".repeat(59),
          height = 34;
        const terminal = new Terminal(left.length + width, height);
        try {
          for (let row = 0; row < height; row++) terminal.feed(`\x1b[${row + 1};1H${left}`);
          const w = new Writer();
          p.draw(w, left.length, 0, width, height, true);
          terminal.feed(w.buffered());
          const rows = terminal.text().split("\n");
          expect(rows.slice(0, height).every(row => row.startsWith(left + "│"))).toBe(true);
          const body = rows.map(row => row.slice(left.length)).join("\n");
          expect(body).toContain("界界界");
          expect(body).toContain("afterWideLine");
          expect(body).not.toContain("�");
          if (wrap) {
            expect(body).toContain("more characters");
            expect(body).toMatch(/e\u0301|é/);
          }
        } finally {
          terminal.destroy();
        }
      }
    }
  } finally {
    p.hide();
    rmSync(dir, { recursive: true, force: true });
  }
});
