// Mirrors the tests in corgi_setup.zig.
import { expect, test } from "bun:test";
import { Menu, choices, status, testing, type Choice } from "./corgi_setup";
import * as shellPicker from "./shell_picker";
import { Preferences } from "./preferences";
import { State as ClipboardState } from "./host_clipboard";
import * as corgiAnimation from "./corgi_animation";
import { Writer, displayWidth } from "./text";

function rowOf(cols: number, rows: number, choice: Choice): number | null {
  const b = Menu.bounds(cols, rows);
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) if (Menu.hit(cols, rows, x, y) === choice) return y;
  return null;
}

test("setup modal is centered and its rows are clickable inside the frame", () => {
  const b = Menu.bounds(100, 30);
  expect(b.x).toBe(Math.floor((100 - b.w) / 2));
  expect(b.y).toBe(Math.floor((30 - b.h) / 2));
  const auto = rowOf(100, 30, "auto")!;
  expect(rowOf(100, 30, "off")).toBe(auto + 3);
  expect(rowOf(100, 30, "off")!).toBeLessThan(rowOf(100, 30, "ghostty")!);
  expect(rowOf(100, 30, "ghostty")!).toBeLessThan(rowOf(100, 30, "keyboard")!);
  expect(rowOf(100, 30, "readings")!).toBeLessThan(rowOf(100, 30, "sleeping_corgis")!);
  expect(rowOf(100, 30, "sleeping_corgis")!).toBeLessThan(rowOf(100, 30, "shell")!);
  expect(rowOf(100, 30, "shell")!).toBeLessThan(rowOf(100, 30, "keyboard")!);
  expect(rowOf(100, 30, "import")).toBe(rowOf(100, 30, "keyboard")! + 1);
  expect(Menu.hit(100, 30, b.x + 6, b.y + 2)).toBeNull();
  expect(Menu.hit(100, 30, b.x, auto)).toBeNull();
  // Short terminals drop spacer rows but keep every choice reachable.
  for (const choice of choices) expect(rowOf(80, testing.heightFor("minimal"), choice)).not.toBeNull();
  const menu = Menu.open(status({ choice: "claude" }));
  menu.move(true);
  expect(menu.selected).toBe("off");
  menu.move(true);
  expect(menu.selected).toBe("ghostty");
  for (let i = 0; i < 20; i++) menu.move(true);
  expect(menu.selected).toBe("import");
  menu.selected = "auto";
  menu.move(false);
  expect(menu.selected).toBe("auto");
});

test("setup modal explains the automatic choice", () => {
  const menu = Menu.open(status());
  let w = new Writer();
  menu.draw(
    w,
    status({
      choice: "auto",
      provider: "claude",
      launches: { claude: 3, codex: 1 },
      models: { claude: "claude-haiku-5-5" },
    }),
    new Preferences(),
    100,
    30,
  );
  expect(w.s).toContain("Following you → Claude · Haiku 5.5");
  expect(w.s).toContain("Since start: codex 1× · claude 3×");
  expect(w.s).toContain("[ Enter Keep ]");
  w = new Writer();
  menu.draw(
    w,
    status({
      choice: "auto",
      provider: "codex",
      locked: true,
      model: "gpt-6-luna",
      models: { codex: "gpt-6-luna", claude: "claude-haiku-5-5" },
    }),
    new Preferences(),
    100,
    30,
  );
  expect(w.s).toContain("Settled on Codex · GPT-6 Luna");
  expect(w.s).toContain("GPT-6 Luna · your Codex login");
  expect(w.s).toContain("Haiku 5.5 · your Claude login");
  expect(w.s).toContain("ᐯoᴥ°ᐯ");
  expect(displayWidth("ᐯoᴥ°ᐯ")).toBe([..."ᐯoᴥ°ᐯ"].length);
  w = new Writer();
  menu.draw(w, status(), new Preferences(), 20, 8);
  expect(w.s.length).toBe(0);
});

test("resource readings are one on/off row", () => {
  const menu = Menu.open(status());
  const prefs = new Preferences();
  menu.selected = "readings";
  let w = new Writer();
  menu.drawAt(w, status(), prefs, 100, 40, 0);
  expect(w.s).toContain("Resource readings");
  expect(w.s).toContain("[ Enter Turn off ]");
  expect(w.s).not.toContain("[x]");
  menu.move(true);
  expect(menu.selected as string).toBe("sleeping_corgis");
  menu.selected = "readings";
  prefs.resources.enabled = false;
  w = new Writer();
  menu.drawAt(w, status(), prefs, 100, 40, 0);
  expect(w.s).toContain("[ Enter Turn on ]");
});

test("sleeping corgis row shows its state, offers the opposite, and naps beside the label", () => {
  const menu = Menu.open(status());
  const prefs = new Preferences();
  menu.selected = "sleeping_corgis";
  let w = new Writer();
  menu.drawAt(w, status(), prefs, 100, 40, 0);
  expect(w.s).toContain("Sleeping corgis");
  expect(w.s).toContain("● On");
  expect(w.s).toContain("[ Enter Turn off ]");
  expect(w.s).toContain("~ᐯ◡ᴥ◡ᐯ");
  expect(w.s).toContain("ᶻ");
  // Between puffs the preview rests without a Z.
  w = new Writer();
  menu.drawAt(w, status(), prefs, 100, 40, corgiAnimation.puff_duration_ms);
  expect(w.s).not.toContain("ᶻ");
  prefs.sleeping_corgis = false;
  w = new Writer();
  menu.drawAt(w, status(), prefs, 100, 40, 0);
  expect(w.s).toContain("○ Off");
  expect(w.s).toContain("[ Enter Turn on ]");
  expect(w.s).toContain("~ᐯ◡ᴥ◡ᐯ");
  expect(w.s).not.toContain("ᶻ");
});

test("a viewer sees whether it can paste images", () => {
  const menu = Menu.open(status());
  let w = new Writer();
  menu.drawAt(w, status(), new Preferences(), 100, 40, 0);
  expect(w.s).not.toContain("Image paste");
  const clipboard = new ClipboardState();
  clipboard.support = "unsupported";
  menu.image_paste = clipboard;
  w = new Writer();
  menu.drawAt(w, status(), new Preferences(), 100, 40, 0);
  expect(w.s).toContain("Image paste");
  expect(w.s).toContain("○ no paste events");
});

test("the shell row opens a picker in the same frame", () => {
  const menu = Menu.open(status());
  menu.shell = shellPicker.status({
    path: "/bin/zsh",
    source: "account",
    default: "/bin/zsh",
    default_source: "account",
  });
  menu.selected = "shell";
  let w = new Writer();
  menu.drawAt(w, status(), new Preferences(), 100, 40, 0);
  expect(w.s).toContain("zsh · your account  →");
  expect(w.s).toContain("New panes and splits start in this login shell");
  expect(w.s).toContain("[ Enter Open → ]");
  menu.picker = shellPicker.Picker.open(menu.shell, ["/bin/bash", "/bin/zsh"]);
  w = new Writer();
  menu.drawAt(w, status(), new Preferences(), 100, 40, 0);
  expect(w.s).toContain("Shell for new panes");
  expect(w.s).not.toContain("Activity summaries");
  expect(w.s).toContain("[ Enter Keep ]");
  // Rows are clickable inside the frame, in entry order.
  const hits: number[] = [];
  for (let y = 0; y < 40; y++) {
    const hit = menu.pickerHit(100, 40, 50, y);
    if (hit !== null) hits.push(hit);
  }
  expect(hits).toEqual([0, 1, 2, 3]);
  expect(menu.pickerContains(100, 40, 50, 0)).toBe(false);
  // Too short for every entry: the selected one stays in view.
  menu.picker.selected = 3;
  const visible: number[] = [];
  for (let y = 0; y < 6; y++) {
    const hit = menu.pickerHit(100, 6, 50, y);
    if (hit !== null) visible.push(hit);
  }
  expect(visible).toEqual([2, 3]);
});
