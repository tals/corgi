import { expect, test } from "bun:test";
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
function choiceHit(
  menu: Menu,
  match: RegExp,
  s: ReturnType<typeof status>,
  prefs: Preferences,
  cols = 100,
  rows = 30,
): Hit {
  const y = draw(menu, cols, rows, 0, s, prefs).findIndex(row => match.test(row));
  expect(y).toBeGreaterThanOrEqual(0);
  for (let x = 0; x < cols; x++) {
    const hit = menu.hit(cols, rows, x, y, s, prefs);
    if (hit && "choice" in hit) return hit;
  }
  throw Error("No choice on matching row");
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
  hover(25, 9, 2100);
  expect(menu.item).toBe("keyboard");
  hover(30, 8, 2200);
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
  // Visual flourishes' Intensity sits on rows 7 and 8, its preview below.
  for (const [y, kept] of [
    [8, true],
    [15, false],
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
  menu.hover(100, 30, 15, 14, s, prefs, 0);
  menu.hover(100, 30, 22, 10, s, prefs, 100);
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
  for (const use of ["Activity summaries", "Worktree briefs", "Smart Links"])
    expect(rows.join("\n")).toMatch(new RegExp(`${use} +● On`));
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

test("Settings asks for every account only while a pane lists them all", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ choice: "omp" });
  menu.agents = new LauncherMenu();
  // Clever Corgi shows first, its model list closed.
  expect(menu.item).toBe("clever_corgi");
  expect(menu.listsAccounts()).toBe(false);
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  expect(menu.listsAccounts()).toBe(true);
  menu.back();
  expect(menu.listsAccounts()).toBe(false);
  menu.back();
  menu.item = "agents";
  expect(menu.listsAccounts()).toBe(true);
});

test("Model opens a dropdown on the choice in use, and Left closes it", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ choice: "omp" });
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.focus).toBe("options");
  expect(menu.cursor).toBe(0);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("enter change");
  expect(menu.enter(s, prefs)).toBeNull();
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/│\s+✓ Auto\s+Sign in first/);
  // Turning things off is up to each use's own switch.
  expect(text).not.toContain("No summaries");
  expect(text).toContain("enter use");
  // The choice in use has nothing to apply.
  expect(menu.enter(s, prefs)).toBeNull();
  // Keys wrap past either end; the wheel stops there.
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "auto" });
  menu.enter(s, prefs);
  menu.move(true, s, prefs, false);
  menu.move(true, s, prefs, false);
  expect(menu.enter(s, prefs)).toBeNull();
  menu.enter(s, prefs);
  menu.move(true, s, prefs);
  menu.move(true, s, prefs);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
  // Clicks open it and choose.
  const row = hits(menu, 100, 30, s, prefs).find(hit => "option" in hit && hit.option === 0)!;
  expect(menu.click(row, s, prefs)).toBeNull();
  const codex = choiceHit(menu, /GPT-6 Luna/, s, prefs);
  expect(menu.click(codex, s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
  // Left closes the dropdown, then returns to the list.
  menu.enter(s, prefs);
  expect(menu.back()).toBe(true);
  expect(menu.focus).toBe("options");
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).not.toContain("✓");
  // The options wrap too: the model, two uses and Smart Links.
  menu.move(true, s, prefs);
  expect(menu.cursor).toBe(1);
  for (let i = 0; i < 6; i++) menu.move(true, s, prefs, false);
  expect(menu.cursor).toBe(3);
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

test("Pi shows fetching in the model picker and keeps cached choices usable", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ loading: true });
  expect(menu.enter(s, prefs)).toBeNull();
  expect(menu.enter(s, prefs)).toBeNull();
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Pi");
  expect(text).toContain("Fetching models…");
  expect(text).not.toContain("Sign in through Pi first");
  const available = [{ provider: "pi", model: "custom/cached", name: "Cached model", account: "" }];
  const cached = status({ loading: true, available });
  text = draw(menu, 100, 30, 0, cached, prefs).join("\n");
  expect(text).toMatch(/Pi\s+1 model ◌/);
  expect(text).not.toMatch(/Cached model.*Fetching|Pi\s+Fetching/);
  expect(text).toContain("Cached model");
  // Auto, Codex, Claude, Pi Auto, then its cached model.
  for (let i = 0; i < 4; i++) menu.move(true, cached, prefs);
  expect(menu.enter(cached, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "custom/cached",
    account: "",
  });
});

test("Pi's grouped models scroll inside the frame and selection carries the exact model and account", () => {
  const menu = Menu.open(),
    prefs = new Preferences();
  const available = Array.from({ length: 80 }, (_, i) => ({
    provider: "pi",
    model: `custom/model-${i}`,
    name: `Model ${i}`,
    account: "/pi/work",
    account_name: "Work",
    subscription: i === 0,
    input_cost: i + 1,
    output_cost: i + 2,
  }));
  const s = status({
    choice: "pi",
    provider: "pi",
    model: "custom/model-0",
    account: "/pi/work",
    available,
    selection: { provider: "pi", model: "custom/model-0", account: "/pi/work" },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  let rows = draw(menu, 100, 40, 0, s, prefs),
    text = rows.join("\n");
  expect(text).toMatch(/Model 0\s+\(auto choice\)/);
  expect(text).not.toMatch(/cheapest/i);
  expect(text).toContain("Model 4");
  expect(text).not.toContain("Model 5");
  expect(text).toContain("Show 75 more");
  const model_column = rows.find(row => /Model 0\s+\(auto choice\)/.test(row))!.indexOf("Model 0");
  for (let i = 0; i < 5; i++) menu.move(true, s, prefs, false);
  const more = choiceHit(menu, /Show 75 more/, s, prefs, 100, 24);
  expect(menu.click(more, s, prefs)).toBeNull();
  expect(menu.modelSearch()).not.toBeNull();
  for (let i = 0; i < 65; i++) menu.move(true, s, prefs, false);
  rows = draw(menu, 100, 24, 0, s, prefs);
  text = rows.join("\n");
  expect(text).toContain("Model 70");
  expect(text).toMatch(/Model 0\s+\(auto choice\)/);
  expect(rows.find(row => row.includes("Model 70"))!.indexOf("Model 70")).toBe(model_column);
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "custom/model-70",
    account: "/pi/work",
  });
});

test("scrolling keeps agent and provider headers sticky and mouse choices mapped to the visible model", () => {
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
  for (let i = 0; i < 5; i++) menu.move(true, s, prefs, false);
  menu.click(choiceHit(menu, /Show 35 more/, s, prefs, 100, 24), s, prefs);
  for (let i = 0; i < 25; i++) menu.move(true, s, prefs, false);
  const rows = draw(menu, 100, 24, 0, s, prefs),
    search = rows.findIndex(row => row.includes("Search models")),
    agent = rows[search + 1],
    account = rows[search + 2];
  expect(agent).toMatch(/Pi\s+40 models/);
  expect(account).toContain("OpenAI Codex");
  expect(account).toContain("Pro 500");
  expect(account).toContain("personal@example.com");
  expect(rows.some(row => /│   Codex\s/.test(row))).toBe(false);
  expect(rows.join("\n")).toContain("Model 30");
  expect(rows[search + 3]).toMatch(/Model 0\s+\(auto choice\)/);
  expect(rows[search + 3].indexOf("(auto choice)")).toBe(account.indexOf("personal@example.com"));
  expect(rows[search + 4]).toContain("GitHub Copilot");
  expect(rows[search + 4]).toContain("Business");
  expect(menu.hit(100, 24, agent.indexOf("Pi"), search + 1, s, prefs)).toBeNull();
  expect(menu.hit(100, 24, account.indexOf("OpenAI"), search + 2, s, prefs)).toBeNull();
  expect(menu.click(choiceHit(menu, /Model 29\b/, s, prefs, 100, 24), s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "github-copilot/model-29",
    account: "/work",
  });
});

test("model search filters the complete list like Manage Agents, including collapsed models", () => {
  const menu = Menu.open(),
    prefs = new Preferences();
  const available = Array.from({ length: 30 }, (_, i) => ({
    provider: "pi",
    model: `custom/model-${i}`,
    name: `Model ${i}`,
    account: "/pi/work",
    account_name: "Work",
  }));
  const s = status({ choice: "pi", provider: "pi", model: "custom/model-0", available });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  for (const byte of Buffer.from("WORK model-29")) expect(menu.key(byte)).toBe(true);
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Model 29");
  expect(text).not.toContain("Model 28");
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "custom/model-29",
    account: "/pi/work",
  });
  menu.enter(s, prefs);
  for (const byte of Buffer.from("no-such-model")) menu.paste(byte);
  expect(draw(menu, 100, 30, 0, s, prefs).join("\n")).toContain("No matching models");
  expect(menu.escape()).toBe(true);
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Search models");
  expect(text).toContain("Show 25 more");
});

test("the auto choice is visible outside the collapsed shortlist and stays as non-selectable context during search", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "pi",
      provider: "pi",
      model: "basic/model-0",
      selection: { provider: "pi", model: "basic/model-0", account: "" },
      available: Array.from({ length: 30 }, (_, i) => ({
        provider: "pi",
        model: `${i === 7 ? "priority" : "basic"}/model-${i}`,
        name: `Model ${i}`,
        account: "",
        account_name: "work@example.com",
        subscription: true,
        ready: i === 7 ? true : null,
        plan: "Pro 500",
      })),
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  let rows = draw(menu, 100, 40, 0, s, prefs);
  expect(rows.join("\n")).toMatch(/Model 7\s+\(auto choice\)/);
  expect(rows.join("\n")).not.toContain("Model 6");
  const candidate = rows.findIndex(row => /Model 7\s+\(auto choice\)/.test(row));
  expect(rows[candidate - 1]).toMatch(/priority\s+work@example.com\s+Pro 500/);
  for (const byte of Buffer.from("Model 29")) menu.key(byte);
  rows = draw(menu, 100, 24, 0, s, prefs);
  const context = rows.findIndex(row => /Model 7\s+\(auto choice\)/.test(row));
  expect(context).toBeGreaterThanOrEqual(0);
  expect(menu.hit(100, 24, rows[context].indexOf("Model 7"), context, s, prefs)).toBeNull();
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "pi", model: "basic/model-29", account: "" });
});

test("narrow pickers preserve the aligned auto-choice label even when a model name is clipped", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      available: [
        {
          provider: "pi",
          model: "custom/long",
          name: "A very long custom model name that cannot fit",
          account: "",
          subscription: true,
        },
      ],
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 44, 30, 0, s, prefs),
    candidate = rows.find(row => row.includes("(auto choice)"))!;
  expect(candidate).toBeDefined();
  expect(candidate).toContain("…");
  expect(candidate).toContain("│ ");
});

test("a wider plan table captures clicks over the settings list instead of selecting a setting", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ models: { codex: "gpt-6-luna" } });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    options: {
      codex: {
        account: "very.long.account@example.com",
        plan: "Enterprise (Automation)",
        signed_in: true,
        limits: { windows: [null, null] },
      },
    },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 100, 30, 0, s, prefs),
    y = rows.findIndex(row => /[├╰]  GPT-6 Luna/.test(row)),
    x = rows[y].indexOf("GPT-6 Luna"),
    hit = menu.hit(100, 30, x, y, s, prefs);
  expect(x).toBeLessThan(30);
  expect(hit).toHaveProperty("choice");
  expect(menu.click(hit!, s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
});

test("model picker nests models under provider accounts with aligned identities", () => {
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
          provider: "pi",
          model: "openai-codex/sol",
          name: "GPT-6.1 Sol",
          account: "",
          account_name: "Personal",
          plan: "Pro 500",
          subscription: true,
        },
        {
          provider: "opencode2",
          model: "github-copilot/haiku",
          name: "Claude Haiku 5.5",
          account: "",
          account_name: "Work",
          plan: "Business",
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
      codex: { account: "Personal", plan: "Pro 500", signed_in: true, limits: { windows: [null, null] } },
      claude: { account: "Work", signed_in: true, limits: "metered" },
    },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 100, 40, 0, s, prefs),
    roots = ["Codex", "Claude", "Pi", "OpenCode"].map(name =>
      rows.findIndex(row => new RegExp(`│   ${name}\\s`).test(row)),
    ),
    root_column = rows[roots[0]].indexOf("Codex"),
    account_column = rows[roots[0] + 1].indexOf("Personal");
  for (const [i, name] of ["Codex", "Claude", "Pi", "OpenCode"].entries()) {
    expect(rows[roots[i]].indexOf(name)).toBe(root_column);
    expect(menu.hit(100, 40, root_column, roots[i], s, prefs)).toBeNull();
  }
  const billing_column = rows[roots[0] + 1].indexOf("Pro 500");
  for (const [label, user, billing] of [
    ["OpenAI", "Personal", "Pro 500"],
    ["Anthropic", "Work", "Metered"],
    ["OpenAI Codex", "Personal", "Pro 500"],
    ["GitHub Copilot", "Work", "Business"],
  ]) {
    const y = rows.findIndex(row => row.slice(root_column).startsWith(label + " "));
    expect(rows[y].indexOf(label)).toBe(root_column);
    expect(rows[y].indexOf(user)).toBe(account_column);
    expect(rows[y].indexOf(billing)).toBe(billing_column);
    expect(rows[y]).not.toContain("…");
    expect(menu.hit(100, 40, root_column, y, s, prefs)).toBeNull();
  }
  const models = rows.filter(row =>
    /[├╰]  (?:GPT-6 Luna|Haiku 5.5|GPT-6.1 Sol|Claude Haiku 5.5|MAI-Code-1.1-Flash)/.test(row),
  );
  expect(models).toHaveLength(6);
  for (const [i, name] of [
    "GPT-6 Luna",
    "Haiku 5.5",
    "GPT-6 Luna",
    "GPT-6.1 Sol",
    "Claude Haiku 5.5",
    "MAI-Code-1.1-Flash",
  ].entries()) {
    expect(models[i].indexOf(name)).toBe(root_column + 3);
    expect(models[i]).not.toMatch(/Personal|Work|Sub|Tokens|…/);
  }
  expect(models[0]).toContain("✓ ╰  GPT-6 Luna");
  expect(models[2].indexOf("├")).toBe(root_column);
  expect(models[3].indexOf("╰")).toBe(root_column);
  expect(models[2]).toContain("(auto choice)");
  expect(models[4]).toContain("(auto choice)");
  expect(models[2].indexOf("(auto choice)")).toBe(account_column);
  expect(models[4].indexOf("(auto choice)")).toBe(account_column);
  expect(rows.find(row => /Pi\s+2 models/.test(row))!.indexOf("2 models")).toBe(account_column);
  const text = rows.join("\n");
  expect(text).not.toMatch(/included|checked|login|\(Sub\)/);
  expect(rows.find(row => row.includes("Search models"))!.indexOf("Billing")).toBe(billing_column);
  for (const root of roots.slice(1)) expect(rows[root - 1].slice(root_column, root_column + 12)).toBe(" ".repeat(12));
  const writer = new Writer(),
    harness = new Style({ fg: "accent", bg: "surface", bold: true }).sgr(),
    account = new Style({ fg: "muted", bg: "surface", bold: true }).sgr();
  menu.drawAt(writer, s, prefs, 100, 40, 0);
  for (const name of ["Codex", "Claude", "Pi", "OpenCode"]) expect(writer.s).toContain(harness + name);
  expect(writer.s).toContain(account + "OpenAI");
});

test("native named accounts are listed and searchable with their exact inference account", () => {
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
        option: { account: "Personal", plan: "API", limits: "metered", signed_in: true, model: "nvidia/kimi-k3" },
      },
    ],
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 100, 40, 0, s, prefs),
    accounts = rows.filter(row => row.includes("nvidia") && !/[├╰].*nvidia/.test(row));
  expect(accounts).toHaveLength(2);
  for (const row of accounts) expect(row).toContain("Metered");
  expect(rows.some(row => row.includes("✓ ╰  Haiku"))).toBe(true);
  for (const byte of Buffer.from("nvidia Codex")) menu.key(byte);
  expect(draw(menu, 100, 30, 0, s, prefs).some(row => /│   Claude\s/.test(row))).toBe(false);
  expect(menu.enter(s, prefs)).toEqual({
    kind: "summaries",
    choice: "codex",
    model: "gpt-6-luna",
    account: "/codex/nvidia",
  });
});

test("native accounts show cheap shortlists and expand to every model without borrowing chat defaults", () => {
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
      s = status({ choice: provider, provider, available });
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
    let rows = draw(menu, 100, 40, 0, s, prefs),
      text = rows.join("\n");
    expect(text).toContain("Show 6 more");
    expect(text).not.toContain("Heavy chat model");
    const account = rows.findIndex(row => /nvidia\s+work@example.com/.test(row));
    expect(rows[account]).toContain("Metered");
    expect(rows[account + 1]).toContain("Cheap model");
    expect(rows.find(row => row.includes("(auto choice)"))).toContain("Cheap model");
    menu.click(choiceHit(menu, /Show 6 more/, s, prefs, 100, 40), s, prefs);
    rows = draw(menu, 100, 40, 0, s, prefs);
    text = rows.join("\n");
    expect(text).toContain("Show fewer");
    expect(rows.filter(row => /[├╰]  Heavy chat model/.test(row))).toHaveLength(2);
    expect(rows.filter(row => /nvidia\s+work@example.com/.test(row))).toHaveLength(1);
    for (const byte of Buffer.from("nvidia Heavy")) menu.key(byte);
    expect(draw(menu, 100, 40, 0, s, prefs).join("\n")).toContain("Heavy chat model");
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
  expect(rows.some(row => row.includes("GPT-6 Luna"))).toBe(true);
  expect(rows.some(row => row.includes("✓ ╰  nvidia/kimi-k3"))).toBe(true);
  expect(menu.click(choiceHit(menu, /GPT-6 Luna/, s, prefs, 100, 40), s, prefs)).toEqual({
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

test("cached models stay visible while refreshing with only a quiet heading indicator", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "pi",
      provider: "pi",
      loading: true,
      available: [
        { provider: "pi", model: "custom/cached", name: "Cached model", account: "", ready: true },
        { provider: "opencode2", model: "custom/old", name: "Older model", account: "", ready: false },
        { provider: "omp", model: "custom/omp", name: "omp model", account: "", ready: true },
      ],
    });
  menu.enter(s, prefs);
  let text = draw(menu, 100, 40, 0, s, prefs).join("\n");
  expect(text).not.toMatch(/checking|Checking/);
  menu.enter(s, prefs);
  text = draw(menu, 100, 40, 0, s, prefs).join("\n");
  expect(text).toMatch(/Pi\s+1 model ◌/);
  expect(text).toMatch(/OpenCode\s+1 model ◌/);
  expect(text).toMatch(/omp\s+1 model ◌/);
  expect(text).toContain("Cached model");
  expect(text).toContain("Older model");
  expect(text).not.toContain("Fetching models");
  expect(text).not.toMatch(/checking|Checking/);
});

test("a narrow model picker clips metadata without overlapping names or borders", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      available: [
        {
          provider: "pi",
          model: "a-very-long-provider/model",
          name: "A very long model name",
          account: "/work",
          account_name: "A very long account name",
          subscription: true,
        },
      ],
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const rows = draw(menu, 50, 30, 0, s, prefs),
    model = rows.find(row => row.includes("(auto choice)"))!;
  expect(model).toBeDefined();
  expect(model).toContain("…");
  const account = rows.find(row => row.includes("a-very-long"))!;
  expect(account).toContain("…");
  expect(model.trimEnd().endsWith("│ │")).toBe(true);
  const hit = choiceHit(menu, /[├╰]  .*\(auto choice\)/, s, prefs, 50, 30);
  expect(menu.click(hit, s, prefs)).toEqual({
    kind: "summaries",
    choice: "pi",
    model: "a-very-long-provider/model",
    account: "/work",
  });
});

test("model billing distinguishes plans, token pricing, free models and unknown prices", () => {
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
  const rows = draw(menu, 100, 40, 0, s, prefs);
  for (const [model, label] of [
    ["Plan model", "Plan"],
    ["Token model", "Metered"],
    ["Free model", "Free"],
    ["Unknown model", "Unknown"],
  ]) {
    const y = rows.findIndex(row => row.includes(model) && !row.includes("Auto"));
    expect(rows[y - 1]).toContain("custom");
    expect(rows[y - 1]).toContain(label);
    expect(rows[y]).not.toContain("…");
  }
});

test("native model rows show and search the signed-in user without assuming a billing type", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({ models: { codex: "gpt-6-luna" } });
  menu.agents = new LauncherMenu();
  menu.agents.preview = preview({
    options: {
      codex: { account: "tal@example.com", signed_in: true },
    },
  });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  for (const byte of Buffer.from("tal@")) menu.key(byte);
  const rows = draw(menu, 100, 30, 0, s, prefs),
    account = rows.find(row => /OpenAI\s+tal@example.com/.test(row))!;
  expect(account).toContain("tal@example.com");
  expect(rows.join("\n")).toContain("GPT-6 Luna");
  expect(account).not.toMatch(/Sub|Tokens/);
  expect(rows.join("\n")).not.toContain("Claude");
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "codex" });
});

test("OpenCode groups and searches its models and applies the exact selection", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "opencode2",
      provider: "opencode2",
      model: "openai/sol",
      models: { opencode2: "openai/sol" },
      available: [
        { provider: "opencode2", model: "openai/sol", name: "Sol", account: "", subscription: true, ready: true },
        {
          provider: "opencode2",
          model: "custom/tiny",
          name: "Tiny",
          account: "",
          input_cost: 1,
          output_cost: 5,
          ready: false,
        },
      ],
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  let text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("2 models");
  expect(text).toMatch(/Sol\s+\(auto choice\)/);
  expect(text).toContain("Check failed");
  expect(text).toMatch(/OpenAI\s+—\s+Plan/);
  expect(text).not.toMatch(/included|checked/);
  for (const byte of Buffer.from("tiny")) menu.key(byte);
  text = draw(menu, 100, 30, 0, s, prefs).join("\n");
  expect(text).toContain("Tiny");
  expect(text).toMatch(/Sol\s+\(auto choice\)/);
  expect(menu.enter(s, prefs)).toEqual({ kind: "summaries", choice: "opencode2", model: "custom/tiny", account: "" });
});

test("OpenCode Auto reports unverified access rather than claiming no model works", () => {
  const menu = Menu.open(),
    prefs = new Preferences(),
    s = status({
      choice: "opencode2",
      available: [
        { provider: "opencode2", model: "github/cheap", name: "Cheap", account: "", ready: false },
        { provider: "opencode2", model: "other/untested", name: "Untested", account: "" },
      ],
    });
  menu.enter(s, prefs);
  menu.enter(s, prefs);
  const text = draw(menu, 120, 30, 0, s, prefs).join("\n");
  expect(text).toMatch(/✓ Auto\s+No verified model yet/);
  expect(text).toContain("Check failed");
  expect(text).not.toContain("No working model found");
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
  // The presets, Prefix, then All keys; cmux is a preset only on macOS.
  const all_keys = km.available_presets.length + 1;
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
  expect(menu.intensityKey("left", prefs)).toBeNull();
  menu.openOptions(s, prefs);
  expect(menu.intensityKey("left", prefs)).toEqual({ kind: "corgi_intensity", value: 45 });
  expect(menu.intensityKey("right", prefs)).toEqual({ kind: "corgi_intensity", value: 55 });
  expect(menu.intensityKey("home", prefs)).toEqual({ kind: "corgi_intensity", value: 0 });
  expect(menu.intensityKey("end", prefs)).toEqual({ kind: "corgi_intensity", value: 100 });
  prefs.corgi_intensity = 0;
  expect(menu.intensityKey("left", prefs)).toEqual({ kind: "corgi_intensity", value: 0 });
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
    expect(menu.hit(cols, rows, left, y, s, prefs)).toEqual({ intensity: 0 });
    expect(menu.hit(cols, rows, right, y, s, prefs)).toEqual({ intensity: 100 });
    expect(menu.click({ intensity: 25 }, s, prefs)).toBeNull();
    expect(menu.previewIntensity(prefs)).toBe(25);
    expect(prefs.corgi_intensity).toBe(50);
    menu.dragIntensity(cols, rows, -20);
    expect(menu.previewIntensity(prefs)).toBe(0);
    expect(draw(menu, cols, rows, 0, s, prefs).join("\n")).not.toContain("~ᐯ");
    menu.dragIntensity(cols, rows, cols + 20);
    expect(menu.finishIntensity()).toEqual({ kind: "corgi_intensity", value: 100 });
    expect(menu.draggingIntensity()).toBe(false);
    menu.click({ intensity: 0 }, s, prefs);
    menu.back();
    expect(menu.previewIntensity(prefs)).toBe(50);
    expect(menu.finishIntensity()).toBeNull();
  }
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
    "hold",
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
  expect(text).toContain("○ tmux       Classic splits");
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
    launch.manager.back_label = "Settings";
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
  const accountRows = (rows: string[]) =>
    rows
      .filter(row => row.includes("Claude Code") && row.includes("@"))
      .map(row => row.slice(row.indexOf("Claude Code")).replace(/[│ ]+$/, ""));
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
