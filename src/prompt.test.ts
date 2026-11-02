import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Prompt,
  chatArgs,
  contextText,
  matching,
  parseChatArgs,
  parseCommand,
  readHandoff,
  writeHandoff,
  type Context,
} from "./prompt";
import * as palette from "./palette";
import { fast_ms } from "./prompt_session";
import type { Choice, Entry } from "./model_picker";
import type { Daemon } from "./prompt_session";
import { Writer } from "./text";

/** The screen's text after replaying the cursor moves in `ansi`. */
function screen(ansi: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (const m of ansi.matchAll(/\x1b\[([\d;?]*)([A-Za-z])|\x1b\][^\x1b]*\x1b\\|([\s\S])/gu)) {
    if (m[2] === "H") {
      const [r, c] = (m[1] || "1;1").split(";").map(Number);
      y = r - 1;
      x = c - 1;
    } else if (m[3] !== undefined) {
      if (y < rows && x < cols) grid[y][x] = m[3];
      x++;
    }
  }
  return grid.map(row => row.join("").trimEnd());
}
class Fake implements Daemon {
  calls: { op: string; payload: any }[] = [];
  starts: any[] = [];
  journal: { seq: number; event: unknown }[] = [];
  pending: unknown[] = [];
  async call(op: string, payload: any) {
    this.calls.push({ op, payload });
    if (op !== "headless.events") return { ok: true };
    return {
      ok: true,
      events: this.journal.filter(e => BigInt(e.seq) > BigInt(payload.after)),
      pending_requests: this.pending,
    };
  }
  /** Sessions the next starts make, then 0193-session. */
  ids: string[] = [];
  async start(payload: any) {
    this.starts.push(payload);
    return { provider: payload.provider, session: this.ids.shift() ?? "0193-session" };
  }
  add(...events: unknown[]) {
    for (const event of events) this.journal.push({ seq: this.journal.length + 1, event });
  }
  sent() {
    return this.calls.filter(c => c.op === "headless.send").map(c => c.payload.input);
  }
}
const opus: Choice = { provider: "claude", account: "", model: "claude-opus-5-5", name: "Opus 5.5", effort: "high" };
const entries: Entry[] = [
  {
    provider: "claude",
    account: "",
    account_name: "",
    model: "claude-opus-5-5",
    name: "Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh"],
    default_effort: "high",
  },
  {
    provider: "codex",
    account: "",
    account_name: "",
    model: "gpt-6-astra",
    name: "GPT-6 Astra",
    efforts: ["low", "medium", "high"],
    default_effort: "medium",
  },
];
const context: Context = {
  cwd: "/work/corgi",
  workspace: "corgi",
  workspace_id: 3,
  branch: "main",
  focus: { title: "Fix sidebar flicker", provider: "claude", activity: "Running sidebar tests", pane: 7 },
  herd: [
    { name: "Fix sidebar flicker", state: "working", activity: "Running sidebar tests" },
    { name: "Release notes", state: "blocked", activity: "Needs input" },
  ],
  mentions: [
    { kind: "agent", pane: 7, name: "Fix sidebar flicker", provider: "claude", activity: "Running sidebar tests" },
    { kind: "agent", pane: 8, name: "Release notes", provider: "codex", activity: "Needs input" },
    { kind: "diff", cwd: "/work/corgi" },
  ],
};
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-prompt-"));
  folders.push(dir);
  return dir;
}
function prompt(over: { transcript?: (p: any, s: string) => string } = {}) {
  const d = new Fake(),
    clock = { now: Date.UTC(2026, 9, 30, 12) },
    root = folder(),
    p = new Prompt({ daemon: d, memory_root: root, clock: () => clock.now, ...over });
  p.catalog(entries, [opus], [{ provider: "claude", account: "", text: "Max · 5h 12% · 7d 48%" }]);
  p.show(context);
  return { p, d, clock, root };
}
function draw(p: Prompt, cols = 112, rows = 34, now = 0): string[] {
  return screen(drawn(p, cols, rows, now), cols, rows);
}
/** The frame `p` writes, escapes and all. */
function drawn(p: Prompt, cols = 112, rows = 34, now = 0): string {
  const w = new Writer();
  p.draw(w, cols, rows, null, now);
  return w.s;
}
function type(p: Prompt, text: string) {
  for (const byte of Buffer.from(text)) p.key(byte);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function poll(p: Prompt, now: number) {
  p.poll(now);
  await settle();
  await settle();
}
/** The drawn card's rows, without the screen around them. */
function card(lines: string[]): string[] {
  const top = lines.findIndex(l => l.includes("╭")),
    x = lines[top].indexOf("╭"),
    bottom = lines.findLastIndex(l => l[x] === "╰");
  return lines.slice(top, bottom + 1).map(l => l.slice(x));
}

test("a fresh prompt is one line, the context chips and the model", () => {
  const { p } = prompt();
  // The corgi sleeps on the frame, leaving the input its room.
  expect(card(draw(p))).toEqual([
    "╭───────────────────────────────────────────────────────────────────────── ~ᐯ◡ᴥ◡ᐯ ─╮",
    "│  ›  *  Fix sidebar f…  █Ask Corgi anything, @ to add context                     │",
    "├──────────────────────────────────────────────────────────────────────────────────┤",
    "│  *  Auto · Opus 5.5 · High ▾  Max · 5h 12% · …  ctrl+o open as pane   esc close  │",
    "╰──────────────────────────────────────────────────────────────────────────────────╯",
  ]);
});

test("before the catalogs arrive, the prompt says its models are loading rather than asking for a pick", () => {
  const { p } = prompt();
  p.catalog([], [], [], null, true);
  expect(card(draw(p)).at(-2)).toContain("Loading models…");
  type(p, "hi");
  expect(p.key(13)).toBeNull();
  expect(p.conversation.items.at(-1)).toMatchObject({ text: "The models are still loading; send again in a moment." });
  p.catalog(entries, [opus], [], opus);
  expect(card(draw(p)).at(-2)).toContain("Auto · Opus 5.5 · High ▾");
});

test("the card is centered, at most 84 wide, and narrower terminals take cols - 8", () => {
  const { p } = prompt();
  const wide = draw(p, 200, 50),
    top = wide.findIndex(l => l.includes("╭"));
  expect(wide[top].indexOf("╭")).toBe(58);
  expect(wide[top].trimEnd().length - 58).toBe(84);
  const narrow = draw(p, 70, 30);
  expect(narrow.find(l => l.includes("╭"))!.indexOf("╭")).toBe(4);
  // Too small for the card: one line says so, and Esc still closes it.
  const small = draw(p, 30, 8);
  expect(small.slice(0, 7).every(l => !l.trim())).toBe(true);
  expect(small[7]).toBe(" Corgi prompt: enlarge termin…");
  expect(draw(p, 60, 8)[7]).toBe(" Corgi prompt: enlarge terminal or Esc");
  expect(p.key(27)).toEqual({ kind: "close" });
});

test("the first message starts a session with memory and context", async () => {
  const { p, d, root } = prompt();
  writeFileSync(join(root, "MEMORY.md"), "- Runs tests with bun, never npm.\n");
  type(p, "why does CI flake?");
  p.key(13);
  expect(d.starts.length).toBe(1);
  const start = d.starts[0];
  expect(start).toMatchObject({
    provider: "claude",
    cwd: "/work/corgi",
    workspace: 3,
    model: "claude-opus-5-5",
    effort: "high",
    persist: true,
    corgi: true,
  });
  // Where it opened goes with the first message.
  expect(start.prompt).toBe(
    '<context kind="agent" name="Fix sidebar flicker">\n\n</context>\n\n' + "why does CI flake?",
  );
  expect(start.instructions).toContain("Runs tests with bun, never npm.");
  expect(start.instructions).toContain('Opened over the agent "Fix sidebar flicker" (Claude)');
  expect(start.instructions).toContain("- Release notes: blocked · Needs input");
  await settle();
  expect(p.conversation.session).toBe("0193-session");
});

test("the model is told how to drive Corgi, and each message says which viewer is looking", async () => {
  const d = new Fake(),
    p = new Prompt({ daemon: d, memory_root: folder(), viewer: () => 7, binary: "/opt/corgi/bin/corgi" });
  p.catalog(entries, [opus], []);
  p.show({ ...context, mentions: [] });
  type(p, "open my parser chat");
  p.key(13);
  const start = d.starts[0];
  expect(start.instructions).toContain("corgi resume PROVIDER SESSION --viewer V");
  expect(start.instructions).toContain("/opt/corgi/bin/corgi");
  expect(start.prompt).toStartWith('<corgi viewer="7" workspace="corgi"/>\n');
  expect(start.prompt).toEndWith("open my parser chat");
});

test("mid-conversation: the thread, an approval and a remembered line", async () => {
  const { p, d, root } = prompt();
  type(p, "why does the sidebar test flake on CI?");
  p.key(13);
  await settle();
  const ask = { tool: true, name: "Edit", summary: "src/sidebar.test.ts" },
    today = join(root, "2026-10-30.md");
  d.add(
    { kind: "turn", session: "0193-session", turn: "t", phase: "started" },
    {
      kind: "tool",
      session: "0193-session",
      turn: "t",
      id: "1",
      done: true,
      wrote: [],
      name: "Read",
      summary: "src/sidebar.test.ts",
    },
    {
      kind: "tool",
      session: "0193-session",
      turn: "t",
      id: "2",
      done: true,
      wrote: [],
      name: "Bash",
      summary: "bun test src/sidebar.test.ts -t flicker",
    },
    {
      kind: "message",
      session: "0193-session",
      text: "The flicker case seeds the corgi routine with `Date.now()`, so two cases in the same millisecond share a routine and the second reads a cached frame. Seeding from the pane id makes every case deterministic.",
    },
    { kind: "request", session: "0193-session", id: "r1", ask },
  );
  d.pending = [{ id: "r1", session: "0193-session", ask }];
  await poll(p, 0);
  // The model notes something in today's log; its edit shows as the line.
  writeFileSync(today, "- CI runs unit tests in parallel\n");
  d.add({
    kind: "tool",
    session: "0193-session",
    turn: "t",
    id: "3",
    done: true,
    wrote: [today],
    name: "Edit",
    summary: today,
  });
  await poll(p, 200);
  expect(card(draw(p, 112, 34, 0))).toEqual([
    "╭───────────────────────────────────────────────────────────────────────── ^ᐱ•ᴥ•ᐱ ─╮",
    "│  ›  *  Fix sidebar f…  why does the sidebar test flake on CI?                    │",
    "│                                                                                  │",
    "│  ● Read src/sidebar.test.ts                                                      │",
    "│  ● Bash bun test src/sidebar.test.ts -t flicker                                  │",
    "│                                                                                  │",
    "│  The flicker case seeds the corgi routine with Date.now(), so two cases in the   │",
    "│  same millisecond share a routine and the second reads a cached frame. Seeding   │",
    "│  from the pane id makes every case deterministic.                                │",
    "│                                                                                  │",
    "│  ● needs you  Edit src/sidebar.test.ts                       y⏎ allow   n⏎ deny  │",
    "│                                                                                  │",
    "│  ε=з remembered CI runs unit tests in parallel                                   │",
    "│                                                                                  │",
    "├──────────────────────────────────────────────────────────────────────────────────┤",
    "│  › █Reply, or answer the request above                                           │",
    "├──────────────────────────────────────────────────────────────────────────────────┤",
    "│  *  Auto · Opus 5.5 · High ▾  Max · 5h 12% · 7…  ctrl+o open as pane   esc hide  │",
    "╰──────────────────────────────────────────────────────────────────────────────────╯",
  ]);
  expect(p.conversation.wrote).toEqual([{ file: today, line: "- CI runs unit tests in parallel" }]);
  // A lone y, sent, answers the request.
  type(p, "y");
  expect(d.sent()).toEqual([]);
  p.key(13);
  expect(d.sent()).toEqual([{ kind: "answer", request: "r1", allow: true }]);
});

test("a reply that starts with y is a reply, not an answer", async () => {
  const { p, d } = prompt();
  type(p, "push it");
  p.key(13);
  await settle();
  const ask = { tool: true, name: "Bash", summary: "git push --force" };
  d.add({ kind: "request", session: "0193-session", id: "r1", ask });
  d.pending = [{ id: "r1", session: "0193-session", ask }];
  await poll(p, 0);
  type(p, "yes but no force");
  p.key(13);
  expect(d.sent()).toEqual([{ kind: "prompt", text: "yes but no force" }]);
  expect(p.conversation.pending()?.id).toBe("r1");
  type(p, "N");
  p.key(13);
  expect(d.sent().at(-1)).toEqual({ kind: "answer", request: "r1", allow: false });
});

test("clicking deny answers the request", async () => {
  const { p, d } = prompt();
  type(p, "fix it");
  p.key(13);
  await settle();
  const ask = { tool: true, name: "Bash", summary: "rm -rf build" };
  d.add({ kind: "request", session: "0193-session", id: "r1", ask });
  d.pending = [{ id: "r1", session: "0193-session", ask }];
  await poll(p, 0);
  const lines = draw(p),
    y = lines.findIndex(l => l.includes("needs you")),
    x = lines[y].indexOf("n⏎ deny");
  expect(p.click(x + 2, y)).toBeNull();
  expect(d.sent()).toEqual([{ kind: "answer", request: "r1", allow: false }]);
});

test("a long thread wraps, keeps the newest at the bottom and scrolls back", async () => {
  const { p, d } = prompt();
  type(p, "count");
  p.key(13);
  await settle();
  d.add({
    kind: "message",
    session: "0193-session",
    text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
  });
  d.add({ kind: "turn", session: "0193-session", turn: "", phase: "ended", outcome: "completed" });
  await poll(p, 0);
  let lines = card(draw(p, 112, 34));
  expect(lines.length).toBe(Math.floor(34 * 0.8));
  expect(lines.some(l => l.includes("line 40"))).toBe(true);
  expect(lines.some(l => l.includes("line 1 "))).toBe(false);
  expect(lines[1]).toEndWith("↑│");
  p.sequence("\x1b[5~");
  lines = card(draw(p, 112, 34));
  expect(lines.some(l => l.includes("line 40"))).toBe(false);
  expect(lines.some(l => l.includes("↓"))).toBe(true);
  for (let i = 0; i < 20; i++) p.scroll(false);
  lines = card(draw(p, 112, 34));
  expect(lines[1]).toMatch(/› .*Fix sidebar f… +count/);
  p.sequence("\x1b[6~");
  p.sequence("\x1b[6~");
  p.sequence("\x1b[6~");
  expect(card(draw(p, 112, 34)).some(l => l.includes("line 40"))).toBe(true);
});

test("a drag over the thread selects its text, copied on release as it was written", async () => {
  const { p, d } = prompt();
  type(p, "why?");
  p.key(13);
  await settle();
  const sentence =
    "The flicker case seeds the corgi routine with Date.now(), so two cases in the same millisecond share it.";
  d.add({
    kind: "message",
    session: "0193-session",
    text: sentence.replace("Date.now()", "`Date.now()`") + "\n\n- one\n- two",
  });
  d.add({ kind: "turn", session: "0193-session", turn: "", phase: "ended", outcome: "completed" });
  await poll(p, 0);
  const lines = draw(p, 80, 30),
    y = lines.findIndex(l => l.includes("The flicker")),
    x = lines[y].indexOf("The flicker");
  expect(lines[y + 1]).toContain("share it.");
  // A press alone selects nothing.
  p.click(x, y);
  expect(p.release()).toBeNull();
  // From the second word to past the end of the wrapped line, it's the sentence as one line.
  p.click(x + 4, y);
  expect(p.drag(x + 100, y + 1)).toBe(true);
  expect(p.release()).toEqual({ kind: "copy", text: sentence.slice(4) });
  // It shows until a key; on to the list, lines keep their breaks.
  const w = new Writer();
  p.draw(w, 80, 30, null, 0);
  expect(w.s).toContain(palette.selection + "flicker case");
  p.click(x, y);
  p.drag(x + 4, y + 4);
  expect(p.release()).toEqual({ kind: "copy", text: sentence + "\n\n- one\n- two" });
  p.sequence("\x1b[C");
  expect(drawn(p, 80, 30)).not.toContain(palette.selection);
});

test("a drag over the input selects what's typed there, copied on release", () => {
  const { p } = prompt();
  type(p, "hello world");
  const lines = draw(p),
    y = lines.findIndex(l => l.includes("hello world")),
    x = lines[y].indexOf("hello");
  p.click(x, y);
  expect(p.drag(x + 5, y)).toBe(true);
  expect(p.release()).toEqual({ kind: "copy", text: "hello" });
  // Typing replaces it, as in any text box.
  type(p, "bye");
  expect(draw(p)[y]).toContain("bye world");
});

test("/ lists the commands, filters them and runs the highlighted one", () => {
  const { p } = prompt();
  p.key(47);
  let lines = draw(p);
  expect(lines.filter(l => /\/\w+ {2,}\w/.test(l)).map(l => l.trim().split(/\s+/)[1])).toEqual([
    "/forgetmenow",
    "/remember",
    "/forget",
    "/dig",
    "/pane",
    "/incognito",
    "/memory",
    "/new",
  ]);
  expect(card(lines).at(-2)).toContain("↑↓ pick   ⏎ run   esc back");
  type(p, "f");
  expect(matching("f")).toEqual(["forgetmenow", "forget"]);
  expect(matching("me")).toEqual(["memory", "forgetmenow", "remember"]);
  p.sequence("\x1b[B");
  p.key(13);
  // A command that takes words fills the input instead of running.
  expect(card(draw(p)).find(l => l.includes("›"))).toContain("Fix sidebar f…  /forget █");
  for (let i = 0; i < 20; i++) p.key(127);
  type(p, "/rem");
  p.key(13);
  // The twenty Backspaces took the chips too, once the box was empty.
  expect(card(draw(p)).find(l => l.includes("›"))).toContain("› /remember █");
  for (let i = 0; i < 20; i++) p.key(127);
  type(p, "/d");
  p.key(27);
  expect(card(draw(p)).some(l => l.includes("search memory"))).toBe(false);
  expect(parseCommand("dig")).toBe("dig");
  expect(parseCommand("fetch")).toBeNull();
});

test("/remember, /dig and /forget work on memory", () => {
  const { p, root } = prompt();
  // As OpenClaw keeps it, what's remembered goes to today's log.
  type(p, "/remember CI runs unit tests in parallel");
  p.key(13);
  expect(readFileSync(join(root, "2026-10-30.md"), "utf8")).toBe("- CI runs unit tests in parallel\n");
  expect(p.conversation.items.at(-1)).toEqual({
    kind: "note",
    text: "remembered CI runs unit tests in parallel → 2026-10-30.md",
    tone: "faint",
    bone: true,
  });
  writeFileSync(join(root, "MEMORY.md"), "- CI caches bun\n");
  type(p, "/dig CI");
  p.key(13);
  expect(p.conversation.items.slice(-2).map(i => (i as any).text)).toEqual([
    "CI caches bun · MEMORY",
    "CI runs unit tests in parallel · 2026-10-30",
  ]);
  type(p, "/forget CI");
  p.key(13);
  expect(p.conversation.items.at(-1)).toEqual({
    kind: "note",
    text: "2 lines match. /forget with the whole line drops one.",
    tone: "warm",
  });
  type(p, "/forget ci caches bun");
  p.key(13);
  expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("");
  expect((p.conversation.items.at(-1) as any).text).toBe("forgot CI caches bun ← MEMORY.md");
});

test("/forgetmenow waits for a second Enter, then burns what it can", async () => {
  const transcripts = folder(),
    file = join(transcripts, "0193-session.jsonl");
  writeFileSync(file, "{}\n");
  const { p, d, clock, root } = prompt({ transcript: () => file });
  type(p, "/remember keep this");
  p.key(13);
  type(p, "hello");
  p.key(13);
  await settle();
  type(p, "/forgetmenow");
  p.key(13);
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(false);
  expect(card(draw(p)).find(l => l.includes("› /"))).toContain("/forgetmenow█  ⏎ again burns the chat");
  clock.now += 2500;
  p.key(13);
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(false);
  p.key(13);
  await settle();
  expect(d.calls.filter(c => c.op === "headless.stop").map(c => c.payload)).toEqual([
    { provider: "claude", session: "0193-session" },
  ]);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(join(root, "2026-10-30.md"), "utf8")).toBe("");
  expect(p.conversation.items).toEqual([
    {
      kind: "note",
      text: "burned the chat, 1 memory line and Claude's transcript",
      tone: "faint",
      bone: true,
    },
  ]);
});

test("/forgetmenow burns every session the thread used, and keeps lines changed since", async () => {
  const transcripts = folder(),
    files: Record<string, string> = {
      first: join(transcripts, "first.jsonl"),
      second: join(transcripts, "second.jsonl"),
    };
  for (const file of Object.values(files)) writeFileSync(file, "{}\n");
  const { p, d, clock, root } = prompt({ transcript: (_provider, session) => files[session] ?? "" });
  d.ids = ["first", "second"];
  const log = join(root, "2026-10-30.md");
  writeFileSync(log, "- the user's own line\n");
  type(p, "/remember keep this");
  p.key(13);
  type(p, "/remember and this");
  p.key(13);
  type(p, "one");
  p.key(13);
  await settle();
  // A new model: the first session stops, and a second one starts.
  p.choice = { provider: "codex", account: "", model: "gpt-6-astra", name: "GPT-6 Astra", effort: "high" };
  type(p, "two");
  p.key(13);
  await settle();
  // The user edits one of the remembered lines by hand.
  writeFileSync(log, "- the user's own line\n- keep this, edited\n- and this\n");
  type(p, "/forgetmenow");
  p.key(13);
  clock.now += 100;
  p.key(13);
  await settle();
  await settle();
  expect(existsSync(files.first)).toBe(false);
  expect(existsSync(files.second)).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("- the user's own line\n- keep this, edited\n");
  expect(p.conversation.items.map(i => (i as any).text)).toEqual([
    "burned the chat, 1 memory line and 2 transcripts",
    "A memory line changed since it was written, so it stays: keep this",
  ]);
});

test("/forgetmenow during a start burns the session once it arrives", async () => {
  const transcripts = folder(),
    file = join(transcripts, "late.jsonl");
  writeFileSync(file, "{}\n");
  const { p, d, clock } = prompt({ transcript: (_provider, session) => (session === "late" ? file : "") });
  let resolve!: (v: { provider: any; session: string }) => void;
  d.start = async (payload: any) => {
    d.starts.push(payload);
    return new Promise(r => (resolve = r));
  };
  type(p, "hello");
  p.key(13);
  type(p, "/forgetmenow");
  p.key(13);
  clock.now += 100;
  p.key(13);
  await settle();
  resolve({ provider: "claude", session: "late" });
  await settle();
  await settle();
  await settle();
  expect(d.calls.filter(c => c.op === "headless.stop").map(c => c.payload.session)).toContain("late");
  expect(existsSync(file)).toBe(false);
  expect(p.conversation.items.map(i => (i as any).text)).toEqual(["burned the chat and Claude's transcript"]);
});

test("/forgetmenow says plainly what stays when Corgi can't find the transcript", async () => {
  const { p, clock } = prompt();
  type(p, "hello");
  p.key(13);
  await settle();
  type(p, "/forgetmenow");
  p.key(13);
  clock.now += 500;
  p.key(13);
  await settle();
  expect(p.conversation.items.map(i => (i as any).text)).toEqual([
    "burned the chat",
    "Claude keeps its transcript of session 0193-session: Corgi doesn't know where it is.",
  ]);
});

test("/incognito starts over keeping nothing, until /new", async () => {
  const { p, d } = prompt();
  type(p, "/incognito");
  p.key(13);
  expect(p.incognito).toBe(true);
  expect(card(draw(p)).at(-2)).toContain("incognito · Max");
  type(p, "/remember secret");
  p.key(13);
  expect((p.conversation.items.at(-1) as any).text).toBe("Incognito keeps nothing, so /remember is off until /new.");
  type(p, "psst");
  p.key(13);
  expect(d.starts[0].persist).toBe(false);
  expect(d.starts[0].instructions).toContain("incognito");
  await settle();
  // An incognito chat moves to a pane too, still incognito: it goes on with the same session.
  type(p, "/pane");
  const moved = p.key(13) as any;
  expect(moved.argv).toContain("--incognito");
  expect(readHandoff(parseChatArgs(moved.argv.slice(moved.argv.indexOf("__chat") + 1)).handoff)!.incognito).toBe(true);
  expect(p.incognito).toBe(false);
  p.show(context);
  type(p, "/incognito");
  p.key(13);
  type(p, "/new");
  p.key(13);
  expect(p.incognito).toBe(false);
  expect(p.conversation.items).toEqual([]);
  // The session went on in the pane, so /new had none of its own to stop.
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(false);
});

test("/pane hands the conversation to a Corgi pane, which reads it once; /memory browses the memory", async () => {
  const { p, d, root } = prompt();
  type(p, "/pane");
  // With nothing asked yet, the pane starts the conversation, following Auto.
  const empty = p.key(13) as any;
  expect(empty.kind).toBe("pane");
  const fresh = parseChatArgs(empty.argv.slice(empty.argv.indexOf("__chat") + 1)),
    blank = readHandoff(fresh.handoff)!;
  expect(fresh).toMatchObject({ provider: "claude", session: "", model: "claude-opus-5-5", cwd: "/work/corgi" });
  expect(blank.conversation).toBeNull();
  expect(blank.choice).toBeNull();
  expect(p.conversation.items).toEqual([]);
  p.show(context);
  type(p, "hello");
  p.key(13);
  await settle();
  d.add({ kind: "message", session: "0193-session", text: "hi there" });
  await poll(p, 0);
  // ctrl+o is /pane.
  const effect = p.key(15) as any;
  expect(effect.kind).toBe("pane");
  expect(p.open).toBe(false);
  const at = effect.argv.indexOf("__chat"),
    args = parseChatArgs(effect.argv.slice(at + 1));
  expect(args).toMatchObject({
    provider: "claude",
    session: "0193-session",
    model: "claude-opus-5-5",
    effort: "high",
    incognito: false,
    cwd: "/work/corgi",
    workspace: 3,
  });
  expect(effect.cwd).toBe("/work/corgi");
  // The handoff is this user's alone, and gone once read.
  expect(statSync(args.handoff).mode & 0o777).toBe(0o600);
  const file = readHandoff(args.handoff)!;
  expect(existsSync(args.handoff)).toBe(false);
  expect(readHandoff(args.handoff)).toBeNull();
  expect(file.conversation).toMatchObject({ provider: "claude", session: "0193-session", after: "1" });
  expect(file.conversation!.items.map(i => i.kind)).toEqual(["user", "text"]);
  expect(file.choice).toEqual(opus);
  // The card let the session go without stopping it, and starts over.
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(false);
  expect(p.conversation.session).toBe("");
  expect(p.conversation.items.map(i => (i as any).text)).toEqual(["Continued in a Corgi pane."]);
  // /memory browses the memory in the card, at its tallest; Ctrl+E opens a file in the editor.
  p.show(context);
  const before = box(draw(p));
  type(p, "/memory");
  expect(p.key(13)).toBeNull();
  const lines = draw(p),
    browsing = box(lines);
  // It grows down, moving up only as far as the screen makes it.
  expect(browsing.top).toBeLessThanOrEqual(before.top);
  expect(browsing.bottom - browsing.top).toBeGreaterThan(before.bottom - before.top);
  expect(lines.some(l => l.includes("Search memory"))).toBe(true);
  expect(lines.some(l => /MEMORY\.md +loaded · 0/.test(l))).toBe(true);
  expect(p.key(5)).toEqual({
    kind: "pane",
    argv: ["sh", "-c", 'exec ${EDITOR:-vi} "$1"', "sh", join(root, "MEMORY.md")],
    cwd: root,
  });
  // Esc goes back to the conversation.
  p.show(context);
  type(p, "/memory");
  p.key(13);
  p.key(27);
  expect(draw(p).some(l => l.includes("Search memory"))).toBe(false);
  expect(p.open).toBe(true);
});

test("corgi __chat takes the handoff and what the session runs with", () => {
  const args = {
    handoff: "/tmp/corgi-chat-1.json",
    provider: "codex" as const,
    session: "t-1",
    account: "/accounts/work",
    model: "gpt-6-astra",
    effort: "medium" as const,
    incognito: true,
    cwd: "/work/corgi",
    workspace: 2,
  };
  expect(parseChatArgs(chatArgs(args))).toEqual(args);
  expect(parseChatArgs(["/tmp/h.json", "--provider", "claude", "--session", "s"])).toMatchObject({
    account: "",
    model: "",
    effort: null,
    incognito: false,
    workspace: null,
  });
  for (const bad of [
    ["/tmp/h.json"],
    ["/tmp/h.json", "--provider", "nope", "--session", "s"],
    ["/tmp/h.json", "--provider", "claude", "--session"],
    ["/tmp/h.json", "--provider", "claude", "--session", "s", "--effort", "huge"],
    ["/tmp/h.json", "/tmp/other.json", "--provider", "claude", "--session", "s"],
  ])
    expect(() => parseChatArgs(bad)).toThrow("Usage");
});

/** A Corgi pane's prompt, as `corgi __chat` makes it, going on with a handed-over chat. */
function pane(d = new Fake()) {
  const p = new Prompt({
    daemon: d,
    memory_root: folder(),
    clock: () => Date.UTC(2026, 9, 30, 12),
    mode: "pane",
    pane: 9,
  });
  p.adopt({
    conversation: {
      provider: "claude",
      session: "0193-session",
      start: {
        provider: "claude",
        account: "",
        model: "claude-opus-5-5",
        effort: "high",
        cwd: "/work/corgi",
        workspace: 3,
        instructions: "",
        persist: true,
      },
      after: "4",
      running: false,
      items: [
        { kind: "user", text: "say hi in 3 words" },
        { kind: "text", text: "Hi there, friend!", partial: false },
      ],
      wrote: [],
      used: [],
      memory_writes: true,
    },
    incognito: false,
    choice: opus,
    catalog: { entries, suggested: [opus], briefs: [{ provider: "claude", account: "", text: "Max · 5h 12%" }] },
    context,
  });
  p.show(context);
  return { p, d };
}

test("in a pane the card fills it: thread, input, footer, and menus over the thread", () => {
  for (const [cols, rows] of [
    [100, 30],
    [60, 16],
  ]) {
    const { p } = pane(),
      lines = draw(p, cols, rows);
    expect(box(lines)).toEqual({ top: 0, left: 0, width: cols, bottom: rows - 1 });
    expect(lines[1]).toContain("› say hi in 3 words");
    expect(lines.some(l => l.includes("Hi there, friend!"))).toBe(true);
    // No default chip: the pane opened over nothing.
    expect(lines[rows - 4]).toMatch(/›\s+█Reply/);
    expect(lines[rows - 2]).toContain("Opus 5.5 · High ▾");
    expect(lines[rows - 2]).toContain("ctrl+d close");
    expect(p.title()).toBe("Corgi · Opus 5.5 · High");
    for (const key of [47, 127, 64, 127, 9]) {
      p.key(key);
      expect(box(draw(p, cols, rows))).toEqual({ top: 0, left: 0, width: cols, bottom: rows - 1 });
    }
    p.key(27);
  }
});

test("in a pane Esc backs out of menus only, Ctrl+D or /close ends it, and its reads claim the session", async () => {
  const { p, d } = pane();
  p.key(47);
  expect(p.key(27)).toBeNull();
  expect(p.key(27)).toBeNull();
  expect(p.open).toBe(true);
  expect(matching("", "pane")).toContain("close");
  expect(matching("", "pane")).not.toContain("pane");
  expect(matching("", "overlay")).not.toContain("close");
  // Ctrl+O and a click outside do nothing here.
  expect(p.key(15)).toBeNull();
  for (let i = 0; i < 3; i++) p.key(127);
  expect(p.key(4)).toEqual({ kind: "close" });
  type(p, "x");
  expect(p.key(4)).toBeNull();
  p.key(127);
  type(p, "/close");
  expect(p.key(13)).toEqual({ kind: "close" });
  // Reading on from where the card left off, as the pane.
  await poll(p, 0);
  expect(d.calls.at(-1)).toEqual({
    op: "headless.events",
    payload: { provider: "claude", session: "0193-session", after: 4n, pane: 9 },
  });
  type(p, "and again?");
  p.key(13);
  expect(d.sent()).toEqual([{ kind: "prompt", text: "and again?" }]);
  expect(d.starts).toEqual([]);
});

test("Tab or a click on the chip opens the picker; a pick changes the chip", () => {
  const { p } = prompt();
  p.key(9);
  let lines = draw(p);
  expect(lines.some(l => l.includes("GPT-6 Astra") || l.includes("Opus 5.5"))).toBe(true);
  expect(p.key(27)).toBeNull();
  lines = draw(p);
  const y = lines.findIndex(l => l.includes("Opus 5.5 · High ▾"));
  p.click(lines[y].indexOf("Opus"), y);
  // Down from Auto to Opus, → to its efforts, up from High to Medium.
  p.sequence("\x1b[B");
  p.sequence("\x1b[C");
  p.sequence("\x1b[A");
  const effect = p.key(13);
  expect(effect?.kind).toBe("pick");
  expect(p.current()).toEqual({ ...opus, effort: "medium" });
  expect(draw(p).some(l => l.includes("Opus 5.5 · Medium ▾"))).toBe(true);
});

test("a new model mid-conversation starts a new session", async () => {
  const { p, d } = prompt();
  type(p, "one");
  p.key(13);
  await settle();
  p.choice = { provider: "codex", account: "", model: "gpt-6-astra", name: "GPT-6 Astra", effort: "high" };
  type(p, "two");
  p.key(13);
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(true);
  expect(d.starts.map(s => s.provider)).toEqual(["claude", "codex"]);
});

test("following Auto, the conversation keeps the model it started on, whatever the suggestions do next", async () => {
  const { p } = prompt();
  expect(p.choice).toBeNull();
  type(p, "hi");
  expect(p.key(13)).toBeNull();
  await settle();
  const astra: Choice = { provider: "codex", account: "", model: "gpt-6-astra", name: "GPT-6 Astra", effort: "medium" };
  p.catalog(entries, [astra, opus], []);
  expect(p.current()).toEqual(opus);
  type(p, "again");
  expect(p.key(13)).toBeNull();
  expect(p.conversation.used.length).toBe(1);
});

test("a reloaded viewer goes on with its session, model, account and incognito", async () => {
  const { p, d } = prompt();
  d.add(
    { kind: "message", session: "kept", text: "an earlier answer" },
    { kind: "turn", session: "kept", turn: "", phase: "ended", outcome: "completed" },
  );
  p.hide();
  p.attach({
    provider: "codex",
    session: "kept",
    cwd: "/work/corgi",
    workspace: 3,
    state: "idle",
    account: "/accounts/work",
    model: "gpt-6-astra",
    effort: "medium",
    persist: false,
  });
  expect(p.incognito).toBe(true);
  expect(p.conversation.memory_writes).toBe(false);
  expect(p.current()).toEqual({
    provider: "codex",
    account: "/accounts/work",
    model: "gpt-6-astra",
    name: "GPT-6 Astra",
    effort: "medium",
  });
  await poll(p, 0);
  // What it reads back was seen before the reload.
  expect(p.attention()).toBe("none");
  p.show(context);
  expect(card(draw(p)).some(l => l.includes("an earlier answer"))).toBe(true);
  type(p, "and now?");
  p.key(13);
  expect(d.sent().map(i => i.text.split("\n").at(-1))).toEqual(["and now?"]);
  expect(d.starts).toEqual([]);
});

test("text from the model and the panes can't reach the terminal raw", async () => {
  const { p, d } = prompt();
  p.show({
    ...context,
    focus: { title: "evil\x1b]52;c;ZXZpbA==\x07title", provider: "claude", activity: "", pane: 9 },
  });
  type(p, "hi");
  p.key(13);
  await settle();
  d.add({ kind: "message", session: "0193-session", text: "copy\x1b]52;c;ZXZpbA==\x07 this\tnow \x1b[2J" });
  await poll(p, 0);
  const w = new Writer();
  p.draw(w, 112, 34, null, 0);
  expect(w.s).not.toContain("\x1b]52");
  expect(w.s).not.toContain("\x1b[2J");
  expect(w.s).not.toContain("\t");
  expect(card(screen(w.s, 112, 34)).find(l => l.includes("copy"))).toContain("copy this   now");
});

test("typing: UTF-8 bytes, Alt+Enter breaks the line, pastes keep their lines", () => {
  const { p } = prompt();
  type(p, "café");
  p.sequence("\x1b\r");
  p.paste("a\r\nb\tc");
  const lines = card(draw(p));
  // The first line starts after the chips; the lines after it wrap back
  // under them, to the caret's gutter.
  const at = lines.findIndex(l => l.includes("café"));
  expect(lines[at]).toMatch(/^│  › .*Fix sidebar.* café/);
  expect(lines.slice(at + 1, at + 3).map(l => l.slice(5, -1).replace(/ +\/? *$/, ""))).toEqual(["a", "b    c█"]);
});

test("a pasted image is a chip that goes as an image, even with nothing typed", async () => {
  const { p, d } = prompt();
  p.attachImage("/tmp/a.png", "image/png");
  p.attachImage("/tmp/a.png", "image/png");
  p.attachImage("/tmp/b.png", "image/png");
  expect(p.attached()).toEqual(["Fix sidebar flicker", "Image 1", "Image 2"]);
  expect(card(draw(p)).find(l => l.includes("Image 1"))).toContain("Image 2");
  p.key(13);
  await settle();
  await settle();
  expect(d.starts[0]).toMatchObject({
    images: [
      { path: "/tmp/a.png", mime: "image/png" },
      { path: "/tmp/b.png", mime: "image/png" },
    ],
  });
  // The model is told only of the pane; the images go as themselves.
  expect(d.starts[0].prompt).toContain('<context kind="agent" name="Fix sidebar flicker">');
  expect(d.starts[0].prompt).not.toContain("Image 1");
  expect(p.conversation.items[0]).toMatchObject({
    kind: "user",
    text: "",
    chips: [{ name: "Fix sidebar flicker" }, { name: "Image 1" }, { name: "Image 2" }],
  });
  // They lead the message in the thread as they led the input.
  expect(card(draw(p))[1]).toMatch(/^│  › +\* +Fix sidebar f… +Image 1 +Image 2 +│$/);
});

/** Draws `p` with a picture for the image under the pointer, as a host that shows them would. */
function pictured(
  p: Prompt,
  cols: number,
  rows: number,
  thumbnail = { width: 180, height: 72, cell: { width: 9, height: 18 } },
) {
  const w = new Writer();
  p.draw(w, cols, rows, null, 0, { pictures: true, thumbnail });
  return { lines: screen(w.s, cols, rows), ansi: w.s };
}

test("pointing at a pasted image previews it just over its chip", () => {
  const { p } = prompt();
  p.attachImage("/tmp/shot.png", "image/png");
  let lines = draw(p);
  const y = lines.findIndex(l => l.includes("Image 1")),
    x = lines[y].indexOf("Image 1");
  expect(p.previewed()).toBeNull();
  expect(p.hover(x, y)).toBe(true);
  expect(p.previewed()).toBe("/tmp/shot.png");
  // The host shows pictures: the frame sits on the chip's row, holding the thumbnail, named.
  const shown = pictured(p, 112, 34);
  expect(shown.lines[y - 1].slice(x - 2, x)).toBe("╰─");
  expect(shown.lines[y - 7].slice(x - 2, x)).toBe("╭─");
  expect(shown.lines[y - 2]).toContain("Image 1");
  expect(shown.ansi).toContain("\x1b_Ga=p,i=730140");
  // Without pictures it names the file instead.
  expect(draw(p).some(l => l.includes("Image 1 · /tmp/shot.png"))).toBe(true);
  // Off the chip, it goes.
  expect(p.hover(0, 0)).toBe(true);
  expect(p.previewed()).toBeNull();
});

test("a preview with no room over its chip hangs under it, and shrinks when it fits neither side", () => {
  const { p } = prompt();
  p.attachImage("/tmp/shot.png", "image/png");
  // On a short screen the card sits near the top, three rows over its chip and eight under.
  const lines = draw(p, 112, 12),
    y = lines.findIndex(l => l.includes("Image 1")),
    x = lines[y].indexOf("Image 1");
  expect(y).toBe(3);
  p.hover(x, y);
  expect(pictured(p, 112, 12).lines[y + 1].slice(x - 2, x)).toBe("╭─");
  // Eight rows of picture fit neither side: it takes five under the chip.
  const shrunk = pictured(p, 112, 12, { width: 180, height: 144, cell: { width: 9, height: 18 } });
  expect(shrunk.lines[y + 1].slice(x - 2, x)).toBe("╭─");
  expect(shrunk.lines[y + 8].slice(x - 2, x)).toBe("╰─");
  expect(shrunk.ansi).toMatch(/a=p,i=730140,[^\x1b]*r=5/);
});

test("a message's image chip in the thread previews like the input's", async () => {
  const { p } = prompt();
  p.attachImage("/tmp/shot.png", "image/png");
  type(p, "what's this?");
  p.key(13);
  await settle();
  await settle();
  const lines = draw(p),
    y = lines.findIndex(l => l.includes("what's this?")),
    x = lines[y].indexOf("Image 1");
  expect(lines[y]).toMatch(/› +\* +Fix sidebar f… +Image 1 +what's this\?/);
  expect(p.hover(x, y)).toBe(true);
  expect(p.previewed()).toBe("/tmp/shot.png");
  expect(pictured(p, 112, 34).lines[y - 1].slice(x - 2, x)).toBe("╰─");
});

test("a long message wraps under the chips, and scrolls them away with its first line", () => {
  const { p } = prompt();
  type(p, "one two three four five six seven eight nine ten ".repeat(3).trim());
  let lines = card(draw(p, 80, 30));
  const at = lines.findIndex(l => l.includes("one two"));
  // The second line starts at the gutter and runs as far as the first.
  expect(lines[at + 1].slice(0, 6)).toMatch(/^│    \S/);
  expect(lines[at + 1].trimEnd().length).toBeGreaterThan(lines[at].trimEnd().length - 6);
  // Lines enough to scroll take the caret and the chips away with the first.
  p.paste("\n1\n2\n3\n4\n5\n6");
  lines = card(draw(p, 80, 30));
  expect(lines.some(l => l.includes("Fix sidebar") || l.includes("›"))).toBe(false);
  // Back on the first line, they're back.
  for (let i = 0; i < 12; i++) p.sequence("\x1b[A");
  expect(card(draw(p, 80, 30)).some(l => l.includes("Fix sidebar"))).toBe(true);
});

test("Esc hides, a click outside closes, and working shows on the input line", async () => {
  const { p, d } = prompt();
  type(p, "go");
  p.key(13);
  await settle();
  d.add(
    { kind: "turn", session: "0193-session", turn: "", phase: "started" },
    {
      kind: "tool",
      session: "0193-session",
      turn: "",
      id: "1",
      done: false,
      wrote: [],
      name: "Read",
      summary: "src/headless.ts",
    },
  );
  await poll(p, 0);
  const lines = card(draw(p, 112, 34, Date.UTC(2026, 9, 30, 12) + 4200));
  expect(lines.find(l => l.includes("working"))).toContain("working 4s · Read src/headless.ts");
  expect(lines.at(-2)).toContain("ctrl+c stop   esc hide");
  // What's typed meanwhile steers the turn, and says so when it's sent.
  type(p, "use bun");
  expect(card(draw(p, 112, 34)).at(-2)).toContain("⏎ steer   ctrl+c stop  │");
  p.key(13);
  expect(d.sent().at(-1)).toEqual({ kind: "prompt", text: "use bun" });
  expect(card(draw(p, 112, 34)).find(l => l.includes("use bun"))).toMatch(/› use bun +steered/);
  p.key(3);
  expect(d.sent().at(-1)).toEqual({ kind: "interrupt" });
  expect(card(draw(p, 112, 34, Date.UTC(2026, 9, 30, 12) + 5200)).find(l => l.includes("stopping"))).toContain(
    "stopping 5s",
  );
  expect(p.attention()).toBe("working");
  expect(p.key(27)).toEqual({ kind: "close" });
  expect(p.open).toBe(false);
  p.show(context);
  draw(p);
  expect(p.click(0, 0)).toEqual({ kind: "close" });
});

test("poll asks for a frame as the corgi moves, and none while it sleeps", () => {
  const { p } = prompt();
  expect(p.poll(0)).toBe(true);
  // Nothing under way, it sleeps and holds still.
  expect(p.poll(200)).toBe(false);
  expect(card(draw(p))[0]).toContain(" ~ᐯ◡ᴥ◡ᐯ ─╮");
  // Working, it sniffs.
  type(p, "go");
  p.key(13);
  expect(p.poll(1000)).toBe(true);
  expect(p.poll(1200)).toBe(true);
  p.hide();
  expect(p.poll(1400)).toBe(false);
});

test("a session opened over a shell says so", () => {
  expect(contextText({ ...context, focus: { title: "shell", provider: null, activity: "", pane: 3 }, herd: [] })).toBe(
    'Workspace corgi on branch main, in /work/corgi.\nOpened over the pane "shell".',
  );
});

test("the session's context names the workspace, the focused agent and the herd", () => {
  expect(contextText(context)).toBe(
    [
      "Workspace corgi on branch main, in /work/corgi.",
      'Opened over the agent "Fix sidebar flicker" (Claude): Running sidebar tests.',
      "Agents in this workspace:",
      "- Fix sidebar flicker: working · Running sidebar tests",
      "- Release notes: blocked · Needs input",
    ].join("\n"),
  );
});

/** The card's box on screen: the widest ╭…╮ and the ╰ under it. Menus are narrower. */
function box(lines: string[]) {
  let best = { y: -1, x: -1, w: 0 };
  lines.forEach((line, y) => {
    for (let x = line.indexOf("╭"); x >= 0; x = line.indexOf("╭", x + 1)) {
      const w = line.indexOf("╮", x) - x + 1;
      if (w > best.w) best = { y, x, w };
    }
  });
  const bottom = lines.findIndex((line, y) => y > best.y && line[best.x] === "╰");
  return { top: best.y, left: best.x, width: best.w, bottom };
}
async function midConversation(p: Prompt, d: Fake) {
  type(p, "hello");
  p.key(13);
  await settle();
  d.add({
    kind: "message",
    session: "0193-session",
    text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
  });
  d.add({ kind: "turn", session: "0193-session", turn: "", phase: "ended", outcome: "completed" });
  await poll(p, 0);
}

test("/, @ and the picker open over the card or beside it, never moving or resizing it", async () => {
  for (const mid of [false, true])
    for (const [cols, rows] of [
      [112, 34],
      [70, 24],
      [120, 18],
    ]) {
      const { p, d } = prompt();
      if (mid) await midConversation(p, d);
      const before = box(draw(p, cols, rows));
      expect(before.top).toBeGreaterThanOrEqual(0);
      p.key(47);
      const slash = draw(p, cols, rows);
      expect(box(slash)).toEqual(before);
      expect(slash.some(l => l.includes("/forgetmenow"))).toBe(true);
      p.key(127);
      p.key(64);
      const at = draw(p, cols, rows);
      expect(box(at)).toEqual(before);
      expect(at.some(l => l.includes("Release notes"))).toBe(true);
      p.key(127);
      p.key(9);
      const picker = draw(p, cols, rows);
      expect(box(picker)).toEqual(before);
      expect(picker.some(l => l.includes("Search models, agents and accounts"))).toBe(true);
      p.key(27);
      expect(box(draw(p, cols, rows))).toEqual(before);
    }
});

test("a menu fits over the thread when it can, else hangs below the card, else above it", async () => {
  const { p, d } = prompt();
  p.key(47);
  // Fresh, there's no thread to cover: it hangs below.
  let lines = draw(p, 112, 34),
    card = box(lines);
  expect(lines.findIndex(l => l.includes("/forgetmenow"))).toBe(card.bottom + 2);
  p.key(127);
  await midConversation(p, d);
  p.key(47);
  lines = draw(p, 112, 34);
  card = box(lines);
  const at = lines.findIndex(l => l.includes("/forgetmenow"));
  expect(at).toBeGreaterThan(card.top);
  expect(at).toBeLessThan(card.bottom);
  // A card at the bottom, short of room below, has it above.
  const { p: low } = prompt();
  (low as any).anchor = { size: "112x24", top: 19 };
  lines = draw(low, 112, 24);
  card = box(lines);
  expect(card.bottom).toBe(23);
  low.key(47);
  lines = draw(low, 112, 24);
  expect(box(lines)).toEqual(card);
  expect(lines.findIndex(l => l.includes("/new"))).toBe(card.top - 2);
  expect(lines.findIndex(l => l.includes("/forgetmenow"))).toBe(card.top - 9);
});

test("the card grows down from where it opened, and moves up only when it must", async () => {
  const { p, d } = prompt();
  const first = box(draw(p, 112, 40));
  type(p, "hello");
  p.key(13);
  await settle();
  d.add({ kind: "message", session: "0193-session", text: "one\ntwo\nthree" });
  await poll(p, 0);
  const grown = box(draw(p, 112, 40));
  expect(grown.top).toBe(first.top);
  expect(grown.bottom).toBeGreaterThan(first.bottom);
  d.add({ kind: "message", session: "0193-session", text: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") });
  await poll(p, fast_ms);
  const tall = box(draw(p, 112, 40));
  expect(tall.bottom).toBeLessThanOrEqual(39);
  expect(tall.top).toBe(40 - (tall.bottom - tall.top + 1));
  expect(tall.top).toBeLessThan(first.top);
  // It doesn't drop back down when it shrinks; it opens fresh where it starts.
  type(p, "/new");
  p.key(13);
  expect(box(draw(p, 112, 40)).top).toBe(tall.top);
  p.hide();
  p.show(context);
  expect(box(draw(p, 112, 40)).top).toBe(first.top);
});

test("/ and @ menus open again once their trigger is typed anew", () => {
  const { p } = prompt();
  const shows = (what: string) => draw(p).some(l => l.includes(what));
  p.key(47);
  expect(shows("/forgetmenow")).toBe(true);
  p.key(127);
  expect(shows("/forgetmenow")).toBe(false);
  p.key(47);
  expect(shows("/forgetmenow")).toBe(true);
  // Esc closes the menu and keeps the text; it opens again for a new "/".
  p.key(27);
  expect(shows("/forgetmenow")).toBe(false);
  expect(p.open).toBe(true);
  type(p, "re");
  expect(shows("/remember")).toBe(false);
  for (let i = 0; i < 3; i++) p.key(127);
  p.key(47);
  expect(shows("/forgetmenow")).toBe(true);
  p.key(127);
  type(p, "look at @");
  expect(shows("Release notes")).toBe(true);
  p.key(27);
  expect(shows("Release notes")).toBe(false);
  expect(card(draw(p)).find(l => l.includes("›"))).toContain("look at @");
  p.key(127);
  p.key(64);
  expect(shows("Release notes")).toBe(true);
});

test("@ lists what it can attach, filtered; ⏎ or Tab attaches it and takes the @word out", async () => {
  const { p } = prompt();
  type(p, "what does @");
  let lines = draw(p);
  // The focused agent is already attached, so it isn't offered again.
  expect(lines.filter(l => /Release notes|diff|Fix sidebar/.test(l) && !l.includes("›")).map(l => l.trim())).toEqual([
    "│ † Release notes  Needs input                                 │",
    "│   diff           uncommitted changes in corgi                │",
  ]);
  type(p, "di");
  lines = draw(p);
  expect(lines.some(l => l.includes("Release notes"))).toBe(false);
  p.key(9);
  expect(p.attached()).toEqual(["Fix sidebar flicker", "diff"]);
  type(p, "say?");
  lines = card(draw(p));
  // The chips sit in the input row, before what's typed.
  expect(lines.find(l => l.includes("›"))).toContain("›  *  Fix sidebar f…   diff  what does say?█");
  // Nothing matches: no menu.
  type(p, " @zzz");
  expect(draw(p).some(l => l.includes("Release notes"))).toBe(false);
  expect(p.attached().length).toBe(2);
});

test("@ offers the other workspaces, and what one holds once it's attached", () => {
  const { p } = prompt(),
    api = { id: 9, name: "api" };
  p.show({
    ...context,
    mentions: [
      ...context.mentions,
      { kind: "workspace", id: 9, name: "api", cwd: "/work/api" },
      { kind: "agent", pane: 31, name: "Fix the parser", provider: "codex", activity: "Running tests", workspace: api },
      { kind: "diff", cwd: "/work/api", workspace: api },
    ],
  });
  type(p, "@");
  let lines = draw(p);
  // The workspace is offered; what it holds waits until it's attached.
  expect(lines.some(l => /api +workspace · api/.test(l))).toBe(true);
  expect(lines.some(l => l.includes("Fix the parser"))).toBe(false);
  type(p, "api");
  p.key(13);
  expect(p.attached()).toEqual(["Fix sidebar flicker", "api"]);
  type(p, "@");
  lines = draw(p);
  expect(lines.some(l => /Fix the parser +Running tests · in api/.test(l))).toBe(true);
  expect(lines.some(l => /api diff +uncommitted changes in api/.test(l))).toBe(true);
  // Its diff is its own, beside this workspace's.
  type(p, "api diff");
  p.key(13);
  expect(p.attached()).toEqual(["Fix sidebar flicker", "api", "api diff"]);
});

test("Backspace in an empty box drops the last chip; reopening elsewhere replaces the default one", () => {
  const { p } = prompt();
  // The pane it opened over is the only chip it starts with.
  expect(p.attached()).toEqual(["Fix sidebar flicker"]);
  type(p, "@rel");
  p.key(13);
  expect(p.attached()).toEqual(["Fix sidebar flicker", "Release notes"]);
  p.key(127);
  expect(p.attached()).toEqual(["Fix sidebar flicker"]);
  type(p, "@diff");
  p.key(13);
  p.hide();
  p.show({ ...context, focus: { title: "Release notes", provider: "codex", activity: "", pane: 8 } });
  expect(p.attached()).toEqual(["Release notes", "diff"]);
  p.key(127);
  p.key(127);
  p.key(127);
  expect(p.attached()).toEqual([]);
  expect(card(draw(p)).findLast(l => l.includes("›"))).toMatch(/›\s+█Ask Corgi/);
});

test("a message carries a context block per attachment; the thread shows what went with it", async () => {
  const d = new Fake(),
    resolved: string[] = [],
    p = new Prompt({
      daemon: d,
      memory_root: folder(),
      clock: () => Date.UTC(2026, 9, 30, 12),
      resolve: async m => {
        resolved.push(m.kind === "agent" ? `agent ${m.pane}` : m.kind);
        return m.kind === "diff"
          ? "diff --git a/x b/x\n+new\x1b]52;c;ZXZpbA==\x07"
          : `screen of ${m.kind === "agent" ? m.name : "?"}`;
      },
    });
  p.catalog(entries, [opus], []);
  p.show(context);
  type(p, "@diff");
  p.key(13);
  await settle();
  expect(resolved).toEqual(["agent 7", "diff"]);
  type(p, "what's this error?");
  p.key(13);
  expect(d.starts[0].prompt).toBe(
    [
      '<context kind="agent" name="Fix sidebar flicker">',
      "screen of Fix sidebar flicker",
      "</context>",
      '<context kind="diff" name="diff">',
      "diff --git a/x b/x",
      "+new",
      "</context>",
      "",
      "what's this error?",
    ].join("\n"),
  );
  expect(p.conversation.items[0]).toEqual({
    kind: "user",
    text: "what's this error?",
    chips: [context.mentions[0], context.mentions[2]],
  });
  expect(card(draw(p)).slice(1, 3)).toEqual([
    "│  ›  *  Fix sidebar f…   diff  what's this error?                                 │",
    "│                                                                                  │",
  ]);
  expect(p.attached()).toEqual([]);
  // Mid-conversation, a new attachment goes with the next message.
  await settle();
  type(p, "@rel");
  p.key(13);
  await settle();
  type(p, "and this one?");
  p.key(13);
  expect(d.sent().at(-1).text).toBe(
    '<context kind="agent" name="Release notes">\nscreen of Release notes\n</context>\n\nand this one?',
  );
});

test("a message waits for an attachment still being read", async () => {
  const d = new Fake();
  let release!: (text: string) => void;
  const p = new Prompt({
    daemon: d,
    memory_root: folder(),
    resolve: m => (m.kind === "diff" ? new Promise(r => (release = r)) : Promise.resolve("")),
  });
  p.catalog(entries, [opus], []);
  p.show({ ...context, focus: null });
  type(p, "@diff");
  p.key(13);
  type(p, "summarize");
  expect(p.key(13)).toBeNull();
  expect(d.starts).toEqual([]);
  expect(card(draw(p)).find(l => l.includes("›"))).toContain("Reading diff…");
  release("+line");
  await settle();
  await settle();
  expect(d.starts.map(s => s.prompt.endsWith("summarize") && s.prompt.includes("+line"))).toEqual([true]);
});

test("the pointer hits the menu where it hangs, and no brand mark shows under it", () => {
  const { p } = prompt();
  type(p, "@");
  const w = new Writer(),
    placed: [string, number, number][] = [];
  p.draw(
    w,
    112,
    34,
    (provider, col, row) => {
      placed.push([provider, col, row]);
      return "<mark>";
    },
    0,
  );
  const lines = screen(w.s, 112, 34),
    y = lines.findIndex(l => l.includes("uncommitted changes")),
    x = lines[y].indexOf("diff");
  expect(placed.some(([provider]) => provider === "codex")).toBe(true);
  expect(p.hover(x, y)).toBe(true);
  expect(p.hover(x, y)).toBe(false);
  expect(p.click(x, y)).toBeNull();
  expect(p.attached()).toEqual(["Fix sidebar flicker", "diff"]);
  // The footer's and the chips' marks still sit on their rows, and none under the menu but its own.
  const drawn = (p as any).drawn,
    panel = drawn.panel,
    under = placed.filter(([, col, row]) => panel.contains(col, row));
  expect(placed.map(([, , row]) => row)).toEqual(expect.arrayContaining([drawn.footer_y, drawn.input_y]));
  expect(under.every(([, col]) => col === panel.x + 2)).toBe(true);
});

test("typing into an open menu or the picker's search keeps it where and how big it is", async () => {
  for (const mid of [false, true]) {
    const { p, d } = prompt();
    if (mid) await midConversation(p, d);
    const panel = () => {
      draw(p);
      const r = (p as any).drawn.panel;
      return r && [r.x, r.y, r.w, r.h];
    };
    p.key(47);
    const slash = panel();
    type(p, "rem");
    expect(panel()).toEqual(slash);
    for (let i = 0; i < 4; i++) p.key(127);
    type(p, "@");
    const at = panel();
    type(p, "re");
    expect(panel()).toEqual(at);
    for (let i = 0; i < 3; i++) p.key(127);
    p.key(9);
    const picker = panel();
    type(p, "/gpt");
    expect(panel()).toEqual(picker);
    p.key(27);
    p.key(27);
    expect(panel()).toBeNull();
  }
});

test("an @ search runs past spaces while its words match, and stays text once one doesn't", () => {
  const { p } = prompt();
  const offered = () => draw(p).some(l => l.includes("Release notes") && !l.includes("›"));
  type(p, "@release no");
  expect(offered()).toBe(true);
  type(p, "tes please");
  expect(offered()).toBe(false);
  expect(card(draw(p)).find(l => l.includes("›"))).toContain("@release notes please");
  for (let i = 0; i < "@release notes please".length; i++) p.key(127);
  // An agent's name finds its panes.
  type(p, "@codex");
  expect(offered()).toBe(true);
  p.key(13);
  expect(p.attached()).toEqual(["Fix sidebar flicker", "Release notes"]);
});

test("chips sit inline in the input row, so adding or removing one never resizes the card", async () => {
  for (const mid of [false, true]) {
    const { p, d } = prompt();
    if (mid) await midConversation(p, d);
    const before = box(draw(p));
    type(p, "@rel");
    p.key(13);
    type(p, "@diff");
    p.key(13);
    expect(box(draw(p))).toEqual(before);
    // Fresh, with the default chip, three don't fit in half the row: the
    // oldest is counted and the newest show.
    const row = card(draw(p)).findLast(l => l.includes("›"))!;
    expect(row).toMatch(mid ? /› +† +Release notes +diff +█/ : /› \+1 +† +Release notes +diff +█/);
    p.key(127);
    p.key(127);
    expect(box(draw(p))).toEqual(before);
  }
});
