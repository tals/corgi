//! Setup modal opened from the corgi badge (or `prefix i`), centered on screen.
//! The settings list sits on the left with each current value, and the
//! selected setting's options on the right. Viewer-owned: Enter and clicks
//! return an `Apply` that the controller carries out. Opening Keymap grows
//! the frame to fit onboarding's preset detail beside the presets; an import
//! source shows onboarding's import picker in place of options. Source
//! control edits the worktree folder template in place, with a preview.
//! The top border names the running build and links its commit.
import * as i18n from "./i18n";
import { homedir } from "node:os";
import { join } from "node:path";
import * as palette from "./palette";
import * as trickConfig from "./trick_config";
import * as trickPalette from "./trick_palette";
import * as trickStyle from "./trick_style";
import * as trickPaletteUi from "./trick_palette_ui";
import type { Color as TrickColor } from "./tricks";
import { Style, colors, bgRgb, mix, selection, type Token } from "./palette";
import { Rect } from "./layout";
import { Provider, byProvider, adapter } from "./providers";
import type { ByProvider } from "./providers";
import { Model } from "./providers/model";
import * as corgiAnimation from "./corgi_animation";
import * as moonlanderScene from "./moonlander/scene";
import * as sidebar from "./sidebar";
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
import * as config from "./build_config";
import * as releaseLabel from "./release_label";
import * as bugReport from "./bug_report";
import type { Snapshot as TerminalSnapshot } from "./terminal_info";
import * as os from "./os";
import { Writer, clamp, directoryLabel, displayWidth, writeEllipsis, sat, wrap } from "./text";
import { Dialog, View as DialogView, writeField } from "./name_dialog";
import { matches } from "./search";
import * as keys from "./keys";
import type { Key } from "./keyboard";
import * as worktreeFolder from "./worktree_folder";
import * as shellPicker from "./shell_picker";
import * as scrollThumb from "./scroll_thumb";
import * as settingRow from "./setting_row";
import * as dropdown from "./dropdown";
import * as menuAim from "./menu_aim";
import { milliTimestamp } from "./clock";
import type { ShellStatus } from "./launch/command";
import {
  preferred_width as launcher_width,
  type Menu as LauncherMenu,
  type Preview as LauncherPreview,
} from "./agent_launcher";
import type { Connection } from "./rpc";
import type { Use, Uses } from "./inference/setup";
import { Selection, automatic, compare, options as modelOptions, type Option as ModelOption } from "./inference/models";

/** The inference setup status the daemon publishes, as inference.zig's `Status`. */
export interface Status {
  choice: Summarizer;
  provider: Provider | null;
  model: string;
  account: string;
  selection: Selection;
  available: ModelOption[];
  loading: boolean;
  locked: boolean;
  launches: ByProvider<number>;
  models: ByProvider<string>;
  uses: Uses;
}
export function status(value: any = {}): Status {
  // A daemon from before uses were separate says "off" for all of them.
  const on = value?.choice !== "off",
    use = (v: unknown) => (typeof v === "boolean" ? v : on);
  return {
    choice: value?.choice === "off" ? "off" : (Provider.parse(value?.choice) ?? "auto"),
    provider: Provider.parse(value?.provider),
    model: value?.model ?? "",
    account: typeof value?.account === "string" ? value.account : "",
    selection: Selection.parse(value?.selection),
    available: modelOptions(value?.available),
    loading: value?.loading === true,
    locked: value?.locked === true,
    launches: byProvider(p => Number(value?.launches?.[p] ?? 0)),
    models: byProvider(p => value?.models?.[p] ?? ""),
    uses: {
      activity: use(value?.uses?.activity),
      worktrees: use(value?.uses?.worktrees),
    },
  };
}
/** Who answers what Corgi asks the model; "off" only from an older daemon. */
export type Summarizer = "auto" | Provider | "off";
const summarizers: Summarizer[] = ["auto", ...Provider.all];
export const Summarizer = {
  provider(choice: Summarizer): Provider | null {
    return Provider.parse(choice);
  },
  label(choice: Summarizer): string {
    return choice === "auto" ? i18n.t`Auto` : choice === "off" ? i18n.t`Off` : adapter(choice).name;
  },
};

export type Item =
  | "flourishes"
  | "readings"
  | "clever_corgi"
  | "theme"
  | "language"
  | "shell"
  | "keyboard"
  | "agents"
  | "tricks"
  | "source_control"
  | "terminal"
  | "about"
  | "report_bug"
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
const list = (): ListRow[] => [
  "clever_corgi",
  "flourishes",
  "readings",
  null,
  "theme",
  "language",
  "shell",
  "keyboard",
  "source_control",
  null,
  "agents",
  "tricks",
  null,
  "terminal",
  null,
  { heading: i18n.t`Import from` },
  ...(Object.keys(import_sources) as ImportItem[]).filter(item =>
    catalog.available_sources.includes(import_sources[item]),
  ),
  null,
  "about",
  "report_bug",
  "detach",
];
export const items = list().filter((row): row is Item => typeof row === "string");
const labels = (): Record<Item, string> => ({
  flourishes: i18n.t`Visual flourishes`,
  readings: i18n.t`Resources`,
  clever_corgi: i18n.t`Clever Corgi`,
  theme: i18n.t`Theme`,
  language: i18n.t`Language`,
  shell: i18n.t`Shell`,
  keyboard: i18n.t`Keymap`,
  source_control: i18n.t`Source control`,
  agents: i18n.t`Manage agents`,
  tricks: i18n.t`Tricks`,
  terminal: i18n.t`Terminal capabilities`,
  about: i18n.t`About`,
  report_bug: i18n.t`Report a bug`,
  import_tmux: "tmux",
  import_herdr: "Herdr",
  import_cmux: "cmux",
  detach: i18n.t`Detach`,
});
/** An item's name on its own, as the crumb and the pane's title give it. */
function fullLabel(item: Item): string {
  const source = labels()[item];
  return importSource(item) === null ? source : i18n.t`Import from ${source}`;
}
/** The import source an item offers, or null for settings. */
function importSource(item: Item): catalog.Source | null {
  return item in import_sources ? import_sources[item as ImportItem] : null;
}

/** The settings Report a bug names, as they are now. */
function reportSettings(s: Status, prefs: Preferences): bugReport.Settings {
  return {
    theme: bugReport.theme(prefs.theme, palette.chosen(prefs.theme)),
    keymap: bugReport.keymap(prefs),
    clever_corgi: bugReport.cleverCorgi(s),
  };
}
/** What Enter or a click asks the controller to do. */
export type Apply =
  | { kind: "trick_palette_colors"; ref: string; colors: TrickColor[] | null }
  | { kind: "trick_palette_open"; ref: string | null }
  | { kind: "trick_palette_set"; ref: string; key: trickPalette.Key; color: TrickColor | null; all?: boolean }
  | { kind: "trick"; id: string; enabled: boolean }
  | { kind: "tricks_reload" }
  | { kind: "summaries"; choice: Summarizer; model?: string; account?: string }
  | { kind: "inference_use"; use: Use; on: boolean }
  | { kind: "readings" | "smart_links" | "ghostty"; on: boolean }
  | { kind: "corgi_intensity"; value: number }
  | { kind: "theme"; theme: palette.Theme }
  | { kind: "language"; language: i18n.Locale | undefined }
  | { kind: "shell"; entry: shellPicker.Entry }
  | { kind: "preset"; preset: km.Preset }
  | { kind: "prefix" }
  | { kind: "keymap" }
  | { kind: "keybindings" }
  /** Where the launcher puts new worktrees. */
  | { kind: "worktree_folder"; template: string }
  /** Copy the import picker's choice into Corgi. */
  | { kind: "import" }
  /** Close setup on the workspace an import made. */
  | { kind: "imported"; workspace: number | null }
  /** Leave Corgi running and close this viewer. */
  | { kind: "detach" }
  | { kind: "moonlander" }
  /** A link the user clicked. */
  | { kind: "open"; url: string }
  /** A link to copy where Corgi can't open it, as over SSH. */
  | { kind: "copy"; text: string };
/** A list row, an option, a choice in the open dropdown, the import picker
 * or the release's commit link under the pointer. */
export type Hit =
  | { item: Item }
  | { option: number }
  | { choice: number }
  | { model_search: number }
  | { picker: importPicker.Hit }
  | { manager: Rect }
  | { intensity: number }
  | { url: string };

interface Option {
  preview?: palette.Rgb[];
  inset?: number;
  copy_path?: string;
  color?: palette.Rgb;
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
  choice?: { text: string; on: boolean; choices: Choice[]; placeholder?: string };
  /** A text field, in a box, that takes typing while it has the cursor. */
  edit?: boolean;
  slider?: number;
  art?: number;
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
  preview?: palette.Rgb[];
  color?: palette.Rgb;
  text: string;
  note: string;
  detail?: string;
  pin?: boolean;
  depth?: number;
  inline_note?: boolean;
  current: boolean;
  heading?: boolean;
  heading_tone?: Token;
  more?: Provider;
  apply: Apply | null;
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
  | { tag: "intensity" | "intensity_ends" }
  | { tag: "corgi_preview"; row: number }
  | { tag: "art"; option: Option; index: number; row: number }
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
/** A pointer that reached the row this recently and drifts a column right is
 * still sliding down the list, not turning toward the options. */
const aim_settle_ms = 100;
/** The source of a commit the top border names. */
const commit_url = "https://github.com/tals/corgi/commit/";
const spaceship_rows = 8;
const acknowledgements = () =>
  [
    { label: "Ghostty", detail: i18n.t`our terminal engine`, url: "https://ghostty.org" },
    { label: "Kitty", detail: i18n.t`terminal graphics`, url: "https://sw.kovidgoyal.net/kitty/" },
    { label: "herdr", detail: i18n.t`inspiration and sound cues`, url: "https://github.com/herdrdev/herdr" },
    { label: "herdr-reviewr", detail: i18n.t`review panel design`, url: "https://github.com/persiyanov/herdr-reviewr" },
    {
      label: "Pi",
      detail: i18n.t`the wonderful pi-tui`,
      url: "https://github.com/earendil-works/pi/tree/main/packages/tui",
    },
    { label: "Bun", detail: i18n.t`our TypeScript runtime`, url: "https://bun.sh" },
  ] as const;
const buildPrefix = () => i18n.t`Build: `;
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
const grow_ms = 280;
const shrink_ms = 200;

/** Shared expansion timing for the Keymap detail and agent management. */
class Growth {
  from = 0;
  to = 0;
  at_ms = 0;
  value(now_ms: number): number {
    const span = this.to > this.from ? grow_ms : shrink_ms,
      k = Math.max(0, (now_ms - this.at_ms) / span);
    return k >= 1 ? this.to : this.from + (this.to - this.from) * (1 - (1 - k) ** 3);
  }
  toward(target: number, now_ms: number): number {
    if (target !== this.to) {
      this.from = this.value(now_ms);
      this.to = target;
      this.at_ms = now_ms;
    }
    return this.value(now_ms);
  }
}

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
function layout(cols: number, rows: number, grown: number, expanded = 0): Layout | null {
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
  const normal = Math.min(cols - 4, 84),
    base = normal + (Math.min(cols - 4, launcher_width + 2) - normal) * expanded,
    size = detailSize(cols, rows),
    t = size ? grown : 0,
    w = Math.round(base + ((size?.w ?? base) - base) * t),
    h = Math.round(h0 + Math.max(0, (size?.h ?? h0) - h0) * t),
    b = new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h),
    shown = Math.round(list_w * (1 - Math.max(t, expanded))),
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
  /** The same model and manager the new-tab picker uses. */
  agents: LauncherMenu | null = null;
  managing(): boolean {
    return this.item === "agents" && this.focus === "options" && this.agents !== null;
  }
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
  tricks: trickConfig.Info | null = null;
  trick_palettes: trickPalette.Summary[] = [];
  trick_palette: trickPalette.Info | null = null;
  trick_palette_ref: string | null = null;
  tricks_error: string | null = null;
  private tricks_poll = 0;
  private tricks_loading = false;
  private closed = false;
  /** The worktree folder template being typed, while Source control edits it. */
  editing: Dialog | null = null;
  /** A project the worktree folder's preview places a branch in; an example when null. */
  project: { name: string; root: string } | null = null;
  /** The running build, which the top border names. */
  release = releaseLabel.of(config.releaseVersion, config.releaseCommit, config.builtAt);
  /** What Report a bug says, once gathered. */
  report: bugReport.Report | null = null;
  /** What the viewer found out about its terminal, for the report. */
  host_terminal: TerminalSnapshot | null = null;
  /** The full report, where the report wrote one. */
  full_path: string | null = null;
  private gathering = false;
  /** Asks for a redraw when something arrives without input, as the report does. */
  changed: () => void = () => {};
  /** Whether the issue link went to the clipboard, where no browser opens it. */
  link_copied = false;
  /** Where the field's caret was drawn, for the terminal's cursor. */
  private caret: { x: number; y: number } | null = null;
  /** Sessions from the import source under the list's cursor. */
  readonly import_picker = new importPicker.Picker();
  /** The source the picker last switched to. */
  private import_source: catalog.Source | null = null;
  /** The list's first row shown while it scrolls. */
  private list_first = 0;
  /** Whether the prefix key came last; setup runs only detach after it. */
  after_prefix = false;
  /** The open dropdown: its setting's option, and the highlighted choice. */
  private dropdown: { option: number; at: number; top: number; visible: number[] } | null = null;
  private expanded_models = new Set<Provider>();
  private model_query = Dialog.init({ agent_command: 0 }, "");
  private models_visible = false;
  modelSearch(): Dialog | null {
    return this.dropdown ? this.model_query : null;
  }
  private searchedModels() {
    if (this.dropdown) {
      this.dropdown.at = 0;
      this.dropdown.top = 0;
    }
    this.expanded_models.clear();
  }
  /** Pointer adjustments preview until release, then save once. */
  private intensity_drag: number | null = null;
  /** The selected row's exit point while the pointer aims for its options,
   * where and when it reached the row, and whether its last step moved right:
   * one step straight down after that may still be on the way. */
  private aim: {
    x: number;
    y: number;
    entry_x: number;
    since: number;
    last_x: number;
    rightward: boolean;
    at: number | null;
    item: Item;
    cols: number;
    rows: number;
  } | null = null;
  private pending_item: Item | null = null;
  /** The frame's growth toward the preset detail, eased between draws. */
  private grow = new Growth();
  private expand = new Growth();
  /** Pointer targets follow the frame actually drawn during expansion. */
  private rendered: { cols: number; rows: number; layout: Layout } | null = null;
  static open(): Menu {
    return new Menu();
  }
  close(): void {
    this.closed = true;
    this.clearAim();
    this.intensity_drag = null;
    this.import_picker.close();
  }
  previewIntensity(prefs: Preferences): number {
    return this.intensity_drag ?? prefs.corgi_intensity;
  }
  draggingIntensity(): boolean {
    return this.intensity_drag !== null;
  }
  intensityKey(key: keys.Key | null, prefs: Preferences): Apply | null {
    if (this.item !== "flourishes" || this.focus !== "options") return null;
    const current = this.previewIntensity(prefs);
    let value: number;
    switch (key) {
      case "left":
        value = Math.max(0, current - 5);
        break;
      case "right":
        value = Math.min(100, current + 5);
        break;
      case "home":
        value = 0;
        break;
      case "end":
        value = 100;
        break;
      default:
        return null;
    }
    this.intensity_drag = null;
    return { kind: "corgi_intensity", value };
  }
  dragIntensity(cols: number, rows: number, x: number): void {
    const l = this.rest(cols, rows);
    if (l && this.intensity_drag !== null) this.intensity_drag = this.intensityAt(l, x);
  }
  finishIntensity(): Apply | null {
    const value = this.intensity_drag;
    this.intensity_drag = null;
    return value === null ? null : { kind: "corgi_intensity", value };
  }
  private intensityAt(l: Layout, x: number): number {
    return clamp(Math.round(((x - l.options.x - 2) * 20) / Math.max(1, l.options.w - 4)) * 5, 0, 100);
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
  async poll(conn: Pick<Connection, "call">, cols: number, rows: number, now = milliTimestamp()): Promise<boolean> {
    if (this.aim && (this.aim.cols !== cols || this.aim.rows !== rows)) this.clearAim();
    let hovered = false;
    if (this.aim?.at != null && now - this.aim.at >= menuAim.aim_ms) {
      if (this.pending_item && this.focus === "list" && this.item === this.aim.item) {
        this.item = this.pending_item;
        hovered = true;
      }
      this.clearAim();
    }
    const l = this.rest(cols, rows),
      visible = this.item === "clever_corgi" && l !== null && !(l.single && this.focus === "list");
    if (visible && !this.models_visible) void conn.call("inference.configure", {}).catch(() => {});
    this.models_visible = visible;
    if (
      this.item === "tricks" &&
      l !== null &&
      !(l.single && this.focus === "list") &&
      !this.tricks_loading &&
      now >= this.tricks_poll
    ) {
      this.tricks_loading = true;
      this.tricks_poll = now + 1000;
      const ref = this.trick_palette_ref;
      void Promise.all([
        conn.call("tricks.list"),
        conn.call("tricks.palettes"),
        ref ? conn.call("tricks.palette", { palette: ref }) : Promise.resolve(null),
      ])
        .then(([reply, list, selected]) => {
          const next = trickConfig.info(reply);
          const palettes = trickPalette.summaries(list.palettes),
            picked = selected ? trickPalette.info(selected) : null;
          if (
            !this.closed &&
            ref === this.trick_palette_ref &&
            (JSON.stringify([next, palettes, picked]) !==
              JSON.stringify([this.tricks, this.trick_palettes, this.trick_palette]) ||
              this.tricks_error !== null)
          ) {
            this.tricks = next;
            this.trick_palettes = palettes;
            this.trick_palette = picked;
            this.tricks_error = null;
            this.changed();
          }
        })
        .catch(error => {
          if (!this.closed && this.tricks_error !== String(error)) {
            this.tricks_error = String(error);
            this.changed();
          }
        })
        .finally(() => {
          this.tricks_loading = false;
        });
    }
    const picker = this.importing();
    return (picker !== null && (await picker.poll(conn))) || hovered;
  }
  /** Prefix shortcuts in setup: the prefix waits for the next key, which
   * detaches when it is an active detach key; setup drops the other
   * shortcuts. Null for keys setup handles itself. */
  prefixKey(byte: number, prefs: Preferences, key: Key = { codepoint: byte, mods: {} }): "detach" | "taken" | null {
    if (this.after_prefix) {
      this.after_prefix = false;
      return bindings.lookup(prefs.bindings(), true, key.codepoint, key.mods)?.name === "detach" ? "detach" : "taken";
    }
    if (!keys.same(key, { codepoint: km.prefixByte(prefs.prefix), mods: {} })) return null;
    this.after_prefix = true;
    return "taken";
  }
  /** The field's or the import picker's own keys while they have focus;
   * false for the rest. Enter and Esc go on to save or cancel the field. */
  key(byte: number): boolean {
    if (this.dropdown) {
      if ([13, 27, 9, 14, 16].includes(byte)) return false;
      this.model_query.key(byte);
      this.searchedModels();
      return true;
    }
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
  /** Escape sequences the field takes while it has focus: caret movement
   * and Delete. Arrows up and down stay with it rather than move. */
  sequence(text: string): boolean {
    if (this.dropdown) {
      const k = keys.parse(text);
      if (k === "up" || k === "down" || k === "shift_tab" || (k === "left" && !this.model_query.len)) return false;
      const before = this.model_query.name();
      this.model_query.sequence(text);
      if (before !== this.model_query.name()) this.searchedModels();
      return true;
    }
    if (!this.editing) return false;
    const k = keys.parse(text);
    if (k !== "up" && k !== "down" && k !== "shift_tab") this.editing.sequence(text);
    return true;
  }
  paste(byte: number): void {
    if (this.dropdown) {
      this.model_query.pasteByte(byte);
      this.searchedModels();
      return;
    }
    if (this.managing()) {
      this.agents!.manager.paste(byte, this.agents!.manageModel());
      return;
    }
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
    this.clearAim();
    if (this.editing) return;
    if (this.dropdown !== null) {
      const d = this.dropdown,
        n = this.choices(s, prefs).length;
      const choices = this.choices(s, prefs);
      for (let step = 0; step < n; step++) {
        const at = wrap ? (d.at + (next ? 1 : n - 1)) % n : clamp(d.at + (next ? 1 : -1), 0, n - 1);
        if (at === d.at) break;
        d.at = at;
        if (choices[at]?.apply || choices[at]?.more) break;
      }
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
    this.clearAim();
    if (this.importing() || (this.item === "agents" && this.agents)) {
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
  /** Esc closes setup, except while adjusting a slider or copying sessions. */
  escape(): boolean {
    if (this.focus !== "options") return false;
    if (this.item === "tricks" && (this.trick_palette_ref || this.dropdown)) return this.back();
    if ((this.dropdown && this.model_query.len) || this.item === "flourishes" || this.importing()?.stage === "copying")
      return this.back();
    return false;
  }
  /** Returns focus to the list. False when it already has it. */
  back(): boolean {
    this.clearAim();
    if (this.intensity_drag !== null) {
      this.intensity_drag = null;
      return true;
    }
    if (this.editing) {
      this.editing = null;
      this.focus = "list";
      return true;
    }
    if (this.focus === "list") return false;
    if (this.dropdown !== null) {
      if (this.model_query.len) {
        this.model_query = Dialog.init({ agent_command: 0 }, "");
        this.searchedModels();
        return true;
      }
      this.dropdown = null;
      return true;
    }
    const picker = this.importing();
    if (picker?.stage === "copying") {
      if (picker.failed()) picker.retry();
      return true;
    }
    if (this.item === "tricks" && this.trick_palette_ref) {
      this.trick_palette_ref = null;
      this.trick_palette = null;
      this.cursor = 0;
      return true;
    }
    this.leaveImport();
    this.focus = "list";
    return true;
  }
  /** Enter: an on/off setting flips from the list; the rest open their options. */
  enter(s: Status, prefs: Preferences): Apply | null {
    this.clearAim();
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
        this.model_query = Dialog.init({ agent_command: 0 }, "");
        this.expanded_models.clear();
        this.dropdown = {
          option: this.cursor,
          top: 0,
          visible: [],
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
    this.clearAim();
    if ("manager" in hit) return null;
    if ("intensity" in hit) {
      this.focus = "options";
      this.cursor = 0;
      this.intensity_drag = hit.intensity;
      return null;
    }
    // A click away from the field drops what it typed.
    const on_field = "option" in hit && this.options(s, prefs)[hit.option]?.edit === true;
    if (this.editing && !on_field) this.editing = null;
    // The open dropdown takes the click, or closes.
    if (this.dropdown !== null) {
      if ("choice" in hit) return this.choose(hit.choice, s, prefs);
      if ("model_search" in hit) {
        const width = Math.max(1, (this.rendered?.layout.options.w ?? 20) - 10),
          offset = DialogView.scroll(this.model_query, width);
        this.model_query.position(this.model_query.byteAtColumn(offset, Math.max(0, hit.model_search)));
        return null;
      }
      this.dropdown = null;
      return null;
    }
    if ("choice" in hit || "model_search" in hit) return null;
    if ("url" in hit) return { kind: "open", url: hit.url };
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
    if (!this.dropdown) return [];
    const choices = this.options(s, prefs)[this.dropdown.option]?.choice?.choices ?? [];
    const current = choices[this.dropdown.at];
    if (!current?.apply && !current?.more)
      this.dropdown.at = Math.max(
        0,
        choices.findIndex(c => c.apply || c.more),
      );
    return choices;
  }
  /** Closes the dropdown on choice `index`; Apply when it isn't the one in use. */
  private choose(index: number, s: Status, prefs: Preferences): Apply | null {
    const choice = this.choices(s, prefs)[index];
    if (choice?.more) {
      if (this.expanded_models.has(choice.more)) this.expanded_models.delete(choice.more);
      else this.expanded_models.add(choice.more);
      this.dropdown!.at = Math.min(index, this.choices(s, prefs).length - 1);
      return null;
    }
    if (!choice?.apply) return null;
    this.dropdown = null;
    return choice && !choice.current ? choice.apply : null;
  }
  private clearAim(): void {
    this.aim = null;
    this.pending_item = null;
  }
  /** Keep the selected setting while crossing other rows toward its pane. */
  hover(cols: number, rows: number, x: number, y: number, s: Status, prefs: Preferences, now = milliTimestamp()): void {
    const l = this.rest(cols, rows),
      hit = this.hit(cols, rows, x, y, s, prefs),
      from = this.aim;
    this.pending_item = null;
    if (l && !l.single && l.list > 0 && this.focus === "list" && this.dropdown === null) {
      if (hit && "item" in hit && hit.item === this.item) {
        const on = from !== null && from.at === null && from.item === this.item && from.y === y;
        // With no motion tracked before it, the pointer was resting.
        const entry_x = on ? from.entry_x : x,
          since = on ? from.since : from === null ? -Infinity : now,
          rightward = from !== null && x > from.last_x && (x >= entry_x + 2 || now - since >= aim_settle_ms);
        this.aim = { x, y, entry_x, since, last_x: x, rightward, at: null, item: this.item, cols, rows };
        return;
      }
      if (
        from &&
        from.item === this.item &&
        from.cols === cols &&
        from.rows === rows &&
        (from.at === null || now - from.at < menuAim.aim_ms) &&
        (x > from.last_x || (x === from.last_x && from.rightward)) &&
        menuAim.grazed(new Rect(l.options.x, l.b.y + 2, l.options.w, l.body), from, x, y)
      ) {
        from.rightward = x > from.last_x;
        from.last_x = x;
        from.at = now;
        this.pending_item = hit && "item" in hit ? hit.item : null;
        return;
      }
      this.clearAim();
      if (hit && "item" in hit)
        this.aim = { x, y, entry_x: x, since: now, last_x: x, rightward: false, at: null, item: hit.item, cols, rows };
    } else this.clearAim();
    if (hit === null) return;
    if ("choice" in hit) {
      if (this.dropdown !== null) this.dropdown.at = hit.choice;
    } else if (this.dropdown !== null) return;
    else if ("item" in hit) {
      if (this.focus === "list") this.item = hit.item;
    } else if ("option" in hit && this.focus === "options" && !this.options(s, prefs)[hit.option]?.disabled)
      this.cursor = hit.option;
  }
  /** Starts gathering what Report a bug shows, once per setup. */
  private gatherReport(s: Status, prefs: Preferences): void {
    if (this.gathering || this.report !== null) return;
    this.gathering = true;
    const socket = os.socketPath();
    void bugReport.collect(socket, this.host_terminal).then(async report => {
      this.report = report;
      this.full_path = await bugReport.writeFull(report, reportSettings(s, prefs), socket);
      this.changed();
    });
  }
  /** The frame as it rests after the current change. */
  private rest(cols: number, rows: number): Layout | null {
    if ((this.expand.from > 0 || this.expand.to > 0) && this.rendered?.cols === cols && this.rendered.rows === rows)
      return this.rendered.layout;
    return layout(cols, rows, this.growing(cols, rows) ? 1 : 0, this.managing() ? 1 : 0);
  }
  contains(cols: number, rows: number, x: number, y: number): boolean {
    return this.rest(cols, rows)?.b.contains(x, y) ?? false;
  }
  hit(cols: number, rows: number, x: number, y: number, s: Status, prefs: Preferences): Hit | null {
    const l = this.rest(cols, rows);
    if (!l) return null;
    if (y === l.b.y) {
      const spot = this.releaseAt(l);
      if (spot === null || x < spot.link || x >= spot.link + displayWidth(releaseLabel.short(this.release)))
        return null;
      return { url: commit_url + this.release.commit };
    }
    if (this.item === "agents" && this.agents && !(l.single && this.focus === "list")) {
      const area = managerArea(l);
      if (area.contains(x, y) && area.h >= this.agents.manager.minimumHeight()) return { manager: area };
    }
    const row = y - l.b.y - 2;
    if (row < 0 || row >= l.body) return null;
    const open = this.dropdownBox(l, s, prefs);
    if (open?.contains(x, y)) {
      const choices = this.choices(s, prefs);
      if (y === open.y + 1 && x > open.x && x < open.x + open.w - 1) {
        const search_width = modelColumns(choices, open.w).detail - 2;
        return x < open.x + 4 + search_width ? { model_search: x - open.x - 4 } : null;
      }
      const index = dropdown.hit(open, this.dropdown?.visible.length ?? 0, x, y, true),
        at = index === null ? -1 : (this.dropdown?.visible[index] ?? -1);
      return at < 0 || (!choices[at]?.apply && !choices[at]?.more) ? null : { choice: at };
    }
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
    if (line?.tag === "intensity") return { intensity: this.intensityAt(l, x) };
    return line && (line.tag === "option" || line.tag === "art") ? { option: line.index } : null;
  }
  draw(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number): void {
    return this.drawAt(w, s, prefs, cols, rows, Date.now());
  }
  drawAt(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number, now_ms: number): void {
    const grown = this.grow.toward(this.growing(cols, rows) ? 1 : 0, now_ms),
      expanded = this.expand.toward(this.managing() ? 1 : 0, now_ms),
      l = layout(cols, rows, grown, expanded);
    if (!l) {
      this.rendered = null;
      return;
    }
    this.rendered = { cols, rows, layout: l };
    const b = l.b,
      top = b.y + 2;
    this.caret = null;
    frame(w, b, l.dividers);
    w.write(`${at(b.x + 2, b.y)}${text} ᐯ•ᴥ•ᐯ ${bright}` + i18n.t`Corgi setup` + " ");
    const crumb = this.crumb(l);
    if (crumb !== null) {
      // The crumb stops short of a divider's corner.
      const start = this.crumbStart(l),
        room = Math.min(b.x + b.w - 2 - start, ...l.dividers.filter(x => x > start).map(x => x - start - 1));
      w.write(at(start, b.y) + hint_key);
      writeEllipsis(w, crumb, room);
    }
    this.drawRelease(w, l);
    const list_shown = l.single ? this.focus === "list" : l.list === list_w;
    if (list_shown) this.drawList(w, b.x + 1, top, l.single ? b.w - 2 : list_w, l.body, s, prefs);
    const managing = this.item === "agents" && this.agents !== null && !(l.single && this.focus === "list");
    if (!(l.single && this.focus === "list") && !managing) this.drawOptions(w, l, s, prefs, now_ms);
    const open = this.dropdownBox(l, s, prefs);
    if (open) {
      const choices = this.choices(s, prefs),
        columns = modelColumns(choices, open.w);
      dropdown.draw(
        w,
        open,
        (this.dropdown?.visible ?? []).map(index => {
          const choice = choices[index],
            branch = choice.depth === 2 ? (choices[index + 1]?.depth === 2 ? "├" : "╰") : undefined;
          return {
            text: choice.text,
            color: choice.color,
            preview: choice.preview,
            note: choice.note,
            detail: choice.detail,
            pin: choice.pin,
            current: choice.current,
            dim: choice.pin && !choice.apply,
            heading: choice.heading,
            heading_tone: choice.heading_tone,
            depth: choice.depth,
            inset: modelIndent(choice),
            branch,
            inline_note: choice.inline_note,
            hovered: index === this.dropdown?.at,
          };
        }),
        { text: "", note: "", detail: this.item === "tricks" ? "" : i18n.t`Billing` },
        this.item === "tricks" ? undefined : columns.note,
        this.item === "tricks" ? undefined : columns.detail,
      );
      const x = open.x + 4,
        y = open.y + 1,
        width = Math.max(1, columns.detail - 2);
      w.write(at(x, y) + text);
      const offset = DialogView.scroll(this.model_query, width);
      const column = writeField(w, this.model_query, offset, width, text);
      if (!this.model_query.len)
        w.write(border + (this.options(s, prefs)[this.cursor]?.choice?.placeholder ?? i18n.t`Search models`));
      this.caret = { x: x + column, y };
    }
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
    if (this.item === "report_bug") this.gatherReport(s, prefs);
    w.write("\x1b[0m\x1b[?25l");
    // drawField sets it, after the reset above.
    const caret = this.caret as { x: number; y: number } | null;
    if (caret) w.write(at(caret.x, caret.y) + "\x1b[?25h");
    if (managing) {
      const launch = this.agents!,
        area = managerArea(l);
      if (area.h >= launch.manager.minimumHeight())
        launch.manager.draw(w, area, launch.manageModel(), milliTimestamp(), {
          framed: false,
          focused: this.focus === "options",
        });
      else w.write(at(area.x + 2, area.y + 1) + text + i18n.t`Make the terminal taller to manage agents.`);
    }
  }
  /** The setting the options belong to, on the top border while the list is hidden. */
  private crumb(l: Layout): string | null {
    return (l.single ? this.focus !== "list" : l.list < list_w / 2) ? `› ${fullLabel(this.item)} ` : null;
  }
  private crumbStart(l: Layout): number {
    return l.b.x + 2 + displayWidth(` ᐯ•ᴥ•ᐯ ${i18n.t`Corgi setup`} `);
  }
  /** Where the release sits at the right of the top border, and where its
   * commit starts; null when the title, the crumb or a divider is in the way. */
  private releaseAt(l: Layout): { x: number; link: number } | null {
    const label = releaseLabel.text(this.release),
      crumb = this.crumb(l),
      width = displayWidth(buildPrefix() + label) + 2,
      x = l.b.x + l.b.w - 2 - width;
    if (label.length === 0) return null;
    if (x < this.crumbStart(l) + 1 + (crumb === null ? 0 : displayWidth(crumb))) return null;
    if (l.dividers.some(d => d >= x && d < x + width)) return null;
    return { x, link: x + 1 + displayWidth(buildPrefix() + releaseLabel.parts(this.release)[0]) };
  }
  private drawRelease(w: Writer, l: Layout): void {
    const spot = this.releaseAt(l);
    if (spot === null) return;
    const [built, commit, mark] = releaseLabel.parts(this.release);
    w.write(at(spot.x, l.b.y) + panel + " " + buildPrefix() + built);
    if (commit.length > 0)
      w.write(`${hint_key}\x1b]8;;${commit_url}${this.release.commit}\x1b\\\x1b[4m${commit}\x1b[24m\x1b]8;;\x1b\\`);
    w.write(panel + mark + " ");
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
      const v = this.value(item, s, prefs);
      const valueWidth = displayWidth(v.text);
      writeEllipsis(w, labels()[item], Math.max(0, width - indent - 2 - (valueWidth ? valueWidth + 1 : 0)));
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
    const rows = body >= list().length ? list() : list().filter(row => row !== null);
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
    return body >= list().length ? list().length : list().filter(row => row !== null).length;
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
        case "intensity": {
          const thumb = Math.round((this.previewIntensity(prefs) * Math.max(0, right - x0 - 1)) / 100);
          w.write(at(x0, y) + graph + "━".repeat(thumb));
          w.write((this.focus === "options" ? bright : graph) + "●" + border + "─".repeat(sat(right - x0 - 1, thumb)));
          return;
        }
        case "intensity_ends":
          w.write(at(x0, y) + panel + i18n.t`0 Off` + at(right - 10, y) + i18n.t`100 Bright`);
          return;
        case "corgi_preview":
          return this.drawCorgiPreview(w, x0, y, Math.min(28, right - x0), line.row, prefs, now_ms);
        case "art":
          return this.drawArt(w, line.option, line.index, line.row, x, width, y);
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
            cx += displayWidth(label) + 1;
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
      first = Math.max(0, at_caret - room + 1),
      // The selection, as every field shows it, counted in characters like the cells.
      sel = editor?.area.selection(),
      chosen = sel ? sel.map(end => [...editor!.area.text.slice(0, end)].length) : null;
    let shown = "",
      used = 0;
    for (const [i, [ch, own]] of cells.slice(first).entries()) {
      if (used + displayWidth(ch) > room) break;
      const style = chosen && first + i >= chosen[0] && first + i < chosen[1] ? selection : own;
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
      const since = ` −${(n * framePacing.column_ms) / 1000} s `,
        now = i18n.t` now`;
      w.write(at(axis, y) + border + "└─" + panel + since + border + "─".repeat(sat(n, displayWidth(since + now) + 1)));
      w.write(panel + now);
      return;
    }
    const label = row === hold_row ? i18n.t`wait` : row % 2 === 0 ? ["1 s", "100 ms", "10 ms", "1 ms"][row / 2] : "";
    w.write(at(axis - 1 - displayWidth(label), y) + panel + label + " " + border + "┤");
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
  private drawCorgiPreview(
    w: Writer,
    x: number,
    y: number,
    width: number,
    row: number,
    prefs: Preferences,
    now: number,
  ) {
    const style = new Style({ fg: "text", bg: "bg" }).sgr(),
      intensity = this.previewIntensity(prefs),
      room = Math.max(0, width - 5);
    w.write(at(x, y) + style + " ".repeat(width - 1) + palette.fg("line") + "│");
    switch (row) {
      case 1:
        w.write(at(x + 1, y) + palette.fg("muted") + i18n.t`agents: corgi ▾`);
        break;
      case 3:
        w.write(at(x + 1, y) + palette.fg("accent") + "▶" + at(x + 4, y) + palette.fg("text"));
        writeEllipsis(w, i18n.t`Visual flourishes`, room);
        break;
      case 4:
        w.write(at(x + 1, y) + palette.fg("faint") + corgiAnimation.spinner(false, now));
        w.write(at(x + 4, y) + corgiAnimation.writeWag(room, now, intensity));
        break;
      case 5:
        w.write(at(x + 1, y) + palette.fg("muted") + "○" + at(x + 4, y) + palette.fg("text"));
        writeEllipsis(w, i18n.t`Release notes`, room);
        break;
      case 6:
        if (intensity === 0) w.write(at(x + 1, y) + sidebar.nap_fg + "ᶻ");
        else
          w.write(
            at(x + 4, y) + corgiAnimation.idle(room, { intensity, puff_ms: now % corgiAnimation.dream_period_ms }),
          );
        break;
    }
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
    if (o.copy_path !== undefined) {
      const p = settingRow.fill(w, x, y, width, here),
        button = "[ " + o.label + " ]";
      w.write(at(x + 2, y) + p.accent + button + "  " + p.muted);
      writeEllipsis(w, o.copy_path, sat(width, displayWidth(button) + 5));
      return;
    }
    if (o.preview) {
      const p = settingRow.fill(w, x, y, width, here),
        start = x + 6 + (o.inset ?? 0);
      const end = right - 3,
        room = Math.max(0, end - start);
      const labelWidth = Math.min(displayWidth(o.label), Math.max(4, room - Math.min(12, o.preview.length * 3 + 1)));
      w.write(at(start, y) + p.label);
      writeEllipsis(w, o.label, labelWidth);
      w.write(at(start + labelWidth + 2, y));
      palette.chips(w, o.preview, Math.max(0, end - start - labelWidth - 2), p.background);
      w.write(at(right - 2, y) + p.muted + "→");
      return;
    }
    if (o.art) return this.drawArt(w, o, line.index, 0, x, width, y);
    if (o.slider !== undefined) {
      const value = o.slider === 0 ? i18n.t`Off` : `${o.slider}%`;
      w.write(at(x0, y) + (here ? bright : text) + o.label + at(right - displayWidth(value), y) + bright + value);
      return;
    }
    if (o.toggle !== undefined)
      return settingRow.drawToggle(w, x, y, width, {
        label: o.label,
        on: o.toggle,
        here,
        disabled: o.disabled,
        glyph: o.glyph,
      });
    if (o.choice !== undefined)
      return settingRow.drawChoice(w, x, y, width, o.label, o.choice.text, o.choice.on, here, o.color);
    if (o.edit) return this.drawField(w, x0, y, right, prefs);
    const p = settingRow.fill(w, x, y, width, here);
    if (o.mark !== "none")
      w.write(at(x0 + 2, y) + (o.mark === "on" && !o.disabled ? p.accent : p.quiet) + (o.mark === "on" ? "●" : "○"));
    w.write(at(x0 + 4, y) + (o.disabled ? p.quiet : p.label));
    if (o.apply?.kind === "open") w.write(`\x1b]8;;${o.apply.url}\x1b\\`);
    writeEllipsis(w, o.label, Math.min(label_w, sat(right, x0 + 4)));
    if (o.apply?.kind === "open") w.write("\x1b]8;;\x1b\\");
    let dx = x0 + 4 + label_w + 3;
    if (o.swatch && right - dx >= 7) {
      w.write(
        `${at(dx, y)}\x1b[0;1m${palette.swatch("bg", o.swatch)}${palette.fg("accent", o.swatch)} ▶ ` +
          `${palette.fg("warm", o.swatch)}● \x1b[22m${palette.fg("muted", o.swatch)}○ `,
      );
      dx += 8;
    }
    w.write(at(dx, y) + (o.disabled ? p.quiet : o.warn ? p.warn : p.muted));
    writeEllipsis(w, o.detail, sat(right - (o.arrow ? 3 : 0), dx));
    if (o.arrow) w.write(at(right - 2, y) + p.muted + "→");
  }
  private about_scene: moonlanderScene.Screen | null = null;
  private drawArt(w: Writer, option: Option, index: number, row: number, x: number, width: number, y: number) {
    const cols = Math.max(1, width - 4),
      rows = option.art ?? 0,
      here = this.focus === "options" && index === this.cursor;
    if (this.about_scene?.cols !== cols || this.about_scene.rows !== rows)
      this.about_scene = moonlanderScene.landing(cols, rows);
    w.write(at(x, y) + palette.bg("surface"));
    w.splat(" ", width);
    w.write(at(x + 2, y));
    let previous = "";
    for (const cell of this.about_scene.cells.slice(row * cols, (row + 1) * cols)) {
      const focused = here && (cell.fg === "text" || cell.fg === "strong"),
        style = palette.fg(focused ? "strong" : cell.fg) + (focused ? "\x1b[1m" : "\x1b[22m");
      if (style !== previous) w.write(style);
      w.write(cell.glyph);
      previous = style;
    }
    w.write("\x1b[22m");
  }
  /** The open dropdown's box, under its setting's row with ✓ under the ›;
   * null while it is closed. */
  private dropdownBox(l: Layout, s: Status, prefs: Preferences): Rect | null {
    const d = this.dropdown;
    if (d === null) return null;
    const row = this.lines(s, prefs, l).findIndex(line => line.tag === "option" && line.index === d.option);
    if (row < 0) return null;
    const choices = this.choices(s, prefs),
      count = choices.length,
      h = Math.min(count + 3, l.body),
      capacity = h - 3,
      width = Math.min(l.b.w - 4, Math.max(l.options.w - 3, modelPreferredWidth(choices))),
      bottom = l.b.y + 2 + l.body;
    const view = dropdown.viewport(choices, d.top, d.at, capacity);
    d.top = view.first;
    d.visible = view.indices;
    return new Rect(
      l.options.x + l.options.w - 1 - width,
      Math.max(l.b.y + 2, Math.min(l.b.y + 3 + row, bottom - h)),
      width,
      h,
    );
  }
  /** The options pane's rows as they fit `l`: leads and notes wrap, notes
   * give way first, then the options scroll to keep the cursor in view. */
  private lines(s: Status, prefs: Preferences, l: Layout): Line[] {
    const fit = { keys: !l.room, brief: l.options.w < 42, chart: true };
    let out = this.wrapped(s, prefs, l, fit);
    if (this.item === "about") {
      const start = out.findIndex(line => line.tag === "option" && line.option.art),
        art = out.slice(start).slice(-Math.max(1, l.body - 1)),
        room = l.body - art.length,
        cursor = out.findIndex(line => line.tag === "option" && line.index === this.cursor),
        top = clamp(cursor < start ? cursor - room + 1 : 0, 0, Math.max(0, start - room)),
        credits = out.slice(top, Math.min(start, top + room));
      return credits.concat(
        Array.from({ length: room - credits.length }, (): Line => ({ tag: "blank" })),
        art,
      );
    }
    if (this.item === "report_bug") return out.slice(0, l.body);
    if (this.item === "flourishes" && out.length > l.body)
      return out.filter(line => line.tag !== "blank" && line.tag !== "lead").slice(0, l.body);
    // A short frame draws the answer-time chart as one row.
    if (out.length > l.body && out.some(line => line.tag === "chart"))
      out = this.wrapped(s, prefs, l, { ...fit, chart: false });
    if (out.length <= l.body) return out;
    const first = out.findIndex(line => line.tag === "option"),
      last = out.findLastIndex(line => line.tag === "option" || line.tag === "art"),
      kept = first < 0 ? out : out.slice(0, last + 1);
    if (kept.length <= l.body || first < 0) return kept.slice(0, l.body);
    const head = kept.slice(0, Math.min(first, l.body - 1)),
      options = kept.slice(first),
      span = l.body - head.length,
      cursor = options.findLastIndex(
        line => (line.tag === "option" || line.tag === "art") && line.index === this.cursor,
      ),
      start = Math.min(Math.max(0, cursor - span + 1), options.length - span);
    return head.concat(options.slice(start, start + span));
  }
  /** Frame pacing under Terminal capabilities: how fast the host answers, charted when `chart`. */
  private pacingLines(chart: boolean): Line[] {
    const p = this.pacing,
      name = i18n.t`Frame pacing`;
    if (p === null)
      return [
        { tag: "capability", name, mark: "no" },
        { tag: "brief", text: i18n.t`This viewer has no terminal.` },
      ];
    if (p.timing === null)
      return [
        { tag: "capability", name, mark: "no" },
        { tag: "brief", text: i18n.t`Never answered, so frames never wait.` },
      ];
    const held = p.late + p.lost,
      lost = p.lost,
      slowest = duration(p.slowest),
      answers = duration(p.timing.mean, p.timing.sd),
      late: Line = {
        tag: "brief",
        text:
          held === 0
            ? i18n.t`None late enough to hold frames.`
            : lost > 0
              ? lost === 1
                ? i18n.t`${held} late enough to hold frames; one never came.`
                : i18n.t`${held} late enough to hold frames; ${lost} never came.`
              : i18n.t`${held} late enough to hold frames; slowest ${slowest}.`,
      };
    if (!chart) return [{ tag: "capability", name, mark: "yes" }, { tag: "spark", text: answers }, late];
    return [
      { tag: "capability", name, mark: "yes" },
      { tag: "brief", text: i18n.t`Answers in ${answers}.` },
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
      else if (line.tag === "option") {
        const at = index++;
        out.push({ ...line, index: at });
        if (line.option.art)
          for (let row = 1; row < line.option.art; row++) out.push({ tag: "art", option: line.option, index: at, row });
      } else out.push(line);
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
      case "agents":
        return [];
      case "tricks": {
        if (this.trick_palette_ref) {
          const picked = this.trick_palette;
          const query = this.model_query.name();
          const custom = palette.css(query);
          return [
            title(directoryLabel(this.trick_palette_ref, null, 160)),
            ...(this.tricks_error
              ? [{ tag: "warn" as const, text: directoryLabel(this.tricks_error, null, 512) }]
              : []),
            option({
              label: i18n.t`Back`,
              detail: "",
              mark: "none",
              apply: { kind: "trick_palette_open", ref: null },
              action: i18n.t`back`,
            }),
            ...(picked
              ? [
                  option({
                    label: i18n.t`Palette`,
                    detail: "",
                    mark: "none",
                    apply: null,
                    action: i18n.t`choose`,
                    choice: {
                      text: trickPaletteUi.schemeName(picked.scheme),
                      on: picked.scheme !== null,
                      placeholder: i18n.t`Search palettes`,
                      choices: [
                        {
                          text: i18n.t`Automatic`,
                          note: "",
                          preview: picked.colors.map(trickStyle.rgb),
                          current: picked.scheme === null,
                          apply: { kind: "trick_palette_colors" as const, ref: picked.ref, colors: null },
                        },
                        ...Object.values(palette.schemes).map(colors => ({
                          text: trickPaletteUi.schemeName(colors),
                          note: "",
                          preview: colors.map(trickStyle.rgb),
                          current: JSON.stringify(picked.scheme) === JSON.stringify(colors),
                          apply: {
                            kind: "trick_palette_colors" as const,
                            ref: picked.ref,
                            colors: [...colors] as TrickColor[],
                          },
                        })),
                      ].filter(c => matches(query, c.text)),
                    },
                  }),
                  ...picked.assignments.map(a => {
                    const choose = (color: TrickColor | null): Apply => ({
                      kind: "trick_palette_set",
                      ref: picked.ref,
                      key: a.key,
                      color,
                    });
                    const choices: Choice[] = [
                      { text: i18n.t`Automatic`, note: "", current: !a.override, apply: choose(null) },
                      ...trickPaletteUi
                        .choices([...(picked.scheme ?? picked.colors), ...trickStyle.palette.identity, a.color])
                        .map(color => ({
                          text: trickPaletteUi.colorName(color),
                          note: "",
                          preview: [trickStyle.rgb(color)],
                          current: a.override && JSON.stringify(a.color) === JSON.stringify(color),
                          apply: choose(color),
                        })),
                    ].filter(c => matches(query, c.text));
                    if (custom)
                      choices.push({
                        text: custom,
                        note: i18n.t`Custom`,
                        preview: [trickStyle.rgb(custom)],
                        current: false,
                        apply: choose(custom),
                      });
                    return option({
                      label: directoryLabel(a.label, null, 160),
                      detail: "",
                      mark: "none",
                      apply: null,
                      action: i18n.t`choose`,
                      color: trickStyle.rgb(a.color),
                      choice: {
                        text: trickPaletteUi.colorName(a.color),
                        on: a.override,
                        choices,
                        placeholder: i18n.t`Color name or #hex`,
                      },
                    });
                  }),
                ]
              : []),
            option({
              label: i18n.t`Reset all colors`,
              detail: "",
              mark: "none",
              apply: { kind: "trick_palette_set", ref: this.trick_palette_ref, key: null, color: null, all: true },
              action: i18n.t`reset`,
            }),
          ];
        }
        const info = this.tricks;
        const paletteRow = (p: trickPalette.Summary, nested: boolean): Line =>
          option({
            label: p.ref.startsWith("globals.") ? p.ref : p.ref.slice(p.ref.indexOf("/") + 1),
            detail: "",
            mark: "none",
            preview: p.preview.map(trickStyle.rgb),
            inset: nested ? 2 : 0,
            apply: { kind: "trick_palette_open", ref: p.ref },
            action: i18n.t`open`,
            arrow: true,
          });
        const ownedBy = (p: trickPalette.Summary, id: string) =>
          p.owners.includes(id) || trickPalette.ref(p.ref).owner === id;
        const unassigned = this.trick_palettes.filter(p => !info?.tricks.some(t => ownedBy(p, t.id)));
        return [
          title(i18n.t`Tricks`),
          ...(this.tricks_error ? [{ tag: "warn" as const, text: directoryLabel(this.tricks_error, null, 512) }] : []),
          ...(info
            ? [
                ...(info.watch_error ? [{ tag: "warn" as const, text: info.watch_error }] : []),
                ...info.tricks.flatMap((trick, i) => [
                  ...(i ? [blank] : []),
                  option({
                    label: directoryLabel(trick.id, null, 160),
                    detail: "",
                    mark: trick.enabled ? "on" : "off",
                    toggle: trick.enabled,
                    warn: trick.error !== null,
                    apply: { kind: "trick", id: trick.id, enabled: !trick.enabled },
                    action: trick.enabled ? i18n.t`turn off` : i18n.t`turn on`,
                  }),
                  ...(trick.error ? [{ tag: "warn" as const, text: directoryLabel(trick.error, null, 512) }] : []),
                  ...this.trick_palettes.filter(p => ownedBy(p, trick.id)).map(p => paletteRow(p, true)),
                ]),
                ...(!info.tricks.length ? [lead(i18n.t`No tricks installed yet.`)] : []),
                ...(unassigned.length
                  ? [blank, title(i18n.t`Saved palettes`), ...unassigned.map(p => paletteRow(p, false))]
                  : []),
                blank,
                title(i18n.t`Development`),
                option({
                  label: i18n.t`Restart`,
                  detail: "",
                  mark: "none",
                  apply: { kind: "tricks_reload" },
                  action: i18n.t`reload`,
                }),
                option({
                  label: i18n.t`Copy`,
                  detail: "",
                  copy_path: directoryLabel(info.directory, homedir(), 1024),
                  mark: "none",
                  apply: { kind: "copy", text: info.directory },
                  action: i18n.t`copy`,
                }),
              ]
            : [lead(this.tricks_error ? i18n.t`Tricks are unavailable.` : i18n.t`Loading installed tricks…`)]),
        ];
      }
      case "about":
        return [
          title(i18n.t`About Corgi`),
          option({
            label: "GitHub",
            detail: "tals/corgi",
            mark: "none",
            apply: { kind: "open", url: "https://github.com/tals/corgi" },
            action: i18n.t`open`,
          }),
          blank,
          title(i18n.t`Acknowledgements`),
          ...acknowledgements().map(link =>
            option({
              label: link.label,
              detail: link.detail,
              mark: "none",
              apply: { kind: "open", url: link.url },
              action: i18n.t`open`,
            }),
          ),
          blank,
          option({
            label: "Moonlander",
            detail: "",
            mark: "none",
            apply: { kind: "moonlander" },
            action: i18n.t`play`,
            art: spaceship_rows,
          }),
        ];
      case "flourishes":
        return [
          title(i18n.t`Visual flourishes`),
          blank,
          lead(i18n.t`Sidebar corgi brightness.`),
          blank,
          option({
            label: i18n.t`Intensity`,
            detail: "",
            mark: "none",
            apply: null,
            action: i18n.t`adjust`,
            slider: this.previewIntensity(prefs),
          }),
          { tag: "intensity" },
          { tag: "intensity_ends" },
          blank,
          { tag: "note", text: i18n.t`Preview` },
          ...Array.from({ length: 8 }, (_, row): Line => ({ tag: "corgi_preview", row })),
        ];
      case "readings":
        return [
          title(i18n.t`Resource readings`),
          lead(i18n.t`CPU and memory under each workspace in the sidebar.`),
          blank,
          ...onOff(prefs.resources.enabled, "readings", [i18n.t`show the readings row`, i18n.t`hide the row`]).map(
            option,
          ),
          blank,
          { tag: "note", text: i18n.t`Sampling stops once every viewer turns it off.` },
        ];
      case "clever_corgi": {
        const second = note(s.choice, s);
        return [
          title(i18n.t`Clever Corgi`),
          blank,
          option({
            label: i18n.t`Model`,
            detail: "",
            mark: "none",
            apply: null,
            action: i18n.t`change`,
            choice: {
              text: inUse(s),
              on: s.choice !== "off",
              choices: summarizerChoices(s, this.expanded_models, this.model_query.name(), this.agents?.preview),
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
              action: c.on ? i18n.t`turn off` : i18n.t`turn on`,
              toggle: c.on,
            }),
            { tag: "brief", text: c.brief },
            blank,
          ]),
        ];
      }
      case "theme":
        return [
          title(i18n.t`Theme`),
          lead(i18n.t`Corgi's colors, or your terminal theme's.`),
          blank,
          ...palette.available_themes.map(theme =>
            option({
              label: palette.themes[theme].label,
              detail: theme === "corgi" ? i18n.t`Corgi's own` : i18n.t`your terminal's`,
              mark: theme === palette.chosen(prefs.theme) ? "on" : "off",
              apply: theme === prefs.theme ? null : { kind: "theme", theme },
              action: i18n.t`use`,
              swatch: theme,
            }),
          ),
          blank,
          { tag: "note", text: i18n.t`Corgi keeps your background when it's dark and paints its own otherwise.` },
        ];
      case "language":
        return [
          title(i18n.t`Language`),
          lead(i18n.t`Choose the language for Corgi's interface.`),
          { tag: "note", text: i18n.t`CORGI_LANG overrides this setting when set.` },
          blank,
          option({
            label: i18n.t`Auto`,
            detail: i18n.t`Follow your system language`,
            mark: prefs.language === undefined ? "on" : "off",
            apply: prefs.language === undefined ? null : { kind: "language", language: undefined },
            action: i18n.t`use`,
          }),
          ...i18n.locales.map(language =>
            option({
              label: i18n.names[language],
              detail: "",
              mark: language === prefs.language ? "on" : "off",
              apply: language === prefs.language ? null : { kind: "language", language },
              action: i18n.t`use`,
            }),
          ),
        ];
      case "shell": {
        const picker = shellPicker.Picker.open(this.shell, this.shells);
        return [
          title(i18n.t`Shell for new panes`),
          lead(i18n.t`New panes and splits start in this shell.`),
          blank,
          ...picker.entries.map((entry, i) => {
            const used = i === picker.in_use && entry !== "other";
            return option({
              label: picker.label(entry),
              detail: picker.detail(entry),
              mark: used ? "on" : "off",
              apply: used ? null : { kind: "shell", entry },
              action: entry === "other" ? i18n.t`type a path` : i18n.t`use`,
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
          title(i18n.t`Worktree folder`),
          { tag: "box", edge: "top" },
          option({ label: "", detail: "", mark: "none", apply: null, action: i18n.t`save`, edit: true }),
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
        const other = prefs.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b",
          prefixName = km.prefixName(other);
        return [
          title(i18n.t`Keymap`),
          fit.keys
            ? { tag: "keys", keys: keyLine(this.previewPreset(prefs), prefs.prefix) }
            : lead(i18n.t`Which shortcuts feel like home?`),
          blank,
          ...km.available_presets.map(preset =>
            option({
              label: km.name(preset),
              detail: fit.brief ? km.shortDescription(preset) : km.description(preset),
              mark: preset === prefs.preset ? "on" : "off",
              apply: preset === prefs.preset ? null : { kind: "preset", preset },
              action: i18n.t`use`,
            }),
          ),
          blank,
          option({
            label: i18n.t`Prefix`,
            detail: km.prefixName(prefs.prefix),
            mark: "none",
            apply: { kind: "prefix" },
            action: i18n.t`switch to ${prefixName}`,
          }),
          option({
            label: i18n.t`Customize`,
            detail: "",
            mark: "none",
            apply: { kind: "keybindings" },
            action: i18n.t`edit`,
            arrow: true,
          }),
          option({
            label: i18n.t`All keys`,
            detail: "",
            mark: "none",
            apply: { kind: "keymap" },
            action: i18n.t`open`,
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
          title(i18n.t`Terminal capabilities`),
          lead(i18n.t`Detected, not settings: what this terminal can do.`),
          blank,
          ...found(
            i18n.t`Terminal`,
            null,
            (term.name || i18n.t`Didn't say its name`) + (term.ssh ? i18n.t` · over SSH` : ""),
            "muted",
          ),
          ...found(
            i18n.t`Kitty graphics`,
            term.graphics ? "yes" : "no",
            term.graphics ? i18n.t`Pixel corgi badge and animations.` : i18n.t`🐕 badge; animations stay still.`,
          ),
          ...found(
            i18n.t`Theme colors`,
            term.colors ? "yes" : "no",
            term.colors ? i18n.t`Animal Style takes its colors from them.` : i18n.t`Animal Style keeps Corgi's colors.`,
          ),
          ...(clipboard
            ? found(
                i18n.t`Image paste`,
                paste_found[clipboard.support],
                clipboard.diagnosis(),
                clipboard.support === "denied" ? "warm" : undefined,
              )
            : found(i18n.t`Image paste`, "no", i18n.t`This viewer has no terminal to paste from.`)),
          ...this.pacingLines(fit.chart),
        ];
      }
      case "report_bug": {
        if (this.report === null)
          return [title(i18n.t`Report a bug`), lead(i18n.t`Gathering details about this machine…`)];
        const settings = reportSettings(s, prefs),
          url = bugReport.issueUrl(this.report, settings, this.full_path !== null) ?? bugReport.issues_url,
          path = this.full_path ? bugReport.tilde(this.full_path) : "",
          brief = (text: string): Line => ({ tag: "brief", text, tone: "muted" });
        return [
          title(i18n.t`Report a bug`),
          lead(i18n.t`The issue starts with these details. Nothing is sent until you submit it on GitHub.`),
          blank,
          option({
            label: i18n.t`Open an Issue on GitHub`,
            detail: "",
            mark: "none",
            // Over SSH the browser would open on the other machine, if at all.
            apply: this.terminal.ssh ? { kind: "copy", text: url } : { kind: "open", url },
            action: this.terminal.ssh ? i18n.t`copy link` : i18n.t`open`,
            arrow: true,
          }),
          ...(this.link_copied ? [brief(i18n.t`Copied the link; paste it into your browser.`)] : []),
          ...(this.full_path
            ? [
                {
                  tag: "note",
                  text: this.terminal.ssh
                    ? i18n.t`Please attach ${path}, on the machine Corgi runs on.`
                    : i18n.t`Please attach ${path}.`,
                } as Line,
              ]
            : []),
          blank,
          ...bugReport
            .rows(this.report, settings)
            .filter(row => !row.local)
            .map((row): Line => ({ tag: "variable", name: "  ".repeat(row.depth) + row.label, value: row.value })),
        ];
      }
      case "detach":
        return [
          title(i18n.t`Detach`),
          lead(i18n.t`Corgi and your agents keep running.`),
          blank,
          { tag: "binding", job: i18n.t`Detach`, key: detachKey(prefs), dim: false },
          { tag: "binding", job: i18n.t`Come back`, key: "corgi", dim: false },
        ];
      case "import_tmux":
      case "import_herdr":
      case "import_cmux": {
        const picker = this.importing()!;
        return [
          title(
            { choose: fullLabel(this.item), copying: picker.heading(), complete: i18n.t`Import complete` }[
              picker.stage
            ],
          ),
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
          label: i18n.t`Command keys`,
          glyph: "⌘",
          detail: "",
          mark: "none",
          apply: works ? { kind: "ghostty", on: !on } : null,
          action: on ? i18n.t`turn off` : i18n.t`turn on`,
          toggle: on,
          disabled: !works,
        },
      },
      ...(this.reload_ghostty ? [brief(i18n.t`Reload Ghostty with ⌘⇧, to apply.`, "warm")] : []),
      this.integration === "failed"
        ? brief(i18n.t`Corgi can't read your Ghostty config.`, "warm")
        : brief(
            works ? i18n.t`In Ghostty only, these keys drive Corgi:` : i18n.t`Ghostty only, on this Mac; not over SSH.`,
          ),
      { tag: "blank" },
      ...commandRows(prefs).map(([job, key]): Line => ({ tag: "binding", job, key, dim: !on })),
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
      use("activity", i18n.t`Activity summaries`, i18n.t`What each agent is doing, under its name.`),
      use("worktrees", i18n.t`Worktree briefs`, i18n.t`What each worktree holds, in a few words.`),
      {
        label: i18n.t`Smart Links`,
        brief: i18n.t`Digs up likely HTTP links ↗`,
        on: this.smart_links,
        apply: (on: boolean): Apply => ({ kind: "smart_links", on }),
      },
    ];
  }
  /** The theme under the cursor, or the one in use. */
  previewTheme(prefs: Preferences): palette.Theme | undefined {
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
      enabled ? { text: i18n.t`On`, tone: "muted" as const } : { text: i18n.t`Off`, tone: "faint" as const };
    switch (item) {
      case "flourishes":
        return {
          text: this.previewIntensity(prefs) === 0 ? i18n.t`Off` : `${this.previewIntensity(prefs)}%`,
          tone: "muted",
        };
      case "readings":
        return flag(prefs.resources.enabled);
      case "clever_corgi":
        return { text: "", tone: "faint" };
      case "theme":
        return { text: palette.themes[palette.chosen(prefs.theme)].label, tone: "muted" };
      case "language":
        return { text: prefs.language ? i18n.names[prefs.language] : i18n.t`Auto`, tone: "muted" };
      case "shell":
        if (shellPicker.missing(this.shell)) return { text: i18n.t`not found`, tone: "warm" };
        return { text: this.shell.path ? this.shell.path.split("/").pop()! : "", tone: "muted" };
      case "keyboard":
        return { text: km.name(prefs.preset), tone: "muted" };
      case "source_control":
        return prefs.worktree_folder === worktreeFolder.default_template
          ? { text: "", tone: "faint" }
          : { text: i18n.t`custom`, tone: "muted" };
      case "tricks": {
        const count = this.tricks?.tricks.filter(t => t.running).length ?? 0;
        return {
          text: this.tricks ? i18n.t`${count} on` : "",
          tone: this.tricks?.tricks.some(t => t.error) ? "warm" : "muted",
        };
      }
      case "terminal":
      case "about":
      case "report_bug":
      case "agents":
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
        ["enter", i18n.t`save`],
        ["esc", i18n.t`close`],
      ];
    const picker = this.importing();
    if (this.focus === "list") {
      const flip = this.flip(prefs),
        open = this.item === "agents" || picker !== null || this.options(s, prefs).some(o => !o.disabled);
      const enter: [string, string][] =
        flip?.kind === "detach"
          ? [["enter", i18n.t`detach`]]
          : flip && "on" in flip
            ? [["enter", flip.on ? i18n.t`turn on` : i18n.t`turn off`]]
            : open
              ? [["enter", i18n.t`choose`]]
              : [];
      return [["↑↓", i18n.t`move`], ...enter, ["esc", i18n.t`close`]];
    }
    if (this.item === "agents") return [];
    if (picker) return importHints(picker);
    if (this.item === "flourishes")
      return [
        ["←→", i18n.t`adjust`],
        ["home", i18n.t`off`],
        ["end", i18n.t`bright`],
        ["esc", i18n.t`back`],
      ];
    if (this.dropdown !== null)
      return [
        ["type", i18n.t`search`],
        ["↑↓", i18n.t`move`],
        ["enter", i18n.t`use`],
        ["esc", i18n.t`close`],
      ];
    const option = this.options(s, prefs)[this.cursor];
    const enter: [string, string][] =
      option && !option.disabled && (option.apply || option.choice !== undefined) ? [["enter", option.action]] : [];
    return [["↑↓", i18n.t`move`], ...enter, ["←", i18n.t`back`], ["esc", i18n.t`close`]];
  }
}
/** The manager fills the options pane, leaving the outer frame intact. */
function managerArea(l: Layout): Rect {
  return new Rect(l.options.x, l.b.y + 1, l.options.w, l.b.h - 2);
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
          ["r", i18n.t`refresh`],
          ["e", i18n.t`expand`],
        ];
      if (picker.source === "herdr") hints.push(["h", i18n.t`handoff`]);
      hints.push(
        ["↑↓", i18n.t`move`],
        ["space", picker.switch_focused ? (picker.handoff ? i18n.t`turn off` : i18n.t`turn on`) : i18n.t`select`],
      );
      if (count > 0) hints.push(["enter", picker.activeHandoff() ? i18n.t`hand off` : i18n.t`import ${count}`]);
      hints.push(["←", i18n.t`back`], ["esc", i18n.t`close`]);
      return hints;
    }
    case "copying":
      return picker.failed() ? [["enter", i18n.t`back`]] : [];
    case "complete":
      return [
        ["enter", i18n.t`open`],
        ["←", i18n.t`back`],
        ["esc", i18n.t`close`],
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
    label: value ? i18n.t`On` : i18n.t`Off`,
    detail: details[i],
    mark: value === enabled ? "on" : "off",
    apply: value === enabled ? null : { kind, on: value },
    action: value ? i18n.t`turn on` : i18n.t`turn off`,
  }));
}
const action = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
/** The key that detaches under the saved preset, with its prefix. */
function detachKey(prefs: Preferences): string {
  const b = bindings.find(prefs.bindings(), action("detach"));
  if (!b) return "";
  return b.prefixed ? `${km.prefixName(prefs.prefix)} ${bindings.compact(b)}` : bindings.compact(b);
}
/** The mini keymap's width, as wide as its longest row needs. */
const binding_w = 30;
/** The jobs Command keys' mini keymap shows, where active shortcuts bind them. */
const commandJobs = (): { job: string; actions: string[] }[] => [
  { job: i18n.t`New tab`, actions: ["new"] },
  { job: i18n.t`Close tab`, actions: ["close-tab"] },
  { job: i18n.t`Reopen tab`, actions: ["undo-close"] },
  { job: i18n.t`Next / previous`, actions: ["next", "prev"] },
  { job: i18n.t`Select tab`, actions: ["tab"] },
  { job: i18n.t`Select workspace`, actions: ["goto-workspace"] },
];
/** Command keys' active jobs; consecutive numbered keys show as ⌘1–9. */
function commandRows(prefs: Preferences): [string, string][] {
  const bound = ghosttyIntegration.commandKeys(prefs.preset, prefs.bindings()),
    key = (name: string) => {
      const labels = [
        ...new Set(bound.filter(b => b.action.name === name).map(b => ghosttyIntegration.macLabel(b.host))),
      ];
      if (!labels.length) return null;
      const numbered = labels.map(label => /^(.*?)(\d+)$/.exec(label)),
        first = numbered[0];
      if (
        labels.length > 1 &&
        first &&
        numbered.every((label, i) => label?.[1] === first[1] && Number(label[2]) === Number(first[2]) + i)
      )
        return `${labels[0]}–${numbered.at(-1)![2]}`;
      return labels.join(" / ");
    };
  return commandJobs().flatMap(({ job, actions }) => {
    const keys = actions.map(key);
    return keys.every(k => k !== null) ? [[job, keys.join(" / ")] as [string, string]] : [];
  });
}
/** The keys a preset teaches, on one line, where its detail has no room. */
function keyLine(preset: km.Preset, prefix: km.Prefix): [string, string][] {
  const key = (name: string, value?: string) => onboarding.cardKey({ preset, prefix }, action(name, value));
  return [
    preset === "cmux" ? ["⌘", "+"] : [km.prefixName(prefix), i18n.t`then`],
    [key("new"), i18n.t`tab`],
    [`${key("split", "right")} ${key("split", "down")}`, i18n.t`split`],
    [["left", "down", "up", "right"].map(side => key("focus", side)).join(" "), i18n.t`focus`],
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
function summarizerChoices(
  s: Status,
  expanded: ReadonlySet<Provider>,
  query: string,
  preview?: LauncherPreview,
): Choice[] {
  const choices = summarizers.flatMap(choice => {
    const provider = Summarizer.provider(choice);
    if (!provider) {
      if (!matches(query, `${Summarizer.label(choice)} ${summary(choice, s)}`)) return [];
      const providerName = s.provider ? adapter(s.provider).name : "",
        model = s.provider ? Model.resolve(s.models[s.provider]).label() : "";
      return [
        {
          text: Summarizer.label(choice),
          inline_note: true,
          note:
            choice === "auto" && s.choice === "auto" && s.provider
              ? s.locked
                ? i18n.t`Use ${providerName} · ${model}`
                : i18n.t`Follow ${providerName} · ${model}`
              : choice === "auto"
                ? i18n.t`Follow your agents`
                : summary(choice, s),
          current: choice === s.choice,
          apply: { kind: "summaries", choice },
        } as Choice,
      ];
    }
    const native = adapter(provider).inference.catalog === "native";
    if (!adapter(provider).inference.models || (native && !s.available.some(m => m.provider === provider))) {
      const default_model = s.selection.provider === provider && s.selection.model ? "" : s.models[provider],
        rows = [
          {
            account: "",
            name: adapter(provider).inference.source || preview?.names[provider] || i18n.t`Default`,
            option: preview?.options[provider],
          },
          ...(preview?.accounts.filter(a => a.provider === provider) ?? []).map(a => ({
            account: a.account,
            name: a.name,
            option: a.option,
          })),
        ].flatMap(row => {
          const explicit =
              s.selection.provider === provider && s.selection.account === row.account && s.selection.model,
            model = explicit || default_model || adapter(provider).inference.model,
            label =
              (row.option?.model === model ? row.option.model_name : "") ||
              Model.resolve(model).label() ||
              i18n.t`Default model`,
            user = row.option?.account || "—",
            plan = row.option?.plan ?? "",
            kind: Billing | "signed_out" =
              row.option?.signed_in === false
                ? "signed_out"
                : row.option?.limits === "metered"
                  ? "tokens"
                  : row.option && typeof row.option.limits === "object"
                    ? "subscription"
                    : "unknown";
          if (!matches(query, `${adapter(provider).name} ${row.name} ${label} ${model} ${user} ${plan}`)) return [];
          return [
            modelHeading(row.name, 1, user, billingLabel(kind, plan)),
            {
              text: label,
              note: "",
              depth: 2,
              current: s.choice === provider && s.account === row.account,
              apply: row.account
                ? { kind: "summaries", choice: provider, model, account: row.account }
                : { kind: "summaries", choice: provider },
            } as Choice,
          ];
        });
      return rows.length ? [modelHeading(adapter(provider).name), ...rows] : [];
    }
    const all = s.available.filter(m => m.provider === provider);
    if (native) all.sort(compare);
    const recommended = automatic(all.filter(m => !native || !m.account)),
      models = all.filter(m =>
        matches(
          query,
          `${adapter(provider).name} ${modelSource(m, preview)} ${m.name} ${m.model} ${m.account_name} ${m.plan}`,
        ),
      ),
      show_all = expanded.has(provider),
      auto = s.selection.provider !== provider || !s.selection.model;
    if (query && !models.length && !(s.loading && matches(query, adapter(provider).name))) return [];
    const candidate = recommended;
    const auto_choice: Choice = {
      text: i18n.t`Auto`,
      depth: 1,
      inline_note: true,
      note: candidate
        ? ""
        : all.length
          ? i18n.t`No verified model yet`
          : s.loading
            ? i18n.t`Fetching models…`
            : i18n.t`Sign in first`,
      current: s.choice === provider && auto,
      apply: s.loading && !all.length ? null : { kind: "summaries", choice: provider },
    };
    const count = models.length,
      modelCount = count === 1 ? i18n.t`${count} model` : i18n.t`${count} models`;
    const heading: Choice = {
      text: adapter(provider).name,
      note: all.length
        ? modelCount + (s.loading ? " ◌" : "")
        : s.loading
          ? i18n.t`Fetching models…`
          : i18n.t`No signed-in models`,
      current: false,
      heading: true,
      heading_tone: "accent",
      apply: null,
    };
    const counts = new Map<string, number>(),
      shortlist = native
        ? models.filter(m => {
            const count = counts.get(m.account) ?? 0;
            counts.set(m.account, count + 1);
            return count < 5;
          })
        : models.slice(0, 5),
      hidden = models.length - shortlist.length,
      visible = show_all ? models.slice() : shortlist;
    if (candidate) {
      const index = visible.indexOf(candidate);
      if (index >= 0) visible.splice(index, 1);
      else if (!show_all && models.includes(candidate)) {
        const last = visible.findLastIndex(m => !native || m.account === candidate.account);
        if (last >= 0) visible.splice(last, 1);
      }
      visible.unshift(candidate);
    }
    const groups = new Map<string, ModelOption[]>();
    for (const model of visible) {
      const key = JSON.stringify([modelSource(model, preview), model.account, billing(model), model.plan]),
        group = groups.get(key);
      if (group) group.push(model);
      else groups.set(key, [model]);
    }
    return [
      heading,
      ...(matches(query, `${auto_choice.text} ${auto_choice.note}`) ? [auto_choice] : []),
      ...[...groups.values()].flatMap(group => [
        modelHeading(
          modelSource(group[0], preview),
          1,
          group[0].account_name || "—",
          billingLabel(billing(group[0]), group[0].plan),
        ),
        ...group.map((m): Choice => ({
          text: m.name,
          depth: 2,
          note: m === candidate ? i18n.t`(auto choice)` : m.ready === false ? i18n.t`Check failed` : "",
          pin: m === candidate,
          current: s.choice === provider && !auto && s.model === m.model && s.account === m.account,
          apply: models.includes(m)
            ? { kind: "summaries", choice: provider, model: m.model, account: m.account }
            : null,
        })),
      ]),
      ...(hidden > 0
        ? [
            {
              text: show_all ? i18n.t`Show fewer` : i18n.t`Show ${hidden} more`,
              depth: 1,
              note: "",
              current: false,
              more: provider,
              apply: null,
            } as Choice,
          ]
        : []),
    ];
  });
  let harness = false;
  const spaced: Choice[] = [];
  for (const choice of choices) {
    if (choice.heading && (choice.depth ?? 0) === 0) {
      if (harness) spaced.push({ text: "", note: "", depth: 0, current: false, apply: null });
      harness = true;
    }
    spaced.push(choice);
  }
  return spaced.length
    ? spaced
    : [{ text: i18n.t`No matching models`, note: "", heading: true, current: false, apply: null }];
}
function modelHeading(text: string, depth = 0, note = "", detail = ""): Choice {
  return {
    text,
    depth,
    note,
    detail,
    heading: true,
    heading_tone: depth === 0 ? "accent" : undefined,
    current: false,
    apply: null,
  };
}
function modelProviderName(provider: string): string {
  const names: Record<string, string> = {
    "github-copilot": "GitHub Copilot",
    "openai-codex": "OpenAI Codex",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    openrouter: "OpenRouter",
  };
  return names[provider] ?? provider;
}
function modelSource(model: ModelOption, preview?: LauncherPreview): string {
  const inference = adapter(model.provider).inference;
  if (inference.catalog !== "native") return modelProviderName(model.model.split("/")[0]);
  const source = inference.source || adapter(model.provider).name;
  return model.account
    ? preview?.accounts.find(a => a.provider === model.provider && a.account === model.account)?.name ||
        model.account_name ||
        source
    : source;
}
type Billing = "subscription" | "tokens" | "free" | "unknown";
function billingLabel(kind: Billing | "signed_out", plan: string): string {
  switch (kind) {
    case "subscription":
      return plan || i18n.t`Plan`;
    case "tokens":
      return i18n.t`Metered`;
    case "free":
      return i18n.t`Free`;
    case "unknown":
      return plan || i18n.t`Unknown`;
    case "signed_out":
      return i18n.t`Signed out`;
  }
}
function billing(model: ModelOption): Billing {
  if (model.subscription) return "subscription";
  if (adapter(model.provider).inference.catalog === "native") return "tokens";
  if (model.input_cost === null || model.output_cost === null) return "unknown";
  return model.input_cost === 0 && model.output_cost === 0 ? "free" : "tokens";
}
/** Stable columns across groups and scroll positions; names keep room before metadata. */
function modelIndent(choice: Choice): number {
  return choice.depth === 2 ? 3 : 0;
}
function modelColumnWidths(choices: Choice[]): { name: number; account: number; billing: number } {
  const accounts = choices.filter(c => c.heading && c.depth === 1);
  return {
    name: Math.max(
      12,
      ...accounts.map(c => displayWidth(c.text)),
      ...choices.filter(c => c.pin).map(c => displayWidth(c.text) + modelIndent(c)),
    ),
    account: Math.max(12, ...accounts.map(c => displayWidth(c.note))),
    billing: Math.max(7, ...accounts.map(c => displayWidth(c.detail ?? ""))),
  };
}
function modelPreferredWidth(choices: Choice[]): number {
  const columns = modelColumnWidths(choices);
  return columns.name + columns.account + columns.billing + 10;
}
function modelColumns(choices: Choice[], width: number): { note: number; detail: number } {
  const room = Math.max(0, width - 6),
    wanted = modelColumnWidths(choices),
    billing = Math.min(wanted.billing, Math.max(7, Math.floor(room / 3))),
    name = Math.min(wanted.name, Math.max(8, room - billing - 10)),
    account = Math.max(0, room - name - billing - 4);
  return { note: name, detail: name + account + 4 };
}
function summary(choice: Summarizer, s: Status): string {
  switch (choice) {
    case "auto": {
      if (s.choice !== "auto" || s.provider === null) return i18n.t`Follow the agents you run`;
      const providerName = adapter(s.provider).name,
        model = Model.resolve(s.models[s.provider]).label();
      return s.locked
        ? i18n.t`Settled on ${providerName} · ${model}`
        : i18n.t`Following you → ${providerName} · ${model}`;
    }
    case "off":
      return i18n.t`No summaries, plain links`;
    default: {
      const provider = Summarizer.provider(choice)!,
        providerName = adapter(provider).name;
      const selected = s.available.find(
        m =>
          m.provider === provider &&
          m.model === s.models[provider] &&
          (provider !== s.provider || m.account === s.account),
      );
      const cached = s.available.filter(m => m.provider === provider);
      if (
        adapter(provider).inference.models &&
        adapter(provider).inference.catalog !== "native" &&
        !s.models[provider] &&
        !cached.length
      )
        return s.loading
          ? i18n.t`Checking signed-in models…`
          : i18n.t`Sign in to a model provider through ${providerName}`;
      const model =
        selected?.name ||
        Model.resolve(
          s.models[provider] ||
            (adapter(provider).inference.catalog === "native" ? adapter(provider).inference.model : ""),
        ).label() ||
        automatic(cached)?.name ||
        i18n.t`No verified model yet`;
      return i18n.t`${model} · your ${providerName} login`;
    }
  }
}
/** The second line under Summaries, where the choice needs one. */
function note(choice: Summarizer, s: Status): string | null {
  switch (choice) {
    case "auto":
      return launchCounts(s);
    case "off":
      return i18n.t`Activity text stays blank; links say Open Link`;
    default:
      return null;
  }
}
/** Summaries' value: the choice, and whom Auto follows once it knows. */
function inUse(s: Status): string {
  const label = Summarizer.label(s.choice),
    provider = Summarizer.provider(s.choice);
  if (
    provider &&
    adapter(provider).inference.models &&
    (adapter(provider).inference.catalog !== "native" || s.available.some(m => m.provider === provider))
  ) {
    const native = adapter(provider).inference.catalog === "native",
      cached = s.available.filter(m => m.provider === provider && (!native || !m.account));
    if (native) cached.sort(compare);
    const model =
      s.available.find(m => m.provider === provider && m.model === s.model && m.account === s.account)?.name ??
      (s.model ? Model.resolve(s.model).label() : (automatic(cached)?.name ?? i18n.t`checking…`));
    const auto = s.selection.provider !== provider || !s.selection.model;
    return `${label} · ${auto ? i18n.t`Auto (${model})` : model}`;
  }
  return s.choice === "auto" && s.provider !== null ? `${label} · ${adapter(s.provider).name}` : label;
}
/** Launches per provider since the daemon started, in launcher order. */
function launchCounts(s: Status): string {
  const total = Provider.all.reduce((sum, provider) => sum + s.launches[provider], 0);
  if (total === 0) return i18n.t`No agents yet this session; using your last one`;
  let out = i18n.t`Since start:`;
  Provider.all.forEach(
    (provider, i) => (out += `${i === 0 ? "" : " ·"} ${adapter(provider).command} ${s.launches[provider]}×`),
  );
  return out;
}
