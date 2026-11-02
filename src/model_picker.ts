//! The model picker the Corgi prompt and Clever Corgi share: an Auto row,
//! then the models worth offering under each agent, with a row per account
//! or routed source giving who it's signed in as, its plan and its limits in
//! columns, and a search field over every model. A model's effort shows at
//! its right, and → opens the levels in the same box, as Manage agents does.
import * as i18n from "./i18n";
import * as effort from "./providers/effort";
import type { Effort } from "./providers/effort";
import { Provider, adapter, byProvider } from "./providers";
import { Model } from "./providers/model";
import { Rect } from "./layout";
import * as dropdown from "./dropdown";
import * as keys from "./keys";
import * as scrollThumb from "./scroll_thumb";
import { matches } from "./search";
import { pulse } from "./sidebar";
import { fit, suggest } from "./model_suggest";
import { outdated, routeName } from "./model_series";
import { percentFigure } from "./launcher_usage";
import { writeMark, type Marks } from "./provider_mark";
import type { Limits } from "./usage/account";
import { Style, fg, fgRgb, keycap, type Token } from "./palette";
import { Writer, clamp, displayWidth, writeEllipsis } from "./text";

export type Entry = {
  provider: Provider;
  account: string;
  account_name: string;
  model: string;
  name: string;
  efforts: Effort[];
  default_effort: Effort | null;
};
export type Choice = { provider: Provider; account: string; model: string; name: string; effort: Effort | null };
/** What a picker says of an account, of a source routed through one, or of
 * a model. An account's or a source's heads its models: `who` it's signed in
 * as, its `plan` and its `limits` ("5h 12%", "7d 48%"), or else its parts.
 * A model's adds what's true of it alone, as "auto". `text` is the parts
 * joined, as the prompt's card shows them; a brief without `parts` is one. */
export type Brief = {
  provider: Provider;
  account: string;
  /** The source a routed model comes from, as "GitHub Copilot"; unset for the account's own. */
  route?: string;
  model?: string;
  text: string;
  parts?: string[];
  who?: string;
  plan?: string;
  limits?: string[];
};
/** A row above the models that picks something besides one, as Auto; its
 * detail is parts, as a brief's. */
export type Pin = { id: string; name: string; detail: string[]; glyph: string };
export type Options = { pins?: Pin[]; current_pin?: string | null };
export type Result = "pick" | "close" | null;

const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;
/** "Opus 5.5 · High". */
export function label(c: Choice): string {
  const name = nameOf(c);
  return c.effort ? `${name} · ${effort.label(c.effort)}` : name;
}
/** A brief of `parts`, with its text. */
export function brief(provider: Provider, account: string, parts: string[], model?: string): Brief {
  const out: Brief = { provider, account, text: parts.join(" · "), parts };
  return model === undefined ? out : { ...out, model };
}
type Account = { plan: string; limits: Limits; signed_in: boolean | null };
/** An account's plan and limits as a brief's parts, the shortest window
 * first: "Max", "5h 12%", "7d 48%"; "Signed out" when it is. */
export function accountParts(o: Account): string[] {
  if (o.signed_in === false) return [i18n.t`Signed out`];
  const parts = [o.plan];
  if (o.limits === "metered" && !o.plan) parts.push(i18n.t`Metered`);
  else if (o.limits === "rate_limited") parts.push(i18n.t`rate limited`);
  else if (typeof o.limits === "object")
    for (const w of o.limits.windows.filter(w => w !== null).sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0)))
      parts.push(`${w.label()} ${percentFigure(w.used)}`);
  return parts.filter(Boolean);
}
/** The same, joined to show whole: "Max · 5h 12% · 7d 48%". */
export function accountBrief(o: Account): string {
  return accountParts(o).join(" · ");
}
/** The brief heading an account's models: its parts, and apart, who it's
 * signed in as, its plan and its limits. */
export function accountHeader(provider: Provider, account: string, o: Account & { account?: string }): Brief {
  const parts = accountParts(o),
    plan = o.signed_in !== false && o.plan ? o.plan : "";
  return { ...brief(provider, account, parts), who: o.account ?? "", plan, limits: plan ? parts.slice(1) : parts };
}
/** The models of one account, or of one source routed through it. */
type Group = { provider: Provider; account: string; route: string };
/** An agent's heading, carrying its only group when it has one; a group's
 * heading under its agent; a model; or a pin. */
type Row =
  | { kind: "agent"; provider: Provider; group: Group | null }
  | { kind: "group"; group: Group }
  | { kind: "choice"; choice: Choice }
  | { kind: "pin"; pin: Pin };
type Span = { from: number; to: number };
/** Where the last draw put things, for clicks: the field, the rows, and
 * each model row's "Edit ›". */
type Drawn = { rect: Rect; field: number; top: number; capacity: number; first: number; edits: Map<number, Span> };
/** Columns shared by every row, so headers line up as a table. */
type Columns = {
  agent: number;
  group: number;
  model: number;
  who: number;
  who_w: number;
  plan: number;
  plan_w: number;
  limits_w: number;
  right: number;
};
/** The row to keep highlighted across a rebuild. */
type Focus = Choice | { pin: string } | null;
/** The effort list → opens in place of the models. */
type Editing = { choice: Choice; levels: (Effort | null)[]; at: number; first: number };

const key = (c: { provider: Provider; account: string; model: string }) => `${c.provider}\0${c.account}\0${c.model}`;
const groupOf = (c: { provider: Provider; account: string; model: string }): Group => ({
  provider: c.provider,
  account: c.account,
  route: routeName(c.model),
});
const groupKey = (g: Group) => `${g.provider}\0${g.account}\0${g.route}`;
const header = (row: Row): boolean => row.kind === "agent" || row.kind === "group";
function nameOf(c: { model: string; name: string }): string {
  return c.name || Model.resolve(c.model).label() || c.model || i18n.t`Default`;
}
function partsOf(b: Brief): string[] {
  return b.parts ?? [b.text];
}
/** `parts` joined in `room`, empty ones left out and the last dropped whole
 * so no figure is cut; "" when even the first won't fit. */
function shorten(parts: string[], room: number): string {
  const kept = parts.filter(Boolean);
  while (kept.length && displayWidth(kept.join(" · ")) > room) kept.pop();
  return kept.join(" · ");
}
/** Groups in order, each with its choices, gathered from `list`. */
function gather(list: Choice[]): [Group, Choice[]][] {
  const groups = new Map<string, [Group, Choice[]]>();
  for (const c of list) {
    const g = groupOf(c),
      k = groupKey(g);
    if (!groups.has(k)) groups.set(k, [g, []]);
    groups.get(k)![1].push(c);
  }
  return [...groups.values()];
}
/** The rows `groups` take: an agent's heading over each of its groups, or
 * one heading carrying an agent's only group, then the models. */
function rowsOf(groups: [Group, Choice[]][]): Row[] {
  const agents = [...new Set(groups.map(([g]) => g.provider))],
    choices = (list: Choice[]) => list.map((choice): Row => ({ kind: "choice", choice }));
  return agents.flatMap((provider): Row[] => {
    const own = groups.filter(([g]) => g.provider === provider);
    return own.length === 1
      ? [{ kind: "agent", provider, group: own[0][0] }, ...choices(own[0][1])]
      : [
          { kind: "agent", provider, group: null },
          ...own.flatMap(([group, list]): Row[] => [{ kind: "group", group }, ...choices(list)]),
        ];
  });
}
/** As many of each group's choices as `room` rows hold, headings included:
 * the best group's first four, the next's three, the next's two and one of
 * each after, then the rest, best group first. Groups that don't fit wait
 * for a search. */
function trim(groups: [Group, Choice[]][], room: number): [Group, Choice[]][] {
  const take = groups.map(() => 0),
    rows = () =>
      rowsOf(groups.map(([g, list], i): [Group, Choice[]] => [g, list.slice(0, take[i])]).filter(([, l]) => l.length))
        .length,
    grow = (i: number, upto: number) => {
      while (take[i] < Math.min(upto, groups[i][1].length)) {
        take[i]++;
        if (rows() > room) {
          take[i]--;
          return;
        }
      }
    };
  groups.forEach((_, i) => grow(i, [4, 3, 2][i] ?? 1));
  groups.forEach((_, i) => {
    if (take[i]) grow(i, Infinity);
  });
  return groups.map(([g, list], i): [Group, Choice[]] => [g, list.slice(0, take[i])]).filter(([, l]) => l.length);
}
/** The most rows the list takes under the search field, and the fewest it
 * keeps for a search; the box keeps its rows whatever is listed or typed. */
const list_rows = 14,
  least_rows = 5;

export class Picker {
  private entries: Entry[] = [];
  private by_key = new Map<string, Entry>();
  /** The models a newer version replaces, which search lists after the rest. */
  private old = new Set<Entry>();
  private briefs: Brief[] = [];
  private rows: Row[] = [];
  /** Each model's effort as the user left it, or as suggested. */
  private efforts = new Map<string, Effort | null>();
  /** What's typed after `/`; null while not searching. */
  private query: string | null = null;
  /** A typed character's bytes until it is whole. */
  private partial: number[] = [];
  private highlight = 0;
  private first = 0;
  /** List rows the box holds under the field, as last drawn. */
  private capacity = list_rows;
  private drawn: Drawn | null = null;
  private edit: Editing | null = null;
  private pins: Pin[];
  private current_pin: string | null;

  constructor(
    entries: Entry[],
    private suggested: Choice[],
    private current: Choice | null,
    briefs: Brief[],
    options: Options = {},
  ) {
    this.pins = options.pins ?? [];
    this.current_pin = options.current_pin ?? null;
    this.update(entries, briefs);
  }
  get searching(): boolean {
    return this.query !== null;
  }
  /** The effort list is open in place of the models. */
  get editing(): boolean {
    return this.edit !== null;
  }
  /** What's typed after `/`; "" while not searching. */
  typed(): string {
    return this.query ?? "";
  }
  /** The highlighted pin's id; null on a model. */
  pinned(): string | null {
    const row = this.rows[this.highlight];
    return !this.edit && row?.kind === "pin" ? row.pin.id : null;
  }
  /** Takes catalogs and limits as they arrive, and new suggestions and pins with them. */
  update(entries: Entry[], briefs: Brief[], suggested?: Choice[], pins?: Pin[]): void {
    const focused = this.focused();
    this.entries = entries;
    this.by_key = new Map(entries.map(e => [key(e), e]));
    this.old = outdated(entries);
    this.briefs = briefs;
    if (suggested) this.suggested = suggested;
    if (pins) this.pins = pins;
    if (this.current && !this.efforts.has(key(this.current))) this.efforts.set(key(this.current), this.current.effort);
    for (const c of this.suggested) if (!this.efforts.has(key(c))) this.efforts.set(key(c), c.effort);
    this.rebuild(focused);
  }
  key(byte: number): Result {
    if (this.edit) return this.editKey(byte);
    switch (byte) {
      case 27:
        if (this.query === null) return "close";
        this.leave();
        return null;
      case 13:
        return this.enter();
      case 9:
      case 14:
        this.move(1);
        return null;
      case 16:
        this.move(-1);
        return null;
    }
    if (this.query === null) {
      if (byte === 47) this.search();
      else if (byte > 32 && byte !== 127) this.type(byte);
      return null;
    }
    switch (byte) {
      case 8:
      case 127:
        if (!this.query) this.leave();
        else this.retype([...this.query].slice(0, -1).join(""));
        return null;
      case 21:
        this.retype("");
        return null;
      case 23:
        this.retype(this.query.replace(/\S*\s*$/u, ""));
        return null;
    }
    this.type(byte);
    return null;
  }
  sequence(text: string): Result {
    if (text.length === 1 && text.charCodeAt(0) < 0x80) return this.key(text.charCodeAt(0));
    const parsed = keys.parse(text);
    if (this.edit) {
      if (parsed === "up" || parsed === "shift_tab") this.editMove(-1);
      else if (parsed === "down") this.editMove(1);
      else if (parsed === "left") this.edit = null;
      return null;
    }
    switch (parsed) {
      case "up":
      case "shift_tab":
        this.move(-1);
        return null;
      case "down":
        this.move(1);
        return null;
      case "right":
        this.open();
        return null;
      case "page_up":
        this.jump(this.highlight - this.page(), -1);
        return null;
      case "page_down":
        this.jump(this.highlight + this.page(), 1);
        return null;
      case "home":
        this.jump(0, 1);
        return null;
      case "end":
        this.jump(this.rows.length - 1, -1);
        return null;
      case null:
        if (text.startsWith("\x1b")) return null;
        for (const byte of Buffer.from(text)) this.type(byte);
        return null;
      default:
        return null;
    }
  }
  /** A click at screen cell (x, y), hit against the last drawn rect: the
   * field searches, "Edit ›" opens a model's efforts, a row picks, an effort
   * chooses itself, and outside closes. */
  click(x: number, y: number): Result {
    const d = this.drawn;
    if (!d) return null;
    if (!d.rect.contains(x, y)) return "close";
    if (x === d.rect.x || x === d.rect.x + d.rect.w - 1) return null;
    if (this.edit) {
      if (y === d.field) this.edit = null;
      else {
        const index = this.edit.first + y - d.top;
        if (y >= d.top && y < d.top + d.capacity && index < this.edit.levels.length) {
          this.edit.at = index;
          return this.editKey(13);
        }
      }
      return null;
    }
    if (y === d.field) {
      this.search();
      return null;
    }
    const index = d.first + y - d.top;
    if (y < d.top || y >= d.top + d.capacity || index >= this.rows.length) return null;
    if (header(this.rows[index])) return null;
    this.highlight = index;
    const edit = d.edits.get(y);
    if (edit && x >= edit.from && x < edit.to) {
      this.open();
      return null;
    }
    return this.enter();
  }
  /** Highlights the row under the pointer at screen cell (x, y), as a menu follows it. */
  hover(x: number, y: number): void {
    const d = this.drawn;
    if (!d || !d.rect.contains(x, y) || y < d.top || y >= d.top + d.capacity) return;
    if (this.edit) {
      const index = this.edit.first + y - d.top;
      if (index < this.edit.levels.length) this.edit.at = index;
      return;
    }
    const index = d.first + y - d.top;
    if (index < this.rows.length && !header(this.rows[index])) this.highlight = index;
  }
  scroll(down: boolean): void {
    const capacity = this.drawn?.capacity ?? 0;
    if (this.edit) {
      this.editMove(down ? 1 : -1);
      return;
    }
    const count = this.rows.length;
    if (capacity <= 0 || count <= capacity) return;
    this.first = clamp(this.first + (down ? 1 : -1), 0, count - capacity);
    const last = this.first + capacity - 1;
    this.highlight = clamp(this.highlight, this.first, last);
    if (header(this.rows[this.highlight])) {
      const below = this.selectable(this.highlight, 1);
      this.highlight = below <= last && !header(this.rows[below]) ? below : this.selectable(this.highlight, -1);
    }
  }
  /** The rows it wants of the `rows` it may take: the field and the rows
   * every offered model would fill, which a search scrolls within. It's the
   * same whatever is typed; before any catalog it keeps room for one. */
  height(rows: number): number {
    const offered = this.entries.length ? this.offered() : [],
      wanted = offered.length ? this.pins.length + rowsOf(gather(offered)).length : list_rows;
    return Math.max(0, Math.min(rows, 3 + clamp(wanted, least_rows, list_rows)));
  }
  draw(w: Writer, rect: Rect, marks: Marks | null, now: number): void {
    const b = new Rect(rect.x, rect.y, rect.w, rect.h);
    this.drawn = null;
    if (b.w < 12 || b.h < 4) return;
    dropdown.draw(w, b, []);
    const field = b.y + 1,
      top = b.y + 2,
      capacity = Math.max(0, b.y + b.h - 1 - top);
    if (capacity !== this.capacity) {
      this.capacity = capacity;
      if (this.query === null) this.rebuild(this.focused());
    }
    const edits = new Map<number, Span>(),
      levels = this.edit ? this.drawEffort(w, b, field, top, capacity, marks) : top;
    if (!this.edit) this.drawList(w, b, field, top, capacity, marks, now, edits);
    this.drawHints(w, b);
    w.write("\x1b[0m");
    this.drawn = {
      rect: b,
      field,
      top: levels,
      capacity: top + capacity - levels,
      first: this.edit ? this.edit.first : this.first,
      edits,
    };
  }
  /** The highlighted model with its effort: what ⏎ or a click picked. */
  chosen(): Choice {
    const row = this.rows[this.highlight];
    if (row?.kind === "choice") return this.withEffort(row.choice);
    if (this.current) return this.withEffort(this.current);
    const e = this.entries[0];
    return e
      ? { provider: e.provider, account: e.account, model: e.model, name: e.name, effort: fit(e, null) }
      : { provider: Provider.first, account: "", model: "", name: "", effort: null };
  }

  private focused(): Focus {
    const row = this.rows[this.highlight];
    return row?.kind === "pin" ? { pin: row.pin.id } : row?.kind === "choice" ? row.choice : null;
  }
  /** The model in use, then the suggestions, each once. */
  private offered(): Choice[] {
    const shown = this.suggested.length
        ? this.suggested
        : suggest({ launches: byProvider(() => 0), agents: [], last: this.current, clever: null }, this.entries),
      seen = new Set<string>(),
      list: Choice[] = [];
    for (const c of this.current ? [this.current, ...shown] : shown)
      if (!seen.has(key(c))) {
        seen.add(key(c));
        list.push(c);
      }
    return list;
  }
  /** Lists the pins and the offered models that fit, under their agents and
   * accounts, or every model the query finds, grouped the same way, then the
   * pins it finds; keeps `keep` highlighted. */
  private rebuild(keep: Focus): void {
    const offered = this.offered();
    if (this.query === null)
      this.rows = [
        ...this.pins.map((pin): Row => ({ kind: "pin", pin })),
        ...rowsOf(trim(gather(offered), this.capacity - this.pins.length)),
      ];
    else {
      const query = this.query,
        order = [...new Set([...offered, ...this.entries].map(c => groupKey(groupOf(c))))],
        found = [...this.entries]
          .sort((a, b) => Number(this.old.has(a)) - Number(this.old.has(b)))
          .filter(e => {
            const p = adapter(e.provider);
            return matches(
              query,
              `${e.name} ${e.model} ${p.name} ${p.label} ${e.account_name} ${this.headerOf(groupOf(e))?.who ?? ""} ${routeName(e.model)}`,
            );
          })
          .map((e): Choice => ({
            provider: e.provider,
            account: e.account,
            model: e.model,
            name: e.name,
            effort: fit(e, null),
          }));
      this.rows = [
        ...rowsOf(gather(found).sort(([a], [b]) => order.indexOf(groupKey(a)) - order.indexOf(groupKey(b)))),
        ...this.pins.filter(pin => matches(query, pin.name)).map((pin): Row => ({ kind: "pin", pin })),
      ];
    }
    if (this.edit && !this.by_key.has(key(this.edit.choice))) this.edit = null;
    const find = (focus: Focus) =>
      focus && "pin" in focus
        ? this.rows.findIndex(r => r.kind === "pin" && r.pin.id === focus.pin)
        : focus
          ? this.rows.findIndex(r => r.kind === "choice" && key(r.choice) === key(focus))
          : -1;
    const found = find(keep),
      current = find(this.current ?? (this.current_pin === null ? null : { pin: this.current_pin }));
    this.highlight = found >= 0 ? found : current >= 0 ? current : this.selectable(0, 1);
  }
  /** The first row from `from` stepping by `step` that isn't a heading; `from` when there's none. */
  private selectable(from: number, step: 1 | -1): number {
    for (let i = from; i >= 0 && i < this.rows.length; i += step) if (!header(this.rows[i])) return i;
    return from;
  }
  private search(): void {
    if (this.query !== null) return;
    this.query = "";
    this.first = 0;
    this.rebuild(this.focused());
  }
  private leave(): void {
    const focused = this.focused();
    this.query = null;
    this.partial = [];
    this.first = 0;
    this.rebuild(focused);
  }
  /** Searches for `query`, from its first match; an emptied query keeps the highlight. */
  private retype(query: string): void {
    const focused = this.focused();
    this.query = query;
    this.first = 0;
    this.rebuild(query ? null : focused);
    if (query) this.highlight = this.selectable(0, 1);
  }
  /** Types a byte into the query, starting a search; UTF-8 waits until whole. */
  private type(byte: number): void {
    if (byte < 32 || byte === 127) return;
    let text: string;
    if (byte < 0x80) {
      this.partial = [];
      text = String.fromCharCode(byte);
    } else {
      if (byte < 0xc0 && !this.partial.length) return;
      if (byte >= 0xc0) this.partial = [];
      this.partial.push(byte);
      const lead = this.partial[0],
        size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
      if (this.partial.length < size) return;
      text = Buffer.from(this.partial).toString();
      this.partial = [];
      if (text.includes("�")) return;
    }
    if (this.query === null) this.search();
    this.retype(this.query! + text);
  }
  private enter(): Result {
    const row = this.rows[this.highlight];
    return row && !header(row) ? "pick" : null;
  }
  /** Steps past headings, wrapping. */
  private move(delta: number): void {
    const count = this.rows.length;
    let i = this.highlight;
    for (let n = 0; n < count; n++) {
      i = (i + delta + count) % count;
      if (!header(this.rows[i])) break;
    }
    if (count) this.highlight = i;
  }
  /** Highlights the row at `to`, or past a heading there in `step`'s direction. */
  private jump(to: number, step: 1 | -1): void {
    if (!this.rows.length) return;
    const at = clamp(to, 0, this.rows.length - 1),
      found = this.selectable(at, step);
    this.highlight = !header(this.rows[found]) ? found : this.selectable(at, step === 1 ? -1 : 1);
  }
  private page(): number {
    return Math.max(1, this.capacity - 1);
  }
  /** Opens the highlighted model's efforts, on the one it has. */
  private open(): void {
    const row = this.rows[this.highlight];
    if (row?.kind !== "choice") return;
    const efforts = this.levels(row.choice);
    if (!efforts.length) return;
    const levels: (Effort | null)[] = [null, ...efforts];
    this.edit = { choice: row.choice, levels, at: Math.max(0, levels.indexOf(this.effortOf(row.choice))), first: 0 };
  }
  private editKey(byte: number): Result {
    const edit = this.edit!;
    switch (byte) {
      case 27:
        this.edit = null;
        return null;
      case 13:
        this.efforts.set(key(edit.choice), edit.levels[edit.at]);
        this.edit = null;
        return "pick";
      case 9:
      case 14:
        this.editMove(1);
        return null;
      case 16:
        this.editMove(-1);
        return null;
    }
    return null;
  }
  private editMove(delta: number): void {
    const edit = this.edit!,
      n = edit.levels.length;
    edit.at = (edit.at + delta + n) % n;
  }
  private levels(c: Choice): Effort[] {
    return this.by_key.get(key(c))?.efforts ?? [];
  }
  private effortOf(c: Choice): Effort | null {
    const k = key(c),
      value = this.efforts.has(k) ? this.efforts.get(k)! : c.effort,
      e = this.by_key.get(k);
    return e ? fit(e, value) : value;
  }
  private withEffort(c: Choice): Choice {
    const e = this.by_key.get(key(c));
    return { ...c, name: e?.name || c.name, effort: this.effortOf(c) };
  }
  /** "High", or the model's default when none is chosen: "Default (High)". */
  private effortText(c: Choice, value: Effort | null): string {
    if (value) return effort.label(value);
    const fallback = this.by_key.get(key(c))?.default_effort,
      label = fallback ? effort.label(fallback) : "";
    return fallback ? i18n.t`Default (${label})` : i18n.t`Default`;
  }
  /** Every group a heading may name, so the columns stay put however the list scrolls. */
  private groups(): Group[] {
    const all = [...this.entries, ...(this.current ? [this.current] : [])];
    return [...new Map(all.map(e => [groupKey(groupOf(e)), groupOf(e)])).values()];
  }
  /** What heads a group: a brief for its source, else its account's. */
  private headerOf(g: Group): Brief | null {
    const own = this.briefs.filter(b => b.provider === g.provider && b.account === g.account && b.model === undefined);
    return own.find(b => (b.route ?? "") === g.route) ?? own.find(b => !b.route) ?? null;
  }
  /** A group's name: its source, or when the agent has several accounts,
   * who its account is signed in as, else the account's name; "" otherwise.
   * Not the name alone: the default account's is its agent's in Manage
   * agents, often a model's, as "Opus". */
  private groupName(g: Group): string {
    if (g.route) return g.route;
    const own = this.entries.filter(e => e.provider === g.provider);
    if (new Set(own.map(e => e.account)).size < 2) return "";
    return (
      this.headerOf(g)?.who ||
      own.find(e => e.account === g.account)?.account_name ||
      (g.account ? "" : i18n.t`default`)
    );
  }
  /** Who a group's heading says it's signed in as in its own column; "" when its name already does. */
  private whoOf(g: Group): string {
    const who = this.headerOf(g)?.who ?? "";
    return who === this.groupName(g) ? "" : who;
  }
  /** What a model's own brief adds to its group's heading, as "auto". */
  private extras(c: Choice): string[] {
    const model = this.briefs.find(b => b.provider === c.provider && b.account === c.account && b.model === c.model);
    if (!model) return [];
    const head = this.headerOf(groupOf(c)),
      shared = new Set(head ? [...partsOf(head), head.who, head.plan, ...(head.limits ?? [])] : []);
    return partsOf(model).filter(part => part && !shared.has(part) && part !== groupOf(c).route);
  }
  private columns(b: Rect): Columns {
    const agent = b.x + 5,
      group = agent + 2,
      right = b.x + b.w - 3;
    let lead = 0,
      who = 0,
      plan = 0,
      limits = 0,
      first = 0;
    for (const g of this.groups()) {
      const name = this.groupName(g),
        head = this.headerOf(g),
        mine = adapter(g.provider).name;
      lead = Math.max(
        lead,
        agent + displayWidth(mine) + (name ? 3 + displayWidth(name) : 0),
        group + displayWidth(name),
      );
      if (!head) continue;
      who = Math.max(who, displayWidth(this.whoOf(g)));
      plan = Math.max(plan, displayWidth(head.plan ?? ""));
      limits = Math.max(limits, displayWidth((head.limits ?? []).join(" · ")));
      first = Math.max(first, displayWidth(head.limits?.[0] ?? ""));
    }
    // A long name, as an email, shortens before the plan and the first limit go.
    lead = Math.min(lead, Math.max(group + 12, right - 1 - (plan ? plan + 2 : 0) - first));
    const start = lead + 2,
      room = right + 1 - start;
    let limits_w = limits,
      plan_w = plan,
      who_w = Math.min(who, room - (plan ? plan + 2 : 0) - (limits ? limits + 2 : 0));
    if (who_w < 8) who_w = 0;
    if (room < (plan_w ? plan_w + 2 : 0) + limits_w) limits_w = Math.max(0, room - (plan_w ? plan_w + 2 : 0));
    if (room < plan_w) plan_w = 0;
    const plan_x = right + 1 - limits_w - (limits_w ? 2 : 0) - plan_w;
    return { agent, group, model: group + 2, who: start, who_w, plan: plan_x, plan_w, limits_w, right };
  }
  private drawList(
    w: Writer,
    b: Rect,
    field: number,
    top: number,
    capacity: number,
    marks: Marks | null,
    now: number,
    edits: Map<number, Span>,
  ): void {
    this.drawField(w, b, field);
    if (!this.rows.length && capacity > 0) {
      w.write(at(b.x + 5, top) + new Style({ fg: "faint", bg: "surface" }).sgr());
      if (this.query !== null) writeEllipsis(w, i18n.t`No models match`, b.w - 7);
      else if (this.entries.length) writeEllipsis(w, i18n.t`No models`, b.w - 7);
      else for (const [i, ch] of [...i18n.t`Reading models…`].entries()) w.write(fgRgb(pulse(i / 4, now)) + ch);
    }
    // The highlighted row stays in view, with its headings when there's room.
    const count = this.rows.length;
    let lead = this.highlight;
    while (lead > 0 && header(this.rows[lead - 1]) && this.highlight - lead + 2 <= capacity) lead--;
    this.first = Math.min(Math.max(this.first, this.highlight - capacity + 1), lead);
    this.first = clamp(this.first, 0, Math.max(0, count - capacity));
    const cols = this.columns(b);
    this.rows.slice(this.first, this.first + capacity).forEach((row, i) => {
      const y = top + i,
        selected = this.first + i === this.highlight;
      if (row.kind === "agent") this.drawAgent(w, b, y, row.provider, row.group, cols, marks);
      else if (row.kind === "group") this.drawGroup(w, b, y, row.group, cols);
      else if (row.kind === "pin") this.drawPin(w, b, y, row.pin, selected, cols);
      else {
        const edit = this.drawChoice(w, b, y, row.choice, selected, cols);
        if (edit) edits.set(y, edit);
      }
    });
    const thumb = scrollThumb.thumb(capacity, count, this.first);
    if (thumb) {
      w.write(new Style({ fg: "line", bg: "surface" }).sgr());
      for (let k = thumb.start; k < thumb.start + thumb.len; k++) w.write(at(b.x + b.w - 1, top + k) + "┃");
    }
  }
  private clear(w: Writer, b: Rect, y: number, bg: Token): void {
    w.write(at(b.x + 1, y) + new Style({ fg: "text", bg }).sgr());
    w.splat(" ", b.w - 2);
  }
  /** An agent's heading: its mark and name, and when it has one group, that group's columns. */
  private drawAgent(
    w: Writer,
    b: Rect,
    y: number,
    provider: Provider,
    group: Group | null,
    cols: Columns,
    marks: Marks | null,
  ): void {
    this.clear(w, b, y, "surface");
    writeMark(w, provider, b.x + 2, y, marks);
    const name = adapter(provider).name,
      room = Math.max(0, (cols.who_w ? cols.who : cols.plan) - 2 - cols.agent);
    w.write(at(cols.agent, y) + new Style({ fg: "strong", bg: "surface", bold: true }).sgr());
    writeEllipsis(w, name, room);
    if (!group) return;
    const own = this.groupName(group);
    if (own) {
      w.write(new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, ` · ${own}`, Math.max(0, room - displayWidth(name)));
    }
    this.drawColumns(w, y, group, cols, cols.agent + displayWidth(name) + (own ? 3 + displayWidth(own) : 0));
  }
  /** A group's heading under its agent: its name, then its columns. */
  private drawGroup(w: Writer, b: Rect, y: number, group: Group, cols: Columns): void {
    this.clear(w, b, y, "surface");
    w.write(at(cols.group, y) + new Style({ fg: "muted", bg: "surface" }).sgr());
    writeEllipsis(w, this.groupName(group), Math.max(0, (cols.who_w ? cols.who : cols.plan) - 2 - cols.group));
    this.drawColumns(w, y, group, cols, cols.group + displayWidth(this.groupName(group)));
  }
  /** Who the group is signed in as, its plan and its limits, in their
   * columns; or a brief without them at the right, past its heading's `end`. */
  private drawColumns(w: Writer, y: number, group: Group, cols: Columns, end: number): void {
    const head = this.headerOf(group);
    if (!head) return;
    const quiet = new Style({ fg: "faint", bg: "surface" }).sgr();
    if (head.who === undefined && head.plan === undefined && head.limits === undefined) {
      const text = shorten(partsOf(head), cols.right - 1 - end);
      if (text) w.write(at(cols.right + 1 - displayWidth(text), y) + quiet + text);
      return;
    }
    const who = this.whoOf(group);
    if (cols.who_w && who) {
      w.write(at(cols.who, y) + quiet);
      writeEllipsis(w, who, cols.who_w);
    }
    if (cols.plan_w && head.plan) {
      w.write(at(cols.plan, y) + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, head.plan, cols.plan_w);
    }
    const limits = shorten(head.limits ?? [], cols.limits_w);
    if (limits) w.write(at(cols.right + 1 - displayWidth(limits), y) + quiet + limits);
  }
  /** One model's row: ✓ on the one in use, its name, what its brief adds,
   * and its effort with "Edit ›"; returns where "Edit ›" went. */
  private drawChoice(w: Writer, b: Rect, y: number, c: Choice, selected: boolean, cols: Columns): Span | null {
    const bg: Token = selected ? "selected" : "surface",
      style = new Style({ fg: selected ? "strong" : "text", bg }).sgr(),
      quiet = new Style({ fg: selected ? "muted" : "faint", bg }).sgr();
    this.clear(w, b, y, bg);
    if (this.current && key(this.current) === key(c))
      w.write(at(cols.model - 2, y) + new Style({ fg: "strong", bg }).sgr() + "✓");
    const levels = this.levels(c),
      note = levels.length ? `${this.effortText(c, this.effortOf(c))}  ${i18n.t`Edit ›`}` : "",
      note_x = cols.right + 1 - displayWidth(note),
      extra = shorten(this.extras(c), Math.max(0, (note ? note_x - 2 : cols.right + 1) - cols.model - 12)),
      end = (note ? note_x - 2 : cols.right + 1) - (extra ? displayWidth(extra) + 2 : 0);
    w.write(at(cols.model, y) + style);
    writeEllipsis(w, nameOf(this.withEffort(c)), Math.max(0, end - cols.model));
    if (extra) w.write(at(end + 2, y) + quiet + extra);
    if (!note) return null;
    w.write(at(note_x, y) + quiet + note);
    return { from: note_x, to: cols.right + 1 };
  }
  /** A pin's row: its glyph where marks go, its name, and its detail at the right. */
  private drawPin(w: Writer, b: Rect, y: number, pin: Pin, selected: boolean, cols: Columns): void {
    const bg: Token = selected ? "selected" : "surface";
    this.clear(w, b, y, bg);
    w.write(at(b.x + 2, y) + new Style({ fg: "strong", bg, bold: true }).sgr());
    writeEllipsis(w, pin.glyph, 2);
    w.write(at(cols.agent, y) + new Style({ fg: selected ? "strong" : "text", bg, bold: true }).sgr());
    writeEllipsis(w, pin.name, Math.max(0, cols.right - cols.agent));
    const detail = shorten(pin.detail, cols.right + 1 - cols.agent - displayWidth(pin.name) - 4);
    if (detail)
      w.write(
        at(cols.right + 1 - displayWidth(detail), y) +
          new Style({ fg: selected ? "muted" : "faint", bg }).sgr() +
          detail,
      );
  }
  /** The effort list → opened: the model and its agent on top, then its
   * levels with ✓ on the one it has, as Manage agents draws them. Returns
   * the row the levels start on. */
  private drawEffort(w: Writer, b: Rect, field: number, top: number, capacity: number, marks: Marks | null): number {
    const edit = this.edit!,
      c = edit.choice,
      right = b.x + b.w - 3,
      g = groupOf(c),
      name = this.groupName(g),
      agent = adapter(c.provider).name + (name ? ` · ${name}` : ""),
      model = nameOf(this.withEffort(c)),
      title = i18n.t`‹ ${model} · Effort`;
    w.write(at(b.x + 2, field) + new Style({ fg: "strong", bg: "surface" }).sgr());
    writeEllipsis(w, title, b.w - 4);
    const tag_x = right + 1 - displayWidth(agent);
    if (tag_x - 3 > b.x + 2 + displayWidth(title)) {
      writeMark(w, c.provider, tag_x - 3, field, marks);
      w.write(at(tag_x, field) + new Style({ fg: "faint", bg: "surface" }).sgr() + agent);
    }
    const start = top + (capacity > edit.levels.length ? 1 : 0),
      room = Math.max(1, top + capacity - start);
    edit.first = clamp(edit.first, edit.at - room + 1, edit.at);
    edit.first = clamp(edit.first, 0, Math.max(0, edit.levels.length - room));
    const current = this.effortOf(c);
    edit.levels.slice(edit.first, edit.first + room).forEach((value, i) => {
      const y = start + i,
        on = edit.first + i === edit.at,
        bg: Token = on ? "selected" : "surface";
      this.clear(w, b, y, bg);
      if (value === current) w.write(at(b.x + 2, y) + new Style({ fg: "strong", bg }).sgr() + "✓");
      w.write(at(b.x + 4, y) + new Style({ fg: on ? "strong" : "text", bg }).sgr());
      writeEllipsis(w, this.effortText(c, value), b.w - 6);
    });
    const thumb = scrollThumb.thumb(room, edit.levels.length, edit.first);
    if (thumb) {
      w.write(new Style({ fg: "line", bg: "surface" }).sgr());
      for (let k = thumb.start; k < thumb.start + thumb.len; k++) w.write(at(b.x + b.w - 1, start + k) + "┃");
    }
    return start;
  }
  /** The search field, always over the list: a `/` keycap, the query and
   * its caret while searching, and how many models there are or match. */
  private drawField(w: Writer, b: Rect, y: number): void {
    const style = new Style({ fg: "text", bg: "selected" }).sgr(),
      x = b.x + 2,
      width = b.w - 4;
    w.write(at(x, y) + style);
    w.splat(" ", width);
    w.write(at(x, y) + keycap + " / " + style + " ");
    const total = this.entries.length,
      found = this.rows.filter(r => r.kind === "choice").length,
      count = this.query !== null ? i18n.t`${found} of ${total}` : total ? i18n.t`${total} models` : "",
      inner = width - 5,
      counted = count !== "" && inner - displayWidth(count) - 2 >= 12,
      room = counted ? inner - displayWidth(count) - 2 : inner;
    let query = this.query ?? "";
    while (query && displayWidth(query) > room - 1) query = [...query].slice(1).join("");
    if (this.query !== null) w.write(query + "\x1b[7m \x1b[27m");
    if (!query && room > 2) {
      const hint = i18n.t`Search models, agents and accounts`;
      w.write(fg("muted"));
      writeEllipsis(w, displayWidth(hint) < room ? hint : i18n.t`Search models`, room - 1);
    }
    if (counted) w.write(at(x + width - 1 - displayWidth(count), y) + fg("muted") + count);
  }
  private drawHints(w: Writer, b: Rect): void {
    const hints: [string, string][] = this.edit
      ? [
          ["←", i18n.t`back`],
          ["⏎", i18n.t`choose effort`],
        ]
      : [
          ...(this.entries.some(e => e.efforts.length) ? [["→", i18n.t`effort`] as [string, string]] : []),
          ["⏎", i18n.t`pick`],
          ["esc", this.query === null ? i18n.t`close` : i18n.t`back`],
        ];
    const size = (list: [string, string][]) =>
      list.reduce((sum, [k, l], i) => sum + displayWidth(k) + 1 + displayWidth(l) + (i ? 3 : 0), 2);
    while (hints.length && size(hints) > b.w - 4) hints.pop();
    if (!hints.length) return;
    const keyStyle = new Style({ fg: "text", bg: "surface", bold: true }).sgr(),
      labelStyle = new Style({ fg: "faint", bg: "surface" }).sgr();
    w.write(at(b.x + 2, b.y + b.h - 1) + labelStyle + " ");
    hints.forEach(([k, l], i) => w.write((i ? labelStyle + " · " : "") + keyStyle + k + labelStyle + " " + l));
    w.write(" ");
  }
}
