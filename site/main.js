// Frames drawn by corgi's own renderer (src/render.ts), written by
// tools/site_frames.ts as [text, style] runs per row; styles are
// [fg, bg, bold, underline, underline color]. The corgis and spinners over
// them move by corgi's own animation code.
import "./browser/process";
import "./browser/buffer";
import "./language";
import * as i18n from "./i18n";
import * as textWidth from "../src/text";
import * as cellGrid from "./cells";
import * as heroConfig from "./hero_config";
import * as resourceSamples from "./resource_samples";
import DATA from "./frames.json";
import * as terminal from "./terminal";
import * as corgiAnimation from "../src/corgi_animation";
import * as corgiFrames from "../src/corgi_frames";
import * as corgiBadge from "../src/assets/corgi_badge";
import * as palette from "../src/palette";
import * as panel from "../src/review/panel";
import * as resourceTooltip from "../src/resource_tooltip";
import * as shortcutHelp from "../src/shortcut_help";
import * as worktreeTooltip from "../src/worktree_tooltip";
import * as worktreeRemoval from "../src/worktree_removal";
import * as worktrees from "../src/worktrees";
import * as bindings from "../src/bindings";
import { TabMenu } from "../src/commands";
import * as linkTooltip from "../src/link_tooltip";
import * as processName from "../src/process_name";
import * as tabIcons from "../src/tab_icons";
import * as brandIcons from "../src/assets/brand_icons";
import { Rect } from "../src/layout";
import { Writer } from "../src/text";
import { cpuText, memoryText } from "../src/trackers/resources";
import CLI_HELP from "../assets/cli-help.txt" with { type: "text" };
import CLI_SKILL from "../assets/corgi-skill.md" with { type: "text" };

const helpText = i18n.html(CLI_HELP);
const WAG = corgiFrames.wag;
const BADGE = `data:image/png;base64,${corgiBadge.png_base64}`;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GAME_LABEL = i18n.t`Game` + " ↗", GAME_URL = "http://localhost:3000/";
const GAME_TARGETS = [GAME_LABEL, GAME_URL, GAME_URL.slice(0, -1)].map((text) => cellGrid.decode([[text, 0]]).map(([ch]) => ch));

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
// Blocks run a pixel past the cell's edges, so neighbors meet without a seam.
const SHADES = { "░": 25, "▒": 50, "▓": 75 };
// A tab's brand mark over its two cells, each a private-use character showing
// its half, as corgi places it: a fifth of the two cells' box smaller, from
// the first's left edge, centered down the row.
const MARKS = new Map();
function markCells(brand) {
  const cells = [0, 1].map((half) => String.fromCharCode(0xe000 + 2 * processName.brands.indexOf(brand) + half));
  if (!MARKS.has(cells[0])) {
    const [x, y, w, h] = brandIcons.art[brand].view, paths = tabIcons.fill(brand).layers.map((l) => `<path fill="rgb(${l.rgb})" d="${l.d}"/>`).join("");
    const img = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">${paths}</svg>`)}")`;
    cells.forEach((ch, half) => MARKS.set(ch, { img, size: "calc(1.6 * var(--cell)) calc(1.6 * var(--cell))", pos: `calc(${-half} * var(--cell)) calc((1.42em - 1.6 * var(--cell)) / 2)` }));
  }
  return cells;
}
function shape(ch) {
  if (MARKS.has(ch)) return MARKS.get(ch);
  if (ch === "▌" || ch === "▐") return { img: G, size: "calc(50% + 1px) calc(100% + 2px)", pos: ch === "▌" ? "-1px center" : "calc(100% + 1px) center" };
  // Shades fill the cell with their share of the color, as Ghostty draws them.
  if (SHADES[ch]) { const c = `color-mix(in srgb, currentColor ${SHADES[ch]}%, transparent)`; return { img: `linear-gradient(${c}, ${c})`, size: "calc(100% + 2px) calc(100% + 2px)", pos: "center" }; }
  const cp = ch.codePointAt(0);
  // Lower eighths, ▁ through █, fill from the cell's bottom edge.
  if (cp === 0x2588) return { img: G, size: "calc(100% + 2px) calc(100% + 2px)", pos: "center" };
  if (cp >= 0x2581 && cp < 0x2588) return { img: G, size: `calc(100% + 2px) calc(${(cp - 0x2580) * 12.5}% + 1px)`, pos: "center calc(100% + 1px)" };
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
const cellsOf = (frame) => frame.map(cellGrid.decode);
// A list of frames nests one level deeper than a frame.
const F = Object.fromEntries(Object.entries(DATA.frames).map(([k, v]) => [k, Array.isArray(v[0][0][0]) ? v.map(cellsOf) : cellsOf(v)]));
const copy = (g) => g.map((r) => r.slice());
// Where corgi's sidebar puts its focus bar (content starts a column later)
// and its badge, read from a recorded sidebar.
const BAR = F.w34_C00.map((row) => row.findIndex(([ch]) => ch === "▌")).find((c) => c >= 0);
const BADGE_X = DATA.layout.badge;
const crop = (g, r0, c0, rows, cols) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => g[r0 + r]?.[c0 + c] ?? [" ", PLAIN]));
// The sidebar without the header's [ + ] and < buttons or the workspaces'
// tool-call counts.
function tidySidebar(g) {
  const width = g[0].findIndex(([ch]) => ch === "│") + 1;
  if (width > 0) {
    const style = g[0][5][1];
    put(g, 0, 5, " ".repeat(width - 6), style);
    put(g, 0, 5, textWidth.ellipsis(i18n.t`workspaces`, width - 7), style);
  }
  for (const row of g) {
    const start = row.findIndex(([ch]) => ch === "⚒");
    if (start < 0) continue;
    let end = start + 1;
    while (/^\d$/.test(row[end]?.[0] ?? "")) end++;
    for (let column = start; column < end; column++) row[column] = [" ", row[column][1]];
  }
  return g;
}

const blank = (rows, cols) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => [" ", PLAIN]));
// The style `s` would give, keeping the cell's underline (agent separators).
const keepRule = (s, cell) => { const [fg, bg, bold] = STYLES[s], [, , , ul, ulc] = STYLES[cell[1]]; return ul ? style(fg, bg, bold, ul, ulc) : s; };
function put(g, r, c, text, s) {
  return cellGrid.put(g[r], c, text, s);
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
    this.spans = []; this.keys = []; this.rowEls = []; this.links = [];
    this.initial = [...el.querySelectorAll(":scope > .hero-initial")];
    for (let r = 0; r < rows; r++) {
      const row = el.appendChild(document.createElement("div"));
      row.className = "r";
      row.hidden = this.initial.length > 0;
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
      img.className = "badge"; img.src = BADGE; img.alt = ""; img.style.left = `calc(${BADGE_X} * var(--cell))`;
      img.hidden = this.initial.length > 0;
      this.badge = img;
    }
  }
  /// Show only the first `n` rows.
  rows(n) {
    if (this.shown === n) return;
    this.shown = n;
    this.rowEls.forEach((row, i) => (row.hidden = i >= n));
  }
  paint(g) {
    this.spans.forEach((row, r) => {
      let changed = false;
      row.forEach((span, c) => {
        const [ch, s] = g[r]?.[c] ? cellGrid.visible(g[r], c, row.length) : [" ", PLAIN];
        const key = ch + "\u0000" + s;
        if (this.keys[r][c] === key) return;
        changed = true;
        this.keys[r][c] = key;
        const L = look(s), box = shape(ch);
        span.className = L.cls + (span.dataset.p ? " p" : "");
        span.textContent = box ? " " : ch;
        span.classList.toggle("wide", textWidth.displayWidth(ch) === 2);
        span.classList.toggle("continuation", ch === "");
        span.style.color = L.color;
        span.style.backgroundColor = L.bg;
        span.style.setProperty("--ulc", L.ulc);
        span.style.backgroundImage = box ? box.img : "";
        span.style.backgroundSize = box ? box.size : "";
        span.style.backgroundPosition = box ? box.pos : "";
      });
      if (changed) this.gameLinks(g[r] ?? [], r);
    });
    if (this.initial.length) {
      this.initial.forEach((frame) => frame.remove());
      this.initial = [];
      this.rowEls.forEach((row, r) => row.hidden = this.shown != null && r >= this.shown);
      if (this.badge) this.badge.hidden = false;
    }
  }
  // Links follow the cells that survived cropping and popovers.
  gameLinks(cells, r) {
    const spans = [];
    for (let c = 0; c < this.spans[r].length; c++) {
      const text = GAME_TARGETS.find((text) => c + text.length <= this.spans[r].length && text.every((ch, i) => cells[c + i]?.[0] === ch));
      if (text) spans.push([c, text.length]);
    }
    const key = JSON.stringify(spans);
    if (this.links[r]?.key === key) return;
    this.links[r]?.anchors.forEach((a) => a.remove());
    const anchors = spans.map(([col, width]) => {
      const a = document.createElement("a");
      a.className = "game-link"; a.href = `/${i18n.language()}/moonlander`; a.target = "_blank"; a.rel = "noopener";
      a.title = GAME_URL; a.setAttribute("aria-label", i18n.t`Play Moonlander (opens in a new tab)`);
      Object.assign(a.style, { left: `calc(${col} * var(--cell))`, width: `calc(${width} * var(--cell))` });
      a.addEventListener("click", (e) => e.stopPropagation());
      a.addEventListener("keydown", (e) => e.stopPropagation());
      return this.rowEls[r].appendChild(a);
    });
    this.links[r] = { key, anchors };
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
  ["claude", i18n.t`Fix sidebar flicker`, "the sidebar flickers when an agent finishes", "`drawAgent` cleared each row, then wrote it again. It now writes once.", "commit it", "Committed `4f2c1d9` sidebar: draw each row in one write", 12 * 60, 0, ["Read", "src/sidebar.zig", "Read 2104 lines"]],
  ["claude", i18n.t`Name dev server links`, "links just say Open Link", "Links now take the server's own name.", "use the page title when there is one", "Done. The title wins when the page has one.", 50 * 60, 0, ["Search", "\"Open Link\"", "Found 3 files"]],
  ["claude", i18n.t`Slow down the herd animation`, "the compacting herd feels rushed", "Each herd step now takes `110 ms`.", "slower, the letters blur", "Slowed `herd_step_ms` to `140`.", 2 * HOUR, 0, ["Read", "src/corgi_animation.zig", "Read 1038 lines"]],
  ["codex", i18n.t`Static Linux build`, "build a static linux binary", "Built with the musl target.", "strip it before upload", "Stripped: 18 MB down to 7 MB.", 5 * HOUR, 0, ["Ran", "zig build -Dtarget=x86_64-linux-musl", "Build Summary: 5/5 steps succeeded"]],
  ["claude", i18n.t`Ghostty keybindings`, "bind cmd+1-9 to tabs", "`Cmd+1–9` now switch tabs.", "does Cmd+W close the whole tab?", "Yes: `Cmd+W` closes the tab with every pane in it.", 2 * HOUR, 1, ["Read", "src/ghostty_integration.zig", "Read 412 lines"]],
  ["claude", i18n.t`Faster session restore`, "restore takes two seconds", "Restore now reads the checkpoint once.", "measure it again after the cache", "Down to 180 ms.", 4 * HOUR, 1, ["Bash", "hyperfine 'corgi checkpoint restore'", "Time (mean ± σ):  1.94 s ±  0.05 s"]],
  ["claude", i18n.t`Usage bars in the picker`, "show usage next to each agent", "Each agent row now has its limits.", "show when it resets", "Added the reset time after each bar.", 6 * HOUR, 1, ["Read", "src/launcher_usage.zig", "Read 233 lines"]],
  ["claude", i18n.t`Date resume rows by reply`, "resume dates look wrong", "Rows were dated by file time.", "date by the last reply instead", "Done. Rows now date by the last reply.", 9 * HOUR, 1, ["Search", "updated_at", "Found 6 files"]],
  ["codex", i18n.t`Onboarding copy`, "rewrite the onboarding text", "Rewrote each step in one line.", "fewer words", "Halved it.", 12 * HOUR, 1, ["Ran", "wc -w docs/onboarding.md", "1840 docs/onboarding.md"]],
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
const ellipsis = textWidth.ellipsis;
function ageLabel(s) {
  for (const [below, size, name] of [[HOUR, 60, "m"], [DAY, HOUR, "h"], [14 * DAY, DAY, "d"], [60 * DAY, 7 * DAY, "w"], [Infinity, 30 * DAY, "mo"]])
    if (s < below) return Math.max(1, Math.floor(s / size)) + name;
}
const dayStart = (s) => { const d = new Date(s * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
function dayLabel(s) {
  const days = Math.floor((dayStart(NOW) - dayStart(s) + 43200) / DAY);
  if (days <= 0) return i18n.t`Today`;
  if (days === 1) return i18n.t`Yesterday`;
  return new Date(s * 1000).toLocaleDateString(i18n.language(), days < 7 ? { weekday: "long" } : { month: "long", day: "numeric" });
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
const searchCount = count => { const scope = i18n.t`this workspace`; return i18n.t`${count} in ${scope}`; };
const searchLabel = count => i18n.t` Search ${count} agents`;
function drawLine(g, line, selected, isNamed, row, cols) {
  const x = POP.x, width = POP.width, base = selected ? R.selected : R.row;
  if (line.kind === "day") {
    const text = dayLabel(line.at);
    const c = put(g, row, x + 3, text + " ", R.panel);
    put(g, row, c, "─".repeat(Math.max(0, width - (6 + textWidth.displayWidth(text)))), R.rule);
    return;
  }
  if (line.kind === "heading") { put(g, row, x + 3, searchCount(line.n), R.heading); return; }
  put(g, row, x + 1, " ".repeat(width - 3), base);
  put(g, row, x + 1, selected ? "›" : " ", base);
  if (line.kind === "more") {
    put(g, row, x + 3, " / ", R.key);
    put(g, row, x + 6, searchLabel(line.n), ink(selected ? "muted" : "faint", selected));
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
function noYolo(g) {
  const row = g.length - 2, style = g[row][1][1];
  put(g, row, 1, " ".repeat(g[row].length - 2), style);
  put(g, row, 2, i18n.t`new tab`, style);
  const hint = i18n.t`↑↓ browse · Enter open · / search · Esc close`;
  put(g, row, Math.max(18, g[row].length - textWidth.displayWidth(hint) - 2), hint, style);
  return g;
}
// Rows: Codex, Claude Code, Pi on the company's account, New terminal.
// Every mode is the same height, so the page never moves.
const PICK_AGENTS = 4, PICK_HEIGHT = 18, FIELD_ROW = 7;
// What each agent row starts.
const PICK_PROVIDERS = ["codex", "claude", "pi"];
const PICK = Array.from({ length: PICK_AGENTS }, (_, i) => noYolo(crop(F["launcher" + i], POP_AT.top, POP_AT.left, PICK_HEIGHT, POP.width)));
const PICK_LIST = crop(F.search3, POP_AT.top, POP_AT.left, PICK_HEIGHT, POP.width);
// No scope switching here: the search line and the footer lose "tab".
function noScope(g) {
  for (let c = 7; c < POP.width - 2; c++) g[FIELD_ROW][c] = [" ", g[FIELD_ROW][1][1]];
  return g;
}
// corgi's search frame lists ten rows; keep the first seven, then its footer.
const shortList = (g) => [...g.slice(0, LIST.top + LIST.height), ...g.slice(-2)];
const PICK_SEARCH = [F.search0, F.search1].map((f) => noYolo(noScope(shortList(crop(f, 0, POP_AT.left, f.length, POP.width)))));
const AGENT_ROWS = 2, ENTRY_ROWS = 8, MORE_ROW = 14;

const L = { mode: "agents", agent: 1, key: 0, query: "", scroll: 0, opened: null, back: "agents", phone: false };
const launcherEl = document.getElementById("v-launcher");
launcherEl.style.setProperty("--cols", POP.width);
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
  if (rows.length <= 1) put(g, LIST.top + rows.length, POP.x + 12, i18n.t`No matches.`, R.panel);
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
  } else if (provider === "pi") {
    // Pi's editor between its two rules, then the folder and its status line.
    rows.push([["─".repeat(width), PI.rule]], [], [["─".repeat(width), PI.rule]], [["~/dev/corgi", PI.dim]]);
    const status = "$0.000 (sub) 0.0%/400k (auto)", model = "(openai-codex) gpt-6-astra • high";
    rows.push([[status + " ".repeat(Math.max(1, width - status.length - model.length)) + model, PI.dim]]);
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
// Pi's purple rules and gray lines, as it draws them.
const PI = { rule: style("#9776e5"), dim: style("#7e888e") };
// The caret: inside Claude Code's box or Pi's editor, or over the first
// letter of Codex's hint.
function caret(g, provider, rows, top) {
  if (provider === "claude") return put(g, top + rows.length - 3, 3, " ", A.cursor);
  if (provider === "pi") return put(g, top + rows.length - 4, 1, " ", A.cursor);
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
  if (L.mode === "agents") return L.agent === PICK_AGENTS - 1 ? openItem("terminal") : openItem("agent", PICK_PROVIDERS[L.agent]);
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
// The keycaps, as corgi reads them: a digit or t opens its row, a the
// selected agent, j and k move.
function keycap(key) {
  const row = key === "t" ? PICK_AGENTS - 1 : /^\d$/.test(key) && Number(key) < PICK_AGENTS - 1 ? Number(key) : null;
  if (row !== null) { Object.assign(L, { mode: "agents", agent: row }); openSelected(); }
  else if (key === "a" && L.mode === "agents") openSelected();
  else if (key === "j" || key === "k") move(key === "j" ? 1 : -1);
  else return false;
  return true;
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
  else if (L.mode !== "search" && !e.metaKey && !e.ctrlKey && !e.altKey && keycap(e.key)) e.preventDefault();
});
// Hovering a stage hands it the keyboard; leaving hands it back, unless a
// click took it up.
function lendKeys(stage) {
  let lent = null;
  stage.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse" || stage.contains(document.activeElement)) return;
    lent = document.activeElement;
    stage.focus({ preventScroll: true });
  });
  stage.addEventListener("pointerdown", () => (lent = null));
  stage.addEventListener("pointerleave", () => {
    if (lent && document.activeElement === stage) { stage.blur(); lent.focus?.({ preventScroll: true }); }
    lent = null;
  });
}
lendKeys(launcherStage);
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.target === queryInput || e.metaKey || e.ctrlKey || L.mode === "search" || L.mode === "opened" || !visible.has(launcherStage)) return;
  e.preventDefault();
  startSearch();
  redraw();
});
queryInput.addEventListener("input", () => { L.query = queryInput.value; L.key = null; L.scroll = 0; redraw(); });
// Ctrl-T is the picker's own key: bring it up and flash what it would open.
let flashAt = -Infinity;
const ctrlKey = document.getElementById("ctrl-t");
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
const PS = {
  border: style("line", "surface"), title: style("strong", "surface", true), key: R.key,
  mark: R.selected, text: R.row, text_sel: R.selected, label: R.panel,
  label_sel: style("muted", "selected"), pct: R.row, pct_sel: R.selected,
  muted: R.panel, muted_sel: style("muted", "selected"), foot: R.panel,
  scope_in: R.panel, scope: R.row,
};
// [row, account, name, model, [label, use (%)] for each of the two figures,
// or null where unknown], under their accounts.
const PHONE_AGENTS = [
  [0, "you@example.com", "Codex", "GPT-6 Astra", [null, ["7d", 18]]],
  [1, "you@example.com", "Claude Code", "Opus 5.5", [["5h", 23], ["7d", 41]]],
  [2, "you@slopcorp.ai", "Pi", "GPT-6 Astra", [["5h", 12], ["7d", 33]]],
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
  put(g, 0, put(g, 0, 2, i18n.t` New agent  in  `, PS.title), "corgi ", PS.scope);
  let r = 1, account = null;
  PHONE_AGENTS.forEach(([i, acct, name, model, use]) => {
    if (acct !== account) phoneHeader(g, r++, (account = acct));
    const sel = L.mode === "agents" && L.agent === i, k = sel ? "_sel" : "";
    phoneRow(g, r, sel);
    put(g, r, 3, ` ${i} `, PS.key);
    put(g, r, NAME, name, PS["text" + k]);
    put(g, r, MODEL, model, PS["muted" + k]);
    use.forEach((figure, n) => {
      if (!figure) return;
      const at = FIG - 12 + 7 * n;
      put(g, r, put(g, r, at, figure[0] + " ", PS["label" + k]), `${figure[1]}%`.padStart(3), PS["pct" + k]);
    });
    PMAP[r++] = { agent: i };
  });
  const term = PICK_AGENTS - 1, sel = L.mode === "agents" && L.agent === term;
  phoneRow(g, r, sel);
  put(g, r, 3, " t ", PS.key);
  put(g, r, NAME, i18n.t`New terminal`, sel ? PS.text_sel : PS.text);
  PMAP[r++] = { agent: term };
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
    if (line.kind === "heading") { phoneRow(g, r); put(g, r++, 3, searchCount(line.n), R.heading); return; }
    if (line.kind === "more") {
      phoneRow(g, r, k === sel);
      put(g, r, 3, " / ", R.key);
      put(g, r, 6, searchLabel(line.n), ink(k === sel ? "muted" : "faint", k === sel));
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
  put(g, PROWS - 2, 2, i18n.t`new tab`, PS.foot);
  // Key hints end two cells in from the border, as corgi's footer does.
  let c = PW - 2 - keys.reduce((n, [k, label]) => n + k.length + 2 + textWidth.displayWidth(label) + 1, 0);
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
  if (rows.length <= 1) { phoneRow(g, end); put(g, end, NAME, i18n.t`No matches.`, R.panel); }
  phoneFoot(g, Math.max(end, rows.length <= 1 ? end + 1 : end), [["↵", i18n.t`resume`]]);
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
// Below 600 pixels the picker takes the phone's layout; the stylesheet swaps
// the screens. Each resize waits a frame, so the layout it changes doesn't
// loop back into the observer.
new ResizeObserver(() => requestAnimationFrame(() => {
  const phone = launcherStage.closest(".band").clientWidth < 600;
  if (phone === L.phone) return;
  L.phone = phone;
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
// Each workspace's resource card, drawn by corgi's own code from the second
// of resource_samples.ts's loop the page is on, on keeps watch's laptop or
// the GPU host; the sidebar's figures follow the same seconds.
const RES_ROW = { C: WS_ROWS.C[2], M: WS_ROWS.M[2] };
const RES_WS = { C: [1, "corgi"], M: [2, "moonlander"] };
const resSnapshot = (host, t) => resourceSamples.snapshot(host, Math.floor(t / 1000));
const resWork = (snapshot, ws) => snapshot.workspaces.find((w) => w.id === RES_WS[ws][0]);
const resGpus = (host) => resourceTooltip.gpuCount(resourceSamples.snapshot(host, 0));
// A workspace's figures as its sidebar row prints them: CPU, memory, and GPU
// while it uses one.
function resTotals(host, ws, t) {
  const w = resWork(resSnapshot(host, t), ws);
  return [cpuText(w.cpu), memoryText(w.memory), w.gpu_shown ? cpuText(w.gpu) : ""];
}
// Puts them where the recording printed its own: the first percentage is
// CPU's, the size memory's, and a second percentage GPU's.
function putTotals(g, row, [cpu, memory, gpu]) {
  const text = g[row].map(([ch]) => ch).join(""), rates = [...text.matchAll(/\d+%/g)], size = text.match(/\d[\d.]*[GM]\b/);
  const field = (match, value) => {
    if (match) put(g, row, textWidth.displayWidth(text.slice(0, match.index)), value.padEnd(match[0].length));
  };
  field(rates[0], cpu);
  field(size, memory);
  field(rates[1], gpu);
}
// The card in `rect` at time t, its rows in `state`'s order, which holds
// while `held`, as corgi holds it under the pointer. A pointer on its
// history shows that moment's figures and leaders.
const RES_CELLS = new Map();
function resCells(host, ws, t, state, rect, held, pointer = null) {
  const snapshot = resSnapshot(host, t), gpus = resourceTooltip.gpuCount(snapshot), local = new Rect(0, 0, rect.w, rect.h);
  state.update(resWork(snapshot, ws), held, gpus);
  const at = pointer && { x: pointer.col - rect.x, y: pointer.row - rect.y }, hover = at && resourceTooltip.hoverAt(local, gpus, at.x, at.y);
  const key = [host, ws, Math.floor(t / 1000) % resourceSamples.loop_s, rect.w, rect.h, state.sort, state.ascending, state.order.map((k) => k.pid), hover?.metric, hover?.age, hover?.line].join(":");
  if (!RES_CELLS.has(key)) {
    const out = new Writer();
    resourceTooltip.draw(out, local, RES_WS[ws][1], snapshot, state, at);
    RES_CELLS.set(key, terminal.grid(out.buffered(), rect.w, rect.h).map((row) => row.map(([ch, ...look]) => [ch, style(...look)])));
    // Seconds go by: only the latest few cards stay.
    if (RES_CELLS.size > 16) RES_CELLS.delete(RES_CELLS.keys().next().value);
  }
  return RES_CELLS.get(key);
}
const paste = (g, cells, rect) => cells.forEach((row, r) => row.forEach((cell, c) => (g[rect.y + r][rect.x + c] = cell)));
// corgi places the card at the sidebar's edge, inside the window.
const watchRes = new resourceTooltip.State();
const resRect = (ws) => resourceTooltip.geometry(W.cols, WATCH_ROWS_N, W.width, RES_ROW[ws]);
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
      ...codexBottom(i18n.t`Audit the install script`)];
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
      ...codexBottom(i18n.t`Ghostty keybindings`)];
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
// The thruster tuning, asked how the game looks now, saves a screenshot
// and goes on tuning, as the sidebar says.
const SHOT = { text: "shots/descent.png", uri: "file:///Users/me/dev/moonlander/.claude/worktrees/thrusters/shots/descent.png" };
const shotRows = (t, w) => [
  ...ask("fix the bounce"),
  ...tool("Update", "physics.ts", "2 lines fixed"),
  ...say("Fixed: it lands softly now."), [],
  ...ask("show me the descent"), [],
  ...tool("Bash", "bun run shot --at descent", "Wrote 1 screenshot"),
  ...say(`It drifts down past the moon: ${SHOT.text}`), [],
  [[SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length] + " Tuning lunar gravity… ", ORANGE], [`(${41 + Math.floor(t / 1000)}s)`, A.hint]],
  ...claudeBottom(w)];
// The thruster tuning, asked for a pull request, opens one and goes on
// tuning; its link sits over blank rows the card opens onto.
const PR = { text: "https://github.com/you/moonlander/pull/12" };
const prRows = (t, w) => [
  ...ask("open a PR for the thrusters"),
  ...tool("Bash", "gh pr create --fill", "Created pull request #12"),
  ...say("It's up for review:"), [["  " + PR.text, A.text]], [], [], [],
  [[SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length] + " Tuning lunar gravity… ", ORANGE], [`(${41 + Math.floor(t / 1000)}s)`, A.hint]],
  ...claudeBottom(w)];
// The thruster tuning's session, told short, once its turn is over.
const thrustersTuned = (w) => [
  ...ask("fix the bounce"), [],
  ...tool("Read", "physics.ts", "Read 38 lines"),
  ...say("Gravity is `9.81`;"), [["  moon wants ", A.text], ["1.62", A.code], [".", A.text]],
  ...tool("Update", "physics.ts", "2 lines fixed"),
  ...tool("Bash", "bun test", "2 passed"),
  ...say("Fixed: it lands"), [["  softly now.", A.text]], [],
  [["✻ Worked for 64s", A.hint]], [],
  ...claudeBottom(w)];
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
    const used = runs.reduce((n, [text]) => n + textWidth.displayWidth(text), 0);
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
  res: null, resPointer: null, link: false, cols: WATCH_COLS, compacting: still, peekAt: null, wsHover: null,
  phone: false, desk: 34,
};
// Frames by name; a phone's carry a "p".
const frameOf = (name) => F[(W.phone ? "p" : "") + name];
// moonlander's dev server, linked by name on its row; with the pointer on it,
// corgi shows the URL in the window's corner. A click opens the game itself.
const LINK_ROW = WS_ROWS.M[0];
const openGame = () => window.open("/moonlander", "_blank");
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
  const scope = DATA.layout.controls[`${W.phone ? "p" : ""}w${W.width}_${W.ws}${unread}${ahead}`].scope;
  if (scope) put(g, AGENT_TOP - 2, scope[0], " ".repeat(scope[1] - scope[0]));
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
const pushing = spinner => i18n.t` Pushing ${spinner}`;
function gitLabel(now) {
  if (W.git === "pushing") return { text: pushing(corgiAnimation.spinner(false, now)), fg: "accent" };
  if (W.git === "pushed") return { text: i18n.t` Pushed ✓`, fg: "accent" };
  if (W.git === "ahead" && W.gitHover) return { text: i18n.t` Push ↑2`, fg: "warm" };
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
  for (const ws of ["C", "M"]) putTotals(g, RES_ROW[ws], resTotals("laptop", ws, t));
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
  if (label) put(g, 2, W.width - 2 - textWidth.displayWidth(label.text), label.text, style(label.fg, W.gitHover || W.ws === "C" ? "selected" : "bg", true));
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
  if (W.res) { const rect = resRect(W.res); paste(g, resCells("laptop", W.res, t, watchRes, rect, !!W.resPointer, W.resPointer), rect); }
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
const unreadLabel = count => i18n.t`${count} unread →`;
const sidebarControls = (width, ws, unread, ahead, phone = false) => DATA.layout.controls[`${phone ? "p" : ""}w${width}_${ws}${unread}${ahead}`];
const unreadAt = ({ col, row }) => {
  const unread = WATCH_UNREAD.length - W.read.size;
  const range = sidebarControls(W.width, W.ws, unread, W.git === "none" ? 0 : 1, W.phone).unread;
  return unread > 0 && row === 3 && col >= range.start && col < range.end;
};
const edgeAt = ({ col }) => !W.phone && col === W.width - 1;
const newAt = ({ col, row }) => {
  const span = sidebarControls(W.width, W.ws, 1, 1, W.phone).newAgent;
  return row === AGENT_TOP - 2 && span && col >= span[0] && col < span[1];
};
// A resource row, up to the sidebar's edge on the way to its card.
// corgi needs 68 columns for the resource card, so a phone has none.
const resAt = ({ col, row }) => (W.phone || col >= W.width ? null : row === RES_ROW.C ? "C" : row === RES_ROW.M ? "M" : null);
const within = ({ col, row }, box) => row >= box.top && row <= box.bottom && col >= box.left && col <= box.right;
// A phone has no hover: taps drive it (tapWatch).
watchEl.addEventListener("mouseenter", () => { if (W.phone) return; Object.assign(W, { taken: true, inside: true }); watchEl.classList.add("taken"); });
watchEl.addEventListener("mouseleave", () => { if (!W.phone) Object.assign(W, { inside: false, hover: null, card: null, res: null, resPointer: null, link: false, wsHover: null, dismissed: null, gitHover: false, resumeAt: performance.now() + 5000 }); });
watchEl.addEventListener("mousemove", (e) => {
  if (W.dragging || W.phone) return;
  const at = watchCell(e), i = agentAt(at);
  W.wsHover = workspaceAt(at);
  // The resource card stays open while the pointer is on it.
  W.resPointer = W.res && resRect(W.res).contains(at.col, at.row) && !resAt(at) ? at : null;
  if (W.resPointer) return drawWatch(W.t);
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
// on "Push ↑2" pushes, and one on the link opens it); otherwise an agent opens
// its card, focused and read, and the rest act as clicks do. The tour resumes
// 6 s after the last tap.
function tapWatch(at) {
  const now = performance.now();
  Object.assign(W, { taken: true, inside: false, resumeAt: now + 6000 });
  watchEl.classList.add("taken");
  if (W.gitHover && W.git === "ahead" && gitHit(at)) return Object.assign(W, { git: "pushing", gitAt: now, gitHover: false });
  if (W.link && linkAt(at)) { W.link = false; return openGame(); }
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
// Clicks: the link, Push, "unread →", a workspace, or an agent.
watchEl.addEventListener("click", (e) => {
  const at = watchCell(e);
  if (W.phone) { tapWatch(at); return drawWatch(W.t); }
  if (linkAt(at)) return openGame();
  if (edgeAt(at) || (W.res && resRect(W.res).contains(at.col, at.row) && !resAt(at))) return;
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
// The card on the screen's ground, which its border cells would otherwise
// spill past its line: the sidebar header it opens from keeps none of its
// own either, and its "workspaces" sits well back so the card leads.
const OV_STEP = 2400, OV_CARD = F.ov_card.map((g) => g.map((row, r) => row.map(([ch, s]) => {
  const [fg, bg, bold, ul, ulc] = STYLES[s];
  if (r > 1 && bg !== "bg") return [ch, s];
  return [ch, style(r > 1 || !fg ? fg : mix(fg, "bg", 0.65), null, bold, ul, ulc)];
})));
const overviewEl = document.getElementById("v-overview");
const overviewScreen = new Screen(overviewEl, OV_CARD[0][0].length, OV_CARD[0].length, { badge: true });
// The badge's left edge on the card's left border, the middle of its cell.
overviewScreen.badge.style.left = `calc(${BADGE_X - 0.5} * var(--cell))`;
// The line the card hangs from it by, from its foot to the card's top border.
const hang = overviewEl.appendChild(Object.assign(document.createElement("div"), { className: "hang" }));
hang.style.left = `calc(${BADGE_X + 1} * var(--cell) - .5px)`;
let overviewShown = null;
// On a phone the card is laid out like the picker: agents under their
// account, limits under their own header, each a label and one figure at the
// right edge, from the same cells corgi drew.
const OPW = 48, OPROWS = F.ov_phone[0].length;
const overviewPhoneEl = document.getElementById("v-overview-phone");
overviewPhoneEl.style.setProperty("--rows", OPROWS);
const overviewPhone = new Screen(overviewPhoneEl, OPW, OPROWS);
const overviewSection = document.getElementById("overview");
let overviewPhoneOn = false;
function drawOverview(t) {
  const g = OV_CARD[Math.floor(t / OV_STEP) % OV_CARD.length];
  if (overviewPhoneOn) { if (g !== overviewShown) (overviewShown = g, overviewPhone.paint(F.ov_phone[Math.floor(t / OV_STEP) % F.ov_phone.length])); return; }
  if (g !== overviewShown) overviewScreen.paint((overviewShown = g));
}
// Below 600 pixels the card takes the phone's layout, edge to edge; the
// stylesheet swaps the screens.
new ResizeObserver(() => requestAnimationFrame(() => {
  const phone = overviewSection.clientWidth < 600;
  if (phone === overviewPhoneOn) return;
  overviewPhoneOn = phone;
  overviewShown = null;
  drawOverview(0);
})).observe(overviewSection);

// ---------------------------------------------------------------- keyboard and mouse
// Corgi's command menu as Ctrl-B opens it, drawn by its own code: every
// shortcut, each one a button too. A key, read as corgi reads it once the
// prefix is down, or a click lights what it would run. t or a click on the
// footer's corgi throws it a ball; the wheel, or a finger on a phone,
// scrolls what doesn't fit.
const keysStage = document.getElementById("keys-stage");
const keysHelp = Object.assign(new shortcutHelp.State(), { command_mode: true });
const K = { preset: "corgi", lit: null, litAt: -Infinity, painted: false };
const LIT_FOR = 500;
const keysScreens = [["v-keys", 112, 36], ["v-keys-phone", 48, 30]].map(([id, cols, rows]) => {
  const el = document.getElementById(id);
  return { el, cols, rows, screen: new Screen(el, cols, rows) };
});
// The one the stylesheet shows.
const keysNow = () => keysScreens.find((k) => k.el.offsetParent) ?? keysScreens[0];
const actionKey = (a) => `${a.name}:${a.value ?? ""}`;
// What each cell answers to: an action, "close" on the Esc button, "play" on
// the corgi.
const KEY_CELLS = new Map();
function keyCells({ cols, rows }) {
  const id = [K.preset, cols, rows, keysHelp.scroll].join(":");
  if (KEY_CELLS.has(id)) return KEY_CELLS.get(id);
  const b = shortcutHelp.bounds(cols, rows), esc = { r: b.y + b.h - 2, c0: b.x + b.w - 16, c1: b.x + b.w - 5 };
  const cells = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => {
    const hit = keysHelp.hit(cols, rows, x, y, K.preset);
    if (hit.name === "action") return actionKey(hit.action);
    if (hit.name === "close") return y === esc.r && x >= esc.c0 && x <= esc.c1 ? "close" : null;
    return hit.name === "play" ? "play" : null;
  }));
  KEY_CELLS.set(id, cells);
  return cells;
}
function drawKeys() {
  if (K.painted && !visible.has(keysStage)) return;
  K.painted = true;
  const k = keysNow(), { cols, rows } = k;
  const g = terminal.grid(keysHelp.frame(cols, rows, K.preset, "ctrl_b", Date.now()), cols, rows).map((row) => row.map(([ch, ...look]) => [ch, style(...look)]));
  // What a key or a click ran stays lit a moment, its label through its key;
  // Ctrl-B lights the prefix's keycap.
  if (K.lit && performance.now() - K.litAt < LIT_FOR) {
    const b = shortcutHelp.bounds(cols, rows), cells = keyCells(k);
    for (let r = 0; r < rows; r++) {
      const c0 = K.lit === "prefix" ? (r === b.y + 3 ? b.x + 11 : -1) : cells[r].indexOf(K.lit);
      const c1 = K.lit === "prefix" ? b.x + 20 : cells[r].lastIndexOf(K.lit);
      for (let c = Math.max(0, c0); c0 >= 0 && c <= c1; c++) {
        const [fg, bg, bold, ul, ulc] = STYLES[g[r][c][1]];
        g[r][c] = [g[r][c][0], style(fg, bg === "line" ? "faint" : "selected", bold, ul, ulc)];
      }
    }
  }
  k.screen.paint(g);
}
function lightKeys(what) {
  Object.assign(K, { lit: what, litAt: performance.now() });
  drawKeys();
  setTimeout(drawKeys, LIT_FOR + 20);
}
// The action a key runs once the prefix is down: a prefixed binding, else a
// direct one such as F1. Ctrl and a letter is its control byte.
const NAMED_KEYS = { ArrowLeft: 57350, ArrowRight: 57351, ArrowUp: 57352, ArrowDown: 57353, Tab: 9, Enter: 13 };
function keyAction(e) {
  const mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, super: e.metaKey };
  const either = (key, m) => bindings.lookup(K.preset, true, key, m) ?? bindings.lookup(K.preset, false, key, m);
  const named = NAMED_KEYS[e.key] ?? (/^F([1-9]|1[0-2])$/.test(e.key) ? 57363 + Number(e.key.slice(1)) : null);
  if (named != null) return either(named, mods);
  if (Array.from(e.key).length !== 1) return null;
  if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && /^[a-z]$/i.test(e.key)) return either(e.key.toLowerCase().charCodeAt(0) - 96, {});
  if (e.ctrlKey || e.metaKey || e.altKey) return bindings.chord(K.preset, true, { codepoint: e.key.codePointAt(0), mods });
  return bindings.lookup(K.preset, true, e.key.codePointAt(0), {});
}
// As in corgi: Ctrl-N and Ctrl-P scroll and t plays ahead of any binding;
// keys that bind nothing page through it.
const SCROLL_KEYS = { ArrowUp: [false, 1], ArrowDown: [true, 1], PageUp: [false, "page"], PageDown: [true, "page"], Home: [false, Infinity], End: [true, Infinity] };
keysStage.addEventListener("keydown", (e) => {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "n" || e.key === "p")) { keysHelp.move(e.key === "n", 1); handled(); return drawKeys(); }
  if (plain && e.key === "t") { keysHelp.play(Date.now()); return handled(); }
  if (plain && e.key === "Escape") { lightKeys("close"); return handled(); }
  const act = keyAction(e);
  if (act) { lightKeys(actionKey(act)); return handled(); }
  const scroll = plain && SCROLL_KEYS[e.key];
  if (!scroll || !keysHelp.max_scroll) return;
  keysHelp.move(scroll[0], scroll[1] === "page" ? keysHelp.page_rows : scroll[1]);
  handled();
  drawKeys();
});
lendKeys(keysStage);
const keysCell = (e, k) => { const box = k.el.getBoundingClientRect(); return { x: Math.floor((e.clientX - box.left) / (box.width / k.cols)), y: Math.floor((e.clientY - box.top) / (box.height / k.rows)) }; };
// Whether the menu can scroll the way `down` says.
const keysCanScroll = (down) => (down ? keysHelp.scroll < keysHelp.max_scroll : keysHelp.scroll > 0);
for (const k of keysScreens) {
  k.el.addEventListener("mousemove", (e) => {
    const { x, y } = keysCell(e, k);
    k.el.style.cursor = keysHelp.pointsAt(k.cols, k.rows, x, y, K.preset) ? "pointer" : "";
  });
  k.el.addEventListener("click", (e) => {
    const { x, y } = keysCell(e, k), what = keyCells(k)[y]?.[x];
    if (what === "play") keysHelp.play(Date.now());
    else if (what) lightKeys(what);
  });
  // Three rows a notch, as in corgi; the page scrolls on once it can't.
  let wheel = 0;
  k.el.addEventListener("wheel", (e) => {
    if (!keysCanScroll(e.deltaY > 0)) return;
    e.preventDefault();
    wheel += e.deltaMode ? e.deltaY * 40 : e.deltaY;
    for (; Math.abs(wheel) >= 40; wheel -= Math.sign(wheel) * 40) keysHelp.move(wheel > 0, 3);
    drawKeys();
  }, { passive: false });
  let touchY = null;
  k.el.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  k.el.addEventListener("touchmove", (e) => {
    if (touchY == null) return;
    const dy = touchY - e.touches[0].clientY;
    if (!keysCanScroll(dy > 0)) return;
    e.preventDefault();
    const row = k.el.getBoundingClientRect().height / k.rows, n = Math.trunc(dy / row);
    if (!n) return;
    keysHelp.move(n > 0, Math.abs(n));
    touchY -= n * row;
    drawKeys();
  }, { passive: false });
}
// The presets corgi offers, as tabs over the menu.
const presetButtons = [...document.querySelectorAll("#keys-presets button")];
presetButtons.forEach((button) => button.addEventListener("click", () => {
  Object.assign(K, { preset: button.dataset.preset, lit: null });
  presetButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  drawKeys();
}));
// Ctrl-B anywhere brings the menu up and hands it the keyboard, unless
// something on the page took the key first (the review panel's own prefix).
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return;
  e.preventDefault();
  const box = keysStage.getBoundingClientRect(), shown = box.top >= 0 && box.bottom <= innerHeight;
  if (!shown) keysStage.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  keysStage.focus({ preventScroll: true });
  setTimeout(() => lightKeys("prefix"), shown || still ? 0 : 450);
});

// [watched element, draw, loop length, resting time]
const LOOPS = [
  [launcherStage, drawLauncher, 1e9, 0],
  [watchEl, drawWatch, 1e9, 3600],
  [document.getElementById("overview-stage"), drawOverview, OV_STEP * OV_CARD.length, 0],
  [keysStage, drawKeys, 1e9, 0],
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
  const reset = () => { copyBtn.classList.remove("copied"); copyBtn.setAttribute("aria-label", i18n.t`Copy the install command`); };
  // The check shows on the click itself; the glint runs alongside it.
  clearTimeout(copyBtn.timer);
  copyBtn.classList.remove("copied");
  cmd.classList.remove("glint");
  void cmd.offsetWidth;
  copyBtn.classList.add("copied");
  copyBtn.setAttribute("aria-label", i18n.t`Copied`);
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

// ---------------------------------------------------------------- sessions
// A corgi session in split panes, built from keeps watch's frames. The hero
// opens one from a shell prompt for the visitor to poke at. Each feature
// below shows a slice of another, its point ringed.
(() => {
const COLS = WATCH_COLS, ROWS = WATCH_ROWS_N, SW = 34;
const rowText = (g, r) => g[r].map(([ch]) => ch).join("");
const now = () => performance.now();

// ---- layouts
const right = (a, b, ratio = 0.52) => ({ dir: "right", ratio, a, b }), down = (a, b, ratio = 0.5) => ({ dir: "down", ratio, a, b });
const pane = (id) => ({ id }), named = (title, root) => ({ ...root, title });
// corgi's tabs: Claude and Codex side by side, Release notes beside the
// refactor in a tab named for them, then the finished agent. moonlander
// splits into Claude, a finished Claude and a shell.
const TABS = {
  C: [right(pane("C0"), pane("C1")), named("release", right(pane("C2"), pane("C3"))), pane("C4")],
  M: [right(pane("M0"), down(pane("M1"), pane("sh"), 0.42))],
};
// As corgi draws a tab: a half cell of bar, its number on a badge, the
// badge's half cell, then its name and a space. An untitled tab is twelve
// wide; a renamed one fits its whole title.
const tabWidth = (root, i) => Math.max(12, `${i + 1}`.length + 3 + textWidth.displayWidth(root.title ?? ""));
// What an untitled tab shows for its pane, as corgi does: its agent and the
// provider's mark, the program in front of its shell and its mark, or its
// folder.
const AGENT_TABS = {
  C0: [i18n.t`Fix sidebar flicker`, "claude"], C1: [i18n.t`Audit the install script`, "codex"], C2: [i18n.t`Release notes`, "claude"], C3: [i18n.t`Refactor the viewer`, "claude"],
  C4: [i18n.t`Ghostty keybindings`, "codex"], M0: [i18n.t`Tune the thruster physics`, "claude"], M1: [i18n.t`Draw the lander sprite`, "claude"],
};
function untitledTab(S, id) {
  const agent = AGENT_TABS[id];
  if (agent) return { name: agent[0], brand: processName.brandOf(agent[1]) };
  const p = S.term?.[id], command = p ? p.program : id === "sh" && S.server ? "bun run dev" : null;
  if (command) return processName.program(command.split(/\s+/));
  const folder = p?.ps?.[0][0] ?? "~/moonlander";
  return { name: folder.slice(folder.lastIndexOf("/") + 1), brand: null };
}
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
const agentOf = (id) => (id === "sh" ? -1 : Number(id.slice(1)));
const LINK_TEXT = GAME_LABEL;
const groundOf = (g, r, c) => STYLES[g[r][c][1]][1];
// A tab's half blocks, badge and name: the number on the keycap's gray, lit
// with the focus color on the active tab; a cut name's last two letters fade.
const tabStyles = (on) => {
  const [ground, ink] = on ? ["selected", "strong"] : ["surface", "faint"];
  return {
    open: style(on ? "accent" : "line", "bg"), badge: on ? style("bg", "accent", true) : style("text", "line"),
    end: style(on ? "accent" : "line", ground), name: style(ink, ground, on), fade: [0.65, 0.35].map((n) => style(mix(ground, ink, n), ground, on)),
  };
};
const TAB_OFF = tabStyles(false), TAB_ON = tabStyles(true), TAB_ADD_EDGE = style("surface", "bg"), TAB_ADD = style("strong", "surface", true);
const EDGE_ON = style("accent", null, true), EDGE = style("line");
const PATH = style("#9fd39a"), URL = style("#a9b1f5"), CURSOR = style(null, "text");
const GLYPH = { ud: "│", lr: "─", dr: "┌", dl: "┐", ur: "└", ul: "┘", udr: "├", udl: "┤", dlr: "┬", ulr: "┴", udlr: "┼" };
const prompt = (dir) => [[dir, PATH], [" $ ", A.hint]];
// What the hackable band's panes run, kept to a glance: moonlander's tests,
// failing until its agent fixes them, and its dev server.
const PASS = style("accent"), FAIL = style("hot");
const TEST_RUN = [[["bun test v1.3.1", A.strong]], [], [["✗ ", FAIL], ["landing > doesn't bounce", A.text]], [], [[" 11 pass", PASS]], [[" 1 fail", FAIL]]];
const TEST_PASS = [[["bun test v1.3.1", A.strong]], [], [[" 12 pass", PASS]], [[" 0 fail", A.text]]];
// How long a quiet agent takes over what it was asked.
const FIX_AFTER = 3000;
const DEV_RUN = [[["$ bun --hot server.ts", A.out]], [], [["  ➜  Local:   ", A.text], ["http://localhost:3000/", URL]]];
const plain = (rows) => rows.map((row) => (row.runs ?? row).map(([text]) => text).join("")).join("\n");
// Rows soft-wrapped at `w` cells, as a terminal reflows them.
function wrap(rows, w) {
  return rows.flatMap((row) => {
    const out = [[]];
    let n = 0;
    for (const [text, s] of row) for (const ch of text) {
      const width = textWidth.displayWidth(ch);
      if (n + width > w) { out.push([]); n = 0; }
      const line = out.at(-1), last = line.at(-1);
      if (last?.[1] === s) last[0] += ch;
      else line.push([ch, s]);
      n += width;
    }
    return out;
  });
}
const resRectAt = (ws, rows, host) => resourceTooltip.geometry(COLS, rows, SW, RES_ROW[ws], resGpus(host));
function find(g, text, { r0 = 0, r1 = g.length - 1, c0 = 0, c1 = g[0].length - 1 } = {}) {
  for (let r = r0; r <= r1; r++) {
    const at = cellGrid.find(g[r].slice(c0, c1 + 1), text);
    if (at >= 0) return { r0: r, r1: r, c0: c0 + at, c1: c0 + at + textWidth.displayWidth(text) - 1 };
  }
  return null;
}
const agentRows = (i) => ({ r0: WATCH_ROWS[i], r1: WATCH_ROWS[i] + 1, c0: 1, c1: SW - 3 });
const WT_ROWS = F.wt34_0.length;

// ---- the review panel: Corgi's own, at the window's right edge, on one of
// moonlander's checkouts as git answered the recorder (site/browser/git.ts).
// Corgi's default width, beside a narrow sidebar, leaving the agent's pane
// less than Corgi would. Its keys overlay stays shut.
const REVIEW_W = 80;
// The checkouts the recorder made, by the worktree each is: where the panel
// reads it, and the agent it follows there.
const REVIEWED = [
  ["/thrusters", { cwd: "~/moonlander", name: i18n.t`Tune the thruster physics` }],
  ["/sprite", { cwd: "~/moonlander/.claude/worktrees/sprite", name: i18n.t`Draw the lander sprite` }],
];
function reviewPanel(target = REVIEWED[0][1]) {
  const p = new panel.Panel();
  p.open = true;
  p.keysHelp = false;
  p.follow({ pane: 0, ...target });
  // All files, newest edit first; the thruster tuning's new physics test
  // folded to its heading so the gravity fix in physics.ts shows under it.
  // Sorting keeps the cursor on its file, so it goes back to the top first.
  const fold = target === REVIEWED[0][1] ? [{ text: "x" }] : [];
  p.refresh().then(() => [{ text: "o" }, { named: "home" }, ...fold].forEach((k) => p.key(k)));
  return p;
}
function drawReview(g, p, focused, rows) {
  const out = new Writer(), x = COLS - REVIEW_W;
  p.draw(out, x, 0, REVIEW_W, rows, focused);
  terminal.grid(out.buffered(), COLS, rows).forEach((row, r) => {
    for (let c = x; c < COLS; c++) { const [ch, ...look] = row[c]; g[r][c] = [ch, style(...look)]; }
  });
}
// As Corgi's viewer passes them on: a press in the panel gives it the
// keyboard and one elsewhere takes it back; the wheel scrolls it while it
// has the keyboard; Ctrl-B e opens, focuses or closes it.
const REVIEW_KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", PageUp: "page_up", PageDown: "page_down", Home: "home", End: "end", Enter: "enter", Escape: "escape", Backspace: "backspace" };
const REVIEW_CTRL = { d: "half_down", u: "half_up", j: "newline", h: "backspace" };
function reviewKey(e) {
  if (e.metaKey || e.altKey) return null;
  if (e.ctrlKey) return REVIEW_CTRL[e.key] ? { named: REVIEW_CTRL[e.key] } : null;
  if (e.key === "Tab") return { named: e.shiftKey ? "shift_tab" : "tab" };
  if (e.key === "Enter" && e.shiftKey) return { named: "newline" };
  if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) return { named: e.key === "ArrowUp" ? "shift_up" : "shift_down" };
  if (REVIEW_KEYS[e.key]) return { named: REVIEW_KEYS[e.key] };
  return Array.from(e.key).length === 1 ? { text: e.key } : null;
}
function reviewEffect(s, effect) {
  const S = s.S;
  switch (effect.kind) {
    case "send": (S.pasted[S.focus[S.ws]] ??= []).push(effect.text); S.reviewKeys = false; return;
    case "copy": try { navigator.clipboard.writeText(effect.text).catch(() => {}); } catch {} return;
    case "hide": s.review.hide(); Object.assign(S, { review: false, reviewKeys: false }); return;
    case "leave": S.reviewKeys = false;
  }
}
function toggleReview(s) {
  const S = s.S;
  if (!s.review) return;
  if (!S.review) { s.review.open = true; void s.review.refresh(); Object.assign(S, { review: true, reviewKeys: true }); }
  else if (!S.reviewKeys) S.reviewKeys = true;
  else reviewEffect(s, { kind: "hide" });
}
function reviewInput(el, current, [r0, c0, rows, cols]) {
  const cellAt = (e) => { const b = el.getBoundingClientRect(); return { col: c0 + Math.floor((e.clientX - b.left) / (b.width / cols)), row: r0 + Math.floor((e.clientY - b.top) / (b.height / rows)) }; };
  const inPanel = (s, { col }) => s.S.review && col >= COLS - REVIEW_W;
  let pressed = false, prefix = false, wheel = 0;
  el.addEventListener("mousedown", (e) => {
    const s = current(), at = cellAt(e);
    s.S.reviewKeys = inPanel(s, at);
    if (!s.S.reviewKeys) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    s.S.active = pressed = true;
    s.review.mouse("press", at.col, at.row);
    reviewEffect(s, s.review.takeEffect());
  });
  el.addEventListener("mousemove", (e) => {
    const s = current(), at = cellAt(e);
    // A slice that opens its panel only on Review changes has none yet.
    if (!s.review) return;
    if (pressed) s.review.mouse("drag", at.col, at.row);
    else if (inPanel(s, at)) s.review.mouse("move", at.col, at.row);
    // The rule under the file list drags its height.
    el.style.cursor = s.review.splitting || (inPanel(s, at) && at.col > COLS - REVIEW_W && at.row === s.review.splitRow) ? "ns-resize" : "";
  });
  addEventListener("mouseup", (e) => {
    if (!pressed) return;
    pressed = false;
    const at = cellAt(e);
    current().review.mouse("release", at.col, at.row);
  });
  // A notch of a wheel, or a trackpad's worth of one.
  el.addEventListener("wheel", (e) => {
    const s = current(), at = cellAt(e);
    if (!s.S.reviewKeys || !s.S.active || !inPanel(s, at)) return;
    e.preventDefault();
    wheel += e.deltaMode ? e.deltaY * 40 : e.deltaY;
    for (; Math.abs(wheel) >= 40; wheel -= Math.sign(wheel) * 40) s.review.mouse(wheel > 0 ? "wheel_down" : "wheel_up", at.col, at.row);
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const s = current();
    s.S.active = true;
    if (prefix) { prefix = false; if (e.key !== "e") return; e.preventDefault(); return toggleReview(s); }
    if (e.ctrlKey && e.key === "b") { prefix = true; return e.preventDefault(); }
    const k = s.S.reviewKeys ? reviewKey(e) : null;
    if (!k) return;
    e.preventDefault();
    reviewEffect(s, s.review.key(k));
  });
  el.addEventListener("focus", () => { current().S.active = true; });
  el.addEventListener("blur", () => { current().S.active = false; });
}

// ---- the worktree overview: Corgi's own, over a workspace's worktrees as
// the recorder kept them, their times moved up to now, beside a sidebar `sw`
// wide. Holding ⌫ removes one of corgi's as Corgi does, with no Git to wait
// for: it leaves the list, and the sidebar shows the frame recorded without
// it and its agent.
function overview(name, sw) {
  const data = DATA.worktrees[name], shift = Date.now() - data.at, at = (ms) => (ms == null ? null : ms + shift);
  const snapshot = { ...data.snapshot, entries: data.snapshot.entries.map((e) => ({ ...e,
    comparison: e.comparison && { ahead: BigInt(e.comparison.ahead), behind: BigInt(e.comparison.behind) },
    created: at(e.created), edited: at(e.edited) })) };
  return openTrees({ data, sw, card: Object.assign(new worktreeTooltip.State(), { anchor: data.badges[0].y }), snapshot, gone: 0 });
}
// As the badge opens it, pinned; closing clears all this.
function openTrees(o) {
  Object.assign(o.card, { workspace: 1, pinned: true, briefs: new Map(o.data.briefs.map((b) => [b.path, b])), agents: new Map(o.data.agents) });
  return Object.assign(o, { open: true });
}
const treesBadge = (o) => { const b = o.data.badges[o.gone]; return b && new Rect(b.x, b.y, b.w, b.h); };
function treesRect(o, rows, now = Date.now()) {
  const shown = worktreeTooltip.listing(o.snapshot, o.card, now);
  return worktreeTooltip.geometry(COLS, rows, o.sw, treesBadge(o)?.y ?? o.card.anchor, shown.entries.length, shown.closed, o.card.lines());
}
// What Corgi wrote to `out` over `g`, each cell's look through `ground`;
// what it leaves unwritten shows through.
function drawOver(g, out, rows, ground = (look) => look) {
  terminal.grid(out.buffered(), COLS, rows).forEach((row, r) => row.forEach(([ch, ...look], c) => {
    if (look[1] !== null) g[r][c] = [ch, style(...ground(look, c))];
  }));
}
// The card and the line from its badge. Over the pane the card takes the
// pane's ground, which its border cells would otherwise spill past its line.
function drawTrees(g, o, rows) {
  const now = Date.now(), out = new Writer();
  if (o.card.removal.phase !== "idle") o.card.removal.advance(now);
  const rect = treesRect(o, rows, now);
  if (!rect) return;
  worktreeTooltip.draw(out, rect, o.data.name, o.data.cwd, o.snapshot, o.card, treesBadge(o), now);
  drawOver(g, out, rows, ([fg, bg, ...rest], c) => [fg, bg === "surface" && c >= o.sw ? "pane" : bg, ...rest]);
}
// ---- a worktree heading's menu: Corgi's own, as a right-click on the
// heading opens it (on the page, any click). Review changes says what it
// would show once git answers; Copy full path copies the folder. The rest
// close it, the page having no tabs to open.
const GIT_ANSWERS = 350;
// The checkout whose heading is on `row` of the sidebar, `sw` wide.
function headingAt(g, o, row, sw) {
  if (!g?.[row]) return null;
  const text = g[row].slice(0, sw - 1).map(([ch]) => ch).join(""), at = text.indexOf("⌥ ");
  if (at < 0) return null;
  const name = text.slice(at + 2).split(" ")[0];
  return o.snapshot.entries.find((e) => worktrees.label(e) === name || (name.endsWith("…") && worktrees.label(e).startsWith(name.slice(0, -1)))) ?? null;
}
function openMenu(S, checkout, col, row) {
  const o = S.trees, menu = new TabMenu({ tab: 1, worktree: checkout.path, title: worktrees.label(checkout), anchor_x: col, anchor_y: row });
  menu.setDetail("review", null);
  menu.setDetail("copy-path", [[worktreeTooltip.displayPath(checkout.path, o.data.cwd), "faint"]]);
  menu.highlightFirst();
  S.menu = { menu, path: checkout.path, at: Date.now(), overview: o.open };
  o.card.clear();
  o.open = false;
}
// The overview the menu opened over comes back as it goes.
function closeMenu(S) {
  if (S.menu.overview) openTrees(S.trees);
  S.menu = null;
}
function menuAction(s, item) {
  const S = s.S, path = S.menu.path;
  if (item === "copy-path") {
    navigator.clipboard?.writeText(path).catch(() => {});
    S.copiedUntil = Date.now() + 2000;
  }
  closeMenu(S);
  if (item === "review") reviewTree(s, path);
}
// Review changes on a worktree: Corgi's panel on its checkout, the overview
// going as the panel takes the keyboard.
function reviewTree(s, path) {
  const target = REVIEWED.find(([end]) => path.endsWith(end))?.[1];
  if (!target) return;
  s.S.trees.card.clear();
  s.S.trees.open = false;
  s.openReview(target);
}
function drawMenu(g, S) {
  const m = S.menu, out = new Writer();
  if (!m.answered && Date.now() - m.at >= GIT_ANSWERS) {
    m.answered = true;
    m.menu.setDetail("review", new Map(S.trees.data.reviews).get(m.path) ?? [[i18n.t`No changes`, "faint"]]);
  }
  m.menu.draw(out, COLS, S.rows);
  drawOver(g, out, S.rows);
}
// Corgi's toast once something's copied, as src/render.ts draws it.
function drawCopied(g, rows) {
  const out = new Writer(), x = COLS - 26;
  out.write(new palette.Style({ fg: "line", bg: "bg" }).sgr() + `\x1b[2;${x}H╭─────────────────────────╮`);
  out.write(`\x1b[3;${x}H│ ` + palette.fg("strong") + "● \x1b[1mCopied to clipboard\x1b[22m" + palette.fg("line") + "   │");
  out.write(`\x1b[4;${x}H╰─────────────────────────╯\x1b[0m`);
  drawOver(g, out, rows);
}
// A press of ⌫ or Delete, or a repeat while it's held, as Corgi's
// worktree-remove, always with the corgi burying the row. Once the hold
// completes, Corgi would close the agents and have Git remove it; here it's
// gone at once, and the sidebar shows the frame recorded without it and its
// agents.
function removeTree(S) {
  const o = S.trees, card = o.card, entries = card.entries(o.snapshot), index = card.index(entries), checkout = entries[index];
  if (!checkout) return;
  card.select(checkout.path);
  const agents = o.snapshot.agents.filter((a) => a.path === checkout.path).length, now = Date.now();
  if (!card.removal.press(now, worktreeRemoval.target(1, checkout, index, agents), "bury")) return;
  o.gone |= 1 << o.data.snapshot.entries.filter((e) => !e.primary).findIndex((e) => e.path === checkout.path);
  o.snapshot = { ...o.snapshot, entries: o.snapshot.entries.filter((e) => e.path !== checkout.path), agents: o.snapshot.agents.filter((a) => a.path !== checkout.path) };
  card.removal.settle(now, null);
  card.select((entries[index + 1] ?? entries[index - 1])?.path ?? null);
}
// Its keys while the screen has the page's focus: ↑↓ (or j k) browse, ⌫
// held removes, Esc closes. The pointer picks the row it's on, a heading
// sorts the rows, and the badge opens it again. `held` runs once a hold is
// under way, and e reviews the worktree browsed. A worktree heading in the
// sidebar opens its menu, which takes the keys and the pointer while it's
// open. The review panel, once open, has its own.
const TREE_MOVES = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };
function treesInput(el, current, [r0, c0, rows, cols], held) {
  // A pointer's whole pixels can sit just outside a screen that starts between two.
  const inside = (n, size) => Math.min(size - 1, Math.max(0, n));
  const cellAt = (e) => { const b = el.getBoundingClientRect(); return { col: c0 + inside(Math.floor((e.clientX - b.left) / (b.width / cols)), cols), row: r0 + inside(Math.floor((e.clientY - b.top) / (b.height / rows)), rows) }; };
  const aim = (e) => {
    const s = current(), S = s.S, o = S.trees, at = cellAt(e), badge = treesBadge(o), rect = o.open && treesRect(o, rows);
    const onBadge = !!badge && badge.contains(at.col, at.row), on = rect && rect.contains(at.col, at.row);
    const row = S.menu ? S.menu.menu.hit(COLS, S.rows, at.col, at.row) : null;
    const heading = !S.menu && at.col < o.sw - 1 ? headingAt(F[S.side], o, at.row, o.sw) : null;
    return { s, S, o, onBadge, at, rect, row, heading, panel: S.review && at.col >= COLS - REVIEW_W, path: on ? o.card.hit(o.snapshot, rect, at.col, at.row) : null, sort: on ? worktreeTooltip.sortAt(rect, at.col, at.row) : null };
  };
  el.addEventListener("keydown", (e) => {
    const s = current(), S = s.S, o = S.trees, m = S.menu?.menu;
    if (e.metaKey || e.ctrlKey || e.altKey || S.reviewKeys) return;
    if (m) {
      const item = e.key.length === 1 ? m.itemFor(e.key.charCodeAt(0)) : null;
      if (e.key === "Escape") closeMenu(S);
      else if (TREE_MOVES[e.key]) m.move(TREE_MOVES[e.key] > 0);
      else if (e.key === "Enter" && m.highlightedItem()) menuAction(s, m.highlightedItem());
      else if (item) menuAction(s, item);
      else return;
    }
    else if (!o.open) return;
    else if (e.key === "Escape") { o.card.clear(); o.open = false; }
    else if (e.key === "e") { const entries = o.card.entries(o.snapshot), at = entries[o.card.index(entries)]; if (at) reviewTree(s, at.path); }
    else if (TREE_MOVES[e.key]) o.card.move(o.snapshot, TREE_MOVES[e.key]);
    else if (e.key === "Backspace" || e.key === "Delete") { removeTree(S); held(); }
    else return;
    e.preventDefault();
  });
  el.addEventListener("mousemove", (e) => {
    if (!e.movementX && !e.movementY) return;
    const { S, o, onBadge, row, heading, panel, path, sort } = aim(e);
    if (panel && !o.open) return;
    if (S.menu) {
      if (row != null && !S.menu.menu.off.has(S.menu.menu.entries()[row].item)) S.menu.menu.highlighted = row;
      return void (el.style.cursor = row != null ? "pointer" : "");
    }
    if (onBadge && !o.open) openTrees(o);
    if (path) o.card.select(path);
    el.style.cursor = onBadge || path || sort || heading ? "pointer" : "";
  });
  const press = (e) => {
    const { s, S, o, onBadge, at, rect, row, heading, panel, path, sort } = aim(e);
    if (S.menu) {
      const item = row != null ? S.menu.menu.entries()[row].item : null;
      if (item == null) closeMenu(S);
      else if (!S.menu.menu.off.has(item)) menuAction(s, item);
      return;
    }
    if (panel && !o.open) return;
    if (heading) return openMenu(S, heading, at.col, at.row);
    if (onBadge && !o.open) openTrees(o);
    if (path) o.card.select(path);
    if (sort) o.card.click(rect, at.col, at.row);
  };
  el.addEventListener("click", press);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); press(e); });
}

// ---- a session: its state, and the frame it draws
const SIDE = new Map();
// Time taken to the second, as the sidebar's elapsed prints it.
function elapsed(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
function session(init = {}) {
  const S = {
    ws: "C", tabs: TABS, tab: { C: 0, M: 0 }, focus: { C: "C0", M: "M0" }, read: new Set(),
    typed: "", history: [], server: false, link: 0, linkAt: -1e9,
    hover: null, card: null, res: null, resHeld: false, resPointer: null, wsHover: null, linkHover: false,
    git: "ahead", gitAt: 0, gitHover: false, approvedAt: null, tagged: false, clear: null, newButton: true, solo: false,
    // Refactor the viewer compacting, its herd walking in from herdAt.
    compacting: false, herdAt: null,
    // A recorded sidebar and window height in place of the agent list's,
    // and the review panel open, with the keyboard or not; keys reach it
    // while the screen has the page's focus.
    // Notes it sent wait in a pane's prompt.
    side: null, rows: ROWS, cols: COLS, single: false, review: false, reviewKeys: false, active: false, pasted: {},
    // With `trees`, the worktree overview of the workspace it names, open;
    // a worktree heading's menu, and when the toast for a copy goes. With
    // `lights`, the sidebar is the frame of that name recorded after the
    // overview's removals, lighting the worktree it browses while open.
    // With `alone`, the sidebar lists `ws` only.
    trees: null, menu: null, copiedUntil: 0, lights: null, alone: false,
    // The hackable band's terminals by pane: scrollback, the line being
    // typed, and the program holding it, if any. With `quiet`, agents show
    // only what `corgi pane send` asked them, kept in `asked`.
    term: null, quiet: false, asked: {}, fixed: false,
    // With `idle`, the thruster tuning has finished, its pane still; with
    // `shot`, it has saved a screenshot of the game, and with `pr`, opened a
    // pull request.
    idle: false, shot: false, pr: false,
    // The host the resource figures come from: keeps watch's laptop, or the GPU host.
    host: "laptop",
    ...init,
  };
  Object.assign(S, { read: new Set(S.read), tab: { ...S.tab }, focus: { ...S.focus }, term: S.term && structuredClone(S.term) });
  // The sidebar is as wide as its recording, and the rest lays out around it.
  const SW = (S.side ? F[S.side] : F.w34_C00)[0].length;
  S.trees &&= overview(S.trees, SW);
  let review = S.review ? reviewPanel() : null;
  // The resource card's table order and sort.
  const resCard = new resourceTooltip.State();
  const unread = () => (S.read.has(4) ? 0 : 1) + (S.tagged && !S.read.has(2) ? 1 : 0);
  function sidebar() {
    const ws = S.ws, ahead = S.git === "none" ? 0 : 1, fi = agentOf(S.focus[ws]), un = Math.min(1, unread());
    // Release notes, once tagged and read, is clear too.
    const clear = [S.clear, S.tagged && S.read.has(2) ? 2 : null].filter((i) => i != null);
    const key = [ws, ahead, un, fi, [...S.read].sort().join(","), clear, S.newButton, S.approvedAt != null, S.side, S.rows, S.compacting].join(":");
    if (SIDE.has(key)) return SIDE.get(key);
    // A recorded sidebar keeps its rows past a shorter window's, for a
    // slice's edit to move up.
    const g = blank(Math.max(S.rows, S.side ? F[S.side].length : 0), COLS);
    if (S.side) F[S.side].forEach((row, r) => row.slice(0, SW).forEach((cell, c) => (g[r][c] = cell)));
    else agentList(g, ws, un, ahead, fi, clear);
    tidySidebar(g);
    const controls = sidebarControls(SW, ws, un, ahead);
    const span = S.side ? null : controls.scope;
    if (span) put(g, AGENT_TOP - 2, span[0], " ".repeat(span[1] - span[0]));
    if (!S.newButton && controls.newAgent) put(g, AGENT_TOP - 2, controls.newAgent[0], " ".repeat(controls.newAgent[1] - controls.newAgent[0]));
    SIDE.set(key, g);
    return g;
  }
  function agentList(g, ws, un, ahead, fi, clear) {
    F[`w34_${ws}${un}${ahead}`].forEach((row, r) => row.forEach((cell, c) => (g[r][c] = cell)));
    const rest = F[`w34_e${ws}00`];
    rest.forEach((row, r) => row.forEach((cell, c) => (g[AGENT_TOP + r][c] = cell)));
    for (let i = 0; i < AGENTS[ws]; i++) {
      const read = ws === "C" && S.read.has(i) ? 1 : 0, focus = i === fi ? 1 : 0;
      const frame = F[ws === "C" && i === COMPACTOR && !S.compacting ? `w34_eC${focus}0p` : `w34_e${ws}${focus}${read}`] ?? rest;
      for (const y of [WATCH_ROWS[i], WATCH_ROWS[i] + 1]) frame[y - AGENT_TOP].forEach((cell, c) => (g[y][c] = cell));
    }
    // A clear agent takes the read Ghostty keybindings' rows, under its own
    // name and keeping its separator.
    if (ws === "C") for (const i of clear) {
      const read = F[`w34_eC${i === fi ? 1 : 0}1`], [top, under] = [WATCH_ROWS[i], WATCH_ROWS[i] + 1];
      read[WATCH_ROWS[4] - AGENT_TOP].forEach((cell, c) => (g[top][c] = cell));
      read[WATCH_ROWS[4] + 1 - AGENT_TOP].forEach((cell, c) => (g[under][c] = [cell[0], keepRule(cell[1], g[under][c])]));
      const name = F[`w34_eC${i === fi ? 1 : 0}0`][top - AGENT_TOP].slice(BAR + 4).map(([ch]) => ch).join("").trimEnd();
      put(g, top, BAR + 4, name + " ".repeat(Math.max(0, SW - 3 - BAR - 4 - textWidth.displayWidth(name))));
    }
    // Once allowed, Release notes needs no one, so the ● count goes.
    if (S.approvedAt != null) {
      const at = cellGrid.find(g[3], "●1 "), end = cellGrid.find(g[3], "  ", at);
      if (at >= 0) { const gone = g[3].splice(at, 3); g[3].splice(end - 3, 0, ...gone.map(([, s]) => [" ", s])); }
    }
  }
  const linkCol = () => cellGrid.find(sidebar()[LINK_ROW], LINK_TEXT);
  function layout() {
    const room = S.cols - SW - (S.review ? REVIEW_W : 0), rows = S.rows;
    const tabs = S.tabs[S.ws], root = tabs[S.tab[S.ws]] ?? tabs[0];
    if (S.single) {
      const panes = leaves(root, 0, 0, room, rows - 1), focused = S.focus[S.ws];
      return leaves(pane(panes.some((p) => p.id === focused) ? focused : panes[0].id), SW, 1, room, rows - 1);
    }
    // A slice shows only the left pane, so there the focused agent takes it.
    if (S.solo) {
      const id = S.focus[S.ws], next = S.ws + ((agentOf(id) + 1) % AGENTS[S.ws]);
      return leaves(right(pane(id), pane(next)), SW + 1, 2, room - 2, rows - 3);
    }
    return root.id ? leaves(root, SW, 1, room, rows - 1) : leaves(root, SW + 1, 2, room - 2, rows - 3);
  }

  // ---- panes
  function shellRows(t, focused) {
    const rows = [...S.history];
    if (S.server) rows.push([...prompt("~/moonlander"), ["bun run dev", A.text]], [["$ bun --hot server.ts", A.out]], [],
      [["  Starting moonlander game…", A.text]], [],
      [["  ➜  Local:   ", A.text], ["http://localhost:3000/", URL]]);
    else rows.push([...prompt("~/moonlander"), [S.typed, A.text], [focused && Math.floor(t / 530) % 2 === 0 ? " " : "", CURSOR]]);
    return rows;
  }
  function termRows(id, t, w, focused) {
    const p = S.term[id];
    return wrap(p.program ? p.rows : [...p.rows, [...(p.ps ?? prompt("~/moonlander")), [p.typed, A.text], [focused && Math.floor(t / 530) % 2 === 0 ? " " : "", CURSOR]]], w);
  }
  // A quiet agent: what it was asked, then working on it, then done.
  function askedRows(id, t) {
    const a = S.asked[id];
    if (!a) return [];
    const took = Math.max(0, Math.floor((t - a.at) / 1000)), spin = SPIN_CLAUDE[Math.floor(t / 120) % SPIN_CLAUDE.length];
    const done = t - a.at >= FIX_AFTER ? [...say(/fix|test/i.test(a.text) ? "Fixed: the lander no longer bounces." : "Done."), [], [[`✻ Worked for ${FIX_AFTER / 1000}s`, A.hint]]] : [[[spin + " Fixing… ", ORANGE], [`(${took}s)`, A.hint]]];
    return [...ask(a.text), [], ...done, []];
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
    if (id === "blank") return [];
    if (S.term?.[id]) return termRows(id, t, w, focused);
    if (id === "sh") return shellRows(t, focused);
    if (S.shot && id === "M0") return shotRows(t, w);
    if (S.pr && id === "M0") return prRows(t, w);
    if (S.quiet) return [...askedRows(id, t), ...claudeBottom(w)];
    if (id === "C2" && S.approvedAt != null) return tagRows(t, w);
    // keeps watch's sessions; its hidden band won't read this.
    W.compacting = S.compacting;
    // The shorter telling keeps watch wrote for phones reads at a glance.
    const rows = S.idle && id === "M0" ? thrustersTuned(w) : closeBox(phoneRows(id, t, w), w), sent = S.pasted[id] ?? [];
    // Pasted notes wait in Claude's prompt, as Claude Code shows a paste.
    const at = sent.length ? rows.findLastIndex((row) => row[0]?.[0] === "❯ ") : -1;
    if (at >= 0) rows[at] = [rows[at][0], ...sent.map((text, n) => [`[Pasted text #${n + 1} +${text.split("\n").length - 1} lines] `, A.text])];
    return rows;
  }
  function drawPane(g, l, t) {
    const focused = l.id === S.focus[S.ws], rows = paneRows(l.id, t, l.w - 2, focused);
    // A shell fills from the top, scrolled back as far as its wheel took it;
    // an agent's input sits at the bottom.
    const top = l.id === "sh" || S.term?.[l.id] ? l.y + Math.min(0, l.h - rows.length) + (S.term?.[l.id]?.scroll ?? 0) : l.y + l.h - rows.length;
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
    for (let r = 0; r < S.rows; r++) put(g, r, SW, " ".repeat(COLS - SW), R.pane);
    let c = SW;
    S.tabs[S.ws].forEach((root, i) => {
      if (S.single && i !== S.tab[S.ws]) return;
      const ts = i === S.tab[S.ws] ? TAB_ON : TAB_OFF, number = `${i + 1}`, w = tabWidth(root, i);
      const ids = leaves(root, 0, 0, 90, 20).map((l) => l.id);
      const { name, brand } = root.title != null ? { name: root.title, brand: null } : untitledTab(S, ids.includes(S.focus[S.ws]) ? S.focus[S.ws] : ids[0]);
      const mark = brand ? markCells(brand) : [];
      let label = textWidth.clipped(name, w - number.length - mark.length - 3);
      const cut = label.length < name.length;
      if (cut) label = label.trimEnd();
      const end = number.length + 2 + mark.length + textWidth.displayWidth(label);
      const labelCells = cellGrid.decode([[label, ts.name]]);
      const cells = [...cellGrid.decode([["▐" + number + "▌", ts.name]]), ...mark.map(ch => [ch, ts.name]), ...labelCells];
      while (cells.length < w) cells.push([" ", ts.name]);
      cells.forEach(([ch], k) => { if (g[0][c + k]) g[0][c + k] = [ch,
        k === 0 ? ts.open : k <= number.length ? ts.badge : k === number.length + 1 ? ts.end : cut && k >= end - 2 && k < end ? ts.fade[k - end + 2] : ts.name]; });
      c += w;
    });
    if (!S.single) put(g, 0, put(g, 0, put(g, 0, c, "▐", TAB_ADD_EDGE), "+", TAB_ADD), "▌", TAB_ADD_EDGE);
    const ls = layout();
    // A slice showing one pane of two draws no outline.
    if (ls.length > 1 && !S.solo) {
      // Every pane's outline; the focused one's in the accent.
      const on = new Map();
      for (const l of ls) for (let x = l.x - 1; x <= l.x + l.w; x++) for (let y = l.y - 1; y <= l.y + l.h; y++) {
        if (x !== l.x - 1 && x !== l.x + l.w && y !== l.y - 1 && y !== l.y + l.h) continue;
        const k = y * 1000 + x;
        on.set(k, on.get(k) || l.id === S.focus[S.ws]);
      }
      for (const [k, hi] of on) {
        const y = Math.floor(k / 1000), x = k % 1000, has = (dx, dy) => on.has((y + dy) * 1000 + x + dx);
        const key = (has(0, -1) ? "u" : "") + (has(0, 1) ? "d" : "") + (has(-1, 0) ? "l" : "") + (has(1, 0) ? "r" : "");
        put(g, y, x, GLYPH[key] ?? "┼", hi ? EDGE_ON : EDGE);
      }
    }
    for (const l of ls) drawPane(g, l, t);
  }

  // ---- a frame
  function cardFor(ws, i) {
    const early = ws === "C" && i === COMPACTOR && !S.compacting, read = ws === "C" && S.read.has(i) ? 1 : 0;
    return early ? [EARLY_CARD, EARLY_BOX] : [CARDS[ws][i][read], CARD_BOX[ws][i]];
  }
  function gitLabel(t) {
    if (S.git === "pushing") return { text: ` Pushing ${corgiAnimation.spinner(false, t)}`, fg: "accent" };
    if (S.git === "pushed") return { text: i18n.t` Pushed ✓`, fg: "accent" };
    if (S.git === "ahead" && S.gitHover) return { text: i18n.t` Push ↑2`, fg: "warm" };
    return null;
  }
  function compose(t) {
    const at = now();
    if (S.git === "pushing" && at - S.gitAt > 1800) Object.assign(S, { git: "pushed", gitAt: at });
    if (S.git === "pushed" && at - S.gitAt > 1500) Object.assign(S, { git: "none", gitHover: false });
    // An agent done with a fix turns the tests that watch it green.
    if (!S.fixed && Object.values(S.asked).some((a) => at - a.at >= FIX_AFTER)) {
      S.fixed = true;
      for (const p of Object.values(S.term ?? {})) if (p.program === "bun test --watch") p.rows = TEST_PASS;
    }
    if (S.lights) {
      const o = S.trees, browsed = o.open && o.card.entries(o.snapshot)[o.card.index(o.card.entries(o.snapshot))];
      const k = browsed ? o.data.snapshot.entries.filter((e) => !e.primary).findIndex((e) => e.path === browsed.path) : -1;
      S.side = `${S.lights}_${o.gone}${k >= 0 ? `_${k}` : ""}`;
    }
    const g = animate(sidebar(), t);
    // Resources sample once a second, as in keeps watch; a workspace alone
    // has its row where the first one's is.
    for (const [ws, row] of Object.entries(S.alone ? { [S.ws]: RES_ROW.C } : RES_ROW)) putTotals(g, row, resTotals(S.host, ws, t));
    // Every demo links to the game; starting its shell server animates it.
    const lc = linkCol(), shown = Math.min(LINK_TEXT.length, Math.max(0, Math.floor((at - S.linkAt) / 70)));
    if (lc >= 0) for (let k = shown; k < LINK_TEXT.length; k++) g[LINK_ROW][lc + k] = [" ", style("muted", groundOf(g, LINK_ROW, lc - 1))];
    S.link = shown;
    // Release notes once allowed: working, then finished and unread.
    if (S.ws === "C" && S.approvedAt != null && !(S.tagged && S.read.has(2))) {
      const [r0, r1] = [WATCH_ROWS[2], WATCH_ROWS[2] + 1], bg = groundOf(g, r0, 2);
      if (S.tagged) {
        put(g, r0, BAR + 1, "●", style("accent", bg, true)); put(g, r0, BAR + 4, i18n.t`Release notes`, style("strong", bg, true));
        put(g, r1, BAR + 1, "   ~ᐯ◡ᴥ◡ᐯ".padEnd(SW - 3 - BAR), style(bg === "selected" ? "muted" : "faint", bg));
      } else {
        put(g, r0, BAR + 1, "▶", style("accent", bg, true));
        put(g, r1, BAR + 1, `${corgiAnimation.spinner(false, t)}  Pushing the tag`.padEnd(SW - 3 - BAR), style("text", bg));
        put(g, r1, BAR + 1, corgiAnimation.spinner(false, t), style(bg === "selected" ? "muted" : "faint", bg));
      }
    }
    // Compacting piles its dots and herds its letters once, as in keeps watch.
    // Once the corgi has curled up, the compaction's time so far sits at the right.
    if (S.ws === "C" && S.compacting && !S.side) {
      const row = WATCH_ROWS[COMPACTOR] + 1, width = SW - 6, ground = STYLES[g[row][4][1]][1] ?? "bg";
      const step = still ? 40 : S.herdAt == null ? 0 : Math.floor((at - S.herdAt) / 110);
      put(g, row, BAR + 1, corgiAnimation.spinner(true, t));
      terminal.row(corgiAnimation.writeHerd(width, step), width).forEach(([ch, fg], c) => put(g, row, BAR + 4 + c, ch, keepRule(style(fg ?? "text", ground), g[row][BAR + 4 + c])));
      if (S.herdAt != null && corgiAnimation.herdScene(width, step).finished) {
        const took = elapsed(at - S.herdAt), c = BAR + 4 + width - took.length;
        put(g, row, c, took, keepRule(style(ground === "selected" ? "muted" : "faint", ground), g[row][c]));
      }
    }
    if (unread() > 1) { const count = String(unread()), range = sidebarControls(SW, S.ws, 1, 1).unread; put(g, 3, range.start, i18n.t`${count} unread →`); }
    const label = gitLabel(at);
    if (label) put(g, 2, SW - 2 - textWidth.displayWidth(label.text), label.text, style(label.fg, "selected", true));
    // The workspace not shown fades back until the pointer comes to it.
    const other = S.ws === "C" ? "M" : "C";
    if (!S.alone && S.wsHover !== other && S.res !== other) for (const r of WS_ROWS[other]) for (let c = 0; c < SW - 1; c++) {
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
    if (S.review) drawReview(g, review, S.reviewKeys && S.active, S.rows);
    if (S.trees?.open) drawTrees(g, S.trees, S.rows);
    if (S.menu) drawMenu(g, S);
    if (S.copiedUntil > Date.now()) drawCopied(g, S.rows);
    if (S.linkHover) CHIP.forEach((cell, c) => (g[S.rows - 1][c] = cell));
    if (S.res) { const rect = resRectAt(S.res, S.rows, S.host); paste(g, resCells(S.host, S.res, t, resCard, rect, S.resHeld, S.resPointer), rect); }
    else if (S.card != null) { const [frame, box] = cardFor(S.ws, S.card); overlay(g, frame, box, SW, box.left); }
    else if (S.gitHover && S.git !== "none") overlay(g, F.git, GIT_BOX, SW, GIT_BOX.left);
    return g;
  }
  // Focusing an agent shows its tab and reads it, as in corgi.
  function focusAgent(i) {
    const id = S.ws + i;
    S.tab[S.ws] = Math.max(0, S.tabs[S.ws].findIndex((root) => leaves(root, 0, 0, 90, 20).some((l) => l.id === id)));
    S.focus[S.ws] = id;
    if (S.ws === "C") S.read.add(i);
  }
  // What a cell holds, or null.
  const side = ({ col }) => col < SW - 1;
  const hit = {
    link: ({ row, col }) => { const lc = linkCol(); return row === LINK_ROW && S.link >= LINK_TEXT.length && col >= lc && col < lc + LINK_TEXT.length ? true : null; },
    git: ({ row, col }) => (row === 2 && S.git === "ahead" && col >= SW - 2 - (S.gitHover ? 8 : 2) && col < SW - 2 ? true : null),
    unread: ({ row, col }) => { const u = sidebarControls(SW, S.ws, 1, 1).unread; return unread() > 0 && row === 3 && side({ col }) && col >= u.start && col < u.end ? true : null; },
    agent: (at) => { const i = side(at) ? WATCH_ROWS.slice(0, AGENTS[S.ws]).findIndex((y) => at.row === y || at.row === y + 1) : -1; return i >= 0 ? i : null; },
    res: (at) => (side(at) ? (at.row === RES_ROW.C ? "C" : at.row === RES_ROW.M ? "M" : null) : null),
    ws: (at) => (side(at) ? (WS_ROWS.C.includes(at.row) ? "C" : WS_ROWS.M.includes(at.row) ? "M" : null) : null),
    tab: ({ row, col }) => { let c = SW; const i = row === 0 ? S.tabs[S.ws].findIndex((root, n) => (!S.single || n === S.tab[S.ws]) && col >= c && col < (c += tabWidth(root, n))) : -1; return i >= 0 ? i : null; },
    pane: ({ row, col }) => layout().find((l) => row >= l.y - 1 && row <= l.y + l.h && col >= l.x - 1 && col <= l.x + l.w)?.id ?? null,
  };
  // Review changes on a checkout the recorder made: the panel opens on it
  // with the keyboard.
  function openReview(target) {
    review = reviewPanel(target);
    Object.assign(S, { review: true, reviewKeys: true, active: true });
  }
  return { S, compose, layout, linkCol, focusAgent, unread, cardFor, hit, get review() { return review; }, openReview, resCard, paneRows };
}

// ---- pointing at a screen that shows `crop` [row, column, rows, columns] of
// a session. `touch` names what answers; `cards` is "hover" for an agent's
// card while the pointer is on it, or "keep" to leave the last one, or the
// resource card, open.
const POINTS = ["link", "git", "unread", "agent", "ws", "tab", "pane"];
function point(el, current, area, { touch, cards = null, touched = () => {} }) {
  const can = new Set(touch.split(" "));
  const cellAt = (e) => {
    const [r0, c0, rows, cols] = typeof area === "function" ? area() : area, b = el.getBoundingClientRect();
    return { col: c0 + Math.floor((e.clientX - b.left) / (b.width / cols)), row: r0 + Math.floor((e.clientY - b.top) / (b.height / rows)) };
  };
  const first = (hit, at) => { for (const kind of POINTS) { const v = can.has(kind) ? hit[kind](at) : null; if (v != null) return { kind, v }; } return null; };
  // A pointer that only rests where the page scrolled opens nothing.
  el.addEventListener("mousemove", (e) => {
    if (!e.movementX && !e.movementY) return;
    const { S, hit, cardFor } = current(), at = cellAt(e), i = can.has("agent") ? hit.agent(at) : null;
    if (can.has("ws")) S.wsHover = hit.ws(at);
    if (can.has("link")) S.linkHover = !!hit.link(at);
    if (can.has("res")) {
      // On the card its rows hold still, a heading sorts them, and its
      // history shows the moment under the pointer.
      const card = S.res && resRectAt(S.res, S.rows, S.host);
      S.resHeld = !!card && card.contains(at.col, at.row) && !hit.res(at);
      S.resPointer = S.resHeld ? at : null;
      if (S.resHeld) return void (el.style.cursor = resourceTooltip.sortAt(card, at.col, at.row, resGpus(S.host)) ? "pointer" : "");
      const res = S.linkHover ? null : hit.res(at);
      if (res || cards !== "keep") S.res = res;
    }
    if (can.has("git")) S.gitHover = !!hit.git(at) || (S.gitHover && S.git !== "none" && within(at, GIT_BOX));
    if (cards === "hover" && S.card != null && within(at, cardFor(S.ws, S.card)[1])) return;
    if (i != null || cards !== "keep") S.hover = !S.linkHover && !S.res ? i : null;
    if (cards) S.card = S.hover;
    const h = first(hit, at);
    el.style.cursor = (can.has("res") && hit.res(at)) || (h && h.kind !== "pane") ? "pointer" : "";
  });
  el.addEventListener("mouseleave", () => Object.assign(current().S, { resHeld: false, resPointer: null, wsHover: null, linkHover: false, gitHover: false }, cards === "keep" ? {} : { res: null, hover: null, card: null }));
  el.addEventListener("click", (e) => {
    const s = current(), at = cellAt(e), h = first(s.hit, at);
    if (s.S.res) return s.resCard.click(resRectAt(s.S.res, s.S.rows, s.S.host), at.col, at.row);
    if (!h) return;
    touched();
    act(s, h, cards);
  });
}
function act(s, { kind, v }, cards = null) {
  const S = s.S;
  switch (kind) {
    case "link": return openGame();
    case "git": return Object.assign(S, { git: "pushing", gitAt: now() });
    case "unread": S.ws = "C"; s.focusAgent(S.tagged && !S.read.has(2) ? 2 : 4); return Object.assign(S, { card: null, readAt: now() });
    case "agent": s.focusAgent(v); return Object.assign(S, cards === "keep" ? { card: v, hover: v } : { card: null, hover: null }, { readAt: now() });
    case "ws": return Object.assign(S, { ws: v, hover: null, card: null });
    case "tab": S.tab[S.ws] = v; S.focus[S.ws] = s.layout()[0].id; return;
    case "pane": S.focus[S.ws] = v;
  }
}

// ---- the hero: corgi's own workspace, Claude and Codex side by side
const simEl = document.getElementById("v-sim");
const hero = session(), H = hero.S;
const heroScreen = new Screen(simEl, COLS, ROWS, { badge: true });
let heroFrom = null, heroReady = still;
function drawHero(t) {
  const ms = heroFrom == null ? 0 : t - heroFrom;
  heroReady ||= ms >= 1400;
  simEl.classList.toggle("launching", !heroReady);
  simEl.tabIndex = heroReady ? 0 : -1;
  simEl.setAttribute("aria-label", !heroReady
    ? i18n.t`A terminal starting Corgi.`
    : H.single
      ? i18n.t`A Corgi session. Tap an agent to see its pane.`
      : i18n.t`A Corgi session with Claude and Codex agents. Click an agent to switch to it.`);
  if (heroReady) heroScreen.paint(crop(hero.compose(t), 0, 0, ROWS, H.cols));
  else {
    const g = blank(ROWS, H.cols);
    const typed = Math.max(0, Math.min(5, Math.floor((ms - 100) / 140)));
    put(g, 1, 2, "~/dev", T.faint);
    let c = put(g, 2, 2, "$ ", T.faint);
    c = put(g, 2, c, "corgi".slice(0, typed), T.strong);
    put(g, 2, c, " ", T.cursor);
    heroScreen.paint(g);
  }
  heroScreen.badge.hidden = !heroReady;
}
point(simEl, () => hero, () => [0, 0, ROWS, H.cols], { touch: "link git unread agent res ws tab pane", cards: "hover" });
// The prerendered page's container query sets --cols, so the band has its new
// size before the observer runs; without it (the prerender itself), the
// band's width picks and the script sets it.
function fitHero() {
  simEl.style.removeProperty("--cols");
  const styled = +getComputedStyle(simEl).getPropertyValue("--cols");
  const single = styled ? styled === heroConfig.mobile.cols : simEl.closest(".band").clientWidth < heroConfig.mobile.breakpoint;
  Object.assign(H, { single, cols: single ? heroConfig.mobile.cols : COLS, hover: null, card: null, res: null, resHeld: false, linkHover: false, gitHover: false });
  if (!styled) simEl.style.setProperty("--cols", H.cols);
  drawHero(now());
}
new ResizeObserver(fitHero).observe(simEl.closest(".band"));
fitHero();
simEl.addEventListener("click", () => simEl.focus({ preventScroll: true }));
// Typing reaches moonlander's shell when it has focus: `bun run dev` starts the server.
simEl.addEventListener("keydown", (e) => {
  if (!heroReady || H.focus[H.ws] !== "sh" || H.ws !== "M" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Enter") {
    const cmd = H.typed.trim();
    if (cmd === "bun run dev" && !H.server) Object.assign(H, { server: true, linkAt: now() + 500, typed: "" });
    else if (!H.server) { H.history.push([...prompt("~/moonlander"), [H.typed, A.text]]); if (cmd) H.history.push([[cmd === "clear" ? "" : `zsh: try bun run dev`, A.out]]); if (cmd === "clear") H.history = []; H.typed = ""; }
  } else if (e.key === "Backspace") H.typed = H.typed.slice(0, -1);
  else if (e.key.length === 1 && !H.server) H.typed += e.key;
  else return;
  e.preventDefault();
});
let heroSeen = false;
new IntersectionObserver(([entry]) => {
  heroSeen = entry.isIntersecting;
  if (heroSeen && heroFrom == null) heroFrom = now();
}).observe(simEl);

// Two viewers attach independently; closing one leaves the work running.
const runningEl = document.getElementById("running-desktop");
const runningWindow = document.getElementById("running-window-agent");
const runningStatus = document.getElementById("running-status");
const runningViews = [
  { name: "agent", at: 500, view: session({ single: true, cols: 76 }) },
  { name: "server", at: 2200, view: session({ single: true, cols: 76, ws: "M", focus: { C: "C0", M: "sh" }, server: true, linkAt: -1e9 }) },
].map((v) => ({ ...v, screen: new Screen(document.getElementById(`v-running-${v.name}`), 76, ROWS, { badge: true }) }));
let runningSeen = false, runningFrom = null;
function drawRunning(t) {
  const ms = still ? 6000 : runningFrom == null ? 0 : Math.min(15000, t - runningFrom);
  const detached = ms >= 8000 && ms < 10500;
  runningWindow.classList.toggle("detached", detached);
  runningWindow.setAttribute("aria-hidden", String(detached));
  runningStatus.textContent = detached ? i18n.t`window closed · agents + dev server still running` : i18n.t`agents + dev server · running in the background`;
  for (const v of runningViews) {
    const start = v.name === "agent" && ms >= 10500 ? 10500 : v.at;
    const typed = Math.max(0, Math.min(5, Math.floor((ms - start) / 130)));
    if (ms >= start + 1100) v.screen.paint(crop(v.view.compose(still ? 6000 : t), 0, 0, ROWS, 76));
    else {
      const g = blank(ROWS, 76);
      put(g, 1, 2, "~/dev", T.faint);
      let c = put(g, 2, 2, "$ ", T.faint);
      c = put(g, 2, c, "corgi".slice(0, typed), T.strong);
      put(g, 2, c, " ", T.cursor);
      v.screen.paint(g);
    }
  }
}
new IntersectionObserver(([entry]) => {
  runningSeen = entry.isIntersecting;
  if (runningSeen && runningFrom == null) runningFrom = now();
}, { threshold: 0.25 }).observe(runningEl);
document.getElementById("running-replay").addEventListener("click", () => { runningFrom = now(); drawRunning(runningFrom); });
drawRunning(now());

// ---- features: a slice of a session, what it's about ringed, and rings that
// go together wired. Rings are on the whole session's cells; the slice is
// `crop` [row, column, rows, columns]; `wires` pairs rings by index; `lit`
// is more that stays undimmed, unringed; `edit` changes the whole session's
// frame before it's sliced. `touch` and `cards` say what answers
// the pointer, as for `point`; with `live`, the first touch lifts the dim.
// A slice with neither rings nor `lit` isn't dimmed, and one with the
// review panel open passes it the pointer and keys. A slice goes back to
// how it started once it's out of view.
const cardRect = (s) => { const box = s.cardFor(s.S.ws, s.S.card)[1]; return { r0: box.top, r1: box.bottom, c0: box.left, c1: box.right }; };
// The open card's Recent rows, down to the blank row under them.
function recentRows(g, s) {
  const box = cardRect(s), at = find(g, i18n.t` Recent `, box);
  if (!at) return null;
  let r1 = at.r0 + 1;
  while (r1 + 1 < box.r1 && g[r1 + 1].slice(box.c0 + 1, box.c1).some(([ch]) => ch.trim())) r1++;
  return { r0: at.r0 + 1, r1, c0: box.c0 + 3, c1: box.c1 - 3 };
}

// ---- corgi's pane and tab commands on a session's own layout, answered as
// src/cli.ts answers them. moonlander is workspace 2; its tabs and panes
// carry their IDs. A command run outside Corgi has no calling pane.
const MOON = 2;
const CLI_OPTIONS = new Set(["command", "cwd", "name", "lines", "workspace", "viewer", "width", "height", "before", "after", "right-of", "left-of", "above", "below"]);
const PIPE = Symbol("|"), JSON_OUT = style("muted");
// A command line's words, quotes kept together, with each | apart.
const words = (line) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\|)|([^\s|]+)/g)].map((m) => (m[3] ? PIPE : m[1] ?? m[2] ?? m[4]));
function cliArgs(args) {
  const pos = [], opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    if (!CLI_OPTIONS.has(a.slice(2))) { opt[a.slice(2)] = true; continue; }
    if (i + 1 >= args.length) throw Error("Usage");
    opt[a.slice(2)] = args[++i];
  }
  return { pos, opt };
}
// The help lines for the command `args` names, as src/cli.ts's usage().
function usage(args) {
  const end = args.findIndex((a) => a.startsWith("-")), names = end < 0 ? args : args.slice(0, end);
  for (let n = names.length; n > 0; n--) {
    const prefix = ["corgi", ...names.slice(0, n)].join(" ");
    const lines = helpText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(prefix) && [undefined, " ", "|"].includes(l[prefix.length]));
    if (lines.length) return lines;
  }
  return [];
}
const holds = (node, id) => (node.id ? node.id === id : holds(node.a, id) || holds(node.b, id));
const leafIds = (node) => (node.id ? [node.id] : [...leafIds(node.a), ...leafIds(node.b)]);
const swapLeaf = (node, id, make) => (node.id ? (node.id === id ? make(node) : node) : { ...node, a: swapLeaf(node.a, id, make), b: swapLeaf(node.b, id, make) });
function dropLeaf(node, id) {
  if (node.id) return node.id === id ? null : node;
  const a = dropLeaf(node.a, id), b = dropLeaf(node.b, id);
  return a && b ? { ...node, a, b } : a ?? b;
}
// moonlander's tabs replaced. The viewer keeps its tab, or takes the one
// before it, and a focus that went falls to the tab's first pane.
function retab(S, tabs) {
  const shown = S.tabs.M[S.tab.M]?.tab, at = tabs.findIndex((root) => root.tab === shown);
  S.tabs = { ...S.tabs, M: tabs.length ? tabs : [{ ...pane("blank"), tab: S.nextTab++ }] };
  S.tab.M = at >= 0 ? at : Math.max(0, Math.min(S.tab.M, S.tabs.M.length) - 1);
  if (!S.tabs.M.some((root) => holds(root, S.focus.M))) S.focus.M = leafIds(S.tabs.M[S.tab.M])[0];
}
const closePane = (S, id) => retab(S, S.tabs.M.map((root) => { const kept = dropLeaf(root, id); return kept && { ...kept, title: root.title, tab: root.tab }; }).filter(Boolean));
const locate = (S, id) => ({ pane: S.ids[id], tab: S.tabs.M.find((root) => holds(root, id)).tab, workspace: MOON });
// A tab's splits as `corgi list` words them: `5 left of (7 above 8)`.
const layoutText = (S, node, nested) => {
  if (node.id) return String(S.ids[node.id]);
  const text = `${layoutText(S, node.a, true)} ${node.dir === "right" ? "left of" : "above"} ${layoutText(S, node.b, true)}`;
  return nested ? `(${text})` : text;
};
// `corgi list` for moonlander: its tabs and panes, the panes it started with
// being Claude, which works once a send asks it something.
function listText(S) {
  const out = ['workspace 2 "moonlander" ~/moonlander'];
  for (const root of S.tabs.M) {
    const ids = leafIds(root).filter((k) => S.ids[k]);
    if (!ids.length) continue;
    out.push(`  tab ${root.tab}${root.title ? ` "${root.title}"` : ""}${ids.length > 1 ? `: ${layoutText(S, root)}` : ""}`);
    for (const k of ids) out.push(`    pane ${S.ids[k]}${S.term[k] ? "" : ` claude ${S.asked[k] ? "working" : "idle"}`}`);
  }
  return out.join("\n");
}
function paneArg(S, from, arg) {
  if (arg == null) throw Error("Usage");
  if (arg === "current") { if (!from) throw Error("NoCallerPane"); return from; }
  if (!/^\+?\d+$/.test(arg)) throw Error("InvalidCharacter");
  const id = Object.keys(S.ids).find((k) => S.ids[k] === Number(arg) && S.tabs.M.some((root) => holds(root, k)));
  if (!id) throw Error("NoPane");
  return id;
}
function tabArg(S, from, arg) {
  if (arg == null) throw Error("Usage");
  if (arg === "current" && !from) throw Error("NoCallerPane");
  if (arg !== "current" && !/^\+?\d+$/.test(arg)) throw Error("InvalidCharacter");
  const root = S.tabs.M.find((root) => (arg === "current" ? holds(root, from) : root.tab === Number(arg)));
  if (!root) throw Error("NoTab");
  return root;
}
// A pane `--command` starts: what the command shows, until it exits and
// takes the pane with it. One the page doesn't know shows a hint instead.
const PROGRAMS = { "bun test --watch": TEST_RUN, "bun run dev": DEV_RUN };
const programRows = (S, command) => (command === "bun test --watch" && S.fixed ? TEST_PASS : PROGRAMS[command]);
function newPane(S, command) {
  const id = `sh${S.next}`, run = command && programRows(S, command.trim());
  S.ids = { ...S.ids, [id]: S.next++ };
  S.term[id] = command ? { rows: run ?? [[["zsh: try bun test --watch", A.out]]], typed: "", program: command.trim(), exits: true } : { rows: [], typed: "" };
  return id;
}
function paneText(s, from, id) {
  const p = s.S.term[id];
  if (!p) return plain(s.paneRows(id, now(), (s.layout().find((l) => l.id === id)?.w ?? 62) - 2, false));
  return plain(p.program || id === from ? p.rows : [...p.rows, [...prompt("~/moonlander"), [p.typed, A.text]]]);
}
// Ctrl-C: a shell drops its line, a program stops, and a pane its command
// started closes with it.
function interrupt(S, p, id) {
  if (p.program && p.exits) return closePane(S, id);
  p.rows = [...p.rows, p.program ? [["^C", A.text]] : [...(p.ps ?? prompt("~/moonlander")), [p.typed + "^C", A.text]]];
  Object.assign(p, { program: null, typed: "", scroll: 0 });
}
// Whether a corgi command line asks for JSON: `--json` before any `--`.
const wantsJson = (args) => args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--json");
// What `corgi ARGS` prints, run from the pane `from` (null outside Corgi).
function corgi(s, from, args) {
  const S = s.S, [group, verb] = args;
  const lines = (text) => text.trimEnd().split("\n").map((line) => [[line, A.text]]);
  const ok = (result) => {
    const r = { pane: 0, tab: 0, workspace: 0, text: null, closed_panes: [], ...result };
    if (wantsJson(args)) return [[[JSON.stringify({ ok: true, result: r }), JSON_OUT]]];
    return lines(r.closed_panes.length ? `closed pane ${r.closed_panes.join(", ")}` : r.pane ? `pane ${r.pane} (tab ${r.tab}, workspace ${r.workspace})` : "ok");
  };
  if (group === "--skill") return lines(CLI_SKILL);
  if (!group || group === "help" || args.includes("--help") || args.includes("-h") || (["pane", "tab", "workspace"].includes(group) && args.length === 1)) return lines(i18n.html(CLI_HELP));
  if (group === "current") { if (!from) throw Error("NoCallerPane"); return ok(locate(S, from)); }
  if (group === "list" || (group === "workspace" && verb === "list")) {
    if (args.slice(group === "list" ? 1 : 2).some((a) => a !== "--json")) throw Error("Usage");
    if (!wantsJson(args)) return lines(listText(S));
    const panes = S.tabs.M.flatMap((root) => leafIds(root).filter((k) => S.ids[k]).map((k) => locate(S, k)));
    return [[[JSON.stringify({ ok: true, result: { workspaces: [{ id: MOON, name: "moonlander", cwd: "~/moonlander" }], panes }, viewers: [] }), JSON_OUT]]];
  }
  const { pos, opt } = cliArgs(args.slice(2));
  switch (`${group} ${verb}`) {
    case "pane split": {
      const target = paneArg(S, from, pos[0]), side = ["right", "left", "up", "down"].filter((d) => opt[d]);
      if (pos.length !== 1 || side.length !== 1) throw Error("Usage");
      const id = newPane(S, opt.command), first = side[0] === "left" || side[0] === "up";
      retab(S, S.tabs.M.map((root) => swapLeaf(root, target, ({ title, tab, ...leaf }) =>
        ({ dir: side[0] === "left" || side[0] === "right" ? "right" : "down", ratio: 0.5, a: first ? pane(id) : leaf, b: first ? leaf : pane(id), title, tab }))));
      return ok(locate(S, id));
    }
    case "pane close": {
      const id = paneArg(S, from, pos[0]), n = S.ids[id];
      if (pos.length !== 1) throw Error("Usage");
      closePane(S, id);
      return ok({ closed_panes: [n] });
    }
    case "pane read": {
      const id = paneArg(S, from, pos[0]), count = opt.lines ?? "100";
      if (pos.length !== 1) throw Error("Usage");
      if (!/^\d+$/.test(count)) throw Error("InvalidCharacter");
      if (!Number(count) || Number(count) > 10000) throw Error("Usage");
      const all = paneText(s, from, id).trimEnd().split("\n"), text = all.slice(-Number(count)).join("\n");
      if (opt.json) return ok({ ...locate(S, id), text });
      return lines((all.length > Number(count) ? `[corgi: last ${count} lines shown; --lines N reads more]\n` : "") + text);
    }
    case "pane send": {
      const id = paneArg(S, from, pos[0]), p = S.term[id];
      if (pos.length !== 2) throw Error("Usage");
      // A shell at its prompt takes it as typed, and Enter runs it once the
      // sender's command is done. A quiet agent starts on it.
      if (p && !p.program) {
        p.typed += pos[1];
        if (opt.enter) setTimeout(() => !p.program && runLine(s, p, id, p.typed));
      } else if (!p && S.quiet && opt.enter) S.asked[id] = { text: pos[1], at: now() };
      return ok(locate(S, id));
    }
    case "pane keys": {
      const id = paneArg(S, from, pos[0]), p = S.term[id];
      if (pos.length < 2) throw Error("Usage");
      if (p && pos.slice(1).includes("ctrl+c")) setTimeout(() => interrupt(S, p, id));
      return ok(locate(S, id));
    }
    case "tab new": {
      if (pos.length) throw Error("Usage");
      if (!from && !opt.workspace) throw Error("MissingWorkspace");
      if (opt.workspace && opt.workspace !== String(MOON)) throw Error(/^\+?\d+$/.test(opt.workspace) ? "NoWorkspace" : "InvalidCharacter");
      const id = newPane(S, opt.command);
      retab(S, [...S.tabs.M, { ...pane(id), title: opt.name, tab: S.nextTab++ }]);
      return ok(locate(S, id));
    }
    case "tab rename": {
      const root = tabArg(S, from, pos[0]);
      if (opt.clear ? pos.length !== 1 : pos.length !== 2) throw Error("Usage");
      const where = locate(S, leafIds(root)[0]);
      retab(S, S.tabs.M.map((r) => (r === root ? { ...r, title: opt.clear ? undefined : pos[1] } : r)));
      return ok(where);
    }
    case "tab close": {
      const root = tabArg(S, from, pos[0]), closed = leafIds(root).map((id) => S.ids[id]);
      if (pos.length !== 1) throw Error("Usage");
      retab(S, S.tabs.M.filter((r) => r !== root));
      return ok({ closed_panes: closed });
    }
  }
  if (["workspace", "focus", "pane move", "pane swap", "pane resize", "tab move", "tab merge"].some((c) => `${group} ${verb}`.startsWith(c)))
    return [[["corgi: this page knows list, pane split, read, send, keys, close and tab new, rename, close", A.text]]];
  throw Error("Usage");
}
// The few filters a pipe can end in, or null for one it doesn't know.
function filter(lines, [cmd, ...args]) {
  const count = (fallback) => Number(args[0] === "-n" ? args[1] : args[0]?.replace(/^-/, "")) || fallback;
  switch (cmd) {
    case "grep": { const invert = args[0] === "-v", pattern = args[invert ? 1 : 0] ?? ""; return lines.filter((l) => l.includes(pattern) !== invert); }
    case "head": return lines.slice(0, count(10));
    case "tail": return lines.slice(-count(10));
    case "wc": return [String(lines.length).padStart(8)];
    case "jq": {
      const raw = args[0] === "-r", path = args[raw ? 1 : 0] ?? ".";
      let v;
      try { v = JSON.parse(lines.join("\n")); } catch { return ["jq: error: Cannot parse input as JSON"]; }
      for (const k of path.split(".").filter(Boolean)) v = v?.[k] ?? null;
      return (raw && typeof v === "string" ? v : JSON.stringify(v, null, 2)).split("\n");
    }
  }
  return null;
}
// A line run at the prompt of the terminal `p`, the pane `from` or none.
function runLine(s, p, from, line) {
  Object.assign(p, { rows: [...p.rows, [...(p.ps ?? prompt("~/moonlander")), [line, A.text]]], typed: "", scroll: 0 });
  const stages = [[]];
  for (const word of words(line)) word === PIPE ? stages.push([]) : stages.at(-1).push(word);
  const [[cmd, ...args], ...pipes] = stages;
  if (!cmd) return;
  if (cmd === "clear") return void (p.rows = []);
  const program = programRows(s.S, line.trim());
  if (program) return void Object.assign(p, { rows: [...p.rows, ...program], program: line.trim() });
  if (cmd !== "corgi") return void (p.rows = [...p.rows, [["zsh: try corgi --help", A.out]]]);
  let out = [], err = [];
  try { out = corgi(s, from, args); }
  catch (e) {
    const help = e.message === "Usage" ? usage(args) : [];
    err = wantsJson(args)
      ? [[[JSON.stringify({ ok: false, err: e.message, ...(help.length ? { usage: help } : {}) }), JSON_OUT]]]
      : help.length ? [[["corgi: usage:", A.text]], ...help.map((line) => [["  " + line, A.text]])] : [[[`corgi: ${e.message}`, A.text]]];
  }
  for (const stage of pipes) {
    const next = filter(out.map((row) => plain([row])), stage);
    if (!next) { err = [...err, [[`zsh: command not found: ${stage[0] ?? ""}`, A.text]]]; out = []; break; }
    out = next.map((text) => [[text, A.text]]);
  }
  p.rows = [...p.rows, ...err, ...out];
}
// Keys at a terminal's prompt; ↑ and ↓ walk back through what was run.
function termKey(s, p, from, e) {
  const S = s.S;
  if (e.metaKey || e.altKey) return false;
  if (e.ctrlKey) {
    if (e.key === "c") interrupt(S, p, from);
    else if (e.key === "l" && !p.program) p.rows = [];
    else if (e.key === "u" && !p.program) p.typed = "";
    else return false;
    return true;
  }
  if (p.program) return false;
  switch (e.key) {
    case "Enter":
      if (p.typed.trim()) S.recall = [...S.recall, p.typed];
      S.back = 0;
      runLine(s, p, from, p.typed);
      return true;
    case "Backspace": p.typed = p.typed.slice(0, -1); return true;
    case "ArrowUp": case "ArrowDown":
      S.back = Math.max(0, Math.min(S.recall.length, S.back + (e.key === "ArrowUp" ? 1 : -1)));
      p.typed = S.back ? S.recall[S.recall.length - S.back] : "";
      return true;
  }
  if (Array.from(e.key).length !== 1) return false;
  Object.assign(p, { typed: p.typed + e.key, scroll: 0 });
  return true;
}

// ---- hackable: a terminal outside Corgi types corgi commands, and Corgi
// beside it answers. The script plays while the band is in view and starts
// over when it comes back; clicking the terminal hands it to the visitor.
const CLI_SCRIPT = [
  'corgi pane split 5 --right --command "bun test --watch"',
  "corgi pane read 7 | grep fail",
  'corgi pane send 5 "fix the failing test" --enter',
  'corgi pane split 7 --down --command "bun run dev"',
];
const CLI_INIT = {
  ws: "M", focus: { C: "C0", M: "M0" }, quiet: true,
  tabs: { ...TABS, M: [{ ...named("game", pane("M0")), tab: 1 }, { ...named("art", pane("M1")), tab: 2 }] },
  term: {}, ids: { M0: 5, M1: 6 }, next: 7, nextTab: 3, recall: [], back: 0,
};
const TERM_COLS = 60, CLI_CROP = [0, SW, ROWS, COLS - SW];
const cliBand = (() => {
  const termEl = document.getElementById("v-cli-term"), corgiEl = document.getElementById("v-cli-corgi");
  if (!termEl || !corgiEl) return null;
  const termScreen = new Screen(termEl, TERM_COLS, ROWS), corgiScreen = new Screen(corgiEl, CLI_CROP[3], ROWS);
  const B = { s: null, term: null, step: 0, at: 0, taken: false, shown: false };
  function reset() {
    Object.assign(B, { s: session(CLI_INIT), term: { rows: [], typed: "", ps: [["$ ", A.hint]] }, step: 0, at: now() + 700, taken: false });
    if (!still) return;
    for (const line of CLI_SCRIPT) runLine(B.s, B.term, null, line);
    for (const a of Object.values(B.s.S.asked)) a.at = -Infinity;
    B.step = CLI_SCRIPT.length;
  }
  // A line types at 40 characters a second, runs, and gives Corgi a moment
  // to answer, longer while an agent fixes something; then the next.
  function play(at) {
    if (B.taken || still || at < B.at) return;
    const line = CLI_SCRIPT[B.step];
    if (line == null) return reset();
    B.term.typed = line.slice(0, Math.floor((at - B.at) / 25));
    if (at - B.at < line.length * 25 + 400) return;
    B.s.S.recall = [...B.s.S.recall, line];
    runLine(B.s, B.term, null, line);
    B.step++;
    B.at = at + (B.step === CLI_SCRIPT.length ? 9000 : line.includes(" send ") ? FIX_AFTER + 1500 : 1500);
  }
  function drawTerm(t) {
    const p = B.term, h = ROWS - 2, on = !B.taken || (document.activeElement === termEl && Math.floor(t / 530) % 2 === 0);
    const rows = wrap(p.program ? p.rows : [...p.rows, [...p.ps, [p.typed, A.text], [on ? " " : "", CURSOR]]], TERM_COLS - 2);
    const top = Math.max(0, rows.length - h - (p.scroll ?? 0)), g = blank(ROWS, TERM_COLS);
    rows.slice(top, top + h).forEach((row, n) => { let c = 1; for (const [text, s] of row) c = put(g, 1 + n, c, text, s); });
    termScreen.paint(g);
  }
  reset();
  // The visitor's own typing takes the terminal from the script.
  termEl.addEventListener("focus", () => {
    if (B.taken) return;
    B.taken = true;
    B.term.typed = "";
  });
  termEl.addEventListener("click", () => termEl.focus({ preventScroll: true }));
  termEl.addEventListener("keydown", (e) => { if (termKey(B.s, B.term, null, e)) e.preventDefault(); });
  termEl.addEventListener("paste", (e) => {
    if (B.term.program) return;
    e.preventDefault();
    B.term.typed += e.clipboardData.getData("text").split("\n")[0];
  });
  let wheel = 0;
  termEl.addEventListener("wheel", (e) => {
    const p = B.term, most = Math.max(0, wrap(p.rows, TERM_COLS - 2).length + 1 - (ROWS - 2)), was = p.scroll ?? 0;
    if (document.activeElement !== termEl || (e.deltaY < 0 ? was >= most : was <= 0)) return;
    e.preventDefault();
    wheel += e.deltaMode ? e.deltaY * 20 : e.deltaY;
    const n = Math.trunc(wheel / 20);
    wheel -= n * 20;
    p.scroll = Math.max(0, Math.min(most, was - n));
  }, { passive: false });
  point(corgiEl, () => B.s, CLI_CROP, { touch: "tab pane" });
  new IntersectionObserver(([entry]) => {
    B.shown = entry.isIntersecting;
    if (!B.shown) reset();
    else if (!B.step && !B.taken) B.at = now() + 600;
  }, { threshold: 0.3 }).observe(termEl.closest(".band"));
  return {
    draw(t) {
      if (!B.shown) return;
      play(now());
      drawTerm(t);
      corgiScreen.paint(crop(B.s.compose(t), ...CLI_CROP));
    },
  };
})();

// ---- link cards: Corgi's own, under or over a link in a pane, as a
// pointer resting on it opens it, with Copy link (Copy path for a file) and,
// for an image, its picture, as on a host with Kitty graphics. The page's
// pointer, `rest`, rests a little into the first link, and the card holds
// still. `links` are the links a slice shows, each its text and where it
// goes; `img` is the picture of the one that's an image.
// A cell of the picture's, in hundredths of an em: the screen's .6em by 1.42em.
const PIC_CELL = { width: 60, height: 142 };
function linkCards(f, links, img, rest) {
  let rect = null;
  // The picture's size in the card, as link_thumbnail.ts shrinks it: inside
  // 28 by 10 cells, never enlarged.
  const picture = () => {
    if (!img?.naturalWidth) return null;
    const scale = Math.min((28 * PIC_CELL.width) / img.naturalWidth, (10 * PIC_CELL.height) / img.naturalHeight);
    return { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale), cell: PIC_CELL };
  };
  img?.addEventListener("load", () => f.draw(now()));
  return {
    get rect() { return rect; },
    draw(g, rows) {
      rect = null;
      if (img) img.hidden = true;
      const link = links.map((l) => ({ ...l, at: find(g, l.text, { c0: SW }) })).find((l) => l.at);
      rest?.classList.toggle("on", !!link);
      if (!link) return;
      const anchor = { x: link.at.c0 + 2, y: link.at.r0 };
      Object.assign(rest.style, { left: `calc(${anchor.x - f.c0 + 0.3} * var(--cell))`, top: `calc(${anchor.y - f.r0 + 0.35} * 1.42em)` });
      // The link under the pointer is underlined, as Ghostty draws it.
      for (let c = link.at.c0; c <= link.at.c1; c++) {
        const [ch, st] = g[link.at.r0][c], [fg, bg, bold] = STYLES[st];
        g[link.at.r0][c] = [ch, style(fg, bg, bold, 1, null)];
      }
      const thumbnail = link.image ? picture() : null;
      // The slice's right edge is the terminal's, which keeps the card in.
      rect = linkTooltip.geometry(f.c0 + f.cols, rows, anchor, thumbnail);
      if (!rect) return;
      const out = new Writer();
      linkTooltip.draw(out, rect, { link: { uri: link.uri, ...anchor }, copied: false, thumbnail }, false);
      drawOver(g, out, rows);
      if (!thumbnail) return;
      // Centered in the rows under the copy row's rule, as link_thumbnail.ts places it.
      const room = linkTooltip.thumbnailCells(thumbnail).rows;
      const left = ((rect.x + 1 - f.c0) * PIC_CELL.width + ((rect.w - 2) * PIC_CELL.width - thumbnail.width) / 2) / 100;
      const top = ((rect.y + 3 - f.r0) * PIC_CELL.height + (room * PIC_CELL.height - thumbnail.height) / 2) / 100;
      Object.assign(img.style, { left: `${left}em`, top: `${top}em`, width: `${thumbnail.width / 100}em`, height: `${thumbnail.height / 100}em` });
      img.hidden = false;
    },
  };
}
// The rings that take in a link and its card, once it's open.
const withCard = (at, s) => {
  const r = s.S.linkRect;
  return at && r ? { r0: Math.min(at.r0, r.y), r1: Math.max(at.r1, r.y + r.h - 1), c0: Math.min(at.c0, r.x), c1: Math.max(at.c1, r.x + r.w - 1) } : at;
};

// moonlander running its dev server, in the window beside its sidebar.
const CLEVER = { ws: "M", side: "clever34", tabs: { ...TABS, M: [pane("sh")] }, focus: { C: "C0", M: "sh" }, server: true };
// moonlander's link, once corgi's rows go from over it.
const cleverLink = (g) => find(g, LINK_TEXT, { r0: WS_ROWS.C[0], r1: WS_ROWS.C[0] });
// What's worth reading in each agent's pane, from one of its texts to
// another: the step under way, the question waiting, or the answer.
const INTEREST = {
  C0: ["Bash(zig build test)", "Testing…"], C1: ["Spawned 2 agents", "Working"], C2: ["╭", "╰"],
  C3: ["Compacting…", "Compacting…"], C4: ["Cmd+1–9 now switch tabs.", "Worked for"],
  M0: ["Bash(bun test)", "Tuning…"], M1: ["Two legs", "Doodled"],
};
// Once the visitor reads an agent, its pane's part worth reading, to its
// last written cell.
function interest(g, s) {
  const S = s.S, id = S.focus[S.ws], l = S.readAt != null && s.layout().find((p) => p.id === id), marks = INTEREST[id];
  if (!l || !marks) return null;
  const area = { r0: l.y, r1: l.y + l.h - 1, c0: l.x, c1: l.x + l.w - 1 }, from = find(g, marks[0], area), to = from && find(g, marks[1], { ...area, r0: from.r0 });
  if (!to) return null;
  let c0 = area.c1, c1 = area.c0;
  for (let r = from.r0; r <= to.r0; r++) for (let c = area.c0; c <= area.c1; c++) if (g[r][c][0] !== " ") { c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  return { r0: from.r0, r1: to.r0, c0, c1 };
}
const moonOnly = (g) => g.forEach((row, r) => r >= WS_ROWS.C[0] && row.splice(0, SW - 1, ...g[Math.min(r + 3, g.length - 1)].slice(0, SW - 1)));
const FEATURES = {
  // Each agent's state, and the unread one waiting behind the workspace's pill.
  // Nothing dims, so the screen keeps one ground with the box around it;
  // reading an agent rings what's worth reading in its pane.
  // The slice starts at the workspaces and ends where the pane's lines do,
  // so the box's padding is the same all round; past the sidebar, `split`,
  // it takes the pane's ground.
  agents: { init: { clear: 1, newButton: false, solo: true, compacting: true }, crop: [2, 1, 21, 78], split: SW, touch: "unread agent ws", live: true,
    rings: (g) => [find(g, unreadLabel(1), { r0: 3, r1: 3 }), agentRows(4)], dim: false, focus: interest },
  steps: { init: { hover: 0, card: 0 }, crop: [7, 0, 16, 122], touch: "agent", cards: "keep", rings: (g, s) => [agentRows(s.S.card), recentRows(g, s)], wires: [[0, 1]], lit: (g, s) => [cardRect(s)] },
  // moonlander's thruster tuning, idle under its worktree with the sprite's
  // agent in another, and its changes in the review panel, which has the
  // keyboard as Corgi gives it on opening. The rest of the sidebar and the
  // agent's pane dim.
  reviews: { init: { ws: "M", side: "review24", idle: true, review: true, reviewKeys: true, tabs: { ...TABS, M: [pane("M0")] } }, crop: [0, 0, 24, 124],
    // The thrusters' worktree heading and its agent's two rows, and the review panel.
    lit: (g, s) => {
      const w = F.review24[0].length, tree = find(g, "⌥", { c1: w - 1 });
      return [{ r0: tree.r0, r1: tree.r0 + 2, c0: 0, c1: w - 2 }, { r0: 0, r1: s.S.rows - 1, c0: COLS - REVIEW_W, c1: COLS - 1 }];
    } },
  // moonlander alone, its worktree overview open, live, with its brief of
  // each worktree, over an empty pane; the sidebar lights the agents of the
  // worktree it browses, as Corgi does, and Review changes opens the panel.
  worktrees: { init: { ws: "M", alone: true, lights: "wt34", side: "wt34_0", reviewable: true, rows: WT_ROWS, trees: "moonlander alone", single: true, newButton: false, tabs: { ...TABS, M: [named("game", pane("blank"))] } }, crop: [0, 0, WT_ROWS, 124] },
  // Smart Links: moonlander, alone in the sidebar, runs its dev server, and
  // the server's page names the link on moonlander's row. A phone shows the
  // link through to the server's URL.
  clever: { init: CLEVER, crop: [0, 0, 15, 124], phone: [16, 56],
    // corgi's rows go, and the rest of the sidebar moves up.
    edit: moonOnly,
    rings: (g) => [cleverLink(g), find(g, "➜  Local:   http://localhost:3000/", { c0: SW })],
    wires: [[0, 1]],
    // The window beside the sidebar, below its tab bar.
    lit: (g, s) => [{ r0: 1, r1: s.S.rows - 1, c0: SW, c1: COLS - 1 }] },
  // The same window with moonlander's worktree overview open from its
  // badge, a ring on the brief Corgi wrote of each worktree. A phone shows
  // the badge on.
  briefs: { init: { ...CLEVER, trees: "moonlander" }, crop: [0, 0, 18, 124], phone: [16, 56],
    rings: (g, s) => s.S.trees.data.briefs.map((b) => find(g, b.label, { c0: SW })),
    // The card, and its badge with the line between them.
    lit: (g, s) => {
      const o = s.S.trees, card = treesRect(o, s.S.rows), badge = treesBadge(o);
      return [{ r0: card.y, r1: card.y + card.h - 1, c0: card.x, c1: card.x + card.w - 1 }, { r0: badge.y, r1: badge.y, c0: badge.x, c1: card.x }];
    } },
  // The thruster tuning's pull request, its link's card open. A phone shows
  // the pane and the card.
  links: { init: { ws: "M", side: "clever34", rows: 15, tabs: { ...TABS, M: [pane("M0")] }, focus: { C: "C0", M: "M0" }, pr: true },
    crop: [0, 0, 15, 124], phone: [SW, 56], edit: moonOnly,
    links: [{ text: PR.text, uri: PR.text }],
    rings: (g, s) => [withCard(find(g, PR.text, { c0: SW }), s)],
    lit: (g, s) => [{ r0: 1, r1: s.S.rows - 1, c0: SW, c1: COLS - 1 }] },
  // The thruster tuning's screenshot of the game, its card showing the
  // picture. A phone shows the pane and the card.
  shots: { init: { ws: "M", side: "clever34", tabs: { ...TABS, M: [pane("M0")] }, focus: { C: "C0", M: "M0" }, shot: true },
    crop: [0, 0, 20, 124], phone: [SW, 56], edit: moonOnly,
    links: [{ ...SHOT, image: true }],
    rings: (g, s) => [withCard(find(g, SHOT.text, { c0: SW }), s)],
    lit: (g, s) => [{ r0: 1, r1: s.S.rows - 1, c0: SW, c1: COLS - 1 }] },
  // moonlander's resource card on the GPU host, open beside its workspace's
  // row over one empty pane, its autopilot training on all eight GPUs. As in
  // corgi, its rows hold still under the pointer, a click on a heading sorts
  // by that column, pointing at a graph's history shows that moment and who
  // led it, and corgi's row opens corgi's.
  resources: { init: { res: "M", host: "gpus", side: "res34", rows: 38, tabs: { ...TABS, C: [named("fixes", pane("blank")), ...TABS.C.slice(1)] } }, crop: [0, 0, 38, 117], touch: "res", cards: "keep",
    rings: (g, s) => {
      const ws = s.S.res, card = resRectAt(ws, s.S.rows, s.S.host);
      return [{ r0: RES_ROW[ws], r1: RES_ROW[ws], c0: 1, c1: SW - 3 }, { r0: card.y, r1: card.y + card.h - 1, c0: card.x, c1: card.x + card.w - 1 }];
    },
    wires: [[0, 1]] },
};

// How far a ring's line keeps off its cells, across and down, in em.
const RING_PAD = [0.45, 0.08];
const SVG = "http://www.w3.org/2000/svg";
const el = (tag, cls, html = "") => Object.assign(document.createElement(tag), { className: cls, innerHTML: html });

// ---- wires: from one ring to another, through blank cells
const STEPS4 = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // right, down, left, up
const TURN = 5, CROSS = 6, GAP = 30;
// Cells a wire may pass: blanks freely, a line only straight across it.
function kinds(g, blocked) {
  const rows = g.length, cols = g[0].length, n = rows * cols, cost = new Float32Array(n).fill(Infinity), line = new Uint8Array(n), gap = new Uint8Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const ch = g[r][c][0], i = r * cols + c;
    if (blocked(r, c)) continue;
    if (ch === " ") cost[i] = 0;
    else if (ch === "│") { cost[i] = CROSS; line[i] = 1; }
    else if (ch === "─") { cost[i] = CROSS; line[i] = 2; }
    gap[i] = ch === " " && c > 0 && c < cols - 1 && /\S/.test(g[r][c - 1][0]) && /\S/.test(g[r][c + 1][0]) ? 1 : 0;
  }
  return { rows, cols, cost, line, gap };
}
// Cheapest wire from a target's edge to a cell beside the box `b`, which may
// lie just outside the grid.
function route(k, t, b) {
  const { rows: ROWS, cols: COLS, cost, line, gap } = k, N = ROWS * COLS * 4, dist = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), heap = [];
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

class Feature {
  constructor(band, spec) {
    [this.r0, this.c0, this.rows, this.cols] = spec.crop;
    this.spec = spec; this.band = band; this.name = band.dataset.feature;
    this.session = session(spec.init);
    this.el = band.querySelector(".screen");
    // The page holds the slice's size before this runs; keep it in step.
    const held = ["--rows", "--cols"].map((v) => +this.el.style.getPropertyValue(v));
    if (held[0] !== this.rows || held[1] !== this.cols) console.warn(`${this.name}: index.html holds ${held.join("×")}, the crop is ${this.rows}×${this.cols}`);
    // With `phone` ([first column, columns]), a phone shows only those columns,
    // larger: index.html holds their count as --phone-cols, which the
    // stylesheet makes --cols there.
    const phoneHeld = +this.el.style.getPropertyValue("--phone-cols") || undefined;
    if (phoneHeld !== spec.phone?.[1]) console.warn(`${this.name}: index.html holds ${phoneHeld} phone columns, the phone crop has ${spec.phone?.[1]}`);
    this.el.style.setProperty("--rows", this.rows);
    this.el.style.setProperty("--cols", this.cols);
    this.fit();
    if (spec.phone) new ResizeObserver(() => this.fit()).observe(this.el.closest(".band"));
    this.stage = this.el.parentElement;
    this.plan = null;
    if (spec.split != null) new ResizeObserver(() => this.splitAt()).observe(this.stage);
    // All but what it's about dims, with a ring on each thing it's about.
    if (spec.rings || spec.lit) {
      this.stage.classList.add("marked");
      const dim = document.createElementNS(SVG, "svg"), wire = document.createElementNS(SVG, "svg");
      dim.classList.add("sim-dim"); wire.classList.add("sim-wire");
      if (spec.dim === false) dim.style.display = "none";
      this.marks = { dim, wire, rings: [] };
      this.stage.append(dim, wire);
    }
    if (spec.focus) this.stage.append((this.focusRing = el("div", "sim-focus")));
    this.live = false;
    if (spec.links) this.cards = linkCards(this, spec.links, this.el.querySelector(".shot"), this.el.querySelector(".cursor"));
    if (spec.touch) point(this.el, () => this.session, () => [this.r0, this.c0, this.rows, this.cols], { touch: spec.touch, cards: spec.cards, touched: () => this.touched() });
    if (this.session.review || spec.init.reviewable) reviewInput(this.el, () => this.session, spec.crop);
    // A ringed overview holds still.
    if (this.session?.S.trees && !spec.rings) {
      treesInput(this.el, () => this.session, spec.crop, () => this.play());
      lendKeys(this.el);
    }
  }
  // The crop the stylesheet sized the screen for: the phone's, or the whole.
  fit() {
    const phone = this.spec.phone && +getComputedStyle(this.el).getPropertyValue("--cols") === this.spec.phone[1];
    const [c0, cols] = phone ? this.spec.phone : [this.spec.crop[1], this.spec.crop[3]];
    if (this.screen && c0 === this.c0 && cols === this.cols) return;
    [this.c0, this.cols] = [c0, cols];
    this.el.querySelectorAll(":scope > .r, :scope > .badge").forEach((node) => node.remove());
    this.screen = new Screen(this.el, cols, this.rows, { badge: this.r0 === 0 && c0 === 0 });
    if (this.full) this.draw(now());
    this.splitAt();
  }
  // Where the box's padding turns from the sidebar's ground to the pane's.
  splitAt() {
    if (this.spec.split == null || !this.stage) return;
    const box = this.stage.getBoundingClientRect(), term = this.el.getBoundingClientRect();
    const at = term.left - box.left - this.stage.clientLeft + (this.spec.split - this.c0) * (term.width / this.cols);
    this.stage.style.setProperty("--split", `${at}px`);
  }
  // Every animation frame while a removal plays, not the 50 ms tick.
  play() {
    if (this.playing) return;
    this.playing = true;
    const frame = () => {
      this.draw(now());
      if (this.session.S.trees.card.removal.phase !== "idle" && inView.has(this)) requestAnimationFrame(frame);
      else this.playing = false;
    };
    requestAnimationFrame(frame);
  }
  touched() {
    if (!this.spec.live) return;
    this.live = true;
    this.stage.classList.add("live");
  }
  reset() {
    this.session = session(this.spec.init);
    this.live = false;
    this.stage.classList.remove("live");
  }
  draw(t) {
    const s = this.session;
    // The herd, and the compaction's clock, wait until the whole slice is on screen.
    if (s.S.compacting && s.S.herdAt == null) {
      const box = this.el.getBoundingClientRect();
      if (box.top >= 0 && box.bottom <= innerHeight) s.S.herdAt = now();
    }
    const full = s.compose(t);
    this.spec.edit?.(full);
    if (this.cards) { this.cards.draw(full, s.S.rows); s.S.linkRect = this.cards.rect; }
    this.full = full;
    const g = crop(full, this.r0, this.c0, this.rows, this.cols);
    this.screen.paint(g);
    if (this.focusRing) this.focus(this.live ? this.spec.focus(full, s) : null);
    if (this.live || !this.marks) return;
    const local = (q) => ({ r0: q.r0 - this.r0, r1: q.r1 - this.r0, c0: q.c0 - this.c0, c1: q.c1 - this.c0 });
    this.mark(g, (this.spec.rings?.(full, s) ?? []).filter(Boolean).map(local), (this.spec.lit?.(full, s) ?? []).map(local));
  }
  // A ring on the cells of `q`, in the whole session's cells, or none.
  focus(q) {
    const ring = this.focusRing;
    ring.classList.toggle("on", !!q);
    if (!q) return;
    const box = this.stage.getBoundingClientRect(), term = this.el.getBoundingClientRect();
    const cw = term.width / this.cols, rh = term.height / this.rows, em = parseFloat(getComputedStyle(this.el).fontSize);
    const x = term.left - box.left - this.stage.clientLeft + this.stage.scrollLeft, y = term.top - box.top - this.stage.clientTop + this.stage.scrollTop;
    const [padX, padY] = [RING_PAD[0] * em, RING_PAD[1] * em + 0.12 * em];
    const left = x + (q.c0 - this.c0) * cw - padX, top = y + (q.r0 - this.r0) * rh - padY;
    Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${(q.c1 - q.c0 + 1) * cw + 2 * padX}px`, height: `${(q.r1 - q.r0 + 1) * rh + 2 * padY}px` });
  }
  mark(g, targets, lit) {
    const stage = this.stage, box = stage.getBoundingClientRect(), term = this.el.getBoundingClientRect();
    const cw = term.width / this.cols, rh = term.height / this.rows;
    const x = term.left - box.left - stage.clientLeft + stage.scrollLeft, y = term.top - box.top - stage.clientTop + stage.scrollTop;
    const e = this.marks;
    while (e.rings.length < targets.length) { const ring = el("div", "sim-ring"); e.rings.push(ring); stage.append(ring); }
    // A ring's line keeps a little off its cells, except where a side meets
    // a line of corgi's own: then it runs on it, a border beside it or an
    // agent's separator above it.
    const em = parseFloat(getComputedStyle(this.el).fontSize), padX = RING_PAD[0] * em, padY = RING_PAD[1] * em, rule = 0.12 * em + 0.5;
    const border = (c, t) => { for (let r = t.r0; r <= t.r1; r++) if (g[r]?.[c]?.[0] !== "│") return false; return true; };
    const separator = (r, t) => { let n = 0; for (let c = t.c0; c <= t.c1; c++) if (STYLES[g[r]?.[c]?.[1]]?.[3]) n++; return n * 2 > t.c1 - t.c0 + 1; };
    const ringOf = (t) => {
      const left = border(t.c0 - 1, t) ? (t.c0 - 0.5) * cw : t.c0 * cw - padX, right = border(t.c1 + 1, t) ? (t.c1 + 1.5) * cw : (t.c1 + 1) * cw + padX;
      const top = t.r0 * rh - (separator(t.r0 - 1, t) ? rule : padY), bottom = (t.r1 + 1) * rh + padY;
      return { x: x + left, y: y + top, w: right - left, h: bottom - top };
    };
    // Each ring's box is its line's center line, the border astride it.
    targets.forEach((t, k) => { const q = ringOf(t); Object.assign(e.rings[k].style, { left: `${q.x - 0.5}px`, top: `${q.y - 0.5}px`, width: `${q.w + 1}px`, height: `${q.h + 1}px` }); });
    // The dim: the whole slice, with a hole over each ring.
    const tw = this.cols * cw, th = this.rows * rh;
    const holes = targets.map((t) => { const q = ringOf(t); return `<rect x="${q.x - x - 0.5}" y="${q.y - y - 0.5}" width="${q.w + 1}" height="${q.h + 1}" rx="6"/>`; }).join("")
      + lit.map((t) => `<rect x="${t.c0 * cw}" y="${t.r0 * rh}" width="${(t.c1 - t.c0 + 1) * cw}" height="${(t.r1 - t.r0 + 1) * rh}"/>`).join("");
    if (e.dim.dataset.holes !== holes + tw) {
      e.dim.dataset.holes = holes + tw;
      Object.assign(e.dim.style, { left: `${x}px`, top: `${y}px`, width: `${tw}px`, height: `${th}px` });
      e.dim.setAttribute("viewBox", `0 0 ${tw} ${th}`);
      e.dim.innerHTML = `<defs><mask id="hole-${this.name}"><rect width="${tw}" height="${th}" fill="#fff"/><g fill="#000">${holes}</g></mask></defs><rect width="${tw}" height="${th}" mask="url(#hole-${this.name})"/>`;
    }
    // Wires, routed once a layout: from a ring's edge, through cell centers,
    // turning only at right angles, into the other ring's side.
    const key = JSON.stringify(targets);
    if (this.plan?.key !== key) {
      const inRing = (r, c) => targets.some((t) => r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1);
      const wires = (this.spec.wires ?? []).map(([a, b]) => {
        const from = targets[a], to = targets[b];
        return from && to && route(kinds(g, inRing), from, { r: to.r0, c: to.c0, w: to.c1 - to.c0 + 1, h: to.r1 - to.r0 + 1 });
      });
      this.plan = { key, wires };
    }
    // Through cell centers on whole pixels, its ends on the rings' lines.
    const cx = (c) => Math.round((c + 0.5) * cw) + 0.5, cy = (r) => Math.round((r + 0.5) * rh) + 0.5;
    let d = "";
    this.plan.wires.forEach((wv, k) => {
      if (!wv) return;
      const [a, b] = this.spec.wires[k], from = ringOf(targets[a]), to = ringOf(targets[b]), first = wv.cells[0], last = wv.cells[wv.cells.length - 1];
      const [fx, fy, tx, ty] = [from.x - x, from.y - y, to.x - x, to.y - y];
      const start = [[fx + from.w, cy(first.r)], [cx(first.c), fy + from.h], [fx, cy(first.r)], [cx(first.c), fy]][wv.out];
      const end = [[tx, cy(last.r)], [cx(last.c), ty], [tx + to.w, cy(last.r)], [cx(last.c), ty + to.h]][wv.into];
      const pts = [start, ...wv.cells.map((q) => [cx(q.c), cy(q.r)]), end];
      const knees = pts.filter((pt, i) => i === 0 || i === pts.length - 1 || !((pt[0] === pts[i - 1][0] && pt[0] === pts[i + 1][0]) || (pt[1] === pts[i - 1][1] && pt[1] === pts[i + 1][1])));
      d += "M" + knees.map((pt) => pt.join(" ")).join(" L");
    });
    if (e.wire.dataset.d !== d + tw) {
      e.wire.dataset.d = d + tw;
      Object.assign(e.wire.style, { left: `${x}px`, top: `${y}px`, width: `${tw}px`, height: `${th}px` });
      e.wire.innerHTML = `<path d="${d}"/>`;
    }
  }
}
const features = [...document.querySelectorAll("[data-feature]")].map((band) => new Feature(band, FEATURES[band.dataset.feature]));
const inView = new Set();
const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
  const f = features.find((x) => x.stage === entry.target);
  if (entry.isIntersecting) inView.add(f);
  else { inView.delete(f); f.reset(); }
}));
features.forEach((f) => { seen.observe(f.stage); f.draw(0); });

// F1 jumps to the next unread agent, as in corgi, in the agents slice,
// scrolling it into view first.
const away = features.find((f) => f.name === "agents"), f1 = document.getElementById("f1");
document.addEventListener("keydown", (e) => {
  if (e.key !== "F1" || e.metaKey || e.ctrlKey || e.altKey || !away) return;
  e.preventDefault();
  const box = away.stage.getBoundingClientRect(), shown = box.top >= 0 && box.bottom <= innerHeight;
  away.stage.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  setTimeout(() => {
    if (away.session.unread()) { act(away.session, { kind: "unread" }); away.touched(); }
    f1.classList.remove("flash");
    void f1.offsetWidth;
    f1.classList.add("flash");
  }, shown || still ? 0 : 450);
});

// ---- tab tricks: the pointer right-clicks Ghostty keybindings' tab and
// picks Close from corgi's tab menu. The tab goes, its row in the sidebar
// with it, and the tab before it, a shell, shows, as in corgi. Then
// Ctrl-Shift-T shows, and its keys go down: both come back where they were,
// the agent's old screen faded under its Restoring card until it draws. It
// starts once the whole screen is in view and loops, from the top each time
// it comes back. A phone shows the window alone, 56 columns.
const TRICKS_TABS = { ...TABS, C: [...TABS.C.slice(0, 2), named("shell", pane("sh")), TABS.C[2]] };
// When each step starts, in ms from the start.
const TRICK = { toTab: 400, menu: 1300, toClose: 1700, closed: 2700, gone: 3200, keys: 3600, press: 4400, up: 5000, keysGone: 5800, loop: 10000 };
const UNDO_KEYS = ["Ctrl", "Shift", "T"].map((key, i) => ({ key, down: TRICK.press + i * 120 }));
const REOPENED_AT = UNDO_KEYS.at(-1).down + 60, RESTORED_AFTER = 2300, UNFADE = 400, TRICKS_PHONE = 56;
// The agent's tab, where the pointer right-clicks it.
const TRICK_TAB = { x: SW + TRICKS_TABS.C.slice(0, 3).reduce((x, root, i) => x + tabWidth(root, i), 0) + 4, y: 0 };
const tricksBand = (() => {
  const screenEl = document.getElementById("v-tricks"), keysEl = document.getElementById("tricks-keys"), cursorEl = screenEl?.querySelector(".cursor"), kbd = document.getElementById("undo-close");
  if (!screenEl) return null;
  const stage = screenEl.parentElement, caps = UNDO_KEYS.map((k) => el("kbd", "", k.key)), menu = new TabMenu({ tab: 0, anchor_x: TRICK_TAB.x });
  keysEl.replaceChildren(...caps);
  const init = { tabs: TRICKS_TABS, tab: { C: 3, M: 0 }, focus: { C: "C4", M: "M0" }, read: [4], term: { sh: { rows: [], typed: "", ps: prompt("~/dev/corgi") } } };
  const B = { s: session(init), from: null, shown: false, last: 0, phone: null, c0: 0, cols: COLS, screen: null };
  // An agent closed: its two rows go, and the separator above them.
  function dropRow(g, i) {
    const top = WATCH_ROWS[i], ground = g[ROWS - 1];
    for (let c = 0; c < SW - 1; c++) {
      g[top][c] = g[top + 1][c] = [" ", ground[c][1]];
      const [ch, s] = g[top - 1][c], [fg, bg, bold] = STYLES[s];
      g[top - 1][c] = [ch, style(fg, bg, bold)];
    }
  }
  // Reopened `ms` ago: corgi's restoring card, centered on the pane as corgi
  // centers it, over the faded old screen, its dig row from the flipbook;
  // then the screen comes up as the agent draws.
  function restoring(g, ms) {
    const l = B.s.layout().find((p) => p.id === "C4"), k = 0.6 * (1 - Math.min(1, Math.max(0, (ms - RESTORED_AFTER) / UNFADE)));
    if (k > 0) for (let r = l.y; r < l.y + l.h; r++) for (let c = l.x; c < l.x + l.w; c++) g[r][c] = [g[r][c][0], faded(g[r][c][1], k)];
    if (ms >= RESTORED_AFTER) return;
    const pre = B.phone ? "p" : "", card = F[`${pre}reopen`], dig = F[`${pre}reopen_dig`], end = dig[dig.length - 1][0];
    const left = card[0].findIndex(([ch]) => ch === "╭"), right = card[0].findIndex(([ch]) => ch === "╮");
    const row = card.findIndex((cells) => cells.every(([ch], c) => ch === end[c][0]));
    const top = l.y + Math.floor((l.h - card.length) / 2);
    card.forEach((cells, r) => {
      const from = r === row ? dig[Math.min(Math.floor(ms / 80), dig.length - 1)][0] : cells;
      for (let c = left; c <= right; c++) g[top + r][l.x + c] = from[c];
    });
  }
  // The pointer: in the pane, then on the tab, then on the menu's Close,
  // which lights once it's there. It presses for each click.
  function pointer(ms) {
    const b = menu.bounds(B.s.S.cols, ROWS), close = { x: b.x + 9, y: b.y + b.padding + 2 };
    const at = ms < TRICK.toTab ? { x: TRICK_TAB.x + 8, y: 11 } : ms < TRICK.toClose ? TRICK_TAB : close;
    Object.assign(cursorEl.style, { left: `calc(${at.x - B.c0 + 0.3} * var(--cell))`, top: `calc(${at.y + 0.35} * 1.42em)` });
    const pressed = (click) => ms >= click - 150 && ms < click;
    cursorEl.classList.toggle("on", ms < TRICK.gone && !still);
    cursorEl.classList.toggle("jump", ms < TRICK.toTab);
    cursorEl.classList.toggle("over", ms >= TRICK.toClose + 450 && ms < TRICK.closed);
    cursorEl.classList.toggle("press", pressed(TRICK.menu) || pressed(TRICK.closed));
    menu.highlighted = ms >= TRICK.toClose + 450 ? 2 : 0;
  }
  function draw(t) {
    if (B.shown && B.from == null && !still) {
      const box = stage.getBoundingClientRect();
      if (box.top >= 0 && box.bottom <= innerHeight) B.from = t;
    }
    const ms = still ? REOPENED_AT + 1900 : B.from == null ? 0 : (t - B.from) % TRICK.loop, S = B.s.S, closed = ms >= TRICK.closed && ms < REOPENED_AT;
    S.tabs = closed ? { ...TRICKS_TABS, C: TRICKS_TABS.C.slice(0, -1) } : TRICKS_TABS;
    S.tab.C = closed ? 2 : 3;
    S.focus.C = closed ? "sh" : "C4";
    pointer(ms);
    const g = B.s.compose(t);
    if (closed) dropRow(g, 4);
    else if (ms >= REOPENED_AT) restoring(g, ms - REOPENED_AT);
    else if (ms >= TRICK.menu) {
      const out = new Writer();
      menu.draw(out, S.cols, ROWS);
      drawOver(g, out, ROWS);
    }
    B.screen.paint(crop(g, 0, B.c0, ROWS, B.cols));
    keysEl.classList.toggle("on", ms >= TRICK.keys && ms < TRICK.keysGone);
    UNDO_KEYS.forEach((k, i) => caps[i].classList.toggle("down", ms >= k.down && ms < TRICK.up));
    if (B.last < REOPENED_AT && ms >= REOPENED_AT && !still) {
      kbd.classList.remove("flash");
      void kbd.offsetWidth;
      kbd.classList.add("flash");
    }
    B.last = ms;
  }
  // A phone's stylesheet gives the screen 56 columns: the window alone, as wide.
  function fit() {
    const phone = +getComputedStyle(screenEl).getPropertyValue("--cols") === TRICKS_PHONE;
    if (phone === B.phone) return;
    Object.assign(B, { phone, c0: phone ? SW : 0, cols: phone ? TRICKS_PHONE : COLS });
    B.s.S.cols = B.c0 + B.cols;
    screenEl.querySelectorAll(":scope > .r, :scope > .badge").forEach((node) => node.remove());
    B.screen = new Screen(screenEl, B.cols, ROWS, { badge: !phone });
    keysEl.style.left = `calc(${(SW + B.s.S.cols) / 2 - B.c0} * var(--cell))`;
    draw(now());
  }
  fit();
  new ResizeObserver(fit).observe(stage.closest(".band"));
  new IntersectionObserver(([entry]) => {
    B.shown = entry.isIntersecting;
    if (B.shown) return;
    Object.assign(B, { from: null, last: 0 });
    draw(now());
  }).observe(stage);
  return { draw: (t) => B.shown && draw(t) };
})();

// Rows of runs at the bottom of a screen, a column in from its left edge.
function bottomGrid(rows, cols, height) {
  const g = blank(height, cols), top = height - rows.length;
  rows.forEach((runs, n) => {
    if (top + n < 0) return;
    let c = 1;
    for (const [text, s] of runs) c = put(g, top + n, c, ellipsis(text, cols - 1 - c), s);
  });
  return g;
}

// ---- keeping pace: one agent's pane twice, over a link that drops for
// 20 s while the agent writes walls of output and finishes. Without pacing,
// the output queued behind the drop replays, every screen of it: the link
// drains `link` times as fast as live, and each row of output costs a share
// of it, so the walls replay slowly and the pane settles `catchup` ms after
// the link is back. Corgi shows the finished pane about when the link is.
// Times are the story's; the page plays them `speed` times as fast and stops
// at PACE_END, a moment after both are back.
const PACE = { cols: 44, rows: 13, speed: 8, stall: [4000, 24000], catchup: 10000, link: 5, flush: 400 };
const ADD = style("accent"), DEL = style("hot");
const call = (at, verb, arg, out) => [[at, [["⏺ ", A.done], [verb, A.tool], [`(${arg})`, A.text]]], [at + 700, [["  ⎿  " + out, A.out]]]];
// An edit as Claude Code shows it, its diff numbered, all at once.
function edit(at, file, line, diff) {
  const count = (op) => diff.filter(([o]) => o === op).length;
  return [
    [at, [["⏺ ", A.done], ["Update", A.tool], [`(${file})`, A.text]]],
    [at, [[`  ⎿  ${count("+")} additions, ${count("-")} removals`, A.out]]],
    ...diff.map(([op, code]) => [at, [[`  ${String(op === "-" ? line : line++).padStart(4)} ${op} ${code}`, op === "+" ? ADD : op === "-" ? DEL : A.out]]]),
  ];
}
// While the link is down, the agent works through the gear in quick steps,
// each with its output: walls for plain SSH to replay.
const WALL_FILES = ["src/lander.ts", "src/gear.ts", "src/physics.ts", "src/hud.ts", "src/legs.ts", "test/landing.test.ts"];
const WALL_CODE = [
  "const sq = this.gear.squash();", "const f = K * sq - C * this.vy;", "this.vy += (f - G) * dt;", "this.y = Math.max(0, this.y);",
  "if (sq > MAX) this.crash();", 'hud.gauge("gear", sq / MAX);', "expect(l.bounces).toBe(1);", "k = 0.4; c = 1.8; rest = 0.6;",
  "for (const leg of this.legs) {", "  leg.step(dt, this.vy);", "}", 'emit("touchdown", this.vy);', "this.t += dt;",
  "const rest = this.gear.rest;", "return Math.max(0, rest - y);", 'test("settles", () => {',
];
const WALL_SAYS = ["Each leg springs on its own now.", "The HUD shows the squash.", "Damping was too low; raising `c`.", "One more test for a hard drop."];
function wall(from, to, step) {
  const rows = [];
  let seed = 7;
  const pick = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n;
  for (let at = from, i = 0; at < to; at += step, i++) {
    if (i % 6 === 2) rows.push([at, say(WALL_SAYS[Math.floor(i / 6) % WALL_SAYS.length])[0]]);
    else if (i % 6 === 5) rows.push(...call(at, "Bash", "bun test", `${44 + i} pass, ${pick(3)} fail`));
    else {
      const diff = Array.from({ length: 5 + pick(6) }, () => [["+", "+", "-", " "][pick(4)], "  " + WALL_CODE[pick(WALL_CODE.length)]]);
      rows.push(...edit(at, WALL_FILES[pick(WALL_FILES.length)], 10 + pick(200), diff));
    }
  }
  return rows;
}
const PACE_LOG = [
  ...call(500, "Read", "src/physics.ts", "Read 412 lines"),
  [1800, say("The gear has no spring: `k` is 0.")[0]],
  ...call(3000, "Update", "src/physics.ts", "1 addition, 1 removal"),
  ...wall(4400, 20000, 400),
  ...call(20400, "Bash", "bun test", "64 pass, 0 fail"),
  ...call(21200, "Bash", "git commit -am 'Spring the gear'", "1 commit"),
  [22200, say("Done: it lands with one soft bounce now.")[0]],
];
// The agent finishes before the link is back.
const PACE_DONE = PACE_LOG.at(-1)[0];
// The link each row of output costs, so the replay of the rows written since
// the drop ends `catchup` ms after the link is back.
const PACE_ROW = (PACE.stall[0] - PACE.stall[1] + (PACE.link - 1) * PACE.catchup) / PACE_LOG.filter(([at]) => at > PACE.stall[0]).length;
// How much link the story up to `d` takes, and how far plain SSH's replay
// has got T into it, once the link is back.
const paceCost = (d) => d + PACE_ROW * PACE_LOG.filter(([at]) => at <= d).length;
function replayed(T) {
  const [from, to] = PACE.stall, budget = paceCost(from) + PACE.link * (T - to);
  let lo = from, hi = T;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (paceCost(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}
const PLAIN_BACK = PACE.stall[1] + PACE.catchup, PACE_END = PLAIN_BACK + 4000;
// When a side is back: Corgi a moment after the link, plain SSH once its
// replay has caught up.
const paceBack = (paced) => (paced ? PACE.stall[1] + PACE.flush : PLAIN_BACK);
// What a side shows at T into the loop: frozen through the drop, then
// replaying, or back at once.
function paceShown(T, paced) {
  const [from, to] = PACE.stall;
  if (T < from || T >= paceBack(paced)) return T;
  return T < to || paced ? from : replayed(T);
}
function paceGrid(d) {
  const spin = SPIN_CLAUDE[Math.floor(d / 120 / PACE.speed) % SPIN_CLAUDE.length];
  const status = d < PACE_DONE
    ? [[spin + " Springing… ", ORANGE], [`(${Math.floor(27 + d / 1000)}s · ↓ ${(0.4 + d / 9000).toFixed(1)}k tokens)`, A.hint]]
    : [[`✻ Worked for ${Math.floor(27 + PACE_DONE / 1000)}s`, A.hint]];
  return bottomGrid([...ask("make the landing gear springy"), [], ...PACE_LOG.filter(([at]) => at <= d).map(([, row]) => row), [],
    status, [], ...claudeBottom(PACE.cols - 2)], PACE.cols, PACE.rows);
}
const paceEl = document.getElementById("pace"), timebar = document.getElementById("timebar");
const paceSides = [["plain", false], ["corgi", true]].map(([name, paced]) => {
  const el = document.getElementById(`v-pace-${name}`);
  return { el, paced, screen: new Screen(el, PACE.cols, PACE.rows) };
});
// Under them, a timeline of each side as Chrome draws one: usable, halted,
// catching up, usable again, filled in up to the playhead.
const linkDown = elapsed => i18n.t`link down · ${elapsed}`;
const catchUp = elapsed => i18n.t`catch-up · ${elapsed}`;
for (const [name, paced] of [[i18n.t`plain ssh`, false], ["corgi", true]]) {
  const [from, to] = PACE.stall, back = paceBack(paced), track = el("div", "tb-track"), fill = el("div", "tb-fill");
  const secs = (ms) => `${Math.round(ms / 100) / 10} s`;
  const spans = [["usable", 0, from, i18n.t`usable`, ""], ["halt", from, to, linkDown(secs(to - from)), secs(to - from)], ["catchup", to, back, catchUp(secs(back - to)), secs(back - to)], ["usable", back, PACE_END, i18n.t`usable`, ""]];
  for (const [kind, a, b, long, short] of spans) {
    const span = el("span", `tb-${kind}`);
    Object.assign(span.dataset, { long, short });
    Object.assign(span.style, { left: `${(100 * a) / PACE_END}%`, width: `${(100 * (b - a)) / PACE_END}%` });
    fill.append(span);
  }
  track.append(fill);
  timebar.append(el("span", "tb-name", name), track);
}
// Each label shows whole, short or not at all, as its span has room.
new ResizeObserver(() => timebar.querySelectorAll(".tb-fill > span").forEach((span) => {
  for (const label of [span.dataset.long, span.dataset.short, ""]) {
    span.textContent = label;
    if (span.scrollWidth <= span.clientWidth) break;
  }
})).observe(timebar);
// It plays each time half of it comes into view, every animation frame,
// and again `PACE_REST` ms after the end, or at once on a tap; a still page
// shows the end.
const PACE_REST = 3000;
let paceFrom = null, pacePlaying = false, paceRest = 0;
function paintPace(T) {
  timebar.style.setProperty("--at", T / PACE_END);
  for (const side of paceSides) side.screen.paint(paceGrid(paceShown(T, side.paced)));
}
function playPace() {
  if (paceFrom == null) return void (pacePlaying = false);
  const T = Math.min(PACE_END, (now() - paceFrom) * PACE.speed);
  paintPace(T);
  if (T < PACE_END) return void requestAnimationFrame(playPace);
  pacePlaying = false;
  paceRest = setTimeout(startPace, PACE_REST);
}
function startPace() {
  clearTimeout(paceRest);
  paceFrom = now();
  if (!pacePlaying) { pacePlaying = true; requestAnimationFrame(playPace); }
}
new IntersectionObserver(([entry]) => {
  if (entry.intersectionRatio >= 0.5 && paceFrom == null && !still) startPace();
  else if (!entry.isIntersecting) { clearTimeout(paceRest); paceFrom = null; paintPace(still ? PACE_END : 0); }
}, { threshold: [0, 0.5] }).observe(paceEl);
paceEl.addEventListener("click", () => { if (!still) startPace(); });
paintPace(still ? PACE_END : 0);

function run() {
  const t = now();
  if (heroSeen) drawHero(t);
  if (runningSeen) drawRunning(t);
  for (const f of inView) f.draw(t);
  cliBand?.draw(t);
  tricksBand?.draw(t);
}
run();
setInterval(run, 50);
})();

