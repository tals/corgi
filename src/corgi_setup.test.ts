import { expect, test } from "bun:test";
import * as i18n from "./i18n";
import { Terminal } from "./pane/terminal";
import { Menu, items, status, type Hit } from "./corgi_setup";
import { Menu as LauncherMenu, preferred_width, preview } from "./agent_launcher";
import { Rect } from "./layout";
import * as shellPicker from "./shell_picker";
import { Preferences } from "./preferences";
import { State as ClipboardState } from "./host_clipboard";
import { Pacer } from "./frame_pacing";
import * as corgiAnimation from "./corgi_animation";
import * as km from "./keymap";
import { Worker, pane, workspace } from "./import/catalog";
import { Writer } from "./text";
import * as releaseLabel from "./release_label";
import type { Connection } from "./rpc";
import { Style } from "./palette";

/** The screen's text after replaying the cursor moves in `ansi`. */
function screen(ansi: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (const m of ansi.matchAll(/\x1b\[([\d;?]*)([A-Za-z])|\x1b\][^\x1b]*\x1b\\|([\s\S])/gu)) {
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
/** The open model picker's hit at the first match of `match` on screen. */
function modelHit(
  menu: Menu,
  match: RegExp,
  s: ReturnType<typeof status>,
  prefs: Preferences,
  cols = 100,
  rows = 30,
): Hit {
  const screen = draw(menu, cols, rows, 0, s, prefs),
    y = screen.findIndex(row => match.test(row));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = screen[y].search(match),
    hit = menu.hit(cols, rows, x, y, s, prefs);
  expect(hit).toEqual({ models: { x, y } });
  return hit!;
}

const no_setup_rpc: Pick<Connection, "call"> = {
  call: async () => {
    throw new Error("Unexpected setup RPC");
  },
};

test("entering a visible Clever Corgi pane starts discovery asynchronously, not on each picker open", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences(),
    requests: string[] = [],
    conn = {
      async call(op: string, ..._args: unknown[]) {
        requests.push(op);
        return new Promise<never>(() => {});
      },
    };
  await menu.poll(conn, 100, 30);
  expect(requests).toEqual(["inference.configure"]);
  await menu.poll(conn, 100, 30);
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  await menu.poll(conn, 100, 30);
  menu.back();
  menu.enter(s, prefs);
  await menu.poll(conn, 100, 30);
  expect(requests).toHaveLength(1);
  menu.back();
  menu.item = "keyboard";
  await menu.poll(conn, 100, 30);
  menu.item = "clever_corgi";
  await menu.poll(conn, 100, 30);
  expect(requests).toHaveLength(2);
});

test("narrow setup doesn't discover models until Clever Corgi's options are actually visible", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences(),
    requests: string[] = [],
    conn = {
      async call(op: string, ..._args: unknown[]) {
        requests.push(op);
        return new Promise<never>(() => {});
      },
    };
  await menu.poll(conn, 50, 30);
  expect(requests).toHaveLength(0);
  menu.item = "keyboard";
  menu.openOptions(s, prefs);
  await menu.poll(conn, 50, 30);
  expect(requests).toHaveLength(0);
  menu.item = "clever_corgi";
  await menu.poll(conn, 50, 30);
  expect(requests).toEqual(["inference.configure"]);
});

test("setup keeps its options while aiming diagonally across list rows and gaps", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  const hover = (x: number, y: number, now: number) => menu.hover(100, 30, x, y, s, prefs, now);
  hover(15, 3, 0);
  // Resting on the selected row does not spend the crossing's grace period.
  await menu.poll(no_setup_rpc, 100, 30, 1000);
  for (const [x, y, now] of [
    [22, 4, 1100],
    [28, 5, 1200],
    [30, 6, 1300],
    [34, 7, 1400],
  ]) {
    hover(x, y, now);
    expect(menu.item).toBe("clever_corgi");
  }
  // The divider and blank space in the options cancel a pending list hover.
  hover(35, 7, 1450);
  hover(36, 7, 1500);
  expect(await menu.poll(no_setup_rpc, 100, 30, 2000)).toBe(false);
  expect(menu.item).toBe("clever_corgi");
  // Up and to the right, toward Keymap's options, crosses Shell.
  hover(25, 10, 2100);
  expect(menu.item).toBe("keyboard");
  hover(30, 9, 2200);
  expect(menu.item).toBe("keyboard");
  hover(36, 7, 2300);
  expect(menu.item).toBe("keyboard");
});

test("setup selects the crossed row when the pointer pauses", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  menu.hover(100, 30, 15, 3, s, prefs, 0);
  menu.hover(100, 30, 22, 4, s, prefs, 100);
  expect(await menu.poll(no_setup_rpc, 100, 30, 399)).toBe(false);
  expect(menu.item).toBe("clever_corgi");
  expect(await menu.poll(no_setup_rpc, 100, 30, 400)).toBe(true);
  expect(menu.item).toBe("flourishes");
});

test("vertical setup browsing selects every row immediately in both directions", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  for (const [y, item] of [
    [3, "clever_corgi"],
    [4, "flourishes"],
    [5, "readings"],
    [4, "flourishes"],
    [3, "clever_corgi"],
  ] as const) {
    menu.hover(100, 30, 15, y, s, prefs, 100);
    expect(menu.item).toBe(item);
  }
  expect(await menu.poll(no_setup_rpc, 100, 30, 500)).toBe(false);
});

test("setup keeps its options across the single-cell steps a terminal reports", () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  let now = 0;
  menu.hover(100, 30, 15, 3, s, prefs, now);
  // Two columns right, then a row straight down, until the options.
  for (let x = 16, y = 3; x <= 36; x++) {
    menu.hover(100, 30, x, y, s, prefs, (now += 16));
    if (x % 2 === 1 && x < 35) menu.hover(100, 30, x, ++y, s, prefs, (now += 16));
    expect(menu.item).toBe("clever_corgi");
  }
});

test("setup tells a column of drift down the list from a turn toward the options", () => {
  const s = status(),
    prefs = new Preferences();
  for (const [steps, item] of [
    // Drifting a column right on the way down the list keeps browsing.
    [
      [
        [16, 4, 45],
        [16, 5, 60],
      ],
      "readings",
    ],
    // Pausing on the row first, or moving two columns right, turns toward the options.
    [
      [
        [16, 4, 500],
        [16, 5, 516],
      ],
      "flourishes",
    ],
    [
      [
        [16, 4, 40],
        [17, 4, 50],
        [17, 5, 60],
      ],
      "flourishes",
    ],
  ] as const) {
    const menu = Menu.open();
    menu.hover(100, 30, 15, 3, s, prefs, 0);
    menu.hover(100, 30, 15, 4, s, prefs, 30);
    for (const [x, y, now] of steps) menu.hover(100, 30, x, y, s, prefs, now);
    expect(menu.item).toBe(item);
  }
});

test("turning straight down drops the setup guard on the second row", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  menu.hover(100, 30, 15, 3, s, prefs, 0);
  menu.hover(100, 30, 16, 3, s, prefs, 100);
  // One step straight down may be the path bending toward the options.
  menu.hover(100, 30, 16, 4, s, prefs, 150);
  expect(menu.item).toBe("clever_corgi");
  menu.hover(100, 30, 16, 5, s, prefs, 200);
  expect(menu.item).toBe("readings");
  expect(await menu.poll(no_setup_rpc, 100, 30, 500)).toBe(false);
});

/** A pointer's single-cell reports along a straight line between two cells. */
function walk(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [],
    n = 64 * Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 1; i <= n; i++) {
    const x = Math.floor(x0 + 0.5 + ((x1 - x0) * i) / n),
      y = Math.floor(y0 + 0.5 + ((y1 - y0) * i) / n),
      [lx, ly] = out.at(-1) ?? [x0, y0];
    if (x !== lx || y !== ly) out.push([x, y]);
  }
  return out;
}

test("setup aims only at the options a click acts on", () => {
  const s = status(),
    prefs = new Preferences();
  // Visual flourishes' sliders sit on rows 7 to 8 and 22 to 23, its preview
  // between them; nothing below them takes a click.
  for (const [y, kept] of [
    [8, true],
    [26, false],
  ] as const) {
    const menu = Menu.open();
    menu.hover(100, 30, 15, 4, s, prefs, 0);
    menu.hover(100, 30, 16, 4, s, prefs, 200);
    let now = 200;
    for (const [x, row] of walk(16, 4, 35, y)) menu.hover(100, 30, x, row, s, prefs, (now += 16));
    expect(menu.item === "flourishes").toBe(kept);
  }
  // Terminal capabilities has nothing to click, so nothing guards it.
  const menu = Menu.open();
  menu.hover(100, 30, 15, 15, s, prefs, 0);
  menu.hover(100, 30, 22, 11, s, prefs, 100);
  expect(menu.item).toBe("source_control");
});

test("setup stops guarding when moving away, leaving the frame, or resizing", async () => {
  const s = status(),
    prefs = new Preferences();
  for (const end of ["back", "outside", "resize", "vertical"] as const) {
    const menu = Menu.open();
    menu.hover(100, 30, 15, 3, s, prefs, 0);
    menu.hover(100, 30, 22, 4, s, prefs, 100);
    switch (end) {
      case "back":
        menu.hover(100, 30, 21, 4, s, prefs, 200);
        break;
      case "outside":
        menu.hover(100, 30, 0, 0, s, prefs, 200);
        break;
      case "resize":
        menu.hover(102, 30, 23, 4, s, prefs, 200);
        break;
      case "vertical":
        menu.hover(100, 30, 15, 3, s, prefs, 150);
        menu.hover(100, 30, 15, 7, s, prefs, 200);
        break;
    }
    expect(menu.item).toBe(end === "outside" ? "clever_corgi" : end === "vertical" ? "theme" : "flourishes");
    expect(await menu.poll(no_setup_rpc, 100, 30, 500)).toBe(false);
  }
});

test("setup clicks and keyboard navigation override a guarded hover", async () => {
  const s = status(),
    prefs = new Preferences();
  for (const action of ["click", "move", "options"] as const) {
    const menu = Menu.open();
    menu.hover(100, 30, 15, 3, s, prefs, 0);
    menu.hover(100, 30, 28, 5, s, prefs, 100);
    if (action === "click") menu.click({ item: "theme" }, s, prefs);
    else if (action === "move") menu.move(true, s, prefs);
    else menu.openOptions(s, prefs);
    expect(await menu.poll(no_setup_rpc, 100, 30, 500)).toBe(false);
    expect(menu.item).toBe(action === "click" ? "theme" : action === "move" ? "flourishes" : "clever_corgi");
  }
});

test("resizing setup cancels a pending row even without further pointer motion", async () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  menu.hover(100, 30, 15, 3, s, prefs, 0);
  menu.hover(100, 30, 22, 4, s, prefs, 100);
  expect(await menu.poll(no_setup_rpc, 60, 30, 500)).toBe(false);
  expect(menu.item).toBe("clever_corgi");
});

test("single-column setup hovers immediately", () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  menu.hover(60, 30, 15, 3, s, prefs, 0);
  menu.hover(60, 30, 22, 4, s, prefs, 100);
  expect(menu.item).toBe("flourishes");
});

test("setup lists every setting beside the selected one's options", () => {
  const menu = Menu.open();
  const rows = draw(menu, 100, 30, 0, status({ choice: "claude" }));
  const top = rows.findIndex(row => row.includes("Corgi setup"));
  expect(rows[top].indexOf("╭")).toBe(8);
  expect(rows[top + 2]).toMatch(/Clever Corgi\s+│\s+Clever Corgi/);
  expect(rows.join("\n")).toMatch(/Model +● Claude ▾/);
  for (const use of ["Activity summaries", "Worktree briefs", "Smart Links", "Auto-retry capacity errors"])
    expect(rows.join("\n")).toMatch(new RegExp(`${use} +● On`));
  expect(rows.join("\n")).toContain("↑↓ move   enter choose   esc close");
  // List rows and options are clickable, in order.
  const s = status({ choice: "claude" });
  const found = hits(menu, 100, 30, s);
  expect(found.filter(hit => "item" in hit)).toEqual(items.map(item => ({ item })));
  expect(found.filter(hit => "option" in hit)).toEqual([0, 1, 2, 3, 4].map(option => ({ option })));
  expect(menu.hit(100, 30, 0, 0, s, new Preferences())).toBeNull();
  expect(menu.contains(100, 30, 50, top + 1)).toBe(true);
  // Too small for the frame: nothing draws.
  expect(draw(menu, 20, 8).join("").trim()).toBe("");
});

test("the top border says when the build was made and links its commit", () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences(),
    commit = "be82c7b9090a" + "0".repeat(28);
  menu.release = releaseLabel.of("0.1.0-dev", commit, new Date(2026, 8, 25, 18, 30).toISOString());
  let rows = draw(menu, 100, 30, 0, s, prefs);
  const top = rows.findIndex(row => row.includes("Corgi setup"));
  expect(rows[top]).toMatch(/Corgi setup ─+┬─+ Build: 2026-09-25 18:30 · be82c7b ─╮/);
  const w = new Writer();
  menu.drawAt(w, s, prefs, 100, 30, 0);
  expect(w.s).toContain(`\x1b]8;;https://github.com/tals/corgi/commit/${commit}\x1b\\\x1b[4mbe82c7b`);
  // Only the commit takes a click, which opens it.
  const x = rows[top].indexOf("be82c7b"),
    url = `https://github.com/tals/corgi/commit/${commit}`;
  expect(menu.hit(100, 30, x - 2, top, s, prefs)).toBeNull();
  expect(menu.hit(100, 30, x + 6, top, s, prefs)).toEqual({ url });
  expect(menu.hit(100, 30, x + 7, top, s, prefs)).toBeNull();
  expect(menu.click({ url }, s, prefs)).toEqual({ kind: "open", url });
  // A development build's dirty mark sits outside the link.
  menu.release = releaseLabel.of("0.1.0-dev", "0123abcdef45-dirty", new Date(2026, 9, 12, 14, 3).toISOString());
  rows = draw(menu, 100, 30, 0, s, prefs);
  expect(rows[top]).toContain("─ Build: 2026-10-12 14:03 · 0123abc-dirty ─╮");
  // A narrow frame keeps the crumb and drops the release.
  menu.release = releaseLabel.of("20260925T183012Z-be82c7b9090a", commit);
  menu.openOptions(s, prefs);
  rows = draw(menu, 50, 30, 0, s, prefs);
  expect(rows.join("\n")).toContain("Corgi setup › Clever Corgi");
  expect(rows.join("\n")).not.toContain("be82c7b");
});

test("translated setup titles and chart labels leave their borders intact", () => {
  const previous = i18n.language();
  try {
    for (const language of i18n.locales) {
      i18n.setLanguage(language);
      const menu = Menu.open(),
        s = status(),
        prefs = new Preferences();
      menu.openOptions(s, prefs);
      const narrow = new Terminal(50, 30),
        chart = new Terminal(80, 40);
      try {
        let w = new Writer();
        menu.drawAt(w, s, prefs, 50, 30, 0);
        narrow.feed(w.s);
        expect(narrow.text()).toContain(`${i18n.t`Corgi setup`} › ${i18n.t`Clever Corgi`}`);
        menu.item = "terminal";
        menu.pacing = new Pacer();
        menu.pacing.stamp(1000);
        menu.pacing.answered(1024);
        w = new Writer();
        menu.drawAt(w, s, prefs, 80, 40, 0);
        chart.feed(w.s);
        const axis = chart
          .text()
          .split("\n")
          .find(row => row.includes("└─"))!;
        expect(axis).toContain(i18n.t` now`);
        expect(axis.slice(axis.indexOf(i18n.t` now`) + i18n.t` now`.length)).toMatch(/^\s*│\s*$/);
      } finally {
        narrow.destroy();
        chart.destroy();
      }
    }
  } finally {
    i18n.setLanguage(previous);
  }
});

test("Model opens the prompt's model picker on the choice in use, and Left closes it", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "codex",
      provider: "codex",
      model: "gpt-6-luna",
      models: { codex: "gpt-6-luna", claude: "claude-haiku-5-5" },
    });
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("options");
  expect(menu.cursor).toBe(0);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("enter change");
  expect(menu.modelSearch()).toBeNull();
  expect(menu.enter(s, prefs)).toBeNull();
  const rows = draw(menu, 100, 30, 0, s, prefs),
    top = rows.findIndex(row => row.includes("✦  Auto"));
  // The search field, Auto, then the model in use under its agent, highlighted, and a quick
  // one on the other agent. Each is its agent's own choice for now, which picking it follows.
  expect(rows.slice(top - 2, top + 6).map(row => row.slice(26, 90))).toEqual([
    "╭──────────────────────────────────────────────────────────────╮",
    "│  /  Search models, agents and accounts             2 models  │",
    "│ ✦  Auto                                   Follow your agents │",
    "│ †  Codex                                                     │",
    "│      ✓ GPT-6 Luna                                       auto │",
    "│ *  Claude                                                    │",
    "│        Haiku 5.5                                        auto │",
    "╰─ ⏎ pick · esc close ─────────────────────────────────────────╯",
  ]);
  // Turning things off is up to each use's own switch.
  expect(rows.join("\n")).not.toContain("No summaries");
  expect(rows.join("\n")).toContain("/ search   ↑↓ move   enter use   ← back   esc close");
  expect(menu.modelSearch()?.name()).toBe("");
  // The model in use has nothing to apply, and picking closes the picker.
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.modelSearch()).toBeNull();
  // Keys wrap past either end; Space picks too.
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "claude" });
  menu.enter(s, prefs);
  menu.move(false, s, prefs);
  expect(menu.key(32)).toBe(false);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "auto" });
  menu.enter(s, prefs);
  // A click on the search field starts a search rather than picking.
  expect(menu.click(modelHit(menu, /Search models/, s, prefs), s, prefs)).toBeNull();
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("esc back");
  expect(menu.back()).toBe(true);
  expect(menu.modelSearch()?.name()).toBe("");
  // Clicks open it and choose.
  expect(menu.back()).toBe(true);
  const row = hits(menu, 100, 30, s, prefs).find(hit => "option" in hit && hit.option === 0)!;
  expect(menu.click(row, s, prefs)).toBeNull();
  expect(menu.click(modelHit(menu, /Haiku 5\.5/, s, prefs), s, prefs)).toEqual({ kind: "summaries", choice: "claude" });
  // A click elsewhere in setup only closes it.
  menu.enter(s, prefs);
  expect(menu.click({ item: "theme" }, s, prefs)).toBeNull();
  expect(menu.item).toBe("clever_corgi");
  expect(menu.modelSearch()).toBeNull();
  // Left closes the picker, then returns to the list.
  menu.enter(s, prefs);
  expect(menu.sequence("\x1b[D")).toBe(false);
  expect(menu.back()).toBe(true);
  expect(menu.focus).toBe("options");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).not.toContain("✦");
  // The options wrap too: the model, two uses, Smart Links and auto-retry.
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(1);
  for (let i = 0; i < 6; i++) menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(4);
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(0);
  expect(menu.back()).toBe(true);
  expect(menu.back()).toBe(false);
  menu.move(true, s, prefs);
  expect(menu.item).toBe("flourishes");
  for (let i = 0; i < 20; i++) menu.move(true, s, prefs, false);
  expect(menu.item).toBe(items.at(-1)!);
  menu.move(true, s, prefs);
  expect(menu.item).toBe("clever_corgi");
  menu.move(false, s, prefs);
  expect(menu.item).toBe(items.at(-1)!);
});

test("typing and pasting search every model of every account; Esc leaves the search first", () => {
  const menu = Menu.open(),
    prefs = new Preferences();
  const available = Array.from({ length: 30 }, (_, i) => ({
    provider: "pi",
    model: `custom/model-${i}`,
    name: `Model ${i}`,
    account: "/pi/work",
    account_name: "Work",
  }));
  const s = status({ choice: "pi", provider: "pi", model: "custom/model-0", account: "/pi/work", available });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("32 models");
  expect(text).not.toContain("Model 29");
  for (const byte of Buffer.from("WORK model-29")) expect(menu.key(byte)).toBe(true);
  expect(menu.modelSearch()?.name()).toBe("WORK model-29");
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Model 29");
  expect(text).not.toContain("Model 28");
  expect(text).toContain("1 of 32");
  expect(text).toContain("type search   ↑↓ move   enter use   esc back");
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "custom/model-29",
    account: "/pi/work",
  });
  // A pasted line searches, its break a space.
  menu.enter(s, prefs);
  for (const byte of Buffer.from("no-such\nmodel")) menu.paste(byte);
  expect(menu.modelSearch()?.name()).toBe("no-such model");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("No models match");
  expect(menu.escape()).toBe(true);
  expect(menu.modelSearch()?.name()).toBe("");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("⏎ pick · esc close");
  // Outside a search, Esc is setup's, which closes.
  expect(menu.escape()).toBe(false);
  // Left keeps a search, and leaves an empty one.
  menu.key(47);
  menu.key("m".charCodeAt(0));
  expect(menu.sequence("\x1b[D")).toBe(true);
  menu.key(127);
  expect(menu.sequence("\x1b[D")).toBe(false);
});

test("the wheel scrolls a long search, and hovers and clicks pick the model under the pointer", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "pi",
      provider: "pi",
      model: "openai-codex/model-0",
      account: "/personal",
      selection: { provider: "pi", model: "openai-codex/model-0", account: "/personal" },
      available: Array.from({ length: 40 }, (_, i) => ({
        provider: "pi",
        model: `${i === 0 ? "openai-codex" : "github-copilot"}/model-${i}`,
        name: `Model ${i}`,
        account: i === 0 ? "/personal" : "/work",
        account_name: i === 0 ? "personal@example.com" : "work@example.com",
        plan: i === 0 ? "Pro 500" : "Business",
        subscription: true,
      })),
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  for (const byte of Buffer.from("work")) menu.key(byte);
  let rows = draw(menu, 100, 24, 0, s, prefs);
  expect(rows.join("\n")).not.toContain("Model 20");
  // A source's heading says where its models are routed, who it's signed in as and the plan.
  expect(rows.join("\n")).toMatch(/π  Pi · GitHub Copilot\s+work@example\.com\s+Business/);
  for (let i = 0; i < 12; i++) menu.move(true, s, prefs, false);
  rows = draw(menu, 100, 24, 0, s, prefs);
  expect(rows.join("\n")).toContain("Model 20");
  const y = rows.findIndex(row => /Model 20\b/.test(row));
  menu.hover(100, 24, rows[y].indexOf("Model 20"), y, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "github-copilot/model-20",
    account: "/work",
  });
  menu.enter(s, prefs);
  for (const byte of Buffer.from("work")) menu.key(byte);
  draw(menu, 100, 24, 0, s, prefs);
  for (let i = 0; i < 12; i++) menu.move(true, s, prefs, false);
  expect(menu.click(modelHit(menu, /Model 21\b/, s, prefs, 100, 24), s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "github-copilot/model-21",
    account: "/work",
  });
});

test("headers show each agent's mark and its account's plan and limits; rows what's true of the model alone", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "codex",
      models: { codex: "gpt-6-luna", claude: "claude-haiku-5-5" },
      available: [
        {
          provider: "pi",
          model: "openai-codex/luna",
          name: "GPT-6 Luna",
          account: "",
          account_name: "Personal",
          plan: "Pro 500",
          subscription: true,
        },
        {
          provider: "opencode2",
          model: "github-copilot/flash",
          name: "MAI-Code-1.1-Flash",
          account: "",
          account_name: "Work",
          plan: "Business",
          subscription: true,
        },
      ],
    });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    options: {
      codex: {
        account: "Personal",
        plan: "Pro",
        signed_in: true,
        limits: {
          windows: [
            { minutes: 10080, used: 48 },
            { minutes: 300, used: 12 },
          ],
        },
      },
      claude: { account: "Work", signed_in: true, limits: "metered" },
    },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 100, 30, 0, s, prefs),
    top = rows.findIndex(row => row.includes("✦  Auto"));
  // A routed source heads its models as its agent does, so the columns make room for its name.
  expect(rows.slice(top, top + 9).map(row => row.slice(26, 90))).toEqual([
    "│ ✦  Auto                                   Follow your agents │",
    "│ †  Codex                           Pro       5h 12% · 7d 48% │",
    "│      ✓ GPT-6 Luna                                       auto │",
    "│ *  Claude                                            Metered │",
    "│        Haiku 5.5                                        auto │",
    "│ π  Pi · OpenAI Codex               Pro 500                   │",
    "│        GPT-6 Luna                                       auto │",
    "│ o  OpenCode · GitHub Copilot       Business                  │",
    "│        MAI-Code-1.1-Flash                               auto │",
  ]);
  const writer = new Writer();
  menu.drawAt(writer, s, prefs, 100, 30, 0);
  expect(writer.s).toContain(new Style({ fg: "strong", bg: "selected" }).sgr() + "GPT-6 Luna");
});

test("a launcher account that is signed out says so in its brief", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ choice: "claude", models: { codex: "gpt-6-luna" } });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    options: {
      codex: { plan: "Pro", signed_in: true, limits: { windows: [{ minutes: 300, used: 30 }, null] } },
      claude: { signed_in: false },
    },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/\*  Claude\s+Signed out │/);
  expect(text).toMatch(/Haiku 5\.5\s+auto │/);
  expect(text).toMatch(/†  Codex\s+Pro\s+5h 30% │/);
  expect(text).toMatch(/GPT-6 Luna\s+auto │/);
});

test("a provider's recommended model follows the provider's choice, and picking it again stops keeping to one", () => {
  const prefs = new Preferences(),
    available = [
      {
        provider: "claude",
        model: "claude-haiku-5-5",
        name: "Haiku 5.5",
        account: "",
        ready: true,
        subscription: true,
      },
      { provider: "claude", model: "claude-sonnet-5-5", name: "Sonnet 5.5", account: "", subscription: true },
      { provider: "claude", model: "claude-opus-5-5", name: "Opus 5.5", account: "", subscription: true },
    ],
    pinned = (model: string) =>
      status({
        choice: "claude",
        provider: "claude",
        model,
        launches: { claude: 2 },
        selection: { provider: "claude", model, account: "" },
        available,
      }),
    open = (s: ReturnType<typeof status>) => {
      const menu = Menu.open();
      menu.enter(s, prefs);
      menu.enter(s, prefs);
      return menu;
    };
  // Kept to Opus, Haiku follows Claude's choice.
  let s = pinned("claude-opus-5-5"),
    menu = open(s);
  let rows = draw(menu, 100, 30, 0, s, prefs);
  // The plan is the account's, on its header; "auto" is Haiku's alone.
  expect(rows.find(row => row.includes("✓ "))).toMatch(/✓ Opus 5\.5\s+│/);
  expect(rows.join("\n")).toMatch(/\*  Claude\s+Plan │/);
  expect(rows.join("\n")).toMatch(/Haiku 5\.5\s+auto │/);
  expect(menu.click(modelHit(menu, /Haiku 5\.5/, s, prefs), s, prefs)).toEqual({ kind: "summaries", choice: "claude" });
  menu.enter(s, prefs);
  for (const byte of Buffer.from("sonnet")) menu.key(byte);
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "claude",
    model: "claude-sonnet-5-5",
    account: "",
  });
  // Following Claude, Haiku is in use; Opus keeps to Opus.
  s = status({ choice: "claude", provider: "claude", model: "claude-haiku-5-5", available });
  menu = open(s);
  rows = draw(menu, 100, 30, 0, s, prefs);
  expect(rows.find(row => row.includes("✓ "))).toMatch(/✓ Haiku 5\.5\s+auto │/);
  expect(menu.enter(s, prefs)).toBeNull();
  menu.enter(s, prefs);
  for (const byte of Buffer.from("opus")) menu.key(byte);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "claude", model: "claude-opus-5-5", account: "" });
  // Kept to Haiku by name, picking Haiku goes back to following.
  s = pinned("claude-haiku-5-5");
  menu = open(s);
  draw(menu, 100, 30, 0, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "claude" });
});

test("named accounts list their own models, and a pick carries the account", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "claude",
      provider: "claude",
      model: "haiku",
      account: "/claude/nvidia",
      models: { claude: "haiku", codex: "gpt-6-luna" },
    });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    accounts: [
      {
        provider: "claude",
        account: "/claude/nvidia",
        name: "nvidia",
        option: { account: "Work", plan: "API", limits: "metered", signed_in: true },
      },
      {
        provider: "codex",
        account: "/codex/nvidia",
        name: "nvidia",
        option: { account: "Personal", limits: "metered", signed_in: true, model: "nvidia/kimi-k3" },
      },
    ],
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  // The model in use, under its account, comes first after Auto.
  let rows = draw(menu, 100, 40, 0, s, prefs);
  const y = rows.findIndex(row => row.includes("✓ Haiku"));
  expect(rows[y - 2]).toMatch(/\*  Claude\s+│/);
  expect(rows[y - 1]).toMatch(/ Work\s+API\s+│/);
  for (const byte of Buffer.from("nvidia Codex")) menu.key(byte);
  rows = draw(menu, 100, 40, 0, s, prefs);
  expect(rows.join("\n")).toMatch(/†  Codex · Personal\s+Metered │/);
  expect(rows.join("\n")).toMatch(/GPT-6 Luna/);
  expect(rows.join("\n")).not.toContain("Haiku");
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "codex",
    model: "gpt-6-luna",
    account: "/codex/nvidia",
  });
});

test("suggestions are cheap models, with heavier ones a search away", () => {
  for (const provider of ["codex", "claude"] as const) {
    const menu = Menu.open(),
      prefs = new Preferences(),
      available = ["", "/nvidia"].flatMap(account =>
        Array.from({ length: 8 }, (_, i) => ({
          provider,
          account,
          model: `model-${i}`,
          name: i === 0 ? "Heavy chat model" : i === 7 ? "Cheap model" : `Mid model ${i}`,
          account_name: account ? "work@example.com" : "personal@example.com",
          subscription: !account,
          input_cost: i === 1 ? null : 8 - i,
          output_cost: i === 1 ? null : 5 * (8 - i),
        })),
      ),
      s = status({ choice: "auto", provider, launches: { [provider]: 3 }, available });
    menu.agents = new LauncherMenu();
    menu.agents.preview = preview({
      accounts: [
        {
          provider,
          account: "/nvidia",
          name: "nvidia",
          option: { model: "model-0", model_name: "Heavy chat model", limits: "metered", signed_in: true },
        },
      ],
    });
    menu.enter(s, prefs);
    menu.enter(s, prefs);
    let text = draw(menu, 100, 40, 0, s, prefs).join("\n");
    expect(text).toMatch(/✦  Auto\s+Follow (Codex|Claude) │/);
    expect(text).toContain("Cheap model");
    expect(text).not.toContain("Heavy chat model");
    for (const byte of Buffer.from("nvidia Heavy")) menu.key(byte);
    text = draw(menu, 100, 40, 0, s, prefs).join("\n");
    expect(text).toMatch(/Codex|Claude/);
    expect(text).toMatch(/ · nvidia\s+Metered │/);
    expect(text).toMatch(/        Heavy chat model\s+│/);
    expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: provider, model: "model-0", account: "/nvidia" });
  }
});

test("a selected native account's model does not leak into the default account row", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "codex",
      provider: "codex",
      model: "nvidia/kimi-k3",
      account: "/codex/nvidia",
      selection: { provider: "codex", model: "nvidia/kimi-k3", account: "/codex/nvidia" },
      models: { codex: "nvidia/kimi-k3" },
    });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    accounts: [{ provider: "codex", account: "/codex/nvidia", name: "nvidia", option: { model: "nvidia/kimi-k3" } }],
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 100, 40, 0, s, prefs);
  const y = rows.findIndex(row => row.includes("✓ nvidia/kimi-k3"));
  expect(rows[y - 1]).toMatch(/ nvidia\s+│/);
  expect(rows[y - 2]).toMatch(/†  Codex\s+│/);
  expect(menu.click(modelHit(menu, /GPT-6 Luna/, s, prefs, 100, 40), s, prefs)).toEqual({
    kind: "summaries",
    choice: "codex",
  });
});

test("a heavy explicit default selection doesn't become another native account's inference default", () => {
  for (const [provider, heavy, cheap] of [
    ["codex", "gpt-6-astra", "gpt-6-luna"],
    ["claude", "claude-opus-5-5[1m]", "claude-haiku-5-5"],
  ] as const) {
    const menu = Menu.open(),
      prefs = new Preferences(),
      s = status({
        choice: provider,
        provider,
        model: heavy,
        models: { [provider]: heavy },
        selection: { provider, model: heavy, account: "" },
      });
    menu.agents = new LauncherMenu();
    menu.agents.preview = preview({
      accounts: [{ provider, account: "/nvidia", name: "nvidia", option: { model: heavy, limits: "metered" } }],
    });
    menu.enter(s, prefs);
    menu.enter(s, prefs);
    for (const byte of Buffer.from("nvidia")) menu.key(byte);
    draw(menu, 100, 30, 0, s, prefs);
    expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: provider, model: cheap, account: "/nvidia" });
  }
});

test("cached models stay listed while catalogs refresh, and arrive in an open picker", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    loading = status({ choice: "pi", provider: "pi", loading: true });
  menu.enter(loading, prefs);
  menu.enter(loading, prefs);
  let text = draw(menu, 100, 40, 0, loading, prefs).join("\n");
  expect(text).toContain("GPT-6 Luna");
  expect(text).not.toContain("Cached model");
  menu.move(true, loading, prefs);
  const cached = status({
    choice: "pi",
    provider: "pi",
    loading: true,
    available: [
      { provider: "pi", model: "custom/cached", name: "Cached model", account: "", ready: true },
      { provider: "opencode2", model: "custom/old", name: "Older model", account: "", ready: false },
      { provider: "omp", model: "custom/omp", name: "omp model", account: "", ready: true },
    ],
  });
  text = draw(menu, 100, 40, 0, cached, prefs).join("\n");
  expect(text).toContain("Cached model");
  expect(text).not.toMatch(/checking|Checking|Fetching/);
  for (const byte of Buffer.from("older")) menu.key(byte);
  expect(draw(menu, 100, 40, 0, cached, prefs).join("\n")).toMatch(/OpenCode · custom[^]*Older model\s+Check failed │/);
  expect(menu.enter(cached, prefs)).toEqual({
    kind: "summaries",
    choice: "opencode2",
    model: "custom/old",
    account: "",
  });
  menu.enter(cached, prefs);
  for (const byte of Buffer.from("cached")) menu.key(byte);
  draw(menu, 100, 40, 0, cached, prefs);
  // The model in use has nothing to apply.
  expect(menu.enter(cached, prefs)).toBeNull();
});

test("a narrow frame clips names inside the picker without crossing its borders", () => {
  const prefs = new Preferences(),
    s = status({
      available: [
        {
          provider: "pi",
          model: "a-very-long-provider/model",
          name: "A very long model name that cannot fit",
          account: "/work",
          account_name: "A very long account name",
          subscription: true,
        },
        { provider: "pi", model: "custom/cheap", name: "Cheap", account: "", ready: true },
      ],
    });
  for (const cols of [44, 50]) {
    const menu = Menu.open();
    menu.enter(s, prefs);
    menu.enter(s, prefs);
    const rows = draw(menu, cols, 30, 0, s, prefs),
      model = rows.find(row => /A very long(?! account)/.test(row))!;
    expect(model).toContain("…");
    expect(model.trimEnd().endsWith("│ │")).toBe(true);
    expect(
      rows
        .find(row => row.includes("a-very-long-provider"))!
        .trimEnd()
        .endsWith("│ │"),
    ).toBe(true);
    expect(menu.click(modelHit(menu, /A very long(?! account)/, s, prefs, cols, 30), s, prefs)).toEqual({
      kind: "summaries",
      choice: "pi",
      model: "a-very-long-provider/model",
      account: "/work",
    });
  }
});

test("where the picker overhangs the settings list, clicks go to the picker", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ models: { codex: "gpt-6-luna" } });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 80, 30, 0, s, prefs),
    y = rows.findIndex(row => row.includes("GPT-6 Luna")),
    border = rows[y].lastIndexOf("│", rows[y].indexOf("GPT-6 Luna")),
    divider = rows.find(row => row.includes("Clever Corgi"))!.indexOf("│", 4);
  expect(border).toBeLessThan(divider);
  expect(menu.hit(80, 30, border, y, s, prefs)).toEqual({ models: { x: border, y } });
  expect(menu.click({ models: { x: divider, y } }, s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
});

test("catalog billing reads as plans, metered, free or nothing", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      available: [
        { provider: "pi", model: "custom/plan", name: "Plan model", account: "", subscription: true },
        { provider: "pi", model: "custom/tokens", name: "Token model", account: "", input_cost: 1, output_cost: 5 },
        { provider: "pi", model: "custom/free", name: "Free model", account: "", input_cost: 0, output_cost: 0 },
        { provider: "pi", model: "custom/unknown", name: "Unknown model", account: "" },
      ],
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  for (const byte of Buffer.from("custom")) menu.key(byte);
  const rows = draw(menu, 100, 40, 0, s, prefs);
  // The source heads its models with the first one's billing; a model billed
  // otherwise says how. The plan model is Pi's choice for now.
  expect(rows.join("\n")).toMatch(/π  Pi · custom\s+Plan │/);
  for (const [model, brief] of [
    ["Plan model", "auto"],
    ["Token model", "Metered"],
    ["Free model", "Free"],
    ["Unknown model", ""],
  ])
    expect(rows.find(row => row.includes(model))).toMatch(new RegExp(`${model}\\s+${brief}${brief ? " " : ""}│`));
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
  expect(text).toContain("Use Codex · GPT-6 Luna");
  expect(text).toContain("Haiku 5.5");
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
  // The presets, Prefix, Customize, then All keys; cmux is macOS-only.
  const all_keys = km.available_presets.length + 2;
  menu.openOptions(s, prefs);
  for (let i = 0; i < 10; i++) menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(all_keys);
  menu.integration = "disabled";
  menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(all_keys + 1);
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

test("Command keys omit unbound actions and show customized cmux keys", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "keyboard";
  menu.integration = "enabled";
  prefs.keys = { new: [] };
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).not.toMatch(/New tab +⌘T/);
  expect(text).toMatch(/Close tab +⌘W/);
  prefs.keys = { tab: "prefix+1..2" };
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/Select tab +⌘1–2/);
  expect(text).not.toMatch(/Select tab +⌘1–9/);
  prefs.preset = "cmux";
  prefs.keys = { new: "cmd+f1" };
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/New tab +⌘F1/);
  expect(text).not.toMatch(/New tab +⌘T/);
});

test("visual flourishes preview working and idle corgis with a keyboard slider", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "flourishes";
  const text = (now = 0) => draw(menu, 100, 30, now, s, prefs).join("\n");
  expect(text()).toContain("Intensity");
  expect(text()).toContain("━");
  expect(text()).toContain("agents: corgi ▾");
  expect(text()).toContain("Visual flourishes");
  expect(text()).toContain("Release notes");
  expect(text()).toContain("~ᐯ•.•ᐯ");
  expect(text()).toContain("~ᐯ◡ᴥ◡ᐯ ᶻ");
  expect(text(corgiAnimation.puff_duration_ms)).not.toContain("ᶻ");
  expect(text()).not.toContain("Sleeping corgi");
  expect(text()).not.toContain("Reset");
  expect(menu.sliderKey("left", prefs)).toBeNull();
  menu.openOptions(s, prefs);
  expect(menu.sliderKey("left", prefs)).toEqual({ kind: "corgi_intensity", value: 45 });
  expect(menu.sliderKey("right", prefs)).toEqual({ kind: "corgi_intensity", value: 55 });
  expect(menu.sliderKey("home", prefs)).toEqual({ kind: "corgi_intensity", value: 0 });
  expect(menu.sliderKey("end", prefs)).toEqual({ kind: "corgi_intensity", value: 100 });
  prefs.corgi_intensity = 0;
  expect(menu.sliderKey("left", prefs)).toEqual({ kind: "corgi_intensity", value: 0 });
  expect(text()).not.toContain("~ᐯ");
  expect(text()).toContain("ᶻ");
  expect(text()).toContain("Release notes");
});

test("the intensity slider previews a drag, clamps outside its track, and cancels", () => {
  for (const [cols, rows] of [
    [100, 30],
    [60, 22],
    [80, 14],
  ]) {
    const menu = Menu.open(),
      prefs = new Preferences(),
      s = status();
    menu.item = "flourishes";
    menu.openOptions(s, prefs);
    const rendered = draw(menu, cols, rows, 0, s, prefs);
    const y = rendered.findIndex(row => row.includes("━"));
    const left = rendered[y].indexOf("━"),
      right = rendered[y].lastIndexOf("─");
    expect(y).toBeGreaterThanOrEqual(0);
    expect(menu.hit(cols, rows, left, y, s, prefs)).toEqual({ slider: "corgi_intensity", value: 0 });
    expect(menu.hit(cols, rows, right, y, s, prefs)).toEqual({ slider: "corgi_intensity", value: 100 });
    expect(menu.click({ slider: "corgi_intensity", value: 25 }, s, prefs)).toBeNull();
    expect(menu.previewIntensity(prefs)).toBe(25);
    expect(prefs.corgi_intensity).toBe(50);
    menu.dragSlider(cols, rows, -20);
    expect(menu.previewIntensity(prefs)).toBe(0);
    expect(draw(menu, cols, rows, 0, s, prefs).join("\n")).not.toContain("~ᐯ");
    menu.dragSlider(cols, rows, cols + 20);
    expect(menu.finishSlider()).toEqual({ kind: "corgi_intensity", value: 100 });
    expect(menu.draggingSlider()).toBe(false);
    menu.click({ slider: "corgi_intensity", value: 0 }, s, prefs);
    menu.back();
    expect(menu.previewIntensity(prefs)).toBe(50);
    expect(menu.finishSlider()).toBeNull();
  }
});

test("visual flourishes sets the workspace tint on a second slider, keyed and dragged on its own", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  prefs.corgi_intensity = 40;
  prefs.workspace_tint = 0;
  menu.item = "flourishes";
  menu.openOptions(s, prefs);
  const rendered = draw(menu, 100, 30, 0, s, prefs),
    text = rendered.join("\n");
  expect(text).toContain("Workspace section background.");
  expect(text).toMatch(/Workspace tint +Off/);
  expect(text).toContain("100 Bright");
  expect(text).toContain("100 Strong");
  // The tint's slider sits below the corgi's preview.
  expect(text).toContain("Release notes");
  expect(text.indexOf("Workspace tint")).toBeGreaterThan(text.indexOf("Release notes"));
  // Each bar hits its own slider, from 0 at its left end to 100 at its right.
  const ends = (id: string) => {
    const found = hits(menu, 100, 30, s, prefs).filter(hit => "slider" in hit && hit.slider === id);
    return found.map(hit => ("slider" in hit ? hit.value : -1));
  };
  for (const id of ["corgi_intensity", "workspace_tint"]) {
    expect(ends(id)).toContain(0);
    expect(ends(id)).toContain(100);
  }
  // Only the slider under the cursor shows a bright thumb.
  const thumbs = () => {
    const w = new Writer();
    menu.drawAt(w, s, prefs, 100, 30, 0);
    return w.s.split(new Style({ fg: "strong", bg: "surface", bold: true }).sgr() + "●").length - 1;
  };
  expect(thumbs()).toBe(1);
  // Keys act on the slider under the cursor.
  expect(menu.sliderKey("right", prefs)).toEqual({ kind: "corgi_intensity", value: 45 });
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(1);
  expect(thumbs()).toBe(1);
  expect(menu.sliderKey("left", prefs)).toEqual({ kind: "workspace_tint", value: 0 });
  expect(menu.sliderKey("right", prefs)).toEqual({ kind: "workspace_tint", value: 5 });
  expect(menu.sliderKey("end", prefs)).toEqual({ kind: "workspace_tint", value: 100 });
  prefs.workspace_tint = 100;
  expect(menu.sliderKey("right", prefs)).toEqual({ kind: "workspace_tint", value: 100 });
  expect(menu.sliderKey("left", prefs)).toEqual({ kind: "workspace_tint", value: 95 });
  expect(menu.sliderKey("home", prefs)).toEqual({ kind: "workspace_tint", value: 0 });
  expect(menu.sliderKey("enter" as never, prefs)).toBeNull();
  expect(prefs.corgi_intensity).toBe(40);
  menu.move(false, s, prefs);
  expect(menu.sliderKey("home", prefs)).toEqual({ kind: "corgi_intensity", value: 0 });
  // A click on the tint's bar takes the cursor there and drags it alone.
  prefs.workspace_tint = 0;
  expect(menu.click({ slider: "workspace_tint", value: 30 }, s, prefs)).toBeNull();
  expect(menu.cursor).toBe(1);
  expect(menu.draggingSlider()).toBe(true);
  expect(menu.previewSlider("workspace_tint", prefs)).toBe(30);
  expect(menu.previewIntensity(prefs)).toBe(40);
  menu.dragSlider(100, 30, 200);
  expect(menu.previewSlider("workspace_tint", prefs)).toBe(100);
  expect(prefs.workspace_tint).toBe(0);
  expect(menu.finishSlider()).toEqual({ kind: "workspace_tint", value: 100 });
  expect(menu.draggingSlider()).toBe(false);
  expect(menu.previewSlider("workspace_tint", prefs)).toBe(0);
  // The list's value for Visual flourishes stays the corgi's brightness.
  prefs.workspace_tint = 80;
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toMatch(/Visual flourishes +40%/);
  // A click on the corgi's bar puts the cursor back on it.
  menu.click({ slider: "corgi_intensity", value: 20 }, s, prefs);
  expect(menu.cursor).toBe(0);
  expect(menu.finishSlider()).toEqual({ kind: "corgi_intensity", value: 20 });
  // A short frame gives up the preview before either slider.
  const short = draw(menu, 80, 14, 0, s, prefs).join("\n");
  expect(short).toContain("Intensity");
  expect(short).toMatch(/Workspace tint +80%/);
  expect(short).toContain("100 Strong");
  expect(short).not.toContain("Preview");
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
  // Unset, the terminal picks.
  expect(menu.previewTheme(prefs)).toBeUndefined();
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

test("language choices return stable locale codes and can follow the system", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "language";
  menu.enter(s, prefs);
  expect(menu.enter(s, prefs)).toBeNull();
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "language", language: "en" });
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "language", language: "zh" });
  prefs.language = "zh";
  menu.cursor = 0;
  expect(menu.enter(s, prefs)).toEqual({ kind: "language", language: undefined });
});

test("terminal capabilities report what the terminal can do, not settings", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.item = "terminal";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Detected, not settings: what this terminal can do.");
  expect(text).toContain("Didn't say its name");
  expect(text).toMatch(/– Kitty graphics/);
  expect(text).toContain("This viewer has no terminal to paste from.");
  // Nothing in it takes the cursor.
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("list");
  menu.terminal = { name: "ghostty 1.3.0", ssh: true, graphics: true, colors: true };
  const clipboard = new ClipboardState();
  clipboard.support = "denied";
  menu.image_paste = clipboard;
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("ghostty 1.3.0 · over SSH");
  expect(text).toMatch(/✓ Kitty graphics/);
  expect(text).toMatch(/✓ Theme colors/);
  expect(text).toMatch(/! Image paste/);
  expect(text).toContain("Blocked by clipboard-read = deny.");
});

test("frame pacing charts how fast the host answers, in one row on a short frame", () => {
  const menu = Menu.open(),
    pacing = new Pacer();
  menu.item = "terminal";
  menu.pacing = pacing;
  expect(draw(menu, 100, 40).join("\n")).toContain("Never answered, so frames never wait.");
  // Two minutes of answers in 24 ms, but one in 1.2 s and one lost.
  let now = 1_000_000;
  for (let i = 0; i < 600; i++) {
    pacing.stamp(now);
    if (i === 400) pacing.waiting((now += 5000));
    else pacing.answered((now += i === 300 ? 1200 : 24));
    now += 200;
  }
  let text = draw(menu, 100, 40, now).join("\n");
  expect(text).toMatch(/✓ Frame pacing/);
  expect(text).toContain("Answers in 24 ms ± 0.");
  expect(text).toContain("2 late enough to hold frames; one never came.");
  // The mean sits on the 30 ms row, and the slow answer lifts it to 100 ms.
  const rows = text.split("\n").filter(row => row.includes("┤"));
  expect(rows.map(row => row.split("┤")[0].split("│").at(-1)!.trim())).toEqual([
    "1 s",
    "wait",
    "100 ms",
    "",
    "10 ms",
    "",
    "1 ms",
  ]);
  expect(rows[0]).toContain("✕");
  expect(rows[2]).toContain("█");
  expect(rows[3]).toMatch(/█{20}/);
  expect(text).toMatch(/└─ −\d+ s ─+ now/);
  text = draw(menu, 100, 24, now).join("\n");
  expect(text).not.toContain("┤");
  expect(text).toMatch(/▄{10}.*✕.*24 ms ± 0/);
  expect(text).toContain("2 late enough to hold frames; one never came.");
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
  expect(text).toContain("Visual flourishes");
  expect(text).not.toContain("PREFIX");
  text = draw(menu, 140, 36, 1100, s, prefs).join("\n");
  expect(text).not.toContain("Visual flourishes");
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
  expect(text).toMatch(/○ tmux +Classic splits/);
  expect(menu.enter(s, prefs)).toEqual({ kind: "preset", preset: "tmux" });
  // Clicks land on the grown frame's options.
  expect(hits(menu, 140, 36, s, prefs).filter(hit => "item" in hit)).toEqual([]);
  expect(menu.back()).toBe(true);
  text = draw(menu, 140, 36, 2200, s, prefs).join("\n");
  text = draw(menu, 140, 36, 3000, s, prefs).join("\n");
  expect(text).toContain("Visual flourishes");
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
    expect(text).toContain("Ctrl+B then   c tab   v - split   ← ↓ ↑ → focus");
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
  expect(await menu.poll(conn, 100, 30)).toBe(true);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Copying into Corgi");
  expect(menu.back()).toBe(true);
  expect(menu.focus).toBe("options");
  expect(menu.escape()).toBe(true);
  expect(menu.focus).toBe("options");
  progress.phase = "complete";
  menu.import_picker.last_poll = 0;
  await menu.poll(conn, 100, 30);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Import complete");
  expect(menu.enter(s, prefs)).toEqual({ kind: "imported", workspace: 7 });
  menu.close();
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

test("Detach sits at the bottom and leaves from the list", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  expect(items.at(-1)).toBe("detach");
  menu.item = "detach";
  const text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/│ {2}Detach +Ctrl\+B q {2}│/);
  expect(text).toMatch(/Come back +corgi/);
  expect(text).toContain("enter detach");
  expect(menu.enter(s, prefs)).toEqual({ kind: "detach" });
  expect(menu.focus).toBe("list");
  // The preset's detach shortcut works in setup; other prefix keys don't.
  expect(menu.prefixKey(2, prefs)).toBe("taken");
  expect(menu.prefixKey(113, prefs)).toBe("detach");
  expect(menu.prefixKey(113, prefs)).toBeNull();
  prefs.preset = "tmux";
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toMatch(/│ {2}Detach +Ctrl\+B d {2}│/);
  menu.prefixKey(2, prefs);
  expect(menu.prefixKey(113, prefs)).toBe("taken");
  menu.prefixKey(2, prefs);
  expect(menu.prefixKey(100, prefs)).toBe("detach");
});

test("Source control's box takes the worktree folder, shows where it leads, and refuses what can't work", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status();
  menu.project = { name: "corgi", root: "/src/corgi" };
  menu.item = "source_control";
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("│ $PROJECT_ROOT/.worktrees/$NAME");
  expect(text).toContain("→ /src/corgi/.worktrees/fix-login");
  expect(text).toMatch(/\$PROJECT_ROOT +\/src\/corgi/);
  expect(text).toMatch(/\$NAME +fix-login/);
  // Opening the pane puts the caret in the box; q and space are typing.
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.editing).not.toBeNull();
  for (const _ of ".worktrees/$NAME") menu.key(127);
  for (const byte of Buffer.from("wt q/$BRANCH")) expect(menu.key(byte)).toBe(true);
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("$BRANCH isn't a variable; did you mean $NAME?");
  expect(text).not.toContain("→");
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.editing).not.toBeNull();
  for (const _ of "$BRANCH") menu.key(127);
  for (const byte of Buffer.from("$NAME")) menu.key(byte);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("→ /src/corgi/wt q/fix-login");
  expect(menu.enter(s, prefs)).toEqual({ kind: "worktree_folder", template: "$PROJECT_ROOT/wt q/$NAME" });
  expect([menu.editing, menu.focus]).toEqual([null, "list"]);
  // Back drops an edit; an emptied box saves the default it shows.
  prefs.worktree_folder = "$PROJECT_ROOT/wt/$NAME";
  menu.enter(s, prefs);
  menu.key(127);
  expect(menu.back()).toBe(true);
  expect([menu.editing, menu.focus]).toEqual([null, "list"]);
  // Typing ./ spells out the project root.
  menu.enter(s, prefs);
  menu.key(21);
  for (const byte of Buffer.from("./wt/$NAME")) menu.key(byte);
  expect(menu.editing!.name()).toBe("$PROJECT_ROOT/wt/$NAME");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("→ /src/corgi/wt/fix-login");
  menu.back();
  menu.enter(s, prefs);
  menu.key(21);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("│ $PROJECT_ROOT/.worktrees/$NAME");
  expect(menu.enter(s, prefs)).toEqual({ kind: "worktree_folder", template: "$PROJECT_ROOT/.worktrees/$NAME" });
});

test("About links its acknowledgements and makes the whole spaceship a keyboard and pointer target", () => {
  const s = status(),
    prefs = new Preferences();
  for (const [cols, rows] of [
    [100, 30],
    [56, 24],
    [80, 20],
  ]) {
    const menu = Menu.open();
    menu.item = "about";
    menu.enter(s, prefs);
    expect(menu.enter(s, prefs)).toEqual({ kind: "open", url: "https://github.com/tals/corgi" });
    const initial = draw(menu, cols, rows, 0, s, prefs).join("\n");
    if (rows >= 24) expect(initial).toContain("Acknowledgements");
    expect(initial).toContain("ᐯ•ᴥ•ᐯ");
    expect(initial).not.toContain("With thanks");
    expect(initial).not.toContain("Play Moonlander");
    menu.move(false, s, prefs);
    const scene = draw(menu, cols, rows, 0, s, prefs),
      bottom = scene.findLastIndex(row => row.includes("esc close"));
    expect(scene[bottom - 3]).toMatch(/━{16,}/);
    expect(scene.join("\n")).not.toContain("×2");
    expect(menu.enter(s, prefs)).toEqual({ kind: "moonlander" });
    const ship = hits(menu, cols, rows, s, prefs).filter(hit => "option" in hit && hit.option === menu.cursor);
    expect(ship.length).toBe(8);
    for (const hit of ship) expect(menu.click(hit, s, prefs)).toEqual({ kind: "moonlander" });
  }
  const menu = Menu.open();
  menu.item = "about";
  const w = new Writer();
  menu.draw(w, s, prefs, 100, 30);
  for (const url of [
    "https://ghostty.org",
    "https://sw.kovidgoyal.net/kitty/",
    "https://github.com/herdrdev/herdr",
    "https://github.com/persiyanov/herdr-reviewr",
    "https://github.com/earendil-works/pi/tree/main/packages/tui",
    "https://bun.sh",
  ])
    expect(w.s).toContain(`\x1b]8;;${url}\x1b\\`);
});

test("Manage agents shares the launcher's view inside wide and narrow settings", () => {
  for (const cols of [60, 100, 160]) {
    const menu = Menu.open(),
      s = status(),
      prefs = new Preferences(),
      launch = new LauncherMenu();
    launch.managing = true;
    launch.manager.back = "settings";
    menu.agents = launch;
    menu.item = "agents";
    expect(menu.openOptions(s, prefs)).toBe(true);
    expect(menu.managing()).toBe(true);
    let rows = draw(menu, cols, 24);
    expect(rows.join("\n")).toContain("Search");
    expect(rows.join("\n")).toContain("Active ·");
    expect(rows.join("\n")).toContain("Hidden ·");
    expect(rows.join("\n")).not.toContain("New tab");
    const searchY = rows.findIndex(row => row.includes("Search")),
      searchX = rows[searchY].indexOf("Search"),
      hit = menu.hit(cols, 24, searchX, searchY, s, prefs);
    expect(hit).toHaveProperty("manager");
    launch.manager.key(47, launch.manageModel());
    for (const ch of "custom") menu.paste(ch.charCodeAt(0));
    expect(launch.manager.query.name()).toBe("custom");
    launch.manager.key(9, launch.manageModel());
    launch.manager.key(13, launch.manageModel());
    expect(launch.manager.page).toBe("command");
    rows = draw(menu, cols, 24);
    expect(rows.join("\n")).toContain("Paste a command");
    expect(rows.join("\n")).toContain("[Cancel]  [Add]");
    expect(menu.back()).toBe(true);
    expect(menu.managing()).toBe(false);
    const w = new Writer();
    menu.drawAt(w, s, prefs, cols, 24, 0);
    expect(w.s).not.toContain("\x1b[?25h");
  }
});

test("Manage agents expands and returns with Keymap's easing, keeping visible pointer targets", () => {
  const menu = Menu.open(),
    s = status(),
    prefs = new Preferences();
  menu.agents = new LauncherMenu();
  menu.agents.managing = true;
  menu.item = "agents";
  const width = (rows: string[]) => {
    const top = rows.find(row => row.includes("Corgi setup"))!;
    return top.lastIndexOf("╮") - top.indexOf("╭") + 1;
  };
  const normal = width(draw(menu, 160, 36, 1000));
  menu.openOptions(s, prefs);
  expect(width(draw(menu, 160, 36, 1000))).toBe(normal);
  const middle = draw(menu, 160, 36, 1100),
    midWidth = width(middle);
  expect(midWidth).toBeGreaterThan(normal);
  expect(midWidth).toBeLessThan(preferred_width + 2);
  const y = middle.findIndex(row => row.includes("Search")),
    x = middle[y].indexOf("Search");
  const hit = menu.hit(160, 36, x, y, s, prefs);
  expect(hit && "manager" in hit ? hit.manager.x + 7 : null).toBe(x);
  expect(width(draw(menu, 160, 36, 1280))).toBe(preferred_width + 2);
  menu.back();
  expect(width(draw(menu, 160, 36, 1300))).toBe(preferred_width + 2);
  const shrinking = width(draw(menu, 160, 36, 1400));
  expect(shrinking).toBeGreaterThan(normal);
  expect(shrinking).toBeLessThan(preferred_width + 2);
  // Reversing midway starts at the current width, with no jump.
  menu.openOptions(s, prefs);
  expect(width(draw(menu, 160, 36, 1400))).toBe(shrinking);
  expect(width(draw(menu, 160, 36, 1680))).toBe(preferred_width + 2);
  menu.back();
  draw(menu, 160, 36, 1700);
  expect(width(draw(menu, 160, 36, 1900))).toBe(normal);
  expect(draw(menu, 60, 24, 2000).join("\n")).toContain("Manage agents");
});

test("expanded settings and the popup render the same account rows and usage bars", () => {
  const now = Math.floor(Date.now() / 1000),
    launch = new LauncherMenu();
  launch.managing = true;
  launch.preview = preview({
    pending: false,
    options: {
      claude: {
        signed_in: true,
        account: "me@example.com",
        usage_fetched_at: now,
        limits: {
          windows: [
            { minutes: 300, used: 20, reset_at: now + 3600 },
            { minutes: 10080, used: 40, reset_at: now + 86400 },
          ],
        },
      },
    },
    accounts: [
      {
        provider: "claude",
        account: "/accounts/work",
        name: "work",
        option: {
          signed_in: true,
          account: "me@work.com",
          limits: "metered",
          usage_fetched_at: now,
          spend: {
            used_minor: 590000,
            limit_minor: 1000000,
            currency: "USD",
            exponent: 2,
            period_start: now - 60,
            reset_at: now + 86400,
          },
        },
      },
    ],
  });
  const menu = Menu.open();
  menu.agents = launch;
  menu.item = "agents";
  menu.openOptions(status(), new Preferences());
  draw(menu, 180, 36, 1000);
  const expanded = draw(menu, 180, 36, 1300);
  const w = new Writer();
  launch.manager.draw(w, new Rect(0, 0, preferred_width, 30), launch.manageModel());
  const popup = screen(w.s, 180, 36);
  // Claude's accounts, by the mark each wears.
  const accountRows = (rows: string[]) =>
    rows
      .filter(row => row.includes("≡ * ") && row.includes("@"))
      .map(row => row.slice(row.indexOf("≡ * ")).replace(/[│ ]+$/, ""));
  expect(accountRows(expanded)).toEqual(accountRows(popup));
  expect(accountRows(expanded)).toHaveLength(2);
  for (const row of accountRows(expanded)) expect(row).toContain("━");
  expect(accountRows(expanded)[1]).toContain("$5.9k / $10k");
});

test("Report a bug shows what the issue will say, and opens it, or copies its link over SSH", () => {
  const s = status(),
    prefs = new Preferences(),
    menu = Menu.open();
  menu.item = "report_bug";
  // Already under way, so drawing doesn't ask the real daemon.
  (menu as unknown as { gathering: boolean }).gathering = true;
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Gathering details");
  menu.report = {
    corgi: "1.2.3 (abc1234), linux-x64",
    install: { path: "/usr/bin/corgi", auto_update: null },
    system: {
      os: "Ubuntu 24.04.1 LTS",
      os_timed_out: false,
      kernel: "Linux 6.8.0",
      locale: "C.UTF-8",
      shell: { path: "/usr/bin/fish", version: "fish, version 3.7.1" },
      agents: [
        {
          name: "Codex",
          version: "codex-cli 0.46.0",
          path: "/usr/bin/codex",
          old: false,
          unanswered: false,
          hooks: "installed",
        },
      ],
    },
    daemon: null,
    slow: { daemon: false, sessions: false, report: false },
    terminal: null,
    overrides: [],
    logs: { server: "/tmp/server.log", crashes: 0 },
    warnings: ["warn: only local"],
    inference: null,
  };
  const shown = draw(menu, 100, 30, 0, s, prefs),
    text = shown.join("\n");
  expect(text).toMatch(/Shell +fish, version 3\.7\.1 \(\/usr\/bin\/fish\)/);
  expect(text).toMatch(/ {2}Codex +codex-cli 0\.46\.0 \(\/usr\/bin\/codex\),/);
  expect(text).toMatch(/Settings +theme Corgi \(automatic\), keymap/);
  expect(text).not.toContain("only local");
  // The button sits above the report, so a short frame still shows it.
  const at = (needle: string) => shown.findIndex(row => row.includes(needle));
  expect(at("Open an Issue on GitHub")).toBeLessThan(at("1.2.3 (abc1234)"));
  expect(draw(menu, 100, 16, 0, s, prefs).join("\n")).toContain("Open an Issue on GitHub");
  const button = hits(menu, 100, 30, s, prefs).find(hit => "option" in hit)!,
    open = menu.click(button, s, prefs);
  expect(open?.kind).toBe("open");
  const url = (open as { url: string }).url;
  expect(url).toContain("https://github.com/tals/corgi/issues/new?body=");
  expect(decodeURIComponent(url)).toContain("- Shell: fish, version 3.7.1 (/usr/bin/fish)");
  // No browser opens over SSH, so the same button copies the link and says so.
  menu.terminal = { ...menu.terminal, ssh: true };
  expect(menu.click(button, s, prefs)).toEqual({ kind: "copy", text: url });
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("enter copy link");
  menu.link_copied = true;
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("Copied the link; paste it into your browser.");
  menu.full_path = "/tmp/full_bug_report.txt";
  const attach = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(attach).toContain("Please attach /tmp/full_bug_report.txt,");
  expect(attach).toContain("Corgi runs on.");
});
test("a setup choice or provider the viewer doesn't know reads as auto and none", () => {
  expect([status({ choice: "future", provider: "future" }).choice, status({ provider: "future" }).provider]).toEqual([
    "auto",
    null,
  ]);
  expect([status({ choice: "off" }).choice, status({ choice: "codex", provider: "codex" }).provider]).toEqual([
    "off",
    "codex",
  ]);
});
