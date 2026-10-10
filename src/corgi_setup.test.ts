import { expect, test } from "bun:test";
import { Menu, items, status, type Hit } from "./corgi_setup";
import * as shellPicker from "./shell_picker";
import { Preferences } from "./preferences";
import { State as ClipboardState } from "./host_clipboard";
import * as corgiAnimation from "./corgi_animation";
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
  expect(rows[top + 2]).toMatch(/Summaries\s+Claude\s+│\s+Activity summaries/);
  expect(rows.join("\n")).toContain("● Claude");
  expect(rows.join("\n")).toContain("↑↓ move   enter choose   esc close");
  // List rows and options are clickable, in order.
  const s = status({ choice: "claude" });
  const found = hits(menu, 100, 30, s);
  expect(found.filter(hit => "item" in hit)).toEqual(items.map(item => ({ item })));
  expect(found.filter(hit => "option" in hit)).toEqual([0, 1, 2, 3].map(option => ({ option })));
  expect(menu.hit(100, 30, 0, 0, s, new Preferences())).toBeNull();
  expect(menu.contains(100, 30, 50, top + 1)).toBe(true);
  // Too small for the frame: nothing draws.
  expect(draw(menu, 20, 8).join("").trim()).toBe("");
});

test("Enter opens a setting's options on the one in use, and Esc returns", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ choice: "claude" });
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("options");
  expect(menu.cursor).toBe(2);
  // The option in use has nothing to apply.
  expect(menu.enter(s, prefs)).toBeNull();
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "off" });
  // Keys wrap past either end; the wheel stops there.
  menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(3);
  menu.move(true, s, prefs);
  expect(menu.cursor).toBeLessThan(2);
  menu.move(false, s, prefs);
  expect(menu.cursor).toBe(3);
  expect(draw(menu, 100, 30, 0, s).join("\n")).toContain("Activity text stays blank; links say Open Link");
  expect(menu.back()).toBe(true);
  expect(menu.back()).toBe(false);
  menu.move(true, s, prefs);
  expect(menu.item).toBe("sleeping_corgis");
  for (let i = 0; i < 20; i++) menu.move(true, s, prefs, false);
  expect(menu.item).toBe("import");
  menu.move(true, s, prefs);
  expect(menu.item).toBe("summaries");
  menu.move(false, s, prefs);
  expect(menu.item).toBe("import");
});

test("the automatic choice says whom it follows", () => {
  const menu = Menu.open();
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
  text = draw(
    menu,
    100,
    30,
    0,
    status({
      choice: "auto",
      provider: "codex",
      locked: true,
      models: { codex: "gpt-6-luna", claude: "claude-haiku-5-5" },
    }),
  ).join("\n");
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
  // Command keys can't change where Ghostty isn't local.
  menu.item = "ghostty";
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("list");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Mac only");
  menu.integration = "disabled";
  expect(menu.enter(s, prefs)).toEqual({ kind: "ghostty", on: true });
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
  expect(text).toContain("Summaries");
  expect(text).not.toContain("PREFIX");
  text = draw(menu, 140, 36, 1100, s, prefs).join("\n");
  expect(text).not.toContain("Summaries");
  expect(text).not.toContain("PREFIX");
  text = draw(menu, 140, 36, 2000, s, prefs).join("\n");
  expect(text).toContain("Corgi setup › Shortcuts");
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
  expect(text).toContain("Summaries");
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
