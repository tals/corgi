//! Setup modal opened from the corgi badge (or `prefix i`), centered on screen.
//! The settings list sits on the left with each current value, and the
//! selected setting's options on the right. Viewer-owned: Enter and clicks
//! return an `Apply` that the controller carries out. Opening Keymap grows
//! the frame to fit onboarding's preset detail beside the presets; an import
//! source shows onboarding's import picker in place of options. Source
//! control edits the worktree folder template in place, with a preview.
import { homedir } from "node:os";
import { join } from "node:path";
import * as palette from "./palette";
import { Style, colors, bgRgb, mix, type Token } from "./palette";
import { Rect } from "./layout";
import { Provider } from "./providers";
import { Model } from "./providers/model";
import * as corgiAnimation from "./corgi_animation";
import * as km from "./keymap";
import * as bindings from "./bindings";
import * as onboarding from "./onboarding";
import * as catalog from "./import/catalog";
import * as importPicker from "./import/picker";
import type { Action } from "./action";
import type { Preferences } from "./preferences";
import * as ghosttyIntegration from "./ghostty_integration";
import type { State as IntegrationState } from "./ghostty_integration";
import type { State as ClipboardState } from "./host_clipboard";
import * as framePacing from "./frame_pacing";
import { Writer, clamp, directoryLabel, displayWidth, writeEllipsis, sat } from "./text";
import { Dialog } from "./name_dialog";
import * as keys from "./keys";
import * as worktreeFolder from "./worktree_folder";
import * as shellPicker from "./shell_picker";
import * as scrollThumb from "./scroll_thumb";
import * as settingRow from "./setting_row";
import * as dropdown from "./dropdown";
import type { ShellStatus } from "./launch/command";
import type { Connection } from "./rpc";
import type { Use, Uses } from "./inference/setup";

/** The inference setup status the daemon publishes, as inference.zig's `Status`. */
export interface Status {
  choice: Summarizer;
  provider: Provider | null;
  model: string;
  locked: boolean;
  launches: { codex: number; claude: number };
  models: { codex: string; claude: string };
  uses: Uses;
}
export function status(value: any = {}): Status {
  // A daemon from before uses were separate says "off" for all of them.
  const on = value?.choice !== "off",
    use = (v: unknown) => (typeof v === "boolean" ? v : on);
  return {
    choice: value?.choice ?? "auto",
    provider: value?.provider ?? null,
    model: value?.model ?? "",
    locked: value?.locked === true,
    launches: { codex: Number(value?.launches?.codex ?? 0), claude: Number(value?.launches?.claude ?? 0) },
    models: { codex: value?.models?.codex ?? "", claude: value?.models?.claude ?? "" },
    uses: {
      activity: use(value?.uses?.activity),
    },
  };
}
/** Who answers what Corgi asks the model; "off" only from an older daemon. */
export type Summarizer = "auto" | "codex" | "claude" | "off";
const summarizers: Summarizer[] = ["auto", "codex", "claude"];
export const Summarizer = {
  provider(choice: Summarizer): Provider | null {
    return choice === "codex" || choice === "claude" ? choice : null;
  },
  label(choice: Summarizer): string {
    return { auto: "Auto", codex: "Codex", claude: "Claude", off: "Off" }[choice];
  },
};

export type Item =
  | "flourishes"
  | "readings"
  | "clever_corgi"
  | "theme"
  | "shell"
  | "keyboard"
  | "source_control"
  | "terminal"
  | ImportItem
  | "detach";
type ImportItem = "import_tmux" | "import_herdr" | "import_cmux";
const import_sources: Record<ImportItem, catalog.Source> = {
  import_tmux: "tmux",
  import_herdr: "herdr",
  import_cmux: "cmux",
};
/** A list row: a setting, a group's heading, or a gap between groups. */
type ListRow = Item | { heading: string } | null;
/** The list, top to bottom. */
const list: ListRow[] = [
  "clever_corgi",
  "flourishes",
  "readings",
  null,
  "theme",
  "shell",
  "keyboard",
  "source_control",
  null,
  "terminal",
  null,
  { heading: "Import from" },
  ...(Object.keys(import_sources) as ImportItem[]).filter(item =>
    catalog.available_sources.includes(import_sources[item]),
  ),
  null,
  "detach",
];
export const items = list.filter((row): row is Item => typeof row === "string");
const labels: Record<Item, string> = {
  flourishes: "Visual flourishes",
  readings: "Resources",
  clever_corgi: "Clever Corgi",
  theme: "Theme",
  shell: "Shell",
  keyboard: "Keymap",
  source_control: "Source control",
  terminal: "Terminal capabilities",
  import_tmux: "tmux",
  import_herdr: "Herdr",
  import_cmux: "cmux",
  detach: "Detach",
};
/** An item's name on its own, as the crumb and the pane's title give it. */
function fullLabel(item: Item): string {
  return importSource(item) === null ? labels[item] : `Import from ${labels[item]}`;
}
/** The import source an item offers, or null for settings. */
function importSource(item: Item): catalog.Source | null {
  return item in import_sources ? import_sources[item as ImportItem] : null;
}

/** What Enter or a click asks the controller to do. */
export type Apply =
  | { kind: "summaries"; choice: Summarizer }
  | { kind: "inference_use"; use: Use; on: boolean }
  | { kind: "readings" | "sleeping_corgis" | "smart_links" | "ghostty"; on: boolean }
  | { kind: "theme"; theme: palette.Theme }
  | { kind: "shell"; entry: shellPicker.Entry }
  | { kind: "preset"; preset: km.Preset }
  | { kind: "prefix" }
  | { kind: "keymap" }
  /** Where the launcher puts new worktrees. */
  | { kind: "worktree_folder"; template: string }
  /** Copy the import picker's choice into Corgi. */
  | { kind: "import" }
  /** Close setup on the workspace an import made. */
  | { kind: "imported"; workspace: number | null }
  /** Leave Corgi running and close this viewer. */
  | { kind: "detach" };
/** A list row, an option, a choice in the open dropdown, or the import
 * picker under the pointer. */
export type Hit = { item: Item } | { option: number } | { choice: number } | { picker: importPicker.Hit };

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
  /** Status glyphs on the theme's background, before the detail. */
  swatch?: palette.Theme;
  /** A toggle in a group: On or Off at the right edge, as in the list. */
  toggle?: boolean;
  /** An icon before a toggle's name, where other options keep their mark. */
  glyph?: string;
  /** A dropdown in a group: the choice in use at the right edge, green while
   * `on`, and Enter opens `choices`. */
  choice?: { text: string; on: boolean; choices: Choice[] };
  /** A text field, in a box, that takes typing while it has the cursor. */
  edit?: boolean;
}
/** What the viewer found out about its terminal, for Terminal capabilities. */
export interface Terminal {
  /** As the terminal reports itself, or names itself in the environment. */
  name: string;
  ssh: boolean;
  graphics: boolean;
  /** Whether it reported its colors. */
  colors: boolean;
}
/** Whether the terminal has a capability (✓), lacks it (–), needs fixing for
 * it (!) or is still telling (…). */
type Found = "yes" | "no" | "fix" | "checking";
/** Image paste's support, as Terminal capabilities marks it. */
const paste_found: Record<ClipboardState["support"], Found> = {
  probing: "checking",
  on: "yes",
  denied: "fix",
  unsupported: "no",
};
/** One of a dropdown's choices. */
interface Choice {
  text: string;
  note: string;
  current: boolean;
  apply: Apply;
}
type Line =
  | { tag: "title" | "lead" | "note" | "warn"; text: string }
  /** One line under a setting in a group, aligned with its name. */
  | { tag: "brief"; text: string; tone?: "muted" | "warm" }
  /** The top or bottom of the box around an `edit` option. */
  | { tag: "box"; edge: "top" | "bottom" }
  /** What a field makes, after an arrow; a long one keeps its end. */
  | { tag: "result"; text: string }
  /** What's wrong with a field, under it, wrapped. */
  | { tag: "problem"; text: string }
  /** A variable a field takes, and what it stands for here. */
  | { tag: "variable"; name: string; value: string }
  | { tag: "blank" }
  /** A rule that sets a setting apart from the options above it. */
  | { tag: "rule" }
  /** How an idle agent's row looks: the napping corgi, or a dim ᶻ. */
  | { tag: "nap"; asleep: boolean }
  /** A row of a setting's mini keymap: what a key does, and the key. */
  | { tag: "binding"; job: string; key: string; dim: boolean }
  | { tag: "keys"; keys: [string, string][] }
  /** A capability, marked by whether the terminal has it; none for a plain fact. */
  | { tag: "capability"; name: string; mark: Found | null }
  /** A row of the chart of the host's answer times; the last is its time axis. */
  | { tag: "chart"; row: number }
  /** The answer times in one row, on a short frame, and `text` at its end. */
  | { tag: "spark"; text: string }
  | { tag: "option"; option: Option; index: number }
  /** The import picker, down to the bottom of the pane. */
  | { tag: "picker" };

let panel: string, border: string, text: string, bright: string, warm: string, graph: string, hint_key: string;
let row_resting: settingRow.Row;
palette.derived(() => {
  panel = new Style({ fg: "faint", bg: "surface" }).sgr();
  border = new Style({ fg: "line", bg: "surface" }).sgr();
  text = new Style({ fg: "text", bg: "surface" }).sgr();
  bright = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  warm = new Style({ fg: "warm", bg: "surface" }).sgr();
  graph = new Style({ fg: "accent", bg: "surface" }).sgr();
  hint_key = new Style({ fg: "muted", bg: "surface" }).sgr();
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
/** The chart row for `ms`; time at or below zero falls to the bottom. */
function chartRow(ms: number): number {
  return clamp(Math.round((3 - Math.log10(Math.max(ms, 1e-3))) * 2), 0, chart_rows - 1);
}
/** `ms` as "24 ms" or "1.4 s", and with `sd` to the same digit, "24 ms ± 6". */
function duration(ms: number, sd?: number): string {
  const [scale, unit] = ms >= 1000 ? [1000, "s"] : [1, "ms"],
    digits = ms / scale < 9.95 ? 1 : 0,
    figure = (v: number) => (v / scale).toFixed(digits);
  return `${figure(ms)} ${unit}` + (sd === undefined ? "" : ` ± ${figure(sd)}`);
}

const list_w = 26;
/** The frame's height on a tall terminal. */
const height_max = 40;
/** The options column beside onboarding's preset detail. */
const options_w = 34;
const two_pane_cols = 80;
const single_max = 56;
const single_min = 44;
/** The answer-time chart's rows, half a decade apart from 1 s down to 1 ms. */
const chart_rows = 7;
/** Labels and the axis take this many columns before the chart's plot. */
const chart_inset = 8;
const hold_row = chartRow(framePacing.hold_after_ms);
const spark = "▁▂▃▄▅▆▇█";
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
/** How the selected setting's rows fit the frame; see `Menu.content`. */
interface Fit {
  keys: boolean;
  brief: boolean;
  chart: boolean;
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
  // As tall as the terminal allows, a row short of each edge where it can.
  const h0 = Math.min(height_max, Math.max(Math.min(rows, 12), rows - 2));
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
    h = Math.round(h0 + Math.max(0, (size?.h ?? h0) - h0) * t),
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
  item: Item = "clever_corgi";
  focus: "list" | "options" = "list";
  /** The highlighted option while the options have focus. */
  cursor = 0;
  integration: IntegrationState = "unavailable";
  /** Whether Command keys changed while setup was open, so Ghostty needs a reload. */
  reload_ghostty = false;
  /** The host terminal's clipboard; null when the viewer has no terminal. */
  image_paste: ClipboardState | null = null;
  /** What the viewer found out about its terminal. */
  terminal: Terminal = { name: "", ssh: false, graphics: false, colors: false };
  /** The viewer's frame pacing, which times the host's answers; null when the viewer has no terminal. */
  pacing: framePacing.Pacer | null = null;
  /** The shell new panes run, as the daemon last published it. */
  shell: ShellStatus = shellPicker.status();
  /** Shells /etc/shells lists, offered beside the default. */
  shells: string[] = [];
  /** Whether the daemon probes the ports servers print, for Open ↗ buttons. */
  smart_links = true;
  /** The worktree folder template being typed, while Source control edits it. */
  editing: Dialog | null = null;
  /** A project the worktree folder's preview places a branch in; an example when null. */
  project: { name: string; root: string } | null = null;
  /** Where the field's caret was drawn, for the terminal's cursor. */
  private caret: { x: number; y: number } | null = null;
  /** Sessions from the import source under the list's cursor. */
  readonly import_picker = new importPicker.Picker();
  /** The source the picker last switched to. */
  private import_source: catalog.Source | null = null;
  /** The list's first row shown while it scrolls. */
  private list_first = 0;
  /** Whether the prefix key came last; setup runs only detach after it. */
  private after_prefix = false;
  /** The open dropdown: its setting's option, and the highlighted choice. */
  private dropdown: { option: number; at: number } | null = null;
  /** The frame's growth toward the preset detail, eased between draws. */
  private grow = { from: 0, to: 0, at_ms: 0 };
  static open(): Menu {
    return new Menu();
  }
  close(): void {
    this.import_picker.close();
  }
  /** The import picker while the list's cursor is on an import source,
   * switched to that source. A copy keeps the source it started from. */
  private importing(): importPicker.Picker | null {
    const source = importSource(this.item),
      picker = this.import_picker;
    if (source === null) return null;
    if (source !== this.import_source && picker.stage === "choose") {
      picker.changeSource(source);
      this.import_source = source;
    }
    return picker;
  }
  /** Whether a copy is under way; setup stays on it until it ends. */
  private copying(): boolean {
    return this.import_picker.stage === "copying" && !this.import_picker.failed();
  }
  /** Leaving a finished import offers the source's sessions afresh. */
  private leaveImport(): void {
    if (this.import_picker.stage === "complete") this.import_picker.restart();
  }
  /** True when the import picker changed and needs drawing. */
  async poll(conn: Pick<Connection, "call">): Promise<boolean> {
    const picker = this.importing();
    return picker !== null && (await picker.poll(conn));
  }
  /** Prefix shortcuts in setup: the prefix waits for the next key, which
   * detaches when it is the preset's detach key; setup drops the other
   * shortcuts. Null for keys setup handles itself. */
  prefixKey(byte: number, prefs: Preferences): "detach" | "taken" | null {
    if (this.after_prefix) {
      this.after_prefix = false;
      const b = bindings.find(prefs.preset, action("detach"));
      return b && b.prefixed && b.key === byte && !Object.values(b.mods).some(Boolean) ? "detach" : "taken";
    }
    if (byte !== km.prefixByte(prefs.prefix)) return null;
    this.after_prefix = true;
    return "taken";
  }
  /** The field's or the import picker's own keys while they have focus;
   * false for the rest. Enter and Esc go on to save or cancel the field. */
  key(byte: number): boolean {
    if (this.editing) {
      if (byte === 13 || byte === 27) return false;
      if (byte !== 9) this.editing.key(byte);
      this.completeRoot();
      return true;
    }
    const picker = this.focus === "options" ? this.importing() : null;
    if (picker?.stage !== "choose") return false;
    picker.message = "";
    return picker.key(byte);
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
  /** Escape sequences the field takes while it has focus: caret movement
   * and Delete. Arrows up and down stay with it rather than move. */
  sequence(text: string): boolean {
    if (!this.editing) return false;
    const k = keys.parse(text);
    if (k !== "up" && k !== "down" && k !== "shift_tab") this.editing.sequence(text);
    return true;
  }
  paste(byte: number): void {
    this.editing?.pasteByte(byte);
    this.completeRoot();
  }
  /** A leading `./` becomes the `$PROJECT_ROOT/` it means, as it's typed. */
  private completeRoot(): void {
    const e = this.editing;
    const done = e && worktreeFolder.completeRoot(e.bytes(0, e.len), e.cursor);
    if (!done) return;
    this.editing = Object.assign(Dialog.init({ agent_command: 0 }, done.template), { selected: false });
    this.editing.position(done.cursor);
  }
  /** Moves the cursor within the focused column, past either end to the
   * other when `wrap`. */
  move(next: boolean, s: Status, prefs: Preferences, wrap = true): void {
    if (this.editing) return;
    if (this.dropdown !== null) {
      const d = this.dropdown,
        n = this.choices(s, prefs).length;
      d.at = wrap ? (d.at + (next ? 1 : n - 1)) % n : clamp(d.at + (next ? 1 : -1), 0, n - 1);
      return;
    }
    const picker = this.focus === "options" ? this.importing() : null;
    if (picker) {
      picker.message = "";
      if (picker.stage === "choose") picker.move(next, wrap);
      return;
    }
    if (this.focus === "list") {
      const index = items.indexOf(this.item),
        n = items.length;
      this.item = items[wrap ? (index + (next ? 1 : n - 1)) % n : next ? Math.min(index + 1, n - 1) : sat(index, 1)];
      return;
    }
    const options = this.options(s, prefs),
      n = options.length;
    for (let step = 1; step < n; step++) {
      const i = this.cursor + (next ? step : -step);
      if (!wrap && (i < 0 || i >= n)) return;
      if (!options[(i + n) % n].disabled) {
        this.cursor = (i + n) % n;
        return;
      }
    }
  }
  /** Gives the options focus, on the one in use. False when none can be chosen. */
  openOptions(s: Status, prefs: Preferences): boolean {
    if (this.importing()) {
      this.focus = "options";
      return true;
    }
    const options = this.options(s, prefs);
    if (options.every(o => o.disabled)) return false;
    const used = options.findIndex(o => o.mark === "on" && !o.disabled);
    this.focus = "options";
    this.cursor = used >= 0 ? used : options.findIndex(o => !o.disabled);
    // A field takes typing as soon as it has the cursor.
    if (options[this.cursor]?.edit) this.edit(prefs);
    return true;
  }
  /** Returns focus to the list. False when it already has it. */
  back(): boolean {
    if (this.editing) {
      this.editing = null;
      this.focus = "list";
      return true;
    }
    if (this.focus === "list") return false;
    if (this.dropdown !== null) {
      this.dropdown = null;
      return true;
    }
    const picker = this.importing();
    if (picker?.stage === "copying") {
      if (picker.failed()) picker.retry();
      return true;
    }
    this.leaveImport();
    this.focus = "list";
    return true;
  }
  /** Enter: an on/off setting flips from the list; the rest open their options. */
  enter(s: Status, prefs: Preferences): Apply | null {
    if (this.editing) {
      // A template with a problem stays open; the line under it says why.
      // Saving an empty field saves the default it shows.
      const template = this.editing.name() || worktreeFolder.default_template;
      if (worktreeFolder.problem(template) !== null) return null;
      this.editing = null;
      this.focus = "list";
      return template === prefs.worktree_folder ? null : { kind: "worktree_folder", template };
    }
    const picker = this.importing();
    if (this.focus === "options" && picker) return enterImport(picker);
    if (this.dropdown !== null) return this.choose(this.dropdown.at, s, prefs);
    if (this.focus === "options") {
      const option = this.options(s, prefs)[this.cursor];
      if (option?.choice !== undefined) {
        this.dropdown = {
          option: this.cursor,
          at: Math.max(
            0,
            option.choice.choices.findIndex(c => c.current),
          ),
        };
        return null;
      }
      return option && !option.disabled ? option.apply : null;
    }
    const flip = this.flip(prefs);
    if (flip) return flip;
    this.openOptions(s, prefs);
    return null;
  }
  /** What Enter on the list does for an on/off setting or an action. */
  private flip(prefs: Preferences): Apply | null {
    switch (this.item) {
      case "readings":
        return { kind: "readings", on: !prefs.resources.enabled };
      case "detach":
        return { kind: "detach" };
      default:
        return null;
    }
  }
  /** Starts editing the worktree folder, the caret after what's saved. */
  private edit(prefs: Preferences): void {
    this.editing = Object.assign(Dialog.init({ agent_command: 0 }, prefs.worktree_folder), { selected: false });
  }
  /** A click: the list selects, then opens; an option applies. */
  click(hit: Hit, s: Status, prefs: Preferences): Apply | null {
    // A click away from the field drops what it typed.
    const on_field = "option" in hit && this.options(s, prefs)[hit.option]?.edit === true;
    if (this.editing && !on_field) this.editing = null;
    // The open dropdown takes the click, or closes.
    if (this.dropdown !== null) {
      const choice = "choice" in hit ? this.choose(hit.choice, s, prefs) : null;
      this.dropdown = null;
      return choice;
    }
    if ("choice" in hit) return null;
    if ("picker" in hit) {
      const picker = this.importing();
      if (picker) {
        this.focus = "options";
        picker.message = "";
        picker.click(hit.picker);
      }
      return null;
    }
    if ("item" in hit) {
      if (this.copying()) return null;
      if (hit.item === this.item && this.focus === "list") return this.enter(s, prefs);
      this.leaveImport();
      this.item = hit.item;
      this.focus = "list";
      return null;
    }
    const option = this.options(s, prefs)[hit.option];
    if (!option || option.disabled) return null;
    this.focus = "options";
    this.cursor = hit.option;
    if (option.choice !== undefined) return this.enter(s, prefs);
    if (option.edit) {
      if (!this.editing) this.edit(prefs);
      return null;
    }
    return option.apply;
  }
  /** The open dropdown's choices. */
  private choices(s: Status, prefs: Preferences): Choice[] {
    return this.dropdown === null ? [] : (this.options(s, prefs)[this.dropdown.option]?.choice?.choices ?? []);
  }
  /** Closes the dropdown on choice `index`; Apply when it isn't the one in use. */
  private choose(index: number, s: Status, prefs: Preferences): Apply | null {
    const choice = this.choices(s, prefs)[index];
    this.dropdown = null;
    return choice && !choice.current ? choice.apply : null;
  }
  /** Pointer motion highlights rows in the focused column. */
  hover(hit: Hit, s: Status, prefs: Preferences): void {
    if ("choice" in hit) {
      if (this.dropdown !== null) this.dropdown.at = hit.choice;
    } else if (this.dropdown !== null) return;
    else if ("item" in hit) {
      if (this.focus === "list") this.item = hit.item;
    } else if ("option" in hit && this.focus === "options" && !this.options(s, prefs)[hit.option]?.disabled)
      this.cursor = hit.option;
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
        const item = this.listRows(l.body)[row];
        return typeof item === "string" ? { item } : null;
      }
    }
    if (l.single && this.focus === "list") return null;
    const open = this.dropdownBox(l, s, prefs);
    if (open?.contains(x, y)) {
      const index = dropdown.hit(open, this.choices(s, prefs).length, x, y);
      return index === null ? null : { choice: index };
    }
    if (x < l.options.x || x >= l.options.x + l.options.w) return null;
    const lines = this.lines(s, prefs, l),
      at_picker = lines.findIndex(line => line.tag === "picker");
    if (at_picker >= 0 && row >= at_picker) {
      const hit = this.import_picker.hit(pickerArea(l, at_picker), x, y);
      return hit && { picker: hit };
    }
    // A click on the field's box is a click on the field.
    const box = lines[row]?.tag === "box" ? (lines[row] as { edge: string }).edge : null,
      line = box === "top" ? lines[row + 1] : box === "bottom" ? lines[row - 1] : lines[row];
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
    this.caret = null;
    frame(w, b, l.dividers);
    w.write(`${at(b.x + 2, b.y)}${text} ᐯ•ᴥ•ᐯ ${bright}Corgi setup `);
    const list_shown = l.single ? this.focus === "list" : l.list === list_w;
    if (!list_shown && (l.single || l.list < list_w / 2)) {
      // The crumb stops short of a divider's corner.
      const room = Math.min(b.w - 23, ...l.dividers.filter(x => x > b.x + 21).map(x => x - b.x - 22));
      w.write(at(b.x + 21, b.y) + hint_key);
      writeEllipsis(w, `› ${fullLabel(this.item)} `, room);
    }
    if (list_shown) this.drawList(w, b.x + 1, top, l.single ? b.w - 2 : list_w, l.body, s, prefs);
    if (!(l.single && this.focus === "list")) this.drawOptions(w, l, s, prefs, now_ms);
    const open = this.dropdownBox(l, s, prefs);
    if (open)
      dropdown.draw(
        w,
        open,
        this.choices(s, prefs).map((choice, i) => ({
          text: choice.text,
          note: choice.note,
          current: choice.current,
          hovered: i === this.dropdown?.at,
        })),
      );
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
    // drawField sets it, after the reset above.
    const caret = this.caret as { x: number; y: number } | null;
    if (caret) w.write(at(caret.x, caret.y) + "\x1b[?25h");
  }
  private drawList(w: Writer, x: number, y: number, width: number, body: number, s: Status, prefs: Preferences) {
    this.listRows(body).forEach((row, i) => {
      if (row === null) return;
      if (typeof row !== "string") {
        w.write(at(x + 2, y + i) + panel);
        return writeEllipsis(w, row.heading, width - 4);
      }
      const item = row,
        chosen = item === this.item,
        p = !chosen ? settingRow.normal : this.focus === "list" ? settingRow.selected : row_resting,
        // A group's items sit under its heading.
        indent = importSource(item) === null ? 2 : 4;
      if (chosen) {
        w.write(at(x, y + i) + p.text);
        w.splat(" ", width);
      }
      w.write(at(x + indent, y + i) + (chosen ? p.label : p.text));
      writeEllipsis(w, labels[item], width - indent - 2);
      const v = this.value(item, s, prefs);
      if (v.text.length > 0)
        w.write(
          at(x + width - 2 - displayWidth(v.text), y + i) +
            (v.tone === "muted" ? p.muted : v.tone === "warm" ? p.warn : p.quiet) +
            v.text,
        );
    });
    const bar = scrollThumb.thumb(body, this.listLength(body), this.list_first);
    if (bar) for (let k = bar.start; k < bar.start + bar.len; k++) w.write(at(x + width, y + k) + panel + "┃");
  }
  /** The rows `body` rows show: short frames drop the gaps between groups,
   * then scroll to keep the selected item, and its heading, in view. */
  private listRows(body: number): ListRow[] {
    const rows = body >= list.length ? list : list.filter(row => row !== null);
    if (rows.length <= body) {
      this.list_first = 0;
      return rows;
    }
    const at = rows.indexOf(this.item),
      above = rows[at - 1],
      top = above && typeof above === "object" ? at - 1 : at;
    this.list_first = clamp(clamp(this.list_first, at - body + 1, top), 0, rows.length - body);
    return rows.slice(this.list_first, this.list_first + body);
  }
  /** Rows the list has to show in `body` rows, before scrolling. */
  private listLength(body: number): number {
    return body >= list.length ? list.length : list.filter(row => row !== null).length;
  }
  private drawOptions(w: Writer, l: Layout, s: Status, prefs: Preferences, now_ms: number) {
    const x = l.options.x,
      width = l.options.w,
      x0 = x + 2,
      right = x + width - 1,
      lines = this.lines(s, prefs, l),
      // Rows with their value at the right edge keep out of the label column.
      label_w = Math.max(
        0,
        ...lines.map(line =>
          line.tag === "option" && line.option.toggle === undefined && line.option.choice === undefined
            ? displayWidth(line.option.label)
            : 0,
        ),
      );
    lines.forEach((line, i) => {
      const y = l.b.y + 2 + i;
      switch (line.tag) {
        case "blank":
          return;
        case "rule":
          w.write(at(x0, y) + border + "─".repeat(sat(right, x0)));
          return;
        case "nap": {
          // The sidebar's sleeper, puffing every few seconds; without it, its ᶻ.
          if (!line.asleep) return w.write(at(x0 + 4, y) + panel + "ᶻ");
          const elapsed = ((now_ms % preview_period_ms) + preview_period_ms) % preview_period_ms;
          w.write(at(x0 + 4, y) + text);
          w.write(
            corgiAnimation.idle(Math.min(12, sat(right, x0 + 4)), {
              background: settingRow.normal.background,
              bright: true,
              selected: false,
              puff_ms: elapsed,
            }),
          );
          return;
        }
        case "binding": {
          // The full keymap's rows: the job, and its key at the column's end.
          const end = Math.min(x0 + 4 + binding_w, right),
            key_x = sat(end, displayWidth(line.key));
          w.write(at(x0 + 4, y) + (line.dim ? panel : text));
          writeEllipsis(w, line.job, sat(key_x - 1, x0 + 4));
          w.write(at(key_x, y) + (line.dim ? panel : bright) + line.key);
          return;
        }
        case "title":
          w.write(at(x0, y) + bright);
          return writeEllipsis(w, line.text, right - x0);
        case "lead":
        case "note":
        case "warn":
          w.write(at(x0, y) + (line.tag === "warn" ? warm : panel));
          return writeEllipsis(w, line.text, right - x0);
        case "brief":
          w.write(
            at(x0 + 4, y) + (line.tone === "muted" ? settingRow.normal.muted : line.tone === "warm" ? warm : panel),
          );
          return writeEllipsis(w, line.text, right - x0 - 4);
        case "box": {
          const edge = line.edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
          w.write(at(x0, y) + (this.editing ? graph : border) + edge[0] + "─".repeat(sat(right, x0 + 2)) + edge[1]);
          return;
        }
        case "result": {
          w.write(at(x0 + 2, y) + panel + "→ " + text);
          // The end of a path says the most; its start gives way.
          const room = sat(right, x0 + 4),
            chars = Array.from(line.text);
          if (displayWidth(line.text) <= room) return w.write(line.text);
          let tail = "";
          while (chars.length > 0 && displayWidth(chars[chars.length - 1] + tail) < room) tail = chars.pop()! + tail;
          return w.write("…" + tail);
        }
        case "problem":
          w.write(at(x0 + 2, y) + warm);
          return writeEllipsis(w, line.text, sat(right, x0 + 2));
        case "variable":
          w.write(at(x0 + 2, y) + graph + line.name.padEnd(15) + panel);
          return writeEllipsis(w, line.value, sat(right, x0 + 17));
        case "capability":
          if (line.mark !== null)
            w.write(
              at(x0 + 2, y) +
                { yes: `${settingRow.normal.accent}✓`, no: `${panel}–`, fix: `${warm}!`, checking: `${panel}…` }[
                  line.mark
                ],
            );
          w.write(at(x0 + 4, y) + text);
          return writeEllipsis(w, line.name, right - x0 - 4);
        case "chart":
          return this.drawChart(w, line.row, x0 + 4, right, y, now_ms);
        case "spark": {
          const end = sat(right, displayWidth(line.text) + 2);
          let shown = "";
          w.write(at(x0 + 4, y));
          for (const column of this.chartColumns(sat(end, x0 + 4), now_ms)) {
            const t = column?.timing,
              [style, cell] = column?.lost
                ? [warm, "✕"]
                : t
                  ? [graph, spark[clamp(Math.round((Math.log10(Math.max(t.mean, 1)) / 3) * 7), 0, 7)]]
                  : [graph, " "];
            if (style !== shown) w.write((shown = style));
            w.write(cell);
          }
          w.write(at(end + 2, y) + panel + line.text);
          return;
        }
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
        case "picker":
          return this.import_picker.draw(w, pickerArea(l, i), this.focus === "options");
      }
    });
  }
  /** The worktree folder's row of its box, from `x` to `right`: the template,
   * as saved or as typed, its variables green and bad `$`s amber, scrolled to
   * keep the caret in view. Empty, it shows the default it would save. */
  private drawField(w: Writer, x: number, y: number, right: number, prefs: Preferences) {
    const editor = this.editing,
      room = sat(right, x + 4),
      typed = editor ? editor.bytes(0, editor.len) : prefs.worktree_folder,
      line = this.editing ? graph : border;
    w.write(at(x, y) + line + "│" + at(sat(right, 1), y) + line + "│");
    w.write(at(x + 2, y));
    if (typed.length === 0) {
      w.write(panel);
      writeEllipsis(w, worktreeFolder.default_template, room);
      this.caret = { x: x + 2, y };
      return;
    }
    const cells: [string, string][] = [];
    for (const token of worktreeFolder.tokens(typed))
      for (const ch of token.text)
        cells.push([ch, token.kind === "variable" ? graph : token.kind === "bad" ? warm : editor ? bright : text]);
    const at_caret = editor ? Array.from(editor.bytes(0, editor.cursor)).length : 0,
      first = Math.max(0, at_caret - room + 1);
    let shown = "",
      used = 0;
    for (const [ch, style] of cells.slice(first)) {
      if (used + displayWidth(ch) > room) break;
      if (style !== shown) w.write((shown = style));
      w.write(ch);
      used += displayWidth(ch);
    }
    if (editor)
      this.caret = {
        x:
          x +
          2 +
          displayWidth(
            cells
              .slice(first, at_caret)
              .map(c => c[0])
              .join(""),
          ),
        y,
      };
  }
  /** One row of the answer-time chart from `x`: the running mean (█) and a
   * deviation either side (░) at each column's last answer, on a log scale,
   * with ✕ where a request was lost. The last row is the time axis. */
  private drawChart(w: Writer, row: number, x: number, right: number, y: number, now_ms: number) {
    const axis = x + chart_inset - 1,
      n = sat(right, axis + 1);
    if (row === chart_rows) {
      const since = ` −${(n * framePacing.column_ms) / 1000} s `;
      w.write(at(axis, y) + border + "└─" + panel + since + border + "─".repeat(sat(n, since.length + 5)));
      w.write(panel + " now");
      return;
    }
    const label = row === hold_row ? "hold" : row % 2 === 0 ? ["1 s", "100 ms", "10 ms", "1 ms"][row / 2] : "";
    w.write(at(axis - 1 - label.length, y) + panel + label + " " + border + "┤");
    let shown = border;
    for (const column of this.chartColumns(n, now_ms)) {
      const t = column?.timing,
        [style, cell] =
          column?.lost && row === 0
            ? [warm, "✕"]
            : t && row === chartRow(t.mean)
              ? [graph, "█"]
              : t && row >= chartRow(t.mean + t.sd) && row <= chartRow(t.mean - t.sd)
                ? [graph, "░"]
                : row === hold_row
                  ? [border, "┈"]
                  : [border, " "];
      if (style !== shown) w.write((shown = style));
      w.write(cell);
    }
  }
  /** The pacer's columns ending now, `n` of them; null where nothing was answered or lost. */
  private chartColumns(n: number, now_ms: number): (framePacing.Column | null)[] {
    const columns = new Map((this.pacing?.columns ?? []).map(c => [c.at, c])),
      last = Math.floor(now_ms / framePacing.column_ms);
    return Array.from({ length: n }, (_, k) => columns.get(last - n + 1 + k) ?? null);
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
      x0 = x + 2,
      right = x + width - 1;
    if (o.toggle !== undefined)
      return settingRow.drawToggle(w, x, y, width, {
        label: o.label,
        on: o.toggle,
        here,
        disabled: o.disabled,
        glyph: o.glyph,
      });
    if (o.choice !== undefined) return settingRow.drawChoice(w, x, y, width, o.label, o.choice.text, o.choice.on, here);
    if (o.edit) return this.drawField(w, x0, y, right, prefs);
    const p = settingRow.fill(w, x, y, width, here);
    if (o.mark !== "none")
      w.write(at(x0 + 2, y) + (o.mark === "on" && !o.disabled ? p.accent : p.quiet) + (o.mark === "on" ? "●" : "○"));
    w.write(at(x0 + 4, y) + (o.disabled ? p.quiet : p.label));
    writeEllipsis(w, o.label, Math.min(label_w, sat(right, x0 + 4)));
    let dx = x0 + 4 + label_w + 3;
    if (o.swatch && right - dx >= 7) {
      w.write(
        `${at(dx, y)}\x1b[0;1m${palette.bg("bg", o.swatch)}${palette.fg("accent", o.swatch)} ▶ ` +
          `${palette.fg("warm", o.swatch)}● \x1b[22m${palette.fg("muted", o.swatch)}○ `,
      );
      dx += 8;
    }
    w.write(at(dx, y) + (o.disabled ? p.quiet : o.warn ? p.warn : p.muted));
    writeEllipsis(w, o.detail, sat(right - (o.arrow ? 3 : 0), dx));
    if (o.arrow) w.write(at(right - 2, y) + p.muted + "→");
  }
  /** The open dropdown's box, under its setting's row with ✓ under the ›;
   * null while it is closed. */
  private dropdownBox(l: Layout, s: Status, prefs: Preferences): Rect | null {
    const d = this.dropdown;
    if (d === null) return null;
    const row = this.lines(s, prefs, l).findIndex(line => line.tag === "option" && line.index === d.option);
    if (row < 0) return null;
    const h = this.choices(s, prefs).length + 2,
      bottom = l.b.y + 2 + l.body;
    return new Rect(l.options.x + 2, Math.min(l.b.y + 3 + row, bottom - h), l.options.w - 3, h);
  }
  /** The options pane's rows as they fit `l`: leads and notes wrap, notes
   * give way first, then the options scroll to keep the cursor in view. */
  private lines(s: Status, prefs: Preferences, l: Layout): Line[] {
    const fit = { keys: !l.room, brief: l.options.w < 42, chart: true };
    let out = this.wrapped(s, prefs, l, fit);
    // A short frame draws the answer-time chart as one row.
    if (out.length > l.body && out.some(line => line.tag === "chart"))
      out = this.wrapped(s, prefs, l, { ...fit, chart: false });
    if (out.length <= l.body) return out;
    const first = out.findIndex(line => line.tag === "option"),
      last = out.findLastIndex(line => line.tag === "option"),
      kept = first < 0 ? out : out.slice(0, last + 1);
    if (kept.length <= l.body || first < 0) return kept.slice(0, l.body);
    const head = kept.slice(0, Math.min(first, l.body - 1)),
      options = kept.slice(first),
      span = l.body - head.length,
      cursor = options.findIndex(line => line.tag === "option" && line.index === this.cursor),
      start = Math.min(Math.max(0, cursor - span + 1), options.length - span);
    return head.concat(options.slice(start, start + span));
  }
  /** Frame pacing under Terminal capabilities: how fast the host answers, charted when `chart`. */
  private pacingLines(chart: boolean): Line[] {
    const p = this.pacing,
      name = "Frame pacing";
    if (p === null)
      return [
        { tag: "capability", name, mark: "no" },
        { tag: "brief", text: "This viewer has no terminal." },
      ];
    if (p.timing === null)
      return [
        { tag: "capability", name, mark: "no" },
        { tag: "brief", text: "Never answered, so frames never wait." },
      ];
    const held = p.late + p.lost,
      answers = duration(p.timing.mean, p.timing.sd),
      late: Line = {
        tag: "brief",
        text:
          held === 0
            ? "None late enough to hold frames."
            : `${held} late enough to hold frames; ` +
              (p.lost > 0 ? `${p.lost === 1 ? "one" : p.lost} never came.` : `slowest ${duration(p.slowest)}.`),
      };
    if (!chart) return [{ tag: "capability", name, mark: "yes" }, { tag: "spark", text: answers }, late];
    return [
      { tag: "capability", name, mark: "yes" },
      { tag: "brief", text: `Answers in ${answers}.` },
      late,
      { tag: "blank" },
      ...Array.from({ length: chart_rows + 1 }, (_, row): Line => ({ tag: "chart", row })),
    ];
  }
  /** The selected setting's rows, with leads and notes wrapped to `l`. */
  private wrapped(s: Status, prefs: Preferences, l: Layout, fit: Fit): Line[] {
    const room = l.options.w - 3,
      out: Line[] = [];
    let index = 0;
    for (const line of this.content(s, prefs, fit))
      if (line.tag === "lead" || line.tag === "note" || line.tag === "warn")
        for (const part of wrap(line.text, room)) out.push({ tag: line.tag, text: part });
      else if (line.tag === "problem")
        for (const part of wrap(line.text, sat(room, 2))) out.push({ tag: "problem", text: part });
      else if (line.tag === "option") out.push({ ...line, index: index++ });
      else out.push(line);
    return out;
  }
  private options(s: Status, prefs: Preferences): Option[] {
    return this.content(s, prefs, { keys: false, brief: false, chart: false }).flatMap(line =>
      line.tag === "option" ? [line.option] : [],
    );
  }
  /** The selected setting's rows. `keys` swaps the lead for a line of keys
   * where onboarding's preset detail has no room; `brief` takes the short
   * preset descriptions for a narrow column; `chart` draws the answer times
   * as a chart rather than one row. */
  private content(s: Status, prefs: Preferences, fit: Fit): Line[] {
    const lead = (text: string): Line => ({ tag: "lead", text }),
      option = (o: Option): Line => ({ tag: "option", option: o, index: 0 }),
      title = (text: string): Line => ({ tag: "title", text }),
      blank: Line = { tag: "blank" };
    switch (this.item) {
      case "flourishes":
        return [
          title("Visual flourishes"),
          blank,
          option({
            label: "Idle",
            detail: "",
            mark: "none",
            apply: null,
            action: "change",
            choice: {
              text: prefs.sleeping_corgis ? "Sleeping corgi" : "Blank",
              on: prefs.sleeping_corgis,
              choices: [
                {
                  text: "Sleeping corgi",
                  note: "naps, and snores now and then",
                  current: prefs.sleeping_corgis,
                  apply: { kind: "sleeping_corgis", on: true },
                },
                {
                  text: "Blank",
                  note: "only a dim ᶻ",
                  current: !prefs.sleeping_corgis,
                  apply: { kind: "sleeping_corgis", on: false },
                },
              ],
            },
          }),
          { tag: "nap", asleep: prefs.sleeping_corgis },
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
      case "clever_corgi": {
        const second = note(s.choice, s);
        return [
          title("Clever Corgi"),
          blank,
          option({
            label: "Model",
            detail: "",
            mark: "none",
            apply: null,
            action: "change",
            choice: {
              text: inUse(s),
              on: s.choice !== "off",
              choices: summarizers.map(choice => ({
                text: Summarizer.label(choice),
                note: summary(choice, s),
                current: choice === s.choice,
                apply: { kind: "summaries", choice },
              })),
            },
          }),
          { tag: "brief", text: summary(s.choice, s), tone: "muted" },
          ...(second === null ? [] : [{ tag: "brief", text: second } as Line]),
          blank,
          ...this.clever(s).flatMap((c): Line[] => [
            option({
              label: c.label,
              detail: "",
              mark: "none",
              apply: c.apply(!c.on),
              action: c.on ? "turn off" : "turn on",
              toggle: c.on,
            }),
            { tag: "brief", text: c.brief },
            blank,
          ]),
        ];
      }
      case "theme":
        return [
          title("Theme"),
          lead("Corgi's colors, or your terminal theme's."),
          blank,
          ...palette.available_themes.map(theme =>
            option({
              label: palette.themes[theme].label,
              detail: theme === "corgi" ? "Corgi's own" : "your terminal's",
              mark: theme === prefs.theme ? "on" : "off",
              apply: theme === prefs.theme ? null : { kind: "theme", theme },
              action: "use",
              swatch: theme,
            }),
          ),
          blank,
          { tag: "note", text: "Corgi keeps your background when it's dark and paints its own otherwise." },
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
      case "source_control": {
        const home = homedir(),
          project = this.project ?? { name: "app", root: join(home, "code", "app") },
          template = this.editing ? this.editing.name() || worktreeFolder.default_template : prefs.worktree_folder,
          trouble = worktreeFolder.problem(template),
          values = worktreeFolder.values(project.root, "fix-login", home);
        return [
          title("Worktree folder"),
          { tag: "box", edge: "top" },
          option({ label: "", detail: "", mark: "none", apply: null, action: "save", edit: true }),
          { tag: "box", edge: "bottom" },
          trouble !== null
            ? { tag: "problem", text: trouble }
            : { tag: "result", text: directoryLabel(worktreeFolder.expand(template, project.root, "fix-login"), home) },
          blank,
          ...worktreeFolder.variables.map((name): Line => ({
            tag: "variable",
            name: `$${name}`,
            value: directoryLabel(values[name], home),
          })),
        ];
      }
      case "keyboard": {
        const other = prefs.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
        return [
          title("Keymap"),
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
          blank,
          ...this.commandKeys(prefs),
        ];
      }
      case "terminal": {
        const term = this.terminal,
          clipboard = this.image_paste,
          found = (name: string, mark: Found | null, detail: string, tone?: "muted" | "warm"): Line[] => [
            { tag: "capability", name, mark },
            { tag: "brief", text: detail, tone },
            blank,
          ];
        return [
          title("Terminal capabilities"),
          lead("Detected, not settings: what this terminal can do."),
          blank,
          ...found("Terminal", null, (term.name || "Didn't say its name") + (term.ssh ? " · over SSH" : ""), "muted"),
          ...found(
            "Kitty graphics",
            term.graphics ? "yes" : "no",
            term.graphics ? "Pixel corgi badge and animations." : "🐕 badge; animations stay still.",
          ),
          ...found(
            "Theme colors",
            term.colors ? "yes" : "no",
            term.colors ? "Animal Style takes its colors from them." : "Animal Style keeps Corgi's colors.",
          ),
          ...(clipboard
            ? found(
                "Image paste",
                paste_found[clipboard.support],
                clipboard.diagnosis(),
                clipboard.support === "denied" ? "warm" : undefined,
              )
            : found("Image paste", "no", "This viewer has no terminal to paste from.")),
          ...this.pacingLines(fit.chart),
        ];
      }
      case "detach":
        return [
          title("Detach"),
          lead("Corgi and your agents keep running."),
          blank,
          { tag: "binding", job: "Detach", key: detachKey(prefs), dim: false },
          { tag: "binding", job: "Come back", key: "corgi", dim: false },
        ];
      case "import_tmux":
      case "import_herdr":
      case "import_cmux": {
        const picker = this.importing()!;
        return [
          title({ choose: fullLabel(this.item), copying: picker.heading(), complete: "Import complete" }[picker.stage]),
          picker.message.length > 0 ? { tag: "warn", text: picker.message } : lead(picker.summary()),
          blank,
          { tag: "picker" },
        ];
      }
    }
  }
  /** Ghostty's Command keys, turned on or off under the keymap. */
  private commandKeys(prefs: Preferences): Line[] {
    const works = this.integration === "enabled" || this.integration === "disabled",
      on = this.integration === "enabled",
      brief = (text: string, tone?: "warm"): Line => ({ tag: "brief", text, tone });
    return [
      { tag: "rule" },
      { tag: "blank" },
      {
        tag: "option",
        index: 0,
        option: {
          label: "Command keys",
          glyph: "⌘",
          detail: "",
          mark: "none",
          apply: works ? { kind: "ghostty", on: !on } : null,
          action: on ? "turn off" : "turn on",
          toggle: on,
          disabled: !works,
        },
      },
      ...(this.reload_ghostty ? [brief("Reload Ghostty with ⌘⇧, to apply.", "warm")] : []),
      this.integration === "failed"
        ? brief("Corgi can't read your Ghostty config.", "warm")
        : brief(works ? "In Ghostty only, these keys drive Corgi:" : "Ghostty only, on this Mac; not over SSH."),
      { tag: "blank" },
      ...commandRows(prefs.preset).map(([job, key]): Line => ({ tag: "binding", job, key, dim: !on })),
    ];
  }
  /** Clever Corgi's settings, each turned on or off in the group's pane. */
  /** What Corgi does with the model, and Smart Links, each with its own switch. */
  private clever(s: Status): { label: string; brief: string; on: boolean; apply: (on: boolean) => Apply }[] {
    const use = (use: Use, label: string, brief: string) => ({
      label,
      brief,
      on: s.uses[use],
      apply: (on: boolean): Apply => ({ kind: "inference_use", use, on }),
    });
    return [
      use("activity", "Activity summaries", "What each agent is doing, under its name."),
      {
        label: "Smart Links",
        brief: "Digs up likely HTTP links ↗",
        on: this.smart_links,
        apply: (on: boolean): Apply => ({ kind: "smart_links", on }),
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
      case "flourishes":
        return { text: "", tone: "faint" };
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
      case "source_control":
        return prefs.worktree_folder === worktreeFolder.default_template
          ? { text: "", tone: "faint" }
          : { text: "custom", tone: "muted" };
      case "terminal":
        return { text: "", tone: "faint" };
      case "detach":
        return { text: detachKey(prefs), tone: "faint" };
      case "import_tmux":
      case "import_herdr":
      case "import_cmux":
        return { text: "", tone: "faint" };
    }
  }
  /** Key hints for the bottom border, most important last. */
  private hints(s: Status, prefs: Preferences): [string, string][] {
    if (this.editing)
      return [
        ["enter", "save"],
        ["esc", "back"],
      ];
    const picker = this.importing();
    if (this.focus === "list") {
      const flip = this.flip(prefs),
        open = picker !== null || this.options(s, prefs).some(o => !o.disabled);
      const enter: [string, string][] =
        flip?.kind === "detach"
          ? [["enter", "detach"]]
          : flip && "on" in flip
            ? [["enter", flip.on ? "turn on" : "turn off"]]
            : open
              ? [["enter", "choose"]]
              : [];
      return [["↑↓", "move"], ...enter, ["esc", "close"]];
    }
    if (picker) return importHints(picker);
    if (this.dropdown !== null)
      return [
        ["↑↓", "move"],
        ["enter", "use"],
        ["esc", "close"],
      ];
    const option = this.options(s, prefs)[this.cursor];
    const enter: [string, string][] =
      option && !option.disabled && (option.apply || option.choice !== undefined) ? [["enter", option.action]] : [];
    return [["↑↓", "move"], ...enter, ["esc", "back"]];
  }
}
/** Enter in the import picker: copy the chosen sessions, go back after a
 * failed copy, or open what a finished one made. */
function enterImport(picker: importPicker.Picker): Apply | null {
  picker.message = "";
  switch (picker.stage) {
    case "choose":
      return picker.selectionCount() > 0 ? { kind: "import" } : null;
    case "copying":
      if (picker.failed()) picker.retry();
      return null;
    case "complete": {
      const workspace = picker.progress.workspace;
      return { kind: "imported", workspace: typeof workspace === "number" ? workspace : null };
    }
  }
}
/** Key hints while the import picker has focus, most important last. */
function importHints(picker: importPicker.Picker): [string, string][] {
  switch (picker.stage) {
    case "choose": {
      const count = picker.selectionCount(),
        hints: [string, string][] = [
          ["r", "refresh"],
          ["e", "expand"],
        ];
      if (picker.source === "herdr") hints.push(["h", "handoff"]);
      hints.push(
        ["↑↓", "move"],
        ["space", picker.switch_focused ? (picker.handoff ? "turn off" : "turn on") : "select"],
      );
      if (count > 0) hints.push(["enter", picker.activeHandoff() ? "hand off" : `import ${count}`]);
      hints.push(["esc", "back"]);
      return hints;
    }
    case "copying":
      return picker.failed() ? [["enter", "back"]] : [];
    case "complete":
      return [
        ["enter", "open"],
        ["esc", "back"],
      ];
  }
}
/** Where the import picker draws: from its line to the bottom of the pane. */
function pickerArea(l: Layout, line: number): Rect {
  const x0 = l.options.x + 2,
    right = l.options.x + l.options.w - 1;
  return new Rect(x0, l.b.y + 2 + line, right - x0, l.body - line);
}
function onOff(enabled: boolean, kind: "readings", details: [string, string]): Option[] {
  return [true, false].map((value, i) => ({
    label: value ? "On" : "Off",
    detail: details[i],
    mark: value === enabled ? "on" : "off",
    apply: value === enabled ? null : { kind, on: value },
    action: value ? "turn on" : "turn off",
  }));
}
const action = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
/** The key that detaches under the saved preset, with its prefix. */
function detachKey(prefs: Preferences): string {
  const b = bindings.find(prefs.preset, action("detach"));
  if (!b) return "";
  return b.prefixed ? `${km.prefixName(prefs.prefix)} ${bindings.compact(b)}` : bindings.compact(b);
}
/** The mini keymap's width, as wide as its longest row needs. */
const binding_w = 30;
/** The jobs Command keys' mini keymap shows, where the preset binds them. */
const command_jobs: { job: string; actions: string[] }[] = [
  { job: "New tab", actions: ["new"] },
  { job: "Close tab", actions: ["close-tab"] },
  { job: "Reopen tab", actions: ["undo-close"] },
  { job: "Next / previous", actions: ["next", "prev"] },
  { job: "Select tab", actions: ["tab"] },
  { job: "Select workspace", actions: ["goto-workspace"] },
];
/** Command keys' jobs and keys under `preset`; numbered keys show as ⌘1–9. */
function commandRows(preset: km.Preset): [string, string][] {
  const bound = ghosttyIntegration.commandKeys(preset),
    key = (name: string) => {
      const found = bound.find(b => b.action.name === name && (b.action.value ?? 1) === 1);
      if (!found) return null;
      const label = ghosttyIntegration.macLabel(found.host);
      return found.action.value === 1 ? `${label}–9` : label;
    };
  return command_jobs.flatMap(({ job, actions }) => {
    const keys = actions.map(key);
    return keys.every(k => k !== null) ? [[job, keys.join(" / ")] as [string, string]] : [];
  });
}
/** The keys a preset teaches, on one line, where its detail has no room. */
function keyLine(preset: km.Preset, prefix: km.Prefix): [string, string][] {
  const key = (name: string, value?: string) => onboarding.cardKey({ preset, prefix }, action(name, value));
  return [
    preset === "cmux" ? ["⌘", "+"] : [km.prefixName(prefix), "then"],
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
  if (hints.length === 0 || width(hints) > room) return;
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
/** The second line under Summaries, where the choice needs one. */
function note(choice: Summarizer, s: Status): string | null {
  switch (choice) {
    case "auto":
      return launchCounts(s);
    case "off":
      return "Activity text stays blank; links say Open Link";
    default:
      return null;
  }
}
/** Summaries' value: the choice, and whom Auto follows once it knows. */
function inUse(s: Status): string {
  const label = Summarizer.label(s.choice);
  return s.choice === "auto" && s.provider !== null ? `${label} · ${Provider.info(s.provider).name}` : label;
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
