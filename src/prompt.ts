//! The Corgi prompt: a card over the panes, opened with Prefix Space, where an
//! agent runs without a terminal and Corgi draws the conversation. The corgi
//! is its prompt glyph; Tab picks the model, `/` lists commands and `@`
//! attaches an agent's screen, the selection or the diff. Menus open as
//! popovers, so the card keeps its size and place. In a Corgi pane the
//! same card fills the pane and goes on with a conversation handed to it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { double_click_ms } from "./clock";
import * as frames from "./corgi_frames";
import * as dropdown from "./dropdown";
import * as errors from "./errors";
import * as json from "./json";
import * as keys from "./keys";
import * as launcherResume from "./launcher_resume";
import * as palette from "./palette";
import * as piLocations from "./providers/pi/locations";
import * as ompLocations from "./providers/omp/locations";
import * as claudeHistory from "./providers/claude/history";
import { Rect } from "./layout";
import { Provider, adapter } from "./providers";
import * as effort from "./providers/effort";
import type { Effort } from "./providers/effort";
import * as conversations from "./prompt_conversations";
import * as markdown from "./prompt_markdown";
import * as reviewPanel from "./review/panel";
import * as reference from "./review/reference";
import { Memory, flush as memoryFlush } from "./prompt_memory";
import * as promptTools from "./prompt_tools";
import * as promptSearch from "./prompt_search";
import { Picker, label, type Brief, type Choice, type Entry, type Pin, type Result } from "./model_picker";
import { writeMark, type Marks } from "./provider_mark";
import {
  Conversation,
  clean,
  shownLine,
  type Attention,
  type Daemon,
  type Handoff,
  type Item,
  type Start,
  type State,
} from "./prompt_session";
import { matches } from "./search";
import * as linkThumbnail from "./link_thumbnail";
import { View as MemoryView, type Result as MemoryResult } from "./memory_view";
import { thumbnailCells, type Thumbnail } from "./link_tooltip";
import { TextArea, byte_edits, key_edits } from "./text_area";
import { Writer, clamp, clipped, displayWidth, ellipsis } from "./text";

/** What `@` attaches: an agent's recent screen, the text selected in a
 * pane, or the workspace's uncommitted changes. */
/** Where a mention belongs, when it isn't the workspace the prompt opened in;
 * `@` offers it once its workspace is attached. */
type Elsewhere = { workspace?: { id: number; name: string } };
export type Mention =
  | ({ kind: "agent"; pane: number; name: string; provider: Provider | null; activity: string } & Elsewhere)
  | ({ kind: "selection"; pane: number; name: string } & Elsewhere)
  | ({ kind: "diff"; cwd: string } & Elsewhere)
  /** Another workspace: its overview, and what it holds for `@`. */
  | { kind: "workspace"; id: number; name: string; cwd: string }
  /** A pasted image, which goes to the model as an image. */
  | { kind: "image"; path: string; mime: string; name: string };
/** Where the prompt was opened, for its chips and the session's instructions. */
export type Context = {
  cwd: string;
  workspace: string;
  /** The workspace the session belongs to, for the daemon. */
  workspace_id: number | null;
  branch: string;
  focus: { title: string; provider: Provider | null; activity: string; pane: number | null } | null;
  herd: { name: string; state: string; activity: string }[];
  /** What `@` offers here: the workspace's agents, the selection, the diff. */
  mentions: Mention[];
};
export type Effect =
  /** The card hid; in a pane, the chat ends. */
  | { kind: "close" }
  /** /pane, /memory: open a tab running this. */
  | { kind: "pane"; argv: string[]; cwd: string }
  /** Persist the last pick; null follows Auto. */
  | { kind: "pick"; choice: Choice | null }
  /** A drag selected this: put it on the clipboard. */
  | { kind: "copy"; text: string }
  /** A reply's list picked a conversation: show the pane running it, or resume it. */
  | { kind: "open"; entry: launcherResume.Entry };
export type Deps = {
  daemon: Daemon;
  /** The memory folder: `Memory.root()` outside tests. */
  memory_root: string;
  /** The transcript the daemon knows for a session, "" when it knows none. */
  transcript?(provider: Provider, session: string): string;
  /** What an attachment holds: a pane's screen, the selected text, the diff. */
  resolve?(mention: Mention): Promise<string>;
  clock?(): number;
  /** The card over the panes, or a Corgi chat filling a pane of its own. */
  mode?: Mode;
  /** The pane a Corgi chat runs in, which its reads claim the session for. */
  pane?: number | null;
  /** The viewer the card shows in, which the model points `corgi` commands at. */
  viewer?(): number | null;
  /** The corgi executable the model drives Corgi with. */
  binary?: string;
  /** The conversations Corgi knows, for the lists replies show; the same
   * object while they don't change. */
  conversations?(): launcherResume.Context | null;
};
/** Where the prompt draws: a card over the panes, or a pane of its own. */
export type Mode = "overlay" | "pane";
/** The prompt's session as the mirror lists it, for a viewer that reloaded. */
export type Resumed = {
  provider: Provider;
  session: string;
  cwd: string;
  workspace: number;
  state: string;
  account: string;
  model: string;
  effort: Effort | null;
  persist: boolean;
};
export type Command = "forgetmenow" | "remember" | "forget" | "dig" | "pane" | "close" | "incognito" | "memory" | "new";
const commands: { name: Command; about: string; takes: boolean }[] = [
  { name: "forgetmenow", about: "burn this chat, keep nothing", takes: false },
  { name: "remember", about: "bury a note in memory", takes: true },
  { name: "forget", about: "dig up a memory and drop it", takes: true },
  { name: "dig", about: "search memory", takes: true },
  { name: "pane", about: "go on in a pane of its own", takes: false },
  { name: "close", about: "end this chat and close the pane", takes: false },
  { name: "incognito", about: "keep nothing from here on", takes: false },
  { name: "memory", about: "edit what Corgi remembers", takes: false },
  { name: "new", about: "fresh conversation", takes: false },
];
/** The commands a mode offers: the card moves to a pane, a pane closes. */
function offered(mode: Mode) {
  return commands.filter(c => c.name !== (mode === "pane" ? "pane" : "close"));
}
export function parseCommand(word: string, mode: Mode = "overlay"): Command | null {
  return offered(mode).find(c => c.name === word)?.name ?? null;
}
/** Commands whose names start with `typed`, then ones that contain it. */
export function matching(typed: string, mode: Mode = "overlay"): Command[] {
  const names = offered(mode).map(c => c.name);
  return [...names.filter(n => n.startsWith(typed)), ...names.filter(n => !n.startsWith(typed) && n.includes(typed))];
}
/** Ears up while the conversation needs an answer. */
const ears = ["^ᐱ•ᴥ•ᐱ", "^ᐱ•ᴥ•ᐱ", "~ᐱ•ᴥ•ᐱ", "~ᐱ•ᴥ•ᐱ", "-ᐱ•ᴥ•ᐱ", "-ᐱ•ᴥ•ᐱ", "~ᐱ•ᴥ•ᐱ", "~ᐱ•ᴥ•ᐱ"];
/** The caret, and the text after it; the corgi sits on the frame above. */
const caret_x = 0,
  text_x = 2;
const max_w = 84,
  max_input_rows = 6,
  burn_ms = 2000,
  /** How long a message waits for its attachments to be read. */
  attach_ms = 3000;
const placeholder = "Ask Corgi anything, @ to add context";
/** The states with a turn under way: Ctrl+C stops it, and a message steers it. */
const busy = new Set<State>(["starting", "working", "blocked"]);
/** The longest an `@` search runs before it's taken for text. */
const mention_query = 40;
/** The longest a chip's name goes in the input row. */
const chip_name_w = 14;

type Seg = markdown.Seg;
/** A thread row: its runs, a fill across the card, hints at the right edge,
 * the request those hints answer, and the chips a message leads with. A row
 * that goes on with the line above when copied says what joins them and how
 * many of its columns are only indent. */
type Row = {
  segs: Seg[];
  fill?: string;
  right?: Seg[];
  ask?: string;
  chips?: Inline;
  cont?: { join: string; skip: number };
  /** Row `k` of a reply's list of conversations, which draws it. */
  list?: { list: conversations.List; k: number };
  search?: promptSearch.Match;
  searchToggle?: string;
  frame?: "top" | "body" | "bottom";
  label?: string;
};
/** A thread row as drawn, and a column from its left. */
type Spot = { row: number; col: number };
/** What a press picks: its cell, or with a double or triple click its word or line. */
type Unit = "cell" | "word" | "line";
/** What a drag selected: thread rows between two spots, laid out `room`
 * wide; or offsets into the input, which keeps the selection itself. A
 * drag reaches from what the press picked, `from` its `unit` to the one
 * under the pointer. `held` until the button's up. */
type Selection =
  | { on: "thread"; unit: Unit; picked: [Spot, Spot]; from: Spot; to: Spot; room: number; held: boolean }
  | { on: "input"; unit: Unit; picked: [number, number]; held: boolean };
type Layout = {
  box: Rect;
  left: number;
  right: number;
  thread: Rect | null;
  input_y: number;
  input_rows: number;
  /** The chips at the start of the input row, and where the typed text starts after them. */
  chips: Inline;
  footer_y: number;
  rules: number[];
  /** The open menu or picker, over the thread or hanging off the card. */
  panel: Rect | null;
};
/** The picture of a pasted image: whether the host shows pictures, and this
 * one's, once it has loaded. */
export type Preview = { pictures: boolean; thumbnail: Thumbnail | null };
/** Chips laid out in a row: each with its name cut to fit, then how many
 * didn't fit, and the columns they all take with the gap after. */
type Inline = { pieces: { mention: Mention; text: string; x: number }[]; more: number; width: number };
/** An attachment waiting for the next message, and what it read. */
type Chip = {
  mention: Mention;
  /** Added for where the prompt opened, and replaced when it opens elsewhere. */
  auto: boolean;
  body: string | null;
  error: string | null;
  pending: Promise<void> | null;
};
/** The menu the input shows: commands after a leading `/`, or what `@word` can attach. */
type Popup = { kind: "slash"; items: Command[] } | { kind: "mention"; items: Mention[]; start: number; query: string };
type Target = {
  x: number;
  y: number;
  w: number;
  act:
    | { kind: "allow" | "deny"; id: string }
    | { kind: "model" }
    | { kind: "list"; list: conversations.List; k: number }
    | { kind: "search"; match: promptSearch.Match }
    | { kind: "search-toggle"; id: string }
    | { kind: "review"; ref: reference.Resolved };
};
/** What a list shows before Corgi has read any conversations. */
const unread = new launcherResume.Context({ pending: true, entries: [] }, "", "", [], 0);

function sameAction(a: Target["act"] | null, b: Target["act"]): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "list" && b.kind === "list") return a.list === b.list;
  if (a.kind === "review" && b.kind === "review") return reference.key(a.ref) === reference.key(b.ref);
  if (a.kind === "search" && b.kind === "search")
    return a.match.provider === b.match.provider && a.match.session === b.match.session;
  return "id" in a && "id" in b ? a.id === b.id : a.kind === "model";
}

let s: Record<
  | "border"
  | "text"
  | "strong"
  | "bold"
  | "muted"
  | "faint"
  | "accent"
  | "spin"
  | "warm"
  | "hot"
  | "key"
  | "caret"
  | "user"
  | "user_mark"
  | "chip"
  | "chip_quiet"
  | "user_with",
  string
>;
palette.derived(() => {
  const on = (fg: palette.Token, bold = false) => new palette.Style({ fg, bg: "bg", bold }).sgr();
  s = {
    border: on("line"),
    text: on("text"),
    strong: on("strong"),
    bold: on("strong", true),
    muted: on("muted"),
    faint: on("faint"),
    accent: on("accent", true),
    spin: on("accent"),
    warm: on("warm"),
    hot: on("hot"),
    key: on("text", true),
    caret: new palette.Style({ fg: "bg", bg: "accent" }).sgr(),
    user: new palette.Style({ fg: "strong", bg: "surface" }).sgr(),
    user_mark: new palette.Style({ fg: "muted", bg: "surface" }).sgr(),
    chip: new palette.Style({ fg: "text", bg: "selected" }).sgr(),
    chip_quiet: new palette.Style({ fg: "muted", bg: "selected" }).sgr(),
    user_with: new palette.Style({ fg: "faint", bg: "surface" }).sgr(),
  };
});
const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;
const width = (segs: Seg[]) => segs.reduce((n, seg) => n + displayWidth(seg.text), 0);

/** What a new session is told about where the prompt was opened. */
export function contextText(c: Context | null): string {
  if (!c) return "";
  const lines = [`Workspace ${c.workspace}${c.branch ? ` on branch ${c.branch}` : ""}, in ${c.cwd}.`];
  if (c.focus?.provider) {
    const who = ` (${adapter(c.focus.provider).name})`;
    lines.push(`Opened over the agent "${c.focus.title}"${who}${c.focus.activity ? `: ${c.focus.activity}` : ""}.`);
  } else if (c.focus) lines.push(`Opened over the pane "${c.focus.title}".`);
  if (c.herd.length) {
    lines.push("Agents in this workspace:");
    for (const a of c.herd) lines.push(`- ${a.name}: ${a.state}${a.activity ? ` · ${a.activity}` : ""}`);
  }
  return lines.join("\n");
}
/** Two mentions name the same thing. */
export function sameMention(a: Mention, b: Mention): boolean {
  if (a.kind === "image" && b.kind === "image") return a.path === b.path;
  if (a.kind === "workspace" && b.kind === "workspace") return a.id === b.id;
  if (a.kind === "diff" && b.kind === "diff") return a.cwd === b.cwd;
  return a.kind === b.kind && "pane" in a && "pane" in b && a.pane === b.pane;
}
/** What a chip and the context block call a mention. */
export function mentionName(m: Mention, c: Context | null): string {
  switch (m.kind) {
    case "agent":
      return clean(m.name);
    case "selection":
      return "selection";
    case "diff":
      return m.workspace ? `${clean(m.workspace.name)} diff` : "diff";
    case "workspace":
    case "image":
      return clean(m.name);
  }
}
/** Mentions whose names start with `query`, then ones with each of its
 * words in their name or agent. */
export function mentionsMatching(all: Mention[], query: string, c: Context | null): Mention[] {
  const q = query.toLowerCase().trim(),
    named = all.map(m => ({
      m,
      name: mentionName(m, c).toLowerCase(),
      agent: m.kind === "agent" && m.provider ? adapter(m.provider).name : "",
    }));
  return [
    ...named.filter(n => n.name.startsWith(q)),
    ...named.filter(n => !n.name.startsWith(q) && matches(q, `${n.name} ${n.agent}`)),
  ].map(n => n.m);
}
/** What a mention's menu row says beside its name. */
function mentionNote(m: Mention): string {
  const where = "workspace" in m && m.workspace ? ` · in ${clean(m.workspace.name)}` : "";
  switch (m.kind) {
    case "agent":
      return (clean(m.activity) || "agent") + where;
    case "selection":
      return `selected in ${clean(m.name)}`;
    case "diff":
      return `uncommitted changes in ${basename(m.cwd) || m.cwd}`;
    case "workspace":
      return `workspace · ${basename(m.cwd) || m.cwd}`;
    case "image":
      return "pasted image";
  }
}
/** The message a model gets: a context block per attachment, then the user's words. */
export function message(text: string, attached: { kind: string; name: string; body: string }[]): string {
  if (!attached.length) return text;
  const blocks = attached.map(
    a =>
      `<context kind="${a.kind}" name="${a.name.replace(/"/g, "'")}">\n` +
      a.body.trimEnd().replace(/<\/context>/g, "</ context>") +
      "\n</context>",
  );
  return blocks.join("\n") + "\n\n" + text;
}
/** What the card writes for a Corgi pane to go on with its conversation, or
 * to start one when nothing was asked yet. */
export type HandoffFile = {
  conversation: Handoff | null;
  incognito: boolean;
  choice: Choice | null;
  catalog: { entries: Entry[]; suggested: Choice[]; briefs: Brief[]; auto?: Choice | null };
  context: Context | null;
};
/** Writes a handoff for a pane, readable by this user only; returns its path. */
export function writeHandoff(file: HandoffFile, dir = tmpdir()): string {
  const path = join(dir, `corgi-chat-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(path, json.stringify(file), { mode: 0o600, flag: "wx" });
  return path;
}
/** Reads a pane's handoff and deletes it; null when it's gone or isn't one. */
export function readHandoff(path: string): HandoffFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  try {
    return handoffFile(JSON.parse(text));
  } catch {
    return null;
  }
}
const item_kinds = new Set(["user", "text", "tool", "search", "ask", "note"]);
/** A handoff as the card wrote it, its conversation checked. */
function handoffFile(v: any): HandoffFile | null {
  const h = v?.conversation,
    provider = Provider.parse(h?.provider);
  if (
    h !== null &&
    (!provider || typeof h.session !== "string" || !h.session || !h.start || !/^\d+$/.test(String(h.after)))
  )
    return null;
  const list = (x: unknown) => (Array.isArray(x) ? x : []),
    chosen = (x: any) => (x && Provider.parse(x.provider) ? x : null);
  return {
    conversation:
      h === null || !provider
        ? null
        : {
            provider,
            session: h.session,
            start: {
              ...h.start,
              provider: Provider.parse(h.start.provider) ?? provider,
              effort: effort.parse(h.start.effort),
            },
            after: String(h.after),
            running: h.running === true,
            items: list(h.items).flatMap((item: any) => {
              if (!item_kinds.has(item?.kind)) return [];
              if (item.kind !== "search") return [item];
              const search = promptSearch.parse(item.search);
              return search ? [{ kind: "search", search }] : [];
            }),
            wrote: list(h.wrote),
            used: list(h.used),
            memory_writes: h.memory_writes !== false,
          },
    incognito: v.incognito === true,
    choice: chosen(v.choice),
    catalog: {
      entries: list(v.catalog?.entries),
      suggested: list(v.catalog?.suggested),
      briefs: list(v.catalog?.briefs),
      auto: chosen(v.catalog?.auto),
    },
    context: v.context && typeof v.context.cwd === "string" ? { mentions: [], ...v.context } : null,
  };
}
/** What `corgi __chat` takes: the handoff, then what the session runs with,
 * so a pane restored without its handoff starts the same way. */
export type ChatArgs = {
  handoff: string;
  provider: Provider;
  session: string;
  account: string;
  model: string;
  effort: Effort | null;
  incognito: boolean;
  cwd: string;
  workspace: number | null;
};
export function chatArgs(a: ChatArgs): string[] {
  return [
    a.handoff,
    "--provider",
    a.provider,
    ...(a.session ? ["--session", a.session] : []),
    ...(a.account ? ["--account", a.account] : []),
    ...(a.model ? ["--model", a.model] : []),
    ...(a.effort ? ["--effort", a.effort] : []),
    ...(a.incognito ? ["--incognito"] : []),
    ...(a.cwd ? ["--cwd", a.cwd] : []),
    ...(a.workspace !== null ? ["--workspace", String(a.workspace)] : []),
  ];
}
export function parseChatArgs(argv: string[]): ChatArgs {
  const out: ChatArgs = {
    handoff: "",
    provider: Provider.first,
    session: "",
    account: "",
    model: "",
    effort: null,
    incognito: false,
    cwd: "",
    workspace: null,
  };
  let provider: Provider | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i],
      value = () => {
        const next = argv[++i];
        if (next === undefined) throw Error("Usage");
        return next;
      };
    switch (arg) {
      case "--provider":
        provider = Provider.parse(value());
        if (!provider) throw Error("Usage");
        break;
      case "--session":
        out.session = value();
        break;
      case "--account":
        out.account = value();
        break;
      case "--model":
        out.model = value();
        break;
      case "--effort":
        out.effort = effort.parse(value());
        if (!out.effort) throw Error("Usage");
        break;
      case "--incognito":
        out.incognito = true;
        break;
      case "--cwd":
        out.cwd = value();
        break;
      case "--workspace": {
        const id = Number(value());
        if (!Number.isSafeInteger(id) || id < 0) throw Error("Usage");
        out.workspace = id;
        break;
      }
      default:
        if (arg.startsWith("-") || out.handoff) throw Error("Usage");
        out.handoff = arg;
    }
  }
  if (!provider) throw Error("Usage");
  out.provider = provider;
  return out;
}
/** How to run this corgi again: its binary, or Bun and main.ts from source. */
export function corgiCommand(): string[] {
  return import.meta.filename.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, join(import.meta.dir, "main.ts")];
}
/** The runs of `segs` between columns-of-text offsets `start` and `end`. */
function slice(segs: Seg[], start: number, end: number): Seg[] {
  const out: Seg[] = [];
  let at = 0;
  for (const seg of segs) {
    const from = Math.max(start, at),
      to = Math.min(end, at + seg.text.length);
    if (from < to) out.push({ text: seg.text.slice(from - at, to - at), style: seg.style });
    at += seg.text.length;
  }
  return out;
}
/** `segs` wrapped between words at `room` columns as thread rows, later
 * ones after `indent` spaces, each going on with the one above, joined by
 * the spaces the break took. */
function wrapped(segs: Seg[], room: number, indent = 0, style = s.text): Row[] {
  const plain = segs.map(seg => seg.text).join("");
  const first = new TextArea(plain).lines(Math.max(1, room))[0];
  const out: Row[] = [{ segs: slice(segs, first.start, first.end) }];
  let from = first.end;
  while (from < plain.length && plain[from] === " ") from++;
  if (from >= plain.length) return out;
  let end = first.end;
  for (const line of new TextArea(plain.slice(from)).lines(Math.max(1, room - indent))) {
    out.push({
      segs: [{ text: " ".repeat(indent), style }, ...slice(segs, from + line.start, from + line.end)],
      cont: { join: plain.slice(end, from + line.start), skip: indent },
    });
    end = from + line.end;
  }
  return out;
}
/** A row's text as its cells, `room` of them: a wide character's second
 * cell is "". Chips show their names. */
function cells(row: Row, room: number): string[] {
  const out = Array<string>(room).fill(" ");
  const put = (x: number, text: string) => {
    for (const ch of text) {
      const w = displayWidth(ch);
      if (x + w > room) return;
      if (w === 0) {
        if (x > 0) out[x - 1] += ch;
        continue;
      }
      out[x] = ch;
      for (let k = 1; k < w; k++) out[x + k] = "";
      x += w;
    }
  };
  put(row.frame === "body" ? 2 : 0, row.segs.map(seg => seg.text).join(""));
  if (row.chips?.more) put(text_x, `+${row.chips.more}`);
  for (const piece of row.chips?.pieces ?? []) put(text_x + piece.x + (branded(piece.mention) ? 4 : 1), piece.text);
  if (row.right?.length)
    put(room - (row.frame === "body" ? 2 : 0) - width(row.right), row.right.map(seg => seg.text).join(""));
  return out;
}
/** Two spots, the earlier first. */
function ordered(a: Spot, b: Spot): [Spot, Spot] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}
/** What a double-click stops at, as panes pick words (pane/terminal.zig):
 * Ghostty's boundaries without `:`, so `path:line` stays whole. */
const word_breaks = new Set([
  " ",
  "\t",
  "'",
  '"',
  "│",
  "`",
  "|",
  ";",
  ",",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "$",
]);
const blank = new Set([" ", "\t"]);
/** Trimmed from a word's end, so a sentence's `foo.` gives `foo`. */
const word_end = new Set([" ", "\t", ".", ":", "!", "?"]);
/** The word around index `at` of `chars`, as `[first, last]`: a run of
 * word characters, or of boundaries when it's on one, trimmed of blanks
 * and its end's punctuation; null on a blank. */
function wordAt(chars: string[], at: number): [number, number] | null {
  if (blank.has(chars[at])) return null;
  const breaks = (i: number) => word_breaks.has(chars[i]),
    kind = breaks(at);
  let first = at,
    last = at;
  while (first > 0 && breaks(first - 1) === kind) first--;
  while (last + 1 < chars.length && breaks(last + 1) === kind) last++;
  while (first <= last && blank.has(chars[first])) first++;
  while (last >= first && word_end.has(chars[last])) last--;
  return first <= last ? [first, last] : null;
}
/** Where a row's text ends: past its last cell that isn't blank. */
function textEnd(cs: string[]): number {
  let end = cs.length;
  while (end > 0 && (cs[end - 1] === " " || cs[end - 1] === "")) end--;
  return end;
}
/** A chip that shows its agent's brand mark. */
function branded(m: Mention): boolean {
  return m.kind === "agent" && m.provider !== null;
}
/** Chips in a row: names cut short, the newest kept in `budget` columns,
 * and the older ones that don't fit counted first. */
function lay(mentions: Mention[], budget: number, c: Context | null): Inline {
  const shown = mentions.map(mention => {
      const text = ellipsis(mentionName(mention, c), chip_name_w);
      return { mention, text, size: 2 + (branded(mention) ? 3 : 0) + displayWidth(text) + 1 };
    }),
    count = (n: number) => (n ? 2 + String(n).length : 0);
  let first = shown.length,
    used = 0;
  while (first > 0 && used + shown[first - 1].size + count(first - 1) <= budget) used += shown[--first].size;
  let x = count(first);
  const pieces = shown.slice(first).map(({ mention, text, size }) => {
    const piece = { mention, text, x };
    x += size;
    return piece;
  });
  return { pieces, more: first, width: x };
}
/** `t` scaled down to at most `cols` by `rows` cells; null when too little would show. */
function shrink(t: Thumbnail, cols: number, rows: number): Thumbnail | null {
  const scale = Math.min(1, (cols * t.cell.width) / t.width, (rows * t.cell.height) / t.height);
  if (scale >= 1) return t;
  const c = Math.max(1, Math.floor((t.width * scale) / t.cell.width)),
    r = Math.floor((t.height * scale) / t.cell.height);
  return r < 2 ? null : { width: c * t.cell.width, height: r * t.cell.height, cell: t.cell, of: t };
}
/** `segs` cut to `room` columns, ending in "…" when cut. */
function clip(segs: Seg[], room: number): Seg[] {
  if (width(segs) <= room) return segs;
  if (room <= 0) return [];
  const out: Seg[] = [];
  let left = room - 1;
  for (const seg of segs) {
    const kept = clipped(seg.text, left);
    if (kept) out.push({ text: kept, style: seg.style });
    left -= displayWidth(kept);
    if (kept.length < seg.text.length) break;
  }
  out.push({ text: "…", style: out.at(-1)?.style ?? s.text });
  return out;
}
function writeSegs(w: Writer, x: number, y: number, segs: Seg[]): number {
  w.write(at(x, y));
  for (const seg of segs) {
    w.write(seg.style + seg.text);
    x += displayWidth(seg.text);
  }
  return x;
}
/** Hints, key then label, the first ones dropped until they fit `room`. */
function hints(list: [string, string][], room: number): Seg[] {
  const segs = (l: [string, string][]) =>
    l.flatMap(([key, what], i) => [
      { text: (i ? "   " : "") + key, style: s.key },
      { text: " " + what, style: s.faint },
    ]);
  while (list.length && width(segs(list)) > room) list = list.slice(1);
  return segs(list);
}
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
/** Whether `path` can be deleted as `session`'s transcript: an existing
 * absolute .jsonl file whose name holds the session. */
function deletable(path: string, session: string): boolean {
  return (
    !!session && isAbsolute(path) && path.endsWith(".jsonl") && basename(path).includes(session) && existsSync(path)
  );
}
/** A whole character from the bytes of one, once it has them all. */
function character(pending: number[], byte: number): string | null {
  pending.push(byte);
  const lead = pending[0],
    size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (pending.length < size) return null;
  const text = Buffer.from(pending.splice(0)).toString();
  return text.includes("�") ? null : text;
}

export class Prompt {
  open = false;
  readonly conversation: Conversation;
  readonly memory: Memory;
  /** The model the next session runs, as last picked; the first suggestion until then. */
  choice: Choice | null;
  context: Context | null = null;
  /** True while nothing is kept: no transcript, no memory. */
  incognito = false;
  private area = new TextArea("", true);
  private entries: Entry[] = [];
  private suggested: Choice[] = [];
  private briefs: Brief[] = [];
  /** What Auto runs: the newest strong model of the agent run most. */
  private auto: Choice | null = null;
  /** The catalogs are still being read and nothing is picked yet. */
  private loading = false;
  private picker: Picker | null = null;
  private menu_at = 0;
  private menu_first = 0;
  /** The menu and query `menu_at` counts in; another starts at the top. */
  private menu_key = "";
  /** The trigger whose menu Esc closed: the leading `/`, or the `@` at an
   * offset. Its menu opens again once the trigger is gone and typed anew. */
  private dismissed: { kind: "slash" } | { kind: "mention"; start: number } | null = null;
  /** Attachments for the next message. */
  private chips: Chip[] = [];
  /** A message waiting for its attachments, and their names. */
  private outbox: Promise<void> | null = null;
  private reading: string[] = [];
  /** The card's top row while the terminal keeps its size; it grows down from there. */
  private anchor: { size: string; top: number } | null = null;
  /** Where the open menu or picker sits, kept while it stays open over the
   * same card, so typing into it never moves or resizes it. */
  private placed: { key: string; rect: Rect } | null = null;
  /** Thread rows scrolled back from the newest, and how many there were when drawn. */
  private back = 0;
  private total = 0;
  private input_first = 0;
  /** /forgetmenow waits for a second Enter until then. */
  private burn_until = 0;
  /** Deleted transcripts to delete again, in case their process wrote once more as it stopped. */
  private rechecks: { path: string; at: number }[] = [];
  private typing: number[] = [];
  private pasting: number[] = [];
  private pasted_cr = false;
  private frame = "";
  private drawn: Layout | null = null;
  /** Menus can use the empty preview area, up to the viewport or an open review. */
  private menu_cols = 0;
  private targets: Target[] = [];
  private expandedSearches = new Set<string>();
  /** The list whose conversation the pointer rests on. */
  private hovered_list: conversations.List | null = null;
  /** The memory, browsed in the card in place of the thread and the input. */
  private memory_view: MemoryView | null = null;
  /** Where each chip was last drawn, in the input or a message, for the pointer. */
  private chip_spots: { x: number; y: number; w: number; mention: Mention }[] = [];
  /** The pasted image the pointer rests on. */
  private hovered: Mention | null = null;
  /** What the last drag selected, shown until the next press or key. */
  private selection: Selection | null = null;
  /** Presses on one cell, each soon after the last: a double picks a word, a triple a line. */
  private clicks: { x: number; y: number; count: number; at: number } | null = null;
  /** The thread's rows as last drawn, and the first one shown. */
  private lines: Row[] = [];
  private shown_from = 0;
  /** Each reply's lists of conversations, in order, kept while it streams. */
  private lists = new WeakMap<Item, conversations.List[]>();
  /** The list the keyboard is in: Shift+Tab, or a press on its search. */
  private listing: conversations.List | null = null;
  private ui: Target["act"] | null = null;
  private ui_row = -1;
  private history: { at: number; texts: string[]; drafts: Map<number, TextArea> } | null = null;
  private readonly review = new reviewPanel.Panel();
  private readonly references = new reference.Recognizer();
  private review_focused = false;
  private review_dirty = false;
  private review_box: Rect | null = null;
  private review_pressed = false;
  private hovered_review: reference.Resolved | null = null;
  private readonly clock: () => number;
  /** The corgi executable the model drives Corgi with. */
  private readonly binary: string;
  readonly mode: Mode;
  constructor(
    readonly deps: Deps,
    choice: Choice | null = null,
  ) {
    this.clock = deps.clock ?? Date.now;
    this.binary = deps.binary ?? corgiCommand()[0];
    this.mode = deps.mode ?? "overlay";
    this.memory = new Memory(deps.memory_root);
    this.choice = choice;
    this.conversation = new Conversation(deps.daemon, {
      inside: path => this.memory.inside(path),
      files: () => [join(this.memory.dir, "MEMORY.md"), this.memory.today(new Date(this.clock()))],
      transcript: (provider, session, account) => this.transcript(provider, session, account),
      corgi: command => promptTools.looks(command, this.binary),
      search: command => promptTools.searchTool(command, this.binary),
      clock: this.clock,
    });
    this.conversation.claim = deps.pane ?? null;
    this.references.changed = this.review.changed = () => {
      this.review_dirty = true;
    };
  }
  /** Called when a reply arrives while the viewer waits on input. */
  set changed(f: () => void) {
    this.conversation.changed = f;
    this.references.changed = this.review.changed = () => {
      this.review_dirty = true;
      f();
    };
  }
  /** Models, suggestions, account briefs and what Auto runs, as they arrive. */
  catalog(entries: Entry[], suggested: Choice[], briefs: Brief[], auto: Choice | null = null, loading = false): void {
    this.entries = entries;
    this.suggested = suggested;
    this.briefs = briefs;
    this.auto = auto;
    this.loading = loading;
    this.picker?.update(entries, briefs, suggested, [this.autoPin()]);
  }
  /** The model the next message goes to: the pick, or following Auto, the
   * model the conversation started on, or else the one Auto runs now. */
  current(): Choice | null {
    if (this.choice) return this.choice;
    const started = this.conversation.session ? this.conversation.started : null;
    if (started) {
      const entry = this.entries.find(e => e.provider === started.provider && e.model === started.model);
      return {
        provider: started.provider,
        account: started.account,
        model: started.model,
        effort: started.effort,
        name: entry?.name ?? "",
      };
    }
    return this.auto ?? this.suggested[0] ?? null;
  }
  /** "Auto · Sonnet 5.5 · High" while following Auto. */
  private currentLabel(): string {
    const choice = this.current();
    return !choice ? "" : this.choice ? label(choice) : `Auto · ${label(choice)}`;
  }
  /** The picker's Auto row, saying what it runs. */
  private autoPin(): Pin {
    const auto = this.auto;
    return {
      id: "auto",
      name: "Auto",
      detail: auto
        ? [adapter(auto.provider).name, label(auto)]
        : [this.loading ? "Loading models…" : "Follows your agents"],
      glyph: "✦",
    };
  }
  show(context: Context): void {
    this.references.forgetMissing();
    this.open = true;
    this.context = context;
    this.back = 0;
    this.anchor = null;
    this.conversation.seen();
    // Where it opened replaces the last default; what the user added stays.
    const added = this.chips.filter(c => !c.auto),
      focus = context.focus;
    this.chips = [];
    if (focus?.pane != null && this.mode === "overlay")
      this.addChip(
        context.mentions.find(m => m.kind === "agent" && m.pane === focus.pane) ?? {
          kind: "agent",
          pane: focus.pane,
          name: focus.title,
          provider: focus.provider,
          activity: focus.activity,
        },
        true,
      );
    for (const chip of added) if (!this.chips.some(c => sameMention(c.mention, chip.mention))) this.chips.push(chip);
  }
  /** What the next message carries, by name. */
  attached(): string[] {
    return this.chips.map(c => mentionName(c.mention, this.context));
  }
  /** In a Corgi pane: goes on with the conversation the card handed over. */
  adopt(file: HandoffFile): void {
    this.incognito = file.incognito;
    this.choice = file.choice;
    this.catalog(file.catalog.entries, file.catalog.suggested, file.catalog.briefs, file.catalog.auto ?? null);
    if (file.conversation) this.conversation.adopt(file.conversation);
    else this.conversation.memory_writes = !file.incognito;
  }
  /** The pane's title: Corgi and the model it talks to. */
  title(): string {
    return this.current() ? `Corgi · ${clean(this.currentLabel())}` : "Corgi";
  }
  hide(): void {
    this.leaveUI();
    this.review.hide();
    this.review.preview(null);
    this.review_focused = false;
    this.open = false;
    this.picker = null;
    this.burn_until = 0;
    this.dismissed = null;
  }
  /** Goes on with the session this prompt ran before the viewer reloaded,
   * with the model, account and incognito it started with. */
  attach(r: Resumed): void {
    this.incognito = !r.persist;
    this.conversation.memory_writes = r.persist;
    this.conversation.attach(
      {
        provider: r.provider,
        account: r.account,
        model: r.model,
        effort: r.effort,
        cwd: r.cwd,
        workspace: r.workspace || null,
        instructions: "",
        persist: r.persist,
      },
      r.session,
      r.state === "working" || r.state === "blocked",
    );
    // A model's name is the same in every account.
    const entry = this.entries.find(e => e.provider === r.provider && e.model === r.model);
    this.choice = {
      provider: r.provider,
      account: r.account,
      model: r.model,
      name: entry?.name ?? "",
      effort: r.effort,
    };
  }
  /** What the viewer shows while the prompt is hidden. */
  attention(): Attention {
    return this.conversation.attention();
  }
  key(byte: number): Effect | null {
    if (!this.open) return null;
    this.selection = this.clicks = null;
    if (this.picker) return this.picked(this.picker.key(byte));
    if (this.memory_view) return this.remembered(this.memory_view.key(byte));
    if (this.review_focused) {
      this.review.preview(null);
      const named = reviewPanel.byte_keys[byte];
      const text =
        byte >= 0x80 ? character(this.typing, byte) : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : null;
      return named
        ? this.reviewEffect(this.review.key({ named }))
        : text
          ? this.reviewEffect(this.review.key({ text }))
          : null;
    }
    // Ctrl+/ searches the newest list of conversations, from the input too.
    if (byte === 31) {
      this.searchList();
      return null;
    }
    if (this.listing) {
      const effect = this.listKey(byte);
      if (effect !== undefined) return effect;
    }
    if (this.ui) {
      if (byte === 27 || byte === 9) {
        this.leaveUI();
        return null;
      }
      if (byte === 13) return this.activate(this.ui);
      if (byte === 106 || byte === 107 || byte === 14 || byte === 16) {
        this.moveUI(byte === 106 || byte === 14 ? 1 : -1);
        return null;
      }
      this.leaveUI();
    }
    const armed = this.burn_until > 0;
    if (byte !== 13) this.burn_until = 0;
    const popup = this.popup();
    switch (byte) {
      // Esc backs out of a menu, then hides the card; a pane stays.
      case 27:
        if (armed) this.area = new TextArea("", true);
        else if (popup)
          this.dismissed = popup.kind === "slash" ? { kind: "slash" } : { kind: "mention", start: popup.start };
        else if (this.mode === "overlay") {
          this.hide();
          return { kind: "close" };
        }
        return null;
      // Ctrl+D in an empty box ends a pane's chat.
      case 4:
        return this.mode === "pane" && !this.area.text ? { kind: "close" } : null;
      case 13:
        return this.enter();
      case 9:
        if (popup?.kind === "slash") this.complete(popup.items[this.menu_at]);
        else if (popup) this.mention(popup);
        else this.openPicker();
        return null;
      case 10:
        this.area.apply("newline");
        return null;
      // Ctrl+C stops the turn, a starting one too; with none, it clears the box.
      case 3:
        if (busy.has(this.conversation.state)) this.conversation.interrupt();
        else this.area = new TextArea("", true);
        return null;
      case 15:
        return this.mode === "overlay" ? this.run("pane", "") : null;
      case 14:
      case 16:
        if (popup) this.move(popup, byte === 14 ? 1 : -1);
        return null;
    }
    // Backspace in an empty box takes back the last attachment.
    if ((byte === 127 || byte === 8) && !this.area.text && this.chips.length) {
      this.chips.pop();
      return null;
    }
    const edit = byte_edits[byte];
    if (edit) this.area.apply(edit);
    else if (byte >= 0x80) {
      const text = character(this.typing, byte);
      if (text) this.area.insert(text);
    } else if (byte >= 32 && byte !== 127) this.area.insert(String.fromCharCode(byte));
    this.popup();
    return null;
  }
  sequence(text: string): Effect | null {
    if (!this.open) return null;
    this.selection = this.clicks = null;
    if (this.picker) return this.picked(this.picker.sequence(text));
    if (this.memory_view) return this.remembered(this.memory_view.sequence(text));
    this.burn_until = 0;
    const key = keys.parse(text),
      popup = this.popup(),
      page = Math.max(1, (this.drawn?.thread?.h ?? 2) - 1);
    if (this.review_focused) {
      this.review.preview(null);
      const named = key && reviewPanel.sequence_keys[key];
      return named ? this.reviewEffect(this.review.key({ named })) : null;
    }
    if (key === "shift_tab" && !popup) {
      this.moveUI(-1);
      return null;
    }
    if (this.listing) {
      const effect = this.listSequence(key, text);
      if (effect !== undefined) return effect;
    }
    if (popup && (key === "up" || key === "down" || key === "shift_tab")) {
      this.move(popup, key === "down" ? 1 : -1);
      return null;
    }
    if (this.ui && (key === "up" || key === "down")) {
      this.moveUI(key === "down" ? 1 : -1);
      return null;
    }
    if (key === "up" || key === "down") {
      this.recall(key === "down" ? 1 : -1);
      return null;
    }
    if (key === "page_up") this.back += page;
    else if (key === "page_down") this.back = Math.max(0, this.back - page);
    else {
      const edit = key && key_edits[key];
      if (edit) this.area.apply(edit);
    }
    this.popup();
    return null;
  }
  paste(text: string): void {
    if (!this.open) return;
    this.selection = this.clicks = null;
    if (this.review_focused) {
      for (const byte of Buffer.from(text)) this.review.pasteByte(byte);
      return;
    }
    if (this.memory_view) return this.memory_view.paste(text);
    if (this.picker) {
      this.picker.sequence(text.replace(/\s+/g, " "));
      return;
    }
    this.area.insert(
      text
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, "    ")
        .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ""),
    );
    this.popup();
  }
  /** A byte of a paste, as the controller passes them on. */
  pasteByte(byte: number): void {
    const cr = this.pasted_cr;
    this.pasted_cr = byte === 13;
    if (byte === 10 && cr) return;
    if (byte < 0x80) {
      this.pasting = [];
      this.paste(byte === 13 ? "\n" : String.fromCharCode(byte));
      return;
    }
    const text = character(this.pasting, byte);
    if (text) this.paste(text);
  }
  click(x: number, y: number): Effect | null {
    if (!this.open) return null;
    this.selection = null;
    if (this.review.open && this.review_box?.contains(x, y)) {
      this.leaveUI();
      this.review_focused = this.review_pressed = true;
      this.review.mouse("press", x, y);
      return this.reviewEffect(this.review.takeEffect());
    }
    this.review_focused = false;
    // Only a press in the thread or the input goes on with a click series.
    const prior = this.clicks;
    this.clicks = null;
    if (this.picker) return this.picked(this.picker.click(x, y));
    const l = this.drawn;
    if (!l) return null;
    const row = this.menuRow(x, y);
    if (row !== null) {
      this.menu_at = row;
      return this.enter();
    }
    // The menu's border takes the press too, wherever the menu hangs.
    if (l.panel?.contains(x, y)) return null;
    for (const t of this.targets) {
      if (y !== t.y || x < t.x || x >= t.x + t.w) continue;
      return this.activate(t.act);
    }
    this.leaveUI();
    if (!l.box.contains(x, y)) {
      if (this.mode === "pane") return null;
      this.hide();
      return { kind: "close" };
    }
    if (this.memory_view) {
      this.memory_view.click(x, y);
      return null;
    }
    // A press in the thread or the input picks its cell, word or line, and
    // may go on to drag a selection.
    const at = this.spot(x, y);
    if (at) {
      const unit = this.unit(prior, x, y),
        picked = this.threadSpan(at, unit);
      this.selection = { on: "thread", unit, picked, from: picked[0], to: picked[1], room: l.thread!.w, held: true };
    } else if (y >= l.input_y && y < l.input_y + l.input_rows && x >= l.left + text_x) {
      const unit = this.unit(prior, x, y);
      this.area.place(this.input_first + y - l.input_y, x - l.left - text_x);
      const picked = this.inputSpan(this.area.caret, unit);
      this.selection = { on: "input", unit, picked, held: true };
      if (picked[0] !== picked[1]) [this.area.anchor, this.area.caret] = picked;
    }
    return null;
  }
  /** What a press at (`x`, `y`) picks: one soon on the cell of the press
   * before picks its word, and a third its line. */
  private unit(prior: Prompt["clicks"], x: number, y: number): Unit {
    const now = this.clock(),
      count =
        prior && prior.x === x && prior.y === y && now - prior.at <= double_click_ms ? Math.min(prior.count + 1, 3) : 1;
    this.clicks = { x, y, count, at: now };
    return count === 3 ? "line" : count === 2 ? "word" : "cell";
  }
  /** The pointer moved with its button down: a selection reaches from what
   * the press picked to the `unit` under it. True when that changed. */
  drag(x: number, y: number): boolean {
    if (this.review_pressed) {
      this.review.mouse("drag", x, y);
      return true;
    }
    const sel = this.selection,
      l = this.drawn;
    // Leaving the cell ends a click series.
    if (this.clicks && (this.clicks.x !== x || this.clicks.y !== y)) this.clicks = null;
    if (!this.open || !sel?.held || !l) return false;
    if (sel.on === "input") {
      const before = `${this.area.anchor},${this.area.caret}`;
      this.area.place(this.input_first + y - l.input_y, x - l.left - text_x);
      const span = this.inputSpan(this.area.caret, sel.unit),
        first = Math.min(sel.picked[0], span[0]),
        last = Math.max(sel.picked[1], span[1]);
      // The caret goes to the end the pointer pulls.
      [this.area.anchor, this.area.caret] = span[0] < sel.picked[0] ? [last, first] : [first, last];
      if (this.area.anchor === this.area.caret) this.area.anchor = null;
      return `${this.area.anchor},${this.area.caret}` !== before;
    }
    const at = this.spot(x, y, true);
    if (!at) return false;
    const span = this.threadSpan(at, sel.unit),
      from = ordered(sel.picked[0], span[0])[0],
      to = ordered(sel.picked[1], span[1])[1];
    if (from.row === sel.from.row && from.col === sel.from.col && to.row === sel.to.row && to.col === sel.to.col)
      return false;
    [sel.from, sel.to] = [from, to];
    return true;
  }
  /** The `unit` at thread spot `at`: its cell; the word, through the rows
   * it wrapped onto; or the whole line it wrapped from. A blank picks its cell. */
  private threadSpan(at: Spot, unit: Unit): [Spot, Spot] {
    const room = this.drawn?.thread?.w ?? 0;
    if (unit === "cell" || !room) return [at, at];
    let first = at.row,
      last = at.row;
    while (first > 0 && this.lines[first].cont) first--;
    while (last + 1 < this.lines.length && this.lines[last + 1].cont) last++;
    if (unit === "line")
      return [
        { row: first, col: 0 },
        { row: last, col: room - 1 },
      ];
    // The line's text as one run of characters, each at its spot, with what
    // a wrap took between rows; a wide character's tail repeats it.
    const chars: string[] = [],
      spots: Spot[] = [];
    let found = -1;
    for (let row = first; row <= last; row++) {
      const r = this.lines[row],
        cs = cells(r, room),
        end = textEnd(cs);
      if (row > first) {
        const after = { row: row - 1, col: Math.min(room - 1, textEnd(cells(this.lines[row - 1], room))) };
        for (const ch of r.cont!.join) (chars.push(ch === "\n" ? " " : ch), spots.push(after));
      }
      for (let col = row > first ? r.cont!.skip : 0; col < end; col++) {
        if (row === at.row && col === at.col) found = chars.length;
        chars.push(cs[col] === "" ? (chars.at(-1) ?? " ") : String.fromCodePoint(cs[col].codePointAt(0)!));
        spots.push({ row, col });
      }
    }
    const word = found < 0 ? null : wordAt(chars, found);
    return word ? [spots[word[0]], spots[word[1]]] : [at, at];
  }
  /** The `unit` around input offset `at`, as offsets: nothing, its word, or its line. */
  private inputSpan(at: number, unit: Unit): [number, number] {
    const text = this.area.text;
    if (unit === "line") {
      const end = text.indexOf("\n", at);
      return [text.lastIndexOf("\n", at - 1) + 1, end < 0 ? text.length : end];
    }
    if (unit === "cell" || at >= text.length) return [at, at];
    const chars: string[] = [],
      offsets: number[] = [];
    for (let i = 0; i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      chars.push(ch === "\n" ? " " : ch);
      offsets.push(i);
      i += ch.length;
    }
    offsets.push(text.length);
    const word = wordAt(
      chars,
      offsets.findLastIndex(o => o <= at),
    );
    return word ? [offsets[word[0]], offsets[word[1] + 1]] : [at, at];
  }
  /** The button came up: what a drag selected is copied. */
  release(): Effect | null {
    if (this.review_pressed) {
      this.review_pressed = false;
      this.review.mouse("release", -1, -1);
      return this.reviewEffect(this.review.takeEffect());
    }
    const sel = this.selection;
    if (!sel?.held) return null;
    sel.held = false;
    const text = sel.on === "input" ? this.area.selectedText() : this.selectedText();
    // A press that didn't drag selects nothing; the input keeps its own selection.
    if (!text || sel.on === "input") this.selection = null;
    return text ? { kind: "copy", text } : null;
  }
  /** The thread row and column at (`x`, `y`), or null outside the thread;
   * `clamped` takes a point past its edges to the nearest row's end. */
  private spot(x: number, y: number, clamped = false): Spot | null {
    const l = this.drawn,
      t = l?.thread;
    if (!l || !t || this.memory_view) return null;
    const last = Math.min(this.lines.length, this.shown_from + t.h) - 1;
    if (last < this.shown_from) return null;
    if (!clamped && !t.contains(x, y)) return null;
    if (y < t.y) return { row: this.shown_from, col: 0 };
    const row = this.shown_from + y - t.y;
    if (row > last) return { row: last, col: t.w - 1 };
    return { row, col: clamp(x - t.x, 0, t.w - 1) };
  }
  /** The pointer moved: the menu row under it takes the highlight. True when that changed. */
  hover(x: number, y: number): boolean {
    if (this.review.open && this.review_box?.contains(x, y)) {
      this.review.preview(null);
      this.review.mouse("move", x, y);
      return true;
    }
    const target =
      this.open && !this.picker && !this.memory_view && !this.drawn?.panel
        ? this.targets.find(t => t.act.kind === "review" && t.y === y && x >= t.x && x < t.x + t.w)
        : null;
    const ref = target?.act.kind === "review" ? target.act.ref : null;
    const reviewChanged =
      (ref ? reference.key(ref) : null) !== (this.hovered_review ? reference.key(this.hovered_review) : null);
    this.hovered_review = ref;
    this.previewReview(ref ?? (this.ui?.kind === "review" ? this.ui.ref : null));
    // A pasted image under the pointer, in the input or a message, shows a preview of itself.
    const spot = this.open && !this.picker ? this.chip_spots.find(c => y === c.y && x >= c.x && x < c.x + c.w) : null,
      image = spot?.mention.kind === "image" ? spot.mention : null;
    let changed = reviewChanged || image !== this.hovered;
    this.hovered = image;
    // A list's conversation under the pointer lights up, as the launcher's do.
    const over = this.open && !this.picker && !this.drawn?.panel?.contains(x, y) ? this.listAt(x, y) : null,
      known = this.known();
    if (this.hovered_list && this.hovered_list !== over?.list) changed = this.hovered_list.hover(known, -1) || changed;
    if (over) changed = over.list.hover(known, over.k) || changed;
    this.hovered_list = over?.list ?? null;
    const row = this.open && !this.picker ? this.menuRow(x, y) : null;
    if (row !== null && row !== this.menu_at) {
      this.menu_at = row;
      changed = true;
    }
    return changed;
  }
  /** The pasted image the pointer rests on, whose picture the card shows. */
  previewed(): string | null {
    const m = this.hovered;
    return this.open && !this.picker && m?.kind === "image" && this.chip_spots.some(c => c.mention === m)
      ? m.path
      : null;
  }
  /** The wheel turned with the pointer at (`x`, `y`): a long list under it
   * scrolls, else the thread does. */
  scroll(down: boolean, x = -1, y = -1): void {
    if (!this.open) return;
    if (this.review.open && this.review_box?.contains(x, y)) {
      this.review.mouse(down ? "wheel_down" : "wheel_up", x, y);
      return;
    }
    // What's under the last click moved: the next press starts anew.
    this.clicks = null;
    const over = this.picker || this.memory_view ? null : this.listAt(x, y);
    if (this.memory_view) this.memory_view.scroll(down);
    else if (this.picker) this.picker.scroll(down);
    else if (over?.list.long()) {
      over.list.scroll(this.known(), down);
      over.list.hover(this.known(), over.k);
    } else this.back = Math.max(0, this.back + (down ? -3 : 3));
  }
  /** The list row drawn at (`x`, `y`), if any. */
  private listAt(x: number, y: number): { list: conversations.List; k: number } | null {
    for (const t of this.targets) if (t.act.kind === "list" && y === t.y && x >= t.x && x < t.x + t.w) return t.act;
    return null;
  }
  /** The thread shows a list of conversations. */
  listed(): boolean {
    return this.lines.some(row => row.list);
  }
  /** The conversations Corgi knows, for the lists. */
  private known(): launcherResume.Context {
    return this.deps.conversations?.() ?? unread;
  }
  /** The newest list the thread holds. */
  private newestList(): conversations.List | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const list = this.lines[i].list?.list;
      if (list) return list;
    }
    return null;
  }
  private recall(delta: number): void {
    if (!this.history) {
      if (delta > 0) return;
      const texts = this.conversation.items.flatMap(item => (item.kind === "user" ? [item.text] : []));
      if (!texts.length) return;
      this.history = { at: texts.length, texts, drafts: new Map([[texts.length, this.area]]) };
    }
    const h = this.history;
    h.drafts.set(h.at, this.area);
    h.at = clamp(h.at + delta, 0, h.texts.length);
    this.area = h.drafts.get(h.at) ?? new TextArea(h.texts[h.at], true);
    if (h.at === h.texts.length) this.history = null;
    this.dismissed = null;
    this.input_first = 0;
  }
  private resolveReview(ref: reference.Reference): reference.Resolved {
    const folder =
      ref.folder === "~" ? homedir() : ref.folder.startsWith("~/") ? join(homedir(), ref.folder.slice(2)) : ref.folder;
    return { cwd: resolve(this.context?.cwd || this.conversation.started?.cwd || ".", folder), source: ref.source };
  }
  private recognizedReview(ref: reference.Reference, request = false): reference.Resolved | null {
    const resolved = this.resolveReview(ref);
    if (!ref.implicit) return resolved;
    const source = this.references.resolve(resolved.cwd, resolved.source, request);
    return source ? { cwd: resolved.cwd, source } : null;
  }
  private previewReview(ref: reference.Resolved | null): void {
    this.review.preview(
      ref ? { cwd: ref.cwd, name: basename(ref.cwd), scope: "commits", pick: null, source: ref.source } : null,
    );
  }
  private reviewEffect(effect: reviewPanel.Effect): Effect | null {
    switch (effect.kind) {
      case "send":
        this.area.anchor = null;
        this.area.caret = this.area.text.length;
        this.area.insert((this.area.text ? "\n\n" : "") + effect.text);
        this.history = null;
        this.review_focused = false;
        if (this.review_box?.x === 0) this.review.hide();
        return null;
      case "hide":
        this.review.hide();
        this.review_focused = false;
        return null;
      case "leave":
        this.review_focused = false;
        if (this.review_box?.x === 0) this.review.hide();
        return null;
      case "copy":
        return { kind: "copy", text: effect.text };
      default:
        return null;
    }
  }
  private activate(act: Target["act"]): Effect | null {
    switch (act.kind) {
      case "list":
        return this.pressList(act.list, act.k);
      case "search":
        return this.openEntry(promptSearch.entry(act.match));
      case "search-toggle":
        if (this.expandedSearches.has(act.id)) this.expandedSearches.delete(act.id);
        else this.expandedSearches.add(act.id);
        return null;
      case "review":
        this.leaveUI();
        this.review.openReference(act.ref.cwd, act.ref.source, "Corgi prompt");
        this.review_focused = true;
        return null;
      case "model":
        this.leaveUI();
        this.openPicker();
        return null;
      default:
        this.leaveUI();
        this.conversation.answer(act.id, act.kind === "allow");
        return null;
    }
  }
  private uiEntries(): { act: Target["act"]; row: number }[] {
    const out: { act: Target["act"]; row: number }[] = [];
    const add = (act: Target["act"], row: number) => {
      if (!sameAction(out.at(-1)?.act ?? null, act)) out.push({ act, row });
    };
    this.lines.forEach((line, row) => {
      if (line.list) add({ kind: "list", list: line.list.list, k: line.list.k }, row);
      if (line.searchToggle) add({ kind: "search-toggle", id: line.searchToggle }, row);
      if (line.search) add({ kind: "search", match: line.search }, row);
      for (const seg of line.segs) {
        const ref = seg.review && this.recognizedReview(seg.review);
        if (ref) add({ kind: "review", ref }, row);
      }
      if (line.ask) {
        add({ kind: "allow", id: line.ask }, row);
        add({ kind: "deny", id: line.ask }, row);
      }
    });
    return out;
  }
  private moveUI(delta: number): void {
    const entries = this.uiEntries();
    const selected = entries.findIndex(e => e.row === this.ui_row && sameAction(this.ui, e.act));
    const at = this.ui
      ? selected >= 0
        ? selected
        : entries.findIndex(e => sameAction(this.ui, e.act))
      : entries.length;
    const next = at + delta;
    if (next < 0) return;
    this.leaveUI();
    const entry = entries[next];
    if (!entry) return;
    this.ui = entry.act;
    this.ui_row = entry.row;
    if (entry.act.kind === "list") {
      this.listing = entry.act.list;
      this.listing.view.focused = true;
      if (delta < 0) this.listing.end(this.known());
      else this.listing.move(this.known(), -Number.MAX_SAFE_INTEGER);
      this.revealList();
    } else {
      const h = this.drawn?.thread?.h ?? 1;
      const end = this.lines.length - this.back;
      if (entry.row < end - h) this.back = this.lines.length - entry.row - h;
      else if (entry.row >= end) this.back = this.lines.length - entry.row - 1;
      if (entry.act.kind === "review") this.previewReview(entry.act.ref);
    }
  }
  private leaveUI(): void {
    this.leaveList();
    this.ui = null;
    this.ui_row = -1;
    this.hovered_review = null;
    this.review.preview(null);
  }
  /** Gives the newest list the keyboard, at its last conversation; false with none. */
  private enterList(): boolean {
    const list = this.newestList(),
      known = this.known();
    if (!list || !list.lines(known).length) return false;
    this.listing = list;
    this.ui = { kind: "list", list, k: 0 };
    list.view.focused = true;
    list.end(known);
    this.revealList();
    return true;
  }
  /** Ctrl+/: the newest list takes the keyboard with its search open, or
   * without when it's too short to search; false with none. */
  private searchList(): boolean {
    const list = this.newestList();
    if (!list) return false;
    if (this.listing !== list) {
      this.leaveUI();
      if (!this.enterList()) return false;
    }
    if (list.long()) list.view.startSearch();
    this.revealList();
    return true;
  }
  private leaveList(): void {
    const list = this.listing;
    if (!list) return;
    this.listing = null;
    list.view.focused = false;
    if (list.view.searching) list.view.stopSearch();
  }
  /** Scrolls the thread to show the list with the keyboard, and its selection. */
  private revealList(): void {
    const list = this.listing,
      h = this.drawn?.thread?.h ?? 0,
      start = list ? this.lines.findIndex(r => r.list?.list === list) : -1;
    if (!list || !h || start < 0) return;
    for (const row of [start + list.height() - 1, start + list.selectedRow(this.known()), start]) {
      const end = this.lines.length - this.back;
      if (row < end - h) this.back = this.lines.length - row - h;
      else if (row >= end) this.back = this.lines.length - row - 1;
    }
  }
  /** A press on row `k` of a list: its search takes the keyboard; a conversation opens. */
  private pressList(list: conversations.List, k: number): Effect | null {
    const press = list.press(this.known(), k);
    if (press !== "search") return press ? this.openEntry(press.open) : null;
    if (this.listing !== list) this.leaveUI();
    this.listing = list;
    this.ui = { kind: "list", list, k: 0 };
    list.view.startSearch();
    return null;
  }
  /** Shows a conversation a list picked; the card makes way for it. */
  private openEntry(entry: launcherResume.Entry): Effect {
    this.leaveUI();
    if (this.mode === "overlay") this.hide();
    return { kind: "open", entry };
  }
  private listMove(delta: number): void {
    // ↓ past the last conversation gives the keyboard back to the input.
    if (!this.listing!.move(this.known(), delta)) this.moveUI(Math.sign(delta));
    else this.revealList();
  }
  /** A key while a list has the keyboard. Typing searches a long list; any
   * other key leaves it and goes to the input: undefined says so. */
  private listKey(byte: number): Effect | null | undefined {
    const list = this.listing!,
      view = list.view;
    switch (byte) {
      case 9:
        this.leaveUI();
        return null;
      case 27:
        if (view.searching) view.leaveSearch();
        else this.leaveUI();
        return null;
      case 13: {
        const entry = list.selected(this.known());
        return entry ? this.openEntry(entry) : null;
      }
      case 14:
      case 16:
        this.listMove(byte === 14 ? 1 : -1);
        return null;
      case 127:
      case 8:
        if (!view.searching) return null;
        if (view.query.len === 0) view.leaveSearch();
        else {
          view.query.key(byte);
          view.home();
        }
        return null;
    }
    if (list.long() && byte >= 32 && byte !== 127) {
      if (!view.searching) {
        view.startSearch();
        if (byte === 47) return null;
      }
      view.query.key(byte);
      view.home();
      return null;
    }
    this.leaveUI();
    return undefined;
  }
  private listSequence(key: keys.Key | null, text: string): Effect | null | undefined {
    const view = this.listing!.view;
    switch (key) {
      case "up":
      case "down":
        this.listMove(key === "down" ? 1 : -1);
        return null;
      case "page_up":
      case "page_down":
        this.listMove((key === "page_down" ? 1 : -1) * conversations.shown_rows);
        return null;
      case "home":
      case "end":
      case "left":
      case "right":
      case "delete":
        if (!view.searching) break;
        view.query.sequence(text);
        return null;
    }
    this.leaveUI();
    return undefined;
  }
  /** Reads the session when due; true when the prompt needs drawing. */
  poll(now: number): boolean {
    let dirty = this.conversation.poll(now) || this.review_dirty;
    this.review_dirty = false;
    for (const due of this.rechecks.filter(r => now >= r.at)) rmSync(due.path, { force: true });
    this.rechecks = this.rechecks.filter(r => now < r.at);
    if (this.burn_until && now >= this.burn_until) {
      this.burn_until = 0;
      dirty = true;
    }
    if (!this.open) return dirty;
    if (this.conversation.attention() === "finished") this.conversation.seen();
    const state = this.conversation.state,
      busy = state === "working" || state === "starting",
      frame =
        this.corgi(now) +
        (busy ? frames.thinking[Math.floor(now / 80) % frames.thinking.length] : "") +
        (busy ? Math.floor((now - this.conversation.working_since) / 1000) : "");
    if (frame !== this.frame) {
      this.frame = frame;
      dirty = true;
    }
    return dirty;
  }
  /** `preview` is the picture of the image the pointer rests on, as the host
   * holds it. Returns the boxes drawn over. */
  draw(w: Writer, cols: number, rows: number, marks: Marks | null, now: number, preview?: Preview): Rect[] {
    this.drawn = null;
    this.targets = [];
    this.chip_spots = [];
    this.review_box = null;
    if (!this.open) return [];
    const review_width = cols >= 85 ? Math.max(reviewPanel.min_width, Math.floor(cols * 0.48)) : 0;
    this.menu_cols = cols - (this.review.open && review_width ? review_width + 1 : 0);
    const reserved = this.review.open && review_width ? review_width + 1 : 0;
    if (this.review.open && !review_width) {
      this.review_box = new Rect(0, 0, cols, rows);
      this.review.draw(w, 0, 0, cols, rows, this.review_focused);
      return [this.review_box];
    }
    const built = this.layout(cols - reserved, rows, now);
    if (!built) {
      // Too small for the card: say so where the status line goes; Esc still closes it.
      if (rows < 1) return [];
      const message = ellipsis(" Corgi prompt: enlarge terminal or Esc", cols);
      w.write(at(0, rows - 1) + s.text + message);
      w.splat(" ", cols - displayWidth(message));
      w.write("\x1b[0m");
      return [new Rect(0, rows - 1, cols, 1)];
    }
    const { l, lines } = built,
      panel = l.panel,
      // A mark is an image over the text: none goes where the menu covers.
      under: Marks | null =
        marks && panel
          ? (provider, col, row) =>
              row >= panel.y && row < panel.y + panel.h && col + 2 > panel.x && col < panel.x + panel.w
                ? ""
                : marks(provider, col, row)
          : marks;
    if (panel) this.review.preview(null);
    this.drawBox(w, l);
    // The corgi sits at the right of the card's top edge, leaving the input its room.
    const corgi = this.corgi(now);
    w.write(at(l.right - displayWidth(corgi) - 1, l.box.y) + " " + s.muted + corgi + " ");
    if (this.memory_view) {
      w.write(at(l.left - 1, l.box.y) + " " + s.bold + "Memory" + s.border + " ");
      this.memory_view.draw(w, new Rect(l.left, l.box.y + 1, l.right - l.left, l.footer_y - l.box.y - 2));
    } else {
      if (l.thread) this.drawThread(w, l, lines, under);
      this.drawInput(w, l, now, under);
    }
    this.drawFooter(w, l, under);
    const boxes = [l.box];
    if (panel) boxes.push(panel);
    if (panel && this.picker) this.picker.draw(w, panel, marks, now);
    else if (panel) this.drawMenu(w, panel, marks);
    else if (this.hovered) {
      const shown = this.drawPreview(w, cols, rows, preview ?? { pictures: false, thumbnail: null });
      if (shown) boxes.push(shown);
    }
    if (review_width && (this.review.open || this.review.ghosted)) {
      this.review_box = new Rect(cols - review_width, 0, review_width, rows);
      if (this.review.open) this.review.draw(w, this.review_box.x, 0, review_width, rows, this.review_focused);
      if (this.review.ghosted) this.review.drawGhost(w, this.review_box.x, 0, review_width, rows);
      boxes.push(this.review_box);
    }
    w.write("\x1b[0m");
    this.drawn = l;
    return boxes;
  }

  /** The menu the input shows: commands while it is one `/word`, or what
   * an `@word` the caret ends can attach. A trigger that's gone lets a menu
   * Esc closed open again. */
  private popup(): Popup | null {
    const text = this.area.text,
      token = this.token();
    if (this.dismissed?.kind === "slash" && !text.startsWith("/")) this.dismissed = null;
    if (this.dismissed?.kind === "mention" && token?.start !== this.dismissed.start) this.dismissed = null;
    let popup: Popup | null = null;
    if (!this.burn_until && text.startsWith("/") && !/\s/.test(text)) {
      const items = this.dismissed ? [] : matching(text.slice(1), this.mode);
      if (items.length) popup = { kind: "slash", items };
    } else if (!this.burn_until && token && !this.dismissed) {
      // This workspace's, the workspaces themselves, and what an attached one holds.
      const attached = new Set(this.chips.flatMap(c => (c.mention.kind === "workspace" ? [c.mention.id] : []))),
        offered = (this.context?.mentions ?? []).filter(
          m =>
            !this.chips.some(c => sameMention(c.mention, m)) &&
            (!("workspace" in m) || !m.workspace || attached.has(m.workspace.id)),
        ),
        items = mentionsMatching(offered, token.query, this.context);
      if (items.length) popup = { kind: "mention", items, ...token };
    }
    const key = popup ? `${popup.kind}:${popup.kind === "slash" ? text : `${popup.start}:${popup.query}`}` : "";
    if (key !== this.menu_key) {
      this.menu_key = key;
      this.menu_at = 0;
      this.menu_first = 0;
    }
    if (popup) this.menu_at = clamp(this.menu_at, 0, popup.items.length - 1);
    return popup;
  }
  /** The `@words` the caret ends while they're typed: where the @ is, and
   * what follows on its line. Spaces may follow, so a name of several words
   * is found; the menu closes once nothing matches. */
  private token(): { start: number; query: string } | null {
    const text = this.area.text,
      caret = this.area.caret;
    if (!caret || this.area.selection()) return null;
    const at = text.lastIndexOf("@", caret - 1);
    if (at < 0 || (at > 0 && !/\s/.test(text[at - 1]))) return null;
    const query = text.slice(at + 1, caret);
    return /^\s|[\n@]/.test(query) || query.length > mention_query ? null : { start: at, query };
  }
  private move(popup: Popup, step: number): void {
    const n = popup.items.length;
    this.menu_at = (this.menu_at + step + n) % n;
  }
  /** The menu row at a cell, where the menu is drawn; null off it. */
  private menuRow(x: number, y: number): number | null {
    const panel = this.drawn?.panel,
      popup = panel && !this.picker ? this.popup() : null;
    if (!panel || !popup) return null;
    const capacity = panel.h - 2,
      index = dropdown.hit(panel, Math.min(popup.items.length, capacity), x, y);
    return index === null ? null : this.menuFirst(popup.items.length, capacity) + index;
  }
  private complete(command: Command): void {
    const takes = commands.find(c => c.name === command)!.takes;
    this.area = new TextArea(`/${command}${takes ? " " : ""}`, true);
  }
  /** Takes the typed `@word` out of the box and attaches what's highlighted. */
  private mention(popup: Extract<Popup, { kind: "mention" }>): void {
    const text = this.area.text,
      caret = this.area.caret;
    this.area = new TextArea(text.slice(0, popup.start) + text.slice(caret), true);
    this.area.caret = popup.start;
    this.addChip(popup.items[this.menu_at], false);
  }
  /** Attaches a pasted image to the next message, named for its place among them. */
  attachImage(path: string, mime: string): void {
    const n = this.chips.filter(c => c.mention.kind === "image").length + 1;
    this.addChip({ kind: "image", path, mime, name: `Image ${n}` }, false);
  }
  /** Attaches `mention` to the next message and starts reading what it holds. */
  private addChip(mention: Mention, auto: boolean): void {
    if (this.chips.some(c => sameMention(c.mention, mention))) return;
    const chip: Chip = { mention, auto, body: null, error: null, pending: null };
    this.chips.push(chip);
    // An image goes as itself; there's nothing to read.
    if (!this.deps.resolve || mention.kind === "image") chip.body = "";
    else
      chip.pending = this.deps
        .resolve(mention)
        .then(
          text => {
            chip.body = clean(text, true);
          },
          error => {
            chip.error = errors.name(error) ?? "unknown error";
          },
        )
        .finally(() => {
          chip.pending = null;
          this.conversation.changed();
        });
  }
  private openPicker(): void {
    this.picker = new Picker(this.entries, this.suggested, this.choice, this.briefs, {
      pins: [this.autoPin()],
      current_pin: this.choice ? null : "auto",
    });
  }
  /** The memory view closed, or asked for a file in the editor, in a tab beside the card's. */
  private remembered(result: MemoryResult): Effect | null {
    if (result) this.memory_view = null;
    if (result?.kind !== "open") return null;
    try {
      mkdirSync(this.memory.dir, { recursive: true });
    } catch {}
    this.hide();
    return {
      kind: "pane",
      argv: ["sh", "-c", 'exec ${EDITOR:-vi} "$1"', "sh", result.file],
      cwd: this.memory.dir,
    };
  }
  private picked(result: Result): Effect | null {
    if (result === "close") this.picker = null;
    if (result !== "pick" || !this.picker) return null;
    this.choice = this.picker.pinned() === "auto" ? null : this.picker.chosen();
    this.picker = null;
    return { kind: "pick", choice: this.choice };
  }
  private enter(): Effect | null {
    const popup = this.popup();
    if (popup?.kind === "mention") {
      this.mention(popup);
      return null;
    }
    if (popup) {
      const command = popup.items[this.menu_at];
      if (commands.find(c => c.name === command)!.takes) {
        this.complete(command);
        return null;
      }
      return this.run(command, "");
    }
    const text = this.area.text.trim(),
      ask = this.conversation.pending();
    // A pasted image goes even with nothing typed.
    if (!text) return this.chips.some(c => c.mention.kind === "image") ? this.ask("") : null;
    // A lone y or n answers the request; anything longer is a reply.
    if (ask && /^[yn]$/i.test(text)) {
      this.area = new TextArea("", true);
      this.conversation.answer(ask.id, text.toLowerCase() === "y");
      return null;
    }
    if (text.startsWith("/")) {
      const word = text.slice(1).split(/\s/, 1)[0],
        command = parseCommand(word, this.mode);
      if (command) return this.run(command, text.slice(1 + word.length).trim());
      this.conversation.note(`/${word} isn't a command. Type / to see them.`, "warm");
      return null;
    }
    return this.ask(text);
  }
  /** Sends a message. Following Auto, the conversation keeps the model it
   * started on until the user picks one. */
  private ask(text: string): Effect | null {
    const choice = this.current();
    if (!choice) {
      this.conversation.note(
        this.loading ? "The models are still loading; send again in a moment." : "Pick a model first: press ⇥.",
        "warm",
      );
      return null;
    }
    this.area = new TextArea("", true);
    this.history = null;
    this.back = 0;
    const c = this.conversation,
      started = c.started;
    if (
      c.session &&
      started &&
      (started.provider !== choice.provider ||
        started.account !== choice.account ||
        started.model !== choice.model ||
        started.effort !== choice.effort)
    ) {
      this.stopping(c.stop());
      c.note(`${label(choice)} from here on, in a new session that doesn't see the messages above.`, "faint");
    }
    this.post(text, this.chips.splice(0), choice);
    return null;
  }
  /** Sends `text` with its attachments once they're read, or after a few
   * seconds with what's there. Messages go in the order they were sent. */
  private post(text: string, chips: Chip[], choice: Choice): void {
    this.references.forgetMissing();
    const send = () => {
      // Images go as images; the rest go as context blocks before the text.
      const images = chips.flatMap(chip =>
          chip.mention.kind === "image" ? [{ path: chip.mention.path, mime: chip.mention.mime }] : [],
        ),
        attached = chips
          .filter(chip => chip.mention.kind !== "image")
          .map(chip => ({
            kind: chip.mention.kind === "agent" && !chip.mention.provider ? "pane" : chip.mention.kind,
            name: mentionName(chip.mention, this.context),
            body:
              chip.body ??
              (chip.error
                ? `(Corgi couldn't read it: ${chip.error})`
                : "(Corgi was still reading it when this was sent)"),
          }));
      const viewer = this.deps.viewer?.() ?? null,
        wire =
          (viewer ? promptTools.where(viewer, this.context?.workspace ?? "") + "\n" : "") +
          (this.conversation.session ? promptTools.replyFormat() : "") +
          message(text, attached);
      this.conversation.send(
        text,
        () => this.start(choice),
        wire === text && !images.length ? undefined : { message: wire, chips: chips.map(chip => chip.mention) },
        images,
      );
    };
    const pending = chips.flatMap(chip => (chip.pending ? [chip.pending] : []));
    if (!pending.length && !this.outbox) return send();
    const names = chips.filter(chip => chip.pending).map(chip => mentionName(chip.mention, this.context)),
      ready = (this.outbox ?? Promise.resolve()).then(() =>
        Promise.race([Promise.all(pending), new Promise(done => setTimeout(done, attach_ms))]),
      ),
      sent: Promise<void> = ready.then(() => {
        send();
        this.conversation.changed();
      });
    this.reading = names;
    this.outbox = sent;
    void sent.finally(() => {
      if (this.outbox !== sent) return;
      this.outbox = null;
      this.reading = [];
    });
  }
  private start(choice: Choice): Start {
    const now = new Date(this.clock()),
      c = this.context;
    // Log lines searches keep finding move to MEMORY.md before it's loaded.
    if (!this.incognito)
      try {
        this.memory.dream(now);
      } catch {}
    const loaded = this.memory.load(c?.workspace || null, now);
    let instructions =
      this.memory.instructions(loaded.text, contextText(c), now, c?.workspace || null) +
      "\n\n" +
      promptTools.instructions(this.binary);
    if (this.incognito) instructions += "\n\nThis conversation is incognito: write nothing to memory or any log.";
    return {
      provider: choice.provider,
      account: choice.account,
      model: choice.model,
      effort: choice.effort,
      cwd: c?.cwd ?? "",
      workspace: c?.workspace_id ?? null,
      instructions,
      persist: !this.incognito,
    };
  }
  private run(command: Command, args: string): Effect | null {
    const c = this.conversation;
    this.area = new TextArea("", true);
    switch (command) {
      case "new":
        this.fresh(false);
        return null;
      case "incognito":
        this.fresh(true);
        c.note("Incognito: nothing from here on is kept, no transcript and no memory. /new ends it.", "faint");
        return null;
      case "remember":
      case "forget":
      case "dig":
        try {
          if (command === "remember") this.remember(args);
          else if (command === "forget") this.forget(args);
          else this.dig(args);
        } catch (error) {
          c.note(`Couldn't use the memory folder: ${errors.name(error) ?? "unknown error"}.`, "hot");
        }
        return null;
      case "forgetmenow":
        if (this.clock() < this.burn_until) {
          this.burn_until = 0;
          void this.burn();
        } else {
          this.burn_until = this.clock() + burn_ms;
          this.area = new TextArea("/forgetmenow", true);
        }
        return null;
      case "memory":
        this.memory_view = new MemoryView(this.memory, this.context?.workspace || null, this.clock);
        return null;
      case "close":
        return { kind: "close" };
      case "pane":
        return this.toPane();
    }
  }
  /** Hands the conversation to a Corgi pane: its thread goes to a file the
   * pane reads, the pane claims the session, and the card starts over. */
  private toPane(): Effect | null {
    const c = this.conversation,
      handed = c.handoff();
    if (!handed && c.state === "starting") {
      c.note("The session is still starting. Try again in a moment.", "warm");
      return null;
    }
    // With nothing asked yet, the pane starts the conversation with this pick.
    const choice = handed ? this.current() : this.choice,
      next = choice ?? this.auto ?? this.suggested[0] ?? null,
      start = handed?.start ?? null;
    let path: string;
    try {
      path = writeHandoff({
        conversation: handed,
        incognito: this.incognito,
        choice,
        catalog: { entries: this.entries, suggested: this.suggested, briefs: this.briefs, auto: this.auto },
        context: this.context,
      });
    } catch (error) {
      c.note(`Couldn't hand the chat to a pane: ${errors.name(error) ?? "unknown error"}.`, "hot");
      return null;
    }
    const cwd = start?.cwd ?? this.context?.cwd ?? "",
      argv = [
        ...corgiCommand(),
        "__chat",
        ...chatArgs({
          handoff: path,
          provider: handed?.provider ?? next?.provider ?? Provider.first,
          session: handed?.session ?? "",
          account: start?.account ?? next?.account ?? "",
          model: start?.model ?? next?.model ?? "",
          effort: start ? start.effort : (next?.effort ?? null),
          incognito: this.incognito,
          cwd,
          workspace: start ? start.workspace : (this.context?.workspace_id ?? null),
        }),
      ];
    if (handed) {
      c.release();
      this.incognito = false;
      c.memory_writes = true;
      c.note("Continued in a Corgi pane.", "faint");
    }
    this.hide();
    return { kind: "pane", argv, cwd: cwd || this.context?.cwd || "" };
  }
  /** A new conversation; incognito or not. */
  private fresh(incognito: boolean): void {
    this.history = null;
    this.leaveUI();
    this.review.hide();
    this.review_focused = false;
    // The conversation let go stores what it should first, unless nothing may be kept.
    this.stopping(this.conversation.reset(this.incognito ? null : memoryFlush));
    this.incognito = incognito;
    this.conversation.memory_writes = !incognito;
    this.back = 0;
  }
  private remember(line: string): void {
    const c = this.conversation;
    if (!line) return c.note("Say what to keep: /remember CI runs unit tests in parallel", "warm");
    if (this.incognito) return c.note("Incognito keeps nothing, so /remember is off until /new.", "warm");
    // As OpenClaw keeps it: today's log, which searches that keep finding it move to MEMORY.md.
    const written = this.memory.remember(line, new Date(this.clock()), "today");
    if (!written.line) return;
    c.wrote.push(written);
    c.note(`remembered ${shownLine(written.line)} → ${basename(written.file)}`, "faint", true);
  }
  private forget(words: string): void {
    const c = this.conversation;
    if (!words) return c.note("Say which line: /forget CI runs", "warm");
    const hits = this.memory.find(words);
    if (!hits.length) return c.note(`Nothing in memory matches “${words}”.`, "faint");
    const want = words.replace(/\s+/g, " ").toLowerCase(),
      exact = hits.find(h => h.line.toLowerCase() === want) ?? (hits.length === 1 ? hits[0] : null);
    if (exact) {
      if (this.memory.forget(exact.line)) c.note(`forgot ${exact.line} ← ${exact.file}`, "faint", true);
      else c.note(`Couldn't drop that line from ${exact.file}.`, "hot");
      return;
    }
    for (const h of hits.slice(0, 6)) c.note(`${h.line} · ${h.file}`, "faint", true);
    c.note(`${hits.length} lines match. /forget with the whole line drops one.`, "warm");
  }
  private dig(words: string): void {
    const c = this.conversation;
    if (!words) return c.note("Say what to look for: /dig splitter", "warm");
    const hits = this.memory.find(words);
    if (!hits.length) return c.note(`Nothing in memory matches “${words}”.`, "faint");
    for (const h of hits.slice(0, 8)) c.note(`${h.line} · ${h.file.replace(/\.md$/, "")}`, "faint", true);
    if (hits.length > 8) c.note(`and ${hits.length - 8} more`, "faint");
  }
  /** /forgetmenow: stops every session the thread used and deletes each
   * transcript Corgi can find, strikes the memory lines it wrote where they
   * still read as written, and clears the thread. The note says what went
   * and what stays. */
  private async burn(): Promise<void> {
    this.history = null;
    this.leaveUI();
    this.review.hide();
    this.review_focused = false;
    const c = this.conversation,
      used = c.used,
      wrote = c.wrote,
      launching = c.launching,
      current = c.provider && c.session ? `${c.provider}\0${c.session}` : "";
    this.incognito = false;
    c.memory_writes = true;
    let unstopped: string | null = null;
    try {
      await c.reset();
    } catch (error) {
      unstopped = errors.name(error) ?? "unknown error";
    }
    // A session still starting arrives after the reset, which stops it.
    const late = launching ? await launching : null;
    if (late) used.push(late);
    const gone = ["the chat"],
      left: string[] = [];
    try {
      const missed = this.memory.strike(wrote);
      if (wrote.length > missed.length) gone.push(count(wrote.length - missed.length, "memory line"));
      for (const w of missed)
        left.push(`A memory line changed since it was written, so it stays: ${shownLine(w.line)}`);
    } catch (error) {
      left.push(`The memory lines it wrote stay: ${errors.name(error) ?? "unknown error"}.`);
    }
    const deleted: string[] = [];
    for (const u of used) {
      if (!u.persist) continue;
      const name = adapter(u.provider).name;
      let failed = `${u.provider}\0${u.session}` === current ? unstopped : null;
      if (u === late)
        try {
          await c.end(u.provider, u.session);
        } catch (error) {
          failed = errors.name(error) ?? "unknown error";
        }
      if (failed) {
        left.push(`${name}'s transcript of session ${u.session} stays: the session didn't stop (${failed}).`);
        continue;
      }
      const path = u.transcript || this.transcript(u.provider, u.session, u.account);
      if (deletable(path, u.session)) {
        rmSync(path, { force: true });
        this.rechecks.push({ path, at: this.clock() + 1500 });
        deleted.push(name);
      } else left.push(`${name} keeps its transcript of session ${u.session}: Corgi doesn't know where it is.`);
    }
    if (deleted.length === 1) gone.push(`${deleted[0]}'s transcript`);
    else if (deleted.length) gone.push(`${deleted.length} transcripts`);
    c.note(`burned ${gone.join(", ").replace(/, ([^,]*)$/, " and $1")}`, "faint", true);
    for (const line of left) c.note(line, "warm");
    c.changed();
  }
  /** Where `session`'s transcript is, if Corgi knows: Pi and omp remember
   * theirs, Claude's sits in a project folder, and the daemon knows the
   * others' from their hooks. No adapter hook locates a transcript, so this
   * is the one place that asks. */
  private transcript(provider: Provider, session: string, account: string): string {
    const located =
      provider === "pi"
        ? piLocations.locate(session, account)
        : provider === "omp"
          ? ompLocations.locate(session, account)
          : provider === "claude"
            ? claudeHistory.locate(session, account)
            : "";
    if (isAbsolute(located) && existsSync(located)) return located;
    const known = this.deps.transcript?.(provider, session) ?? "";
    return known && existsSync(known) ? known : "";
  }
  private stopping(stopped: Promise<void>): void {
    stopped.catch(error => {
      this.conversation.note(`Couldn't stop the session: ${errors.name(error) ?? "unknown error"}.`, "hot");
      this.conversation.changed();
    });
  }
  private corgi(now: number): string {
    switch (this.conversation.state) {
      case "blocked":
        return ears[Math.floor(now / 260) % ears.length];
      case "working":
      case "starting":
        return frames.sniff[Math.floor(now / 200) % frames.sniff.length];
      // Nothing under way: it sleeps.
      default:
        return frames.asleep;
    }
  }
  /** The card: its size follows the thread and the input, never a chip or
   * a menu. Its top stays where it opened while the terminal keeps its size,
   * moving up only when the card would run off the bottom. */
  private layout(cols: number, rows: number, now: number): { l: Layout; lines: Row[] } | null {
    if (cols < 36 || rows < 10) return null;
    if (this.mode === "pane") return this.paneLayout(cols, rows, now);
    const w = Math.min(cols >= 56 ? cols - 8 : cols - 2, max_w),
      x = Math.floor((cols - w) / 2),
      left = x + 3,
      right = x + w - 3;
    const chips = this.inline(right - left - text_x);
    this.fit(right - left - text_x, chips);
    const max_h = Math.max(9, Math.floor(rows * 0.8)),
      input_rows = clamp(this.area.lines().length, 1, Math.min(max_input_rows, max_h - 6)),
      lines = this.rows(right - left, now);
    // The input sits right between the rules, with no rows padding it. The
    // memory takes the card at its tallest, so browsing doesn't resize it.
    let h: number,
      thread_h = 0;
    if (this.memory_view) {
      thread_h = Math.max(0, max_h - 5 - input_rows);
      h = 5 + thread_h + input_rows;
    } else if (!lines.length) h = 4 + input_rows;
    else {
      thread_h = Math.min(lines.length, Math.max(0, max_h - 5 - input_rows));
      h = 5 + thread_h + input_rows;
    }
    if (h > rows) return null;
    const size = `${cols}x${rows}`;
    if (this.anchor?.size !== size) this.anchor = { size, top: Math.max(0, Math.floor((rows - h) / 3)) };
    this.anchor.top = clamp(this.anchor.top, 0, rows - h);
    const y = this.anchor.top,
      box = new Rect(x, y, w, h),
      footer_y = y + h - 2,
      threaded = lines.length > 0 || this.memory_view !== null,
      input_y = threaded ? y + thread_h + 2 : y + 1,
      thread = threaded && thread_h > 0 ? new Rect(left, y + 1, right - left, thread_h) : null;
    return {
      l: {
        box,
        left,
        right,
        thread,
        input_y,
        input_rows,
        chips,
        footer_y,
        // The memory runs from the top to the footer's rule.
        rules: threaded && !this.memory_view ? [y + thread_h + 1, footer_y - 1] : [footer_y - 1],
        panel: this.place(box, thread, left, right, rows),
      },
      lines,
    };
  }
  /** The input takes `room` columns; its first line starts after the chips,
   * and the lines after it wrap back under them. */
  private fit(room: number, chips: Inline): void {
    this.area.width = Math.max(1, room);
    this.area.lead = Math.min(chips.width, this.area.width - 1);
  }
  /** In a pane the card is the pane: the thread takes what the input and
   * the footer leave, and menus open over it. */
  private paneLayout(cols: number, rows: number, now: number): { l: Layout; lines: Row[] } {
    const box = new Rect(0, 0, cols, rows),
      left = 3,
      right = cols - 3,
      chips = this.inline(right - left - text_x);
    this.fit(right - left - text_x, chips);
    const input_rows = clamp(this.area.lines().length, 1, Math.min(max_input_rows, rows - 6)),
      lines = this.rows(right - left, now),
      thread_h = rows - 5 - input_rows,
      thread = new Rect(left, 1, right - left, thread_h),
      footer_y = rows - 2;
    return {
      l: {
        box,
        left,
        right,
        thread,
        input_y: thread_h + 2,
        input_rows,
        chips,
        footer_y,
        rules: this.memory_view ? [footer_y - 1] : [thread_h + 1, footer_y - 1],
        panel: this.place(box, thread, left, right, rows),
      },
      lines,
    };
  }
  /** Where the menu or the picker opens: over the thread just above the
   * input when it fits there, else hanging below the card, else above it,
   * else wherever has the most room. It takes the most rows it may need
   * while open, and keeps them and its place until it closes. */
  private place(box: Rect, thread: Rect | null, left: number, right: number, rows: number): Rect | null {
    const popup = this.picker ? null : this.popup();
    if (!this.picker && !popup) {
      this.placed = null;
      return null;
    }
    const kind = this.picker ? "picker" : popup!.kind,
      key = `${kind}:${box.x},${box.y},${box.w},${box.h}:${rows}:${this.menu_cols}`;
    if (this.placed?.key === key) return this.placed.rect;
    const room = { inside: thread?.h ?? 0, below: rows - box.y - box.h, above: box.y },
      want = this.picker
        ? this.picker.height(rows)
        : popup!.kind === "slash"
          ? offered(this.mode).length + 2
          : (this.context?.mentions.length ?? 0) + 2;
    const where: keyof typeof room =
      want <= room.inside
        ? "inside"
        : want <= room.below
          ? "below"
          : want <= room.above
            ? "above"
            : room.inside >= room.below && room.inside >= room.above
              ? "inside"
              : room.below >= room.above
                ? "below"
                : "above";
    const h = Math.min(want, room[where]);
    if (h < 3) return null;
    const y = where === "inside" ? thread!.y + thread!.h - h : where === "below" ? box.y + box.h : box.y - h;
    const slash = popup?.kind === "slash";
    // Match dropdown's label column, gap and borders; filtering never changes this width.
    const wanted = slash ? Math.max(...offered(this.mode).map(c => displayWidth(c.about))) + 21 : 0;
    const w = slash
      ? Math.min(this.menu_cols - 2, Math.max(right - left + 2, wanted))
      : Math.min(right - left + 2, this.picker ? 76 : 64);
    const rect = new Rect(clamp(left - 1, 1, Math.max(1, this.menu_cols - w - 1)), y, w, h);
    this.placed = { key, rect };
    return rect;
  }
  /** The thread as rows `room` columns wide, oldest first, with a blank
   * between unlike rows and after the last. */
  private rows(totalRoom: number, now: number): Row[] {
    const out: Row[] = [],
      first = this.conversation.pending(),
      latestSearch = this.conversation.items.findLast(item => item.kind === "search"),
      spinner = frames.thinking[Math.floor(now / 80) % frames.thinking.length];
    let last: string | null = null;
    const group = (item: Item) =>
      item.kind === "search" || item.kind === "tool" || item.kind === "ask"
        ? "activity"
        : item.kind === "note"
          ? item.bone
            ? "bone"
            : "note"
          : null;
    for (const item of this.conversation.items) {
      if (item.kind === "tool" && item.search) continue;
      const kind = group(item);
      if (last === "activity" && kind !== last) out.push({ segs: [], frame: "bottom" });
      if (out.length && (kind === null || kind !== last)) out.push({ segs: [] });
      if (kind === "activity" && last !== kind) out.push({ segs: [], frame: "top", label: "Activity" });
      last = kind;
      const begin = out.length,
        room = Math.max(1, totalRoom - (kind === "activity" ? 4 : 0));
      switch (item.kind) {
        case "user": {
          // Its chips lead it as they led the input, and its text wraps as it did there.
          const head = out.length,
            chips = item.chips?.length ? lay(item.chips, room - text_x, this.context) : null,
            area = new TextArea(item.text);
          area.width = Math.max(1, room - text_x);
          area.lead = chips ? Math.min(chips.width, area.width - 1) : 0;
          const lines = area.lines();
          lines.forEach((line, i) => {
            const join = i ? item.text.slice(lines[i - 1].end, line.start) : "\n";
            out.push({
              segs: [
                { text: i ? "  " : "› ", style: s.user_mark },
                { text: " ".repeat(area.leadOf(i)) + item.text.slice(line.start, line.end), style: s.user },
              ],
              fill: s.user,
              ...(i === 0 && chips ? { chips } : {}),
              ...(join !== "\n" ? { cont: { join, skip: text_x } } : {}),
            });
          });
          if (item.steer) {
            // Whether it steered a running turn ends its first line, or takes one of its own.
            const along = [{ text: "steered", style: s.user_with }];
            if (width(out[head].segs) + 2 + width(along) <= room) out[head].right = along;
            else out.push({ segs: clip([{ text: "  ", style: s.user }, ...along], room), fill: s.user });
          }
          break;
        }
        case "text":
          out.push(...this.markdown(item, room));
          break;
        case "tool":
          out.push({
            segs: clip(
              [
                { text: item.done ? "●" : spinner, style: s.spin },
                { text: " " + item.name, style: s.bold },
                { text: item.summary ? " " + item.summary : "", style: s.muted },
              ],
              room,
            ),
          });
          break;
        case "search": {
          const search = item.search,
            done = promptSearch.finished(search),
            failed = search.phase === "failed" || search.phase === "cancelled",
            symbol = failed ? "×" : done ? "✓" : spinner,
            expanded = this.expandedSearches.has(search.id),
            show = expanded || item === latestSearch,
            label =
              search.phase === "checking"
                ? "Checking for new conversations"
                : search.phase === "indexing"
                  ? "Updating conversation index"
                  : search.phase === "searching"
                    ? "Searching conversations"
                    : search.phase === "failed"
                      ? "Search failed"
                      : search.phase === "cancelled"
                        ? "Search stopped"
                        : "Found",
            count = `${search.found}${search.limited ? "+" : ""} conversation${search.found === 1 ? "" : "s"}`,
            detail =
              search.phase === "indexing"
                ? search.total
                  ? ` · ${search.scanned}/${search.total}`
                  : ""
                : !done
                  ? ` · ${count} found`
                  : "";
          out.push({
            segs: clip(
              [
                { text: symbol + " ", style: failed ? s.hot : s.spin },
                { text: label + (search.phase === "done" ? " " + count : ""), style: s.bold },
                { text: detail + (!show ? " · " + search.expression : ""), style: s.muted },
              ],
              room,
            ),
            searchToggle: search.id,
          });
          if (!show) break;
          out.push({ segs: clip([{ text: "  " + search.expression, style: s.muted }], room) });
          if (expanded) out.push({ segs: clip([{ text: "  " + search.workspace, style: s.faint }], room) });
          if (search.error) out.push({ segs: clip([{ text: "  " + search.error, style: s.hot }], room) });
          const known = this.known();
          for (const raw of search.matches.slice(0, expanded ? promptSearch.top_k : 3)) {
            const saved = known.history.entries.find(e => e.provider === raw.provider && e.session === raw.session),
              title = saved?.title || raw.title || saved?.first || "Untitled conversation",
              match = { ...raw, title },
              open = known.opened(promptSearch.entry(match));
            out.push({
              segs: clip(
                [
                  { text: open ? "● " : "○ ", style: open ? s.warm : s.faint },
                  { text: "   " + adapter(match.provider).name.padEnd(6) + " ", style: s.muted },
                  { text: title, style: s.text },
                ],
                room,
              ),
              search: match,
            });
            if (expanded && match.excerpt)
              out.push({ segs: clip([{ text: "     " + match.excerpt, style: s.muted }], room) });
          }
          break;
        }
        case "ask": {
          if (item.answer === null) {
            const right =
              item === first
                ? [
                    { text: "y⏎", style: s.key },
                    { text: " allow   ", style: s.faint },
                    { text: "n⏎", style: s.key },
                    { text: " deny", style: s.faint },
                  ]
                : [];
            out.push({
              segs: clip(
                [
                  { text: "● needs you  ", style: s.warm },
                  { text: item.name, style: s.bold },
                  { text: item.summary ? " " + item.summary : "", style: s.muted },
                ],
                room - (right.length ? width(right) + 2 : 0),
              ),
              right,
              ask: item.id,
            });
          } else
            out.push({
              segs: clip(
                [
                  { text: "● ", style: item.answer === "allow" ? s.muted : s.faint },
                  { text: item.answer === "allow" ? "allowed  " : "denied  ", style: s.faint },
                  { text: item.name, style: s.text },
                  { text: item.summary ? " " + item.summary : "", style: s.faint },
                ],
                room,
              ),
            });
          break;
        }
        case "note": {
          const tone = item.tone === "hot" ? s.hot : item.tone === "warm" ? s.warm : s.faint;
          const segs = item.bone
            ? [
                { text: "ε=з ", style: s.faint },
                { text: item.text, style: s.muted },
              ]
            : [{ text: item.text, style: tone }];
          out.push(...wrapped(segs, room, item.bone ? 4 : 0));
          break;
        }
      }
      if (kind === "activity") for (let i = begin; i < out.length; i++) out[i].frame = "body";
    }
    if (last === "activity") out.push({ segs: [], frame: "bottom" });
    if (out.length) out.push({ segs: [] });
    return out;
  }
  /** A reply's lines as its Markdown lays them out; a `conversations`
   * fence as a list of them. */
  private markdown(item: Extract<Item, { kind: "text" }>, room: number): Row[] {
    const out: Row[] = [],
      lists = this.lists.get(item) ?? [];
    this.lists.set(item, lists);
    let listed = 0;
    for (const line of markdown.lines(item, room)) {
      if ("segs" in line) {
        out.push(line);
        continue;
      }
      const list = (lists[listed++] ??= new conversations.List([]));
      list.refs = conversations.refs(line.conversations);
      out.push({ segs: [], frame: "top", label: "Conversations" });
      for (let k = 0; k < list.height(); k++) out.push({ segs: [], frame: "body", list: { list, k } });
      out.push({ segs: [], frame: "bottom" });
    }
    return out;
  }
  private drawBox(w: Writer, l: Layout): void {
    const b = l.box;
    for (let row = 0; row < b.h; row++) {
      const y = b.y + row;
      w.write(at(b.x, y) + s.border);
      if (row === 0) w.write("╭" + "─".repeat(b.w - 2) + "╮");
      else if (row === b.h - 1) w.write("╰" + "─".repeat(b.w - 2) + "╯");
      else if (l.rules.includes(y)) w.write("├" + "─".repeat(b.w - 2) + "┤");
      else {
        w.write("│" + s.text);
        w.splat(" ", b.w - 2);
        w.write(s.border + "│");
      }
    }
  }
  private drawThread(w: Writer, l: Layout, lines: Row[], marks: Marks | null): void {
    const t = l.thread!;
    if (this.back > 0 && lines.length > this.total) this.back += lines.length - this.total;
    this.total = lines.length;
    this.back = clamp(this.back, 0, Math.max(0, lines.length - t.h));
    const end = lines.length - this.back,
      shown = lines.slice(Math.max(0, end - t.h), end);
    // Rows laid out at another width, or a thread begun anew, hold other text.
    if (this.selection?.on === "thread" && (this.selection.room !== t.w || lines.length < this.lines.length))
      this.selection = null;
    this.lines = lines;
    this.shown_from = Math.max(0, end - t.h);
    const newest = this.newestList();
    shown.forEach((row, i) => {
      const y = t.y + i,
        inset = row.frame === "body" ? 2 : 0,
        left = l.left + inset,
        right = l.right - inset;
      if (row.frame) {
        w.write(at(l.left, y) + s.border);
        if (row.frame === "body") {
          w.write("│");
          w.write(at(l.right - 1, y) + s.border + "│");
        } else {
          const top = row.frame === "top",
            label = top && row.label ? " " + row.label + " " : "",
            caption = ellipsis(label, Math.max(0, t.w - 4));
          w.write(
            (top ? "╭" : "╰") +
              "─" +
              s.muted +
              caption +
              s.border +
              "─".repeat(Math.max(0, t.w - 3 - displayWidth(caption))) +
              (top ? "╮" : "╯"),
          );
          return;
        }
      }
      if (row.list) {
        // As the launcher draws its rows: 1-based, across the card from its
        // border. Ctrl+/ searches the newest list; a click, any.
        const cap = row.list.list === newest ? "ctrl+/" : "";
        row.list.list.draw(w, this.known(), row.list.k, l.left + 1, y + 1, t.w, marks, cap);
        this.targets.push({ x: l.left + 1, y, w: t.w - 2, act: { kind: "list", ...row.list } });
        return;
      }
      if (row.fill) {
        w.write(at(l.box.x + 1, y) + row.fill);
        w.splat(" ", l.box.w - 2);
      }
      let seg_x = left;
      for (const seg of row.segs) {
        const ref = seg.review && this.recognizedReview(seg.review, true);
        const act: Target["act"] | null = ref ? { kind: "review", ref } : null;
        const selected =
          act &&
          (sameAction(this.ui, act) ||
            (this.hovered_review && sameAction({ kind: "review", ref: this.hovered_review }, act)));
        seg_x = writeSegs(w, seg_x, y, [
          { ...seg, style: selected ? palette.selection : act ? seg.style + "\x1b[4m" : seg.style },
        ]);
        if (act) this.targets.push({ x: seg_x - displayWidth(seg.text), y, w: displayWidth(seg.text), act });
      }
      const rowAct: Target["act"] | null = row.searchToggle
        ? { kind: "search-toggle", id: row.searchToggle }
        : row.search
          ? { kind: "search", match: row.search }
          : null;
      if (rowAct && sameAction(this.ui, rowAct))
        writeSegs(
          w,
          left,
          y,
          row.segs.map(seg => ({ ...seg, style: palette.selection })),
        );
      if (row.searchToggle)
        this.targets.push({ x: left, y, w: right - left, act: { kind: "search-toggle", id: row.searchToggle } });
      if (row.search) {
        writeMark(w, row.search.provider, left + 2, y, marks);
        this.targets.push({ x: left, y, w: right - left, act: { kind: "search", match: row.search } });
      }
      if (row.chips) this.drawChips(w, l.left + text_x, y, row.chips, marks);
      if (row.right?.length) {
        const x = right - width(row.right);
        writeSegs(w, x, y, row.right);
        if (row.ask) {
          const allow = displayWidth(row.right[0].text + row.right[1].text.trimEnd()),
            deny = width(row.right.slice(2));
          this.targets.push({ x, y, w: allow, act: { kind: "allow", id: row.ask } });
          this.targets.push({ x: right - deny, y, w: deny, act: { kind: "deny", id: row.ask } });
          if (sameAction(this.ui, { kind: "allow", id: row.ask }))
            writeSegs(
              w,
              x,
              y,
              row.right.slice(0, 2).map(seg => ({ ...seg, style: palette.selection })),
            );
          if (sameAction(this.ui, { kind: "deny", id: row.ask }))
            writeSegs(
              w,
              right - deny,
              y,
              row.right.slice(2).map(seg => ({ ...seg, style: palette.selection })),
            );
        }
      }
      const chosen = this.chosen(this.shown_from + i);
      if (chosen) w.write(at(l.left + chosen.start, y) + palette.selection + chosen.text);
    });
    if (end - t.h > 0) w.write(at(l.right + 1, t.y) + s.faint + "↑");
    if (this.back > 0) w.write(at(l.right + 1, t.y + t.h - 1) + s.faint + "↓");
  }
  /** The selected part of thread row `index`: where it starts, and its text
   * as shown, without the blank past the row's end; null when none is. */
  private chosen(index: number): { start: number; text: string } | null {
    const sel = this.selection;
    if (sel?.on !== "thread" || index >= this.lines.length) return null;
    const [a, b] = ordered(sel.from, sel.to);
    if (index < a.row || index > b.row) return null;
    const cs = cells(this.lines[index], sel.room);
    // A press that hasn't left its cell selects nothing, unless it picked a one-letter word.
    if (a.row === b.row && a.col === b.col && (sel.unit === "cell" || blank.has(cs[a.col]))) return null;
    let start = index === a.row ? a.col : 0;
    const end = Math.min(index === b.row ? b.col + 1 : cs.length, textEnd(cs));
    // A wide character is selected whole.
    while (start > 0 && cs[start] === "") start--;
    return start < end ? { start, text: cs.slice(start, end).join("") } : null;
  }
  /** The selected thread text: rows wrapped from one line join as they were. */
  private selectedText(): string {
    const sel = this.selection;
    if (sel?.on !== "thread") return "";
    const [a, b] = ordered(sel.from, sel.to);
    let out = "";
    for (let index = a.row; index <= b.row && index < this.lines.length; index++) {
      const row = this.lines[index],
        cont = index > a.row ? row.cont : undefined;
      const piece = this.chosen(index)?.text ?? "";
      // A wrapped row's indent isn't part of the line it goes on with.
      out += (index > a.row ? (cont ? cont.join : "\n") : "") + (cont ? piece.slice(cont.skip) : piece);
    }
    return out;
  }
  /** The chips as they sit at the start of the input row, in at most half of `room`. */
  private inline(room: number): Inline {
    return lay(
      this.chips.map(chip => chip.mention),
      Math.floor(room / 2),
      this.context,
    );
  }
  /** Chips leading a row, in the input or a sent message: how many more,
   * then each, an agent's with its brand mark and the others quiet. */
  private drawChips(w: Writer, x: number, y: number, chips: Inline, marks: Marks | null): void {
    if (chips.more) w.write(at(x, y) + s.faint + `+${chips.more}`);
    for (const piece of chips.pieces) {
      const m = piece.mention,
        provider = m.kind === "agent" ? m.provider : null,
        at_x = x + piece.x;
      w.write(at(at_x, y) + s.chip + " ");
      if (provider) {
        writeMark(w, provider, at_x + 1, y, marks);
        w.write(at(at_x + 3, y) + s.chip + " ");
      }
      w.write((m.kind === "agent" ? s.chip : s.chip_quiet) + piece.text + " ");
      this.chip_spots.push({ x: at_x, y, w: (provider ? 5 : 2) + displayWidth(piece.text), mention: m });
    }
  }
  /** The pasted image under the pointer, framed just over its chip, or under
   * it when there's no room: its picture where the host shows them, shrunk
   * to the roomier side when it fits neither, and its name. */
  private drawPreview(w: Writer, cols: number, rows: number, preview: Preview): Rect | null {
    const m = this.hovered,
      spot = this.chip_spots.find(c => c.mention === m);
    if (!spot || m?.kind !== "image") return null;
    const above = spot.y,
      below = rows - spot.y - 1,
      full = preview.thumbnail,
      fits = (t: Thumbnail, room: number) => thumbnailCells(t).rows + 3 <= room && thumbnailCells(t).cols <= cols - 4,
      t =
        full && (fits(full, above) || fits(full, below))
          ? full
          : full && shrink(full, cols - 4, Math.max(above, below) - 3),
      pic = t ? thumbnailCells(t) : { cols: 0, rows: 0 },
      caption = preview.pictures ? (full ? m.name : `${m.name} · loading…`) : `${m.name} · ${m.path}`,
      inner = Math.min(cols - 4, Math.max(pic.cols, displayWidth(caption))),
      bw = inner + 4,
      bh = pic.rows + 3,
      x = clamp(spot.x - 1, 0, Math.max(0, cols - bw)),
      y = bh <= above ? spot.y - bh : bh <= below ? spot.y + 1 : above >= below ? 0 : Math.max(0, rows - bh);
    for (let row = 0; row < bh; row++) {
      w.write(at(x, y + row) + s.border);
      if (row === 0) w.write("╭" + "─".repeat(bw - 2) + "╮");
      else if (row === bh - 1) w.write("╰" + "─".repeat(bw - 2) + "╯");
      else {
        w.write("│" + s.text);
        w.splat(" ", bw - 2);
        w.write(s.border + "│");
      }
    }
    w.write(at(x + 2, y + bh - 2) + s.muted + ellipsis(caption, inner));
    if (t) w.write(linkThumbnail.placeAt(x + 2, y + 1, t, Math.floor((inner * t.cell.width - t.width) / 2)));
    return new Rect(x, y, bw, bh);
  }
  private drawInput(w: Writer, l: Layout, now: number, marks: Marks | null): void {
    const c = this.conversation,
      state = c.state,
      y = l.input_y,
      x = l.left + text_x + l.chips.width,
      room = l.right - x,
      lines = this.area.lines(),
      position = this.area.position();
    this.input_first = clamp(this.input_first, position.row - l.input_rows + 1, position.row);
    this.input_first = clamp(this.input_first, 0, Math.max(0, lines.length - l.input_rows));
    // The caret and the chips lead the first line, and scroll away with it.
    const first = this.input_first === 0;
    if (first) this.drawChips(w, l.left + text_x, y, l.chips, marks);
    if (!this.area.text && (state === "working" || state === "starting")) {
      const spinner = frames.thinking[Math.floor(now / 80) % frames.thinking.length],
        seconds = Math.max(0, Math.floor((now - c.working_since) / 1000)),
        tool = c.tool(),
        search = c.search(),
        segs: Seg[] = [
          {
            text: `${c.stopping ? "stopping" : state === "starting" ? "starting" : "working"} ${seconds}s`,
            style: s.muted,
          },
        ];
      if (search)
        segs.push(
          {
            text:
              " · " +
              (search.phase === "checking" ? "checking" : search.phase === "indexing" ? "updating index" : "searching"),
            style: s.key,
          },
          { text: " " + search.expression + (search.found ? ` · ${search.found} found` : ""), style: s.faint },
        );
      else if (tool && !tool.search)
        segs.push(
          { text: " · ", style: s.faint },
          { text: tool.name, style: s.key },
          { text: tool.summary ? " " + tool.summary : "", style: s.faint },
        );
      writeSegs(w, l.left + caret_x, y, [{ text: spinner, style: s.spin }]);
      writeSegs(w, x, y, clip(segs, room));
      return;
    }
    if (first) w.write(at(l.left + caret_x, y) + s.accent + "›");
    // A list with the keyboard shows the only caret.
    const caret = !this.ui && !this.review_focused;
    if (!this.area.text) {
      const hint = this.reading.length
        ? `Reading ${this.reading.join(", ")}…`
        : state === "blocked"
          ? "Reply, or answer the request above"
          : c.items.length
            ? this.uiEntries().length && !this.ui
              ? "Reply · ↑↓ history · ⇧Tab browse"
              : "Reply"
            : placeholder;
      w.write(at(x, y) + (caret ? s.spin + "█" : " ") + s.faint + ellipsis(hint, room - 1));
      return;
    }
    const sel = this.area.selection();
    for (let row = 0; row < l.input_rows; row++) {
      const index = this.input_first + row,
        line = lines[index],
        line_x = l.left + text_x + this.area.leadOf(index),
        line_room = l.right - line_x;
      if (!line) break;
      w.write(at(line_x, y + row));
      let used = 0;
      for (let i = line.start; i < line.end;) {
        const ch = String.fromCodePoint(this.area.text.codePointAt(i)!),
          chosen = sel !== null && i >= sel[0] && i < sel[1];
        w.write((caret && i === this.area.caret ? s.caret : chosen ? palette.selection : s.strong) + ch);
        used += displayWidth(ch);
        i += ch.length;
      }
      if (caret && this.area.caret === line.end && position.row === index && used < line_room) {
        w.write(s.spin + "█");
        used++;
      }
      if (row === 0 && this.burn_until && used + 3 < line_room)
        w.write(s.faint + ellipsis("  ⏎ again burns the chat, its transcript and memory lines", line_room - used));
    }
  }
  private drawFooter(w: Writer, l: Layout, marks: Marks | null): void {
    const y = l.footer_y,
      choice = this.current(),
      name = choice ? clean(this.currentLabel()) : this.loading ? "Loading models…" : "Pick a model";
    let x = l.left;
    if (choice) {
      writeMark(w, choice.provider, x, y, marks);
      x += 3;
    }
    const chip_end = writeSegs(w, x, y, [
      { text: ellipsis(name, Math.max(4, l.right - x - 2)), style: choice || !this.loading ? s.strong : s.muted },
      { text: " ▾", style: s.muted },
    ]);
    this.targets.push({ x: l.left, y, w: chip_end - l.left, act: { kind: "model" } });
    const brief = choice
      ? clean(this.briefs.find(b => b.provider === choice.provider && b.account === choice.account)?.text ?? "")
      : "";
    const quiet = [this.incognito ? "incognito" : "", brief].filter(Boolean).join(" · ");
    const right = hints(this.hints(), Math.max(0, l.right - chip_end - 2 - Math.min(displayWidth(quiet), 18)));
    const room = l.right - chip_end - 2 - (right.length ? width(right) + 2 : 0);
    if (quiet && room >= 4) w.write(at(chip_end + 2, y) + s.faint + ellipsis(quiet, room));
    if (right.length) writeSegs(w, l.right - width(right), y, right);
  }
  private hints(): [string, string][] {
    // The picker and the memory show their own.
    if (this.picker || this.memory_view) return [];
    if (this.review_focused) return [["esc", "back to input"]];
    if (this.burn_until)
      return [
        ["⏎", "burn it"],
        ["esc", "cancel"],
      ];
    const list = this.listing;
    if (list)
      return [
        ["↑↓", "pick"],
        ["⏎", "open"],
        ...(list.long() && !list.view.searching ? [["type", "to search"] as [string, string]] : []),
        ["esc", list.view.searching ? "clear" : "back"],
      ];
    if (this.ui)
      return [
        ["↑↓", "pick"],
        ["⏎", "open"],
        ["esc", "back"],
      ];
    const popup = this.popup();
    if (popup)
      return [
        ["↑↓", "pick"],
        ["⏎", popup.kind === "slash" ? "run" : "add"],
        ["esc", "back"],
      ];
    const state = this.conversation.state,
      // A pane closes with Ctrl+D; Esc only backs out of menus there.
      leave: [string, string] = this.mode === "pane" ? ["ctrl+d", "close"] : ["esc", "hide"];
    // A message typed while a turn runs goes to it; a lone y or n answers its request.
    const typed = this.area.text.trim();
    if (busy.has(state) && typed && !typed.startsWith("/"))
      return [
        ["⏎", state === "blocked" && /^[yn]$/i.test(typed) ? "answer" : "steer"],
        ["ctrl+c", "stop"],
      ];
    if (state === "working" || state === "starting") return [["ctrl+c", "stop"], leave];
    if (!this.conversation.items.length)
      return this.mode === "pane"
        ? [["⏎", "ask"], ["⇥", "model"], leave]
        : [
            ["⏎", "ask"],
            ["⇥", "model"],
            ["ctrl+o", "open as pane"],
            ["esc", "close"],
          ];
    const browse: [string, string][] = this.uiEntries().length ? [["⇧Tab", "browse"]] : [];
    return this.mode === "pane" ? [...browse, ["⇥", "model"], leave] : [...browse, ["ctrl+o", "open as pane"], leave];
  }
  /** The first row a menu of `capacity` rows shows, moved only to keep the highlight in view. */
  private menuFirst(count: number, capacity: number): number {
    this.menu_first = clamp(this.menu_first, this.menu_at - capacity + 1, this.menu_at);
    this.menu_first = clamp(this.menu_first, 0, Math.max(0, count - capacity));
    return this.menu_first;
  }
  private drawMenu(w: Writer, b: Rect, marks: Marks | null): void {
    const popup = this.popup();
    if (!popup) return;
    const capacity = Math.max(0, b.h - 2),
      first = this.menuFirst(popup.items.length, capacity),
      hovered = (i: number) => first + i === this.menu_at;
    if (popup.kind === "slash") {
      const shown = popup.items.slice(first, first + capacity);
      dropdown.draw(
        w,
        b,
        shown.map((name, i) => ({
          text: "/" + name,
          note: commands.find(c => c.name === name)!.about,
          current: false,
          hovered: hovered(i),
        })),
        undefined,
        13,
      );
      return;
    }
    const shown = popup.items.slice(first, first + capacity),
      names = shown.map(m => mentionName(m, this.context));
    dropdown.draw(
      w,
      b,
      shown.map((m, i) => ({ text: names[i], note: mentionNote(m), current: false, hovered: hovered(i) })),
      undefined,
      Math.min(22, Math.max(...names.map(displayWidth))),
    );
    shown.forEach((m, i) => {
      if (m.kind !== "agent" || !m.provider) return;
      w.write(palette.bg(hovered(i) ? "selected" : "surface"));
      writeMark(w, m.provider, b.x + 2, b.y + 1 + i, marks);
    });
    w.write("\x1b[0m");
  }
}
