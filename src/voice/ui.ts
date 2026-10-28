//! Voice mode's screen: where dictation goes, the microphone level against
//! the threshold, what was heard and what became of it, and the keys.
import * as palette from "../palette";
import { Style } from "../palette";
import * as level from "./level";
import { keys, incomplete, type Key } from "../terminal_keys";
import { displayWidth, ellipsis } from "../text";
import { thumb } from "../scroll_thumb";
import { Differ } from "../frame_diff";
import { closeReadiness } from "../pane/terminal";
import type { VoiceSession, Utterance } from "./session";
import type { Device } from "./capture";
import type { Timing } from "./segmenter";

const reset = "\x1b[0m",
  meter_cells = 20,
  meter_row = 4,
  pause_row = 5,
  options_row = 6,
  history_top = 9,
  label_width = 9,
  /** The first column's values: a meter, two spaces and its setting. */
  column_width = 28,
  /** The level row is not clipped: its label, the meter, two spaces and "T:100". */
  min_cols = 1 + label_width + meter_cells + 2 + 5,
  /** How long a read that ends in an escape waits for the rest of the key. */
  esc_ms = 50,
  /** A meter cell filled by quarters, bottom up. */
  fills = [" ", "⣀", "⣤", "⣶", "⣿"],
  /** The meter's colors run from the accent through warm to hot, so they follow the theme. */
  meter_stops: palette.Token[] = ["accent", "warm", "hot"];
type Option = keyof Timing | "filter";
/** The options in two lines of aligned columns: what ends an utterance, then what starts one. */
const option_lines: Option[][] = [
    ["silence", "burst", "filter"],
    ["pre_roll", "min_speech"],
  ],
  option_names: Record<Option, string> = {
    silence: "silence",
    burst: "burst",
    filter: "filter",
    pre_roll: "pre-roll",
    min_speech: "min speech",
  },
  /** What each timing's menu offers, in seconds; a value from voice.json joins them. */
  choices: Record<keyof Timing, number[]> = {
    silence: [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10],
    burst: [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5],
    pre_roll: [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1],
    min_speech: [0.05, 0.1, 0.2, 0.3, 0.5, 1],
  },
  /** The widest timing, "0.75 s". */
  value_width = 6;
const seconds = (v: number) => `${v} s`;
/** The help overlay: each setting, and how it changes what becomes text. */
const help_entries: [string, string][] = [
  [
    "threshold",
    "How loud a sound must be to count as speech: the bar on the meter, changed with + and - or the mouse wheel. Raise it in a noisy room; lower it when quiet words are missed.",
  ],
  [
    "silence",
    "How long a pause ends an utterance and sends it to Whisper. Shorter types sooner but can split a sentence; longer waits through pauses for thought. The grey line under the meter shows the pause running.",
  ],
  [
    "burst",
    "How long a sound must stay above the threshold to count as speaking again. Shorter peaks, such as music or a click, neither end nor extend the pause.",
  ],
  [
    "filter",
    "Whisper's speech detection, which skips audio without speech so noise does not become text. Switching it, with f or a click, restarts the Whisper server.",
  ],
  ["pre-roll", "Audio kept from just before the level crossed the threshold, so the first syllable is not cut off."],
  [
    "min speech",
    "How much loud audio an utterance needs; anything shorter, such as a cough or a door, is dropped before Whisper.",
  ],
  [
    "",
    "Click an option to change it. Changes last for this session; voice.json holds the defaults. An utterance is cut at 30 s, as Whisper hears 30 s at a time.",
  ],
];
/** `text` in lines of at most `width` cells, broken between words. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && displayWidth(line) + 1 + displayWidth(word) > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...out, line] : out;
}
let plain = "",
  strong = "",
  text = "",
  muted = "",
  quiet = "",
  accent = "",
  accentBold = "",
  warm = "",
  hot = "",
  line = "",
  focused = "",
  mark = "",
  /** The note in the title: three close greens while voice works. */
  listening_note = "",
  recording_note = "",
  transcribing_note = "",
  hotBold = "",
  /** Each meter cell's fill color, and the same dimmed while the level is
   * under the threshold; the grey ones, at the same brightness, while muted. */
  gradient: string[] = [],
  dimmed: string[] = [],
  grey_gradient: string[] = [],
  grey_dimmed: string[] = [];
palette.derived(() => {
  plain = new Style({ bg: "bg" }).sgr();
  const stops = meter_stops.map(t => palette.colors[t]),
    cell = (i: number) => {
      // Where cell i falls between two stops, as a percentage of the way.
      const t = (i * (stops.length - 1) * 100) / (meter_cells - 1),
        from = Math.min(stops.length - 2, Math.floor(t / 100));
      return palette.mix(stops[from], stops[from + 1], t - from * 100);
    },
    grey = ([r, g, b]: palette.Rgb): palette.Rgb => {
      const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      return [y, y, y];
    },
    cells = (color: (i: number) => palette.Rgb) =>
      Array.from({ length: meter_cells }, (_, i) => plain + palette.fgRgb(color(i)));
  gradient = cells(cell);
  dimmed = cells(i => palette.mix(cell(i), palette.colors.bg, 55));
  grey_gradient = cells(i => grey(cell(i)));
  grey_dimmed = cells(i => palette.mix(grey(cell(i)), palette.colors.bg, 55));
  mark = new Style({ fg: "warm", bg: "bg", bold: true }).sgr();
  const green = palette.colors.accent;
  listening_note = plain + "\x1b[1m" + palette.fgRgb(palette.mix(green, palette.colors.bg, 35));
  recording_note = plain + "\x1b[1m" + palette.fgRgb(green);
  transcribing_note = plain + "\x1b[1m" + palette.fgRgb(palette.mix(green, palette.colors.strong, 35));
  hotBold = new Style({ fg: "hot", bg: "bg", bold: true }).sgr();
  strong = new Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  text = new Style({ fg: "text", bg: "bg" }).sgr();
  muted = new Style({ fg: "muted", bg: "bg" }).sgr();
  quiet = new Style({ fg: "faint", bg: "bg" }).sgr();
  accent = new Style({ fg: "accent", bg: "bg" }).sgr();
  accentBold = new Style({ fg: "accent", bg: "bg", bold: true }).sgr();
  warm = new Style({ fg: "warm", bg: "bg" }).sgr();
  hot = new Style({ fg: "hot", bg: "bg" }).sgr();
  line = new Style({ fg: "line", bg: "bg" }).sgr();
  focused = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
});

export type FilterState = "on" | "off" | "not installed";
export type Options = {
  /** "local", or the SSH host. */
  target: string;
  device: string;
  model: string;
  threshold: number;
  /** Whether the speech filter runs, and the times that start and end an utterance. */
  filter: FilterState;
  timing: Timing;
  /** Turns the speech filter on or off, which restarts the Whisper server. */
  toggleFilter: () => Promise<FilterState>;
  /** A live timing went to `seconds`; never saved. */
  setTiming: (name: keyof Timing, seconds: number) => void;
  notices: string[];
  /** The live threshold went to `pct`; never saved. */
  setThreshold: (pct: number) => void;
  listDevices: () => Promise<{ devices: Device[]; notice?: string }>;
  switchDevice: (device: Device) => void;
  quit: () => void;
};
type Picker = { devices: Device[]; choice: number; loading: boolean; notice?: string };
/** A timing's dropdown, opened by a click on it, below its value at `y`, `x`. */
type Menu = { name: keyof Timing; values: number[]; choice: number; y: number; x: number };

/** What a problem means for the user, and the fix. */
export function problem(
  session: VoiceSession,
  app = process.env.TERM_PROGRAM,
  platform = process.platform,
): string | null {
  switch (session.unavailable) {
    case "mic_denied":
      return platform === "darwin"
        ? `Microphone access denied: allow ${app || "your terminal"} in System Settings › Privacy & Security › Microphone`
        : "Microphone access denied";
    case "mic_busy":
      return "The microphone is in use by another program";
    case "mic_missing":
      return "No microphone found: press d to pick another";
    case "server_down":
      return "The Whisper server stopped: press f for a fresh one, or restart voice mode";
    default:
      return null;
  }
}
function linkStatus(session: VoiceSession, target: string): string | null {
  switch (session.link_state) {
    case "connecting":
      return `Connecting to ${target}…`;
    case "lost":
      return `Lost the connection to ${target}; retrying every 5 s`;
    case "refused":
      return session.refused === "VoiceAttached"
        ? "Another voice session is already attached to this runtime"
        : `${target} refused voice mode (${session.refused})`;
    default:
      return null;
  }
}
/** The mode: MUTED or Listening, as the sidebar has it (a voice that cannot
 * listen counts as muted). The note in the title adds whether the runtime is
 * connected and has a viewer, and what speech is doing. */
export function mode(s: VoiceSession): {
  note: string;
  style: string;
  /** Whether the mode is MUTED, which the meter greys for. */
  muted: boolean;
  label: string;
  label_style: string;
} {
  const off = { muted: true, label: "MUTED", label_style: hotBold };
  if (!s.available) return { note: "○", style: warm, ...off };
  if (s.muted) return { note: "♪", style: muted, ...off };
  const on = { muted: false, label: "Listening", label_style: strong };
  // Nowhere for text to go: grey until the runtime is connected with a viewer.
  if (s.link_state !== "connected" || !s.viewer) return { note: "♫", style: muted, ...on };
  if (s.recording) return { note: "♫", style: recording_note, ...on };
  if (s.transcribing) return { note: "♫", style: transcribing_note, ...on };
  return { note: "♫", style: listening_note, ...on };
}
/** A local wall-clock time, as 14:02:31. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}
/** How long the text took once speech ended: transcription plus delivery. */
function latency(u: Utterance): string | null {
  const { transcribe_ms, deliver_ms } = u.timings;
  if (transcribe_ms === undefined || deliver_ms === undefined) return null;
  const ms = transcribe_ms + deliver_ms;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
type Row = { glyph: string; style: string; label: string; time: string; latency: string | null };
/** One history row: a status glyph, when it was said, how long it took, what
 * was said, and what became of it. */
export function row(u: Utterance): Row | null {
  const line = describe(u);
  return line && { ...line, time: clock(u.captured_at), latency: latency(u) };
}
function describe(u: Utterance): { glyph: string; style: string; label: string } | null {
  const said = u.text ?? "";
  switch (u.status) {
    // Speech in progress shows in the title, not as rows that come and go.
    case "recording":
    case "transcribing":
      return null;
    case "delivering":
      return { glyph: "→", style: muted, label: said };
    case "delivered":
      return { glyph: "✓", style: text, label: said };
    case "failed":
      return { glyph: "✗", style: warm, label: `${said ? said + " · " : ""}failed: ${u.reason}` };
    case "discarded":
      return { glyph: "○", style: quiet, label: `discarded (${u.reason})` };
    // Muting drops what was said on purpose; it needs no row.
    case "muted":
    case "dropped":
      return null;
  }
}
/** A rounded box, blank inside, with `title` in its top edge. */
function box(
  at: (y: number, x: number) => string,
  top: number,
  left: number,
  width: number,
  height: number,
  title: string,
): string {
  let out =
    at(top, left) +
    line +
    "╭─ " +
    strong +
    title +
    line +
    " " +
    "─".repeat(Math.max(0, width - 5 - title.length)) +
    "╮";
  for (let y = 1; y < height - 1; y++)
    out += at(top + y, left) + line + "│" + plain + " ".repeat(width - 2) + line + "│";
  return out + at(top + height - 1, left) + "╰" + "─".repeat(width - 2) + "╯" + reset;
}

export class VoiceUi {
  threshold: number;
  timing: Timing;
  filter: FilterState | "switching…";
  /** History rows scrolled back from the newest. */
  scroll = 0;
  picker: Picker | null = null;
  menu: Menu | null = null;
  /** The help overlay, and how far it is scrolled when it does not fit. */
  help: { scroll: number } | null = null;
  device: string;
  /** What a click does, and where, from the last frame: the note and the mode
   * mute or unmute, an option opens its menu or switches. */
  private hits: { y: number; x: number; width: number; act: () => void }[] = [];
  constructor(
    readonly session: VoiceSession,
    private opts: Options,
  ) {
    this.threshold = opts.threshold;
    this.timing = { ...opts.timing };
    this.filter = opts.filter;
    this.device = opts.device;
  }
  /** The frame for a `cols` × `rows` screen, from a clear one. */
  draw(cols: number, rows: number): string {
    const at = (y: number, x: number) => `\x1b[${y + 1};${x + 1}H`,
      s = this.session;
    let frame = "";
    for (let y = 0; y < rows; y++) frame += at(y, 0) + plain + " ".repeat(cols);
    const put = (y: number, x: number, style: string, value: string, room = cols - x) => {
      if (y < 0 || y >= rows || room <= 0) return 0;
      const shown = ellipsis(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " "), room);
      frame += at(y, x) + style + shown + reset;
      return displayWidth(shown);
    };
    if (cols < min_cols || rows < 14) {
      put(0, 0, text, "Make this window bigger for voice mode.");
      return frame;
    }
    // Title: a note for the mode that a click mutes or unmutes, then voice mode.
    const state = mode(s),
      mute = () => this.session.setMuted(!this.session.muted);
    this.hits = [{ y: 0, x: 0, width: 3, act: mute }];
    put(0, 1, state.style, state.note);
    put(0, 3, strong, "Corgi Voice");
    frame += at(1, 0) + line + "─".repeat(cols) + reset;
    // A table of two columns: the first holds the meters, the second starts after them.
    const second = 1 + label_width + column_width + 2,
      cell = (y: number, label: string, value: string, style: string, x = 1, room = column_width) => {
        put(y, x, muted, label);
        return put(y, x + label_width, style, value, Math.min(room, cols - 1 - x - label_width));
      };
    // Where the next text goes: the focused pane's name, much as its tab shows it.
    cell(2, "Target:", this.opts.target + (s.focus ? ` → ${s.focus}` : ""), accent);
    cell(3, "Device:", this.device, accent);
    if (cols > second + label_width) {
      const right = cols - 1 - second - label_width;
      cell(2, "Model:", this.opts.model, strong, second, right);
      const shown = cell(3, "Mode:", state.label, state.label_style, second, right);
      this.hits.push({ y: 3, x: second + label_width, width: shown, act: mute });
    }
    // The level in braille dots, a quarter cell at a time, dimmed while it is
    // under the threshold, which is a solid warm bar. Grey while muted.
    const filled = (s.level / 100) * meter_cells,
      threshold = Math.min(meter_cells - 1, Math.round((this.threshold / 100) * meter_cells)),
      loud = s.level >= this.threshold,
      colors = state.muted ? (loud ? grey_gradient : grey_dimmed) : loud ? gradient : dimmed;
    put(meter_row, 1, muted, "Level:");
    frame += at(meter_row, 1 + label_width);
    for (let i = 0; i < meter_cells; i++) {
      const quarters = Math.min(4, Math.floor(Math.max(0, filled - i) * 4));
      frame += i === threshold ? mark + "┃" : (quarters ? colors[i] : plain) + fills[quarters];
    }
    frame += plain + "  " + mark + `T:${String(Math.round(this.threshold)).padStart(2, "0")}` + reset;
    // Under the meter, a thin line in the separators' grey grows while a pause
    // runs toward the end of the utterance.
    const paused = Math.round(s.pause * meter_cells);
    if (paused) frame += at(pause_row, 1 + label_width) + line + "─".repeat(paused) + reset;
    // The options, a click away: each opens a menu of values, and the filter switches.
    put(options_row, 1, muted, "Options:");
    let x = 1 + label_width;
    for (let c = 0; c < 3; c++) {
      const column = option_lines.map(l => l[c]).filter(o => o !== undefined),
        name_width = Math.max(...column.map(o => option_names[o].length)) + 1;
      option_lines.forEach((l, i) => {
        const o = l[c];
        if (!o) return;
        const y = options_row + i;
        put(y, x, muted, option_names[o]);
        const at = x + name_width,
          shown =
            o === "filter"
              ? put(y, at, this.filter === "not installed" ? warm : this.filter === "on" ? strong : muted, this.filter)
              : put(y, at, strong, seconds(this.timing[o]));
        this.hits.push({
          y,
          x,
          width: at - x + shown,
          act: () => (o === "filter" ? void this.switchFilter() : this.openMenu(o, y + 1, at - 2)),
        });
      });
      x += name_width + value_width + 3;
    }
    frame += at(history_top - 1, 0) + line + "─".repeat(cols) + reset;
    // What stands in the way, if anything, and the notices; then the history, newest at the bottom.
    const status =
        problem(s) ??
        linkStatus(s, this.opts.target) ??
        (s.viewer ? null : "No Corgi window is attached; nothing is recorded until one is"),
      notices: [string, string][] = [
        ...(status ? [[s.available && s.link_state !== "refused" ? muted : warm, status] as [string, string]] : []),
        ...this.opts.notices.slice(0, 3).map(n => [warm, n] as [string, string]),
      ];
    notices.forEach(([style, n], i) => put(history_top + i, 1, style, n, cols - 3));
    const top = history_top + notices.length,
      height = Math.max(0, rows - 2 - top),
      shown = s.history.map(row).filter(r => r !== null);
    this.scroll = Math.max(0, Math.min(this.scroll, shown.length - height));
    const last = shown.length - this.scroll,
      first = Math.max(0, last - height);
    if (!shown.length) put(top, 1, quiet, "Say something; what is heard shows here.");
    shown.slice(first, last).forEach((r, i) => {
      put(top + i, 1, r.style, r.glyph);
      let x = 3 + put(top + i, 3, quiet, r.time + " ");
      if (r.latency) x += put(top + i, x, quiet, `(${r.latency}) `);
      put(top + i, x, r.style, r.label, cols - 2 - x);
    });
    const bar = thumb(height, shown.length, first);
    if (bar) for (let i = 0; i < bar.len; i++) frame += at(top + bar.start + i, cols - 1) + muted + "┃" + reset;
    // The keys, most needed first; those that do not fit are left out whole.
    frame += at(rows - 1, 1);
    let room = cols - 2;
    for (const [key, what] of [
      // Padded to "unmute", so the keys after it never shift.
      ["m", (s.muted ? "unmute" : "mute").padEnd(6)],
      ["q", "quit"],
      ["?", "help"],
      ["+ -", "threshold"],
      ["f", "filter"],
      ["d", "device"],
      ["j k", "history"],
    ]) {
      const width = key.length + what.length + 5;
      if (width > room) break;
      room -= width;
      frame += `${palette.keycap} ${key} ${reset}${quiet} ${what}  ${reset}`;
    }
    if (this.picker) frame += this.drawPicker(cols, rows, at);
    if (this.menu) frame += this.drawMenu(cols, rows, at);
    if (this.help) frame += this.drawHelp(cols, rows, at);
    return frame;
  }
  private drawHelp(cols: number, rows: number, at: (y: number, x: number) => string): string {
    const width = Math.min(cols - 4, 78),
      name_width = 12,
      lines = help_entries.flatMap(([name, what], i) => [
        ...(i ? [{ name: "", text: "" }] : []),
        ...wrap(what, width - 4 - name_width).map((text, j) => ({ name: j ? "" : name, text })),
      ]),
      height = Math.min(rows - 2, lines.length + 4),
      room = height - 4,
      h = this.help!;
    h.scroll = Math.max(0, Math.min(h.scroll, lines.length - room));
    const left = Math.floor((cols - width) / 2),
      top = Math.floor((rows - height) / 2);
    let out = box(at, top, left, width, height, "Options");
    lines.slice(h.scroll, h.scroll + room).forEach((l, i) => {
      out += at(top + 1 + i, left + 2) + accent + l.name.padEnd(name_width) + text + l.text + reset;
    });
    const more = lines.length > room ? "↑↓ scroll  " : "";
    out += at(top + height - 2, left + 2) + quiet + ellipsis(`${more}? or esc close`, width - 4) + reset;
    return out;
  }
  private helpKey(key: Key): void {
    const h = this.help!;
    if (key.kind === "up" || (key.kind === "text" && key.text === "k")) h.scroll = Math.max(0, h.scroll - 1);
    else if (key.kind === "down" || (key.kind === "text" && key.text === "j")) h.scroll++;
    else if (
      key.kind === "esc" ||
      key.kind === "cancel" ||
      key.kind === "enter" ||
      key.kind === "click" ||
      (key.kind === "text" && (key.text === "?" || key.text === "q"))
    )
      this.help = null;
  }
  /** The menu's box, kept on screen: its top-left corner and size. */
  private menuBox(cols: number, rows: number) {
    const m = this.menu!,
      width = Math.max(...m.values.map(v => seconds(v).length)) + 6,
      height = Math.min(rows, m.values.length + 2);
    return {
      top: Math.max(0, Math.min(m.y, rows - height)),
      left: Math.max(0, Math.min(m.x, cols - width)),
      width,
      height,
    };
  }
  private drawMenu(cols: number, rows: number, at: (y: number, x: number) => string): string {
    const m = this.menu!,
      { top, left, width, height } = this.menuBox(cols, rows);
    let out = at(top, left) + line + "╭" + "─".repeat(width - 2) + "╮";
    m.values.slice(0, height - 2).forEach((v, i) => {
      const label = (i === m.choice ? "❯ " : "  ") + seconds(v);
      out +=
        at(top + 1 + i, left) +
        line +
        "│" +
        (i === m.choice ? focused : text) +
        " " +
        label.padEnd(width - 3) +
        line +
        "│";
    });
    out += at(top + height - 1, left) + "╰" + "─".repeat(width - 2) + "╯" + reset;
    this.menuArea = { top, left, width, height };
    return out;
  }
  private menuArea = { top: 0, left: 0, width: 0, height: 0 };
  private openMenu(name: keyof Timing, y: number, x: number): void {
    const now = this.timing[name],
      values = [...new Set([...choices[name], now])].sort((a, b) => a - b);
    this.menu = { name, values, choice: values.indexOf(now), y, x };
  }
  private choose(i: number): void {
    const m = this.menu!;
    this.menu = null;
    this.timing[m.name] = m.values[i];
    this.opts.setTiming(m.name, m.values[i]);
  }
  private menuKey(key: Key): void {
    const m = this.menu!,
      n = m.values.length;
    if (key.kind === "esc" || key.kind === "cancel" || (key.kind === "text" && key.text === "q")) this.menu = null;
    else if (key.kind === "up") m.choice = (m.choice + n - 1) % n;
    else if (key.kind === "down") m.choice = (m.choice + 1) % n;
    else if (key.kind === "enter") this.choose(m.choice);
    else if (key.kind === "click") {
      // A click on a value picks it; anywhere else closes the menu.
      const { top, left, width, height } = this.menuArea,
        i = key.y - top - 1;
      if (key.x > left && key.x < left + width - 1 && i >= 0 && i < Math.min(n, height - 2)) this.choose(i);
      else this.menu = null;
    }
  }
  private drawPicker(cols: number, rows: number, at: (y: number, x: number) => string): string {
    const p = this.picker!,
      lines = p.loading
        ? ["Listing microphones…"]
        : p.devices.map(
            (d, i) =>
              `${i === p.choice ? "❯" : " "} ${d.label.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}${d.default ? "  (default)" : ""}`,
          ),
      width = Math.min(cols - 4, Math.max(36, ...lines.map(l => displayWidth(l) + 4))),
      height = Math.min(rows - 4, lines.length + (p.notice ? 5 : 4)),
      left = Math.floor((cols - width) / 2),
      top = Math.floor((rows - height) / 2);
    let out = box(at, top, left, width, height, "Microphone");
    // The list scrolls so the chosen device stays in view.
    const visible = height - 3,
      first = p.loading ? 0 : Math.max(0, p.choice - visible + 1);
    lines.slice(first, first + visible).forEach((l, i) => {
      const chosen = !p.loading && first + i === p.choice;
      out += at(top + 1 + i, left + 2) + (chosen ? focused : text) + ellipsis(l, width - 4) + reset;
    });
    if (p.notice) out += at(top + height - 3, left + 2) + warm + ellipsis(p.notice, width - 4) + reset;
    out += at(top + height - 2, left + 2) + quiet + ellipsis("↑↓ choose  enter switch  esc close", width - 4) + reset;
    return out;
  }
  input(data: string, rows = process.stdout.rows || 24): void {
    for (const key of keys(data)) this.key(key, rows);
  }
  key(key: Key, rows = 24): void {
    if (this.picker) return this.pickerKey(key);
    if (this.menu) return this.menuKey(key);
    if (this.help) return this.helpKey(key);
    const page = Math.max(1, rows - history_top - 3),
      back = (n: number) => void (this.scroll = Math.max(0, this.scroll + n));
    switch (key.kind) {
      case "cancel":
        return this.opts.quit();
      case "pageup":
        return back(page);
      case "pagedown":
        return back(-page);
      case "up":
        return back(1);
      case "down":
        return back(-1);
      case "ctrl":
        // As in vi: half pages with u/d, whole ones with b/f.
        if (key.key === "u") return back(Math.ceil(page / 2));
        if (key.key === "d") return back(-Math.ceil(page / 2));
        if (key.key === "b") return back(page);
        if (key.key === "f") return back(-page);
        return;
      case "click":
        return this.hits.find(h => key.y === h.y && key.x >= h.x && key.x < h.x + h.width)?.act();
      case "wheel":
        return this.nudge(key.dir);
      case "text":
        switch (key.text) {
          case "q":
            return this.opts.quit();
          case "m":
            return this.session.setMuted(!this.session.muted);
          case "+":
          case "=":
            return this.nudge(1);
          case "-":
          case "_":
            return this.nudge(-1);
          case "d":
            return this.openPicker();
          case "k":
            return back(1);
          case "j":
            return back(-1);
          case "g":
            // The oldest; drawing clamps it.
            return back(Number.MAX_SAFE_INTEGER);
          case "G":
            return void (this.scroll = 0);
          case "f":
            return void this.switchFilter();
          case "?":
            return void (this.help = { scroll: 0 });
        }
    }
  }
  private async switchFilter(): Promise<void> {
    if (this.filter === "switching…" || this.filter === "not installed") return;
    this.filter = "switching…";
    this.filter = await this.opts.toggleFilter();
  }
  private nudge(dir: 1 | -1): void {
    this.threshold = level.step(this.threshold, dir);
    this.opts.setThreshold(this.threshold);
  }
  private openPicker(): void {
    const picker: Picker = { devices: [], choice: 0, loading: true };
    this.picker = picker;
    void this.opts.listDevices().then(
      ({ devices, notice }) => {
        Object.assign(picker, { devices, notice, loading: false });
        picker.choice = Math.max(
          0,
          devices.findIndex(d => (this.device === "(default)" ? d.default : d.label === this.device)),
        );
      },
      () => Object.assign(picker, { loading: false, notice: "Could not list microphones" }),
    );
  }
  private pickerKey(key: Key): void {
    const p = this.picker!;
    if (key.kind === "esc" || key.kind === "cancel" || (key.kind === "text" && key.text === "q")) this.picker = null;
    else if (p.loading || !p.devices.length) return;
    else if (key.kind === "up") p.choice = (p.choice + p.devices.length - 1) % p.devices.length;
    else if (key.kind === "down") p.choice = (p.choice + 1) % p.devices.length;
    else if (key.kind === "enter") {
      const device = p.devices[p.choice];
      this.picker = null;
      this.device = device.default ? "(default)" : device.label;
      this.opts.switchDevice(device);
    }
  }
}

const enter = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[2J",
  leave = "\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l",
  hide = Buffer.from("\x1b[?25l");

/** Runs `ui` in this process's terminal until `stop` resolves, then restores
 * the terminal. A signal restores it and runs `cleanup`; Ctrl+C itself is a
 * key in raw mode, so SIGINT only comes from elsewhere. */
export async function run(ui: VoiceUi, stop: Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  let { cols, rows } = size(),
    differ = Differ.create(cols, rows);
  // Each change hides the cursor again: a host terminal that lost the mode
  // would otherwise show it after the last key in the footer.
  const paint = () => {
    const out = differ.diff(ui.draw(cols, rows));
    if (out.length) process.stdout.write(Buffer.concat([out, hide]));
  };
  // A read can end inside a key's bytes: the rest waits for the next read,
  // or a moment, since a lone Escape is a key too.
  let partial = "",
    flush: ReturnType<typeof setTimeout> | undefined;
  const feed = (data: string) => {
    clearTimeout(flush);
    const text = partial + data,
      cut = incomplete(text);
    partial = text.slice(cut);
    ui.input(text.slice(0, cut), rows);
    if (partial)
      flush = setTimeout(() => {
        const held = partial;
        partial = "";
        ui.input(held, rows);
        paint();
      }, esc_ms);
    paint();
  };
  const onData = (data: Buffer) => feed(data.toString("latin1"));
  const onResize = () => {
    ({ cols, rows } = size());
    differ.destroy();
    differ = Differ.create(cols, rows);
    process.stdout.write("\x1b[2J");
    paint();
  };
  const restore = () => {
    clearInterval(timer);
    clearTimeout(flush);
    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    try {
      process.stdout.write(leave);
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    differ.destroy();
    closeReadiness();
  };
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const,
    onSignal = () => {
      restore();
      void cleanup().finally(() => process.exit(1));
    };
  for (const signal of signals) process.on(signal, onSignal);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  process.stdout.write(enter);
  // 20 Hz, the meter's rate.
  const timer = setInterval(paint, 50);
  paint();
  try {
    await stop;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    restore();
  }
}
