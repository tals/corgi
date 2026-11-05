import { expect, test } from "bun:test";
import { Rect } from "./layout";
import { colors, type Token } from "./palette";
import { Writer } from "./text";
import type { Provider } from "./providers";
import type { Effort } from "./providers/effort";
import { Window } from "./usage/account";
import {
  Picker,
  accountBrief,
  accountHeader,
  accountParts,
  brief,
  label,
  type Brief,
  type Choice,
  type Entry,
} from "./model_picker";
import { writeMark, type Marks } from "./provider_mark";

type Cell = { ch: string; fg: Token | null; bg: Token | null; bold: boolean };
const token = (rgb: number[]) =>
  (Object.keys(colors) as Token[]).find(t => colors[t].every((v, i) => v === rgb[i])) ?? null;
/** The screen after replaying `ansi`: each cell's character, colors as tokens, and weight. */
function screen(ansi: string, cols: number, rows: number): Cell[][] {
  const grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (): Cell => ({ ch: " ", fg: null, bg: null, bold: false })),
  );
  let x = 0,
    y = 0,
    saved = [0, 0],
    pen: Omit<Cell, "ch"> = { fg: null, bg: null, bold: false };
  for (const m of ansi.matchAll(/\x1b_[^\x1b]*\x1b\\|\x1b([78])|\x1b\[([\d;?]*)([A-Za-z])|([\s\S])/gu)) {
    if (m[1] === "7") saved = [x, y];
    else if (m[1] === "8") [x, y] = saved;
    else if (m[3] === "H") {
      const [r, c] = (m[2] || "1;1").split(";").map(Number);
      [y, x] = [r - 1, c - 1];
    } else if (m[3] === "m") {
      const f = (m[2] || "0").split(";").map(Number);
      for (let i = 0; i < f.length; i++) {
        if (f[i] === 0) pen = { fg: null, bg: null, bold: false };
        else if (f[i] === 1) pen.bold = true;
        else if (f[i] === 22) pen.bold = false;
        else if (f[i] === 38 || f[i] === 48) {
          pen[f[i] === 38 ? "fg" : "bg"] = token(f.slice(i + 2, i + 5));
          i += 4;
        }
      }
    } else if (m[4] !== undefined) {
      if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = { ch: m[4], ...pen };
      x++;
    }
  }
  return grid;
}
const text = (grid: Cell[][]) =>
  grid.map(row =>
    row
      .map(c => c.ch)
      .join("")
      .trimEnd(),
  );

function entry(provider: Provider, model: string, name: string, efforts: Effort[], fields: Partial<Entry> = {}): Entry {
  return { provider, account: "", account_name: "", model, name, efforts, default_effort: null, ...fields };
}
const entries: Entry[] = [
  entry("codex", "gpt-6-astra", "GPT-6 Astra", ["minimal", "low", "medium", "high", "xhigh"], {
    default_effort: "medium",
  }),
  entry("codex", "gpt-6-luna", "GPT-6 Luna", ["none", "low", "medium", "high"], { default_effort: "low" }),
  entry("claude", "claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh", "max"]),
  entry("claude", "claude-haiku-5-5", "Haiku 5.5", ["low", "medium", "high"]),
  entry("pi", "openai-codex/gpt-6-luna", "GPT-6 Luna", []),
];
/** The same with a second Claude account. */
const work = entry("claude", "claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh", "max"], {
  account: "/home/me/.claude-work",
  account_name: "work",
});
const both = [...entries, work];
const briefs: Brief[] = [
  brief("claude", "", ["Max", "5h 12%", "7d 48%"]),
  brief("claude", "/home/me/.claude-work", ["Team", "5h 3%"]),
  brief("codex", "", ["Pro", "5h 30%"]),
];
const choice = (e: Entry, effort: Effort | null): Choice => ({
  provider: e.provider,
  account: e.account,
  model: e.model,
  name: e.name,
  effort,
});
const opus = choice(entries[2], "high"),
  astra = choice(entries[0], "xhigh"),
  haiku = choice(entries[3], "low");
const picker = (current: Choice | null = opus, suggested = [opus, astra, haiku], list = entries) =>
  new Picker(list, suggested, current, briefs);
const at = (cols: number, rows: number) => new Rect(2, 1, cols, rows);
function draw(p: Picker, cols = 60, marks: Marks | null = null, now = 0): Cell[][] {
  const w = new Writer(),
    rect = at(cols, p.height(20));
  p.draw(w, rect, marks, now);
  return screen(w.s, cols + 4, rect.h + 2);
}
const left = "\x1b[D",
  right = "\x1b[C",
  up = "\x1b[A",
  down = "\x1b[B";

test("a choice reads as its model and effort", () => {
  expect(label(opus)).toBe("Opus 5.5 · High");
  expect(label({ ...astra, effort: "xhigh" })).toBe("GPT-6 Astra · XHigh");
  expect(label({ ...haiku, effort: null })).toBe("Haiku 5.5");
  expect(label({ ...haiku, name: "", model: "claude-sonnet-5-5", effort: null })).toBe("Sonnet 5.5");
});

test("a brand mark is a placed image when the host takes one, else the glyph", () => {
  const w = new Writer();
  writeMark(w, "claude", 4, 2, () => "<img>");
  expect(w.s).toBe("\x1b[3;5H  <img>");
  const glyph = new Writer();
  writeMark(glyph, "codex", 4, 2, () => "");
  expect(text(screen(glyph.s, 8, 4))[2]).toBe("    †");
  const none = new Writer();
  writeMark(none, "claude", 0, 0, null);
  expect(screen(none.s, 4, 1)[0][0]).toMatchObject({ ch: "*", fg: "hot" });
});

test("it opens on the current model, each agent's models under its header, their efforts at the right", () => {
  const p = picker();
  expect(p.chosen()).toEqual(opus);
  expect(p.height(20)).toBe(8);
  const grid = draw(p);
  expect(text(grid)).toEqual([
    "",
    "  ╭──────────────────────────────────────────────────────────╮",
    "  │  /  Search models, agents and accounts         5 models  │",
    "  │ *  Claude                          Max · 5h 12% · 7d 48% │",
    "  │      ✓ Opus 5.5                             High  Edit › │",
    "  │        Haiku 5.5                             Low  Edit › │",
    "  │ †  Codex                                    Pro · 5h 30% │",
    "  │        GPT-6 Astra                         XHigh  Edit › │",
    "  ╰─ → effort · ⏎ pick · esc close ──────────────────────────╯",
    "",
  ]);
  // The highlighted row stands out; a header names its agent in bold and its account's brief faintly.
  expect(grid[4][12]).toMatchObject({ bg: "selected" });
  expect(grid[5][12]).toMatchObject({ bg: "surface" });
  expect(grid[3][text(grid)[3].indexOf("Claude")]).toMatchObject({ fg: "strong", bold: true });
  expect(grid[6][text(grid)[6].indexOf("Pro")]).toMatchObject({ fg: "faint", bg: "surface" });
});

const headers: Brief[] = [
  { ...briefs[0], who: "me@x.com", plan: "Max", limits: ["5h 12%", "7d 48%"] },
  { ...briefs[1], who: "work@x.com", plan: "Team", limits: ["5h 3%"] },
  { ...briefs[2], who: "", plan: "Pro", limits: ["5h 30%"] },
];

test("an account's header lines up who it's signed in as, its plan and its limits in columns", () => {
  expect(text(draw(new Picker(entries, [opus, astra, haiku], opus, headers))).slice(3, 7)).toEqual([
    "  │ *  Claude             me@x.com      Max  5h 12% · 7d 48% │",
    "  │      ✓ Opus 5.5                             High  Edit › │",
    "  │        Haiku 5.5                             Low  Edit › │",
    "  │ †  Codex                            Pro           5h 30% │",
  ]);
  // Narrow, who it is goes first.
  expect(text(draw(new Picker(entries, [opus, astra, haiku], opus, headers), 40)).slice(2, 4)).toEqual([
    "  │  /  Search models          5 models  │",
    "  │ *  Claude             Max     5h 12% │",
  ]);
});

test("an agent with several accounts heads each one's models with its own row, the current model's first", () => {
  const current = choice(work, "max"),
    p = new Picker(both, [opus, astra, haiku], current, headers);
  expect(p.chosen()).toEqual(current);
  expect(p.height(20)).toBe(11);
  expect(text(draw(p)).slice(3, 11)).toEqual([
    "  │ *  Claude                                                │",
    "  │      work@x.com                    Team            5h 3% │",
    "  │      ✓ Opus 5.5                              Max  Edit › │",
    "  │      me@x.com                      Max   5h 12% · 7d 48% │",
    "  │        Opus 5.5                             High  Edit › │",
    "  │        Haiku 5.5                             Low  Edit › │",
    "  │ †  Codex                           Pro            5h 30% │",
    "  │        GPT-6 Astra                         XHigh  Edit › │",
  ]);
  // Not the account's name, which for the default one is its agent's in
  // Manage agents, often a model's; that only when who it is isn't known.
  const named = both.map(e => (e.provider === "claude" && !e.account ? { ...e, account_name: "Opus" } : e));
  expect(text(draw(new Picker(named, [opus, astra, haiku], current, headers))).slice(4, 7)).toEqual([
    "  │      work@x.com                    Team            5h 3% │",
    "  │      ✓ Opus 5.5                              Max  Edit › │",
    "  │      me@x.com                      Max   5h 12% · 7d 48% │",
  ]);
  expect(text(draw(new Picker(named, [opus, astra, haiku], current, briefs))).slice(4, 7)).toEqual([
    "  │      work                                   Team · 5h 3% │",
    "  │      ✓ Opus 5.5                              Max  Edit › │",
    "  │      Opus                          Max · 5h 12% · 7d 48% │",
  ]);
  // Narrow, a long one shortens before the plan and the first limit go.
  const long = headers.map(h => (h.account ? { ...h, who: "someone.with.a.long.name@example.com" } : h));
  expect(text(draw(new Picker(both, [opus, astra, haiku], current, long), 44)).slice(4, 5)).toEqual([
    "  │      someone.with.a.long.…  Team   5h 3% │",
  ]);
  // Searching finds an account by who it is.
  const q = new Picker(both, [], current, headers);
  q.key(47);
  q.sequence("work@");
  expect(q.chosen()).toEqual(current);
});

test("arrows move past headers and wrap; Home and End go to the ends", () => {
  const p = picker();
  p.sequence(down);
  expect(p.chosen()).toEqual(haiku);
  p.sequence(down);
  expect(p.chosen()).toEqual(astra);
  p.sequence(down);
  expect(p.chosen()).toEqual(opus);
  p.sequence(up);
  expect(p.chosen()).toEqual(astra);
  p.sequence("\x1b[H");
  expect(p.chosen()).toEqual(opus);
  p.sequence("\x1b[F");
  expect(p.chosen()).toEqual(astra);
});

test("search finds models by their account's plan", () => {
  for (const [plan, account] of [
    ["Max", ""],
    ["Team", "/home/me/.claude-work"],
  ]) {
    const p = new Picker(both, [], opus, headers);
    p.key(47);
    p.sequence(plan);
    expect(p.chosen().provider).toBe("claude");
    expect(p.chosen().account).toBe(account);
  }
});

test("→ opens the model's efforts on the one it has; ⏎ chooses one and picks, ← goes back", () => {
  const p = picker();
  expect(p.sequence(right)).toBeNull();
  expect(p.editing).toBe(true);
  expect(text(draw(p)).slice(1, 9)).toEqual([
    "  ╭──────────────────────────────────────────────────────────╮",
    "  │ ‹ Opus 5.5 · Effort                            *  Claude │",
    "  │   Default                                                ┃",
    "  │   Low                                                    ┃",
    "  │   Medium                                                 ┃",
    "  │ ✓ High                                                   ┃",
    // Max is below, as the thumb says.
    "  │   XHigh                                                  │",
    "  ╰─ ← back · ⏎ choose effort ───────────────────────────────╯",
  ]);
  p.sequence(up);
  expect(p.key(13)).toBe("pick");
  expect(p.editing).toBe(false);
  expect(p.chosen()).toEqual({ ...opus, effort: "medium" });
  // ← and esc go back without choosing.
  p.sequence(right);
  p.sequence(down);
  p.sequence(left);
  expect(p.editing).toBe(false);
  p.sequence(right);
  p.sequence(down);
  expect(p.key(27)).toBeNull();
  expect(p.editing).toBe(false);
  expect(p.chosen()).toEqual({ ...opus, effort: "medium" });
});

test("a model with no efforts has no list to open, and a model at its default opens on Default", () => {
  const p = new Picker(entries, [choice(entries[4], null)], choice(entries[4], null), briefs);
  p.sequence(right);
  expect(p.editing).toBe(false);
  const q = picker({ ...opus, effort: null }, []);
  q.sequence(right);
  expect(text(draw(q))[4]).toBe("  │ ✓ Default                                                │");
  q.sequence(down);
  q.key(13);
  expect(q.chosen().effort).toBe("low");
});

test("enter picks the highlighted model; esc closes", () => {
  const p = picker();
  p.sequence(down);
  p.sequence(down);
  expect(p.key(13)).toBe("pick");
  expect(p.chosen()).toEqual(astra);
  expect(picker().key(27)).toBe("close");
});

test("/ searches every model by name, id, agent and account", () => {
  const p = picker();
  expect(p.key(47)).toBeNull();
  expect(p.searching).toBe(true);
  // The box keeps its height.
  expect(p.height(30)).toBe(8);
  for (const ch of "luna") p.key(ch.charCodeAt(0));
  expect(text(draw(p)).slice(1, 7)).toEqual([
    "  ╭──────────────────────────────────────────────────────────╮",
    "  │  /  luna                                         2 of 5  │",
    "  │ †  Codex                                    Pro · 5h 30% │",
    "  │        GPT-6 Luna                            Low  Edit › │",
    "  │ π  Pi · OpenAI Codex                                     │",
    "  │        GPT-6 Luna                                        │",
  ]);
  const find = (query: string) => {
    const q = picker(opus, [], both);
    q.key(47);
    q.sequence(query);
    const found: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = q.chosen();
      if (!found.includes(`${c.provider} ${c.account || "-"} ${c.model}`))
        found.push(`${c.provider} ${c.account || "-"} ${c.model}`);
      q.sequence(down);
    }
    return found.sort();
  };
  expect(find("work")).toEqual(["claude /home/me/.claude-work claude-opus-5-5"]);
  expect(find("codex luna")).toEqual(["codex - gpt-6-luna", "pi - openai-codex/gpt-6-luna"]);
  expect(find("claude code")).toHaveLength(3);
  expect(find("OPUS")).toHaveLength(2);
});

test("backspace edits the query and leaves search once it's empty; esc leaves search first", () => {
  const p = picker();
  p.key(47);
  p.sequence("ha");
  expect(p.chosen()).toEqual(haiku);
  p.key(127);
  p.key(127);
  expect(p.searching).toBe(true);
  p.key(127);
  // Leaving keeps the model the search had highlighted.
  expect(p.searching).toBe(false);
  expect(p.chosen()).toEqual(haiku);
  p.key(47);
  p.sequence("x");
  expect(p.key(27)).toBeNull();
  expect(p.searching).toBe(false);
  expect(p.key(27)).toBe("close");
});

test("typing in the suggestions starts a search with what was typed", () => {
  const p = picker();
  p.key("h".charCodeAt(0));
  p.key("a".charCodeAt(0));
  expect(p.searching).toBe(true);
  expect(p.chosen()).toEqual(haiku);
  p.key(21);
  expect(p.searching).toBe(true);
  const q = picker();
  for (const byte of Buffer.from("é")) q.key(byte);
  expect(text(draw(q))[2]).toContain("/  é");
});

test("an effort chosen on a row stays with that model across search", () => {
  const p = picker();
  p.sequence(down);
  p.sequence(down);
  p.sequence(right);
  p.sequence(up);
  p.key(13);
  p.key(47);
  expect(p.chosen()).toEqual({ ...astra, effort: "high" });
  p.sequence("haiku");
  p.sequence(right);
  p.sequence(down);
  p.key(13);
  p.key(27);
  expect(p.chosen()).toEqual({ ...haiku, effort: "medium" });
});

test("clicks pick a row, open its efforts on Edit, go back on the title, search on the field and close outside", () => {
  const p = picker();
  let rows = text(draw(p));
  expect(p.click(12, 7)).toBe("pick");
  expect(p.chosen()).toEqual(astra);
  // A header picks nothing.
  expect(p.click(12, 6)).toBeNull();
  expect(p.chosen()).toEqual(astra);
  rows = text(draw(p));
  expect(p.click(rows[4].indexOf("Edit"), 4)).toBeNull();
  expect(p.editing).toBe(true);
  expect(p.chosen().model).toBe(opus.model);
  draw(p);
  expect(p.click(10, 2)).toBeNull();
  expect(p.editing).toBe(false);
  const s = picker();
  draw(s);
  expect(s.click(20, 2)).toBeNull();
  expect(s.searching).toBe(true);
  expect(s.click(0, 0)).toBe("close");
  expect(s.click(2, 3)).toBeNull();
});

test("a long search list scrolls under the wheel and keeps the highlight in view", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    // Lettered, as numbers would read as versions of one model.
    entry("codex", `gpt-${i}`, `Model ${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`, []),
  );
  const p = new Picker(many, [], null, []);
  p.key(47);
  expect(p.height(40)).toBe(17);
  let rows = text(draw(p));
  expect(rows[3]).toContain("Codex");
  expect(rows[4]).toContain("Model aa");
  expect(rows.some(r => r.endsWith("┃"))).toBe(true);
  for (let i = 0; i < 5; i++) p.scroll(true);
  rows = text(draw(p));
  expect(rows[3]).toContain("Model ae");
  expect(p.chosen().model).toBe("gpt-4");
  p.sequence("\x1b[F");
  rows = text(draw(p));
  expect(rows[16]).toContain("Model bd");
  p.sequence(down);
  expect(p.chosen().model).toBe("gpt-0");
  // Back at the top, the header shows again over the first model.
  expect(text(draw(p))[3]).toContain("Codex");
});

test("catalogs arriving late fill the suggestions and keep the choice", () => {
  const p = new Picker([], [], null, []);
  expect(text(draw(p))[3]).toContain("Reading models…");
  // It keeps room for the list a catalog brings.
  expect(p.height(20)).toBe(17);
  p.update(entries, briefs);
  expect(p.chosen().provider).toBe("codex");
  p.sequence(down);
  const second = p.chosen();
  p.update(entries, [], [astra, second]);
  expect(p.chosen()).toEqual(second);
});

test("no match says so", () => {
  const p = picker();
  p.key(47);
  p.sequence("zzz");
  expect(text(draw(p))[3]).toContain("No models match");
  expect(p.key(13)).toBeNull();
});

test("marks the host places stand in for the glyphs", () => {
  const placed: [Provider, number, number][] = [];
  draw(picker(), 60, (provider, col, row) => {
    placed.push([provider, col, row]);
    return "";
  });
  // One on each agent's header.
  expect(placed).toEqual([
    ["claude", 4, 3],
    ["codex", 4, 6],
  ]);
});

const auto = { id: "auto", name: "Auto", detail: ["Follow your agents"], glyph: "✦" };
/** No efforts anywhere, as Clever Corgi's models have none. */
const plain = entries.map(e => ({ ...e, efforts: [], default_effort: null }));

test("pins sit above the agents, the current one highlighted, and pick themselves", () => {
  const suggested = [choice(plain[3], null), choice(plain[1], null)],
    p = new Picker(plain, suggested, null, briefs, { pins: [auto], current_pin: "auto" });
  expect(p.pinned()).toBe("auto");
  expect(text(draw(p))).toEqual([
    "",
    "  ╭──────────────────────────────────────────────────────────╮",
    "  │  /  Search models, agents and accounts         5 models  │",
    "  │ ✦  Auto                               Follow your agents │",
    "  │ *  Claude                          Max · 5h 12% · 7d 48% │",
    "  │        Haiku 5.5                                         │",
    "  │ †  Codex                                    Pro · 5h 30% │",
    "  │        GPT-6 Luna                                        │",
    "  ╰─ ⏎ pick · esc close ─────────────────────────────────────╯",
    "",
  ]);
  expect(p.key(13)).toBe("pick");
  p.sequence(down);
  expect(p.pinned()).toBeNull();
  expect(p.chosen()).toEqual(choice(plain[3], null));
  // A current model wins over the current pin.
  expect(new Picker(plain, suggested, choice(plain[1], null), briefs, { pins: [auto] }).pinned()).toBeNull();
});

test("search lists the models it finds first, then the pins whose names match", () => {
  const p = new Picker(plain, [], null, briefs, { pins: [auto], current_pin: "auto" });
  p.key(47);
  p.sequence("luna");
  expect(p.typed()).toBe("luna");
  expect(text(draw(p))[2]).toContain("2 of 5");
  expect(p.pinned()).toBeNull();
  p.key(21);
  p.sequence("aut");
  expect(text(draw(p)).slice(3, 5)).toEqual([
    "  │ ✦  Auto                               Follow your agents │",
    "  │                                                          │",
  ]);
  expect(p.pinned()).toBe("auto");
  p.key(27);
  expect(p.typed()).toBe("");
  // Pins keep their place as catalogs and details change.
  p.update(plain, briefs, undefined, [{ ...auto, detail: ["Follow Claude", "Haiku 5.5"] }]);
  expect(p.pinned()).toBe("auto");
  expect(text(draw(p))[3]).toContain("Follow Claude · Haiku 5.5");
});

test("a model's own brief shows on its row, before its effort", () => {
  const extra = [
    ...briefs,
    brief("claude", "", ["auto"], "claude-opus-5-5"),
    brief("codex", "", ["Check failed"], "gpt-6-luna"),
  ];
  expect(
    text(draw(new Picker(plain, [choice(plain[2], null), choice(plain[1], null)], null, extra))).slice(4, 7),
  ).toEqual([
    "  │        Opus 5.5                                     auto │",
    "  │ †  Codex                                    Pro · 5h 30% │",
    "  │        GPT-6 Luna                           Check failed │",
  ]);
  const rows = text(draw(new Picker(entries, [opus, choice(entries[1], "low")], null, extra)));
  expect(rows[4]).toBe("  │        Opus 5.5                       auto  High  Edit › │");
  expect(rows[6]).toBe("  │        GPT-6 Luna              Check failed  Low  Edit › │");
});

test("an agent reached through several sources heads each source's models", () => {
  const routed = [
    entry("opencode2", "openai/gpt-6.1-sol", "GPT-6.1 Sol", []),
    entry("opencode2", "github-copilot/gpt-6.1-sol", "GPT-6.1 Sol", []),
    entry("omp", "openai-codex/gpt-6-luna", "GPT-6 Luna", []),
  ];
  expect(text(draw(new Picker(routed, [], null, []))).slice(3, 10)).toEqual([
    "  │ o  OpenCode                                              │",
    "  │      OpenAI                                              │",
    "  │        GPT-6.1 Sol                                       │",
    "  │      GitHub Copilot                                      │",
    "  │        GPT-6.1 Sol                                       │",
    // One source names itself beside its agent.
    "  │ ϖ  omp · OpenAI Codex                                    │",
    "  │        GPT-6 Luna                                        │",
  ]);
});

test("short of room, a brief drops its last parts whole, and one without parts is one part", () => {
  const long = (b: Brief) => new Picker(plain, [choice(plain[2], null)], null, [b]);
  const parts = text(draw(long(brief("claude", "", ["Max 20x", "5h 12%", "7d 48%", "Opus 7d 3%"])), 40));
  expect(parts[3]).toMatch(/Claude\s+Max 20x · 5h 12% · 7d 48% │$/);
  // The text shows whole or not at all; its dots aren't read as parts.
  const whole = long({ provider: "claude", account: "", text: "Max 20x · 5h 12% · 7d 48% · Opus 7d 3%" });
  expect(text(draw(whole, 40))[3]).toMatch(/Claude\s+│$/);
  expect(text(draw(long({ provider: "claude", account: "", text: "Max · 5h 12%" }), 40))[3]).toMatch(
    /Claude\s+Max · 5h 12% │$/,
  );
  // A pin's detail drops its parts the same way.
  const pinned = new Picker(plain, [], null, [], {
    pins: [{ ...auto, detail: ["Follow Claude", "Haiku 5.5", "since this morning"] }],
  });
  expect(text(draw(pinned, 30))[3]).toMatch(/Auto\s+Follow Claude │$/);
  expect(text(draw(pinned, 40))[3]).toMatch(/Auto\s+Follow Claude · Haiku 5\.5 │$/);
});

test("hovering highlights the row under the pointer, but not a header", () => {
  const p = picker();
  draw(p);
  p.hover(20, 5);
  expect(p.chosen()).toEqual(haiku);
  // Off the rows, or on a header, the highlight stays.
  p.hover(20, 1);
  p.hover(0, 5);
  p.hover(20, 6);
  expect(p.chosen()).toEqual(haiku);
});

test("an account's brief is its plan, then each window, shortest first; its header splits them", () => {
  expect(
    accountParts({ plan: "Max", limits: { windows: [new Window({ minutes: 300, used: 12 }), null] }, signed_in: true }),
  ).toEqual(["Max", "5h 12%"]);
  expect(brief("claude", "", ["Max", "5h 12%"])).toEqual({
    provider: "claude",
    account: "",
    text: "Max · 5h 12%",
    parts: ["Max", "5h 12%"],
  });
  const window = (minutes: number | null, used: number) => new Window({ minutes, used });
  expect(
    accountBrief({ plan: "Max", limits: { windows: [window(10080, 48), window(300, 12)] }, signed_in: true }),
  ).toBe("Max · 5h 12% · 7d 48%");
  expect(accountBrief({ plan: "Pro", limits: { windows: [null, window(300, 0.4)] }, signed_in: null })).toBe(
    "Pro · 5h <1%",
  );
  expect(accountBrief({ plan: "", limits: "metered", signed_in: true })).toBe("Metered");
  expect(accountBrief({ plan: "API", limits: "metered", signed_in: true })).toBe("API");
  expect(accountBrief({ plan: "Max", limits: "rate_limited", signed_in: true })).toBe("Max · rate limited");
  expect(accountBrief({ plan: "Max", limits: "none", signed_in: false })).toBe("Signed out");
  expect(
    accountHeader("claude", "", {
      account: "me@x.com",
      plan: "Max",
      limits: { windows: [window(10080, 48), window(300, 12)] },
      signed_in: true,
    }),
  ).toMatchObject({ who: "me@x.com", plan: "Max", limits: ["5h 12%", "7d 48%"], text: "Max · 5h 12% · 7d 48%" });
  // Signed out, there's no plan to show, only that.
  expect(accountHeader("claude", "", { plan: "Max", limits: "none", signed_in: false })).toMatchObject({
    plan: "",
    limits: ["Signed out"],
  });
});
