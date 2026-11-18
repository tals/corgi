//! Live information and replies from the terminal running Corgi.
import { Theme } from "./theme";
import type { Input } from "./terminal_input";
import * as corgi_badge from "./corgi_badge";
import * as host_clipboard from "./host_clipboard";
import * as frame_pacing from "./frame_pacing";
import type { Cell } from "./fork_hero";
import type { Colors } from "./terminal_palette";
import type { Rgb } from "./palette";
import type { RGB } from "./theme";
import * as errors from "./errors";
import { n, ptr } from "./native_ffi";
/** Samples for measuring terminal character widths, including joined sequences. */
const width_samples: { kind: string; text: string; sequence: boolean }[] = [
  { kind: "emoji", text: "👍", sequence: false },
  { kind: "text symbol", text: "⚠", sequence: false },
  { kind: "emoji presentation", text: "⚠️", sequence: true },
  { kind: "flag", text: "🇺🇸", sequence: true },
  { kind: "joined emoji", text: "👨‍👩‍👧", sequence: true },
  { kind: "combining accent", text: "e\u0301", sequence: false },
  { kind: "ambiguous width", text: "±", sequence: false },
  { kind: "corgi face", text: "ᴥ", sequence: false },
];

/** Synchronized output, grapheme clusters, focus events, SGR mouse,
 * bracketed paste and color scheme reports. */
const modes = [2026, 2027, 1004, 1006, 2004, 2031] as const;
/** XTGETTCAP names: Kitty's font queries and the styled underline. */
const caps = ["kitty-query-font_family", "kitty-query-font_size", "Smulx"] as const;
/** How long a query waits for the device attributes. */
const wait_ms = 5000;
/** Cursor-position replies share a keyboard encoding, so their late window is bounded. */
const late_ms = 10_000;
/** Unambiguous measurement replies remain replies after a query ends. */
const answer_shapes = [
  /^\x1b\[\?[\d;]*c$/,
  /^\x1b\[>[\d;]*c$/,
  /^\x1b\[\?\d+;\d+\$y$/,
  /^\x1b\[\?\d+u$/,
  /^\x1b\[[46];\d+;\d+t$/,
  /^\x1bP[01]\+r[0-9a-fA-F=]*\x1b\\$/,
];

const hex = (text: string) => Buffer.from(text).toString("hex");
const unhex = (text: string) => (/^([0-9a-f]{2})*$/i.test(text) ? Buffer.from(text, "hex").toString() : "");

const clipboard_prefix = host_clipboard.packet_prefix,
  version_prefix = "\x1bP>|",
  max_packet = 16 * 1024;
/** A sample and the number of columns the terminal used to draw it. */
export interface Width {
  kind: string;
  text: string;
  sequence: boolean;
  columns: number | null;
}
/** Parsed terminal measurements, independent of how callers display them. */
export interface Info {
  status: "idle" | "pending" | "done";
  /** Device attributes arrived, ending the query. */
  answered: boolean;
  da1: number[];
  da2: string;
  modes: Record<string, number>;
  keyboard: number | null;
  window: Cell | null;
  cell: Cell | null;
  capabilities: Record<string, string>;
  /** Columns occupied by each requested sample; null when unanswered. */
  widths: Width[];
  /** Original escape sequences, in arrival order. */
  replies: string[];
}
function information(): Info {
  return {
    status: "idle",
    answered: false,
    da1: [],
    da2: "",
    modes: {},
    keyboard: null,
    window: null,
    cell: null,
    capabilities: {},
    widths: [],
    replies: [],
  };
}

export interface Tmux {
  version: string;
  passthrough: string;
  clipboard: string;
  timed_out: boolean;
}
/** Terminal data shared with the viewer UI and daemon without report formatting. */
export interface Snapshot {
  source: "viewer" | "direct";
  name: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  pty: Pty | null;
  used: Cell | null;
  graphics: boolean;
  badge: corgi_badge.Mode;
  colors: Colors | null;
  tmux: Tmux | null;
  ssh: boolean;
  info: Info;
}

/** Live terminal state, updated only by complete input events. */
export class Probe {
  theme = new Theme();
  badge = new corgi_badge.State();
  /** Replies for viewer-owned images other than the badge. */
  graphics: string[] = [];
  clipboard = new host_clipboard.State();
  pacer = new frame_pacing.Pacer();
  info = information();
  private deadline = 0;
  private late_until = 0;
  private width_row = 0;
  private next_width = 0;
  size = new Size();
  changed = false;
  /** The terminal reported a new color scheme; its colors need asking again. */
  scheme_changed = false;
  /** Consume a host reply; all other events retain their original framing. */
  accept(input: Input, now = Date.now()): boolean {
    if (input.kind !== "sequence") return false;
    const sequence = Buffer.from(input.bytes).toString("latin1");
    if (sequence.startsWith(corgi_badge.reply_prefix) && sequence.endsWith("\x1b\\")) {
      if (!this.badge.accept(sequence) && this.graphics.length < 128) this.graphics.push(sequence);
      return true;
    }
    if (sequence.startsWith(clipboard_prefix)) {
      const length = sequence.endsWith("\x1b\\") ? 2 : sequence.endsWith("\x07") ? 1 : 0;
      const packet = sequence.slice(clipboard_prefix.length, -length);
      if (length && packet.length <= max_packet) this.clipboard.packet(packet, now);
      return true;
    }
    const mode = /^\x1b\[\?5522;(\d+)\$y$/.exec(sequence);
    if (mode) {
      const value = Number(mode[1]);
      this.clipboard.modeReport(value <= 255 ? value : 0, now);
      return true;
    }
    if (/^\x1b\[\?997;\d+n$/.test(sequence)) {
      this.scheme_changed = true;
      return true;
    }
    if (sequence.startsWith(version_prefix) && sequence.endsWith("\x1b\\")) {
      this.clipboard.terminalName(sequence.slice(version_prefix.length, -2));
      return true;
    }
    const sized = this.size.accept(sequence);
    if (this.acceptInfo(sequence, now) || sized) return true;
    if (sequence === frame_pacing.answer) {
      this.pacer.answered(now);
      return true;
    }
    if (sequence.startsWith("\x1b]")) {
      const length = sequence.endsWith("\x1b\\") ? 2 : sequence.endsWith("\x07") ? 1 : 0;
      if (length && this.theme.accept(sequence.slice(2, -length))) {
        this.changed = true;
        return true;
      }
    }
    return false;
  }
  tick(now = Date.now()): void {
    if (this.info.status === "pending" && now >= this.deadline) {
      this.info.status = "done";
      this.late_until = now + late_ms;
    }
  }

  /** Ask for terminal capabilities and each sample's width, finishing with DA1. */
  measure(rows: number | null, now = Date.now()): string {
    this.info = information();
    this.info.status = "pending";
    this.info.widths = width_samples.map(sample => ({ ...sample, columns: null }));
    this.deadline = now + wait_ms;
    this.late_until = 0;
    this.width_row = rows ?? 0;
    this.next_width = 0;
    const at = rows === null ? "\r" : `\x1b[${rows};1H`;
    return (
      "\x1b7" +
      width_samples.map(({ text }) => `${at}${text}\x1b[6n`).join("") +
      `${at}\x1b[2K\x1b8` +
      modes.map(mode => `\x1b[?${mode}$p`).join("") +
      "\x1b[?u" +
      caps.map(cap => `\x1bP+q${hex(cap)}\x1b\\`).join("") +
      "\x1b[c"
    );
  }
  private acceptInfo(sequence: string, now: number): boolean {
    if (this.info.status !== "pending") return this.dropLateInfo(sequence, now);
    const a = this.info;
    let m: RegExpExecArray | null;
    if ((m = /^\x1b\[\?([\d;]*)c$/.exec(sequence))) {
      a.da1 = m[1].split(";").filter(Boolean).map(Number);
      a.answered = true;
      a.status = "done";
    } else if ((m = /^\x1b\[>([\d;]*)c$/.exec(sequence))) a.da2 = m[1];
    else if ((m = /^\x1b\[\?(\d+);(\d+)\$y$/.exec(sequence))) a.modes[m[1]] = Number(m[2]);
    else if ((m = /^\x1b\[\?(\d+)u$/.exec(sequence))) a.keyboard = Number(m[1]);
    else if ((m = /^\x1b\[4;(\d+);(\d+)t$/.exec(sequence))) a.window = { width: Number(m[2]), height: Number(m[1]) };
    else if ((m = /^\x1b\[6;(\d+);(\d+)t$/.exec(sequence))) a.cell = { width: Number(m[2]), height: Number(m[1]) };
    // A modified F3 also reads as a position, but on the top row.
    else if (
      (m = /^\x1b\[(\d+);(\d+)R$/.exec(sequence)) &&
      (this.width_row === 0 || Number(m[1]) === this.width_row) &&
      this.next_width < a.widths.length
    )
      a.widths[this.next_width++].columns = Number(m[2]) - 1;
    else if ((m = /^\x1bP([01])\+r([0-9a-fA-F]*)(?:=([0-9a-fA-F]*))?\x1b\\$/.exec(sequence))) {
      if (m[1] === "1") a.capabilities[unhex(m[2])] = unhex(m[3] ?? "");
    } else return false;
    a.replies.push(sequence);
    return true;
  }
  /** Drain late replies without recording them or treating them as typed input. */
  private dropLateInfo(sequence: string, now: number): boolean {
    const position = /^\x1b\[(\d+);\d+R$/.exec(sequence);
    if (position) return now < this.late_until && this.width_row > 0 && Number(position[1]) === this.width_row;
    if (!answer_shapes.some(shape => shape.test(sequence))) return false;
    if (/^\x1b\[\?[\d;]*c$/.test(sequence)) this.late_until = 0;
    return true;
  }

  colors(): Colors | null {
    const { foreground, background, palette } = this.theme,
      rgb = (c: RGB | null): Rgb | null => (c ? [c.r, c.g, c.b] : null);
    if (!foreground || !background) return null;
    return { foreground: rgb(foreground)!, background: rgb(background)!, ansi: palette.map(rgb) };
  }
  async snapshot(
    context: Pick<Snapshot, "source" | "cols" | "rows" | "pty" | "used">,
    env: Record<string, string | undefined> = process.env,
  ): Promise<Snapshot> {
    return {
      ...context,
      name: this.clipboard.terminal.text(),
      env: Object.fromEntries(terminal_env.flatMap(k => (env[k] ? [[k, env[k]!]] : []))),
      graphics: this.badge.supports_kitty_graphics,
      badge: this.badge.mode(),
      colors: this.colors(),
      tmux: await tmuxOf(env),
      ssh: ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].some(k => !!env[k]),
      info: this.info,
    };
  }

  query(): string {
    return "\x1b]10;?\x1b\\\x1b]11;?\x1b\\" + Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x1b\\`).join("");
  }
}

/** The PTY's grid and pixel dimensions, before any defaults are applied. */
export interface Pty {
  cols: number;
  rows: number;
  width: number;
  height: number;
}

const size_query = "\x1b[14t\x1b[16t";

function valid(cell: Cell | null): cell is Cell {
  return cell !== null && validDimension(cell.width) && validDimension(cell.height);
}

function validDimension(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && n <= 1024;
}

function divided(p: Pty | null): Cell | null {
  if (!p || p.cols <= 0 || p.rows <= 0) return null;
  const cell = { width: Math.floor(p.width / p.cols), height: Math.floor(p.height / p.rows) };
  return valid(cell) ? cell : null;
}

export class Size {
  private previous: Pty | null = null;
  private asked = false;
  private cell: Cell | null = null;
  private window: Cell | null = null;

  /** Ask again after a resize, including a font change with the same grid. */
  update(pty: Pty | null, resized = false): string {
    if (
      this.asked &&
      !resized &&
      pty?.cols === this.previous?.cols &&
      pty?.rows === this.previous?.rows &&
      pty?.width === this.previous?.width &&
      pty?.height === this.previous?.height
    )
      return "";
    this.previous = pty === null ? null : { ...pty };
    this.asked = true;
    this.cell = this.window = null;
    return size_query;
  }

  accept(sequence: string): boolean {
    if (!this.asked) return false;
    const m = /^\x1b\[([46]);(\d+);(\d+)t$/.exec(sequence);
    if (!m) return false;
    const size = { width: Number(m[3]), height: Number(m[2]) };
    if (m[1] === "6") this.cell = size;
    else this.window = size;
    return true;
  }

  pixels(pty: Pty | null): Cell | null {
    if (valid(this.cell)) return this.cell;
    return divided(pty) ?? (this.window && pty ? divided({ ...pty, ...this.window }) : null);
  }
}

/** The variables that say which terminal this is and what sits between. */
const terminal_env = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMUX",
  "STY",
  "ZELLIJ",
  "SSH_CONNECTION",
  "SSH_TTY",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "VTE_VERSION",
  "WT_SESSION",
  "KONSOLE_VERSION",
];
/** tmux's version and the options that decide whether images and copies get through. */
async function tmuxOf(env: Record<string, string | undefined>): Promise<Tmux | null> {
  if (!env.TMUX) return null;
  const subprocess = await import("./subprocess");
  let timed_out = false;
  const run = async (args: string[]) => {
    try {
      const out = await subprocess.run(["tmux", ...args], { timeout_ms: wait_ms, max_output: 4096 });
      return out.ok() ? out.stdout.toString() : "";
    } catch (error) {
      if (errors.is(error, "TimedOut")) timed_out = true;
      return "";
    }
  };
  const [version, passthrough, clipboard] = await Promise.all([
    run(["-V"]),
    run(["show-options", "-gqv", "allow-passthrough"]),
    run(["show-options", "-gqv", "set-clipboard"]),
  ]);
  return { version, passthrough, clipboard, timed_out };
}

/** The PTY's window size before layout defaults are applied. */
export function pty(): Pty | null {
  const size = new Uint16Array(4);
  if (n.probe_winsize_pixels(0, ptr(size)) !== 0) return null;
  return { cols: size[0], rows: size[1], width: size[2], height: size[3] };
}
