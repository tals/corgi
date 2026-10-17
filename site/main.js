// Frames drawn by corgi's own renderer (src/render.ts), written by
// tools/site_frames.ts as [text, style] runs per row; styles are
// [fg, bg, bold, underline, underline color]. The corgis and spinners over
// them move by corgi's own animation code.
import DATA from "./frames.json";
import * as terminal from "./terminal";
import * as corgiAnimation from "../src/corgi_animation";
import * as corgiFrames from "../src/corgi_frames";
import * as corgiBadge from "../src/assets/corgi_badge";
import * as palette from "../src/palette";

const WAG = corgiFrames.wag;
const BADGE = `data:image/png;base64,${corgiBadge.png_base64}`;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- colors
const HEX = { ...Object.fromEntries(Object.entries(palette.colors).map(([token, rgb]) => [token, "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("")])), pane: "#121418" };
const rgb = (h) => [1, 3, 5].map((i) => parseInt((HEX[h] ?? h).slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + rgb(a).map((x, i) => Math.round(x + (rgb(b)[i] - x) * t).toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- styles
const STYLES = DATA.styles;
const styleIndex = new Map(STYLES.map((s, i) => [JSON.stringify(s), i]));
function style(fg, bg = null, bold = false, ul = 0, ulc = null) {
  const s = [fg, bg, bold, ul, ulc], key = JSON.stringify(s);
  if (!styleIndex.has(key)) { styleIndex.set(key, STYLES.length); STYLES.push(s); }
  return styleIndex.get(key);
}
const PLAIN = style(null);
const looks = [];
function look(id) {
  if (looks[id]) return looks[id];
  const [fg, bg, bold, ul, ulc] = STYLES[id];
  const token = (c) => c && !c.startsWith("#");
  const cls = [token(fg) && "f-" + fg, token(bg) && "k-" + bg, bold && "b", ul && "u", ul === 4 && "ud"].filter(Boolean).join(" ");
  return (looks[id] = { cls, color: fg && !token(fg) ? fg : "", bg: bg && !token(bg) ? bg : "", ulc: ulc ? (token(ulc) ? `var(--${ulc})` : ulc) : "" });
}

// Box and block glyphs are drawn edge to edge, as terminals draw them.
const G = "linear-gradient(currentColor, currentColor)";
const ARM = { l: ["calc(50% + .5px) 1px", "left center"], r: ["calc(50% + .5px) 1px", "right center"], u: ["1px calc(50% + .5px)", "center top"], d: ["1px calc(50% + .5px)", "center bottom"] };
const BOX = { "─": "lr", "│": "ud", "┌": "rd", "┐": "ld", "└": "ur", "┘": "ul", "├": "udr", "┤": "udl", "┬": "lrd", "┴": "lru", "┼": "udlr" };
const BRAILLE_DOTS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
function shape(ch) {
  if (ch === "▌") return { img: G, size: "50% 100%", pos: "left" };
  const cp = ch.codePointAt(0);
  // Lower eighths, ▁ through █, fill from the cell's bottom edge.
  if (cp >= 0x2581 && cp <= 0x2588) return { img: G, size: `100% ${(cp - 0x2580) * 12.5}%`, pos: "bottom" };
  if (cp >= 0x2800 && cp <= 0x28ff) {
    const dots = BRAILLE_DOTS.filter((_, bit) => (cp - 0x2800) & (1 << bit));
    return { img: dots.map(() => G).join(","), size: dots.map(() => ".15em .15em").join(","), pos: dots.map(([x, y]) => `${0.075 + x * 0.3}em ${0.125 + y * 0.34}em`).join(",") };
  }
  const arms = BOX[ch];
  if (!arms) return null;
  const list = arms.split("");
  return { img: list.map(() => G).join(","), size: list.map((a) => ARM[a][0]).join(","), pos: list.map((a) => ARM[a][1]).join(",") };
}

// ---------------------------------------------------------------- grids
const cellsOf = (frame) => frame.map((row) => { const out = []; for (const [text, s] of row) for (const ch of text) out.push([ch, s]); return out; });
// A list of frames nests one level deeper than a frame.
const F = Object.fromEntries(Object.entries(DATA.frames).map(([k, v]) => [k, Array.isArray(v[0][0][0]) ? v.map(cellsOf) : cellsOf(v)]));
const copy = (g) => g.map((r) => r.slice());
// Where corgi's sidebar puts its focus bar (content starts a column later)
// and its badge, read from a recorded sidebar.
const BAR = F.w34_C00.map((row) => row.findIndex(([ch]) => ch === "▌")).find((c) => c >= 0);
const BADGE_X = F.w34_C00[0].findIndex(([ch]) => ch === "w") - 4;
const crop = (g, r0, c0, rows, cols) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => g[r0 + r]?.[c0 + c] ?? [" ", PLAIN]));
// The sidebar without the header's [ + ] and < buttons or the workspaces'
// tool-call counts.
function tidySidebar(g) {
  g.forEach((row, r) => {
    const text = row.map(([ch]) => ch).join("");
    const at = r === 0 ? text.indexOf("[ + ]") : -1;
    if (at >= 0) for (let c = at; c < row.length && row[c][0] !== "│"; c++) row[c] = [" ", row[at - 1][1]];
    // With the buttons gone, a narrow sidebar's header has room for its name.
    const cut = r === 0 ? text.indexOf("workspac…") : -1;
    if (cut >= 0) Array.from("workspaces").forEach((ch, k) => (row[cut + k] = [ch, row[cut][1]]));
    for (const m of text.matchAll(/⚒\d+/g)) for (let c = m.index; c < m.index + m[0].length; c++) row[c] = [" ", row[m.index - 1][1]];
  });
  return g;
}
const blank = (rows, cols) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => [" ", PLAIN]));
// The style `s` would give, keeping the cell's underline (agent separators).
const keepRule = (s, cell) => { const [fg, bg, bold] = STYLES[s], [, , , ul, ulc] = STYLES[cell[1]]; return ul ? style(fg, bg, bold, ul, ulc) : s; };
function put(g, r, c, text, s) {
  for (const ch of text) { if (g[r] && c >= 0 && c < g[r].length) g[r][c] = [ch, s ?? g[r][c][1]]; c++; }
  return c;
}

// Live bits of a frame: spinners (piling dots while compacting), an awake
// corgi, sleepers. Any Z already in the frame is wiped so the page decides
// who dreams.
function liveBits(g) {
  const bits = { spin: [], awake: [], sleep: [] };
  g.forEach((row, r) => row.forEach(([ch], c) => {
    if (c <= 2 && /[⠁-⣿]/.test(ch)) bits.spin.push([r, c, corgiFrames.pile.includes(ch)]);
    if ((ch === "ᐯ" || ch === "ᐱ") && row[c + 1]?.[0] === "•" && /[~^-]/.test(row[c - 1]?.[0] ?? "")) bits.awake.push([r, c - 1]);
    if (ch === "ᐯ" && row[c + 1]?.[0] === "◡" && row[c + 2]?.[0] === "ᴥ") {
      bits.sleep.push([r, c - 1]);
      for (let k = c + 5; k < c + 16 && k < row.length; k++) if (row[k][0] === "z" || row[k][0] === "ᶻ") row[k] = [" ", row[k][1]];
    }
  }));
  return bits;
}
const BITS = new Map();
const bitsOf = (g) => { if (!BITS.has(g)) BITS.set(g, liveBits(g)); return BITS.get(g); };

function animate(g, now, dreamKey = 0) {
  const bits = bitsOf(g);
  const out = copy(g);
  for (const [r, c, compacting] of bits.spin) put(out, r, c, corgiAnimation.spinner(compacting, still ? 320 : now));
  const wag = WAG[still ? 0 : Math.floor(now / 200) % WAG.length];
  for (const [r, c] of bits.awake) put(out, r, c, wag);
  // One sleeper dreams per period, as corgi picks it; screens dream out of step.
  const dream = still ? null : corgiAnimation.dreamer(bits.sleep.map((_, i) => BigInt(i)), now + dreamKey * 2300);
  if (dream) {
    const [r, c] = bits.sleep[Number(dream.key)];
    const ground = STYLES[out[r][c][1]][1] ?? "pane", grey = ground === "selected" ? "muted" : "faint";
    for (let k = 7; k < 13; k++) {
      const a = corgiAnimation.puffAmount(dream.puff_ms, k), cell = out[r][c + k];
      // Only on the sleeper's own ground: never over a popover drawn beside it.
      if (a == null || !cell || cell[0] !== " " || (STYLES[cell[1]][1] ?? "pane") !== ground) continue;
      put(out, r, c + k, (k - 7) % 2 === 0 ? "ᶻ" : "z", keepRule(style(mix(ground, grey, a), ground === "pane" ? null : ground), cell));
    }
  }
  return out;
}

// ---------------------------------------------------------------- screens
class Screen {
  constructor(el, cols, rows, { side = Infinity, badge = false } = {}) {
    this.spans = []; this.keys = []; this.rowEls = [];
    for (let r = 0; r < rows; r++) {
      const row = el.appendChild(document.createElement("div"));
      row.className = "r";
      const spans = [];
      for (let c = 0; c < cols; c++) {
        const s = row.appendChild(document.createElement("span"));
        if (c >= side) s.dataset.p = "1";
        spans.push(s);
      }
      this.spans.push(spans); this.keys.push([]); this.rowEls.push(row);
    }
    if (badge) {
      const img = el.appendChild(document.createElement("img"));
      img.className = "badge"; img.src = BADGE; img.alt = ""; img.style.left = `${BADGE_X}ch`;
    }
  }
  /// Show only the first `n` rows.
  rows(n) {
    if (this.shown === n) return;
    this.shown = n;
    this.rowEls.forEach((row, i) => (row.hidden = i >= n));
  }
  paint(g) {
    this.spans.forEach((row, r) => row.forEach((span, c) => {
      const [ch, s] = g[r]?.[c] ?? [" ", PLAIN];
      const key = ch + "\u0000" + s;
      if (this.keys[r][c] === key) return;
      this.keys[r][c] = key;
      const L = look(s), box = shape(ch);
      span.className = L.cls + (span.dataset.p ? " p" : "");
      span.textContent = box ? " " : ch;
      span.style.color = L.color;
      span.style.backgroundColor = L.bg;
      span.style.setProperty("--ulc", L.ulc);
      span.style.backgroundImage = box ? box.img : "";
      span.style.backgroundSize = box ? box.size : "";
      span.style.backgroundPosition = box ? box.pos : "";
    }));
  }
}
const visible = new Set();
const watch = new IntersectionObserver((entries) => entries.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target))));
const T = { text: style("text"), strong: style("strong", null, true), muted: style("muted"), faint: style("faint"), cursor: style(null, "text") };

// ---------------------------------------------------------------- feature screens
// New tab: the real picker. The pointer and the arrows select, a click or
// Enter opens, / searches, esc goes back. The list follows
// launcher_resume.zig: a search keeps conversations whose title, first or
// last message holds every word typed.
const HOUR = 3600, DAY = 86400;
const HISTORY = [
  ["claude", "Fix sidebar flicker", "the sidebar flickers when an agent finishes", "`drawAgent` cleared each row, then wrote it again. It now writes once.", "commit it", "Committed `4f2c1d9` sidebar: draw each row in one write", 12 * 60, 0, ["Read", "src/sidebar.zig", "Read 2104 lines"]],
  ["claude", "Name dev server links", "links just say Open Link", "Links now take the server's own name.", "use the page title when there is one", "Done. The title wins when the page has one.", 50 * 60, 0, ["Search", "\"Open Link\"", "Found 3 files"]],
  ["claude", "Slow down the herd animation", "the compacting herd feels rushed", "Each herd step now takes `110 ms`.", "slower, the letters blur", "Slowed `herd_step_ms` to `140`.", 2 * HOUR, 0, ["Read", "src/corgi_animation.zig", "Read 1038 lines"]],
  ["codex", "Static Linux build", "build a static linux binary", "Built with the musl target.", "strip it before upload", "Stripped: 18 MB down to 7 MB.", 5 * HOUR, 0, ["Ran", "zig build -Dtarget=x86_64-linux-musl", "Build Summary: 5/5 steps succeeded"]],
  ["claude", "Ghostty keybindings", "bind cmd+1-9 to tabs", "`Cmd+1–9` now switch tabs.", "does Cmd+W close the whole tab?", "Yes: `Cmd+W` closes the tab with every pane in it.", 2 * HOUR, 1, ["Read", "src/ghostty_integration.zig", "Read 412 lines"]],
  ["claude", "Faster session restore", "restore takes two seconds", "Restore now reads the checkpoint once.", "measure it again after the cache", "Down to 180 ms.", 4 * HOUR, 1, ["Bash", "hyperfine 'corgi checkpoint restore'", "Time (mean ± σ):  1.94 s ±  0.05 s"]],
  ["claude", "Usage bars in the picker", "show usage next to each agent", "Each agent row now has its limits.", "show when it resets", "Added the reset time after each bar.", 6 * HOUR, 1, ["Read", "src/launcher_usage.zig", "Read 233 lines"]],
  ["claude", "Date resume rows by reply", "resume dates look wrong", "Rows were dated by file time.", "date by the last reply instead", "Done. Rows now date by the last reply.", 9 * HOUR, 1, ["Search", "updated_at", "Found 6 files"]],
  ["codex", "Onboarding copy", "rewrite the onboarding text", "Rewrote each step in one line.", "fewer words", "Halved it.", 12 * HOUR, 1, ["Ran", "wc -w docs/onboarding.md", "1840 docs/onboarding.md"]],
].map(([provider, title, first, did, last, reply, ago, yesterday, tool]) => ({ provider, title, first, did, last, reply, ago, yesterday, tool }));
const NOW = Math.floor(Date.now() / 1000);
// Today's and yesterday's rows land on those days whatever the hour.
{
  const midnight = new Date(NOW * 1000).setHours(0, 0, 0, 0) / 1000;
  const today = NOW - midnight, scale = Math.min(1, (today * 0.9) / (5 * HOUR));
  for (const e of HISTORY) e.ago = e.yesterday ? today + e.ago : Math.max(60, Math.round(e.ago * scale));
}
// Where the popover sits in corgi's frame, read from its corners.
const POP_AT = (() => {
  const top = F.launcher0.findIndex((row) => row.some(([ch]) => ch === "╭"));
  const left = F.launcher0[top].findIndex(([ch]) => ch === "╭"), right = F.launcher0[top].findIndex(([ch]) => ch === "╮");
  return { top, left, width: right - left + 1 };
})();
const POP = { x: 0, width: POP_AT.width };
const FIELD = POP.width - 10;
// Search fits the picker's own height, as corgi's does in a shorter window.
const LIST = { top: 9, height: 7 };
const R = {
  panel: style("faint", "surface"), heading: style("faint", "surface", true), rule: style("line", "surface"),
  row: style("text", "surface"), selected: style("strong", "selected"), key: style("strong", "line", true),
  query: style("strong", "surface"), caret: style("surface", "strong"), pane: style(null, "pane"),
};
const ink = (fg, selected) => style(fg, selected ? "selected" : "surface");
const ellipsis = (text, room) => { const g = Array.from(text); return g.length <= room ? text : room <= 0 ? "" : g.slice(0, room - 1).join("") + "…"; };
function ageLabel(s) {
  for (const [below, size, name] of [[HOUR, 60, "m"], [DAY, HOUR, "h"], [14 * DAY, DAY, "d"], [60 * DAY, 7 * DAY, "w"], [Infinity, 30 * DAY, "mo"]])
    if (s < below) return Math.max(1, Math.floor(s / size)) + name;
}
const dayStart = (s) => { const d = new Date(s * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
function dayLabel(s) {
  const days = Math.floor((dayStart(NOW) - dayStart(s) + 43200) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(s * 1000).toLocaleDateString("en-US", days < 7 ? { weekday: "long" } : { month: "long", day: "numeric" });
}
function columns(expanded) {
  const room = POP.width - 4 - 16, folder = expanded && room >= 60 ? 15 : 0, rest = room - folder;
  const title = rest >= 70 ? Math.max(30, Math.floor(rest * 2 / 5)) : Math.min(rest, Math.max(24, Math.floor(rest * 3 / 5)));
  return { title, folder, last: Math.max(0, room - folder - title - 2) };
}
function rowsFor(mode, query) {
  if (mode !== "search") return [...HISTORY.slice(0, 5).map((_, i) => ({ kind: "entry", i })), { kind: "more", n: HISTORY.length }];
  if (query.length > 0) {
    const words = query.split(" ").filter(Boolean).map((w) => w.toLowerCase());
    const hits = HISTORY.flatMap((e, i) => (words.every((w) => [e.title, e.first, e.last].some((t) => t.toLowerCase().includes(w))) ? [{ kind: "entry", i }] : []));
    return [{ kind: "heading", n: hits.length }, ...hits];
  }
  const rows = [];
  let day = null;
  HISTORY.forEach((e, i) => {
    const start = dayStart(NOW - e.ago);
    if (start !== day) { rows.push({ kind: "day", at: NOW - e.ago }); day = start; }
    rows.push({ kind: "entry", i });
  });
  return rows;
}
const selectable = (line) => line.kind === "entry" || line.kind === "more";
const named = (rows, k, first) => {
  if (rows[k].kind !== "entry") return false;
  if (k === first || rows[k - 1].kind !== "entry") return true;
  return HISTORY[rows[k - 1].i].provider !== HISTORY[rows[k].i].provider;
};
function drawLine(g, line, selected, isNamed, row, cols) {
  const x = POP.x, width = POP.width, base = selected ? R.selected : R.row;
  if (line.kind === "day") {
    const text = dayLabel(line.at);
    const c = put(g, row, x + 3, text + " ", R.panel);
    put(g, row, c, "─".repeat(Math.max(0, width - (6 + text.length))), R.rule);
    return;
  }
  if (line.kind === "heading") { put(g, row, x + 3, `${line.n} in this workspace`, R.heading); return; }
  put(g, row, x + 1, " ".repeat(width - 3), base);
  put(g, row, x + 1, selected ? "›" : " ", base);
  if (line.kind === "more") {
    put(g, row, x + 3, " / ", R.key);
    put(g, row, x + 6, ` Search ${line.n} agents`, ink(selected ? "muted" : "faint", selected));
    return;
  }
  const e = HISTORY[line.i];
  if (isNamed) put(g, row, x + 3, e.provider === "claude" ? "Claude" : "Codex", base);
  else put(g, row, x + 3, "│", ink(selected ? "muted" : "faint", selected));
  let col = x + 12;
  put(g, row, col, ellipsis(e.title, cols.title), base);
  col += cols.title + 2;
  if (cols.folder > 0) { put(g, row, col, ellipsis("corgi", cols.folder - 1), ink("muted", selected)); col += cols.folder; }
  if (cols.last > 12) put(g, row, col, ellipsis(e.last, cols.last), ink(selected ? "text" : "faint", selected));
  const age = ageLabel(e.ago);
  put(g, row, x + width - 3 - age.length, age, ink(selected ? "text" : "faint", selected));
}

// Frames: the picker with each agent row selected, with the keyboard in the
// list, expanded for search, and the tab a choice opens.
// The page has no agents to manage: the title border runs on in its place.
function noManage(g) {
  const top = g[0], text = top.map(([ch]) => ch).join(""), at = text.indexOf("Manage agents");
  if (at < 0) return g;
  let start = at;
  while (start > 0 && top[start - 1][0] !== "─") start--;
  for (let c = start; c <= at + "Manage agents".length; c++) top[c] = ["─", top[1][1]];
  return g;
}
// Rows: Codex, Claude Code, Codex on a second account, New terminal.
// Every mode is the same height, so the page never moves.
const PICK_AGENTS = 4, PICK_HEIGHT = 18, FIELD_ROW = 7;
const PICK = Array.from({ length: PICK_AGENTS }, (_, i) => noManage(crop(F["launcher" + i], POP_AT.top, POP_AT.left, PICK_HEIGHT, POP.width)));
const PICK_LIST = noManage(crop(F.search3, POP_AT.top, POP_AT.left, PICK_HEIGHT, POP.width));
// No scope switching here: the search line and the footer lose "tab".
function noScope(g) {
  for (let c = 7; c < POP.width - 2; c++) g[FIELD_ROW][c] = [" ", g[FIELD_ROW][1][1]];
  const foot = g[PICK_HEIGHT - 2], text = foot.map(([ch]) => ch).join("");
  const hints = text.indexOf(" ↵ "), tab = text.indexOf(" tab ", hints), esc = text.indexOf(" esc ", hints);
  if (hints >= 0 && tab > hints && esc > tab) g[PICK_HEIGHT - 2] = [...foot.slice(0, hints), ...Array.from({ length: esc - tab }, () => [" ", foot[1][1]]), ...foot.slice(hints, tab), ...foot.slice(esc)];
  return g;
}
// corgi's search frame lists ten rows; keep the first seven, then its footer.
const shortList = (g) => [...g.slice(0, LIST.top + LIST.height), ...g.slice(-2)];
const PICK_SEARCH = [F.search0, F.search1].map((f) => noScope(noManage(shortList(crop(f, 0, POP_AT.left, f.length, POP.width)))));
const AGENT_ROWS = 2, ENTRY_ROWS = 8, MORE_ROW = 14;

const L = { mode: "agents", agent: 1, key: 0, query: "", scroll: 0, opened: null, back: "agents", phone: false };
const launcherEl = document.getElementById("v-launcher");
const launcherStage = document.getElementById("launcher-stage");
const queryInput = document.getElementById("launcher-query");
const launcher = new Screen(launcherEl, POP.width, PICK_HEIGHT);
function at(rows) {
  const kept = L.mode === "search" ? rows.findIndex((r) => r.kind === "entry" && r.i === L.key) : L.key;
  return kept >= 0 && rows[kept] && selectable(rows[kept]) ? kept : rows.findIndex(selectable);
}
// Collapsed rows are redrawn too, so ages match the visitor's clock.
function drawCollapsedList(g) {
  const rows = rowsFor("list", ""), sel = L.mode === "list" ? at(rows) : -1, cols = columns(false);
  rows.forEach((line, k) => drawLine(g, line, k === sel, named(rows, k, 0), ENTRY_ROWS + k + (line.kind === "more" ? 1 : 0), cols));
}
function drawSearch(g) {
  const rows = rowsFor("search", L.query), sel = at(rows), cols = columns(true);
  put(g, FIELD_ROW, 7, " ".repeat(FIELD), R.panel);
  put(g, FIELD_ROW, put(g, FIELD_ROW, 7, ellipsis(L.query, FIELD - 1), R.query), " ", R.caret);
  for (let r = LIST.top; r < LIST.top + LIST.height; r++) put(g, r, POP.x + 1, " ".repeat(POP.width - 2), R.panel);
  let first = Math.min(L.scroll, Math.max(0, rows.length - LIST.height));
  if (sel >= 0) {
    const top = sel > 0 && rows[sel - 1].kind === "day" ? sel - 1 : sel;
    if (top < first) first = top;
    if (sel >= first + LIST.height) first = sel + 1 - LIST.height;
  }
  L.scroll = first;
  rows.slice(first, first + LIST.height).forEach((line, k) => drawLine(g, line, first + k === sel, named(rows, first + k, first), LIST.top + k, cols));
  if (rows.length <= 1) put(g, LIST.top + rows.length, POP.x + 12, "No matches.", R.panel);
  if (rows.length > LIST.height) {
    const thumb = Math.max(1, Math.floor(LIST.height * LIST.height / rows.length));
    const top = Math.floor((LIST.height - thumb) * first / (rows.length - LIST.height));
    for (let k = 0; k < LIST.height; k++) {
      const on = k >= top && k < top + thumb;
      put(g, LIST.top + k, POP.x + POP.width - 2, on ? "┃" : "│", on ? R.panel : R.rule);
    }
  }
}
// The opened tab: a resumed conversation comes back under the Restoring band
// over its faded screen, then fills in; a new agent or shell just starts.
// Agent screens follow Claude Code's and Codex's own layouts, anchored to the
// pane's bottom like a terminal, so the band covers the input.
const A = {
  user: style("muted"), userBand: style("text", "surface"), text: style("text"), strong: style("strong"),
  done: style("accent"), tool: style("strong", null, true), out: style("faint"), border: style("line"),
  hint: style("faint"), key: style("strong", null, true), bullet: style("faint"), cursor: style(null, "text"),
  input: style("muted", "selected"), prompt: style("text", "selected"), caret: style("selected", "text"),
  model: style("warm"), path: style("#9fd39a"), title: style("hot"),
  code: style("#a9b1f5"), mode: style("hot"), prompt2: style("strong", null, true),
};
// Claude Code shows `code` in lavender; Codex here keeps it plain.
const inline = (text, base) => text.split("`").map((part, n) => [part, n % 2 ? A.code : base]).filter(([part]) => part);
const plain = (text) => text.replaceAll("`", "");
const VERBS = ["Sautéed", "Brewed", "Churned", "Baked", "Simmered", "Whisked", "Kneaded", "Toasted", "Stewed"];
const clock = (ago) => new Date((NOW - ago) * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
// Rows of [text, style] runs; a row may carry a band background.
function agentScreen(provider, entry, width) {
  const rows = [], gap = () => rows.push([]);
  if (provider === "claude") {
    if (entry) {
      const [verb, arg, out] = entry.tool;
      rows.push([["> " + entry.first, A.user]]); gap();
      rows.push([["⏺ ", A.done], [verb, A.tool], [`(${arg})`, A.text]]);
      rows.push([["  ⎿  " + out, A.out]]); gap();
      rows.push([["⏺ ", A.text], ...inline(entry.did, A.text)]); gap();
      rows.push([["> " + entry.last, A.user]]); gap();
      rows.push([["⏺ ", A.text], ...inline(entry.reply, A.text)]); gap();
      const n = entry.title.length;
      rows.push([[`✻ ${VERBS[n % VERBS.length]} for ${20 + ((n * 7) % 40)}s · done ${clock(entry.ago)}`, A.hint]]);
      const saved = `${40 + n * 3}k tokens`, note = `new task? /clear to save ${saved}`;
      rows.push([[" ".repeat(Math.max(0, width - note.length)) + "new task? ", A.hint], ["/clear", A.code], [" to save ", A.hint], [saved, A.code]]);
    }
    rows.push([["─".repeat(width), A.border]]);
    rows.push([["❯ ", A.prompt2]]);
    rows.push([["─".repeat(width), A.border]]);
    rows.push([["⏵⏵ bypass permissions on", A.mode]]);
  } else {
    if (entry) {
      const [verb, arg, out] = entry.tool;
      rows.push({ band: A.userBand, runs: [["› " + entry.first, A.userBand]] }); gap();
      rows.push([["• ", A.bullet], [verb + " ", A.tool], [arg, A.text]]);
      rows.push([["  └ " + out, A.out]]); gap();
      rows.push([["• ", A.bullet], [plain(entry.did), A.text]]); gap();
      rows.push({ band: A.userBand, runs: [["› " + entry.last, A.userBand]] }); gap();
      rows.push([["• ", A.bullet], [plain(entry.reply), A.text]]); gap();
      rows.push([[`  Worked for ${1 + (entry.title.length % 4)}m ${10 + ((entry.title.length * 7) % 50)}s • ${clock(entry.ago)}`, A.hint]]); gap();
    }
    rows.push({ band: A.input, runs: [] });
    rows.push({ band: A.input, runs: [["› ", A.prompt], ["Ask Codex to do anything", A.input]] });
    rows.push({ band: A.input, runs: [] });
    rows.push([["  GPT-6 Astra high", A.model], [" · ", A.hint], ["~/dev/corgi", A.path], ...(entry ? [[" · ", A.hint], [entry.title, A.title]] : [])]);
  }
  return rows;
}
// A style on the pane, moved `k` of the way toward it: the faded old screen.
function faded(id, k) {
  const [fg, bg, bold] = STYLES[id];
  if (k <= 0) return style(fg, bg ?? "pane", bold);
  return style(mix(fg ?? "text", "pane", k), mix(bg ?? "pane", "pane", k), bold);
}
const PANE_BOTTOM = PICK_HEIGHT;
function drawAgent(g, rows, k, width = POP.width, bottom = PANE_BOTTOM) {
  const top = bottom - rows.length;
  rows.forEach((row, n) => {
    const r = top + n;
    if (r < 0) return;
    const runs = row.runs ?? row;
    if (row.band) put(g, r, 0, " ".repeat(width), faded(row.band, k));
    let c = 1;
    for (const [text, s] of runs) c = put(g, r, c, ellipsis(text, width - 1 - c), faded(s, k));
  });
  return top;
}
// The caret: inside Claude Code's box, or over the first letter of Codex's hint.
function caret(g, provider, rows, top) {
  if (provider === "claude") return put(g, top + rows.length - 3, 3, " ", A.cursor);
  put(g, top + rows.length - 3, 3, "A", A.caret);
}
function drawOpened(g, t, width = POP.width, bottom = PANE_BOTTOM) {
  const o = L.opened, since = t - o.at;
  for (let r = 0; r < bottom; r++) put(g, r, 0, " ".repeat(width), R.pane);
  if (o.kind === "terminal") return put(g, 1, put(g, 1, 1, "~/d/corgi> ", T.faint), " ", T.cursor);
  if (o.kind === "agent") {
    const rows = agentScreen(o.provider, null, width - 2);
    return caret(g, o.provider, rows, drawAgent(g, rows, 0, width, bottom));
  }
  const e = HISTORY[o.i], rows = agentScreen(e.provider, e, width - 2);
  const settle = 2300, k = 0.6 * (1 - Math.min(1, Math.max(0, (since - settle) / 400)));
  const top = drawAgent(g, rows, k, width, bottom);
  if (since < settle) {
    // corgi's restoring card for this conversation, centered on the pane as
    // corgi centers it, over the faded ghost. Its dig row plays from the
    // flipbook for its width.
    const pre = width === POP.width ? "" : "p", card = F[`${pre}rest${o.i}`];
    const left = card[0].findIndex(([ch]) => ch === "╭"), right = card[0].findIndex(([ch]) => ch === "╮");
    const dig = F[`${pre}dig${right - left + 1}`], end = dig[dig.length - 1][0];
    const row = card.findIndex((cells) => cells.every(([ch], c) => ch === end[c][0]));
    const top = Math.floor((bottom - card.length) / 2);
    card.forEach((cells, r) => {
      const from = r === row ? dig[Math.min(Math.floor(since / 80), dig.length - 1)][0] : cells;
      for (let c = left; c <= right; c++) g[top + r][c] = from[c];
    });
  } else if (k === 0) caret(g, e.provider, rows, top);
}
function drawLauncher(t) {
  let g;
  if (L.mode === "opened" && performance.now() - L.opened.at > (L.opened.kind === "entry" ? 4300 : 2200)) backToList(false);
  if (L.phone) g = phonePicker();
  else if (L.mode === "opened") {
    g = blank(PICK_HEIGHT, POP.width);
    drawOpened(g, performance.now());
  } else if (L.mode === "search") {
    g = copy(PICK_SEARCH[L.query ? 1 : 0]);
    drawSearch(g);
  } else {
    g = copy(L.mode === "agents" ? PICK[L.agent] : PICK_LIST);
    drawCollapsedList(g);
  }
  // Ctrl-T brightens the selected row once, softly.
  const since = performance.now() - flashAt;
  if (L.mode !== "opened" && since < 250) {
    // A quick rise, then a fast fade.
    const glow = mix("selected", "line", 0.4 * (since < 40 ? since / 40 : 1 - (since - 40) / 210));
    g.forEach((row) => row.forEach((cell, c) => {
      const [fg, bg, bold] = STYLES[cell[1]];
      if (bg === "selected") row[c] = [cell[0], style(fg, glow, bold)];
    }));
  }
  launcherStage.classList.toggle("opened", L.mode === "opened");
  (L.phone ? launcherPhone : launcher).paint(g);
}

function startSearch() {
  Object.assign(L, { mode: "search", key: null, query: "", scroll: 0 });
  queryInput.value = "";
  queryInput.hidden = false;
  queryInput.focus({ preventScroll: true });
}
function backToList(focus = true) {
  Object.assign(L, { mode: L.back, query: "", scroll: 0, opened: null });
  queryInput.hidden = true;
  if (focus) launcherStage.focus({ preventScroll: true });
}
function openItem(kind, value) {
  L.back = L.mode === "search" ? "list" : L.mode;
  if (L.mode === "search") L.key = 0;
  queryInput.hidden = true;
  L.opened = { kind, at: performance.now(), ...(kind === "entry" ? { i: value } : kind === "agent" ? { provider: value } : {}) };
  L.mode = "opened";
  launcherStage.focus({ preventScroll: true });
}
function openSelected() {
  if (L.mode === "agents") return L.agent === PICK_AGENTS - 1 ? openItem("terminal") : openItem("agent", L.agent === 1 ? "claude" : "codex");
  const rows = rowsFor(L.mode, L.query), line = rows[at(rows)];
  if (!line) return;
  if (line.kind === "more") return startSearch();
  openItem("entry", line.i);
}
function move(delta) {
  if (L.mode === "agents") {
    if (L.agent + delta > PICK_AGENTS - 1) Object.assign(L, { mode: "list", key: 0 });
    else L.agent = Math.max(0, L.agent + delta);
    return;
  }
  const rows = rowsFor(L.mode, L.query), from = at(rows);
  let i = from;
  for (let j = i + delta; j >= 0 && j < rows.length; j += delta) if (selectable(rows[j])) { i = j; break; }
  if (L.mode === "list" && delta < 0 && i === from) return Object.assign(L, { mode: "agents", agent: PICK_AGENTS - 1 });
  L.key = L.mode === "search" ? rows[i]?.i ?? null : i;
}
const redraw = () => drawLauncher(performance.now());
launcherStage.addEventListener("keyup", redraw);
launcherStage.addEventListener("keydown", (e) => {
  queueMicrotask(redraw);
  if (L.mode === "opened") {
    if (e.key === "Escape" || e.key === "Enter") { backToList(); e.preventDefault(); }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { move(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
  else if (e.key === "Enter") { openSelected(); e.preventDefault(); }
  else if (e.key === "Escape" && L.mode === "search") {
    if (L.query) { L.query = queryInput.value = ""; L.key = null; L.scroll = 0; } else backToList();
    e.preventDefault();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.target === queryInput || e.metaKey || e.ctrlKey || L.mode === "search" || L.mode === "opened" || !visible.has(launcherStage)) return;
  e.preventDefault();
  startSearch();
  redraw();
});
queryInput.addEventListener("input", () => { L.query = queryInput.value; L.key = null; L.scroll = 0; redraw(); });
// Ctrl-T is the picker's own key: bring it up and flash what it would open.
let flashAt = -Infinity;
const ctrlKey = document.querySelector(".band kbd");
// Keeps watch's New button brings it up too, scrolling it into view first.
function summonPicker() {
  if (L.mode === "opened" || L.mode === "search") backToList(false);
  const box = launcherStage.getBoundingClientRect(), shown = box.top >= 0 && box.bottom <= innerHeight;
  launcherStage.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  launcherStage.focus({ preventScroll: true });
  // The flash waits for a smooth scroll to land.
  setTimeout(() => {
    flashAt = performance.now();
    ctrlKey.classList.remove("flash");
    void ctrlKey.offsetWidth;
    ctrlKey.classList.add("flash");
    // Every animation frame while it lasts, not the 50 ms tick.
    const pulse = () => { redraw(); if (performance.now() - flashAt < 260) requestAnimationFrame(pulse); };
    pulse();
  }, shown || still ? 0 : 450);
}
document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "t") return;
  e.preventDefault();
  summonPicker();
});
// What a cell of the picker holds: an agent row, a conversation, or "more".
function target(e) {
  const box = launcherEl.getBoundingClientRect();
  const col = Math.floor((e.clientX - box.left) / (box.width / POP.width));
  const row = Math.floor((e.clientY - box.top) / (box.height / PICK_HEIGHT));
  if (col <= POP.x || col >= POP.x + POP.width - 1) return null;
  if (L.mode === "search") {
    const line = rowsFor("search", L.query)[L.scroll + row - LIST.top];
    return row >= LIST.top && row < LIST.top + LIST.height && line?.kind === "entry" ? { entry: line.i } : row === FIELD_ROW ? { field: true } : null;
  }
  if (row >= AGENT_ROWS && row < AGENT_ROWS + PICK_AGENTS) return { agent: row - AGENT_ROWS };
  if (row >= ENTRY_ROWS && row < ENTRY_ROWS + 5) return { row: row - ENTRY_ROWS };
  if (row === MORE_ROW) return { row: 5 };
  return null;
}
function hoverHit(hit) {
  if (!hit) return;
  if (hit.agent != null) Object.assign(L, { mode: "agents", agent: hit.agent });
  else if (hit.row != null) Object.assign(L, { mode: "list", key: hit.row });
  else if (hit.entry != null) L.key = hit.entry;
}
launcherEl.addEventListener("mousemove", (e) => { if (L.mode !== "opened") { hoverHit(target(e)); redraw(); } });
launcherEl.addEventListener("click", (e) => {
  queueMicrotask(redraw);
  if (L.mode === "opened") return backToList();
  const hit = target(e);
  if (!hit) return L.mode === "search" && queryInput.focus({ preventScroll: true });
  if (hit.field) return queryInput.focus({ preventScroll: true });
  hoverHit(hit);
  openSelected();
});

// The picker on a phone: 48 columns, one line an entry. Agents group under
// their account and conversations under their day, each group headed by a
// label and a rule, so the two halves share one shape: entries start in the
// same column and end in a figure, usage or age. The same state and actions
// as the desktop picker; taps instead of hover.
const PW = 48, PROWS = 19;
const launcherPhoneEl = document.getElementById("v-launcher-phone");
const launcherPhone = new Screen(launcherPhoneEl, PW, PROWS);
// Styles sampled from corgi's own picker: the k-th cell of the nth `needle`.
function sampled(g, r, needle, k = 0, nth = 0) {
  const text = g[r].map(([ch]) => ch).join("");
  let at = -1;
  for (let n = 0; n <= nth; n++) at = text.indexOf(needle, at + 1);
  return g[r][at + k][1];
}
const PS = (() => {
  const desk = PICK[1], wide = crop(F.search0, 0, POP_AT.left, F.search0.length, POP.width), at = sampled;
  return {
    border: at(desk, 0, "╭"), title: at(desk, 0, "New agent"), key: at(desk, 2, "0"), mark: at(desk, 3, "›"),
    text: at(desk, 2, "Codex"), text_sel: at(desk, 3, "Claude"), label: at(desk, 2, "7d"), label_sel: at(desk, 3, "5h"),
    pct: at(desk, 2, "18%"), pct_sel: at(desk, 3, "23%"), muted: at(wide, 11, "corgi"), muted_sel: at(wide, 10, "corgi"),
    foot: at(desk, 16, "new tab"), scope_in: at(desk, 0, " in "), scope: at(desk, 0, "corgi"),
  };
})();
// [account, name, model, five-hour and weekly use (%), or null where unknown]
const PHONE_AGENTS = [
  ["you@example.com", "Codex", "GPT-6 Astra", [null, 18]],
  ["you@example.com", "Claude Code", "Opus 5.5", [23, 41]],
  ["you@slopcorp.ai", "Codex", "GPT-6 Astra", null],
];
// Columns: keycap, then name and model; figures end at FIG.
const NAME = 7, MODEL = 20, FIG = 45;
let PMAP = [];
// A row of the box; a selected one is tinted and marked ›.
function phoneRow(g, r, selected = false) {
  g[r] = Array.from({ length: PW }, (_, c) => [c === 0 || c === PW - 1 ? "│" : " ", selected && c > 0 && c < PW - 1 ? PS.text_sel : PS.border]);
  if (selected) put(g, r, 1, "›", PS.mark);
}
// A group's header: its label and a rule, as corgi's search heads a day.
function phoneHeader(g, r, label) {
  phoneRow(g, r);
  const c = put(g, r, 3, label + " ", R.panel);
  put(g, r, c, "─".repeat(Math.max(0, PW - 3 - c)), R.rule);
}
function phoneAgents(g) {
  g[0] = Array.from({ length: PW }, (_, c) => [c === 0 ? "╭" : c === PW - 1 ? "╮" : "─", PS.border]);
  // Its title names the workspace it opens in, as corgi's does.
  put(g, 0, put(g, 0, put(g, 0, 2, " New agent ", PS.title), " in  ", PS.scope_in), "corgi ", PS.scope);
  let r = 1, account = null;
  PHONE_AGENTS.forEach(([acct, name, model, use], i) => {
    if (acct !== account) phoneHeader(g, r++, (account = acct));
    const sel = L.mode === "agents" && L.agent === i, k = sel ? "_sel" : "";
    phoneRow(g, r, sel);
    put(g, r, 3, ` ${i} `, PS.key);
    put(g, r, NAME, name, PS["text" + k]);
    put(g, r, MODEL, model, PS["muted" + k]);
    // An account whose usage corgi can't read shows none.
    if (use) ["5h", "7d"].forEach((label, n) => {
      if (use[n] == null) return;
      const at = FIG - 12 + 7 * n;
      put(g, r, put(g, r, at, label + " ", PS["label" + k]), `${use[n]}%`.padStart(3), PS["pct" + k]);
    });
    PMAP[r++] = { agent: i };
  });
  const sel = L.mode === "agents" && L.agent === 3;
  phoneRow(g, r, sel);
  put(g, r, 3, " t ", PS.key);
  put(g, r, NAME, "New terminal", sel ? PS.text_sel : PS.text);
  PMAP[r++] = { agent: 3 };
  phoneRow(g, r++);
  return r;
}
// One conversation: its title, and how long ago it was active.
function phoneEntry(g, r, i, selected) {
  const e = HISTORY[i], age = ageLabel(e.ago);
  phoneRow(g, r, selected);
  put(g, r, NAME, ellipsis(e.title, FIG - age.length - NAME - 1), selected ? R.selected : R.row);
  put(g, r, FIG - age.length + 1, age, ink(selected ? "text" : "faint", selected));
}
// Conversations under their days, and "more" as search.
function phoneLines(g, r, rows, sel, map, last) {
  rows.forEach((line, k) => {
    if (r > last) return;
    if (line.kind === "day") return phoneHeader(g, r++, dayLabel(line.at));
    if (line.kind === "heading") { phoneRow(g, r); put(g, r++, 3, `${line.n} in this workspace`, R.heading); return; }
    if (line.kind === "more") {
      phoneRow(g, r, k === sel);
      put(g, r, 3, " / ", R.key);
      put(g, r, 6, ` Search ${line.n} agents`, ink(k === sel ? "muted" : "faint", k === sel));
      PMAP[r++] = map(line, k);
      return;
    }
    phoneEntry(g, r, line.i, k === sel);
    PMAP[r++] = map(line, k);
  });
  return r;
}
function phoneFoot(g, r, keys) {
  while (r < PROWS - 2) phoneRow(g, r++);
  phoneRow(g, PROWS - 2);
  put(g, PROWS - 2, 2, "new tab", PS.foot);
  // Key hints end two cells in from the border, as corgi's footer does.
  let c = PW - 2 - keys.reduce((n, [k, label]) => n + k.length + 2 + label.length + 1, 0);
  for (const [k, label] of keys) { c = put(g, PROWS - 2, c, ` ${k} `, PS.key); c = put(g, PROWS - 2, c, ` ${label}`, PS.foot); }
  g[PROWS - 1] = Array.from({ length: PW }, (_, c) => [c === 0 ? "╰" : c === PW - 1 ? "╯" : "─", PS.border]);
}
// The collapsed list: five recent conversations under their days.
function phoneList(g, r) {
  const list = rowsFor("list", ""), sel = L.mode === "list" ? at(list) : -1, rows = [];
  let day = null;
  list.forEach((line, k) => {
    if (line.kind === "entry") {
      const start = dayStart(NOW - HISTORY[line.i].ago);
      if (start !== day) { rows.push({ kind: "day", at: NOW - HISTORY[line.i].ago }); day = start; }
    }
    rows.push({ ...line, k });
  });
  r = phoneLines(g, r, rows, rows.findIndex((line) => line.k === sel), (line) => ({ key: line.k }), PROWS - 3);
  phoneFoot(g, r, [["a", "launch"]]);
}
// Search: the field, then matches under their days, scrolled to the selection.
function phoneSearch(g, r) {
  phoneRow(g, r);
  put(g, r, 3, " / ", R.key);
  put(g, r, put(g, r, NAME, ellipsis(L.query, PW - 10), R.query), " ", R.caret);
  PMAP[r++] = { field: true };
  // A blank row above the footer, as the collapsed list has.
  const rows = rowsFor("search", L.query), sel = at(rows), room = PROWS - 3 - r;
  let first = Math.min(L.scroll, Math.max(0, rows.length - room));
  if (sel >= 0) {
    const lead = sel > 0 && rows[sel - 1].kind === "day" ? sel - 1 : sel;
    if (lead < first) first = lead;
    if (sel >= first + room) first = sel + 1 - room;
  }
  L.scroll = first;
  const end = phoneLines(g, r, rows.slice(first, first + room), sel - first, (line) => ({ entry: line.i }), PROWS - 4);
  if (rows.length <= 1) { phoneRow(g, end); put(g, end, NAME, "No matches.", R.panel); }
  phoneFoot(g, Math.max(end, rows.length <= 1 ? end + 1 : end), [["↵", "resume"]]);
}
function phonePicker() {
  const g = blank(PROWS, PW);
  PMAP = [];
  if (L.mode === "opened") { drawOpened(g, performance.now(), PW, PROWS); return g; }
  const r = phoneAgents(g);
  (L.mode === "search" ? phoneSearch : phoneList)(g, r);
  return g;
}
// Taps open what they land on, as clicks do on desktop.
launcherPhoneEl.addEventListener("click", (e) => {
  queueMicrotask(redraw);
  if (L.mode === "opened") return backToList();
  const box = launcherPhoneEl.getBoundingClientRect(), hit = PMAP[Math.floor((e.clientY - box.top) / (box.height / PROWS))];
  if (!hit) return L.mode === "search" && queryInput.focus({ preventScroll: true });
  if (hit.field) return queryInput.focus({ preventScroll: true });
  if (hit.agent != null) Object.assign(L, { mode: "agents", agent: hit.agent });
  else if (hit.key != null) Object.assign(L, { mode: "list", key: hit.key });
  else if (hit.entry != null) L.key = hit.entry;
  openSelected();
});
// Below 600 pixels the picker takes the phone's layout. Each resize waits a
// frame, so the layout it changes doesn't loop back into the observer.
new ResizeObserver(() => requestAnimationFrame(() => {
  const phone = launcherStage.closest(".band").clientWidth < 600;
  if (phone === L.phone) return;
  L.phone = phone;
  launcherEl.hidden = phone;
  launcherPhoneEl.hidden = !phone;
  redraw();
})).observe(launcherStage.closest(".band"));

// Keeps watch: corgi's sidebar with its workspaces and agents in every state.
// Clicking a workspace switches to it; dragging the sidebar's edge resizes it;
// hovering ↑2 offers Push. The pane shows the focused agent's work, hovering
// an agent opens its card, a click focuses and reads it, and "unread →" jumps
// to the next unread agent. Left alone, a pointer tours the agents; the
// visitor's own pointer takes over until 5 s after it leaves. Phones get corgi
// as a 54-column terminal (its narrowest sidebar, shorter names, packed
// cards) and taps: one opens an agent's card, the next only dismisses it.
const WATCH_COLS = 124, WATCH_ROWS_N = 24, CARD_LEFT = 30, CARD_WIDTH_AT = 34;
const WIDTHS = [26, 30, 34, 38, 42];
// The agent list starts at AGENT_TOP, two rows an agent.
const AGENT_TOP = 13;
const WATCH_ROWS = [13, 15, 17, 19, 21];
const AGENTS = { C: 5, M: 2 };
// "Refactor the viewer" works until a pointer has rested on it a moment,
// then compacts, so the switch happens in view.
const COMPACTOR = 3, COMPACT_AFTER = 600;
const WATCH_UNREAD = [4];
// The tour opens every card but clicks only agents that aren't compacting or unread.
const TOUR_CLICKS = { C: (i) => i !== 3 && !WATCH_UNREAD.includes(i), M: () => true };
const WS_ROWS = { C: [2, 3, 4], M: [5, 6, 7] };
const HOVER_BG = mix("bg", "selected", 0.5);
// Desktop cards are stored from CARD_LEFT on; a phone's are whole.
const boxOf = (g, offset = CARD_LEFT) => {
  const box = { top: 0, bottom: -1, left: 0, right: -1, offset };
  g.forEach((row, r) => row.forEach(([ch], c) => {
    if (ch === "╭" && box.bottom < 0 && c < 6) Object.assign(box, { top: r, left: c + offset });
    if (ch === "╯") Object.assign(box, { bottom: r, right: c + offset });
  }));
  return box;
};
const CARDS = {
  C: Array.from({ length: AGENTS.C }, (_, i) => [F[`card_C${i}_0`], F[`card_C${i}_1`] ?? F[`card_C${i}_0`]]),
  M: Array.from({ length: AGENTS.M }, (_, i) => [F[`card_M${i}_0`], F[`card_M${i}_0`]]),
};
const CARD_BOX = { C: CARDS.C.map(([g]) => boxOf(g)), M: CARDS.M.map(([g]) => boxOf(g)) };
const PCARDS = {
  C: Array.from({ length: AGENTS.C }, (_, i) => [F[`pcard_C${i}_0`], F[`pcard_C${i}_1`] ?? F[`pcard_C${i}_0`]]),
  M: Array.from({ length: AGENTS.M }, (_, i) => [F[`pcard_M${i}_0`], F[`pcard_M${i}_0`]]),
};
const PCARD_BOX = { C: PCARDS.C.map(([g]) => boxOf(g, 0)), M: PCARDS.M.map(([g]) => boxOf(g, 0)) };
// The compacting agent's card from before it compacts.
const EARLY_CARD = F.card_C3_0p, EARLY_BOX = boxOf(EARLY_CARD);
const PEARLY_CARD = F.pcard_C3_0p, PEARLY_BOX = boxOf(PEARLY_CARD, 0);
function cardNow(ws, i) {
  const early = ws === "C" && i === COMPACTOR && !W.compacting, read = ws === "C" && W.read.has(i) ? 1 : 0;
  if (W.phone) return early ? [PEARLY_CARD, PEARLY_BOX] : [PCARDS[ws][i][read], PCARD_BOX[ws][i]];
  return early ? [EARLY_CARD, EARLY_BOX] : [CARDS[ws][i][read], CARD_BOX[ws][i]];
}
// Each workspace's resource card, a sample a second; the sidebar's figures
// follow the same samples.
const RES_SAMPLES = 12;
const RES = { C: [], M: [] };
for (const ws of ["C", "M"]) for (let f = 0; f < RES_SAMPLES; f++) RES[ws].push(F[`res_${ws}_${f}`]);
const RES_ROW = { C: WS_ROWS.C[2], M: WS_ROWS.M[2] };
const RES_BOX = Object.fromEntries(Object.entries(RES).map(([ws, [g]]) => {
  const box = { top: -1, bottom: 0, left: 0, right: 0, offset: CARD_LEFT };
  g.forEach((row, r) => row.forEach(([ch], c) => {
    if (ch === "┌" && box.top < 0) Object.assign(box, { top: r, left: c + CARD_LEFT });
    if (ch === "┘") Object.assign(box, { bottom: r, right: c + CARD_LEFT });
  }));
  return [ws, box];
}));
// Each sample's totals as the sidebar prints them: [CPU, memory].
const RES_TOTALS = DATA.resTotals;
// corgi places the card at the sidebar's edge, inside the window.
const resLeft = (ws) => Math.max(0, Math.min(W.width, W.cols - (RES_BOX[ws].right - RES_BOX[ws].left + 1) - 1));
const resRect = (ws) => { const box = RES_BOX[ws], left = resLeft(ws); return { ...box, left, right: left + box.right - box.left }; };
const GIT_BOX = boxOf(F.git), PGIT_BOX = boxOf(F.pgit, 0);
// Cards and the commit tooltip sit two cells right of the pointer, so they
// move with the sidebar's edge, clamped to the window. A phone's stay where
// corgi drew them in its 54 columns.
const shifted = (box, width) => {
  const left = box.offset === 0 ? box.left : Math.max(0, Math.min(box.left + (width - CARD_WIDTH_AT), W.cols - (box.right - box.left + 1)));
  return { ...box, left, right: left + box.right - box.left, shift: left - box.left };
};
function overlay(g, frame, box, width, left = shifted(box, width).left) {
  const at = { ...box, left, right: left + box.right - box.left, shift: left - box.left };
  for (let r = box.top; r <= box.bottom; r++) for (let c = box.left; c <= box.right; c++) g[r][c + at.shift] = frame[r][c - box.offset];
  return at;
}

// What each agent is doing, as its own tool shows it.
const SPIN_CLAUDE = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const ORANGE = style("#d97757");
const claudeBottom = (w, extra = "") => [[["─".repeat(w), A.border]], [["❯ ", A.prompt2]], [["─".repeat(w), A.border]], [["⏵⏵ bypass permissions on", A.mode], [extra, A.hint]]];
const codexBottom = (title) => [{ band: A.input, runs: [] }, { band: A.input, runs: [["› ", A.prompt], ["Ask Codex to do anything", A.input]] }, { band: A.input, runs: [] },
  [["  GPT-6 Astra high", A.model], [" · ", A.hint], ["~/dev/corgi", A.path], [" · ", A.hint], [title, A.title]]];
const tool = (verb, arg, out) => [[["⏺ ", A.done], [verb, A.tool], [`(${arg})`, A.text]], [["  ⎿  " + out, A.out]]];
const say = (text) => [[["⏺ ", A.text], ...inline(text, A.text)]];
const ask = (text) => [[["> " + text, A.user]]];
const codexAsk = (text) => [{ band: A.userBand, runs: [["› " + text, A.userBand]] }, []];
function workRows(key, t, w) {
  const spin = SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length];
  const dot = Math.floor(t / 500) % 2 ? "◦" : "•";
  const secs = (start) => `${Math.floor(start + t / 1000)}s`;
  switch (key) {
    case "C0": return [
      ...ask("why does the sidebar redraw on every tick?"), [],
      ...tool("Search", '"redraw"', "Found 9 files"),
      ...say("It only redraws when a row changes. The flicker comes from somewhere else."), [],
      ...ask("the sidebar flickers when an agent finishes"), [],
      ...tool("Read", "src/sidebar.zig", "Read 2104 lines"),
      ...say("`drawAgent` clears each row, then writes it again. Drawing it once."),
      ...tool("Update", "src/sidebar.zig", "Updated src/sidebar.zig with 6 additions and 4 removals"),
      ...tool("Bash", "./scripts/zig build test -Dtest-filter=sidebar", "Running…"), [],
      [[spin + " Testing… ", ORANGE], [`(${secs(41)} · ↓ 2.6k tokens)`, A.hint]], [],
      ...claudeBottom(w)];
    case "C1": return [
      ...codexAsk("audit install.sh for anything unsafe"),
      [["• ", A.bullet], ["Explored", A.tool]], [["  └ Read install.sh", A.out]], [["    Search curl in install.sh", A.out]], [],
      [["• ", A.bullet], ["The script pipes a download straight into tar. I'll check the checksums it trusts.", A.text]], [],
      [["• ", A.bullet], ["Spawned 2 agents", A.tool]], [["  └ Explorer  read install.sh", A.out]], [["    Verifier  fetch SHA256SUMS", A.out]], [],
      [[dot + " ", A.text], ["Working", A.tool], [` (${secs(72)})`, A.hint]], [],
      ...codexBottom("Audit the install script")];
    case "C2": {
      const box = (text, s) => [["│ ", A.border], ...(Array.isArray(text) ? text : [[text, s]]), ["", A.border]];
      return [
        ...ask("draft notes for 0.9 and tag it"), [],
        ...tool("Bash", "git log --oneline v0.8..HEAD", "41 commits"),
        ...tool("Write", "docs/notes/0.9.md", "Wrote 38 lines to docs/notes/0.9.md"),
        ...say("Notes are drafted. Tagging the release next."), [],
        [["╭" + "─".repeat(w - 2) + "╮", A.border]],
        box("Bash command", A.tool), box("", A.text),
        box('  git tag -a v0.9 -m "corgi 0.9"', A.text), box("  Tag the release", A.out), box("", A.text),
        box("Do you want to proceed?", A.text),
        box([["❯ ", A.done], ["1. Yes", A.done]]), box("  2. Yes, and don't ask again for git tag commands", A.text), box("  3. No, and tell Claude what to do differently (esc)", A.text),
        [["╰" + "─".repeat(w - 2) + "╯", A.border]]];
    }
    case "C3": return [
      ...ask("split viewer input into its own file"), [],
      ...tool("Read", "src/viewer.zig", "Read 3120 lines"),
      ...say("Input handling is about a third of the file. Moving it out."),
      ...tool("Update", "src/viewer.zig", "Updated src/viewer.zig with 12 additions and 140 removals"),
      ...tool("Write", "src/viewer_input.zig", "Wrote 152 lines to src/viewer_input.zig"), [],
      W.compacting ? [[spin + " Compacting conversation…", ORANGE]] : [[spin + " Refactoring… ", ORANGE], [`(${secs(204)} · ↓ 9.7k tokens)`, A.hint]], [],
      ...claudeBottom(w)];
    case "C4": return [
      ...codexAsk("bind cmd+1-9 to tabs in ghostty"),
      [["• ", A.bullet], ["Explored", A.tool]], [["  └ Read src/ghostty_integration.zig", A.out]], [],
      [["• ", A.bullet], ["Edited ", A.tool], ["src/ghostty_integration.zig (+18 -2)", A.text]], [],
      [["• ", A.bullet], ["Cmd+1–9 now switch tabs. Reload Ghostty with Cmd+Shift+, to pick it up.", A.text]], [],
      [["  Worked for 4m 12s • 12:14 PM", A.hint]], [],
      ...codexBottom("Ghostty keybindings")];
    case "M0": return [
      ...ask("the lander bounces three times on touchdown"), [],
      ...tool("Read", "src/physics.zig", "Read 412 lines"),
      ...say("Gravity is set to Earth's `9.81`. The moon wants `1.62`."),
      ...tool("Update", "src/physics.zig", "Updated src/physics.zig with 2 additions and 2 removals"),
      ...tool("Bash", "zig build run -- --scene landing", "Running…"), [],
      [[spin + " Tuning… ", ORANGE], [`(${secs(18)} · ↓ 1.1k tokens)`, A.hint]], [],
      ...claudeBottom(w)];
    default: return [
      ...ask("draw a 16x16 lander sprite"), [],
      ...tool("Write", "assets/lander.png", "Wrote a 16x16 sprite"),
      ...say("Drew the lander with two legs and a small thruster flame."), [],
      [["✻ Doodled for 48s · done 11:05 AM", A.hint]], [],
      ...claudeBottom(w)];
  }
}
// The same sessions told short enough for a phone's 28-column pane.
function phoneRows(key, t, w) {
  const spin = SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length];
  const dot = Math.floor(t / 500) % 2 ? "◦" : "•";
  const secs = (start) => `${Math.floor(start + t / 1000)}s`;
  const codex = [{ band: A.input, runs: [] }, { band: A.input, runs: [["› ", A.prompt], ["Ask Codex to do anything", A.input]] }, { band: A.input, runs: [] }, [["  GPT-6 Astra high", A.model]]];
  switch (key) {
    case "C0": return [
      ...ask("fix the sidebar flicker"), [],
      ...tool("Read", "sidebar.zig", "Read 2104 lines"),
      ...say("`drawAgent` draws rows"), [["  twice. Fixing that.", A.text]],
      ...tool("Update", "sidebar.zig", "6 added, 4 removed"),
      ...tool("Bash", "zig build test", "Running…"), [],
      [[spin + " Testing… ", ORANGE], [`(${secs(41)})`, A.hint]], [],
      ...claudeBottom(w)];
    case "C1": return [
      ...codexAsk("audit install.sh"),
      [["• ", A.bullet], ["Explored", A.tool]], [["  └ Read install.sh", A.out]], [],
      [["• ", A.bullet], ["Spawned 2 agents", A.tool]], [["  └ Explorer, Verifier", A.out]], [],
      [[dot + " ", A.text], ["Working", A.tool], [` (${secs(72)})`, A.hint]], [],
      ...codex];
    case "C2": {
      const box = (text, s) => [["│ ", A.border], ...(Array.isArray(text) ? text : [[text, s]]), ["", A.border]];
      return [
        ...ask("tag the 0.9 release"), [],
        ...tool("Write", "notes/0.9.md", "Wrote 38 lines"), [],
        [["╭" + "─".repeat(w - 2) + "╮", A.border]],
        box("Bash command", A.tool), box("  git tag -a v0.9", A.text), box("", A.text),
        box("Do you want to proceed?", A.text), box([["❯ ", A.done], ["1. Yes", A.done]]), box("  2. No", A.text),
        [["╰" + "─".repeat(w - 2) + "╯", A.border]]];
    }
    case "C3": return [
      ...ask("split out viewer input"), [],
      ...tool("Read", "viewer.zig", "Read 3120 lines"),
      ...tool("Update", "viewer.zig", "140 lines out"),
      ...tool("Write", "viewer_input.zig", "Wrote 152 lines"), [],
      W.compacting ? [[spin + " Compacting…", ORANGE]] : [[spin + " Refactoring… ", ORANGE], [`(${secs(204)})`, A.hint]], [],
      ...claudeBottom(w)];
    case "C4": return [
      ...codexAsk("bind cmd+1-9 to tabs"),
      [["• ", A.bullet], ["Edited ", A.tool], ["ghostty.zig", A.text]], [],
      [["• ", A.bullet], ["Cmd+1–9 now switch tabs.", A.text]], [],
      [["  Worked for 4m 12s", A.hint]], [],
      ...codex];
    case "M0": return [
      ...ask("the lander bounces"), [],
      ...tool("Read", "physics.ts", "Read 412 lines"),
      ...say("Gravity is `9.81`; the"), [["  moon wants ", A.text], ["1.62", A.code], [".", A.text]],
      ...tool("Update", "physics.ts", "2 lines changed"),
      ...tool("Bash", "bun test", "Running…"), [],
      [[spin + " Tuning… ", ORANGE], [`(${secs(18)})`, A.hint]], [],
      ...claudeBottom(w)];
    default: return [
      ...ask("draw a lander sprite"), [],
      ...tool("Write", "lander.png", "A 16x16 sprite"),
      ...say("Two legs and a small"), [["  thruster flame.", A.text]], [],
      [["✻ Doodled for 48s", A.hint]], [],
      ...claudeBottom(w)];
  }
}
// The permission box's right edge, padded after its text.
function closeBox(rows, w) {
  return rows.map((row) => {
    const runs = row.runs ?? row;
    if (!Array.isArray(runs) || !runs.length || runs[0][0] !== "│ ") return row;
    const used = runs.reduce((n, [text]) => n + Array.from(text).length, 0);
    return [...runs.slice(0, -1), [" ".repeat(Math.max(0, w - 1 - used)) + "│", A.border]];
  });
}
function drawWork(g, key, t, left) {
  const width = Math.max(0, W.cols - left), w = width - 2, rows = closeBox((W.phone ? phoneRows : workRows)(key, t, w), w), top = WATCH_ROWS_N - rows.length;
  for (let r = 0; r < WATCH_ROWS_N; r++) put(g, r, left, " ".repeat(width), R.pane);
  rows.forEach((row, n) => {
    const r = top + n;
    if (r < 0) return;
    const runs = row.runs ?? row;
    if (row.band) put(g, r, left, " ".repeat(width), faded(row.band, 0));
    let c = left + 1;
    for (const [text, s] of runs) c = put(g, r, c, ellipsis(text, W.cols - 1 - c), faded(s, 0));
  });
}

const watchEl = document.getElementById("v-watch");
const watchScreen = new Screen(watchEl, WATCH_COLS, WATCH_ROWS_N, { badge: true });
const watchPointer = document.getElementById("watch-cursor");
// The pointer's tour starts five seconds in.
const TOUR_START = 5000;
// Whenever the touring pointer appears, it starts large so the eye finds it.
function locatePointer() {
  if (still) return;
  watchPointer.classList.remove("locate");
  void watchPointer.offsetWidth;
  watchPointer.classList.add("locate");
}
const W = {
  ws: "C", width: 34, focus: { C: 0, M: 0 }, read: new Set(), git: "ahead", gitAt: 0, gitHover: false, dragging: false,
  taken: false, inside: false, resumeAt: 0, offset: TOUR_START, hover: null, card: null, dismissed: null, spot: -1, t: 0, herdAt: null,
  res: null, link: false, cols: WATCH_COLS, compacting: still, peekAt: null, wsHover: null,
  phone: false, desk: 34,
};
// Frames by name; a phone's carry a "p".
const frameOf = (name) => F[(W.phone ? "p" : "") + name];
// moonlander's dev server, linked by name on its row; with the pointer on it,
// corgi shows the URL in the window's corner.
const LINK_ROW = WS_ROWS.M[0];
const CHIP = (() => {
  const [row] = F[`wl${WIDTHS[0]}_C`], end = row.findIndex(([, s]) => STYLES[s][1] !== "selected");
  return row.slice(0, end);
})();
function linkSpan() {
  const cols = [];
  sidebarNow()[LINK_ROW].forEach(([, s], c) => { if (STYLES[s][3] && !STYLES[s][4]) cols.push(c); });
  return cols.length ? { from: cols[0], to: cols[cols.length - 1] } : null;
}
const linkAt = ({ col, row }) => { const span = row === LINK_ROW ? linkSpan() : null; return !!span && col >= span.from && col <= span.to; };
// The tour opens each agent's card, then points at the link.
const tourSlots = (n) => [...Array.from({ length: n }, (_, i) => i), -1];
const slotOf = (i) => i;
// The sidebar as the current workspace, width, focus, reads and badge draw it.
const SIDE_CACHE = new Map();
function sidebarNow() {
  const ahead = W.git === "none" ? 0 : 1, unread = WATCH_UNREAD.length - W.read.size;
  const key = [W.phone, W.ws, W.width, W.focus[W.ws], [...W.read].sort().join(","), ahead, W.compacting].join(":");
  if (SIDE_CACHE.has(key)) return SIDE_CACHE.get(key);
  const g = blank(WATCH_ROWS_N, WATCH_COLS), top = frameOf(`w${W.width}_${W.ws}${unread}${ahead}`);
  top.forEach((row, r) => row.forEach((cell, c) => (g[r][c] = cell)));
  const rest = frameOf(`w${W.width}_e${W.ws}00`);
  rest.forEach((row, r) => row.forEach((cell, c) => (g[AGENT_TOP + r][c] = cell)));
  for (let i = 0; i < AGENTS[W.ws]; i++) {
    const read = W.ws === "C" && W.read.has(i) ? 1 : 0;
    const focus = i === W.focus[W.ws] ? 1 : 0;
    const early = W.ws === "C" && i === COMPACTOR && !W.compacting;
    const frame = frameOf(early ? `w${W.width}_eC${focus}0p` : `w${W.width}_e${W.ws}${focus}${read}`) ?? rest;
    for (const y of [WATCH_ROWS[i], WATCH_ROWS[i] + 1]) frame[y - AGENT_TOP].forEach((cell, c) => (g[y][c] = cell));
  }
  tidySidebar(g);
  // No scope dropdown: the header reads "agents", then New.
  const head = AGENT_TOP - 2, text = g[head].map(([ch]) => ch).join(""), from = text.indexOf("agents") + 6, to = text.indexOf(" New");
  for (let c = from; c < to; c++) g[head][c] = [" ", g[head][0][1]];
  SIDE_CACHE.set(key, g);
  return g;
}
// Focusing an agent reads it, as in corgi.
function focusAgent(i) {
  W.focus[W.ws] = i;
  if (W.ws === "C" && WATCH_UNREAD.includes(i)) W.read.add(i);
}
function switchTo(ws) {
  if (W.ws === ws) return;
  Object.assign(W, { ws, hover: null, card: null, res: null, dismissed: null, spot: -1 });
}
// The push button, as drawGitAction draws it: right-aligned on corgi's name row.
function gitLabel(now) {
  if (W.git === "pushing") return { text: ` Pushing ${corgiAnimation.spinner(false, now)}`, fg: "accent" };
  if (W.git === "pushed") return { text: " Pushed ✓", fg: "accent" };
  if (W.git === "ahead" && W.gitHover) return { text: " Push ↑2", fg: "warm" };
  return null;
}
// A phone's finger gets the whole "Push ↑2" width to aim at.
const gitHit = ({ col, row }) => W.git === "ahead" && row === 2 && col >= W.width - 2 - (W.gitHover || W.phone ? 8 : 2) && col < W.width - 2;
function drawWatch(t) {
  // One clock for every redraw, so a pointer move never jumps the animations.
  W.t = t;
  const now = performance.now();
  if (W.git === "pushing" && now - W.gitAt > 1800) Object.assign(W, { git: "pushed", gitAt: now });
  if (W.git === "pushed" && now - W.gitAt > 1500) Object.assign(W, { git: "none", gitHover: false });
  if (W.taken && !W.inside && now >= W.resumeAt) {
    Object.assign(W, { taken: false, spot: -1, offset: t - (slotOf(W.focus[W.ws]) + 1) * 4000 });
    watchEl.classList.remove("taken");
    locatePointer();
  }
  const n = AGENTS[W.ws];
  if (!W.taken && t < W.offset) {
    Object.assign(W, { hover: null, card: null, link: false });
    watchPointer.classList.remove("on");
  } else if (!W.taken) {
    // Four seconds a stop: move, open its card, maybe click the agent.
    const slots = tourSlots(n), slot = Math.floor((t - W.offset) / 4000) % slots.length, i = slots[slot], p = (t - W.offset) % 4000;
    W.res = null;
    if (i < 0) Object.assign(W, { hover: null, card: null, link: p >= 600 && p < 3700 });
    else {
      const clicks = TOUR_CLICKS[W.ws](i);
      W.link = false;
      W.hover = p >= 600 ? i : null;
      W.card = p >= 600 && (p < 2600 || !clicks) && p < 3500 ? i : null;
      if (clicks && p >= 2600 && W.focus[W.ws] !== i) focusAgent(i);
    }
    if (W.spot !== slot) {
      W.spot = slot;
      const span = i < 0 ? linkSpan() : null;
      watchPointer.style.top = `${((span ? LINK_ROW : WATCH_ROWS[i] ?? WATCH_ROWS[0]) + 0.5) * 1.42}em`;
      watchPointer.style.left = span ? `${(span.from + span.to + 1) / 2}ch` : "";
      watchPointer.classList.toggle("over", !!span);
    }
    if (!still && !watchPointer.classList.contains("on")) { watchPointer.classList.add("on"); locatePointer(); }
  }
  if (W.ws === "C" && W.hover === COMPACTOR && W.peekAt == null) W.peekAt = now;
  W.compacting = still || (W.peekAt != null && now - W.peekAt >= COMPACT_AFTER);
  const g = animate(sidebarNow(), t);
  // Resources sample once a second; the sidebar shows the latest totals.
  const sample = Math.floor(t / 1000) % RES_SAMPLES;
  for (const ws of ["C", "M"]) {
    const row = RES_ROW[ws], text = g[row].map(([ch]) => ch).join("");
    const cpu = text.match(/\d+%/), memory = text.match(/\d[\d.]*[GM]\b/);
    if (cpu) put(g, row, cpu.index, RES_TOTALS[ws][sample][0].padEnd(cpu[0].length));
    if (memory) put(g, row, memory.index, RES_TOTALS[ws][sample][1].padEnd(memory[0].length));
  }
  // The compacting agent piles its dots and herds its letters once, as corgi
  // does, starting when its row is fully on screen.
  if (W.ws === "C" && W.compacting) {
    const row = WATCH_ROWS[COMPACTOR] + 1, width = W.width - 6;
    if (W.herdAt == null && !still) {
      const box = watchScreen.rowEls[row].getBoundingClientRect();
      if (box.top >= 0 && box.bottom <= innerHeight) W.herdAt = now;
    }
    const step = still ? 40 : W.herdAt == null ? 0 : Math.floor((now - W.herdAt) / 110);
    const ground = STYLES[g[row][4][1]][1] ?? "bg";
    put(g, row, BAR + 1, corgiAnimation.spinner(true, t));
    terminal.row(corgiAnimation.writeHerd(width, step), width).forEach(([ch, fg], c) => put(g, row, BAR + 4 + c, ch, keepRule(style(fg ?? "text", ground), g[row][BAR + 4 + c])));
  }
  drawWork(g, W.ws + W.focus[W.ws], t, W.width);
  const label = gitLabel(now);
  if (label) put(g, 2, W.width - 2 - Array.from(label.text).length, label.text, style(label.fg, W.gitHover || W.ws === "C" ? "selected" : "bg", true));
  // The workspace not shown fades back, until the pointer comes to it.
  const other = W.ws === "C" ? "M" : "C";
  if (W.wsHover !== other && W.res !== other) for (const r of WS_ROWS[other]) for (let c = 0; c < W.width - 1; c++) {
    const [ch, s] = g[r][c], [fg, bg, bold, ul, ulc] = STYLES[s];
    if (fg) g[r][c] = [ch, style(mix(fg, "bg", 0.45), bg, bold, ul, ulc)];
  }
  // A hovered resource row brightens, as drawResources draws it.
  if (W.res) for (let c = BAR + 1; c < W.width - 2; c++) {
    const row = RES_ROW[W.res], [ch, s] = g[row][c], [fg, , bold, ul, ulc] = STYLES[s];
    g[row][c] = [ch, style(fg === "faint" || fg === "muted" ? "text" : fg, "selected", bold, ul, ulc)];
  }
  // The hovered agent's tint goes under any card: a phone's card covers it.
  if (W.hover != null) for (const r of [WATCH_ROWS[W.hover], WATCH_ROWS[W.hover] + 1]) for (let c = BAR; c < W.width - 2; c++) {
    const [ch, s] = g[r][c], [fg, bg, bold, ul, ulc] = STYLES[s];
    if (bg === "bg") g[r][c] = [ch, style(fg, HOVER_BG, bold, ul, ulc)];
  }
  if (W.link) CHIP.forEach((cell, c) => (g[WATCH_ROWS_N - 1][c] = cell));
  if (W.res) overlay(g, RES[W.res][sample], RES_BOX[W.res], W.width, resLeft(W.res));
  else if (W.card != null) overlay(g, ...cardNow(W.ws, W.card), W.width);
  else if (W.gitHover && W.git !== "none") overlay(g, W.phone ? F.pgit : F.git, W.phone ? PGIT_BOX : GIT_BOX, W.width);
  watchScreen.paint(g);
}
const watchCell = (e) => {
  const box = watchEl.getBoundingClientRect();
  return { col: Math.floor((e.clientX - box.left) / (box.width / W.cols)), row: Math.floor((e.clientY - box.top) / (box.height / WATCH_ROWS_N)) };
};
const agentAt = ({ col, row }) => (col < W.width - 1 ? WATCH_ROWS.slice(0, AGENTS[W.ws]).findIndex((y) => row === y || row === y + 1) : -1);
const workspaceAt = ({ col, row }) => (col >= W.width - 1 ? null : WS_ROWS.C.includes(row) ? "C" : WS_ROWS.M.includes(row) ? "M" : null);
const unreadAt = ({ col, row }) => {
  if (row !== 3 || col >= W.width - 1) return false;
  const text = sidebarNow()[3].map(([ch]) => ch).join(""), at = text.indexOf("unread →");
  if (at < 0) return false;
  let from = at;
  while (from > 0 && /[0-9 ]/.test(text[from - 1])) from--;
  return col >= from && col < at + "unread →".length;
};
// A phone's sidebar keeps its width.
const edgeAt = ({ col }) => !W.phone && col === W.width - 1;
// The agents header's New button, through its ▾.
const newAt = ({ col, row }) => {
  if (row !== AGENT_TOP - 2 || col >= W.width - 1) return false;
  const text = sidebarNow()[row].map(([ch]) => ch).join(""), from = text.indexOf(" New") + 1, to = text.indexOf("▾", from);
  return from > 0 && col >= from - 1 && col <= (to < 0 ? from + 3 : to);
};
// A resource row, up to the sidebar's edge on the way to its card.
// corgi needs 68 columns for the resource card, so a phone has none.
const resAt = ({ col, row }) => (W.phone || col >= W.width ? null : row === RES_ROW.C ? "C" : row === RES_ROW.M ? "M" : null);
const within = ({ col, row }, box) => row >= box.top && row <= box.bottom && col >= box.left && col <= box.right;
// A phone has no hover: taps drive it (tapWatch).
watchEl.addEventListener("mouseenter", () => { if (W.phone) return; Object.assign(W, { taken: true, inside: true }); watchEl.classList.add("taken"); });
watchEl.addEventListener("mouseleave", () => { if (!W.phone) Object.assign(W, { inside: false, hover: null, card: null, res: null, link: false, wsHover: null, dismissed: null, gitHover: false, resumeAt: performance.now() + 5000 }); });
watchEl.addEventListener("mousemove", (e) => {
  if (W.dragging || W.phone) return;
  const at = watchCell(e), i = agentAt(at);
  W.wsHover = workspaceAt(at);
  // The resource card stays open while the pointer is on it.
  if (W.res && within(at, resRect(W.res)) && !resAt(at)) return drawWatch(W.t);
  W.link = linkAt(at);
  if (W.link) { Object.assign(W, { hover: null, card: null, res: null, gitHover: false }); watchEl.style.cursor = "pointer"; return drawWatch(W.t); }
  W.res = resAt(at);
  if (W.res) { Object.assign(W, { hover: null, card: null, gitHover: false }); watchEl.style.cursor = edgeAt(at) ? "col-resize" : "pointer"; return drawWatch(W.t); }
  W.gitHover = gitHit(at) || (W.gitHover && W.git !== "none" && at.row >= GIT_BOX.top && at.row <= GIT_BOX.bottom && at.col >= shifted(GIT_BOX, W.width).left);
  watchEl.style.cursor = edgeAt(at) ? "col-resize" : i >= 0 || gitHit(at) || unreadAt(at) || workspaceAt(at) || newAt(at) ? "pointer" : "";
  const box = W.card == null ? null : shifted(cardNow(W.ws, W.card)[1], W.width);
  // The pointer may cross onto the open card without closing it.
  if (box && at.row >= box.top && at.row <= box.bottom && at.col >= box.left && at.col <= box.right) return drawWatch(W.t);
  if (i !== W.dismissed) W.dismissed = null;
  W.hover = i >= 0 ? i : null;
  W.card = i >= 0 && i !== W.dismissed ? i : null;
  drawWatch(W.t);
});
// A narrower window keeps the text size and takes columns from the agent's
// pane, as a smaller terminal would; only below MIN_COLS does the text shrink.
// The text also shrinks so the screen fits under the hero in the first
// window. Never past 11px.
const MIN_COLS = 84, PHONE_COLS = 54, PHONE_ROOM = 600, watchBand = watchEl.closest(".band"), watchStage = watchEl.parentElement;
function fitWatch() {
  const phone = watchBand.clientWidth - 26 < PHONE_ROOM;
  if (phone !== W.phone) {
    // A phone draws corgi's narrowest sidebar; desktop gets its width back.
    if (phone) W.desk = W.width;
    Object.assign(W, { phone, width: phone ? 26 : W.desk, hover: null, card: null, res: null, link: false, gitHover: false, dismissed: null, cols: 0 });
    watchStage.classList.toggle("phone", phone);
  }
  if (W.phone) {
    const fs = Math.min(14, watchBand.clientWidth / PHONE_COLS / 0.6);
    if (W.cols === PHONE_COLS && fs === W.fs) return;
    Object.assign(W, { cols: PHONE_COLS, fs });
    watchEl.style.setProperty("--fs", `${fs}px`);
    watchEl.style.setProperty("--vis", PHONE_COLS);
    return drawWatch(W.t);
  }
  const room = watchBand.clientWidth - 26;
  const below = innerHeight - (watchEl.getBoundingClientRect().top + scrollY) - 24;
  const fs = Math.min(14, Math.max(11, Math.min(room / (MIN_COLS * 0.6), below / (WATCH_ROWS_N * 1.42))));
  watchEl.style.setProperty("--fs", `${fs}px`);
  const ch = watchScreen.spans[0][0].getBoundingClientRect().width || fs * 0.6;
  const cols = Math.max(1, Math.min(WATCH_COLS, Math.floor(room / ch)));
  if (cols === W.cols && fs === W.fs) return;
  Object.assign(W, { cols, fs });
  watchEl.style.setProperty("--vis", cols);
  drawWatch(W.t);
}
new ResizeObserver(() => requestAnimationFrame(fitWatch)).observe(watchBand);
addEventListener("resize", fitWatch);
document.fonts?.ready.then(fitWatch);
// Dragging the sidebar's right edge resizes it, as in corgi.
watchEl.addEventListener("mousedown", (e) => {
  if (!edgeAt(watchCell(e))) return;
  W.dragging = true;
  e.preventDefault();
});
document.addEventListener("mousemove", (e) => {
  if (!W.dragging) return;
  const col = watchCell(e).col + 1;
  const width = WIDTHS.reduce((best, w) => (Math.abs(w - col) < Math.abs(best - col) ? w : best), W.width);
  if (width !== W.width) { W.width = width; drawWatch(W.t); }
});
document.addEventListener("mouseup", () => { W.dragging = false; });
// A phone's tap: with a card or tooltip open it only dismisses that (a tap
// on "Push ↑2" pushes); otherwise an agent opens its card, focused and read,
// and the rest act as clicks do. The tour resumes 6 s after the last tap.
function tapWatch(at) {
  const now = performance.now();
  Object.assign(W, { taken: true, inside: false, resumeAt: now + 6000 });
  watchEl.classList.add("taken");
  if (W.gitHover && W.git === "ahead" && gitHit(at)) return Object.assign(W, { git: "pushing", gitAt: now, gitHover: false });
  if (W.card != null || W.gitHover || W.link) return Object.assign(W, { card: null, hover: null, gitHover: false, link: false });
  if (linkAt(at)) return (W.link = true);
  if (newAt(at)) return summonPicker();
  if (gitHit(at)) return (W.gitHover = true);
  if (unreadAt(at)) {
    const i = WATCH_UNREAD.find((n) => !W.read.has(n));
    if (i != null) { switchTo("C"); focusAgent(i); }
    return;
  }
  const ws = workspaceAt(at);
  if (ws) return switchTo(ws);
  const i = agentAt(at);
  if (i >= 0) { focusAgent(i); Object.assign(W, { card: i, hover: i }); }
}
// Clicks: Push, "unread →", a workspace, or an agent.
watchEl.addEventListener("click", (e) => {
  const at = watchCell(e);
  if (W.phone) { tapWatch(at); return drawWatch(W.t); }
  // The link would open in a browser; here it only shows where it goes.
  if (edgeAt(at) || linkAt(at) || (W.res && within(at, resRect(W.res)) && !resAt(at))) return;
  if (newAt(at)) return summonPicker();
  if (gitHit(at)) {
    Object.assign(W, { git: "pushing", gitAt: performance.now() });
    return drawWatch(W.t);
  }
  if (unreadAt(at)) {
    const i = WATCH_UNREAD.find((n) => !W.read.has(n));
    if (i != null) { switchTo("C"); focusAgent(i); Object.assign(W, { card: null, dismissed: i }); }
    return drawWatch(W.t);
  }
  const ws = workspaceAt(at);
  if (ws) { switchTo(ws); return drawWatch(W.t); }
  const i = agentAt(at);
  if (i < 0) return;
  focusAgent(i);
  Object.assign(W, { card: null, dismissed: i });
  drawWatch(W.t);
});

// `top` for your tokens: corgi's overview, open under the hovered badge. Each
// step adds the working agents' new tokens; Tune the thruster physics passes
// Release notes, and Corgi's summarizer runs now and then.
const OV_STEP = 2400, OV_CARD = F.ov_card;
const overviewEl = document.getElementById("v-overview");
const overviewScreen = new Screen(overviewEl, OV_CARD[0][0].length, OV_CARD[0].length, { badge: true });
let overviewShown = null;
// On a phone the card is laid out like the picker: agents under their
// account, limits under their own header, each a label and one figure at the
// right edge, from the same cells corgi drew.
const OPW = 48, OPROWS = 13, OFIG = 45;
const overviewPhoneEl = document.getElementById("v-overview-phone");
const overviewPhone = new Screen(overviewPhoneEl, OPW, OPROWS);
const OV_PHONE = new Map();
function phoneOverview(f) {
  if (OV_PHONE.has(f)) return OV_PHONE.get(f);
  const text = (r) => f[r].map(([ch]) => ch).join(""), cells = (r, from, n) => f[r].slice(from, from + n);
  const head = text(5), opusEnd = head.indexOf("≈opus") + 5, model = head.indexOf("Model"), split = text(6).indexOf("┬");
  const line = f[2][2][1], ground = style(null, "bg"), faint = style("faint", "bg"), rule = style("line", "bg");
  const g = Array.from({ length: OPROWS }, (_, r) => Array.from({ length: OPW }, (_, c) => [r === 0 || r === OPROWS - 1 ? "─" : c === 0 || c === OPW - 1 ? "│" : " ", c === 0 || c === OPW - 1 || r === 0 || r === OPROWS - 1 ? line : ground]));
  Object.assign(g[0], { 0: ["╭", line], [OPW - 1]: ["╮", line] });
  Object.assign(g[OPROWS - 1], { 0: ["╰", line], [OPW - 1]: ["╯", line] });
  const place = (r, c, list) => list.forEach((cell, k) => (g[r][c + k] = cell));
  const right = (r, list) => place(r, OFIG - list.length + 1, list);
  // The title and the total ride the top border.
  const title = text(3), name = title.indexOf("Observed tokens"), total = title.match(/[\d.]+k?(?= tokens)/);
  place(0, 2, [[" ", line], ...cells(3, name, "Observed tokens".length), [" ", line]]);
  right(0, [[" ", line], ...cells(3, total.index, total[0].length), [" ", line]]);
  // A group: its label, a rule, and what its figures are.
  const header = (r, label, unit) => {
    const c = put(g, r, 3, label + " ", faint), u = OFIG - unit.length + 1;
    put(g, r, c, "─".repeat(Math.max(0, u - 1 - c)), rule);
    put(g, r, u, unit, faint);
  };
  const section = text(6).slice(0, split).replace(/[├─┬]/g, " ").trim().split(" · ")[0].replace(/^(\S+) /, "$1 · ");
  header(1, section, "≈opus");
  for (let r = 7, row = 2; r <= 12; r++, row++) {
    const glyph = text(r).search(/[▶●○]/);
    place(row, 3, cells(r, glyph, 1));
    const label = cells(r, glyph + 2, model - glyph - 2);
    while (label.length && label.at(-1)[0] === " ") label.pop();
    place(row, 5, label.slice(0, OFIG - 14));
    const spend = cells(r, opusEnd - 8, 8);
    while (spend.length && spend[0][0] === " ") spend.shift();
    right(row, spend);
  }
  header(9, "Limits", "resets in");
  for (const [r, row] of [[7, 10], [8, 11]]) {
    const side = text(r).slice(split + 1), at = split + 1, m = side.match(/(\S+) (\S+)\s+(\d+%) (↻ .*?)\s*│/);
    if (!m) continue;
    const start = at + side.indexOf(m[1]);
    place(row, 3, cells(r, start, m[1].length + 1 + m[2].length + 2 + m[3].length));
    right(row, cells(r, at + side.indexOf(m[4]), m[4].length));
  }
  OV_PHONE.set(f, g);
  return g;
}
const overviewSection = document.getElementById("overview"), overviewStage = document.getElementById("overview-stage");
let overviewPhoneOn = false;
function drawOverview(t) {
  const g = OV_CARD[Math.floor(t / OV_STEP) % OV_CARD.length];
  if (overviewPhoneOn) { if (g !== overviewShown) overviewPhone.paint(phoneOverview((overviewShown = g))); return; }
  if (g !== overviewShown) overviewScreen.paint((overviewShown = g));
}
// Below 600 pixels the card takes the phone's layout, edge to edge.
new ResizeObserver(() => requestAnimationFrame(() => {
  const phone = overviewSection.clientWidth < 600;
  if (phone === overviewPhoneOn) return;
  overviewPhoneOn = phone;
  overviewEl.hidden = phone;
  overviewPhoneEl.hidden = !phone;
  overviewStage.classList.toggle("phone", phone);
  overviewShown = null;
})).observe(overviewSection);

// [watched element, draw, loop length, resting time]
const LOOPS = [
  [launcherStage, drawLauncher, 1e9, 0],
  [watchEl, drawWatch, 1e9, 3600],
  [document.getElementById("overview-stage"), drawOverview, OV_STEP * OV_CARD.length, 0],
];
LOOPS.forEach(([el]) => watch.observe(el));

// ---------------------------------------------------------------- hero corgi
// The awake corgi, played by corgi's own Fetch: it wags, and fetches when a
// click throws it a ball, a roll, a lob or a smash. The row ends in the low
// slant the ball bounces off.
const rowOf = (el, n) => Array.from({ length: n }, () => el.appendChild(document.createElement("span")));
const ROOM = 22, SLANT = String.fromCodePoint(0x2860);
// A phone lane can be narrower than corgi's sidebar ever is.
const play = new corgiAnimation.Fetch(10);
let lane = ROOM;
const sprite = document.getElementById("sprite");
const spriteCells = rowOf(sprite, ROOM);
// On a phone the corgi sits beside the centered title, so its lane is what
// fits before the screen's edge, where the slant stands; a throw keeps the
// lane it started with. Cells past the lane are hidden, so nothing spills.
function laneNow() {
  if (getComputedStyle(sprite).position !== "static") return ROOM;
  const cell = spriteCells[0].getBoundingClientRect();
  return Math.max(10, Math.min(ROOM, Math.floor((document.documentElement.clientWidth - cell.left) / cell.width)));
}
// A click throws a ball, unless the corgi is still fetching the last one.
sprite.addEventListener("click", () => {
  const now = performance.now();
  if (still || play.tick(lane, now) !== null) return;
  lane = laneNow();
  play.throwBall(lane, now);
});
function drawSprite(now) {
  // A screen that narrows mid-throw (a phone turning) ends the throw.
  if (play.tick(lane, now) !== null && lane > laneNow()) play.thrown_ms = null;
  const at = still ? null : play.tick(lane, now);
  if (at === null) lane = laneNow();
  // Resting, the row still ends in the slant, so it invites a throw.
  const pose = still ? "~ᐯ•ᴥ•ᐯ" : WAG[Math.floor(now / 200) % WAG.length];
  const cells = terminal.row(at !== null ? corgiAnimation.writeFetch(lane, play.throw, at) : pose.padEnd(lane - 1) + palette.fg("faint") + SLANT, lane);
  spriteCells.forEach((cell, i) => {
    const [ch, fg] = cells[i] ?? [" ", null];
    if (cell.textContent !== ch) cell.textContent = ch;
    if (cell.hidden !== i >= lane) cell.hidden = i >= lane;
    // The slant is faint, and lit while the ball shares its cell.
    cell.classList.toggle("slant", fg === "faint");
  });
}

// ---------------------------------------------------------------- love heart
// A warm band reads along the line, gold turning rose, and the <3 it reaches
// becomes a heart that swells to red three times. The line reads again after
// a pause; hovering or tapping it cuts the pause short.
const LOVE = Array.from("A love letter to the modern terminal. <3"), HEART = LOVE.indexOf("<");
const loveLine = document.getElementById("love");
loveLine.textContent = "";
const loveCells = rowOf(loveLine, LOVE.length), loveShown = [];
const LOVE_TICK = 50, BAND_SPEED = 1.5, BAND_TRAIL = 9, LOVE_PAUSE = 5000;
const ARRIVE = Math.ceil(HEART / BAND_SPEED) * LOVE_TICK;
// The heart's red level, 0 at a rosy gray and 1 at hot: three rises, easing
// back between them, the last one held. A later pass starts at red.
const LOW = mix("muted", "hot", 0.35), RISE = 300, FALL = 500, HOLD = 300;
function swells(fromRed) {
  const keys = [[0, fromRed ? 1 : 0]];
  let at = 0;
  for (let n = 0; n < 3; n++) {
    if (n || fromRed) keys.push([(at += FALL), 0]);
    keys.push([(at += RISE), 1]);
  }
  return keys;
}
const SWELLS = [swells(false), swells(true)];
function swell(keys, s) {
  for (let i = 1; i < keys.length; i++) {
    const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
    if (s < t1) { const x = Math.max(0, (s - t0) / (t1 - t0)); return v0 + (v1 - v0) * x * x * (3 - 2 * x); }
  }
  return keys.at(-1)[1];
}
// The first pass shows ♡ for a tick before the heart fills.
const loveEnd = (pass) => ARRIVE + (pass ? 0 : LOVE_TICK) + SWELLS[pass ? 1 : 0].at(-1)[0] + HOLD;
function loveFrame(t, pass) {
  const cells = LOVE.map((ch) => [ch, ""]);
  const heart = (ch, color) => { cells[HEART] = [ch, color]; cells[HEART + 1] = [" ", ""]; };
  if (pass) heart("♥\uFE0E", HEX.hot);
  if (t < 0) return cells;
  const head = (t / LOVE_TICK) * BAND_SPEED;
  for (let i = 0; i < HEART; i++) {
    const d = head - i;
    if (d >= 0 && d < BAND_TRAIL) cells[i][1] = mix("muted", mix("warm", "hot", i / HEART), 0.9 * (1 - d / BAND_TRAIL));
  }
  if (t < ARRIVE) return cells;
  if (!pass && t < ARRIVE + LOVE_TICK) heart("♡\uFE0E", LOW);
  else heart("♥\uFE0E", mix(LOW, "hot", swell(SWELLS[pass ? 1 : 0], t - ARRIVE - (pass ? 0 : LOVE_TICK))));
  return cells;
}
const love = { start: performance.now() + 1000, pass: 0 };
function drawLove(now) {
  let t = now - love.start;
  if (t >= loveEnd(love.pass)) { love.pass++; love.start = now + LOVE_PAUSE; t = -1; }
  const cells = still ? loveFrame(-1, 1) : loveFrame(Math.floor(t / LOVE_TICK) * LOVE_TICK, love.pass);
  loveCells.forEach((s, i) => {
    const [ch, color] = cells[i];
    if (loveShown[i] === ch + color) return;
    loveShown[i] = ch + color;
    s.textContent = ch;
    s.style.color = color;
  });
}
const readNow = () => { const now = performance.now(); if (now < love.start) love.start = now; };
loveLine.addEventListener("pointerenter", readNow);
loveLine.addEventListener("click", readNow);

// ---------------------------------------------------------------- footer corgi
const sleeperCells = rowOf(document.getElementById("sleeper"), 16);
// Corgi's sleeper, dreaming as a lone sidebar sleeper does.
function drawSleeper(now) {
  const dream = still ? null : corgiAnimation.dreamer([0n], now + 3500);
  const cells = terminal.row(corgiAnimation.idle(16, new corgiAnimation.Sleep({ puff_ms: dream?.puff_ms ?? null })), 16);
  sleeperCells.forEach((s, i) => {
    const [ch, fg] = cells[i];
    if (s.textContent !== ch) s.textContent = ch;
    s.style.color = ch === " " ? "" : HEX[fg] ?? fg;
  });
}

// ---------------------------------------------------------------- wiring
const started = new Map();
function frame(now) {
  drawSprite(now);
  drawLove(now);
  for (const [el, draw, period, rest] of LOOPS) {
    if (still) { draw(rest); continue; }
    if (visible.has(el) && !started.has(el)) started.set(el, now);
    if (started.has(el) && !visible.has(el)) continue;
    draw(started.has(el) ? (now - started.get(el)) % period : rest);
  }
  drawSleeper(now);
}
frame(performance.now());
if (!still) setInterval(() => frame(performance.now()), 50);

const copyBtn = document.getElementById("copy");
copyBtn.addEventListener("click", () => {
  const text = "curl -fsSL https://corgi.computer/install.sh | bash";
  const cmd = copyBtn.closest(".cmd");
  const reset = () => { copyBtn.classList.remove("copied"); copyBtn.setAttribute("aria-label", "Copy the install command"); };
  // The check shows on the click itself; the glint runs alongside it.
  clearTimeout(copyBtn.timer);
  copyBtn.classList.remove("copied");
  cmd.classList.remove("glint");
  void cmd.offsetWidth;
  copyBtn.classList.add("copied");
  copyBtn.setAttribute("aria-label", "Copied");
  if (!still) cmd.classList.add("glint");
  copyBtn.timer = setTimeout(reset, 1600);
  // Without clipboard access, select the command for a manual copy instead.
  const select = () => {
    clearTimeout(copyBtn.timer);
    reset();
    const range = document.createRange(); range.selectNodeContents(document.getElementById("install-cmd")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  };
  try { navigator.clipboard.writeText(text).catch(select); } catch { select(); }
});

// ---------------------------------------------------------------- the tour
// A corgi session in split panes, built from keeps watch's frames. The tour
// plays a user at work and stops now and then to point at something worth
// seeing. Hover or click and the visitor takes over; the tour comes back a
// few seconds after the pointer leaves.
(() => {
const COLS = WATCH_COLS, ROWS = WATCH_ROWS_N, SW = 34;
const simEl = document.getElementById("v-sim"), host = document.getElementById("sim-host"), layer = document.getElementById("sim-layer");
const keysEl = document.getElementById("sim-keys"), chaptersEl = document.getElementById("sim-chapters"), pointer = document.getElementById("sim-cursor");
const screen = new Screen(simEl, COLS, ROWS, { badge: true });
const rowText = (g, r) => g[r].map(([ch]) => ch).join("");

// ---- state
// moonlander splits into Claude, a finished Claude and a shell; corgi holds
// three agents in its first tab and two in its second.
const right = (a, b, ratio = 0.52) => ({ dir: "right", ratio, a, b }), down = (a, b, ratio = 0.5) => ({ dir: "down", ratio, a, b });
const pane = (id) => ({ id });
function tabsOf(ws) {
  if (ws === "C") return [right(pane("C0"), down(pane("C2"), pane("C1"), 0.56)), right(pane("C3"), pane("C4"), 0.5)];
  return [S.split === 1 ? pane("M0") : S.split === 2 ? right(pane("M0"), pane("M1")) : right(pane("M0"), down(pane("M1"), pane("sh"), 0.42))];
}
const S = {};
function reset() {
  Object.assign(S, {
    ws: "M", split: 3, tab: { M: 0, C: 0 }, focus: { M: "M0", C: "C0" }, read: new Set(),
    typed: "", history: [], server: false, link: 0, linkAt: 0,
    hover: null, card: null, res: null, wsHover: null, linkHover: false,
    git: "ahead", gitAt: 0, gitHover: false, approvedAt: null, tagged: false, host: null,
  });
}
reset();
const agentOf = (id) => (id === "sh" ? -1 : Number(id.slice(1)));
const unread = () => (S.read.has(4) ? 0 : 1) + (S.tagged && !S.read.has(2) ? 1 : 0);

// ---- the sidebar, from corgi's frames
const SIDE = new Map();
function sidebar() {
  const ws = S.ws, ahead = S.git === "none" ? 0 : 1, fi = agentOf(S.focus[ws]), un = Math.min(1, unread());
  const key = [ws, ahead, un, fi, [...S.read].sort().join(",")].join(":");
  if (SIDE.has(key)) return SIDE.get(key);
  const g = blank(ROWS, COLS);
  F[`w34_${ws}${un}${ahead}`].forEach((row, r) => row.forEach((cell, c) => (g[r][c] = cell)));
  const rest = F[`w34_e${ws}00`];
  rest.forEach((row, r) => row.forEach((cell, c) => (g[AGENT_TOP + r][c] = cell)));
  for (let i = 0; i < AGENTS[ws]; i++) {
    const read = ws === "C" && S.read.has(i) ? 1 : 0, focus = i === fi ? 1 : 0;
    const frame = F[ws === "C" && i === COMPACTOR ? `w34_eC${focus}0p` : `w34_e${ws}${focus}${read}`] ?? rest;
    for (const y of [WATCH_ROWS[i], WATCH_ROWS[i] + 1]) frame[y - AGENT_TOP].forEach((cell, c) => (g[y][c] = cell));
  }
  tidySidebar(g);
  const head = AGENT_TOP - 2, text = rowText(g, head), from = text.indexOf("agents") + 6, to = text.indexOf(" New");
  for (let c = from; c < to; c++) g[head][c] = [" ", g[head][0][1]];
  SIDE.set(key, g);
  return g;
}
const LINK_ROW = WS_ROWS.M[0], LINK_TEXT = "Game ↗";
const linkCol = () => rowText(sidebar(), LINK_ROW).indexOf(LINK_TEXT);
const groundOf = (g, r, c) => STYLES[g[r][c][1]][1];

// ---- panes
const TAB_ON = style("strong", "selected", true), TAB_OFF = style("faint", "bg"), TAB_ADD = style("strong", "surface", true);
const EDGE_ON = style("accent", null, true), EDGE = style("line");
const PATH = style("#9fd39a"), URL = style("#a9b1f5"), VITE = style("accent", null, true), CURSOR = style(null, "text");
function leaves(node, x, y, w, h, out = []) {
  if (node.id) { out.push({ id: node.id, x, y, w, h }); return out; }
  if (node.dir === "right") {
    const aw = Math.max(1, Math.round((w - 1) * node.ratio));
    leaves(node.a, x, y, aw, h, out); leaves(node.b, x + aw + 1, y, w - aw - 1, h, out);
  } else {
    const ah = Math.max(1, Math.round((h - 1) * node.ratio));
    leaves(node.a, x, y, w, ah, out); leaves(node.b, x, y + ah + 1, w, h - ah - 1, out);
  }
  return out;
}
function layout() {
  const root = tabsOf(S.ws)[S.tab[S.ws]] ?? tabsOf(S.ws)[0];
  return root.id ? leaves(root, SW, 1, COLS - SW, ROWS - 1) : leaves(root, SW + 1, 2, COLS - SW - 2, ROWS - 3);
}
const prompt = (dir) => [[dir, PATH], [" $ ", A.hint]];
function shellRows(t, focused) {
  const rows = [...S.history];
  if (S.server) rows.push([...prompt("~/moonlander"), ["bun run dev", A.text]], [["$ vite", A.out]], [],
    [["  VITE", VITE], [" v7.1  ready in 212 ms", A.out]], [],
    [["  ➜  Local:   ", A.text], ["http://localhost:3000/", URL]], [["  ➜  press h + enter to show help", A.out]]);
  else rows.push([...prompt("~/moonlander"), [S.typed, A.text], [focused && Math.floor(t / 530) % 2 === 0 ? " " : "", CURSOR]]);
  return rows;
}
// Release notes, once its tag is allowed.
function tagRows(t, w) {
  const spin = SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length];
  return [
    [["> draft notes for 0.9 and tag it", A.user]], [],
    ...[["Bash", "git log --oneline v0.8..HEAD", "41 commits"], ["Write", "docs/notes/0.9.md", "Wrote 38 lines"], ["Bash", 'git tag -a v0.9 -m "corgi 0.9"', "Tagged v0.9"]]
      .flatMap(([verb, arg, out]) => [[["⏺ ", A.done], [verb, A.tool], [`(${arg})`, A.text]], [["  ⎿  " + out, A.out]]]), [],
    S.tagged ? [["⏺ ", A.text], ["Tagged and pushed v0.9.", A.text]] : [[spin + " Pushing the tag… ", ORANGE], [`(${Math.floor(3 + (t - S.approvedAt) / 1000)}s)`, A.hint]], [],
    ...claudeBottom(w)];
}
function paneRows(id, t, w, focused) {
  if (id === "sh") return shellRows(t, focused);
  if (id === "C2" && S.approvedAt != null) return tagRows(t, w);
  // keeps watch's sessions; its hidden band won't read this.
  W.compacting = false;
  // The shorter telling keeps watch wrote for phones reads at a glance.
  return closeBox(phoneRows(id, t, w), w);
}
function drawPane(g, l, t) {
  const focused = l.id === S.focus[S.ws], rows = paneRows(l.id, t, l.w - 2, focused);
  // A shell fills from the top; an agent's input sits at the bottom.
  const top = l.id === "sh" ? l.y + Math.min(0, l.h - rows.length) : l.y + l.h - rows.length;
  rows.forEach((row, n) => {
    const r = top + n;
    if (r < l.y || r >= l.y + l.h) return;
    const runs = row.runs ?? row;
    if (row.band) put(g, r, l.x, " ".repeat(l.w), faded(row.band, 0));
    let c = l.x + 1;
    for (const [text, s] of runs) c = put(g, r, c, ellipsis(text, l.x + l.w - 1 - c), faded(s, 0));
  });
}
function drawPanes(g, t) {
  for (let r = 0; r < ROWS; r++) put(g, r, SW, " ".repeat(COLS - SW), R.pane);
  const tabs = tabsOf(S.ws);
  let c = SW;
  tabs.forEach((_, i) => { c = put(g, 0, c, `    ${i + 1}     `, i === S.tab[S.ws] ? TAB_ON : TAB_OFF); });
  put(g, 0, c, " + ", TAB_ADD);
  const ls = layout();
  if (ls.length > 1) {
    // Every pane's outline; the focused one's in the accent.
    const on = new Map();
    for (const l of ls) for (let x = l.x - 1; x <= l.x + l.w; x++) for (let y = l.y - 1; y <= l.y + l.h; y++) {
      if (x !== l.x - 1 && x !== l.x + l.w && y !== l.y - 1 && y !== l.y + l.h) continue;
      const k = y * 1000 + x;
      on.set(k, on.get(k) || l.id === S.focus[S.ws]);
    }
    const GLYPH = { ud: "│", lr: "─", dr: "┌", dl: "┐", ur: "└", ul: "┘", udr: "├", udl: "┤", dlr: "┬", ulr: "┴", udlr: "┼" };
    for (const [k, hi] of on) {
      const y = Math.floor(k / 1000), x = k % 1000, has = (dx, dy) => on.has((y + dy) * 1000 + x + dx);
      const key = (has(0, -1) ? "u" : "") + (has(0, 1) ? "d" : "") + (has(-1, 0) ? "l" : "") + (has(1, 0) ? "r" : "");
      put(g, y, x, GLYPH[key] ?? "┼", hi ? EDGE_ON : EDGE);
    }
  }
  for (const l of ls) drawPane(g, l, t);
}

// ---- a frame
const sample = (t) => Math.floor(t / 1000) % RES_SAMPLES;
const resLeft = (ws) => Math.max(0, Math.min(SW, COLS - (RES_BOX[ws].right - RES_BOX[ws].left + 1) - 1));
function cardFor(ws, i) {
  const early = ws === "C" && i === COMPACTOR, read = ws === "C" && S.read.has(i) ? 1 : 0;
  return early ? [EARLY_CARD, EARLY_BOX] : [CARDS[ws][i][read], CARD_BOX[ws][i]];
}
function gitLabel(now) {
  if (S.git === "pushing") return { text: ` Pushing ${corgiAnimation.spinner(false, now)}`, fg: "accent" };
  if (S.git === "pushed") return { text: " Pushed ✓", fg: "accent" };
  if (S.git === "ahead" && S.gitHover) return { text: " Push ↑2", fg: "warm" };
  return null;
}
function hostGrid(t) {
  const g = blank(ROWS, COLS);
  const rows = [[...prompt("~/dev"), ["corgi", A.text]], [...prompt("~/dev"), [S.host.typed, A.text], [Math.floor(t / 530) % 2 === 0 ? " " : "", CURSOR]]];
  rows.forEach((runs, r) => { let c = 1; for (const [text, s] of runs) c = put(g, r, c, text, faded(s, 0)); });
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (g[r][c][1] === PLAIN) g[r][c] = [g[r][c][0], R.pane];
  return g;
}
function compose(t) {
  if (S.host) return hostGrid(t);
  const now = performance.now();
  if (S.git === "pushing" && now - S.gitAt > 1800) Object.assign(S, { git: "pushed", gitAt: now });
  if (S.git === "pushed" && now - S.gitAt > 1500) Object.assign(S, { git: "none", gitHover: false });
  const g = animate(sidebar(), t);
  // Resources sample once a second, as in keeps watch.
  for (const ws of ["C", "M"]) {
    const row = RES_ROW[ws], text = rowText(g, row), cpu = text.match(/\d+%/), mem = text.match(/\d[\d.]*[GM]\b/);
    if (cpu) put(g, row, cpu.index, RES_TOTALS[ws][sample(t)][0].padEnd(cpu[0].length));
    if (mem) put(g, row, mem.index, RES_TOTALS[ws][sample(t)][1].padEnd(mem[0].length));
  }
  // moonlander's link shows once its dev server is up, a letter at a time.
  const lc = linkCol(), shown = Math.min(LINK_TEXT.length, S.server ? Math.floor((now - S.linkAt) / 70) : 0);
  if (lc >= 0) for (let k = shown; k < LINK_TEXT.length; k++) g[LINK_ROW][lc + k] = [" ", style("muted", groundOf(g, LINK_ROW, lc - 1))];
  S.link = shown;
  // Release notes once allowed: working, then finished and unread.
  if (S.ws === "C" && S.approvedAt != null) {
    const [r0, r1] = [WATCH_ROWS[2], WATCH_ROWS[2] + 1], bg = groundOf(g, r0, 2);
    if (S.tagged) {
      put(g, r0, BAR + 1, "●", style("accent", bg, true)); put(g, r0, BAR + 4, "Release notes", style("strong", bg, true));
      put(g, r1, BAR + 1, "   ~ᐯ◡ᴥ◡ᐯ".padEnd(SW - 3 - BAR), style(bg === "selected" ? "muted" : "faint", bg));
    } else {
      put(g, r0, BAR + 1, "▶", style("accent", bg, true));
      put(g, r1, BAR + 1, `${corgiAnimation.spinner(false, t)}  Pushing the tag`.padEnd(SW - 3 - BAR), style("text", bg));
      put(g, r1, BAR + 1, corgiAnimation.spinner(false, t), style(bg === "selected" ? "muted" : "faint", bg));
    }
  }
  if (unread() > 1) { const text = rowText(g, 3), at = text.indexOf("1 unread"); if (at >= 0) put(g, 3, at, "2"); }
  const label = gitLabel(now);
  if (label) put(g, 2, SW - 2 - Array.from(label.text).length, label.text, style(label.fg, "selected", true));
  // The workspace not shown fades back until the pointer comes to it.
  const other = S.ws === "C" ? "M" : "C";
  if (S.wsHover !== other && S.res !== other) for (const r of WS_ROWS[other]) for (let c = 0; c < SW - 1; c++) {
    const [ch, s] = g[r][c], [fg, bg, bold, ul, ulc] = STYLES[s];
    if (fg) g[r][c] = [ch, style(mix(fg, "bg", 0.45), bg, bold, ul, ulc)];
  }
  if (S.res) for (let c = BAR + 1; c < SW - 2; c++) {
    const row = RES_ROW[S.res], [ch, s] = g[row][c], [fg, , bold, ul, ulc] = STYLES[s];
    g[row][c] = [ch, style(fg === "faint" || fg === "muted" ? "text" : fg, "selected", bold, ul, ulc)];
  }
  if (S.hover != null) for (const r of [WATCH_ROWS[S.hover], WATCH_ROWS[S.hover] + 1]) for (let c = BAR; c < SW - 2; c++) {
    const [ch, s] = g[r][c], [fg, bg, bold, ul, ulc] = STYLES[s];
    if (bg === "bg") g[r][c] = [ch, style(fg, HOVER_BG, bold, ul, ulc)];
  }
  drawPanes(g, t);
  if (S.linkHover) CHIP.forEach((cell, c) => (g[ROWS - 1][c] = cell));
  if (S.res) overlay(g, RES[S.res][sample(t)], RES_BOX[S.res], SW, resLeft(S.res));
  else if (S.card != null) { const [frame, box] = cardFor(S.ws, S.card); overlay(g, frame, box, SW, box.left); }
  else if (S.gitHover && S.git !== "none") overlay(g, F.git, GIT_BOX, SW, GIT_BOX.left);
  return g;
}

// ---- notes: a ring on each target, a small box, and wires between
const SVG = "http://www.w3.org/2000/svg";
const STEPS4 = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // right, down, left, up
const TURN = 5, CROSS = 6, GAP = 30;
const cellPx = () => {
  const term = simEl.getBoundingClientRect(), box = host.getBoundingClientRect();
  return { cw: term.width / COLS, rh: term.height / ROWS, x: term.left - box.left, y: term.top - box.top };
};
const NOTE = { spec: null, els: null, plan: null, frozen: null };
const el = (tag, cls, html = "") => Object.assign(document.createElement(tag), { className: cls, innerHTML: html });
function noteOn(spec) {
  noteOff(true);
  const box = el("div", "sim-box sim-in", `<b>${spec.title}</b>${spec.line ? `<span class="ln">${spec.line}</span>` : ""}`);
  const wire = document.createElementNS(SVG, "svg");
  wire.classList.add("sim-wire");
  // Everything the note isn't about darkens.
  const dim = document.createElementNS(SVG, "svg");
  dim.classList.add("sim-dim");
  NOTE.spec = spec; NOTE.plan = null; NOTE.frozen = null;
  NOTE.els = { box, wire, dim, rings: [] };
  layer.append(dim, wire, box);
}
function noteOff(now = false) {
  if (!NOTE.els) return;
  const nodes = [NOTE.els.box, NOTE.els.wire, NOTE.els.dim, ...NOTE.els.rings];
  NOTE.spec = NOTE.els = NOTE.plan = NOTE.frozen = null;
  if (now || still) return nodes.forEach((n) => n.remove());
  nodes.forEach((n) => n.classList?.add("sim-out") ?? (n.style.opacity = 0));
  setTimeout(() => nodes.forEach((n) => n.remove()), 260);
}
// Cells a wire may pass: blanks freely, a line only straight across it.
function kinds(g, blocked) {
  const n = ROWS * COLS, cost = new Float32Array(n).fill(Infinity), line = new Uint8Array(n), gap = new Uint8Array(n);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const ch = g[r][c][0], i = r * COLS + c;
    if (blocked(r, c)) continue;
    if (ch === " ") cost[i] = 0;
    else if (ch === "│") { cost[i] = CROSS; line[i] = 1; }
    else if (ch === "─") { cost[i] = CROSS; line[i] = 2; }
    gap[i] = ch === " " && c > 0 && c < COLS - 1 && /\S/.test(g[r][c - 1][0]) && /\S/.test(g[r][c + 1][0]) ? 1 : 0;
  }
  return { cost, line, gap };
}
// Cheapest wire from a target's edge to a cell beside the box.
function route(k, t, b) {
  const { cost, line, gap } = k, N = ROWS * COLS * 4, dist = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), heap = [];
  const push = (s, d) => { heap.push([d, s]); for (let i = heap.length - 1; i > 0;) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { const a = 2 * i + 1, c = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (c < heap.length && heap[c][0] < heap[m][0]) m = c; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  const crosses = (i, d) => !line[i] || (line[i] === 1 ? d % 2 === 0 : d % 2 === 1);
  const seed = (r, c, d) => {
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return;
    const i = r * COLS + c, s = i * 4 + d;
    if (cost[i] === Infinity || !crosses(i, d) || cost[i] >= dist[s]) return;
    dist[s] = cost[i]; push(s, cost[i]);
  };
  for (let r = t.r0; r <= t.r1; r++) { seed(r, t.c1 + 1, 0); seed(r, t.c0 - 1, 2); }
  for (let c = t.c0; c <= t.c1; c++) { seed(t.r0 - 1, c, 3); seed(t.r1 + 1, c, 1); }
  while (heap.length) {
    const [d, s] = pop();
    if (d > dist[s]) continue;
    const i = s >> 2, dir = s & 3, r = Math.floor(i / COLS), c = i % COLS;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (dir + 2) % 4 || (line[i] && nd !== dir)) continue;
      const nr = r + STEPS4[nd][0], nc = c + STEPS4[nd][1];
      if (nr < 0 || nc < 0 || nr >= ROWS || nc >= COLS) continue;
      const ni = nr * COLS + nc;
      if (cost[ni] === Infinity || !crosses(ni, nd)) continue;
      const d2 = d + 1 + cost[ni] + (nd === dir ? 0 : TURN) + (gap[ni] && nd % 2 ? GAP : 0), ns = ni * 4 + nd;
      if (d2 < dist[ns]) { dist[ns] = d2; prev[ns] = s; push(ns, d2); }
    }
  }
  // Into the box's side (cheaper) or its top or bottom.
  const ends = [];
  for (let r = b.r; r < b.r + b.h; r++) ends.push([r, b.c - 1, 0, 0], [r, b.c + b.w, 2, 0]);
  for (let c = b.c; c < b.c + b.w; c++) ends.push([b.r - 1, c, 1, 3], [b.r + b.h, c, 3, 3]);
  let best = null;
  for (const [r, c, into, extra] of ends) {
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) continue;
    const s = (r * COLS + c) * 4 + into;
    if (dist[s] === Infinity || (best && dist[s] + extra >= best.score)) continue;
    best = { score: dist[s] + extra, s, into };
  }
  if (!best) return null;
  const cells = [];
  for (let s = best.s; s >= 0; s = prev[s]) cells.push(s);
  cells.reverse();
  return { cells: cells.map((q) => ({ r: Math.floor((q >> 2) / COLS), c: (q >> 2) % COLS })), out: cells[0] & 3, into: best.into, t };
}
const overlaps = (a, b, m = 0) => a.r0 - m <= b.r1 && b.r0 - m <= a.r1 && a.c0 - m <= b.c1 && b.c0 - m <= a.c1;
// The box: near the middle of its region, over as little text as it can.
function placeBox(g, spec, w, h, targets) {
  const reg = spec.region ?? { r0: 2, r1: ROWS - 2, c0: SW + 2, c1: COLS - 3 };
  const mr = (reg.r0 + reg.r1 - h) / 2, mc = (reg.c0 + reg.c1 - w) / 2;
  let best = null;
  for (let r = reg.r0; r + h - 1 <= reg.r1; r++) for (let c = reg.c0; c + w - 1 <= reg.c1; c++) {
    const box = { r0: r, r1: r + h - 1, c0: c, c1: c + w - 1 };
    if (targets.some((t) => overlaps(box, t, 2))) continue;
    // Text under the box counts most; text right beside it, a little.
    let ink = 0;
    for (let rr = r - 1; rr <= r + h; rr++) for (let cc = c - 2; cc < c + w + 2; cc++) {
      if (g[rr]?.[cc] == null || g[rr][cc][0] === " ") continue;
      ink += rr >= r && rr < r + h && cc >= c && cc < c + w ? 1 : 0.25;
    }
    const score = 4 * ink + 1.5 * Math.abs(r - mr) + 0.4 * Math.abs(c - mc);
    if (!best || score < best.score) best = { r, c, w, h, score };
  }
  return best;
}
// Key caps carry a little padding each: a cell apiece.
const textWidth = (html) => Array.from(html.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "x")).length + (html.match(/class="k"/g) ?? []).length;
function plan(g) {
  const spec = NOTE.spec, targets = spec.targets?.(g).filter(Boolean) ?? [];
  const lines = spec.line ? 2 : 1, w = Math.max(textWidth(spec.title), spec.line ? textWidth(spec.line) : 0) + 4, h = lines + 1;
  const box = placeBox(g, spec, w, h, targets);
  if (!box) return null;
  const inBox = (r, c) => r >= box.r && r < box.r + box.h && c >= box.c && c < box.c + box.w;
  const wires = targets.map((t) => {
    const others = targets.filter((o) => o !== t);
    return route(kinds(g, (r, c) => inBox(r, c) || others.some((o) => r >= o.r0 - 1 && r <= o.r1 + 1 && c >= o.c0 - 1 && c <= o.c1 + 1) || (r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1)), t, box);
  });
  return { box, targets, wires, key: JSON.stringify(targets) };
}
function drawNote(g) {
  if (!NOTE.spec) return;
  const targets = NOTE.spec.targets?.(g).filter(Boolean) ?? [];
  if (!NOTE.plan || NOTE.plan.key !== JSON.stringify(targets)) NOTE.plan = plan(g);
  const p = NOTE.plan, e = NOTE.els;
  if (!p) return;
  const { cw, rh, x, y } = cellPx(), fs = getComputedStyle(simEl).fontSize;
  // Rings, one a target.
  while (e.rings.length < p.targets.length) { const ring = el("div", "sim-ring sim-in"); e.rings.push(ring); layer.append(ring); }
  const ringOf = (t) => ({ x: x + t.c0 * cw - 3, y: y + t.r0 * rh - 2, w: (t.c1 - t.c0 + 1) * cw + 6, h: (t.r1 - t.r0 + 1) * rh + 4 });
  p.targets.forEach((t, k) => { const q = ringOf(t); Object.assign(e.rings[k].style, { left: `${q.x}px`, top: `${q.y}px`, width: `${q.w}px`, height: `${q.h}px` }); });
  // The dim: the whole terminal, with a hole over each ring.
  const tw = COLS * cw, th = ROWS * rh;
  const holes = p.targets.map((t) => { const q = ringOf(t); return `<rect x="${q.x - x - 2}" y="${q.y - y - 2}" width="${q.w + 4}" height="${q.h + 4}" rx="5"/>`; }).join("");
  if (e.dim.dataset.holes !== holes + tw) {
    e.dim.dataset.holes = holes + tw;
    Object.assign(e.dim.style, { left: `${x}px`, top: `${y}px`, width: `${tw}px`, height: `${th}px` });
    e.dim.setAttribute("viewBox", `0 0 ${tw} ${th}`);
    e.dim.innerHTML = `<defs><mask id="sim-hole"><rect width="${tw}" height="${th}" fill="#fff"/><g fill="#000">${holes}</g></mask></defs><rect width="${tw}" height="${th}" mask="url(#sim-hole)"/>`;
  }
  const bx = x + p.box.c * cw, by = y + p.box.r * rh, bw = p.box.w * cw, bh = p.box.h * rh;
  Object.assign(e.box.style, { left: `${bx}px`, top: `${by}px`, width: `${bw}px`, height: `${bh}px`, fontSize: fs, padding: `0 ${2 * cw - 1}px` });
  // Wires through cell centers, turning only at right angles.
  const cx = (c) => x + (c + 0.5) * cw, cy = (r) => y + (r + 0.5) * rh;
  let d = "", dots = "", len = 0;
  p.wires.forEach((wv, k) => {
    if (!wv) return;
    const ring = ringOf(p.targets[k]), first = wv.cells[0], last = wv.cells[wv.cells.length - 1];
    const start = [[ring.x + ring.w + 1, cy(first.r)], [cx(first.c), ring.y + ring.h + 1], [ring.x - 1, cy(first.r)], [cx(first.c), ring.y - 1]][wv.out];
    const end = [[bx, cy(last.r)], [cx(last.c), by], [bx + bw, cy(last.r)], [cx(last.c), by + bh]][wv.into];
    const pts = [start, ...wv.cells.map((q) => [cx(q.c), cy(q.r)]), end].map(([px, py]) => [Math.round(px) + 0.5, Math.round(py) + 0.5]);
    const knees = pts.filter((pt, i) => i === 0 || i === pts.length - 1 || !((pt[0] === pts[i - 1][0] && pt[0] === pts[i + 1][0]) || (pt[1] === pts[i - 1][1] && pt[1] === pts[i + 1][1])));
    d += "M" + knees.map((pt) => pt.join(" ")).join(" L");
    for (let i = 1; i < knees.length; i++) len += Math.abs(knees[i][0] - knees[i - 1][0]) + Math.abs(knees[i][1] - knees[i - 1][1]);
    dots += `<circle r="2.5" cx="${knees[0][0]}" cy="${knees[0][1]}"/>`;
  });
  if (e.wire.dataset.d !== d) {
    e.wire.dataset.d = d;
    e.wire.innerHTML = `<path d="${d}"/>${dots}`;
    e.wire.style.setProperty("--len", Math.ceil(len + 4));
  }
}

// ---- finding things on screen
function find(g, text, { r0 = 0, r1 = ROWS - 1, c0 = 0, c1 = COLS - 1 } = {}) {
  for (let r = r0; r <= r1; r++) {
    const at = rowText(g, r).slice(c0, c1 + 1).indexOf(text);
    if (at >= 0) return { r0: r, r1: r, c0: c0 + at, c1: c0 + at + Array.from(text).length - 1 };
  }
  return null;
}
const paneRect = (id) => layout().find((l) => l.id === id);
const inPane = (id) => { const l = paneRect(id); return l && { r0: l.y, r1: l.y + l.h - 1, c0: l.x, c1: l.x + l.w - 1 }; };
const agentRows = (i) => ({ r0: WATCH_ROWS[i], r1: WATCH_ROWS[i] + 1, c0: 1, c1: SW - 3 });

// What the tour says at each stop: a title and one line that shows it.
const k = (s) => `<span class="k">${s}</span>`, ar = `<span class="ar"> → </span>`;
const NOTES = {
  panes: { title: "Panes and tabs", line: `${k("Ctrl-B v")} ${k("Ctrl-B -")} ${k("Ctrl-B c")}`, targets: (g) => [find(g, "    1     ", { r0: 0, r1: 0, c0: SW })] },
  systems: { title: "Find your systems", line: `<span class="c">bun run dev</span>${ar}<span class="lk">Game ↗</span>`, targets: (g) => [find(g, "bun run dev", inPane("sh") ?? {}), find(g, LINK_TEXT, { r0: LINK_ROW, r1: LINK_ROW })] },
  agents: { title: "Every agent, live", line: `<b>▶</b> working  <b style="color:var(--warm)">●</b> needs you  <b>●</b> done`, targets: () => [{ r0: AGENT_TOP, r1: WATCH_ROWS[4] + 1, c0: 1, c1: SW - 3 }] },
  needs: { title: "Needs you", line: "click, you're there", targets: (g) => [agentRows(2), find(g, "Do you want to proceed?", inPane("C2") ?? {})] },
  story: { title: "Every step, on hover", line: "phases · tokens · context", targets: (g) => { const at = find(g, "Recent"), box = CARD_BOX.C[0]; return [at && { r0: at.r0 + 1, r1: at.r0 + 5, c0: box.left + 3, c1: box.right - 3 }]; } },
  push: { title: "Unpushed work", line: `<span style="color:var(--warm)">↑2</span>${ar}Pushed ✓`, targets: (g) => [find(g, "Push ↑2", { r0: 2, r1: 2 })] },
  resources: { title: "CPU and memory", line: "per workspace, live", targets: () => [{ r0: RES_ROW.C, r1: RES_ROW.C, c0: 1, c1: SW - 3 }], region: { r0: 14, r1: ROWS - 2, c0: SW + 2, c1: COLS - 3 } },
  background: { title: "Runs in the background", line: `${k("Ctrl-B d")} close${ar}<span class="c">$ corgi</span> back`, targets: () => [], region: { r0: 4, r1: 18, c0: 30, c1: 94 } },
  back: { title: "While you were away", line: "finished, waiting for you", targets: (g) => [find(g, "unread →", { r0: 3, r1: 3 })], region: { r0: 6, r1: ROWS - 2, c0: SW + 2, c1: COLS - 3 } },
};

// ---- the pointer and the keys
const P = { r: 10, c: 60, shown: false };
function go(r, c) {
  Object.assign(P, { r, c });
  if (!P.shown && !still) { P.shown = true; pointer.classList.add("on"); pointer.classList.remove("locate"); void pointer.offsetWidth; pointer.classList.add("locate"); }
  placePointer();
}
function placePointer() {
  const { cw, rh } = cellPx();
  pointer.style.left = `${(P.c + 0.4) * cw}px`;
  pointer.style.top = `${(P.r + 0.5) * rh}px`;
}
const goTo = (t) => t && go(Math.round((t.r0 + t.r1) / 2), Math.round((t.c0 + t.c1) / 2));
function press(hand = true) {
  pointer.classList.toggle("over", hand);
  pointer.classList.add("press");
  setTimeout(() => pointer.classList.remove("press"), 140);
}
let keysTimer = 0;
function keys(...names) {
  keysEl.innerHTML = names.map((n) => `<kbd class="flash">${n}</kbd>`).join("");
  keysEl.classList.add("on");
  clearTimeout(keysTimer);
  keysTimer = setTimeout(() => keysEl.classList.remove("on"), 1300);
}
function type(text, per, into) {
  Array.from(text).forEach((ch, i) => tour.later(i * per, () => into(ch)));
}

// ---- the tour: stops, each a set-up and a few beats
const atSide = (g, text) => find(g, text, { c1: SW - 2 });
const now = () => performance.now();
const startServer = () => Object.assign(S, { server: true, linkAt: now() + 500, typed: "" });
const ready = () => { reset(); Object.assign(S, { server: true, linkAt: -1e9 }); };
const inC = () => { ready(); S.ws = "C"; };
const STOPS = [
  { name: "panes", ms: 6200, enter: () => { reset(); S.split = 1; }, beats: [
    [300, () => goTo(inPane("M0"))],
    [900, () => keys("Ctrl-B", "v")], [1150, () => Object.assign(S, { split: 2, focus: { ...S.focus, M: "M1" } })],
    [2000, () => keys("Ctrl-B", "-")], [2250, () => Object.assign(S, { split: 3, focus: { ...S.focus, M: "sh" } })],
    [2900, () => noteOn(NOTES.panes)], [5700, () => noteOff()]] },
  { name: "systems", ms: 9600, enter: () => { reset(); S.focus.M = "sh"; }, beats: [
    [200, () => { const l = paneRect("sh"); go(l.y + 1, l.x + 20); }],
    [700, () => press(false)],
    [1000, () => type("bun run dev", 70, (ch) => (S.typed += ch))],
    [1950, () => { keys("⏎"); startServer(); }],
    [2900, () => noteOn(NOTES.systems)], [6300, () => noteOff()],
    [6600, () => goTo(find(compose(0), LINK_TEXT, { r0: LINK_ROW, r1: LINK_ROW }))],
    [7200, () => { S.linkHover = true; pointer.classList.add("over"); }], [9000, () => (S.linkHover = false)]] },
  { name: "agents", ms: 5800, enter: () => { ready(); }, beats: [
    [200, () => go(WS_ROWS.C[0], 8)], [800, () => { press(); S.ws = "C"; }],
    [1300, () => noteOn(NOTES.agents)], [5000, () => noteOff()]] },
  { name: "needs you", ms: 7000, enter: inC, beats: [
    [200, () => go(WATCH_ROWS[2], 12)], [600, () => (S.hover = 2)],
    [1000, () => { press(); Object.assign(S, { hover: null, focus: { ...S.focus, C: "C2" } }); }],
    [1400, () => noteOn(NOTES.needs)], [4600, () => noteOff()],
    [5000, () => keys("1")], [5200, () => (S.approvedAt = now())]] },
  { name: "on hover", ms: 6000, enter: () => { inC(); S.approvedAt = now() - 4000; }, beats: [
    [200, () => go(WATCH_ROWS[0], 12)], [700, () => Object.assign(S, { hover: 0, card: 0 })],
    [1200, () => noteOn(NOTES.story)], [4500, () => noteOff()], [5100, () => Object.assign(S, { hover: null, card: null })]] },
  { name: "push", ms: 6400, enter: () => { inC(); S.approvedAt = now() - 8000; }, beats: [
    [200, () => go(2, SW - 4)], [700, () => (S.gitHover = true)],
    [1100, () => noteOn(NOTES.push)], [3800, () => noteOff()],
    [4100, () => { press(); Object.assign(S, { git: "pushing", gitAt: now() }); }]] },
  { name: "resources", ms: 5400, enter: () => { inC(); Object.assign(S, { approvedAt: now() - 12000, git: "none" }); }, beats: [
    [200, () => go(RES_ROW.C, 10)], [700, () => (S.res = "C")],
    [1100, () => noteOn(NOTES.resources)], [4300, () => noteOff()], [4800, () => (S.res = null)]] },
  { name: "background", ms: 10200, enter: () => { inC(); Object.assign(S, { approvedAt: now() - 15000, git: "none" }); }, beats: [
    [300, () => go(12, 80)], [600, () => keys("Ctrl-B", "d")], [850, () => (S.host = { typed: "" })],
    [1300, () => noteOn(NOTES.background)], [4600, () => noteOff()],
    [4900, () => type("corgi", 90, (ch) => S.host && (S.host.typed += ch))], [5500, () => keys("⏎")],
    [5700, () => Object.assign(S, { host: null, tagged: true })],
    [6300, () => { goTo(find(compose(0), "unread →", { r0: 3, r1: 3 })); noteOn(NOTES.back); }], [9600, () => noteOff()]] },
];

const tour = {
  i: 0, at: 0, beat: 0, pending: [], taken: false, resumeAt: 0,
  start(i) {
    this.i = i % STOPS.length; this.at = now(); this.beat = 0; this.pending = [];
    noteOff(true);
    STOPS[this.i].enter();
    pointer.classList.remove("over");
    markChapter();
  },
  later(ms, fn) { this.pending.push([now() + ms, fn]); },
  tick() {
    if (this.frozen) { this.pending.forEach(([, fn]) => fn()); this.pending = []; return; }
    if (this.taken) {
      if (!this.inside && now() >= this.resumeAt) { this.taken = false; simEl.classList.remove("taken"); P.shown = false; this.start(this.i + 1); }
      return;
    }
    const stop = STOPS[this.i], t = now() - this.at;
    while (this.beat < stop.beats.length && stop.beats[this.beat][0] <= t) stop.beats[this.beat++][1]();
    this.pending = this.pending.filter(([at, fn]) => (at <= now() ? (fn(), false) : true));
    chaptersEl.querySelectorAll("button")[this.i]?.style.setProperty("--p", `${Math.min(100, (100 * t) / stop.ms)}%`);
    if (t >= stop.ms) this.start(this.i + 1);
  },
};
// For checking a stop by hand: simFreeze(stop, ms) holds the tour there.
window.simFreeze = (i, ms) => { tour.frozen = false; tour.start(i); tour.at = now() - ms; tour.tick(); tour.frozen = true; };
window.simThaw = () => { tour.frozen = false; };
STOPS.forEach((stop, i) => {
  const b = chaptersEl.appendChild(document.createElement("li")).appendChild(document.createElement("button"));
  b.type = "button"; b.textContent = stop.name;
  b.addEventListener("click", () => { tour.taken = false; simEl.classList.remove("taken"); tour.start(i); });
});
function markChapter() {
  chaptersEl.querySelectorAll("button").forEach((b, k) => (k === tour.i ? b.setAttribute("aria-current", "step") : (b.removeAttribute("aria-current"), b.style.removeProperty("--p"))));
}

// ---- the visitor's own hands
const cellAt = (e) => { const b = simEl.getBoundingClientRect(); return { col: Math.floor((e.clientX - b.left) / (b.width / COLS)), row: Math.floor((e.clientY - b.top) / (b.height / ROWS)) }; };
const side = ({ col }) => col < SW - 1;
const agentAt = (at) => (side(at) ? WATCH_ROWS.slice(0, AGENTS[S.ws]).findIndex((y) => at.row === y || at.row === y + 1) : -1);
const linkAt = ({ row, col }) => { const lc = linkCol(); return row === LINK_ROW && S.link >= LINK_TEXT.length && col >= lc && col < lc + LINK_TEXT.length; };
const gitAt = ({ row, col }) => row === 2 && S.git === "ahead" && col >= SW - 2 - (S.gitHover ? 8 : 2) && col < SW - 2;
const resAt = (at) => (side(at) ? (at.row === RES_ROW.C ? "C" : at.row === RES_ROW.M ? "M" : null) : null);
const wsAt = (at) => (side(at) ? (WS_ROWS.C.includes(at.row) ? "C" : WS_ROWS.M.includes(at.row) ? "M" : null) : null);
const unreadAt = ({ row, col }) => { if (row !== 3 || col >= SW - 1) return false; const t = find(compose(0), "unread →", { r0: 3, r1: 3 }); return !!t && col >= t.c0 - 2 && col <= t.c1; };
const tabAt = ({ row, col }) => (row === 0 && col >= SW ? Math.floor((col - SW) / 10) : -1);
const paneAt = ({ row, col }) => layout().find((l) => row >= l.y - 1 && row <= l.y + l.h && col >= l.x - 1 && col <= l.x + l.w)?.id;
const within = ({ col, row }, box) => row >= box.top && row <= box.bottom && col >= box.left && col <= box.right;
function focusAgent(i) {
  const id = S.ws + i, tab = tabsOf(S.ws).findIndex((root) => leaves(root, 0, 0, 90, 20).some((l) => l.id === id));
  S.tab[S.ws] = Math.max(0, tab);
  S.focus[S.ws] = id;
  if (S.ws === "C") S.read.add(i);
}
// The visitor takes over by moving the pointer over the screen or clicking,
// not by a pointer that happens to rest where the page scrolled.
function takeOver() {
  if (tour.taken) return;
  Object.assign(tour, { taken: true, inside: true });
  simEl.classList.add("taken");
  noteOff();
  keysEl.classList.remove("on");
}
simEl.addEventListener("mouseenter", () => { tour.inside = true; });
simEl.addEventListener("mouseleave", () => {
  tour.inside = false; tour.resumeAt = now() + 4000;
  Object.assign(S, { hover: null, card: null, res: null, wsHover: null, linkHover: false, gitHover: false });
});
simEl.addEventListener("mousemove", (e) => {
  if (!tour.taken && !e.movementX && !e.movementY) return;
  takeOver();
  if (S.host) return;
  const at = cellAt(e), i = agentAt(at);
  S.wsHover = wsAt(at);
  if (S.res && within(at, { ...RES_BOX[S.res], left: resLeft(S.res), right: resLeft(S.res) + RES_BOX[S.res].right - RES_BOX[S.res].left }) && !resAt(at)) return;
  S.linkHover = linkAt(at);
  S.res = S.linkHover ? null : resAt(at);
  S.gitHover = gitAt(at) || (S.gitHover && S.git !== "none" && within(at, GIT_BOX));
  const card = S.card == null ? null : cardFor(S.ws, S.card)[1];
  if (card && within(at, card)) return;
  S.hover = !S.linkHover && !S.res && i >= 0 ? i : null;
  S.card = S.hover;
  simEl.style.cursor = S.linkHover || S.res || i >= 0 || gitAt(at) || wsAt(at) || tabAt(at) >= 0 || unreadAt(at) ? "pointer" : "";
});
simEl.addEventListener("click", (e) => {
  takeOver();
  const at = cellAt(e);
  simEl.focus({ preventScroll: true });
  if (S.host) return;
  if (linkAt(at) || S.res) return;
  if (gitAt(at)) return Object.assign(S, { git: "pushing", gitAt: now() });
  if (unreadAt(at)) { if (S.ws !== "C") S.ws = "C"; focusAgent(S.tagged && !S.read.has(2) ? 2 : 4); return Object.assign(S, { card: null }); }
  const i = agentAt(at);
  if (i >= 0) { focusAgent(i); return Object.assign(S, { card: null, hover: null }); }
  const ws = wsAt(at);
  if (ws) return Object.assign(S, { ws, hover: null, card: null });
  const tab = tabAt(at), tabs = tabsOf(S.ws).length;
  if (tab >= 0 && tab < tabs) { S.tab[S.ws] = tab; S.focus[S.ws] = layout()[0].id; return; }
  const id = paneAt(at);
  if (id) S.focus[S.ws] = id;
});
// Typing reaches the shell when it has focus: `bun run dev` starts the server.
simEl.addEventListener("keydown", (e) => {
  if (S.host || S.focus[S.ws] !== "sh" || S.ws !== "M" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Enter") {
    const cmd = S.typed.trim();
    if (cmd === "bun run dev" && !S.server) startServer();
    else if (!S.server) { S.history.push([...prompt("~/moonlander"), [S.typed, A.text]]); if (cmd) S.history.push([[cmd === "clear" ? "" : `zsh: try bun run dev`, A.out]]); if (cmd === "clear") S.history = []; S.typed = ""; }
  } else if (e.key === "Backspace") S.typed = S.typed.slice(0, -1);
  else if (e.key.length === 1 && !S.server) S.typed += e.key;
  else return;
  e.preventDefault();
});

// ---- fit and run
const band = host.closest(".band");
let seen = false, last = now();
function fit() {
  const room = band.clientWidth - 26;
  const fs = Math.min(14, Math.max(5, room / (COLS * 0.6)));
  simEl.style.setProperty("--fs", `${fs}px`);
  if (NOTE.plan) NOTE.plan = null;
}
new ResizeObserver(() => requestAnimationFrame(fit)).observe(band);
document.fonts?.ready.then(fit);
new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; }).observe(simEl);
fit();
tour.start(0);
function run() {
  const t = now(), dt = t - last;
  last = t;
  // Off screen, the tour waits where it is.
  if (!seen) { tour.at += dt; tour.pending.forEach((p) => (p[0] += dt)); return; }
  simEl.classList.toggle("detached", !!S.host);
  {
    tour.tick();
    // A note pauses the session: the screen holds the frame it opened on.
    const g = NOTE.spec && !tour.taken ? (NOTE.frozen ??= compose(t)) : compose(t);
    screen.paint(g);
    drawNote(g);
    placePointer();
  }
}
run();
setInterval(run, 50);
})();

