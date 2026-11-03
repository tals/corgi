//! The prompt's conversation: one headless session the daemon hosts, driven
//! over `headless.*` and folded into the rows the prompt draws. It answers
//! memory edits itself and notices the lines they add.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adapter, type Provider } from "./providers";
import type { Image, Input } from "./providers/adapter";
import type { Effort } from "./providers/effort";
import type { Outcome } from "./observation";
import type { Mention } from "./prompt";
import type { Written } from "./prompt_memory";
import * as errors from "./errors";
import { field, str } from "./json";
import { codepointWidth } from "./text";
import * as promptSearch from "./prompt_search";

export type Item =
  /** What the user typed, and the chips that went with it; `steer` when it
   * went to a turn already running. */
  | { kind: "user"; text: string; chips?: Mention[]; steer?: boolean }
  | { kind: "text"; text: string; partial: boolean }
  | { kind: "tool"; id: string; name: string; summary: string; done: boolean; search?: string }
  | { kind: "search"; search: promptSearch.State }
  | { kind: "ask"; id: string; name: string; summary: string; answer: "allow" | "deny" | null }
  | { kind: "note"; text: string; tone: "faint" | "warm" | "hot"; bone?: boolean };
export interface Daemon {
  /** headless.events, send and stop, on the viewer's shared connection. */
  call(op: string, payload: object): Promise<any>;
  /** headless.start on a connection of its own: it holds until the session has an ID. */
  start(payload: object): Promise<{ provider: Provider; session: string }>;
}
export type State = "idle" | "starting" | "working" | "blocked" | "failed";
/** What the viewer shows for the conversation while the prompt is hidden. */
export type Attention = "none" | "working" | "finished" | "needs_input";
/** What a new session runs with. */
export type Start = {
  provider: Provider;
  account: string;
  model: string;
  effort: Effort | null;
  cwd: string;
  workspace: number | null;
  instructions: string;
  /** False keeps no transcript: /incognito. */
  persist: boolean;
};
/** A conversation as it moves to a Corgi pane: its thread, its session and
 * what it started with, and how far its journal was read. */
export type Handoff = {
  provider: Provider;
  session: string;
  start: Start;
  /** The journal's last read entry, as a decimal; the pane reads on from there. */
  after: string;
  running: boolean;
  items: Item[];
  wrote: Written[];
  used: Used[];
  memory_writes: boolean;
};
/** A session the thread used, and its transcript once Corgi learned where it is. */
export type Used = { provider: Provider; session: string; account: string; persist: boolean; transcript: string };
export type Hooks = {
  /** Whether `path` is in the memory folder, links followed. */
  inside(path: string): boolean;
  /** The memory files a turn may add to, read before and after to see what it wrote. */
  files(): string[];
  /** Whether a whole shell command only looks at Corgi or moves a viewer, so
   * it runs without asking. */
  corgi?(command: string): boolean;
  search?(command: string): boolean;
  /** Where a session's transcript is, "" when Corgi doesn't know; asked while it still runs. */
  transcript?(provider: Provider, session: string, account: string): string;
  read?(path: string): string | null;
  clock?(): number;
  /** Waits `ms` between reads of a session no longer shown. */
  wait?(ms: number): Promise<void>;
};
/** How often events are asked for while a turn runs or starts, and while it's idle. */
export const fast_ms = 200,
  slow_ms = 2000;
const max_items = 400;
type Prompt = Extract<Input, { kind: "prompt" }>;
/** A message for the session: its text, and the images it carries, if any. */
function prompt(text: string, images: Image[]): Prompt {
  return { kind: "prompt", text, ...(images.length ? { images } : {}) };
}
/** The tools whose requests are allowed without asking when they edit one
 * absolute path in the memory folder: Claude Code's file edits. Codex asks
 * about file changes without naming their paths, and Pi and omp don't ask
 * about tools, so theirs always wait for the user. */
const memory_edits: Partial<Record<Provider, string[]>> = { claude: ["Edit", "Write", "MultiEdit", "NotebookEdit"] };
/** The tools whose requests carry a whole shell command as their summary:
 * Claude Code's Bash, and Codex's command approvals. */
const shells: Partial<Record<Provider, string>> = { claude: "Bash", codex: "item/commandExecution/requestApproval" };
const tab_stop = 4;

/** Text from the daemon or memory made safe to measure and draw: escape
 * sequences dropped, tabs expanded, other controls shown as spaces. Line
 * breaks stay in `multiline` text and become spaces elsewhere. */
export function clean(text: string, multiline = false): string {
  const lines = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  return lines.map(expand).join(multiline ? "\n" : " ");
}
function expand(line: string): string {
  let out = "",
    col = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\t") {
      const n = tab_stop - (col % tab_stop);
      out += " ".repeat(n);
      col += n;
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += " ";
      col++;
    } else {
      out += ch;
      col += Math.max(0, codepointWidth(cp));
    }
  }
  return out;
}

type Wire =
  | { kind: "conversation"; session: string; parent: string | null }
  | { kind: "turn"; session: string; phase: "started" }
  | { kind: "turn"; session: string; phase: "ended"; outcome: Outcome }
  | { kind: "message" | "partial"; session: string; text: string }
  | { kind: "tool"; session: string; id: string; done: boolean; name: string; summary: string }
  | promptSearch.Event
  | { kind: "request"; session: string; id: string; name: string; summary: string }
  | { kind: "request_closed"; session: string; id: string; running: boolean }
  | { kind: "ended" };
/** A journal event as the daemon sends it, its text cleaned; null for the
 * ones the prompt ignores. */
function wire(value: unknown): Wire | null {
  const session = str(value, "session");
  switch (str(value, "kind")) {
    case "search": {
      const search = promptSearch.parse(field(value, "search"));
      return search ? { kind: "search", session, search } : null;
    }
    case "conversation":
      return { kind: "conversation", session, parent: str(value, "parent") || null };
    case "turn": {
      if (str(value, "phase") === "started") return { kind: "turn", session, phase: "started" };
      const outcome = str(value, "outcome");
      return {
        kind: "turn",
        session,
        phase: "ended",
        outcome: outcome === "interrupted" || outcome === "failed" ? outcome : "completed",
      };
    }
    case "message":
    case "partial":
      return { kind: str(value, "kind") as "message" | "partial", session, text: clean(str(value, "text"), true) };
    case "tool":
      return {
        kind: "tool",
        session,
        id: str(value, "id"),
        done: field(value, "done") === true,
        name: clean(str(value, "name")),
        summary: clean(str(value, "summary")),
      };
    case "request":
      return { kind: "request", session, id: str(value, "id"), ...ask(field(value, "ask")) };
    case "request_closed":
      return { kind: "request_closed", session, id: str(value, "id"), running: field(value, "running") === true };
    case "ended":
      return { kind: "ended" };
    default:
      return null;
  }
}
/** What a request asks, as the journal and the pending list send it. The
 * summary stays raw: it is checked as a path before it is shown. */
function ask(value: unknown): { name: string; summary: string } {
  return { name: str(value, "name"), summary: str(value, "summary") };
}
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
/** The lines of a memory file that say something: no blanks, no headings. */
function said(text: string | null): string[] {
  return (text ?? "").split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#"));
}
/** The lines `after` adds to `before`: new ones, and ones that replace a
 * line `before` had. Where lines were both removed and added, as many of
 * the added as were removed count as edits. */
export function changes(before: string[], after: string[]): { added: string[]; edited: string[] } {
  let start = 0,
    end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const old = before.slice(start, before.length - end),
    now = after.slice(start, after.length - end);
  if (!now.length || !old.length) return { added: now, edited: [] };
  // Too long to compare: none of it counts as new.
  if (old.length * now.length > 250_000) return { added: [], edited: now };
  const longest = Array.from({ length: old.length + 1 }, () => new Uint32Array(now.length + 1));
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = now.length - 1; j >= 0; j--)
      longest[i][j] = old[i] === now[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
  const out = { added: [] as string[], edited: [] as string[] };
  let removed = 0,
    inserted: string[] = [];
  const flush = () => {
    out.edited.push(...inserted.slice(0, removed));
    out.added.push(...inserted.slice(removed));
    removed = 0;
    inserted = [];
  };
  for (let i = 0, j = 0; i < old.length || j < now.length;) {
    if (i < old.length && j < now.length && old[i] === now[j]) {
      flush();
      i++;
      j++;
    } else if (j < now.length && (i >= old.length || longest[i][j + 1] >= longest[i + 1][j])) inserted.push(now[j++]);
    else {
      removed++;
      i++;
    }
  }
  flush();
  return out;
}
/** A memory line as a row shows it, without its list marker. */
export function shownLine(line: string): string {
  return line.replace(/^\s*[-*]\s+(\[[ x]\]\s+)?/, "").trim();
}
/** What a failed start says, by the daemon's error. */
function startFailure(error: unknown, provider: Provider): string {
  const name = adapter(provider).name;
  switch (errors.name(error)) {
    case "HeadlessUnsupported":
      return `${name} can't run without a terminal yet. Pick another model with ⇥.`;
    case "HeadlessExited":
      return `${name} exited before it started. Check that it's installed and signed in.`;
    case "HeadlessStartTimeout":
      return `${name} didn't start within a minute.`;
    case "TooManyHeadlessSessions":
      return "Corgi already runs 16 sessions without a terminal. Stop one first.";
    case "UnknownOperation":
    case "UnknownField":
      return "Corgi's daemon is older than this viewer. Reload it to use the prompt.";
    default:
      return `${name} didn't start: ${errors.name(error) ?? "unknown error"}.`;
  }
}
const gone = (error: unknown) => errors.is(error, "NoHeadlessSession") || errors.is(error, "HeadlessExited");

export class Conversation {
  items: Item[] = [];
  provider: Provider | null = null;
  /** The provider's session ID; "" until one starts, and after it ends. */
  session = "";
  /** What the session runs with. */
  started: Start | null = null;
  /** Off for /incognito: memory edits are denied. */
  memory_writes = true;
  /** Memory lines this conversation added, for /erase. */
  wrote: Written[] = [];
  /** Every session the thread used, ended ones too, for /erase. */
  used: Used[] = [];
  /** A start under way: the session it makes, or null when it fails. */
  launching: Promise<Used | null> | null = null;
  /** When the running turn began, by the hooks' clock. */
  working_since = 0;
  /** The pane a Corgi chat runs in: its reads claim the session for it. */
  claim: number | null = null;
  /** Called when a reply changed something, for a viewer waiting on input. */
  changed: () => void = () => {};
  private starting = false;
  private failed = false;
  private running = false;
  /** Stop was asked and the turn hasn't ended yet. */
  private stop_asked = false;
  private unread = false;
  /** Reading back a session it attached to: what it finds was seen before. */
  private replaying = false;
  private queued: Prompt[] = [];
  private after = 0n;
  private next_at = 0;
  /** Something was sent while events were being read: read again at once. */
  private hurry = false;
  private inflight = false;
  private dirty = false;
  /** Bumped whenever the session is dropped, so late replies for it are ignored. */
  private generation = 0;
  private children = new Set<string>();
  /** Requests answered from here, which the pending list may still name. */
  private answered = new Set<string>();
  private warned = new Set<string>();
  /** Memory files as they read when the turn began. */
  private snapshots = new Map<string, string[]>();
  private readonly read: (path: string) => string | null;
  private readonly clock: () => number;
  constructor(
    readonly daemon: Daemon,
    readonly hooks: Hooks,
  ) {
    this.read = hooks.read ?? readText;
    this.clock = hooks.clock ?? Date.now;
  }
  get state(): State {
    if (this.failed) return "failed";
    if (this.starting) return "starting";
    if (this.pending()) return "blocked";
    return this.running ? "working" : "idle";
  }
  /** A stop was asked and the turn is still winding down. */
  get stopping(): boolean {
    return this.stop_asked && (this.starting || this.running);
  }
  /** The first request still waiting on an answer. */
  pending(): Extract<Item, { kind: "ask" }> | null {
    for (const item of this.items) if (item.kind === "ask" && item.answer === null) return item;
    return null;
  }
  /** The newest tool still running. */
  tool(): Extract<Item, { kind: "tool" }> | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === "user") break;
      if (item.kind === "tool" && !item.done) return item;
    }
    return null;
  }
  search(): promptSearch.State | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === "user") break;
      if (item.kind === "search" && !promptSearch.finished(item.search)) return item.search;
    }
    return null;
  }
  attention(): Attention {
    if (this.pending()) return "needs_input";
    if (this.starting || this.running) return "working";
    return this.unread ? "finished" : "none";
  }
  /** The user saw the reply. */
  seen(): void {
    this.unread = false;
  }
  note(text: string, tone: "faint" | "warm" | "hot", bone = false): void {
    text = clean(text);
    this.push(bone ? { kind: "note", text, tone, bone } : { kind: "note", text, tone });
    this.dirty = true;
  }
  /** Sends `text`, starting a session with `start()` when none runs. With
   * attachments the model gets `attached.message` and the thread shows the
   * text after their chips; `images` go along to the model as images. */
  send(text: string, start: () => Start, attached?: { message: string; chips: Mention[] }, images: Image[] = []): void {
    text = clean(text, true);
    const message = attached ? clean(attached.message, true) : text;
    this.push({
      kind: "user",
      text,
      ...(attached?.chips.length ? { chips: attached.chips } : {}),
      ...(this.starting || this.running ? { steer: true } : {}),
    });
    this.dirty = true;
    this.unread = false;
    if (this.starting) {
      this.queued.push(prompt(message, images));
      return;
    }
    this.snapshot();
    if (!this.session) return this.begin(prompt(message, images), start());
    this.running = true;
    this.working_since = this.clock();
    this.soon();
    this.input(prompt(message, images));
  }
  answer(id: string, allow: boolean): void {
    const ask = this.items.find(item => item.kind === "ask" && item.id === id);
    if (ask?.kind !== "ask" || ask.answer !== null) return;
    ask.answer = allow ? "allow" : "deny";
    this.answered.add(id);
    this.dirty = true;
    this.soon();
    this.input({ kind: "answer", request: id, allow });
  }
  interrupt(): void {
    // A session still starting stops once it has an ID, and runs nothing queued.
    if (this.starting) {
      this.stop_asked = true;
      this.queued = [];
      this.dirty = true;
    } else if (this.session && (this.running || this.pending())) {
      this.stop_asked = true;
      this.dirty = true;
      this.input({ kind: "interrupt" });
    }
  }
  /** Ends the session; the thread stays. */
  stop(): Promise<void> {
    const provider = this.provider,
      session = this.session;
    this.drop();
    return provider && session ? this.end(provider, session) : Promise.resolve();
  }
  /** Stops a session, whether or not it still runs. */
  end(provider: Provider, session: string): Promise<void> {
    return this.daemon.call("headless.stop", { provider, session }).then(
      () => {},
      error => {
        if (!errors.is(error, "NoHeadlessSession")) throw error;
      },
    );
  }
  /** Ends the session and forgets the thread. With `flush`, a session left
   * idle after an exchange is told it first, unseen, and stopped once that
   * turn ends: OpenClaw's memory flush. */
  reset(flush: string | null = null): Promise<void> {
    const provider = this.provider,
      session = this.session,
      after = this.after,
      flushing = flush && provider && session && this.state === "idle" && this.items.some(i => i.kind === "user");
    let stopped: Promise<void>;
    if (flushing) {
      this.drop();
      stopped = this.flushThenEnd(provider, session, after, flush);
    } else stopped = this.stop();
    this.items = [];
    this.wrote = [];
    this.used = [];
    this.launching = null;
    this.unread = false;
    this.failed = false;
    this.dirty = true;
    return stopped;
  }
  /** Sends `text` to a session no longer shown, answers what it asks (a safe
   * Corgi command yes, anything else no), and stops it when that turn ends,
   * or after a minute. */
  private async flushThenEnd(provider: Provider, session: string, after: bigint, text: string): Promise<void> {
    const wait = this.hooks.wait ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms))),
      deadline = this.clock() + 60_000,
      answered = new Set<string>();
    try {
      const before: any = await this.daemon.call("headless.events", { provider, session, after });
      let seen = BigInt(before?.next_seq ?? 1) - 1n;
      await this.daemon.call("headless.send", { provider, session, input: { kind: "prompt", text } });
      for (let ended = false; !ended && this.clock() < deadline;) {
        await wait(500);
        const reply: any = await this.daemon.call("headless.events", { provider, session, after: seen });
        for (const e of reply?.events ?? []) {
          seen = BigInt(e.seq);
          const event = wire(e.event);
          if (event?.kind === "turn" && event.phase === "ended") ended = true;
        }
        for (const request of reply?.pending_requests ?? []) {
          const id = str(request, "id"),
            { name, summary } = ask(field(request, "ask"));
          if (answered.has(id)) continue;
          answered.add(id);
          await this.daemon.call("headless.send", {
            provider,
            session,
            input: { kind: "answer", request: id, allow: this.corgiCommand(name, summary, provider) },
          });
        }
      }
    } catch {}
    await this.end(provider, session).catch(() => {});
  }
  /** What a Corgi pane needs to go on with this conversation; null until a session runs. */
  handoff(): Handoff | null {
    if (!this.provider || !this.session || !this.started) return null;
    return {
      provider: this.provider,
      session: this.session,
      start: this.started,
      after: String(this.after),
      running: this.running,
      items: this.items,
      wrote: this.wrote,
      used: this.used,
      memory_writes: this.memory_writes,
    };
  }
  /** Lets the session go on elsewhere: the thread clears and it keeps running. */
  release(): void {
    this.drop();
    this.provider = null;
    this.items = [];
    this.wrote = [];
    this.used = [];
    this.launching = null;
    this.unread = false;
    this.failed = false;
    this.dirty = true;
  }
  /** Goes on with a conversation handed over: its thread, and its session
   * read on from where it was, so nothing shows twice. */
  adopt(h: Handoff): void {
    this.drop();
    this.items = h.items;
    this.wrote = h.wrote;
    this.used = h.used;
    this.memory_writes = h.memory_writes;
    this.provider = h.provider;
    this.session = h.session;
    this.started = h.start;
    this.running = h.running;
    this.after = BigInt(h.after);
    this.dirty = true;
  }
  /** Follows a session the daemon already runs, such as one this viewer
   * started before it reloaded. What its journal holds was seen then. */
  attach(start: Start, session: string, running: boolean): void {
    this.drop();
    this.provider = start.provider;
    this.session = session;
    this.started = start;
    this.running = running;
    this.replaying = true;
    if (!this.used.some(u => u.provider === start.provider && u.session === session))
      this.used.push({
        provider: start.provider,
        session,
        account: start.account,
        persist: start.persist,
        transcript: "",
      });
  }
  /** Asks for events when they're due; true when something changed since the last call. */
  poll(now: number): boolean {
    if (this.session && !this.inflight && now >= this.next_at) {
      this.inflight = true;
      this.hurry = false;
      const generation = this.generation;
      void this.fetch(generation).finally(() => {
        if (generation !== this.generation) return;
        this.inflight = false;
        this.next_at = this.hurry ? 0 : now + (this.running || this.pending() ? fast_ms : slow_ms);
        this.changed();
      });
    }
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }
  private soon(): void {
    this.next_at = 0;
    this.hurry = true;
  }
  private push(item: Item): void {
    this.items.push(item);
    if (this.items.length > max_items) this.items.splice(0, this.items.length - max_items);
  }
  /** Learns the transcripts of the sessions it used, while the daemon still knows them. */
  private capture(): void {
    for (const u of this.used)
      if (u.persist && !u.transcript) u.transcript = this.hooks.transcript?.(u.provider, u.session, u.account) ?? "";
  }
  /** Forgets the session, leaving the thread. */
  private drop(): void {
    this.capture();
    this.generation++;
    this.session = "";
    this.started = null;
    this.starting = false;
    this.running = false;
    this.stop_asked = false;
    this.replaying = false;
    this.inflight = false;
    this.queued = [];
    this.after = 0n;
    this.next_at = 0;
    this.children.clear();
    this.answered.clear();
    this.snapshots.clear();
    for (const item of this.items) {
      if (item.kind === "ask" && item.answer === null) item.answer = "deny";
      if (item.kind === "tool") item.done = true;
      if (item.kind === "search" && !promptSearch.finished(item.search))
        item.search = { ...item.search, phase: "cancelled" };
      if (item.kind === "text") item.partial = false;
    }
  }
  private begin(first: Prompt, start: Start): void {
    this.failed = false;
    this.starting = true;
    this.stop_asked = false;
    this.started = start;
    this.provider = start.provider;
    this.working_since = this.clock();
    const generation = this.generation;
    const launch: Promise<Used | null> = this.daemon
      .start({
        provider: start.provider,
        prompt: first.text,
        ...(first.images ? { images: first.images } : {}),
        cwd: start.cwd,
        workspace: start.workspace,
        account: start.account,
        model: start.model,
        effort: start.effort ?? "",
        instructions: start.instructions,
        persist: start.persist,
        corgi: true,
      })
      .then(
        reply => {
          const used: Used = {
            provider: reply.provider,
            session: reply.session,
            account: start.account,
            persist: start.persist,
            transcript: "",
          };
          if (generation !== this.generation) {
            // Dropped while it started: it isn't wanted any more.
            void this.end(reply.provider, reply.session).catch(() => {});
            return used;
          }
          this.starting = false;
          this.provider = reply.provider;
          this.session = reply.session;
          this.used.push(used);
          this.running = true;
          this.soon();
          if (this.stop_asked) this.input({ kind: "interrupt" });
          else for (const queued of this.queued.splice(0)) this.input(queued);
          return used;
        },
        error => {
          if (generation === this.generation) {
            this.starting = false;
            this.started = null;
            this.failed = true;
            this.queued = [];
            this.note(startFailure(error, start.provider), "hot");
          }
          return null;
        },
      )
      .finally(() => {
        if (this.launching === launch) this.launching = null;
        this.dirty = true;
        this.changed();
      });
    this.launching = launch;
  }
  private input(input: Input): void {
    const provider = this.provider,
      session = this.session,
      generation = this.generation;
    if (!provider || !session) return;
    this.daemon.call("headless.send", { provider, session, input }).catch(error => {
      if (generation !== this.generation || errors.is(error, "NoRequest")) return;
      if (gone(error)) {
        // A message for a session that ended starts the next one.
        const start = this.started;
        if (input.kind === "prompt" && start) {
          this.lost("The session had ended, so your message started a new one.");
          this.snapshot();
          this.begin(input, start);
        } else this.lost();
      } else this.note(`Couldn't reach ${adapter(provider).name}: ${errors.name(error) ?? "unknown error"}.`, "hot");
      this.changed();
    });
  }
  private async fetch(generation: number): Promise<void> {
    let reply: any;
    try {
      reply = await this.daemon.call("headless.events", {
        provider: this.provider,
        session: this.session,
        after: this.after,
        pane: this.claim,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (errors.is(error, "NoHeadlessSession")) return this.lost();
      const name = errors.name(error) ?? "unknown error";
      if (!this.warned.has(name)) {
        this.warned.add(name);
        this.note(`Couldn't read the session: ${name}.`, "hot");
      }
      return;
    }
    if (generation !== this.generation) return;
    this.warned.clear();
    const pending: unknown[] | null = Array.isArray(reply?.pending_requests) ? reply.pending_requests : null,
      open = pending ? new Set(pending.map(request => str(request, "id"))) : null;
    for (const entry of Array.isArray(reply?.events) ? reply.events : []) {
      const seq = BigInt(field(entry, "seq") ?? 0);
      if (seq <= this.after) continue;
      this.after = seq;
      const e = wire(field(entry, "event"));
      // A request the reply no longer lists was answered or closed.
      if (e && !(e.kind === "request" && open && !open.has(e.id))) this.apply(e);
      if (generation !== this.generation) return;
    }
    if (pending) this.reconcile(pending);
    if (this.replaying) {
      this.replaying = false;
      this.unread = false;
    }
  }
  /** Whether an event speaks for the conversation the prompt shows, not a subagent's. */
  private root(session: string): boolean {
    return !session || session === this.session || !this.children.has(session);
  }
  private apply(e: Wire): void {
    this.dirty = true;
    switch (e.kind) {
      case "search": {
        if (e.session !== this.session) return;
        const tool = this.tool();
        if (tool && this.hooks.search?.(tool.summary)) tool.search = e.search.id;
        const item = this.items.find(i => i.kind === "search" && i.search.id === e.search.id);
        if (item?.kind === "search") {
          if (!promptSearch.finished(item.search) && e.search.revision > item.search.revision) item.search = e.search;
        } else this.push({ kind: "search", search: e.search });
        return;
      }
      case "conversation":
        if (e.parent) this.children.add(e.session);
        return;
      case "turn":
        if (!this.root(e.session)) return;
        if (e.phase === "started") {
          if (!this.running) this.working_since = this.clock();
          this.running = true;
          // A stop asked before the turn began reaches it now.
          if (this.stop_asked) this.input({ kind: "interrupt" });
          return;
        }
        this.running = false;
        this.stop_asked = false;
        this.unread = true;
        for (const item of this.items) if (item.kind === "text") item.partial = false;
        for (const item of this.items) if (item.kind === "tool") item.done = true;
        for (const item of this.items)
          if (item.kind === "search" && !promptSearch.finished(item.search))
            item.search = { ...item.search, phase: "cancelled" };
        this.notice();
        this.capture();
        if (e.outcome === "interrupted") this.note("Stopped.", "faint");
        else if (e.outcome === "failed") this.note("The turn failed.", "hot");
        return;
      case "partial":
      case "message": {
        if (!this.root(e.session) || !e.text) return;
        const open = this.openText();
        if (open) {
          open.text = e.text;
          open.partial = e.kind === "partial";
        } else this.push({ kind: "text", text: e.text, partial: e.kind === "partial" });
        return;
      }
      case "tool": {
        const found = this.items.find(item => item.kind === "tool" && item.id === e.id);
        if (found?.kind === "tool") {
          found.done ||= e.done;
          found.name ||= e.name;
          found.summary ||= e.summary;
        } else if (e.id && e.name && !this.memoryEdit(e.name, e.summary))
          // A memory edit shows as the lines it adds instead. An item that
          // ends with no tool's name, as Codex's messages do, isn't a tool.
          this.push({ kind: "tool", id: e.id, name: e.name, summary: e.summary, done: e.done });
        if (e.done) this.notice();
        return;
      }
      case "request":
        return this.request(e.id, e.name, e.summary);
      case "request_closed": {
        const index = this.items.findIndex(item => item.kind === "ask" && item.id === e.id && item.answer === null);
        if (index >= 0) this.items.splice(index, 1);
        if (!this.pending()) this.running = e.running;
        return;
      }
      case "ended":
        return this.lost();
    }
  }
  /** The reply text still being written: the newest text since the last
   * prompt, while it's partial. Tool rows and steers can come between: a
   * steer joins the turn, whose text block streams on. */
  private openText(): Extract<Item, { kind: "text" }> | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === "user" && !item.steer) return null;
      if (item.kind === "text") return item.partial ? item : null;
    }
    return null;
  }
  private request(id: string, name: string, summary: string): void {
    if (!id || this.answered.has(id) || this.items.some(item => item.kind === "ask" && item.id === id)) return;
    if (this.memoryEdit(name, summary)) {
      this.answered.add(id);
      this.input(
        this.memory_writes
          ? { kind: "answer", request: id, allow: true }
          : {
              kind: "answer",
              request: id,
              allow: false,
              message: "This conversation is incognito: don't write memory.",
            },
      );
      return;
    }
    if (this.corgiCommand(name, summary)) {
      this.answered.add(id);
      this.input({ kind: "answer", request: id, allow: true });
      return;
    }
    this.push({ kind: "ask", id, name: clean(name) || "Tool", summary: clean(summary), answer: null });
  }
  /** Whether a tool is a file edit whose summary is one absolute path in
   * the memory folder. Commands, searches and relative paths never are. */
  private memoryEdit(name: string, summary: string): boolean {
    const edits = this.provider ? (memory_edits[this.provider] ?? []) : [];
    return edits.includes(name) && isAbsolute(summary) && clean(summary) === summary && this.hooks.inside(summary);
  }
  /** Whether a request is a shell running one Corgi command that only looks
   * or moves a viewer. */
  private corgiCommand(name: string, summary: string, provider = this.provider): boolean {
    const shell = provider ? shells[provider] : undefined;
    return !!shell && name === shell && clean(summary) === summary && (this.hooks.corgi?.(summary) ?? false);
  }
  /** Requests the journal no longer holds, and ones answered elsewhere. */
  private reconcile(pending: unknown[]): void {
    const ids = new Set<string>();
    for (const request of pending) {
      const id = str(request, "id"),
        { name, summary } = ask(field(request, "ask"));
      ids.add(id);
      this.request(id, name, summary);
    }
    const before = this.items.length;
    this.items = this.items.filter(item => item.kind !== "ask" || item.answer !== null || ids.has(item.id));
    if (this.items.length !== before) this.dirty = true;
  }
  /** The session is gone or ended: say so, and stop what's left of it. */
  private lost(text = "The session ended. Your next message starts a new one."): void {
    const provider = this.provider,
      session = this.session;
    if (!provider || !session) return;
    this.drop();
    void this.end(provider, session).catch(() => {});
    this.note(text, "faint");
  }
  private snapshot(): void {
    this.snapshots.clear();
    if (!this.memory_writes) return;
    for (const path of this.hooks.files()) this.snapshots.set(path, said(this.read(path)));
  }
  /** Rows for the memory lines the turn wrote since the last look. Only new
   * lines count as its own; an edited line was the user's first. */
  private notice(): void {
    for (const [path, before] of this.snapshots) {
      const after = said(this.read(path)),
        { added, edited } = changes(before, after);
      this.snapshots.set(path, after);
      for (const line of added) {
        this.wrote.push({ file: path, line });
        this.note("remembered " + shownLine(line), "faint", true);
      }
      for (const line of edited) this.note("edited " + shownLine(line), "faint", true);
    }
  }
}
