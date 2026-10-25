//! Name dialogs and the one-line editor search fields share. Mirrors
//! name_dialog.zig: fields count the text in bytes, and the cursor is a byte
//! offset; the editing itself is a single-line text area's.
import { basename } from "node:path";
import * as palette from "./palette";
import { Style, keycap, fgRgb, bgRgb, mix, colors, selection } from "./palette";
export { selection } from "./palette";
import * as keys from "./keys";
import * as forkMotion from "./fork_motion";
import { milliTimestamp } from "./clock";
import { identify, shell } from "./launch/command";
import { adapter } from "./providers";
import { Writer, writeEllipsis, codepointWidth } from "./text";
import { TextArea, byte_edits, key_edits, type Edit } from "./text_area";

export type Target =
  | { pane: number }
  | { rename: number }
  | { workspace_name: number | null }
  | { agent_command: number }
  /** The conversation an agent pane shows, named in its agent's own records. */
  | { agent: number }
  /** The name a copy of an agent pane's conversation starts with. */
  | { fork: number }
  /** The shell new panes run, typed from the shell picker. */
  | { shell: null }
  /** The new-workspace dialog's folder field. */
  | { folder: null };
export const targetKind = (
  t: Target,
): "pane" | "rename" | "workspace_name" | "agent_command" | "agent" | "fork" | "shell" | "folder" =>
  Object.keys(t)[0] as any;
/** Whether names keep non-ASCII text, which the agents' own names carry. */
function unicodeTarget(t: Target): boolean {
  return "agent_command" in t || "agent" in t || "fork" in t || "folder" in t || "workspace_name" in t;
}
export type Result = "none" | "save" | "cancel";
/** The longest name, in bytes, outside launch commands. */
export const name_limit = 80;
const max_length = 2048;
/** C0 and C1 controls and DEL, which a folder's name may hold and the
 * terminal would act on. */
const controls = /[\x00-\x1f\x7f-\x9f]/g;
/** The columns `cp` takes in `t`'s field, where the controls it shows take one. */
function fieldWidth(t: Target, cp: number): number {
  return ("agent_command" in t && cp < 32) || ("folder" in t && (cp < 32 || (cp >= 127 && cp <= 159)))
    ? 1
    : codepointWidth(cp);
}
/** `text` with each control shown as "?", one column wide. */
export function printable(text: string): string {
  return text.replace(controls, "?");
}
/** Writes what field `d` shows from byte `offset` in `columns`, where the
 * cursor stands: its text in `plain` and its selection as every field shows
 * one, unless `selecting` is off. With `caret`, a field that draws its own
 * caret gets it as an inverted cell. Returns the caret's column. */
export function writeField(
  w: Writer,
  d: Dialog,
  offset: number,
  columns: number,
  plain: string,
  { caret = false, selecting = true } = {},
): number {
  const end = d.byteAtColumn(offset, columns),
    sel = selecting ? d.selection() : null,
    at = d.cursor,
    after = at < d.len ? at + sequenceLength(d.text[at]) : at,
    cuts = [offset, end, ...(sel ?? []), ...(caret ? [at, after] : [])]
      .filter(cut => cut >= offset && cut <= end)
      .sort((x, y) => x - y)
      .filter((cut, i, all) => i === 0 || cut !== all[i - 1]);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i],
      to = cuts[i + 1],
      chosen = sel !== null && from >= sel[0] && to <= sel[1];
    w.write((chosen ? selection : plain) + (caret && from === at ? "\x1b[7m" : "") + d.shown(from, to) + "\x1b[27m");
  }
  let column = 0;
  for (const ch of d.bytes(offset, Math.min(at, end))) column += fieldWidth(d.target, ch.codePointAt(0)!);
  if (caret && at >= end && column < columns) w.write(plain + "\x1b[7m \x1b[27m");
  return column;
}
/** The longest text, in bytes, a target takes. */
function limit(t: Target): number {
  return "agent_command" in t || "folder" in t ? max_length : name_limit;
}
export type Hit =
  | { tag: "none" }
  | { tag: "save" }
  | { tag: "clear" }
  | { tag: "cancel" }
  | { tag: "field"; field: number }
  /** Another of the dialog's own keys, by its place in the row. */
  | { tag: "key"; index: number };

function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}
function validUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export class Dialog {
  target: Target;
  /** What's typed: its text, caret and selection, edited as every text box is. */
  area = new TextArea("", false);
  failed = false;
  overflow = false;
  /** The fork card's hero. */
  hero: forkMotion.Hero = { glyphs: false, motion: null };
  /** A typed character's bytes until it is whole. */
  private partial: number[] = [];
  /** Empty, whether text filled in later starts selected, as a new dialog's does. */
  private empty_selected = true;
  /** Where a press in the field put the caret, so a drag selects from it. */
  private pressed_at: number | null = null;
  /** The text as UTF-8, as fields draw it, until the text changes. */
  private utf8 = { text: "", bytes: new Uint8Array() };
  private initial = "";

  constructor(target: Target) {
    this.target = target;
  }
  static init(target: Target, initial: string): Dialog {
    const d = new Dialog(target);
    d.fill(initial);
    d.selected = true;
    return d;
  }
  /** The text as UTF-8 bytes; offsets into it are what the fields count. */
  get text(): Uint8Array {
    if (this.utf8.text !== this.area.text) this.utf8 = { text: this.area.text, bytes: Buffer.from(this.area.text) };
    return this.utf8.bytes;
  }
  get len(): number {
    return this.text.length;
  }
  /** The caret, as a byte offset. */
  get cursor(): number {
    return Buffer.byteLength(this.area.text.slice(0, this.area.caret));
  }
  /** The whole text is selected, as a name starts: typing replaces it. */
  get selected(): boolean {
    if (this.area.text.length === 0) return this.empty_selected;
    const sel = this.area.selection();
    return sel !== null && sel[0] === 0 && sel[1] === this.area.text.length;
  }
  set selected(on: boolean) {
    this.empty_selected = on;
    if (on) this.area.apply("select_all");
    else this.area.anchor = null;
  }
  /** The selection as byte offsets, or null. */
  selection(): [number, number] | null {
    const sel = this.area.selection();
    return (
      sel && [Buffer.byteLength(this.area.text.slice(0, sel[0])), Buffer.byteLength(this.area.text.slice(0, sel[1]))]
    );
  }
  /** Replaces the text, keeping it wholly selected if it was. */
  protected fill(initial: string): void {
    const whole = this.selected;
    this.initial = initial;
    let text = unicodeTarget(this.target) ? initial : initial.replace(/[^\x20-\x7e]/gu, "_");
    while (Buffer.byteLength(text) > this.capacity()) text = [...text].slice(0, -1).join("");
    this.area = new TextArea(text, false);
    if (whole) this.selected = true;
  }
  private capacity(): number {
    // Folder-derived workspace names may exceed the limit for new names.
    return Math.max(limit(this.target), "workspace_name" in this.target ? Buffer.byteLength(this.initial) : 0);
  }
  /** The text as written, untrimmed. */
  raw(): string {
    return this.area.text;
  }
  bytes(from = 0, to = this.len): string {
    return Buffer.from(this.text.subarray(from, to)).toString();
  }
  name(): string {
    if ("workspace_name" in this.target && this.area.text === this.initial) return this.initial;
    const trim = "agent_command" in this.target ? " \t\r\n" : " ";
    let start = 0;
    let end = this.area.text.length;
    while (start < end && trim.includes(this.area.text[start])) start++;
    while (end > start && trim.includes(this.area.text[end - 1])) end--;
    return this.area.text.slice(start, end);
  }
  clear(): void {
    this.area = new TextArea("", false);
    this.partial = [];
    this.empty_selected = false;
    this.failed = false;
    this.overflow = false;
  }
  typeByte(byte: number): void {
    if (byte < 32 || byte === 127 || (byte >= 128 && !unicodeTarget(this.target))) return;
    if (byte < 128) {
      this.partial = [];
      return this.insert(String.fromCharCode(byte));
    }
    this.partial.push(byte);
    if (this.partial.length < sequenceLength(this.partial[0])) return;
    const bytes = Uint8Array.from(this.partial);
    this.partial = [];
    if (validUtf8(bytes)) this.insert(Buffer.from(bytes).toString());
  }
  pasteByte(byte: number): void {
    if ("agent_command" in this.target && (byte === 9 || byte === 13 || byte === 10))
      this.insert(String.fromCharCode(byte));
    else this.typeByte(byte);
  }
  private insert(text: string): void {
    const sel = this.selection() ?? [this.cursor, this.cursor];
    if (this.len - (sel[1] - sel[0]) + Buffer.byteLength(text) > this.capacity()) {
      this.overflow = true;
      return;
    }
    this.area.insert(text);
    this.failed = false;
  }
  /** Edits the text as every text box does. */
  edit(edit: Edit): void {
    this.area.apply(edit);
  }
  key(byte: number): Result {
    switch (byte) {
      case 27:
        return "cancel";
      case 13:
        return "save";
      case 3:
        this.clear();
        break;
      default: {
        const edit = byte_edits[byte];
        if (edit) this.edit(edit);
        else this.typeByte(byte);
      }
    }
    return "none";
  }
  /** Puts the caret at byte `cursor`, or the character it falls in. */
  position(cursor: number): void {
    let at = 0,
      used = 0;
    for (const ch of this.area.text) {
      const size = Buffer.byteLength(ch);
      if (used + size > cursor) break;
      used += size;
      at += ch.length;
    }
    this.area.anchor = null;
    this.area.caret = at;
  }
  byteAtColumn(start: number, columns: number): number {
    const text = this.text;
    let pos = start;
    let used = 0;
    while (pos < text.length) {
      const n = sequenceLength(text[pos]);
      if (pos + n > text.length) break;
      const piece = text.subarray(pos, pos + n);
      if (!validUtf8(piece)) break;
      const cp = Buffer.from(piece).toString().codePointAt(0)!;
      used += fieldWidth(this.target, cp);
      if (used > columns) break;
      pos += n;
    }
    return pos;
  }
  /** The text between bytes `from` and `to` as a field shows it: controls
   * as spaces, or as "?" for a folder. */
  shown(from: number, to: number): string {
    const s = this.bytes(from, to);
    return "folder" in this.target ? printable(s) : s.replace(/[\x00-\x1f\x7f]/g, " ");
  }
  sequence(seq: string): void {
    const key = keys.parse(seq),
      edit = key && key_edits[key];
    if (edit) this.edit(edit);
  }
  /** A view of its own, in place of the plain one; none by default. */
  view(_width: number, _height: number): View | null {
    return null;
  }
  /** A press at `x`, `y` in `v`: its keys save, cancel or clear, and its
   * field takes the cursor. */
  press(v: View, x: number, y: number, _now: number): Result {
    const found = v.hit(x, y);
    switch (found.tag) {
      case "save":
        return "save";
      case "cancel":
        return "cancel";
      case "clear":
        this.clear();
        break;
      case "field":
        this.position(this.byteAtColumn(v.offset, found.field - v.offset));
        this.pressed_at = this.area.caret;
        break;
      default:
        break;
    }
    return "none";
  }
  /** The pointer moved with the button down: after a press in the field, the
   * selection runs from there to the column under it. */
  drag(v: View, x: number): void {
    if (this.pressed_at === null) return;
    this.position(this.byteAtColumn(v.offset, Math.max(0, x - v.text_x)));
    this.area.anchor = this.pressed_at;
  }
  /** The mouse button let go. */
  release(_now: number): void {
    this.pressed_at = null;
  }
  /** Moves a dialog that animates on to `now`; "save" when it finishes by itself. */
  tick(_now: number): Result {
    return "none";
  }
  /** How often it wants frames while it moves, or null at rest. */
  frame(): number | null {
    return null;
  }
}

interface Card {
  hero_y: number | null;
  subtitle_y: number;
  label_y: number;
}
interface Button {
  x: number;
  width: number;
  label: string;
  padded: boolean;
}
/** A plain dialog's button: a keycap, and a label beside it when there is room. */
export interface Key {
  x: number;
  width: number;
  key: string;
  label: string;
  cap: boolean;
  hit: Hit;
  /** Each character on a cap of its own. */
  split: boolean;
}
export type KeySpec = { key: string; label: string; hit: Hit; split?: boolean };
/** The columns a key's caps take; a split key's stand a column apart. */
export const capped = (k: { key: string; split?: boolean }) => (k.split ? k.key.length * 4 - 1 : k.key.length + 2);
export const labelled = (k: { key: string; label: string; split?: boolean }) => capped(k) + 1 + k.label.length;
/** How many columns each fork card button's label takes. */
const card_label_widths = [13, 8, 10];
/** The fork card's call to action: a tint of the accent, not its full
 * strength, so it doesn't glare on the panel. */
let create_fill: string, create_label: string;
palette.derived(() => {
  create_fill = "\x1b[0m" + bgRgb(mix(colors.surface, colors.accent, 22));
  create_label = create_fill + "\x1b[1m" + fgRgb(colors.accent);
});
export class View {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  title_y = 0;
  field_y = 0;
  buttons_y = 0;
  offset = 0;
  /** Where the text starts and how many columns of it show; the field's
   * fill reaches one column past each side when `padded`. */
  text_x = 0;
  text_width = 0;
  padded = false;
  /** The first button forks instead of saving. */
  fork = false;
  /** The fork card's roomier rows, when the screen has space for them. */
  card: Card | null = null;

  static init(width: number, height: number, d: Dialog): View {
    if ("fork" in d.target) {
      const v = View.forkCard(width, height, d);
      if (v) return v;
    }
    const own = d.view(width, height);
    if (own) return own;
    const w = View.plainWidth(width);
    const h = Math.min(height, 7);
    const y = Math.floor((height - h) / 2);
    const field_y = y + (h >= 7 ? 3 : h >= 5 ? 2 : 1);
    const x = Math.floor((width - w) / 2);
    // A gutter inside the border, then a column of the field's fill
    // beside the text, when the dialog is wide enough for them.
    const padded = w >= 20;
    const inset = padded ? 3 : 1;
    const v = new View();
    Object.assign(v, {
      x,
      y,
      width: w,
      height: h,
      title_y: y + (h >= 5 ? 1 : 0),
      field_y,
      // A row apart from the field when there is one to spare.
      buttons_y: field_y + (h >= 7 ? 2 : 1),
      offset: View.scroll(d, w - 2 * inset),
      text_x: x + inset,
      text_width: w - 2 * inset,
      padded,
      fork: "fork" in d.target,
    });
    return v;
  }
  static plainWidth(width: number): number {
    return Math.min(
      width,
      Math.max(10, Math.max(Math.min(Math.max(0, width - 2), 36), Math.min(Math.floor((width * 3) / 5), 70))),
    );
  }
  /** The first byte that shows, keeping the cursor inside `columns`. */
  static scroll(d: Dialog, columns: number): number {
    let offset = Math.max(0, d.cursor - Math.max(0, columns - 1));
    while (offset < d.cursor && (d.text[offset] & 0xc0) === 0x80) offset += 1;
    return offset;
  }
  /** The fork card: a hero, a title and its subtitle, a labelled field and
   * the buttons, with room around each. Without space for the hero it
   * leaves it out; without space for the rest, the plain dialog is used. */
  static forkCard(width: number, height: number, d: Dialog): View | null {
    const w = Math.min(Math.max(0, width - 6), 72);
    const hero = height >= 21;
    const h = hero ? 19 : 15;
    if (w < 46 || height < h + 2) return null;
    const x = Math.floor((width - w) / 2);
    const y = Math.floor((height - h) / 2);
    const top = hero ? 6 : 2;
    const v = new View();
    Object.assign(v, {
      x,
      y,
      width: w,
      height: h,
      title_y: y + top,
      // The field and the buttons are three rows tall; these are their middles.
      field_y: y + top + 5,
      buttons_y: y + top + 9,
      offset: View.scroll(d, w - 10),
      text_x: x + 5,
      text_width: w - 10,
      padded: true,
      fork: true,
      card: { hero_y: hero ? y + 2 : null, subtitle_y: y + top + 1, label_y: y + top + 3 },
    });
    return v;
  }
  /** The fork card's buttons, centered: the call to action, clear and
   * cancel, each padded as wide as the card allows. */
  cardButtons(): Button[] {
    const labels = ["↵ Create Fork", "^C Clear", "esc Cancel"];
    const lengths = card_label_widths;
    const gap = 2;
    const inner = this.width - 2;
    let pad = 3;
    while (pad > 1 && lengths[0] + lengths[1] + lengths[2] + 6 * pad + 2 * gap > inner) pad -= 1;
    const total = lengths[0] + lengths[1] + lengths[2] + 6 * pad + 2 * gap;
    let x = this.x + 1 + Math.floor(Math.max(0, inner - total) / 2);
    return labels.map((label, i) => {
      const button = { x, width: lengths[i] + 2 * pad, label, padded: true };
      x += lengths[i] + 2 * pad + gap;
      return button;
    });
  }
  /** Keycaps with their labels, like the launcher's footer; narrower
   * dialogs keep only the caps, and the narrowest only the keys. */
  buttons(): Key[] {
    const inner = this.width - 2;
    const keys = this.keys();
    // The keys are one column a character.
    const span = (width: (k: KeySpec) => number, gap: number) =>
      keys.reduce((n, k) => n + width(k), 0) + gap * (keys.length - 1);
    const full = span(labelled, 1) <= inner;
    const caps = span(capped, 1) <= inner;
    const gap = span(labelled, 2) + 2 <= inner ? 2 : 1;
    const widths = keys.map(k => (full ? labelled(k) : caps ? capped(k) : k.key.length));
    let x =
      this.x + 1 + Math.floor(Math.max(0, inner - widths.reduce((n, w) => n + w, 0) - gap * (keys.length - 1)) / 2);
    return keys.map((k, i) => {
      const result = {
        x,
        width: widths[i],
        key: k.key,
        label: full ? k.label : "",
        cap: caps,
        hit: k.hit,
        split: k.split === true,
      };
      x += widths[i] + gap;
      return result;
    });
  }
  /** The keys along the bottom. */
  protected keys(): KeySpec[] {
    return [
      { key: "↵", label: this.fork ? "fork" : "save", hit: { tag: "save" } },
      { key: "^C", label: "clear", hit: { tag: "clear" } },
      { key: "esc", label: "cancel", hit: { tag: "cancel" } },
    ];
  }
  hit(x: number, y: number): Hit {
    const v = this;
    if (x < v.x || x >= v.x + v.width || y < v.y || y >= v.y + v.height) return { tag: "cancel" };
    if (v.card !== null) {
      // The field and the buttons are three rows tall, padded around.
      if (y + 1 >= v.field_y && y <= v.field_y + 1 && x + 2 >= v.text_x && x < v.text_x + v.text_width + 2)
        return { tag: "field", field: v.offset + Math.max(0, x - v.text_x) };
      if (y + 1 >= v.buttons_y && y <= v.buttons_y + 1) {
        const buttons = v.cardButtons();
        for (let i = 0; i < buttons.length; i++) {
          const b = buttons[i];
          if (x >= b.x && x < b.x + b.width)
            return i === 0 ? { tag: "save" } : i === 1 ? { tag: "clear" } : { tag: "cancel" };
        }
      }
      return { tag: "none" };
    }
    // The field's fill beside the text answers too.
    const fill = v.padded ? 1 : 0;
    const across = x + fill >= v.text_x && x < v.text_x + v.text_width + fill;
    const column = Math.min(Math.max(0, x - v.text_x), v.text_width);
    if (y === v.field_y && across) return { tag: "field", field: v.offset + column };
    if (y === v.buttons_y) for (const b of v.buttons()) if (x >= b.x && x < b.x + b.width) return b.hit;
    return { tag: "none" };
  }
  /** Drawn like the launcher and the menus: a rounded box on `surface`, a
   * gutter inside it, the field inset on `selected`, and keycap buttons. */
  draw(d: Dialog, w: Writer, number: number): void {
    const v = this;
    if (v.card) return v.drawCard(v.card, d, w);
    v.drawBox(w);
    v.heading(d, w, number);
    v.drawButtons(w);
    v.placeCursor(d, w);
  }
  protected drawBox(w: Writer): void {
    const v = this;
    const panel = new Style({ fg: "text", bg: "surface" }).sgr();
    const border = new Style({ fg: "line", bg: "surface" }).sgr();
    for (let row = 0; row < v.height; row++) {
      w.write(`\x1b[${v.y + row + 1};${v.x + 1}H${border}`);
      if (row === 0 || row + 1 === v.height) {
        w.write(row === 0 ? "╭" : "╰");
        w.write("─".repeat(v.width - 2));
        w.write(row === 0 ? "╮" : "╯");
      } else {
        w.write("│" + panel);
        w.splat(" ", v.width - 2);
        w.write(border + "│");
      }
    }
  }
  /** The title, a line about it, and the field. Returns where text starts,
   * lined up with the field's fill, and the columns it has. */
  protected heading(d: Dialog, w: Writer, number: number): { left: number; room: number } {
    const v = this;
    const kind = targetKind(d.target);
    const title =
      kind === "agent_command"
        ? "Agent launch command"
        : kind === "rename"
          ? "Rename tab"
          : kind === "pane"
            ? "Rename pane"
            : kind === "agent"
              ? "Rename agent"
              : kind === "fork"
                ? "Fork this agent"
                : kind === "shell"
                  ? "Shell for new panes"
                  : (d.target as { workspace_name: number | null }).workspace_name === null
                    ? "New workspace"
                    : "Rename workspace";
    const left = v.text_x - (v.padded ? 1 : 0);
    const room = v.x + v.width - 1 - left - (v.padded ? 1 : 0);
    w.write(
      `\x1b[${v.title_y + 1};${left + 1}H` +
        new Style({ fg: "strong", bg: "surface", bold: true }).sgr() +
        title.slice(0, Math.min(title.length, room)),
    );
    if ((d.failed || d.overflow) && v.height >= 7) {
      const msg =
        kind === "agent_command"
          ? "Could not save command; max 2048 bytes."
          : kind === "workspace_name" && d.len === 0
            ? "Enter a workspace name."
            : kind === "shell"
              ? "No executable shell there."
              : "Could not save. Check folder or capacity.";
      w.write(
        `\x1b[${v.title_y + 2};${left + 1}H` +
          new Style({ fg: "hot", bg: "surface" }).sgr() +
          msg.slice(0, Math.min(msg.length, room)),
      );
    }
    if (kind === "shell" && !d.failed && !d.overflow && v.height >= 7) {
      w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, "A path or a name on PATH; empty uses the default", room);
    }
    if (kind === "agent_command" && !d.failed && !d.overflow && v.height >= 7) {
      const provider = identify(d.name());
      const text = `${basename(shell())} · ${provider ? adapter(provider).name : "resolved at launch"} · empty saves delete`;
      w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, text, room);
    }
    w.write(`\x1b[${v.field_y + 1};${left + 1}H` + new Style({ fg: "text", bg: "selected" }).sgr());
    w.splat(" ", v.text_width + 2 * (v.padded ? 1 : 0));
    w.write(`\x1b[${v.field_y + 1};${v.text_x + 1}H`);
    if (d.len === 0 && kind === "rename") {
      // This is a preview of the current position, never an editable/saved name.
      w.write(palette.fg("muted") + `${number}`);
    } else {
      writeField(w, d, v.offset, v.text_width, new Style({ fg: "text", bg: "selected" }).sgr());
    }
    return { left, room };
  }
  /** How key `i` draws: its cap, its label, and the key alone without room for caps.
   * The first key saves; its label is the one that stands out. */
  protected look(_b: Key, i: number): { cap: string; label: string; bare: string } {
    const strong = new Style({ fg: "strong", bg: "surface", bold: true }).sgr();
    return { cap: keycap, label: i === 0 ? strong : new Style({ fg: "muted", bg: "surface" }).sgr(), bare: strong };
  }
  protected drawButtons(w: Writer): void {
    const v = this;
    v.buttons().forEach((b, i) => {
      const look = v.look(b, i);
      w.write(`\x1b[${v.buttons_y + 1};${b.x + 1}H`);
      if (!b.cap) {
        // Too narrow for caps: the bare key.
        w.write(look.bare + b.key);
        return;
      }
      if (b.split)
        w.write([...b.key].map(ch => `${look.cap} ${ch} `).join(new Style({ fg: "text", bg: "surface" }).sgr() + " "));
      else w.write(look.cap + ` ${b.key} `);
      if (b.label.length > 0) w.write(`${look.label} ${b.label}`);
    });
  }
  protected placeCursor(d: Dialog, w: Writer, offset = this.offset, y = this.field_y): void {
    let cursor_width = 0;
    for (const ch of d.bytes(offset, d.cursor)) {
      const cp = ch.codePointAt(0)!;
      cursor_width += fieldWidth(d.target, cp);
    }
    w.write(`\x1b[0m\x1b[${y + 1};${this.text_x + 1 + cursor_width}H\x1b[?25h`);
  }
  private drawCard(card: Card, d: Dialog, w: Writer): void {
    const v = this;
    v.drawBox(w);
    if (card.hero_y !== null)
      w.write(
        forkMotion.draw(v.x + Math.floor((v.width - forkMotion.width) / 2), card.hero_y, d.hero, milliTimestamp()),
      );
    v.centered(w, v.title_y, new Style({ fg: "strong", bg: "surface", bold: true }).sgr(), "Fork this agent");
    if (d.overflow)
      v.centered(w, card.subtitle_y, new Style({ fg: "hot", bg: "surface" }).sgr(), "Names fit in 80 characters");
    else
      v.centered(
        w,
        card.subtitle_y,
        new Style({ fg: "muted", bg: "surface" }).sgr(),
        "Copies the conversation into a new tab",
      );
    w.write(`\x1b[${card.label_y + 1};${v.text_x - 1}H` + new Style({ fg: "faint", bg: "surface" }).sgr() + "Name");
    // A field three rows tall, with two columns of fill beside the text.
    for (let row = 0; row < 3; row++) {
      w.write(`\x1b[${v.field_y + row};${v.text_x - 1}H` + new Style({ fg: "text", bg: "selected" }).sgr());
      w.splat(" ", v.text_width + 4);
    }
    w.write(`\x1b[${v.field_y + 1};${v.text_x + 1}H`);
    writeField(w, d, v.offset, v.text_width, new Style({ fg: "text", bg: "selected" }).sgr());
    v.cardButtons().forEach((b, i) => {
      const fill = i === 0 ? create_fill : new Style({ bg: "selected" }).sgr();
      for (let row = 0; row < 3; row++) {
        w.write(`\x1b[${v.buttons_y + row};${b.x + 1}H${fill}`);
        w.splat(" ", b.width);
      }
      const key_end = b.label.indexOf(" ");
      const pad = Math.floor((b.width - card_label_widths[i]) / 2);
      w.write(`\x1b[${v.buttons_y + 1};${b.x + 1 + pad}H`);
      if (i === 0) w.write(create_label + "↵ Create Fork");
      else
        w.write(
          new Style({ fg: "muted", bg: "selected" }).sgr() +
            b.label.slice(0, key_end) +
            new Style({ fg: "text", bg: "selected", bold: true }).sgr() +
            b.label.slice(key_end),
        );
    });
    v.placeCursor(d, w);
  }
  /** `text`, ASCII, centered on row `y`. */
  private centered(w: Writer, y: number, style: string, text: string): void {
    const shown = text.slice(0, Math.min(text.length, this.width - 4));
    w.write(`\x1b[${y + 1};${this.x + Math.floor((this.width - shown.length) / 2) + 1}H${style}${shown}`);
  }
}
