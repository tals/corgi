import { expect, test } from "bun:test";
import { Menu, items, status, type Hit } from "./corgi_setup";
import * as shellPicker from "./shell_picker";
import { Preferences } from "./preferences";
import { State as ClipboardState } from "./host_clipboard";
import * as corgiAnimation from "./corgi_animation";
import { Worker, pane, workspace } from "./import/catalog";
import { Writer } from "./text";

/** The screen's text after replaying the cursor moves in `ansi`. */
function screen(ansi: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (const m of ansi.matchAll(/\x1b\[([\d;?]*)([A-Za-z])|([\s\S])/gu)) {
    if (m[2] === "H") {
      const [r, c] = (m[1] || "1;1").split(";").map(Number);
      y = r - 1;
      x = c - 1;
    } else if (m[3] !== undefined) {
      if (y < rows && x < cols) grid[y][x] = m[3];
      x++;
    }
  }
  return grid.map(row => row.join(""));
}
function draw(menu: Menu, cols = 100, rows = 30, now = 0, s = status(), prefs = new Preferences()): string[] {
  const w = new Writer();
  menu.drawAt(w, s, prefs, cols, rows, now);
  return screen(w.s, cols, rows);
}
function hits(menu: Menu, cols = 100, rows = 30, s = status(), prefs = new Preferences()): Hit[] {
  const out: Hit[] = [];
  for (let y = 0; y < rows; y++) {
    const seen = new Set<string>();
    for (let x = 0; x < cols; x++) {
      const hit = menu.hit(cols, rows, x, y, s, prefs);
      if (hit && !seen.has(JSON.stringify(hit))) {
        seen.add(JSON.stringify(hit));
        out.push(hit);
      }
    }
  }
  return out;
}

test("setup lists every setting beside the selected one's options", () => {
  const menu = Menu.open();
  const rows = draw(menu, 100, 30, 0, status({ choice: "claude" }));
  const top = rows.findIndex(row => row.includes("Corgi setup"));
  expect(rows[top].indexOf("╭")).toBe(8);
  expect(rows[top + 2]).toMatch(/Clever Corgi\s+│\s+Clever Corgi/);
  expect(rows.join("\n")).toMatch(/Summaries +● Claude ▾/);
  expect(rows.join("\n")).toContain("↑↓ move   enter choose   esc close");
  // List rows and options are clickable, in order.
  const s = status({ choice: "claude" });
  const found = hits(menu, 100, 30, s);
  expect(found.filter(hit => "item" in hit)).toEqual(items.map(item => ({ item })));
  expect(found.filter(hit => "option" in hit)).toEqual([0, 1].map(option => ({ option })));
  expect(menu.hit(100, 30, 0, 0, s, new Preferences())).toBeNull();
  expect(menu.contains(100, 30, 50, top + 1)).toBe(true);
  // Too small for the frame: nothing draws.
  expect(draw(menu, 20, 8).join("").trim()).toBe("");
});

test("Summaries opens a dropdown on the choice in use, and Esc closes it", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ choice: "claude" });
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("options");
  expect(menu.cursor).toBe(0);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("enter change");
  expect(menu.enter(s, prefs)).toBeNull();
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/│ ✓ Claude /);
  expect(text).toContain("No summaries, plain links");
  expect(text).toContain("enter use");
  // The choice in use has nothing to apply.
  expect(menu.enter(s, prefs)).toBeNull();
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "off" });
  // Keys wrap past either end; the wheel stops there.
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  menu.move(true, s, prefs, false);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "off" });
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "auto" });
  // Clicks open it and choose.
  const row = hits(menu, 100, 30, s, prefs).find(hit => "option" in hit && hit.option === 0)!;
  expect(menu.click(row, s, prefs)).toBeNull();
  const codex = hits(menu, 100, 30, s, prefs).find(hit => "choice" in hit && hit.choice === "codex")!;
  expect(menu.click(codex, s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
  // Esc closes the dropdown, then returns to the list.
  menu.enter(s, prefs);
  expect(menu.back()).toBe(true);
  expect(menu.focus).toBe("options");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).not.toContain("✓");
  // The options wrap too.
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(1);
  menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(1);
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(0);
  expect(menu.back()).toBe(true);
  expect(menu.back()).toBe(false);
  menu.move(true, s, prefs);
  expect(menu.item).toBe("sleeping_corgis");
  for (let i = 0; i < 20; i++) menu.move(true, s, prefs, false);
  expect(menu.item).toBe(items.at(-1)!);
  menu.move(true, s, prefs);
  expect(menu.item).toBe("clever_corgi");
  menu.move(false, s, prefs);
  expect(menu.item).toBe(items.at(-1)!);
});

test("the automatic choice says whom it follows", () => {
  const menu = Menu.open(),
    prefs = new Preferences();
  let text = draw(
    menu,
    100,
    30,
    0,
    status({
      choice: "auto",
      provider: "claude",
      launches: { claude: 3, codex: 1 },
      models: { claude: "claude-haiku-5-5" },
    }),
  ).join("\n");
  expect(text).toContain("Following you → Claude · Haiku 5.5");
  expect(text).toContain("Since start: codex 1× · claude 3×");
  const locked = status({
    choice: "auto",
    provider: "codex",
    locked: true,
    models: { codex: "gpt-6-luna", claude: "claude-haiku-5-5" },
  });
  menu.openOptions(locked, prefs);
  menu.enter(locked, prefs);
  text = draw(menu, 100, 30, 0, locked, prefs).join("\n");
  expect(text).toContain("Settled on Codex · GPT-6 Luna");
  expect(text).toContain("Haiku 5.5 · your Claude login");
});

test("on/off settings flip from the list and offer the opposite", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "readings";
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("enter turn off");
  expect(menu.enter(s, prefs)).toEqual({ kind: "readings", on: false });
  expect(menu.focus).toBe("list");
  prefs.resources.enabled = false;
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toMatch(/Resources\s+Off/);
});

test("Command keys turn on and off under the keymap", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "keyboard";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/│ {2}Keymap +Corgi {2}│/);
  expect(text).toMatch(/│ {2}Keymap +│ *$/m);
  expect(text).toMatch(/⌘ Command keys +○ Off/);
  expect(text).toContain("Ghostty only, on this Mac; not over SSH.");
  // A mini keymap shows what the keys do.
  expect(text).toMatch(/New tab +⌘T/);
  expect(text).toMatch(/Select tab +⌘1–9/);
  // Where Ghostty isn't local, the cursor passes the switch by.
  menu.openOptions(s, prefs);
  for (let i = 0; i < 10; i++) menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(5);
  menu.integration = "disabled";
  menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(6);
  expect(menu.enter(s, prefs)).toEqual({ kind: "ghostty", on: true });
  menu.back();
  menu.integration = "enabled";
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/⌘ Command keys +● On/);
  expect(text).toContain("In Ghostty only, these keys drive Corgi:");
  // Ghostty asks for a reload only after a change.
  expect(text).not.toContain("Reload Ghostty");
  menu.reload_ghostty = true;
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Reload Ghostty with ⌘⇧, to apply.");
});

test("sleeping corgis preview both choices beside them", () => {
  const menu = Menu.open(),
    prefs = new Preferences();
  menu.item = "sleeping_corgis";
  const on = (now: number) => draw(menu, 100, 30, now, status(), prefs).find(row => row.includes("● On"))!;
  expect(on(0)).toContain("~ᐯ◡ᴥ◡ᐯ ᶻ");
  // Between puffs the preview rests without a Z.
  expect(on(corgiAnimation.puff_duration_ms)).not.toContain("ᶻ");
  const off = draw(menu, 100, 30, 0, status(), prefs).find(row => row.includes("○ Off"))!;
  expect(off).toContain("~ᐯ◡ᴥ◡ᐯ");
  expect(off).not.toContain("ᶻ");
});

test("the theme under the cursor previews until Enter keeps it", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "theme";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/Theme\s+Corgi\s+│/);
  expect(text).toMatch(/● Corgi\s+▶ ● ○  Corgi's own/);
  expect(text).toMatch(/○ Animal Style\s+▶ ● ○  your terminal's/);
  expect(menu.previewTheme(prefs)).toBe("corgi");
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.cursor).toBe(0);
  menu.move(true, s, prefs);
  expect(menu.previewTheme(prefs)).toBe("animal_style");
  expect(menu.enter(s, prefs)).toEqual({ kind: "theme", theme: "animal_style" });
  prefs.theme = "animal_style";
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toMatch(/Theme\s+Animal Style/);
  menu.move(false, s, prefs);
  expect(menu.previewTheme(prefs)).toBe("corgi");
  menu.back();
  expect(menu.previewTheme(prefs)).toBe("animal_style");
});

test("image paste explains whether this viewer can paste images", () => {
  const menu = Menu.open();
  menu.item = "image_paste";
  expect(draw(menu).join("\n")).toContain("This viewer has no terminal to paste from.");
  const clipboard = new ClipboardState();
  clipboard.support = "unsupported";
  menu.image_paste = clipboard;
  const text = draw(menu).join("\n");
  expect(text).toMatch(/Image paste\s+Off/);
  expect(text).toContain("○ no paste events");
});

test("shell options are the shell picker's entries", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.shell = shellPicker.status({
    path: "/bin/zsh",
    source: "account",
    default: "/bin/zsh",
    default_source: "account",
  });
  menu.shells = ["/bin/bash", "/bin/zsh"];
  menu.item = "shell";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/Shell\s+zsh/);
  expect(text).toContain("● Default   zsh · your account");
  expect(menu.enter(s, prefs)).toBeNull();
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "shell", entry: { path: "/bin/bash" } });
  menu.move(true, s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "shell", entry: "other" });
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("enter type a path");
  // Too short for every entry: the cursor's stays in view.
  const visible = hits(menu, 100, 12, s, prefs).filter(hit => "option" in hit);
  expect(visible.at(-1)).toEqual({ option: 3 });
});

test("shortcuts grow the frame into onboarding's preset detail", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "keyboard";
  menu.openOptions(s, prefs);
  // The growth starts with the first frame after Enter.
  let text = draw(menu, 140, 36, 1000, s, prefs).join("\n");
  expect(text).toContain("Sleeping corgis");
  expect(text).not.toContain("PREFIX");
  text = draw(menu, 140, 36, 1100, s, prefs).join("\n");
  expect(text).not.toContain("Sleeping corgis");
  expect(text).not.toContain("PREFIX");
  text = draw(menu, 140, 36, 2000, s, prefs).join("\n");
  expect(text).toContain("Corgi setup › Keymap");
  expect(text).toContain("PREFIX    [ Ctrl+B ]  Release, then press a key.");
  expect(text).toContain("[ ? Full keymap ]");
  expect(text).toContain("v Right");
  // The detail follows the preset under the cursor.
  menu.move(true, s, prefs);
  text = draw(menu, 140, 36, 2100, s, prefs).join("\n");
  expect(text).toContain("% Right");
  expect(text).toContain("○ tmux       Classic splits");
  expect(menu.enter(s, prefs)).toEqual({ kind: "preset", preset: "tmux" });
  // Clicks land on the grown frame's options.
  expect(hits(menu, 140, 36, s, prefs).filter(hit => "item" in hit)).toEqual([]);
  expect(menu.back()).toBe(true);
  text = draw(menu, 140, 36, 2200, s, prefs).join("\n");
  text = draw(menu, 140, 36, 3000, s, prefs).join("\n");
  expect(text).toContain("Sleeping corgis");
  expect(text).not.toContain("PREFIX");
});

test("without room for the preset detail, a line of keys stands in", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "keyboard";
  menu.openOptions(s, prefs);
  for (const [cols, rows] of [
    [64, 24],
    [100, 18],
  ]) {
    draw(menu, cols, rows, 0, s, prefs);
    const text = draw(menu, cols, rows, 1000, s, prefs).join("\n");
    expect(text).toContain("Ctrl+B then   c tab   v - split   h j k l focus");
    expect(text).not.toContain("PREFIX");
  }
});

test("each import source opens its sessions beside the list", async () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status(),
    worker = new Worker("tmux"),
    tab = (id: string, name: string) => ({ id, name, nodes: [], panes: [pane({ id, name })] });
  worker.done = true;
  worker.catalog.workspaces = [
    workspace({ id: "0", name: "corgi", tabs: [tab("1", "editor")] }),
    workspace({ id: "1", name: "notes", tabs: [tab("2", "shell")] }),
  ];
  menu.import_picker.workers.set("tmux", worker);
  menu.item = "import_tmux";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  // The sources sit under one heading.
  expect(text).toMatch(/│ {2}Import from +│/);
  expect(text).toMatch(/│ {4}Herdr +│/);
  // The pane's title row ends at the frame.
  expect(text).toMatch(/│ {2}Import from tmux +│ *$/m);
  expect(text).toContain("Copy sessions, scrollback and commands.");
  // The list keeps the cursor; the sessions show without one.
  expect(text).toContain(" [x] corgi");
  expect(text).not.toContain("›[x]");
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("options");
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("›[x] corgi");
  expect(text).toContain("enter import 2");
  // Space and clicks select; Enter asks the controller to copy.
  expect(menu.key(32)).toBe(true);
  expect(menu.import_picker.selectionCount()).toBe(1);
  const notes = hits(menu, 100, 30, s, prefs).find(
    hit => "picker" in hit && "select" in hit.picker && hit.picker.select === 1,
  );
  expect(notes).toBeDefined();
  expect(menu.click(notes!, s, prefs)).toBeNull();
  expect(menu.import_picker.cursor).toBe(1);
  expect(menu.import_picker.selectionCount()).toBe(0);
  expect(menu.enter(s, prefs)).toBeNull();
  menu.key(32);
  expect(menu.enter(s, prefs)).toEqual({ kind: "import" });
  // Setup stays on a copy until it ends, then opens what it made.
  const progress = {
    phase: "copying",
    completed: 0,
    total: 1,
    workspace: 7,
    message: "Creating workspaces and shells",
  };
  const conn: any = { call: async (op: string) => (op === "onboarding.status" ? { progress } : { ok: true }) };
  await menu.import_picker.begin(conn);
  expect(await menu.poll(conn)).toBe(true);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Copying into Corgi");
  expect(menu.back()).toBe(true);
  expect(menu.focus).toBe("options");
  progress.phase = "complete";
  menu.import_picker.last_poll = 0;
  await menu.poll(conn);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Import complete");
  expect(menu.enter(s, prefs)).toEqual({ kind: "imported", workspace: 7 });
  menu.deinit();
});

test("the frame takes the terminal's height, and a short list scrolls", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  let rows = draw(menu, 100, 40, 0, s, prefs);
  expect(rows.findIndex(row => row.includes("╭"))).toBe(1);
  expect(rows.findIndex(row => row.includes("╰"))).toBe(38);
  // Too short for every row: the selected item and its heading stay in view.
  menu.item = items.at(-1)!;
  rows = draw(menu, 100, 14, 0, s, prefs);
  let text = rows.join("\n");
  expect(text).toContain("Import from");
  expect(text).not.toContain("Clever Corgi");
  expect(text).toContain("┃");
  expect(hits(menu, 100, 14, s, prefs).filter(hit => "item" in hit)).toContainEqual({ item: items.at(-1)! });
  menu.move(true, s, prefs);
  text = draw(menu, 100, 14, 0, s, prefs).join("\n");
  expect(text).toContain("Clever Corgi");
  expect(text).not.toMatch(/│ {4}cmux|│ {4}Herdr/);
});
