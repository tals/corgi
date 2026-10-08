//! Name dialogs and the one-line editor search fields share. Mirrors
//! name_dialog.zig: the text is bytes, and the cursor a byte offset.
import { basename } from "node:path";
import * as palette from "./palette";
import { Style, keycap, fgRgb, bgRgb, mix, colors } from "./palette";
import * as keys from "./keys";
import * as forkMotion from "./fork_motion";
import { milliTimestamp } from "./clock";
import { identify, shell } from "./launch/command";
import { Writer, writeEllipsis, codepointWidth } from "./text";

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
  | { shell: null };
export const targetKind = (
  t: Target,
): "pane" | "rename" | "workspace_name" | "agent_command" | "agent" | "fork" | "shell" => Object.keys(t)[0] as any;
/** Whether names keep non-ASCII text, which the agents' own names carry. */
function unicodeTarget(t: Target): boolean {
  return "agent_command" in t || "agent" in t || "fork" in t;
}
export type Result = "none" | "save" | "cancel";
/** The longest name, in bytes, outside launch commands. */
export const name_limit = 80;
const max_length = 2048;
const capacity = 4096;
export type Hit =
  { tag: "none" } | { tag: "save" } | { tag: "clear" } | { tag: "cancel" } | { tag: "field"; field: number };

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
  text = new Uint8Array(capacity);
  len = 0;
  cursor = 0;
  selected = true;
  failed = false;
  overflow = false;
  /** The fork card's hero. */
  hero: forkMotion.Hero = { glyphs: false, motion: null };

  constructor(target: Target) {
    this.target = target;
  }
  static init(target: Target, initial: string): Dialog {
    const d = new Dialog(target);
    const source = Buffer.from(initial);
    d.len = Math.min(source.length, "agent_command" in target ? max_length : name_limit);
    for (let i = 0; i < d.len; i++) {
      const ch = source[i];
      d.text[i] = unicodeTarget(target) || (ch >= 32 && ch < 127) ? ch : "_".charCodeAt(0);
    }
    while (d.len > 0 && !validUtf8(d.text.subarray(0, d.len))) d.len -= 1;
    d.cursor = d.len;
    return d;
  }
  clone(): Dialog {
    const d = new Dialog(this.target);
    d.text = this.text.slice();
    d.len = this.len;
    d.cursor = this.cursor;
    d.selected = this.selected;
    d.failed = this.failed;
    d.overflow = this.overflow;
    d.hero = { ...this.hero };
    return d;
  }
  /** The text as written, untrimmed. */
  raw(): string {
    return Buffer.from(this.text.subarray(0, this.len)).toString();
  }
  bytes(from = 0, to = this.len): string {
    return Buffer.from(this.text.subarray(from, to)).toString();
  }
  name(): string {
    const trim = "agent_command" in this.target ? " \t\r\n" : " ";
    let start = 0;
    let end = this.len;
    while (start < end && trim.includes(String.fromCharCode(this.text[start]))) start++;
    while (end > start && trim.includes(String.fromCharCode(this.text[end - 1]))) end--;
    return this.bytes(start, end);
  }
  clear(): void {
    this.len = 0;
    this.cursor = 0;
    this.selected = false;
    this.failed = false;
    this.overflow = false;
  }
  typeByte(byte: number): void {
    if (byte < 32 || (byte >= 127 && !unicodeTarget(this.target))) return;
    this.insert([byte]);
  }
  pasteByte(byte: number): void {
    if ("agent_command" in this.target && (byte === 9 || byte === 13 || byte === 10)) this.insert([byte]);
    else this.typeByte(byte);
  }
  private insert(bytes: number[]): void {
    if (this.selected) this.clear();
    const limit = "agent_command" in this.target ? max_length : name_limit;
    if (this.len + bytes.length > limit) {
      this.overflow = true;
      return;
    }
    this.text.copyWithin(this.cursor + bytes.length, this.cursor, this.len);
    this.text.set(bytes, this.cursor);
    this.len += bytes.length;
    this.cursor += bytes.length;
    this.failed = false;
  }
  key(byte: number): Result {
    switch (byte) {
      case 27:
        return "cancel";
      case 13:
        return "save";
      case 3:
      case 21:
        this.clear();
        break;
      case 1:
        this.position(0);
        break;
      case 5:
        this.position(this.len);
        break;
      case 8:
      case 127:
        if (this.selected) this.clear();
        else if (this.cursor > 0) {
          const previous_pos = this.previous();
          const count = this.cursor - previous_pos;
          this.text.copyWithin(previous_pos, this.cursor, this.len);
          this.cursor = previous_pos;
          this.len -= count;
        }
        break;
      default:
        this.typeByte(byte);
    }
    return "none";
  }
  position(cursor: number): void {
    this.cursor = Math.min(cursor, this.len);
    while (this.cursor > 0 && this.cursor < this.len && (this.text[this.cursor] & 0xc0) === 0x80) this.cursor -= 1;
    this.selected = false;
  }
  private previous(): number {
    let pos = this.cursor > 0 ? this.cursor - 1 : 0;
    while (pos > 0 && (this.text[pos] & 0xc0) === 0x80) pos -= 1;
    return pos;
  }
  private next(): number {
    if (this.cursor >= this.len) return this.len;
    return Math.min(this.len, this.cursor + sequenceLength(this.text[this.cursor]));
  }
  byteAtColumn(start: number, columns: number): number {
    let pos = start;
    let used = 0;
    while (pos < this.len) {
      const n = sequenceLength(this.text[pos]);
      if (pos + n > this.len) break;
      const piece = this.text.subarray(pos, pos + n);
      if (!validUtf8(piece)) break;
      const cp = Buffer.from(piece).toString().codePointAt(0)!;
      used += "agent_command" in this.target && cp < 32 ? 1 : codepointWidth(cp);
      if (used > columns) break;
      pos += n;
    }
    return pos;
  }
  sequence(seq: string): void {
    switch (keys.parse(seq)) {
      case "left":
        this.position(this.selected ? 0 : this.previous());
        break;
      case "right":
        this.position(this.selected ? this.len : this.next());
        break;
      case "home":
        this.position(0);
        break;
      case "end":
        this.position(this.len);
        break;
      case "delete":
        if (this.selected) this.clear();
        else if (this.cursor < this.len) {
          const next_pos = this.next();
          const count = next_pos - this.cursor;
          this.text.copyWithin(this.cursor, next_pos, this.len);
          this.len -= count;
        }
        break;
      default:
        break;
    }
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
interface Key {
  x: number;
  width: number;
  key: string;
  label: string;
  cap: boolean;
}
/** How many columns each fork card button's label takes. */
const card_label_widths = [13, 8, 10];
/** The fork card's selected name and call to action: tints of the accent, not
 * its full strength, so neither glares on the panel. */
export const selection = fgRgb(colors.strong) + bgRgb(mix(colors.selected, colors.accent, 30));
const create_fill = "\x1b[0m" + bgRgb(mix(colors.surface, colors.accent, 22));
const create_label = create_fill + "\x1b[1m" + fgRgb(colors.accent);

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
    const w = Math.min(
      width,
      Math.max(10, Math.max(Math.min(Math.max(0, width - 2), 36), Math.min(Math.floor((width * 3) / 5), 70))),
    );
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
    const names = ["↵", "^C", "esc"];
    const labels = [this.fork ? "fork" : "save", "clear", "cancel"];
    // The columns each key takes, without its cap's spaces.
    const key_widths = [1, 2, 3];
    const full = inner >= 32;
    const caps = inner >= 14;
    const gap = inner >= 36 ? 2 : 1;
    const widths = key_widths.map((key, i) => (full ? key + 3 + labels[i].length : caps ? key + 2 : key));
    let x = this.x + 1 + Math.floor(Math.max(0, inner - (widths[0] + widths[1] + widths[2] + 2 * gap)) / 2);
    return names.map((key, i) => {
      const result = { x, width: widths[i], key, label: full ? labels[i] : "", cap: caps };
      x += widths[i] + gap;
      return result;
    });
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
    if (y === v.field_y && x + fill >= v.text_x && x < v.text_x + v.text_width + fill)
      return { tag: "field", field: v.offset + Math.min(Math.max(0, x - v.text_x), v.text_width) };
    if (y === v.buttons_y) {
      const buttons = v.buttons();
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        if (x >= b.x && x < b.x + b.width)
          return i === 0 ? { tag: "save" } : i === 1 ? { tag: "clear" } : { tag: "cancel" };
      }
    }
    return { tag: "none" };
  }
  /** Drawn like the launcher and the menus: a rounded box on `surface`, a
   * gutter inside it, the field inset on `selected`, and keycap buttons. */
  draw(d: Dialog, w: Writer, number: number): void {
    const v = this;
    if (v.card) return v.drawCard(v.card, d, w);
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
    // Text lines up with the field's fill.
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
      const text = `${basename(shell())} · ${provider ?? "resolved at launch"} · empty saves delete`;
      w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, text, room);
    }
    w.write(`\x1b[${v.field_y + 1};${left + 1}H` + new Style({ fg: "text", bg: "selected" }).sgr());
    w.splat(" ", v.text_width + 2 * (v.padded ? 1 : 0));
    w.write(`\x1b[${v.field_y + 1};${v.text_x + 1}H`);
    if (d.len === 0 && (kind === "rename" || kind === "workspace_name")) {
      // This is a preview of the current position, never an editable/saved name.
      w.write(palette.fg("muted") + `${number}`);
    } else {
      if (d.selected) w.write(selection);
      const end = d.byteAtColumn(v.offset, v.text_width);
      const shown = Uint8Array.from(d.text.subarray(v.offset, end), byte =>
        kind === "agent_command" && byte < 32 ? 32 : byte,
      );
      w.write(Buffer.from(shown).toString());
    }
    v.buttons().forEach((b, i) => {
      w.write(`\x1b[${v.buttons_y + 1};${b.x + 1}H`);
      if (!b.cap) {
        // Too narrow for caps: the bare key.
        w.write(new Style({ fg: "strong", bg: "surface", bold: true }).sgr() + b.key);
        return;
      }
      w.write(keycap + ` ${b.key} `);
      if (b.label.length === 0) return;
      // The first button saves; its label is the one that stands out.
      const label =
        i === 0
          ? new Style({ fg: "strong", bg: "surface", bold: true }).sgr()
          : new Style({ fg: "muted", bg: "surface" }).sgr();
      w.write(`${label} ${b.label}`);
    });
    v.placeCursor(d, w);
  }
  private placeCursor(d: Dialog, w: Writer): void {
    let cursor_width = 0;
    for (const ch of d.bytes(this.offset, d.cursor)) {
      const cp = ch.codePointAt(0)!;
      cursor_width += "agent_command" in d.target && cp < 32 ? 1 : codepointWidth(cp);
    }
    w.write(`\x1b[0m\x1b[${this.field_y + 1};${this.text_x + 1 + cursor_width}H\x1b[?25h`);
  }
  private drawCard(card: Card, d: Dialog, w: Writer): void {
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
    w.write(`\x1b[${v.field_y + 1};${v.text_x + 1}H${d.selected ? selection : ""}`);
    w.write(d.bytes(v.offset, d.byteAtColumn(v.offset, v.text_width)));
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
