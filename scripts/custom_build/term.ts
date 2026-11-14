/** Terminal output for the tool's views: colors, hyperlinks and aligned tables.
 * Colors and links are only written to a terminal (`color`); piped output stays plain. */
import type { Stage } from "./live_events";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};
export type Tone = Exclude<keyof typeof ansi, "reset"> | null;
/** One table cell: its plain text, a color, and a link target. */
export type Cell = { text: string; tone?: Tone; url?: string | null };

export function paint(text: string, tone: Tone | undefined, color: boolean): string {
  return color && tone ? `${ansi[tone]}${text}${ansi.reset}` : text;
}

/** `#rrggbb` as its three channels; anything else is gray. */
function channels(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}
/** The color `t` of the way from `from` to `to` (0 to 1), as `#rrggbb`. */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from),
    b = channels(to),
    at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return `#${a
    .map((v, i) =>
      Math.round(v + (b[i] - v) * at)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `text` in a 24-bit color. */
export function rgb(text: string, hex: string, color: boolean): string {
  if (!color || !text) return text;
  const [r, g, b] = channels(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}${ansi.reset}`;
}

/** `text` with its color going from `from` to `to`, one step per grapheme. */
export function gradient(text: string, from: string, to: string, color: boolean): string {
  if (!color || !text) return text;
  const parts = [...new Intl.Segmenter().segment(text)].map(s => s.segment),
    steps = Math.max(1, parts.length - 1);
  return (
    parts
      .map((part, i) => {
        const [r, g, b] = channels(mix(from, to, i / steps));
        return `\x1b[38;2;${r};${g};${b}m${part}`;
      })
      .join("") + ansi.reset
  );
}

/** The colors the tool's name goes through in every view's title: the live
 * view, `list` and `status`. */
export const titleGradient: [string, string] = ["#7dcfff", "#bb9af7"];
/** The tool's name as the views' titles show it. */
export const title = (color: boolean): string => gradient("custom-build", ...titleGradient, color);

/** Each stage's color in the live view; merge goes on to `stageGradient`'s end. */
export const stageColor: Record<Stage, string> = {
  fetch: "#7dcfff",
  rebase: "#7aa2f7",
  merge: "#9ece6a",
  verify: "#e0af68",
  "after-build": "#73daca",
  push: "#7dcfff",
};
/** The stages drawn as a gradient: merge goes from green to violet. */
export const stageGradient: Partial<Record<Stage, [string, string]>> = { merge: ["#9ece6a", "#bb9af7"] };

/** `text` as an OSC 8 hyperlink, which terminals like Ghostty, iTerm2, WezTerm
 * and kitty make clickable (often with Cmd or Ctrl held) and others show as
 * plain text. It is underlined, so a link looks like one; a reset inside the
 * text keeps the underline. */
export function link(text: string, url: string | null | undefined, on: boolean): string {
  if (!on || !url) return text;
  const underlined = `\x1b[4m${text.replaceAll(ansi.reset, `${ansi.reset}\x1b[4m`)}\x1b[24m`;
  return `\x1b]8;;${url}\x1b\\${underlined}\x1b]8;;\x1b\\`;
}

/** How narrow the last column may get before it stops being cut to fit. */
const minLast = 12;

/** The cells `text` takes on screen: wide characters count two, combining
 * marks none. The tool can't use `src/text.ts`'s `displayWidth`, which needs
 * the native library: a stopped run runs a copy of the tool without the
 * source tree, and `status` works before any build. */
export const width = (text: string): number => Bun.stringWidth(text);

/** `text` cut to at most `room` cells, ending in `…` when cut. */
export function fit(text: string, room: number): string {
  if (width(text) <= room) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (width(out + segment) > room - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** Aligned rows under a dim header. Widths come from the plain text, so colors
 * and links never shift a column. With `columns` (the terminal's width) the
 * last column is cut with `…` to fit. */
export function table(
  header: string[],
  rows: Cell[][],
  o: { color: boolean; columns?: number; gap?: number },
): string[] {
  const gap = o.gap ?? 3,
    all: Cell[][] = [header.map(text => ({ text, tone: "dim" as Tone })), ...rows],
    widths = header.slice(0, -1).map((_, i) => Math.max(...all.map(row => width(row[i]?.text ?? ""))) + gap),
    room = o.columns ? Math.max(minLast, o.columns - widths.reduce((a, b) => a + b, 0)) : Infinity;
  const show = (c: Cell, cells?: number) => {
    const text = cells === undefined ? fit(c.text, room) : c.text;
    return (
      paint(link(text, c.url, o.color), c.tone, o.color) +
      (cells === undefined ? "" : " ".repeat(Math.max(0, cells - width(text))))
    );
  };
  return all.map(row =>
    row
      .map((c, i) => show(c, widths[i]))
      .join("")
      .trimEnd(),
  );
}

/** Synchronized output (DEC mode 2026): the terminal shows what comes between
 * on and off at once, so a redrawn frame never flickers. */
export const sync = (on: boolean): string => (on ? "\x1b[?2026h" : "\x1b[?2026l");

/** Shows or hides the cursor. */
export const cursor = (show: boolean): string => (show ? "\x1b[?25h" : "\x1b[?25l");

/** Progress in the tab or dock (OSC 9;4): `on` with a percent, `error` for a
 * stop, `off` to clear it. */
export function tabProgress(state: "on" | "error" | "off", percent?: number): string {
  if (state === "off") return "\x1b]9;4;0;\x07";
  const n =
    percent === undefined || !Number.isFinite(percent) ? "" : String(Math.round(Math.min(100, Math.max(0, percent))));
  return `\x1b]9;4;${state === "on" ? 1 : 2};${n}\x07`;
}

/** A desktop notification (OSC 9). Control characters would end the sequence
 * early, so they are dropped and line breaks become spaces. */
export function notify(body: string): string {
  return `\x1b]9;${body.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "")}\x07`;
}

/** Limits scrolling to rows `top` to `bottom` (1-based); `bottom` null resets
 * it to the whole screen. Terminals move the cursor home after either. */
export function scrollRegion(top: number, bottom: number | null): string {
  return bottom === null ? "\x1b[r" : `\x1b[${top};${bottom}r`;
}

/** Puts the terminal back as the live view found it: cursor shown, tab
 * progress cleared, whole-screen scrolling, synchronized output ended. The
 * region reset sits between cursor save and restore, since it moves the
 * cursor home and the shell prompt would come up over the output. */
export function restore(): string {
  return cursor(true) + tabProgress("off") + `\x1b7${scrollRegion(1, null)}\x1b8` + sync(false);
}
