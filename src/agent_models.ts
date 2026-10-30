//! The launch model picker uses the same dropdown as New and workspace choices.
import * as effort from "./providers/effort";
import { adapter, type Provider } from "./providers";
import { Model } from "./providers/model";
import { Quit } from "./subprocess";
import * as dropdown from "./dropdown";
import { Rect } from "./layout";
import { Dialog, View, writeField } from "./name_dialog";
import { Writer, clamp, displayWidth, writeEllipsis } from "./text";
import { Style, fg, fgRgb, keycap } from "./palette";
import { pulse } from "./sidebar";
import { milliTimestamp } from "./clock";
import * as keys from "./keys";
import { matches } from "./search";

export type Choice = { id: string; name: string; efforts?: effort.Effort[]; default_effort?: effort.Effort };
export async function read(provider: Provider, account: string, quit: Quit): Promise<Choice[]> {
  const launch = adapter(provider).launch,
    values = (await (launch.models ?? adapter(provider).inference.models)?.(account, quit)) ?? [];
  return values.map(m => ({
    id: m.id,
    name: m.name,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.default_effort ? { default_effort: m.default_effort } : {}),
  }));
}
/** Keep effort visually subordinate without treating the decorated name as state. */
export function writeModel(
  w: Writer,
  name: string,
  value: effort.Effort | undefined,
  room: number,
  style: string,
): void {
  const suffix = effort.suffix(value),
    size = displayWidth(suffix);
  writeEllipsis(w, name, Math.max(0, room - size));
  if (suffix) {
    w.write(fg("muted"));
    writeEllipsis(w, suffix, Math.min(room, size));
    w.write(style);
  }
}
function defaultLabel(choice: Choice): string {
  return choice.default_effort ? `Default (${effort.label(choice.default_effort)})` : "Default";
}
type Entry = { values: Choice[]; pending: boolean; failed: boolean; checked: number };
/** Viewer-local catalogs survive closing a dropdown or the manager. */
export class Cache {
  static fresh_ms = 5 * 60_000;
  static retry_ms = 30_000;
  private entries = new Map<string, Entry>();
  private queue: { provider: Provider; account: string; entry: Entry }[] = [];
  private running = 0;
  private active = new Set<Quit>();
  private closed = false;
  constructor(
    private changed: () => void,
    private reader = read,
    private now = Date.now,
  ) {}
  get(provider: Provider, account: string): Entry {
    const key = `${provider}\0${account}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { values: [], pending: false, failed: false, checked: -Infinity };
      this.entries.set(key, entry);
    }
    if (
      !this.closed &&
      !entry.pending &&
      this.now() - entry.checked >= (entry.failed ? Cache.retry_ms : Cache.fresh_ms)
    ) {
      entry.pending = true;
      this.queue.push({ provider, account, entry });
      this.drain();
    }
    return entry;
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    for (const quit of this.active) quit.signal();
  }
  private drain(): void {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const { provider, account, entry } = this.queue.shift()!,
        quit = new Quit();
      this.running++;
      this.active.add(quit);
      void this.reader(provider, account, quit)
        .then(
          values => {
            entry.values = values;
            entry.failed = false;
          },
          () => {
            entry.failed = true;
          },
        )
        .finally(() => {
          entry.checked = this.now();
          entry.pending = false;
          this.running--;
          this.active.delete(quit);
          if (!this.closed) this.changed();
          this.drain();
        });
    }
  }
}
export type Result = { model: string; effort?: effort.Effort } | "close" | null;
export class Picker {
  query = Dialog.init({ rename: 0 }, "");
  values: Choice[] = [];
  pending = true;
  failed = false;
  selected = 0;
  first = 1;
  editing: Choice | null = null;
  effort_at = 0;
  constructor(
    public current: string,
    public effort?: effort.Effort,
  ) {
    this.selected = current ? 1 : 0;
  }
  choices(): Choice[] {
    const all = [{ id: "", name: "Auto (last chosen)" }, ...this.values];
    if (this.current && !all.some(c => c.id === this.current))
      all.push({ id: this.current, name: Model.resolve(this.current).label() });
    return all.filter(c => !c.id || matches(this.query.name(), `${c.name} ${c.id}`));
  }
  received(values: Choice[], failed = false, pending = false): void {
    const selected = this.choices()[this.selected]?.id;
    this.values = values;
    this.pending = pending;
    this.failed = failed;
    this.selected = Math.max(
      0,
      this.choices().findIndex(c => c.id === selected),
    );
  }
  private result(
    choice: Choice,
    value: effort.Effort | null | undefined = choice.id === this.current ? this.effort : undefined,
  ): Result {
    return { model: choice.id, ...(choice.id && value ? { effort: value } : {}) };
  }
  edit(): void {
    const choice = this.choices()[this.selected];
    if (!choice?.efforts?.length) return;
    this.editing = choice;
    this.effort_at =
      choice.id === this.current && this.effort ? Math.max(0, choice.efforts.indexOf(this.effort) + 1) : 0;
  }
  key(byte: number): Result {
    if (this.editing) {
      if (byte === 27) this.editing = null;
      else if (byte === 13)
        return this.result(this.editing, this.effort_at ? this.editing.efforts![this.effort_at - 1] : null);
      else if (byte === 9 || byte === 14 || byte === 16) this.move(byte === 16 ? -1 : 1);
      return null;
    }
    if (byte === 47 && !this.query.len) return null;
    if (byte === 27) return "close";
    if (byte === 13) {
      const choice = this.choices()[this.selected];
      return choice ? this.result(choice) : null;
    }
    if (byte === 9 || byte === 14 || byte === 16) {
      this.move(byte === 16 ? -1 : 1);
      return null;
    }
    this.query.key(byte);
    this.searched();
    return null;
  }
  searched(): void {
    this.selected = this.query.len && this.choices().length > 1 ? 1 : 0;
    this.first = 1;
  }
  private move(delta: number): void {
    if (this.editing) {
      const count = 1 + this.editing.efforts!.length;
      this.effort_at = (this.effort_at + delta + count) % count;
      return;
    }
    const count = this.choices().length;
    this.selected = (this.selected + delta + count) % count;
  }
  sequence(seq: string): void {
    const key = keys.parse(seq);
    if (key === "right" && !this.editing) {
      this.edit();
      return;
    }
    if (key === "left" && this.editing) {
      this.editing = null;
      return;
    }
    if (key === "up" || key === "down") this.move(key === "up" ? -1 : 1);
    else if (!this.editing) {
      this.query.sequence(seq);
      this.searched();
    }
  }
  bounds(parent: Rect, anchor: { x: number; y: number }): Rect {
    const w = Math.min(parent.w - 4, 62),
      h = Math.min(parent.h - 2, 14);
    return new Rect(
      clamp(anchor.x, parent.x + 2, parent.x + parent.w - w - 2),
      clamp(anchor.y + 1, parent.y + 1, parent.y + parent.h - h - 1),
      w,
      h,
    );
  }
  private window(b: Rect) {
    const room = Math.max(1, b.h - 7),
      choices = this.choices();
    if (this.selected > 0) this.first = clamp(this.first, this.selected - room + 1, this.selected);
    this.first = clamp(this.first, 1, Math.max(1, choices.length - room));
    return choices.slice(this.first, this.first + room);
  }
  private hit(b: Rect, x: number, y: number): number | null {
    if (x <= b.x || x >= b.x + b.w - 1) return null;
    if (this.editing) {
      const i = y - b.y - 3 + Math.max(0, this.effort_at - Math.max(1, b.h - 5) + 1);
      return y >= b.y + 3 && i >= 0 && i <= this.editing.efforts!.length && y < b.y + b.h - 2 ? i : null;
    }
    if (y === b.y + 3) return 0;
    const index = y - b.y - 5 + this.first;
    return y >= b.y + 5 && y < b.y + b.h - 2 && index < this.choices().length ? index : null;
  }
  hover(b: Rect, x: number, y: number): void {
    const index = this.hit(b, x, y);
    if (index !== null) {
      if (this.editing) this.effort_at = index;
      else this.selected = index;
    }
  }
  click(b: Rect, x: number, y: number): Result {
    if (!b.contains(x, y)) return "close";
    const index = this.hit(b, x, y);
    if (this.editing) {
      if (y === b.y + 1) {
        this.editing = null;
        return null;
      }
      return index === null ? null : this.result(this.editing, index ? this.editing.efforts![index - 1] : null);
    }
    const choice = index === null ? null : this.choices()[index];
    if (choice?.efforts?.length && x >= b.x + b.w - 11) {
      this.selected = index!;
      this.edit();
      return null;
    }
    return choice ? this.result(choice) : null;
  }
  draw(w: Writer, b: Rect, now = milliTimestamp()): void {
    dropdown.draw(w, b, []);
    if (this.editing) {
      const c = this.editing;
      w.write(`\x1b[${b.y + 2};${b.x + 3}H` + new Style({ fg: "strong", bg: "surface" }).sgr());
      writeEllipsis(w, "‹ " + c.name + " · Effort", b.w - 4);
      const values = [undefined, ...c.efforts!];
      const room = Math.max(1, b.h - 5),
        start = Math.max(0, this.effort_at - room + 1);
      values.slice(start, start + room).forEach((value, i) =>
        dropdown.row(w, b, i + 3, {
          text: value ? effort.label(value) : defaultLabel(c),
          note: "",
          current: c.id === this.current && value === this.effort,
          hovered: this.effort_at === start + i,
        }),
      );
      w.write(`\x1b[${b.y + b.h - 1};${b.x + 3}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, "← back · enter choose effort", b.w - 4);
      w.write("\x1b[?25l");
      return;
    }
    const style = new Style({ fg: "text", bg: "selected" }).sgr();
    w.write(`\x1b[${b.y + 2};${b.x + 3}H` + style);
    w.splat(" ", b.w - 4);
    w.write(`\x1b[${b.y + 2};${b.x + 3}H`);
    w.write(keycap + " / " + style + " ");
    if (this.query.len) writeField(w, this.query, View.scroll(this.query, b.w - 8), b.w - 8, style);
    else writeEllipsis(w, "Search models", b.w - 8);
    dropdown.row(w, b, 3, {
      text: "Auto (last chosen)",
      note: "",
      current: !this.current,
      hovered: this.selected === 0,
    });
    w.write(`\x1b[${b.y + 5};${b.x + 5}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
    if (this.pending) {
      for (const [i, ch] of [..."Reading models…"].entries()) w.write(fgRgb(pulse(i / 4, now)) + ch);
    } else if (this.failed) writeEllipsis(w, "Couldn't read models", b.w - 8);
    else if (!this.values.length) writeEllipsis(w, "No models available", b.w - 8);
    this.window(b).forEach((c, i) =>
      dropdown.row(w, b, i + 5, {
        text: c.name,
        note: c.efforts?.length
          ? `${c.id === this.current && this.effort ? effort.label(this.effort) : defaultLabel(c)}  Edit ›`
          : "",
        current: c.id === this.current,
        hovered: this.selected === this.first + i,
      }),
    );
    w.write(`\x1b[${b.y + b.h - 1};${b.x + 3}H` + new Style({ fg: "muted", bg: "surface" }).sgr());
    writeEllipsis(
      w,
      this.choices()[this.selected]?.efforts?.length
        ? "→ edit effort · enter choose · esc back"
        : "Auto follows the agent CLI · esc back",
      b.w - 4,
    );
    const offset = View.scroll(this.query, b.w - 8);
    w.write(
      `\x1b[${b.y + 2};${b.x + 7 + Math.min(b.w - 9, displayWidth(this.query.bytes(offset, this.query.cursor)))}H\x1b[?25h`,
    );
  }
}
