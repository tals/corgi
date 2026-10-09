//! Setup modal opened from the corgi badge (or `prefix i`), centered on screen.
//! The settings list sits on the left with each current value, and the
//! selected setting's options on the right. Viewer-owned: Enter and clicks
//! return an `Apply` that the controller carries out. Opening Shortcuts grows
//! the frame to fit onboarding's preset detail beside the presets.
import * as palette from "./palette";
import { Style, colors, bgRgb, mix, type Rgb, type Token } from "./palette";
import { Rect } from "./layout";
import { Provider } from "./providers";
import { Model } from "./providers/model";
import * as corgiAnimation from "./corgi_animation";
import * as km from "./keymap";
import * as onboarding from "./onboarding";
import * as catalog from "./import/catalog";
import type { Action } from "./action";
import type { Preferences } from "./preferences";
import type { State as IntegrationState } from "./ghostty_integration";
import type { State as ClipboardState } from "./host_clipboard";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";
import * as shellPicker from "./shell_picker";
import type { ShellStatus } from "./launch/command";

/** The inference setup status the daemon publishes, as inference.zig's `Status`. */
export interface Status {
  choice: Summarizer;
  provider: Provider | null;
  model: string;
  locked: boolean;
  launches: { codex: number; claude: number };
  models: { codex: string; claude: string };
}
export function status(value: any = {}): Status {
  return {
    choice: value?.choice ?? "auto",
    provider: value?.provider ?? null,
    model: value?.model ?? "",
    locked: value?.locked === true,
    launches: { codex: Number(value?.launches?.codex ?? 0), claude: Number(value?.launches?.claude ?? 0) },
    models: { codex: value?.models?.codex ?? "", claude: value?.models?.claude ?? "" },
  };
}
/** Who writes activity summaries and link names. */
export type Summarizer = "auto" | "codex" | "claude" | "off";
const summarizers: Summarizer[] = ["auto", "codex", "claude", "off"];
export const Summarizer = {
  provider(choice: Summarizer): Provider | null {
    return choice === "codex" || choice === "claude" ? choice : null;
  },
  label(choice: Summarizer): string {
    return { auto: "Auto", codex: "Codex", claude: "Claude", off: "Off" }[choice];
  },
};

export type Item =
  | "summaries"
  | "sleeping_corgis"
  | "readings"
  | "clever_corgi"
  | "theme"
  | "shell"
  | "keyboard"
  | "ghostty"
  | "image_paste"
  | "import";
/** The list, top to bottom; null leaves a gap between groups. */
const list: (Item | null)[] = [
  "summaries",
  "sleeping_corgis",
  "readings",
  "clever_corgi",
  null,
  "theme",
  "shell",
  "keyboard",
  null,
  "ghostty",
  "image_paste",
  null,
  "import",
];
export const items = list.filter((item): item is Item => item !== null);
const labels: Record<Item, string> = {
  summaries: "Summaries",
  sleeping_corgis: "Sleeping corgis",
  readings: "Resources",
  clever_corgi: "Clever Corgi",
  theme: "Theme",
  shell: "Shell",
  keyboard: "Shortcuts",
  ghostty: "Command keys",
  image_paste: "Image paste",
  import: "Import",
};
const sources: Record<catalog.Source, { label: string; detail: string }> = {
  tmux: { label: "tmux", detail: "sessions, scrollback and commands" },
  herdr: { label: "Herdr", detail: "one session, live or copied" },
  cmux: { label: "cmux", detail: "workspaces and surfaces" },
};

/** What Enter or a click asks the controller to do. */
export type Apply =
  | { kind: "summaries"; choice: Summarizer }
  | { kind: "readings" | "sleeping_corgis" | "smart_links" | "ghostty"; on: boolean }
  | { kind: "theme"; theme: palette.Theme }
  | { kind: "shell"; entry: shellPicker.Entry }
  | { kind: "preset"; preset: km.Preset }
  | { kind: "prefix" }
  | { kind: "keymap" }
  | { kind: "import"; source: catalog.Source };
/** A list row or an option under the pointer. */
export type Hit = { item: Item } | { option: number };

interface Option {
  label: string;
  detail: string;
  /** ● in use, ○ not, or no mark for actions. */
  mark: "on" | "off" | "none";
  /** Null when Enter has nothing to do, as on the option in use. */
  apply: Apply | null;
  /** The Enter hint. */
  action: string;
  disabled?: boolean;
  warn?: boolean;
  arrow?: boolean;
  /** A sleeping corgi before the detail: puffing for On, still for Off. */
  sprite?: "puff" | "still";
  /** Status glyphs on the theme's background, before the detail. */
  swatch?: palette.Theme;
  /** A toggle in a group: On or Off at the right edge, as in the list. */
  toggle?: boolean;
}
type Line =
  | { tag: "title" | "lead" | "note" | "warn"; text: string }
  /** One line under a setting in a group, aligned with its name. */
  | { tag: "brief"; text: string }
  | { tag: "blank" }
  | { tag: "keys"; keys: [string, string][] }
  | { tag: "status"; text: string; tone: "accent" | "warm" | "faint" }
  | { tag: "option"; option: Option; index: number };

interface Row {
  text: string;
  label: string;
  accent: string;
  muted: string;
  quiet: string;
  warn: string;
  background: Rgb;
}
let panel: string, border: string, text: string, bright: string, warm: string, hint_key: string;
let row_normal: Row, row_selected: Row, row_resting: Row;
palette.derived(() => {
  panel = new Style({ fg: "faint", bg: "surface" }).sgr();
  border = new Style({ fg: "line", bg: "surface" }).sgr();
  text = new Style({ fg: "text", bg: "surface" }).sgr();
  bright = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  warm = new Style({ fg: "warm", bg: "surface" }).sgr();
  hint_key = new Style({ fg: "muted", bg: "surface" }).sgr();
  row_normal = {
    text,
    label: text,
    accent: new Style({ fg: "accent", bg: "surface" }).sgr(),
    muted: new Style({ fg: "muted", bg: "surface" }).sgr(),
    quiet: panel,
    warn: warm,
    background: colors.surface,
  };
  row_selected = {
    text: new Style({ fg: "text", bg: "selected" }).sgr(),
    label: new Style({ fg: "strong", bg: "selected", bold: true }).sgr(),
    accent: new Style({ fg: "accent", bg: "selected" }).sgr(),
    muted: new Style({ fg: "muted", bg: "selected" }).sgr(),
    // Faint is too dim on a selected row.
    quiet: new Style({ fg: "muted", bg: "selected" }).sgr(),
    warn: new Style({ fg: "warm", bg: "selected" }).sgr(),
    background: colors.selected,
  };
  // The list's selected row while the options have focus.
  const resting = mix(colors.surface, colors.selected, 45);
  const on = (fg: Token, bold = false) => `\x1b[0${bold ? ";1" : ""}m${bgRgb(resting)}${palette.fg(fg)}`;
  row_resting = {
    text: on("text"),
    label: on("strong", true),
    accent: on("accent"),
    muted: on("muted"),
    quiet: on("muted"),
    warn: on("warm"),
    background: resting,
  };
});
const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;

const list_w = 26;
const body_max = list.length;
/** The options column beside onboarding's preset detail. */
const options_w = 34;
const two_pane_cols = 80;
const single_max = 56;
const single_min = 44;
/** The puffing preview dreams more often than a sidebar list. */
const preview_period_ms = 6_000;
const grow_ms = 280;
const shrink_ms = 200;

/** Onboarding's preset detail at the largest size that fits beside the
 * presets, and the frame it needs; null when it doesn't fit. Its column adds
 * a divider and two columns of padding on each side. */
function detailSize(cols: number, rows: number) {
  let opts = options_w,
    width = Math.min(69, cols - 11 - opts);
  if (width < 41) {
    opts = Math.max(26, opts - (41 - width));
    width = Math.min(69, cols - 11 - opts);
  }
  if (width < 41) return null;
  // Onboarding's own rule for its compact layout.
  const compact = rows < 32,
    h = 4 + onboarding.detailHeight(width, compact);
  return h > rows ? null : { width, compact, w: 2 + opts + width + 5, h };
}
interface Layout {
  b: Rect;
  single: boolean;
  /** Rows for the list and options, from b.y + 2. */
  body: number;
  /** Columns the list shows; it slides out while the frame grows. */
  list: number;
  options: { x: number; w: number };
  dividers: number[];
  /** Whether onboarding's preset detail fits this screen at all. */
  room: boolean;
  /** Onboarding's preset detail, once the frame has grown to fit it. */
  detail: { x: number; y: number; width: number; compact: boolean } | null;
}
/** `grown` runs from 0 (list and options) to 1 (options and preset detail). */
function layout(cols: number, rows: number, grown: number): Layout | null {
  const h0 = Math.min(rows, body_max + 4);
  if (h0 - 4 < 8) return null;
  if (cols < two_pane_cols) {
    const w = Math.min(cols, single_max);
    if (w < single_min) return null;
    const b = new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h0) / 2), w, h0);
    return {
      b,
      single: true,
      body: h0 - 4,
      list: 0,
      options: { x: b.x + 1, w: w - 2 },
      dividers: [],
      room: false,
      detail: null,
    };
  }
  const base = Math.min(cols - 4, 84),
    size = detailSize(cols, rows),
    t = size ? grown : 0,
    w = Math.round(base + ((size?.w ?? base) - base) * t),
    h = Math.round(h0 + ((size?.h ?? h0) - h0) * t),
    b = new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h),
    shown = Math.round(list_w * (1 - t)),
    detail_w = size ? Math.round((size.width + 5) * t) : 0,
    left = b.x + 1,
    right = b.x + w - 1,
    dividers: number[] = [];
  if (shown > 0) dividers.push(left + shown);
  if (detail_w > 0) dividers.push(right - detail_w);
  const x = shown > 0 ? left + shown + 1 : left;
  return {
    b,
    single: false,
    body: h - 4,
    list: shown,
    options: { x, w: (detail_w > 0 ? right - detail_w : right) - x },
    dividers,
    room: size !== null,
    detail:
      size && t === 1 ? { x: right - size.width - 2, y: b.y + 2, width: size.width, compact: size.compact } : null,
  };
}

export class Menu {
  item: Item = "summaries";
  focus: "list" | "options" = "list";
  /** The highlighted option while the options have focus. */
  cursor = 0;
  integration: IntegrationState = "unavailable";
  /** The host terminal's clipboard; null when the viewer has no terminal. */
  image_paste: ClipboardState | null = null;
  /** The shell new panes run, as the daemon last published it. */
  shell: ShellStatus = shellPicker.status();
  /** Shells /etc/shells lists, offered beside the default. */
  shells: string[] = [];
  /** Whether the daemon probes the ports servers print, for Open ↗ buttons. */
  smart_links = true;
  /** The frame's growth toward the preset detail, eased between draws. */
  private grow = { from: 0, to: 0, at_ms: 0 };
  static open(): Menu {
    return new Menu();
  }
  /** Whether the frame grows to show the preset detail. */
  private growing(cols: number, rows: number): boolean {
    return (
      this.item === "keyboard" && this.focus === "options" && cols >= two_pane_cols && detailSize(cols, rows) !== null
    );
  }
  private grown(now_ms: number): number {
    const g = this.grow,
      span = g.to > g.from ? grow_ms : shrink_ms,
      k = Math.max(0, (now_ms - g.at_ms) / span);
    return k >= 1 ? g.to : g.from + (g.to - g.from) * (1 - (1 - k) ** 3);
  }
  /** Moves the cursor within the focused column. */
  move(next: boolean, s: Status, prefs: Preferences): void {
    if (this.focus === "list") {
      const index = items.indexOf(this.item);
      this.item = items[next ? Math.min(index + 1, items.length - 1) : sat(index, 1)];
      return;
    }
    const options = this.options(s, prefs);
    for (let i = this.cursor + (next ? 1 : -1); i >= 0 && i < options.length; i += next ? 1 : -1)
      if (!options[i].disabled) {
        this.cursor = i;
        return;
      }
  }
  /** Gives the options focus, on the one in use. False when none can be chosen. */
  openOptions(s: Status, prefs: Preferences): boolean {
    const options = this.options(s, prefs);
    if (options.every(o => o.disabled)) return false;
    const used = options.findIndex(o => o.mark === "on" && !o.disabled);
    this.focus = "options";
    this.cursor = used >= 0 ? used : options.findIndex(o => !o.disabled);
    return true;
  }
  /** Returns focus to the list. False when it already has it. */
  back(): boolean {
    if (this.focus === "list") return false;
    this.focus = "list";
    return true;
  }
  /** Enter: an on/off setting flips from the list; the rest open their options. */
  enter(s: Status, prefs: Preferences): Apply | null {
    if (this.focus === "options") {
      const option = this.options(s, prefs)[this.cursor];
      return option && !option.disabled ? option.apply : null;
    }
    const flip = this.flip(prefs);
    if (flip) return flip;
    this.openOptions(s, prefs);
    return null;
  }
  /** What Enter on the list does for an on/off setting. */
  private flip(prefs: Preferences): Apply | null {
    switch (this.item) {
      case "readings":
        return { kind: "readings", on: !prefs.resources.enabled };
      case "sleeping_corgis":
        return { kind: "sleeping_corgis", on: !prefs.sleeping_corgis };
      case "ghostty":
        return this.integration === "enabled" || this.integration === "disabled"
          ? { kind: "ghostty", on: this.integration === "disabled" }
          : null;
      default:
        return null;
    }
  }
  /** A click: the list selects, then opens; an option applies. */
  click(hit: Hit, s: Status, prefs: Preferences): Apply | null {
    if ("item" in hit) {
      if (hit.item === this.item && this.focus === "list") return this.enter(s, prefs);
      this.item = hit.item;
      this.focus = "list";
      return null;
    }
    const option = this.options(s, prefs)[hit.option];
    if (!option || option.disabled) return null;
    this.focus = "options";
    this.cursor = hit.option;
    return option.apply;
  }
  /** Pointer motion highlights rows in the focused column. */
  hover(hit: Hit, s: Status, prefs: Preferences): void {
    if ("item" in hit) {
      if (this.focus === "list") this.item = hit.item;
    } else if (this.focus === "options" && !this.options(s, prefs)[hit.option]?.disabled) this.cursor = hit.option;
  }
  /** The frame as it rests after the current change. */
  private rest(cols: number, rows: number): Layout | null {
    return layout(cols, rows, this.growing(cols, rows) ? 1 : 0);
  }
  contains(cols: number, rows: number, x: number, y: number): boolean {
    return this.rest(cols, rows)?.b.contains(x, y) ?? false;
  }
  hit(cols: number, rows: number, x: number, y: number, s: Status, prefs: Preferences): Hit | null {
    const l = this.rest(cols, rows);
    if (!l) return null;
    const row = y - l.b.y - 2;
    if (row < 0 || row >= l.body) return null;
    const list_shown = l.single ? this.focus === "list" : l.list > 0;
    if (list_shown) {
      const left = l.b.x + 1,
        width = l.single ? l.b.w - 2 : l.list;
      if (x >= left && x < left + width) {
        const item = listRows(l.body)[row];
        return item ? { item } : null;
      }
    }
    if (l.single && this.focus === "list") return null;
    if (x < l.options.x || x >= l.options.x + l.options.w) return null;
    const line = this.lines(s, prefs, l)[row];
    return line && line.tag === "option" ? { option: line.index } : null;
  }
  draw(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number): void {
    return this.drawAt(w, s, prefs, cols, rows, Date.now());
  }
  drawAt(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number, now_ms: number): void {
    const target = this.growing(cols, rows) ? 1 : 0;
    if (target !== this.grow.to) this.grow = { from: this.grown(now_ms), to: target, at_ms: now_ms };
    const l = layout(cols, rows, this.grown(now_ms));
    if (!l) return;
    const b = l.b,
      top = b.y + 2;
    frame(w, b, l.dividers);
    w.write(`${at(b.x + 2, b.y)}${text} ᐯ•ᴥ•ᐯ ${bright}Corgi setup `);
    const list_shown = l.single ? this.focus === "list" : l.list === list_w;
    if (!list_shown && (l.single || l.list < list_w / 2)) {
      // The crumb stops short of a divider's corner.
      const room = Math.min(b.w - 23, ...l.dividers.filter(x => x > b.x + 21).map(x => x - b.x - 22));
      w.write(at(b.x + 21, b.y) + hint_key);
      writeEllipsis(w, `› ${labels[this.item]} `, room);
    }
    if (list_shown) this.drawList(w, b.x + 1, top, l.single ? b.w - 2 : list_w, l.body, s, prefs);
    if (!(l.single && this.focus === "list")) this.drawOptions(w, l, s, prefs, now_ms);
    if (l.detail) {
      const d = l.detail;
      onboarding.drawPresetDetail(w, d.x, d.y, d.width, d.compact, {
        preset: this.previewPreset(prefs),
        prefix: prefs.prefix,
        focus: 0,
      });
    }
    const hint_x = (l.list > 0 && !l.single ? b.x + 1 + l.list : b.x) + 2;
    drawHints(w, hint_x, b.y + b.h - 1, l.options.x + l.options.w - 1 - hint_x, this.hints(s, prefs));
    w.write("\x1b[0m\x1b[?25l");
  }
  private drawList(w: Writer, x: number, y: number, width: number, body: number, s: Status, prefs: Preferences) {
    listRows(body).forEach((item, i) => {
      if (item === null) return;
      const chosen = item === this.item,
        p = !chosen ? row_normal : this.focus === "list" ? row_selected : row_resting;
      if (chosen) {
        w.write(at(x, y + i) + p.text);
        w.splat(" ", width);
      }
      w.write(at(x + 2, y + i) + (chosen ? p.label : p.text));
      writeEllipsis(w, labels[item], width - 4);
      const v = this.value(item, s, prefs);
      if (v.text.length > 0)
        w.write(
          at(x + width - 2 - displayWidth(v.text), y + i) +
            (v.tone === "muted" ? p.muted : v.tone === "warm" ? p.warn : p.quiet) +
            v.text,
        );
    });
  }
  private drawOptions(w: Writer, l: Layout, s: Status, prefs: Preferences, now_ms: number) {
    const x = l.options.x,
      width = l.options.w,
      x0 = x + 2,
      right = x + width - 1,
      lines = this.lines(s, prefs, l),
      label_w = Math.max(0, ...lines.map(line => (line.tag === "option" ? displayWidth(line.option.label) : 0)));
    lines.forEach((line, i) => {
      const y = l.b.y + 2 + i;
      switch (line.tag) {
        case "blank":
          return;
        case "title":
          w.write(at(x0, y) + bright);
          return writeEllipsis(w, line.text, right - x0);
        case "lead":
        case "note":
        case "warn":
          w.write(at(x0, y) + (line.tag === "warn" ? warm : panel));
          return writeEllipsis(w, line.text, right - x0);
        case "brief":
          w.write(at(x0 + 4, y) + panel);
          return writeEllipsis(w, line.text, right - x0 - 4);
        case "status":
          w.write(at(x0 + 2, y) + (line.tone === "accent" ? row_normal.accent : line.tone === "warm" ? warm : panel));
          return writeEllipsis(w, line.text, right - x0 - 2);
        case "keys": {
          let cx = x0;
          line.keys.forEach(([key, label], k) => {
            const shown = `${k > 0 ? "   " : ""}${key}`;
            w.write(at(cx, y) + text);
            writeEllipsis(w, shown, right - cx);
            cx += displayWidth(shown);
            w.write(panel);
            writeEllipsis(w, ` ${label}`, sat(right, cx));
            cx += label.length + 1;
          });
          return;
        }
        case "option":
          return this.drawOption(w, line, x, width, y, label_w, prefs, now_ms);
      }
    });
  }
  private drawOption(
    w: Writer,
    line: Extract<Line, { tag: "option" }>,
    x: number,
    width: number,
    y: number,
    label_w: number,
    prefs: Preferences,
    now_ms: number,
  ) {
    const o = line.option,
      here = this.focus === "options" && line.index === this.cursor,
      p = here ? row_selected : row_normal,
      x0 = x + 2,
      right = x + width - 1;
    w.write(at(x, y) + p.text);
    w.splat(" ", width);
    if (here) w.write(at(x0, y) + p.accent + "›");
    if (o.mark !== "none")
      w.write(at(x0 + 2, y) + (o.mark === "on" && !o.disabled ? p.accent : p.quiet) + (o.mark === "on" ? "●" : "○"));
    w.write(at(x0 + 4, y) + (o.disabled ? p.quiet : p.label));
    writeEllipsis(w, o.label, Math.min(label_w, sat(right, x0 + 4)));
    if (o.toggle !== undefined) {
      const value = o.toggle ? "● On" : "○ Off";
      w.write(at(x + width - 2 - displayWidth(value), y) + (o.toggle ? p.accent : p.quiet) + value);
      return;
    }
    let dx = x0 + 4 + label_w + 3;
    if (o.sprite) {
      // On puffs every few seconds; Off naps dim and still.
      const elapsed = ((now_ms % preview_period_ms) + preview_period_ms) % preview_period_ms;
      w.write(at(dx, y) + p.text);
      w.write(
        corgiAnimation.idle(Math.min(12, sat(right, dx)), {
          background: p.background,
          bright: o.sprite === "puff",
          selected: here,
          puff_ms: o.sprite === "puff" ? elapsed : null,
        }),
      );
      dx += 13;
    }
    if (o.swatch && right - dx >= 7) {
      w.write(
        `${at(dx, y)}\x1b[0;1m${palette.bg("bg", o.swatch)}${palette.fg("accent")} ▶ ${palette.fg("warm")}● ` +
          `\x1b[22m${palette.fg("muted")}○ `,
      );
      dx += 8;
    }
    w.write(at(dx, y) + (o.disabled ? p.quiet : o.warn ? p.warn : p.muted));
    writeEllipsis(w, o.detail, sat(right - (o.arrow ? 3 : 0), dx));
    if (o.arrow) w.write(at(right - 2, y) + p.muted + "→");
  }
  /** The options pane's rows as they fit `l`: leads and notes wrap, notes
   * give way first, then the options scroll to keep the cursor in view. */
  private lines(s: Status, prefs: Preferences, l: Layout): Line[] {
    const room = l.options.w - 3,
      out: Line[] = [];
    let index = 0;
    for (const line of this.content(s, prefs, { keys: !l.room, brief: l.options.w < 42 }))
      if (line.tag === "lead" || line.tag === "note" || line.tag === "warn")
        for (const part of wrap(line.text, room)) out.push({ tag: line.tag, text: part });
      else if (line.tag === "option") out.push({ ...line, index: index++ });
      else out.push(line);
    if (out.length <= l.body) return out;
    const first = out.findIndex(line => line.tag === "option"),
      last = out.findLastIndex(line => line.tag === "option"),
      kept = out.slice(0, last + 1);
    if (kept.length <= l.body || first < 0) return kept.slice(0, l.body);
    const head = kept.slice(0, Math.min(first, l.body - 1)),
      options = kept.slice(first),
      span = l.body - head.length,
      cursor = options.findIndex(line => line.tag === "option" && line.index === this.cursor),
      start = Math.min(Math.max(0, cursor - span + 1), options.length - span);
    return head.concat(options.slice(start, start + span));
  }
  private options(s: Status, prefs: Preferences): Option[] {
    return this.content(s, prefs, { keys: false, brief: false }).flatMap(line =>
      line.tag === "option" ? [line.option] : [],
    );
  }
  /** The selected setting's rows. `keys` swaps the lead for a line of keys
   * where onboarding's preset detail has no room; `brief` takes the short
   * preset descriptions for a narrow column. */
  private content(s: Status, prefs: Preferences, fit: { keys: boolean; brief: boolean }): Line[] {
    const lead = (text: string): Line => ({ tag: "lead", text }),
      option = (o: Option): Line => ({ tag: "option", option: o, index: 0 }),
      title = (text: string): Line => ({ tag: "title", text }),
      blank: Line = { tag: "blank" },
      focused = this.focus === "options";
    switch (this.item) {
      case "summaries": {
        const shown = focused ? (summarizers[this.cursor] ?? s.choice) : s.choice;
        return [
          title("Activity summaries"),
          lead("Who writes activity summaries and link names?"),
          blank,
          ...summarizers.map(choice =>
            option({
              label: Summarizer.label(choice),
              detail: summary(choice, s),
              mark: choice === s.choice ? "on" : "off",
              apply: choice === s.choice ? null : { kind: "summaries", choice },
              action: "use",
            }),
          ),
          blank,
          { tag: "note", text: detail(shown, s) },
        ];
      }
      case "sleeping_corgis":
        return [
          title("Sleeping corgis"),
          lead("Idle agents doze off in the sidebar."),
          blank,
          ...onOff(prefs.sleeping_corgis, "sleeping_corgis", ["snores now and then", "dim and still"]).map(o =>
            option({ ...o, sprite: o.label === "On" ? "puff" : "still" }),
          ),
        ];
      case "readings":
        return [
          title("Resource readings"),
          lead("CPU and memory under each workspace in the sidebar."),
          blank,
          ...onOff(prefs.resources.enabled, "readings", ["show the readings row", "hide the row"]).map(option),
          blank,
          { tag: "note", text: "Sampling stops once every viewer turns it off." },
        ];
      case "clever_corgi":
        return [
          title("Clever Corgi"),
          blank,
          ...this.clever().flatMap((c): Line[] => [
            option({
              label: c.label,
              detail: "",
              mark: "none",
              apply: { kind: c.kind, on: !c.on },
              action: c.on ? "turn off" : "turn on",
              toggle: c.on,
            }),
            { tag: "brief", text: c.brief },
            blank,
          ]),
        ];
      case "theme":
        return [
          title("Theme"),
          lead("What shows behind the sidebar and cards."),
          blank,
          ...palette.available_themes.map(theme =>
            option({
              label: palette.themes[theme].label,
              detail: palette.themes[theme].clear ? "terminal background" : "Corgi's dark panels",
              mark: theme === prefs.theme ? "on" : "off",
              apply: theme === prefs.theme ? null : { kind: "theme", theme },
              action: "use",
              swatch: theme,
            }),
          ),
        ];
      case "shell": {
        const picker = shellPicker.Picker.open(this.shell, this.shells);
        return [
          title("Shell for new panes"),
          lead("New panes and splits start in this login shell."),
          blank,
          ...picker.entries.map((entry, i) => {
            const used = i === picker.in_use && entry !== "other";
            return option({
              label: picker.label(entry),
              detail: picker.detail(entry),
              mark: used ? "on" : "off",
              apply: used ? null : { kind: "shell", entry },
              action: entry === "other" ? "type a path" : "use",
              warn: used && entry !== "default" && shellPicker.missing(this.shell),
            });
          }),
        ];
      }
      case "keyboard": {
        const other = prefs.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
        return [
          title("Keyboard shortcuts"),
          fit.keys
            ? { tag: "keys", keys: keyLine(this.previewPreset(prefs), prefs.prefix) }
            : lead("Which shortcuts feel like home?"),
          blank,
          ...km.available_presets.map(preset =>
            option({
              label: km.name(preset),
              detail: fit.brief ? km.shortDescription(preset) : km.description(preset),
              mark: preset === prefs.preset ? "on" : "off",
              apply: preset === prefs.preset ? null : { kind: "preset", preset },
              action: "use",
            }),
          ),
          blank,
          option({
            label: "Prefix",
            detail: km.prefixName(prefs.prefix),
            mark: "none",
            apply: { kind: "prefix" },
            action: `switch to ${km.prefixName(other)}`,
          }),
          option({
            label: "All keys",
            detail: "",
            mark: "none",
            apply: { kind: "keymap" },
            action: "open",
            arrow: true,
          }),
        ];
      }
      case "ghostty": {
        const works = this.integration === "enabled" || this.integration === "disabled";
        return [
          title("Ghostty command keys"),
          lead("Cmd+1-9, Cmd+T/W and Ctrl+Tab drive Corgi's tabs in every Ghostty window."),
          blank,
          ...onOff(this.integration === "enabled", "ghostty", [
            "Corgi's keys in your config",
            "Ghostty keeps its own keys",
          ]).map(o => option({ ...o, disabled: !works, mark: works ? o.mark : "off" })),
          blank,
          this.integration === "failed"
            ? { tag: "warn", text: "Corgi can't read your Ghostty config." }
            : {
                tag: "note",
                text: works
                  ? "Reload Ghostty with Cmd+Shift+, after a change."
                  : "Only for Ghostty on this Mac, not over SSH.",
              },
        ];
      }
      case "image_paste": {
        const clipboard = this.image_paste,
          head = [title("Image paste"), lead("Paste screenshots and other images into an agent."), blank];
        if (!clipboard) return [...head, { tag: "note", text: "This viewer has no terminal to paste from." }];
        return [
          ...head,
          {
            tag: "status",
            text: clipboard.status(),
            tone: clipboard.support === "on" ? "accent" : clipboard.support === "denied" ? "warm" : "faint",
          },
          blank,
          {
            tag: "note",
            text: {
              probing: "Checking what your terminal supports.",
              on: "Copy an image, then paste it where an agent is waiting.",
              denied: "Your terminal refuses clipboard reads. Allow them to paste images.",
              unsupported: "Your terminal doesn't send image pastes to Corgi.",
            }[clipboard.support],
          },
        ];
      }
      case "import":
        return [
          title("Import sessions"),
          lead("Bring your work along from another multiplexer."),
          blank,
          ...catalog.available_sources.map(source =>
            option({
              label: sources[source].label,
              detail: sources[source].detail,
              mark: "none",
              apply: { kind: "import", source },
              action: "open",
              arrow: true,
            }),
          ),
        ];
    }
  }
  /** Clever Corgi's settings, each turned on or off in the group's pane. */
  private clever(): { kind: "smart_links"; label: string; brief: string; on: boolean }[] {
    return [
      {
        kind: "smart_links",
        label: "Smart Links",
        brief: "Digs up likely HTTP links for an Open ↗ button.",
        on: this.smart_links,
      },
    ];
  }
  /** The theme under the cursor, or the one in use. */
  previewTheme(prefs: Preferences): palette.Theme {
    if (this.item !== "theme" || this.focus !== "options") return prefs.theme;
    return palette.available_themes[this.cursor] ?? prefs.theme;
  }
  /** The preset under the cursor, or the one in use. */
  private previewPreset(prefs: Preferences): km.Preset {
    if (this.item !== "keyboard" || this.focus !== "options") return prefs.preset;
    return km.available_presets[this.cursor] ?? prefs.preset;
  }
  /** The list's value column for `item`. */
  private value(item: Item, s: Status, prefs: Preferences): { text: string; tone: "muted" | "faint" | "warm" } {
    const flag = (enabled: boolean) =>
      enabled ? { text: "On", tone: "muted" as const } : { text: "Off", tone: "faint" as const };
    switch (item) {
      case "summaries":
        return { text: Summarizer.label(s.choice), tone: s.choice === "off" ? "faint" : "muted" };
      case "sleeping_corgis":
        return flag(prefs.sleeping_corgis);
      case "readings":
        return flag(prefs.resources.enabled);
      case "clever_corgi":
        return { text: "", tone: "faint" };
      case "theme":
        return { text: palette.themes[prefs.theme].label, tone: "muted" };
      case "shell":
        if (shellPicker.missing(this.shell)) return { text: "not found", tone: "warm" };
        return { text: this.shell.path ? this.shell.path.split("/").pop()! : "", tone: "muted" };
      case "keyboard":
        return { text: km.name(prefs.preset), tone: "muted" };
      case "ghostty":
        return {
          enabled: { text: "On", tone: "muted" as const },
          disabled: { text: "Off", tone: "faint" as const },
          unavailable: { text: "Mac only", tone: "faint" as const },
          failed: { text: "Error", tone: "warm" as const },
        }[this.integration];
      case "image_paste": {
        const support = this.image_paste?.support;
        if (support === "on") return { text: "On", tone: "muted" };
        if (support === "denied") return { text: "Blocked", tone: "warm" };
        return { text: support === "probing" ? "…" : support ? "Off" : "", tone: "faint" };
      }
      case "import":
        return { text: "", tone: "faint" };
    }
  }
  /** Key hints for the bottom border, most important last. */
  private hints(s: Status, prefs: Preferences): [string, string][] {
    if (this.focus === "list") {
      const flip = this.flip(prefs),
        open = this.options(s, prefs).some(o => !o.disabled);
      const enter: [string, string][] =
        flip && "on" in flip ? [["enter", flip.on ? "turn on" : "turn off"]] : open ? [["enter", "choose"]] : [];
      return [["↑↓", "move"], ...enter, ["esc", "close"]];
    }
    const option = this.options(s, prefs)[this.cursor];
    const enter: [string, string][] = option && !option.disabled && option.apply ? [["enter", option.action]] : [];
    return [["↑↓", "move"], ...enter, ["esc", "back"]];
  }
}
/** The list's rows for `body` rows: short frames drop the gaps between groups. */
function listRows(body: number): (Item | null)[] {
  return body >= list.length ? list : items;
}
function onOff(
  enabled: boolean,
  kind: "readings" | "sleeping_corgis" | "ghostty",
  details: [string, string],
): Option[] {
  return [true, false].map((value, i) => ({
    label: value ? "On" : "Off",
    detail: details[i],
    mark: value === enabled ? "on" : "off",
    apply: value === enabled ? null : { kind, on: value },
    action: value ? "turn on" : "turn off",
  }));
}
const action = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
/** The keys a preset teaches, on one line, where its detail has no room. */
function keyLine(preset: km.Preset, prefix: km.Prefix): [string, string][] {
  const key = (name: string, value?: string) => onboarding.cardKey({ preset, prefix }, action(name, value));
  return [
    preset === "cmux" ? ["Cmd", "+"] : [km.prefixName(prefix), "then"],
    [key("new"), "tab"],
    [`${key("split", "right")} ${key("split", "down")}`, "split"],
    [["left", "down", "up", "right"].map(side => key("focus", side)).join(" "), "focus"],
  ];
}
/** The rounded border, with a divider down each listed column. */
function frame(w: Writer, b: Rect, dividers: number[]): void {
  for (let row = 0; row < b.h; row++) {
    const top = row === 0,
      bottom = row === b.h - 1;
    w.write(at(b.x, b.y + row) + border + (top ? "╭" : bottom ? "╰" : "│"));
    if (top || bottom) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(top ? "╮" : bottom ? "╯" : "│");
    for (const x of dividers) w.write(at(x, b.y + row) + (top ? "┬" : bottom ? "┴" : "│"));
  }
}
/** Hints on the bottom border; the first ones give way when room runs out. */
function drawHints(w: Writer, x: number, y: number, room: number, hints: [string, string][]): void {
  const width = (list: [string, string][]) =>
    list.reduce((n, [key, label]) => n + displayWidth(key) + 1 + displayWidth(label), 0) + 3 * (list.length - 1) + 2;
  while (hints.length > 1 && width(hints) > room) hints = hints.slice(1);
  if (width(hints) > room) return;
  w.write(at(x, y) + border + " ");
  hints.forEach(([key, label], i) => {
    w.write(hint_key + key + panel + " " + label + border + (i < hints.length - 1 ? "   " : " "));
  });
}
function wrap(value: string, room: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    if (line.length > 0 && displayWidth(line) + 1 + displayWidth(word) > room) {
      out.push(line);
      line = word;
    } else line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line.length > 0) out.push(line);
  return out;
}
function summary(choice: Summarizer, s: Status): string {
  switch (choice) {
    case "auto":
      if (s.choice !== "auto" || s.provider === null) return "Follow the agents you run";
      return `${s.locked ? "Settled on" : "Following you →"} ${Provider.info(s.provider).name} · ${Model.resolve(s.models[s.provider]).label()}`;
    case "off":
      return "No summaries, plain links";
    default: {
      const provider = Summarizer.provider(choice)!;
      return `${Model.resolve(s.models[provider]).label()} · your ${Provider.info(provider).name} login`;
    }
  }
}
function detail(choice: Summarizer, s: Status): string {
  switch (choice) {
    case "auto":
      return launchCounts(s);
    case "off":
      return "Activity text stays blank; links say Open Link";
    default:
      return `Needs ${Provider.info(Summarizer.provider(choice)!).executables[0]} installed and signed in`;
  }
}
/** Launches per provider since the daemon started, in launcher order. */
function launchCounts(s: Status): string {
  const total = Provider.all.reduce((sum, provider) => sum + s.launches[provider], 0);
  if (total === 0) return "No agents yet this session; using your last one";
  let out = "Since start:";
  Provider.all.forEach(
    (provider, i) =>
      (out += `${i === 0 ? "" : " ·"} ${Provider.info(provider).executables[0]} ${s.launches[provider]}×`),
  );
  return out;
}
