//! Setup modal opened from the corgi badge (or `prefix i`), centered on screen.
//! Viewer-owned; summarizer choices send `inference.configure` to the daemon,
//! resource and sleeping corgi choices update viewer preferences.
//! Mirrors corgi_setup.zig.
import * as palette from "./palette";
import { Style, keycap, colors, bgRgb, mix } from "./palette";
import { Rect } from "./layout";
import { Provider } from "./providers";
import { Model } from "./providers/model";
import * as corgiAnimation from "./corgi_animation";
import * as km from "./keymap";
import type { Preferences } from "./preferences";
import type { State as IntegrationState } from "./ghostty_integration";
import type { State as ClipboardState } from "./host_clipboard";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

export type Choice =
  "auto" | "codex" | "claude" | "off" | "ghostty" | "readings" | "sleeping_corgis" | "keyboard" | "import";
export const choices: Choice[] = [
  "auto",
  "codex",
  "claude",
  "off",
  "ghostty",
  "readings",
  "sleeping_corgis",
  "keyboard",
  "import",
];
export const Choice = {
  provider(choice: Choice): Provider | null {
    return choice === "codex" || choice === "claude" ? choice : null;
  },
};
const summarizer = (choice: Choice) => choices.indexOf(choice) <= choices.indexOf("off");
const labels: Record<Choice, string> = {
  auto: "Auto",
  codex: "Codex",
  claude: "Claude",
  off: "Off",
  ghostty: "Command-key integration",
  readings: "Resource readings",
  sleeping_corgis: "Sleeping corgis",
  keyboard: "Keyboard shortcuts",
  import: "Import sessions",
};
/** The inference setup status the daemon publishes, as inference.zig's `Status`. */
export interface Status {
  choice: "auto" | "codex" | "claude" | "off";
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

/** Rows inside the frame, top to bottom. Drawing and hit testing both walk
 * this table; short terminals drop the spacers, then the hints. */
type Line =
  | "spacer"
  | "image_paste"
  | "detail"
  | "divider"
  | "footer"
  | { heading: string }
  | { lead: string }
  | { hint: string }
  | { option: Choice };
const lines: Line[] = [
  "spacer",
  { heading: "Activity summaries" },
  { lead: "Who writes activity summaries and link names?" },
  "spacer",
  { option: "auto" },
  { option: "codex" },
  { option: "claude" },
  { option: "off" },
  "detail",
  "spacer",
  { heading: "Ghostty" },
  { option: "ghostty" },
  { hint: "Cmd+1-9, Cmd+T/W, Ctrl+Tab · reload with Cmd+Shift+," },
  "image_paste",
  "spacer",
  { heading: "Workspace resources" },
  { option: "readings" },
  "spacer",
  { heading: "Idle agents" },
  { option: "sleeping_corgis" },
  "spacer",
  { heading: "Shortcuts & import" },
  { option: "keyboard" },
  { option: "import" },
  { hint: "Bring in sessions from other terminal multiplexers" },
  "spacer",
  "divider",
  "footer",
];
type Density = "full" | "tight" | "minimal";
function kept(line: Line, density: Density): boolean {
  if (line === "spacer") return density === "full";
  if (typeof line === "object" && "hint" in line) return density !== "minimal";
  return true;
}
function heightFor(density: Density): number {
  return 2 + lines.filter(line => kept(line, density)).length;
}
const max_width = 64;
const min_width = 48;
function densityFor(rows: number): Density {
  return rows >= heightFor("full") ? "full" : rows >= heightFor("tight") ? "tight" : "minimal";
}
/** The line on `offset` rows below the top border. */
function lineAt(rows: number, offset: number): Line | null {
  return lines.filter(line => kept(line, densityFor(rows)))[offset] ?? null;
}
function usable(b: Rect): boolean {
  return b.w >= min_width && b.h >= heightFor("minimal");
}
const panel = new Style({ fg: "faint", bg: "surface" }).sgr();
const border = new Style({ fg: "line", bg: "surface" }).sgr();
const text = new Style({ fg: "text", bg: "surface" }).sgr();
const bright = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
const warm = new Style({ fg: "warm", bg: "surface" }).sgr();
interface Row {
  text: string;
  label: string;
  accent: string;
  muted: string;
  quiet: string;
  warn: string;
  background: palette.Rgb;
}
const row_normal: Row = {
  text,
  label: text,
  accent: new Style({ fg: "accent", bg: "surface" }).sgr(),
  muted: new Style({ fg: "muted", bg: "surface" }).sgr(),
  quiet: panel,
  warn: warm,
  background: colors.surface,
};
const row_selected: Row = {
  text: new Style({ fg: "text", bg: "selected" }).sgr(),
  label: new Style({ fg: "strong", bg: "selected", bold: true }).sgr(),
  accent: new Style({ fg: "accent", bg: "selected" }).sgr(),
  muted: new Style({ fg: "muted", bg: "selected" }).sgr(),
  // Faint is too dim on a selected row.
  quiet: new Style({ fg: "muted", bg: "selected" }).sgr(),
  warn: new Style({ fg: "warm", bg: "selected" }).sgr(),
  background: colors.selected,
};
/** The background darkened halfway to black. */
const shadow = "\x1b[0m" + bgRgb(mix(colors.bg, [0, 0, 0], 50));
// Columns inside the frame, counted from its left border.
const marker_x = 3;
const label_x = 5;
const summary_x = 18;
/** The setup preview dreams more often than a sidebar list. */
const preview_period_ms = 6_000;

export class Menu {
  selected: Choice = "auto";
  integration: IntegrationState = "unavailable";
  /** The host terminal's clipboard; null when the viewer has no terminal. */
  image_paste: ClipboardState | null = null;
  static open(s: Status): Menu {
    const menu = new Menu();
    menu.selected = s.choice;
    return menu;
  }
  static bounds(cols: number, rows: number): Rect {
    const w = Math.min(cols, max_width);
    const h = Math.min(rows, heightFor(densityFor(rows)));
    return new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h);
  }
  static contains(cols: number, rows: number, x: number, y: number): boolean {
    return Menu.bounds(cols, rows).contains(x, y);
  }
  static hit(cols: number, rows: number, x: number, y: number): Choice | null {
    const b = Menu.bounds(cols, rows);
    if (!usable(b) || x <= b.x || x >= b.x + b.w - 1 || y <= b.y) return null;
    const line = lineAt(rows, y - b.y - 1);
    return line !== null && typeof line === "object" && "option" in line ? line.option : null;
  }
  move(next: boolean): void {
    const index = choices.indexOf(this.selected);
    this.selected = choices[next ? Math.min(index + 1, choices.length - 1) : sat(index, 1)];
  }
  draw(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number): void {
    return this.drawAt(w, s, prefs, cols, rows, Date.now());
  }
  drawAt(w: Writer, s: Status, prefs: Preferences, cols: number, rows: number, now_ms: number): void {
    const b = Menu.bounds(cols, rows);
    if (!usable(b)) return;
    // Shadow one row below and two columns right, clipped to the screen.
    if (b.y + b.h < rows) {
      w.write(`\x1b[${b.y + b.h + 1};${b.x + 3}H${shadow}`);
      w.splat(" ", Math.min(b.w, sat(cols, b.x + 2)));
    }
    for (let row = 1; row < b.h; row++) {
      const room = Math.min(2, sat(cols, b.x + b.w));
      if (room === 0) break;
      w.write(`\x1b[${b.y + row + 1};${b.x + b.w + 1}H${shadow}`);
      w.splat(" ", room);
    }
    for (let row = 0; row < b.h; row++) {
      const line = row === 0 || row === b.h - 1 ? null : lineAt(rows, row - 1);
      const divider = line === "divider";
      w.write(`\x1b[${b.y + row + 1};${b.x + 1}H${border}`);
      w.write(row === 0 ? "╭" : row === b.h - 1 ? "╰" : divider ? "├" : "│");
      if (row === 0 || row === b.h - 1 || divider) w.write("─".repeat(b.w - 2));
      else w.splat(" ", b.w - 2);
      w.write(row === 0 ? "╮" : row === b.h - 1 ? "╯" : divider ? "┤" : "│");
    }
    w.write(`\x1b[${b.y + 1};${b.x + 3}H${text} ᐯ•ᴥ•ᐯ ${bright}Corgi setup `);
    w.write(`\x1b[${b.y + 1};${b.x + b.w - 7}H${panel} esc `);
    for (let row = 1; row < b.h - 1; row++) {
      const y = b.y + row;
      const line = lineAt(rows, row - 1)!;
      if (line === "spacer" || line === "divider") continue;
      if (typeof line === "object") {
        if ("heading" in line) put(w, b, marker_x, y, bright, line.heading);
        else if ("lead" in line) put(w, b, marker_x, y, panel, line.lead);
        else if ("hint" in line) put(w, b, label_x, y, panel, line.hint);
        else this.drawOption(w, b, y, line.option, s, prefs, now_ms);
        continue;
      }
      if (line === "image_paste") {
        const clipboard = this.image_paste;
        if (!clipboard) continue;
        const state = clipboard.status();
        put(w, b, label_x, y, text, "Image paste");
        const on = clipboard.support === "on";
        w.write(`\x1b[${y + 1};${b.x + b.w - 3 - displayWidth(state)}H${on ? row_normal.accent : panel}${state}`);
      } else if (line === "detail") {
        put(w, b, summary_x, y, panel, detail(summarizer(this.selected) ? this.selected : s.choice, s));
      } else if (line === "footer") {
        put(w, b, marker_x, y, panel, "↑↓ choose · esc close");
        const label = this.action(s, prefs);
        if (label !== null) {
          const shown = `[ Enter ${label} ]`;
          w.write(`\x1b[${y + 1};${b.x + b.w - 3 - displayWidth(shown) + 1}H${keycap}${shown}`);
        }
      }
    }
    w.write("\x1b[0m\x1b[?25l");
  }
  private drawOption(
    w: Writer,
    b: Rect,
    y: number,
    choice: Choice,
    s: Status,
    prefs: Preferences,
    now_ms: number,
  ): void {
    const highlighted = choice === this.selected;
    const p = highlighted ? row_selected : row_normal;
    const base = p.text;
    w.write(`\x1b[${y + 1};${b.x + 2}H${base}`);
    w.splat(" ", b.w - 2);
    if (highlighted) w.write(`\x1b[${y + 1};${b.x + marker_x + 1}H${p.accent}›`);
    let right: { text: string; style: string };
    switch (choice) {
      case "ghostty":
        right =
          this.integration === "enabled"
            ? { text: "● On", style: p.accent }
            : this.integration === "disabled"
              ? { text: "○ Off", style: p.quiet }
              : this.integration === "unavailable"
                ? { text: "local macOS only", style: p.quiet }
                : { text: "config unreadable", style: p.warn };
        break;
      case "readings":
        right = prefs.resources.enabled ? { text: "● On", style: p.accent } : { text: "○ Off", style: p.quiet };
        break;
      case "sleeping_corgis":
        right = prefs.sleeping_corgis ? { text: "● On", style: p.accent } : { text: "○ Off", style: p.quiet };
        break;
      case "keyboard":
        right = { text: keysLabel(prefs), style: p.muted };
        break;
      case "import":
        right = { text: "→", style: p.muted };
        break;
      default:
        right = { text: summarizer(choice) && choice === s.choice ? "in use" : "", style: p.muted };
    }
    const right_width = displayWidth(right.text);
    const right_x = b.w - 4 - right_width;
    if (summarizer(choice)) {
      const chosen = choice === s.choice;
      w.write(
        `\x1b[${y + 1};${b.x + label_x + 1}H${chosen ? p.accent : p.quiet}${chosen ? "●" : "○"} ${p.label}${labels[choice]}`,
      );
      w.write(`\x1b[${y + 1};${b.x + summary_x + 1}H${base}`);
      writeEllipsis(w, summary(choice, s), sat(right_x, summary_x + (right_width > 0 ? 1 : 0) + 1));
    } else {
      w.write(`\x1b[${y + 1};${b.x + label_x + 1}H${p.label}`);
      writeEllipsis(w, labels[choice], sat(right_x, label_x + 1));
    }
    if (choice === "sleeping_corgis") {
      // A live preview beside the label: on, it puffs every few seconds;
      // off, it naps dim and still.
      const x = label_x + displayWidth(labels[choice]) + 2;
      const elapsed = ((now_ms % preview_period_ms) + preview_period_ms) % preview_period_ms;
      w.write(`\x1b[${y + 1};${b.x + x + 1}H${base}`);
      w.write(
        corgiAnimation.idle(Math.min(12, sat(right_x, x + 1)), {
          background: p.background,
          bright: prefs.sleeping_corgis,
          selected: highlighted,
          puff_ms: prefs.sleeping_corgis ? elapsed : null,
        }),
      );
    }
    if (right_width > 0) w.write(`\x1b[${y + 1};${b.x + right_x + 1}H${right.style}${right.text}`);
  }
  /** The keycap label for Enter, or null when Enter would do nothing useful. */
  action(s: Status, prefs: Preferences): string | null {
    switch (this.selected) {
      case "ghostty":
        return this.integration === "enabled" ? "Turn off" : this.integration === "disabled" ? "Turn on" : null;
      case "readings":
        return prefs.resources.enabled ? "Turn off" : "Turn on";
      case "sleeping_corgis":
        return prefs.sleeping_corgis ? "Turn off" : "Turn on";
      case "keyboard":
      case "import":
        return "Open →";
      default:
        return this.selected === s.choice ? "Keep" : `Use ${labels[this.selected]}`;
    }
  }
}
function keysLabel(prefs: Preferences): string {
  if (prefs.preset === "cmux") return "cmux · Cmd  →";
  return `${km.name(prefs.preset)} · ${km.prefixName(prefs.prefix)}  →`;
}
function put(w: Writer, b: Rect, x: number, y: number, style: string, value: string): void {
  w.write(`\x1b[${y + 1};${b.x + x + 1}H${style}`);
  writeEllipsis(w, value, sat(b.w, x + 2));
}
function summary(choice: Choice, s: Status): string {
  switch (choice) {
    case "auto":
      if (s.choice !== "auto" || s.provider === null) return "Follow the agents you run";
      return `${s.locked ? "Settled on" : "Following you →"} ${Provider.info(s.provider).name} · ${Model.resolve(s.models[s.provider]).label()}`;
    // Mismatched eyes: every glyph stays one terminal column wide.
    case "off":
      return "ᐯoᴥ°ᐯ  no summaries, plain links";
    default: {
      const provider = Choice.provider(choice)!;
      return `${Model.resolve(s.models[provider]).label()} · your ${Provider.info(provider).name} login`;
    }
  }
}
function detail(choice: Choice, s: Status): string {
  switch (choice) {
    case "auto":
      return launchCounts(s);
    case "off":
      return "Activity text stays blank; links say Open Link";
    default:
      return `Needs ${Provider.info(Choice.provider(choice)!).executables[0]} installed and signed in`;
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
export const testing = { heightFor };
