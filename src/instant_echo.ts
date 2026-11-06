import type { Surface, View } from "./pane/surface";
import * as text from "./text";
import * as style from "./instant_style";
import * as composer from "./instant_composer";

interface Draft {
  line: string;
  cursor: number;
}
interface Pending extends Draft {
  expires: number;
  credit: boolean;
  sequence: number;
}

/** Learn plain terminal echo before showing it. */
export class Echo {
  private view: View | null = null;
  private base: Draft | null = null;
  private pending: Pending[] = [];
  private submitted: { sequence: number; expires: number } | null = null;
  private floor = 0;
  private limit = 0;
  private template = "";
  private prefix = "";
  private trusted = false;
  private paused = false;
  private blocked = true;
  private output: Surface | null = null;
  private region = "";
  private acknowledged = 0;
  private dim = false;

  constructor(private readonly budget: () => number) {}

  shade(on: boolean): void {
    if (this.dim === on) return;
    this.dim = on;
    this.refresh();
  }

  reset(): void {
    this.base = null;
    this.pending = [];
    this.submitted = null;
    this.trusted = false;
    this.paused = false;
    this.blocked = true;
    this.output = null;
  }
  receive(view: View, now: number, acknowledged = 0): void {
    this.surface(now);
    const progress = acknowledged > this.acknowledged;
    this.acknowledged = acknowledged;
    if (this.submitted && acknowledged >= this.submitted.sequence) this.reset();
    const previous = this.view;
    this.view = view;
    const cursor = view.surface.cursor;
    if (cursor) {
      const region = `${view.stamp.identity}:${view.surface.cols}:${view.surface.rows}:${cursor.y}`;
      if (region !== this.region) {
        this.region = region;
        this.reset();
      }
    }
    if (view.stamp.offset !== null || !cursor || view.modes.mouse_event !== "none" || view.surface.images?.length) {
      this.reset();
      return;
    }
    if (
      previous &&
      (previous.stamp.identity !== view.stamp.identity ||
        previous.surface.cols !== view.surface.cols ||
        previous.surface.rows !== view.surface.rows ||
        previous.surface.cursor?.y !== cursor.y)
    )
      this.reset();
    const line = Bun.stripANSI(view.surface.lines[cursor.y] ?? "");
    if (this.base) {
      const candidates = [this.base, ...this.pending];
      const minimum = this.pending.findLastIndex(p => p.sequence <= acknowledged) + 1;
      const matches = candidates.flatMap((draft, i) => {
        const expected = projectLine(
          this.template,
          this.floor,
          text.displayWidth(draft.line),
          draft.line.slice(this.prefix.length),
        );
        return i >= minimum &&
          draft.cursor === cursor.x &&
          expected !== null &&
          Bun.stripANSI(expected).trimEnd() === line.trimEnd()
          ? [i]
          : [];
      });
      if (matches.length > 1) {
        // Ambiguous progress still agrees with the trajectory; do not rewind.
        this.refresh();
        return;
      }
      if (!matches.length) {
        this.reset();
      } else if (matches[0] > 0) {
        const confirmed = this.pending.splice(0, matches[0]);
        this.base = confirmed.at(-1)!;
        this.trusted ||= confirmed.some(draft => draft.credit);
        this.paused = false;
      }
    }
    const changed =
      progress ||
      !previous ||
      previous.stamp.identity !== view.stamp.identity ||
      previous.stamp.revision !== view.stamp.revision;
    if (!this.base && changed) {
      const prefix = text.clipped(line, cursor.x),
        tail = line.slice(prefix.length);
      this.limit = tail.trim() ? cursor.x + /^ */.exec(tail)![0].length : view.surface.cols - 1;
      if (text.displayWidth(prefix) !== cursor.x || this.limit <= cursor.x) return;
      this.prefix = prefix;
      this.template = view.surface.lines[cursor.y];
      this.base = { line: prefix, cursor: cursor.x };
      this.floor = cursor.x;
      this.blocked = false;
    }
    this.refresh();
  }
  input(data: string, now: number, sequence = 0): void {
    this.surface(now);
    if (this.submitted) {
      this.submitted.sequence = sequence;
      return;
    }
    if (this.blocked || !this.base || !this.view) return;
    if ((data === "\r" || data === "\n") && this.output) {
      this.submitted = { sequence, expires: now + this.budget() };
      return;
    }
    if (/^[\x20-\x7e]{2,}$/.test(data)) {
      for (const character of data) this.input(character, now, sequence);
      return;
    }
    const previous = this.pending.at(-1) ?? this.base;
    const edited = composer.edit(
      { text: previous.line.slice(this.prefix.length), cursor: previous.cursor - this.floor },
      data,
      false,
    );
    if (!edited) {
      this.reset();
      return;
    }
    const line = this.prefix + edited.text,
      cursor = this.floor + edited.cursor;
    if (text.displayWidth(line) >= this.limit || this.pending.length >= 128) {
      this.reset();
      return;
    }
    if (line === previous.line && cursor === previous.cursor) return;
    this.pending.push({ line, cursor, expires: now + this.budget(), credit: /^[\x21-\x7e]$/.test(data), sequence });
    this.refresh();
  }
  surface(now: number): Surface | null {
    if ((this.pending.length && now >= this.pending[0].expires) || (this.submitted && now >= this.submitted.expires))
      this.reset();
    return this.output;
  }
  private refresh(): void {
    const draft = this.pending.at(-1);
    this.output = null;
    if (!this.trusted || this.paused || !draft || !this.view?.surface.cursor) return;
    const surface = this.view.surface;
    const y = surface.cursor!.y;
    const plainPrefix = text.clipped(draft.line, this.floor);
    const projected = projectLine(
      surface.lines[y],
      this.floor,
      Math.max(text.displayWidth(this.base!.line), text.displayWidth(draft.line)),
      draft.line.slice(plainPrefix.length),
    );
    if (projected === null) return;
    const lines = surface.lines.slice();
    lines[y] = projected;
    this.output = { ...surface, lines, cursor: { x: draft.cursor, y } };
    if (this.dim)
      this.output = style.dim(this.output, surface, [{ y, start: this.floor, end: text.displayWidth(draft.line) }]);
  }
}

/** Replace only learned input cells, retaining the UI's per-cell renditions. */
function projectLine(line: string, start: number, end: number, replacement: string): string | null {
  let output = "",
    used = 0,
    offset = 0;
  for (const match of line.matchAll(/\x1b\[[0-9;]*m|[^\x1b]/gu)) {
    if (match.index !== offset) return null;
    const token = match[0];
    offset += token.length;
    if (token.startsWith("\x1b")) output += token;
    else {
      const width = text.displayWidth(token);
      if (used >= start && used < end) {
        if (width !== 1) return null;
        output += replacement[used - start] ?? " ";
      } else output += token;
      used += width;
    }
  }
  if (offset !== line.length) return null;
  while (used < end) {
    output += replacement[used - start] ?? " ";
    used++;
  }
  return output;
}
