//! Machines a viewer can add, and the search over a list of machines that
//! offers them. Under a divider, lists of machines show the hosts this
//! computer's SSH config names that aren't machines yet, and what's typed
//! when nothing listed is named by it. Once typing rests on a host, it's
//! probed over SSH. Adding one sets Corgi up there in a helper and saves it,
//! as `corgi machine add` does; the viewer then shows it beside the others.
import * as machines from "./machines";
import * as machineUpdate from "./machine_update";
import type * as machineProgress from "./machine_progress";
import * as ssh from "./ssh";
import * as errors from "./errors";
import * as i18n from "./i18n";
import * as dropdown from "./dropdown";
import { Style, fg, type Token } from "./palette";
import { Rect } from "./layout";
import { matches } from "./search";
import { Typed } from "./text_area";
import { codepointWidth, displayWidth, writeEllipsis, type Writer } from "./text";

/** An add under way, with its progress, or how it failed: SSH didn't know
 * the host or couldn't log in, or something else, which `summary` names. */
export type State = { adding: machineProgress.Status } | { failed: ssh.Failure; summary: string };
/** A host's probe: how far its login has got since `since`, in
 * `performance.now()` ms, or what it found. */
export type Probe = { stage: ssh.Stage; since: number } | ssh.Probed;
/** How long typing rests on a host before it's probed. */
export const rest_ms = 600;
/** The most a search holds: past any host's name, short of a paste of a log. */
const query_max = 256;
interface Deps {
  hosts: () => string[];
  saved: () => machines.Profile[];
  add: typeof machineUpdate.add;
  probe: typeof ssh.probe;
  rest_ms: number;
}

export class Adds {
  /** The hosts the SSH config named, and saved machines' names and targets, when last read. */
  private hosts: string[] = [];
  private saved: string[] = [];
  /** Adds by machine name. */
  private states = new Map<string, State>();
  private jobs = new Map<string, AbortController>();
  /** Probes by target: those under way, and those done since a list opened. */
  private probes = new Map<string, Probe>();
  /** The host each open list's typing names, probed once typing rests there;
   * lists that name the same host share its probe. */
  private wants = new Map<object, string>();
  private resting = new Map<object, ReturnType<typeof setTimeout>>();
  private probing = new Map<string, AbortController>();
  private readonly deps: Deps;
  /** Told when an add's or a probe's progress or outcome changes. */
  changed: () => void = () => {};
  /** Told with the machine an add saved, for the viewer to show. */
  added: (profile: machines.Profile) => void = () => {};
  constructor(deps: Partial<Deps> = {}) {
    this.deps = {
      hosts: () => ssh.configHosts(),
      saved: () => machines.read(),
      add: machineUpdate.add,
      probe: ssh.probe,
      rest_ms,
      ...deps,
    };
  }
  /** Reads the SSH config and the saved machines again, as a list of
   * machines opens; hosts no list names now are probed afresh. */
  refresh(): void {
    try {
      this.hosts = this.deps.hosts().filter(host => named(host) === host);
    } catch {
      this.hosts = [];
    }
    try {
      this.saved = this.deps.saved().flatMap(profile => [profile.name, profile.target]);
    } catch {
      this.saved = [];
    }
    for (const [target, probe] of this.probes)
      if (!("stage" in probe) && !this.named(target)) this.probes.delete(target);
    // Why an add failed then gives way to what probing finds now.
    for (const [name, state] of this.states) if ("failed" in state && !this.jobs.has(name)) this.states.delete(name);
  }
  /** Whether `target` is a saved machine's name or target. */
  saves(target: string): boolean {
    return this.saved.includes(target);
  }
  /** The hosts that could be machines: neither one of `shown`, by name, nor saved. */
  candidates(shown: readonly string[]): string[] {
    return this.hosts.filter(host => !shown.includes(host) && !this.saved.includes(host));
  }
  state(name: string): State | null {
    return this.states.get(name) ?? null;
  }
  probe(target: string): Probe | null {
    return this.probes.get(target) ?? null;
  }
  /** Adds machine `name`, reached as `target`, unless it's being added; a failed add tries again. */
  start(name: string, target = name): void {
    if (this.jobs.has(name)) return;
    const job = new AbortController();
    this.jobs.set(name, job);
    this.states.set(name, { adding: { message: i18n.t`Checking…` } });
    this.changed();
    this.deps
      .add(name, target, {
        signal: job.signal,
        progress: (message, extra) => {
          if (job.signal.aborted) return;
          this.states.set(name, { adding: { message, ...extra } });
          this.changed();
        },
      })
      .then(
        profile => {
          if (job.signal.aborted) return;
          this.jobs.delete(name);
          this.states.delete(name);
          this.added(profile);
          this.changed();
        },
        error => {
          if (job.signal.aborted) return;
          this.jobs.delete(name);
          this.states.set(name, failure(error));
          this.changed();
        },
      );
  }
  /** Probes `target` once `list`'s typing has rested on it, in place of the
   * host it named before; null names none. A host's probe stops once no list
   * names it, and one probed since a list opened isn't again. */
  want(list: object, target: string | null): void {
    const before = this.wants.get(list) ?? null;
    if (target === before) return;
    clearTimeout(this.resting.get(list));
    this.resting.delete(list);
    if (target === null) this.wants.delete(list);
    else this.wants.set(list, target);
    if (before !== null && !this.named(before)) {
      this.probing.get(before)?.abort();
      this.probing.delete(before);
      // Stopped partway, it found nothing.
      if ("stage" in (this.probes.get(before) ?? {})) this.probes.delete(before);
    }
    if (target !== null && !this.probes.has(target))
      this.resting.set(
        list,
        setTimeout(() => {
          this.resting.delete(list);
          if (!this.probes.has(target)) this.run(target);
        }, this.deps.rest_ms),
      );
    this.changed();
  }
  /** Whether an open list's typing names `target`. */
  private named(target: string): boolean {
    for (const wanted of this.wants.values()) if (wanted === target) return true;
    return false;
  }
  private run(target: string): void {
    const job = new AbortController(),
      since = performance.now();
    this.probing.set(target, job);
    this.probes.set(target, { stage: "connecting", since });
    this.changed();
    const done = (probe: Probe) => {
      if (job.signal.aborted) return;
      this.probing.delete(target);
      this.probes.set(target, probe);
      this.changed();
    };
    this.deps
      .probe(
        target,
        stage => {
          if (job.signal.aborted) return;
          this.probes.set(target, { stage, since });
          this.changed();
        },
        job.signal,
      )
      .then(
        found => found && done(found),
        error => done({ failed: "error", reason: errors.name(error) }),
      );
  }
  /** Stops the adds and the probes under way, as the viewer leaves. */
  close(): void {
    for (const list of [...this.wants.keys(), ...this.resting.keys()]) this.want(list, null);
    for (const job of [...this.jobs.values(), ...this.probing.values()]) job.abort();
    this.jobs.clear();
    this.probing.clear();
  }
}
/** A short reason for a failed add, from what SSH said when it says why. */
function failure(error: unknown): State {
  const detail = error instanceof machineUpdate.Failure ? error.detail : "";
  const summary = error instanceof machineUpdate.Failure ? error.summary : (errors.name(error) ?? "error");
  return { failed: ssh.failure(detail), summary: ssh.reason(detail) ?? summary };
}
/** The machine `target` would be: the host after any user, when it can name one. */
function named(target: string): string | null {
  const name = target.slice(target.lastIndexOf("@") + 1);
  try {
    machines.target(target);
    return machines.name(name);
  } catch {
    return null;
  }
}

/** A row of a list of machines: every machine's workspaces, a machine, the
 * divider, or a host to add, from the SSH config or as `typed` over the list. */
export type Row<T> =
  | { kind: "all" }
  | { kind: "machine"; machine: T }
  | { kind: "divider" }
  | { kind: "host"; name: string; target: string; typed: boolean };
export type HostRow = Extract<Row<unknown>, { kind: "host" }>;

/** A list of machines, then the hosts that could join them, with what's
 * typed over it: typing narrows the list, and offers a host nothing listed
 * names. It keeps the rows it needs for any search, so typing never resizes it. */
export class Listing<T extends { name: string }> {
  /** What's typed; null until something is. */
  query: string | null = null;
  private index = 0;
  /** The highlighted row, which the highlight stays on as rows come and go. */
  private held: Row<T> | null = null;
  private bytes = new Typed();
  private reserved = 0;
  constructor(
    private readonly machines: () => readonly T[],
    readonly adds: Adds | null,
    /** An "all" row first, while nothing is typed. */
    private readonly all = false,
  ) {}
  /** The highlighted row's index. An add that finishes moves its host up
   * among the machines, and the rows between; the highlight keeps to its
   * row, and to the machine a highlighted host became. */
  get cursor(): number {
    const held = this.held;
    if (!held) return this.index;
    const rows = this.rows();
    if (rows[this.index] && sameRow(rows[this.index], held)) return this.index;
    const index = rows.findIndex(
      row => sameRow(row, held) || (held.kind === "host" && row.kind === "machine" && row.machine.name === held.name),
    );
    if (index >= 0) {
      this.index = index;
      this.held = rows[index];
    }
    return this.index;
  }
  set cursor(index: number) {
    this.index = index;
    this.held = this.rows()[index] ?? null;
  }
  /** Opens on row `cursor`, with the SSH config read again. */
  open(cursor = 0): void {
    this.adds?.want(this, null);
    this.adds?.refresh();
    this.query = null;
    this.bytes = new Typed();
    this.reserved = 0;
    this.cursor = cursor;
  }
  /** Forgets what was typed, and stops probing it. */
  close(): void {
    this.query = null;
    this.bytes = new Typed();
    this.adds?.want(this, null);
  }
  private hosts(): string[] {
    return this.adds?.candidates(this.machines().map(machine => machine.name)) ?? [];
  }
  /** The rows `search` lists: what's typed, or with null, all of them. */
  rows(search: string | null = this.query): Row<T>[] {
    const query = search ?? "";
    const offer = this.offer(query),
      hosts = [
        ...this.hosts()
          .filter(host => matches(query, host))
          .map((host): Row<T> => ({ kind: "host", name: host, target: host, typed: false })),
        ...(offer ? [offer] : []),
      ];
    return [
      ...(this.all && !query ? [{ kind: "all" } as const] : []),
      ...this.machines()
        .filter(machine => matches(query, machine.name))
        .map((machine): Row<T> => ({ kind: "machine", machine })),
      ...(hosts.length ? [{ kind: "divider" } as const, ...hosts] : []),
    ];
  }
  row(index = this.cursor): Row<T> | null {
    return this.rows()[index] ?? null;
  }
  /** What's typed, as a host to add, unless it's a machine already, saved or
   * shown, or names one or a host listed: one name, one machine. */
  private offer(query: string): HostRow | null {
    const target = query.trim(),
      name = named(target),
      adds = this.adds;
    if (!adds || !name || adds.saves(target) || adds.saves(name)) return null;
    if (
      this.machines().some(machine => machine.name === name) ||
      this.hosts().some(host => host === target || host === name)
    )
      return null;
    return { kind: "host", name, target, typed: true };
  }
  /** The most rows any search lists; it only grows while the list is open. */
  reserve(): number {
    const shown = this.machines().length,
      hosts = this.hosts().length;
    // Searching drops "all", and can offer what's typed under the hosts.
    this.reserved = Math.max(this.reserved, (this.all ? 1 : 0) + shown + (hosts ? 1 + hosts : 0), shown + 2 + hosts);
    return this.reserved;
  }
  /** Moves `delta` rows, over the divider, no further than either end. */
  move(delta: number): void {
    const rows = this.rows(),
      step = delta < 0 ? -1 : 1;
    let cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
    while (rows[cursor]?.kind === "divider") cursor += step;
    if (cursor >= 0 && cursor < rows.length) this.cursor = cursor;
  }
  /** Takes a key's byte while the list is open: typing, ⌫, ^U and ^W edit
   * what's typed. False for a byte that isn't the search's. */
  key(byte: number): boolean {
    const query = this.query;
    switch (byte) {
      case 8:
      case 127:
        if (query !== null) this.retype(query ? [...query].slice(0, -1).join("") : null);
        return true;
      case 21:
        if (query !== null) this.retype("");
        return true;
      case 23:
        if (query !== null) this.retype(query.replace(/\S*\s*$/u, ""));
        return true;
    }
    // A space only goes in a search under way.
    if (byte < 32 || byte === 127 || (byte === 32 && query === null)) return false;
    const text = this.bytes.take(byte);
    if (text) this.type(text);
    return true;
  }
  /** Types `text`, as a paste does, leaving out controls, and spaces before a search starts. */
  type(text: string): void {
    let clean = text.replace(/[\x00-\x1f\x7f]/g, "");
    if (this.query === null) clean = clean.trimStart();
    if (clean) this.retype([...((this.query ?? "") + clean)].slice(0, query_max).join(""));
  }
  /** Stops searching; false when nothing was typed. */
  leave(): boolean {
    if (this.query === null) return false;
    this.retype(null);
    return true;
  }
  /** Lands on the row named just as typed, else the first; with the search
   * gone, on the row it was on. The host typed is probed once it rests. */
  private retype(query: string | null): void {
    const before = this.row();
    this.query = query;
    const rows = this.rows(),
      typed = query?.trim() ?? "";
    // What's typed is offered as typed: only a row listed anyway counts as named by it.
    const exact = typed ? rows.findIndex(row => !(row.kind === "host" && row.typed) && label(row) === typed) : -1,
      same = rows.findIndex(row => before !== null && sameRow(row, before)),
      first = rows.findIndex(row => row.kind !== "divider");
    this.cursor = Math.max(0, exact >= 0 ? exact : typed ? first : same >= 0 ? same : first);
    const host = rows.find((row): row is HostRow => row.kind === "host" && row.target === typed);
    this.adds?.want(this, host?.target ?? null);
  }
}
function label(row: Row<{ name: string }>): string | null {
  switch (row.kind) {
    case "machine":
      return row.machine.name;
    case "host":
      return row.target;
    default:
      return null;
  }
}
function sameRow<T>(a: Row<T>, b: Row<T>): boolean {
  switch (a.kind) {
    case "machine":
      return b.kind === "machine" && a.machine === b.machine;
    case "host":
      return b.kind === "host" && a.target === b.target;
    default:
      return a.kind === b.kind;
  }
}

/** A row's note and its color. */
export interface Note {
  text: string;
  tone: Token;
}
/** The note for a host's row: what its add is doing or why it failed, else
 * how its probe goes or what it found, else, hovered, that ↵ adds it. */
export function note(state: State | null, probe: Probe | null, hovered: boolean, now = performance.now()): Note {
  if (state && "adding" in state) {
    const { message, compact, metrics } = state.adding;
    return { text: [compact ?? message, metrics].filter(Boolean).join(" "), tone: "warm" };
  }
  if (state) return failed(state.failed, state.summary);
  if (probe && "stage" in probe) {
    const seconds = Math.floor((now - probe.since) / 1000),
      label = stageLabel(probe.stage);
    return { text: seconds ? `${label} ${seconds}s` : label, tone: "warm" };
  }
  if (probe && "system" in probe) return { text: "✓ " + probe.system, tone: "accent" };
  if (probe) return failed(probe.failed, probe.reason ?? i18n.t`failed`);
  return { text: hovered ? i18n.t`add` : "", tone: "faint" };
}
function failed(failure: ssh.Failure, summary: string): Note {
  switch (failure) {
    case "host-key":
      return { text: i18n.t`unknown host key`, tone: "hot" };
    case "auth":
      return { text: i18n.t`can't log in`, tone: "hot" };
    case "error":
      return { text: summary, tone: "hot" };
  }
}
function stageLabel(stage: ssh.Stage): string {
  switch (stage) {
    case "connecting":
      return i18n.t`connecting…`;
    case "authenticating":
      return i18n.t`logging in…`;
    case "running":
      return i18n.t`logged in…`;
  }
}
/** A host's row: its name, or what was typed after a +, and its note. */
export function hostChoice(adds: Adds, row: HostRow, hovered: boolean, now = performance.now()): dropdown.Choice {
  const state = adds.state(row.name),
    probe = adds.probe(row.target),
    { text, tone } = note(state, probe, hovered, now);
  return {
    text: row.typed ? "+ " + row.target : row.name,
    note: text,
    runs: [[text, tone]],
    current: false,
    hovered,
    dim: !row.typed && !state && !probe,
  };
}
export const divider: dropdown.Choice = { text: "", note: "", current: false, hovered: false, divider: true };
/** A list of machines in `box`: the field on its first row, then `choices`
 * a cell in from the border on either side, as the field is. Returns what
 * puts the cursor at the field's end, for the caller to write last: the
 * field has the keys from the moment the list opens. */
export function drawList(w: Writer, box: Rect, choices: dropdown.Choice[], query: string | null): string {
  dropdown.draw(w, box, []);
  const inner = new Rect(box.x + 1, box.y, box.w - 2, box.h);
  choices.forEach((choice, i) => dropdown.row(w, choice.divider ? box : inner, i + 2, choice));
  w.write("\x1b[0m");
  return drawField(w, box, query);
}
/** The field under `box`'s top border: what's typed, or what typing does. */
function drawField(w: Writer, box: Rect, query: string | null): string {
  const style = new Style({ fg: "text", bg: "selected" }).sgr(),
    x = box.x + 2,
    y = box.y + 1,
    width = box.w - 4,
    room = width - 3;
  if (room < 1) return "";
  w.write(`\x1b[${y + 1};${x + 1}H${style}`);
  w.splat(" ", width);
  w.write(`\x1b[${y + 1};${x + 2}H`);
  const shown = tail(query ?? "", room);
  if (shown) w.write(shown);
  else {
    w.write(fg("muted"));
    writeEllipsis(w, i18n.t`Search or type a host`, room);
  }
  w.write("\x1b[0m");
  return `\x1b[0m\x1b[${y + 1};${x + 2 + displayWidth(shown)}H\x1b[?25h`;
}
/** The end of `text` that fits in `room` cells. */
function tail(text: string, room: number): string {
  const chars = [...text];
  let start = chars.length,
    used = 0;
  while (start > 0 && used + codepointWidth(chars[start - 1].codePointAt(0)!) <= room)
    used += codepointWidth(chars[--start].codePointAt(0)!);
  return chars.slice(start).join("");
}
