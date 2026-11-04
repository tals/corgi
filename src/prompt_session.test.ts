import { expect, test } from "bun:test";
import * as errors from "./errors";
import { Conversation, clean, fast_ms, shownLine, slow_ms, type Daemon, type Start } from "./prompt_session";

/** A daemon that keeps one session's journal and records what it was asked. */
class Fake implements Daemon {
  calls: { op: string; payload: any }[] = [];
  starts: any[] = [];
  journal: { seq: number; event: unknown }[] = [];
  pending: unknown[] = [];
  /** The next reply to `start`, or a session named s1. */
  starting: Promise<{ provider: any; session: string }> | null = null;
  /** Fails every events call with this name. */
  failing: string | null = null;
  /** Requests already answered, which the daemon refuses to answer again. */
  answered = new Set<string>();
  async call(op: string, payload: any) {
    this.calls.push({ op, payload });
    if (op === "headless.send" && payload.input.kind === "answer") {
      if (this.answered.has(payload.input.request)) throw Error("NoRequest");
      this.answered.add(payload.input.request);
    }
    if (op !== "headless.events") return { ok: true };
    if (this.failing) throw Error(this.failing);
    return {
      ok: true,
      events: this.journal.filter(e => BigInt(e.seq) > BigInt(payload.after)),
      pending_requests: this.pending,
      next_seq: this.journal.length + 1,
      first_seq: 1,
    };
  }
  start(payload: any) {
    this.starts.push(payload);
    return this.starting ?? Promise.resolve({ provider: payload.provider, session: "s1" });
  }
  add(...events: unknown[]) {
    for (const event of events) this.journal.push({ seq: this.journal.length + 1, event });
  }
  sent() {
    return this.calls.filter(c => c.op === "headless.send").map(c => c.payload.input);
  }
}
const start = (over: Partial<Start> = {}): Start => ({
  provider: "claude",
  account: "",
  model: "claude-opus-5-5",
  effort: "high",
  cwd: "/work",
  workspace: 2,
  instructions: "You are Corgi.",
  persist: true,
  ...over,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function conversation(d: Fake, clock = { now: 0 }, transcripts: Record<string, string> = {}) {
  return new Conversation(d, {
    inside: path => path.startsWith("/memory/"),
    transcript: (_provider, session) => transcripts[session] ?? "",
    clock: () => clock.now,
  });
}
/** Polls until the conversation asked for events once more. */
async function poll(c: Conversation, now: number) {
  c.poll(now);
  await settle();
  await settle();
}

test("the first message starts a corgi session; later ones are sent to it", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("why does CI flake?", () => start());
  expect(c.state).toBe("starting");
  expect(d.starts).toEqual([
    {
      provider: "claude",
      prompt: "why does CI flake?",
      cwd: "/work",
      workspace: 2,
      account: "",
      model: "claude-opus-5-5",
      effort: "high",
      instructions: "You are Corgi.",
      persist: true,
      corgi: true,
    },
  ]);
  await settle();
  expect(c.session).toBe("s1");
  expect(c.state).toBe("working");
  c.send("and locally?", () => {
    throw Error("only the first message starts a session");
  });
  expect(d.sent()).toEqual([{ kind: "prompt", text: "and locally?" }]);
  // The second went to the turn under way.
  expect(c.items).toEqual([
    { kind: "user", text: "why does CI flake?" },
    { kind: "user", text: "and locally?", steer: true },
  ]);
});

test("images go with the first message's start, and with the ones after it", async () => {
  const d = new Fake(),
    c = conversation(d),
    image = { path: "/tmp/a.png", mime: "image/png" },
    chip = { kind: "image" as const, ...image, name: "Image 1" };
  c.send("what's this?", () => start(), { message: "what's this?", chips: [chip] }, [image]);
  expect(d.starts[0]).toMatchObject({ prompt: "what's this?", images: [image] });
  expect(c.items.at(-1)).toEqual({ kind: "user", text: "what's this?", chips: [chip] });
  await settle();
  c.send("and this?", () => start(), undefined, [image]);
  expect(d.sent()).toEqual([{ kind: "prompt", text: "and this?", images: [image] }]);
});

test("messages sent while the session starts wait for it", async () => {
  const d = new Fake();
  let resolve!: (v: { provider: any; session: string }) => void;
  d.starting = new Promise(r => (resolve = r));
  const c = conversation(d);
  c.send("one", () => start());
  c.send("two", () => start());
  expect(d.starts.length).toBe(1);
  expect(d.sent()).toEqual([]);
  resolve({ provider: "claude", session: "s9" });
  await settle();
  expect(d.sent()).toEqual([{ kind: "prompt", text: "two" }]);
  expect(d.calls.at(-1)!.payload.session).toBe("s9");
});

test("a failed start is a hot note, and the next message tries again", async () => {
  const d = new Fake();
  d.starting = Promise.reject(Error("HeadlessExited"));
  const c = conversation(d);
  c.send("hi", () => start());
  await settle();
  expect(c.state).toBe("failed");
  expect(c.items.at(-1)).toEqual({
    kind: "note",
    text: "Claude exited before it started. Check that it's installed and signed in.",
    tone: "hot",
  });
  d.starting = null;
  c.send("hi again", () => start());
  await settle();
  expect(c.state).toBe("working");
  expect(d.starts.length).toBe(2);
});

test("a steer sent while a reply streams leaves the reply one row", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("plan it", () => start());
  await settle();
  d.add(
    { kind: "conversation", session: "s1", parent: null, role: null, shown: true },
    { kind: "turn", session: "s1", turn: "t1", phase: "started" },
    { kind: "partial", session: "s1", text: "Here is" },
  );
  await poll(c, 0);
  c.send("keep it short", () => start());
  d.add(
    { kind: "partial", session: "s1", text: "Here is the plan" },
    { kind: "message", session: "s1", text: "Here is the plan." },
  );
  await poll(c, fast_ms);
  expect(c.items).toEqual([
    { kind: "user", text: "plan it" },
    { kind: "text", text: "Here is the plan.", partial: false },
    { kind: "user", text: "keep it short", steer: true },
  ]);
});

test("streamed text, tools and the turn's end fold into rows", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("look", () => start());
  await settle();
  d.add(
    { kind: "conversation", session: "s1", parent: null, role: null, shown: true },
    { kind: "turn", session: "s1", turn: "t1", phase: "started" },
    { kind: "partial", session: "s1", text: "Let me" },
    { kind: "partial", session: "s1", text: "Let me check." },
    { kind: "tool", session: "s1", turn: "t1", id: "u1", done: false, wrote: [], name: "Read", summary: "src/x.ts" },
    { kind: "message", session: "s1", text: "Let me check the file." },
  );
  await poll(c, 0);
  expect(c.items).toEqual([
    { kind: "user", text: "look" },
    { kind: "text", text: "Let me check the file.", partial: false },
    { kind: "tool", id: "u1", name: "Read", summary: "src/x.ts", done: false },
  ]);
  expect(c.tool()?.id).toBe("u1");
  d.add(
    { kind: "tool", session: "s1", turn: "t1", id: "u1", done: true, wrote: [] },
    // Codex ends its messages as items with no tool's name: not tools.
    { kind: "tool", session: "s1", turn: "t1", id: "m1", done: true, wrote: [] },
    { kind: "partial", session: "s1", text: "It seeds" },
  );
  await poll(c, fast_ms);
  expect(c.items.at(-1)).toEqual({ kind: "text", text: "It seeds", partial: true });
  expect(c.tool()).toBeNull();
  d.add(
    { kind: "message", session: "s1", text: "It seeds from the clock." },
    { kind: "turn", session: "s1", turn: "t1", phase: "ended", outcome: "completed" },
  );
  await poll(c, 2 * fast_ms);
  expect(c.items.slice(-1)).toEqual([{ kind: "text", text: "It seeds from the clock.", partial: false }]);
  expect(c.state).toBe("idle");
  expect(c.attention()).toBe("finished");
  c.seen();
  expect(c.attention()).toBe("none");
});

test("a subagent's text stays out of the thread", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("go", () => start());
  await settle();
  d.add(
    { kind: "conversation", session: "child", parent: "s1", role: "explorer", shown: false },
    { kind: "message", session: "child", text: "child talk" },
    { kind: "turn", session: "child", turn: "c", phase: "ended", outcome: "completed" },
    { kind: "message", session: "s1", text: "parent talk" },
  );
  await poll(c, 0);
  expect(c.items.filter(i => i.kind === "text").map(i => (i as any).text)).toEqual(["parent talk"]);
  expect(c.state).toBe("working");
});

test("events are asked for fast while working, slowly when idle, never without a session", async () => {
  const d = new Fake(),
    c = conversation(d),
    asked = () => d.calls.filter(x => x.op === "headless.events").length;
  c.poll(0);
  expect(asked()).toBe(0);
  c.send("go", () => start());
  await settle();
  await poll(c, 1000);
  expect(asked()).toBe(1);
  await poll(c, 1000 + fast_ms - 1);
  expect(asked()).toBe(1);
  d.add({ kind: "turn", session: "s1", turn: "", phase: "ended", outcome: "completed" });
  await poll(c, 1000 + fast_ms);
  expect(asked()).toBe(2);
  expect(c.state).toBe("idle");
  await poll(c, 1000 + 2 * fast_ms);
  expect(asked()).toBe(2);
  await poll(c, 1000 + fast_ms + slow_ms);
  expect(asked()).toBe(3);
  expect(d.calls.filter(x => x.op === "headless.events").map(x => x.payload.after)).toEqual([0n, 0n, 1n]);
  // Stopping reads what's left once, then nothing more.
  await c.stop();
  await poll(c, 99_999);
  expect(asked()).toBe(4);
});

test("every request waits for the user's answer, even one about memory", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("fix it", () => start());
  await settle();
  const edit = { tool: true, name: "Edit", summary: "src/x.ts" },
    memory = { tool: true, name: "Edit", summary: "/memory/2026-10-30.md" };
  d.add(
    { kind: "request", session: "s1", id: "r1", ask: edit },
    { kind: "request", session: "s1", id: "r2", ask: memory },
  );
  d.pending = [
    { id: "r1", session: "s1", ask: edit },
    { id: "r2", session: "s1", ask: memory },
  ];
  await poll(c, 0);
  expect(c.state).toBe("blocked");
  expect(c.attention()).toBe("needs_input");
  expect(c.pending()).toEqual({ kind: "ask", id: "r1", name: "Edit", summary: "src/x.ts", answer: null });
  expect(d.sent()).toEqual([]);
  c.answer("r1", false);
  expect(d.sent().at(-1)).toEqual({ kind: "answer", request: "r1", allow: false });
  expect(c.pending()?.id).toBe("r2");
  c.answer("r2", true);
  expect(d.sent().at(-1)).toEqual({ kind: "answer", request: "r2", allow: true });
  expect(c.pending()).toBeNull();
  expect(c.state).toBe("working");
  // Answered once, though the same reply still lists them.
  await poll(c, fast_ms);
  expect(d.sent().length).toBe(2);
});

test("a request the reply no longer lists was closed, and isn't answered", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("go", () => start());
  await settle();
  d.add({ kind: "request", session: "s1", id: "r1", ask: { tool: true, name: "Write", summary: "/memory/x.md" } });
  await poll(c, 0);
  expect(d.sent()).toEqual([]);
  expect(c.pending()).toBeNull();
});

test("requests come back from the pending list, and leave when answered elsewhere", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("go", () => start());
  await settle();
  d.pending = [{ id: "r7", session: "s1", ask: { tool: true, name: "Bash", summary: "bun test" } }];
  await poll(c, 0);
  expect(c.pending()?.id).toBe("r7");
  d.pending = [];
  await poll(c, fast_ms);
  expect(c.pending()).toBeNull();
  d.add({ kind: "request_closed", session: "s1", id: "r7", running: false });
  await poll(c, 2 * fast_ms);
  expect(c.state).toBe("idle");
});

test("direct memory writes show an update even when their start was not read", async () => {
  for (const started of [false, true]) {
    const d = new Fake(),
      c = conversation(d),
      tool = { kind: "tool", session: "s1", id: "write", name: "Write", summary: "/memory/MEMORY.md" };
    c.send("remember this", () => start());
    await settle();
    if (started) d.add({ ...tool, done: false, wrote: [] });
    d.add({ ...tool, done: true, wrote: ["/memory/MEMORY.md", "/memory/today.md"] });
    await poll(c, 0);
    expect(c.items.filter(i => i.kind === "note")).toEqual([
      { kind: "note", text: "Memory updated", tone: "faint", bone: true },
    ]);
    expect(c.wrote).toEqual([]);
    d.add(
      { ...tool, id: "outside", done: true, wrote: ["/repo/file", "relative.md", 1] },
      { ...tool, id: "failed", done: true, wrote: [] },
    );
    await poll(c, fast_ms);
    expect(c.items.filter(i => i.kind === "note")).toHaveLength(1);
    const again = conversation(d);
    again.attach(start(), "s1", false);
    await poll(again, 0);
    expect(again.items.filter(i => i.kind === "note")).toEqual(c.items.filter(i => i.kind === "note"));
    expect(again.wrote).toEqual([]);
  }
});

test("lines corgi memory writes for the session become rows, and new ones are kept for /erase", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("remember that CI is parallel", () => start());
  await settle();
  const line = "- CI runs unit tests in parallel",
    was = { file: "/memory/MEMORY.md", line: "- CI is slow" };
  d.add(
    { kind: "memory", session: "s1", file: "/memory/today.md", line, was: null },
    { kind: "memory", session: "s1", file: "/memory/MEMORY.md", line: "- CI is fast now", was },
  );
  await poll(c, 0);
  expect(c.items.slice(-2)).toEqual([
    { kind: "note", text: "remembered CI runs unit tests in parallel", tone: "faint", bone: true },
    { kind: "note", text: "edited CI is fast now", tone: "faint", bone: true },
  ]);
  // A line it rewrote was the user's first.
  expect(c.wrote).toEqual([{ file: "/memory/today.md", line }]);
  // One of its own it rewrites, or moves, stays its own as it now reads.
  d.add(
    { kind: "memory", session: "s1", file: "/memory/today.md", line: "- CI runs in parallel", was: c.wrote[0] },
    {
      kind: "memory",
      session: "s1",
      file: "/memory/MEMORY.md",
      line: "- CI runs in parallel",
      was: { file: "/memory/today.md", line: "- CI runs in parallel" },
    },
  );
  await poll(c, fast_ms);
  expect(c.wrote).toEqual([{ file: "/memory/MEMORY.md", line: "- CI runs in parallel" }]);
  // A viewer that reloads reads them again from the journal, so /erase still finds them.
  const again = conversation(d);
  again.attach(start(), "s1", false);
  await poll(again, 0);
  expect(again.wrote).toEqual(c.wrote);
});
test("a memory line outside the memory folder counts for nothing, and one an incognito chat wrote anyway shows", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  d.add(
    { kind: "memory", session: "s1", file: "/etc/passwd", line: "- root", was: null },
    { kind: "memory", session: "s1", file: "memory/today.md", line: "- relative", was: null },
  );
  await poll(c, 0);
  expect(c.items.some(i => i.kind === "note")).toBe(false);
  c.memory_writes = false;
  d.add({ kind: "memory", session: "s1", file: "/memory/today.md", line: "- secret", was: null });
  await poll(c, fast_ms);
  expect(c.wrote).toEqual([{ file: "/memory/today.md", line: "- secret" }]);
  expect(c.items.at(-1)).toMatchObject({ kind: "note", text: "remembered secret" });
});
test("stopping reads the memory lines the thread hadn't yet, so /erase finds them", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("remember x", () => start());
  await settle();
  d.add({ kind: "memory", session: "s1", file: "/memory/today.md", line: "- x", was: null });
  const wrote = c.wrote;
  await c.stop();
  expect(wrote).toEqual([{ file: "/memory/today.md", line: "- x" }]);
  expect(d.calls.at(-1)?.op).toBe("headless.stop");
});
test("a lost session says so quietly, stops what's left, and the next message starts another", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  d.failing = "NoHeadlessSession";
  await poll(c, 0);
  expect(c.session).toBe("");
  expect(c.state).toBe("idle");
  expect(c.items.at(-1)).toEqual({
    kind: "note",
    text: "The session ended. Your next message starts a new one.",
    tone: "faint",
  });
  expect(d.calls.at(-1)).toEqual({ op: "headless.stop", payload: { provider: "claude", session: "s1" } });
  d.failing = null;
  c.send("again", () => start());
  expect(d.starts.length).toBe(2);
  expect(d.starts[1].prompt).toBe("again");
});

test("a message for a session that ended starts a new one with it", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  const call = d.call.bind(d);
  d.call = async (op, payload) => {
    if (op === "headless.send") throw Error("HeadlessExited");
    return call(op, payload);
  };
  c.send("are you there?", () => {
    throw Error("the new session starts as the old one did");
  });
  await settle();
  await settle();
  expect(d.starts.map(s => s.prompt)).toEqual(["hi", "are you there?"]);
  expect(d.starts[1].model).toBe("claude-opus-5-5");
  expect(c.items.map(i => (i.kind === "note" ? i.text : i.kind))).toEqual([
    "user",
    "user",
    "The session had ended, so your message started a new one.",
  ]);
  expect(c.state).toBe("working");
});

test("a follow-up the session refuses leaves it as it was", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  d.add(
    { kind: "turn", session: "s1", turn: "", phase: "started" },
    { kind: "turn", session: "s1", turn: "", phase: "completed" },
  );
  await poll(c, 0);
  expect(c.state).toBe("idle");
  const call = d.call.bind(d);
  let failure = errors.fromReply({ err: "InvalidMessage" });
  d.call = async (op, payload) => {
    if (op === "headless.send") throw failure;
    return call(op, payload);
  };
  c.send("nine images", () => start());
  expect(c.state).toBe("working");
  await settle();
  expect(c.state).toBe("idle");
  expect(c.items.at(-1)).toMatchObject({ kind: "note", text: "Couldn't reach Claude: InvalidMessage." });
  // A timeout may have reached it, so the turn it may have started shows.
  failure = Error("Timeout");
  c.send("are you there", () => start());
  await settle();
  expect(c.state).toBe("working");
  d.add({ kind: "turn", session: "s1", turn: "", phase: "completed" });
  await poll(c, fast_ms);
  expect(c.state).toBe("idle");
  // A steer refused mid-turn leaves the turn running.
  failure = errors.fromReply({ err: "InvalidMessage" });
  d.add({ kind: "turn", session: "s1", turn: "", phase: "started" });
  await poll(c, fast_ms + slow_ms);
  expect(c.state).toBe("working");
  c.send("and also", () => start());
  await settle();
  expect(c.state).toBe("working");
});

test("a session taken up after a reload that ended starts the next with instructions", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.attach(start({ instructions: "" }), "s0", false);
  d.call = async (op, payload) => {
    d.calls.push({ op, payload });
    if (op === "headless.send") throw Error("HeadlessExited");
    return { ok: true, events: [], pending_requests: [], next_seq: 1, first_seq: 1 };
  };
  c.send("still there?", () => start({ instructions: "You are Corgi, again." }));
  await settle();
  await settle();
  expect(d.starts.map(s => [s.prompt, s.instructions])).toEqual([["still there?", "You are Corgi, again."]]);
});

test("a read that fails warns once, and an ended client is a lost session", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  d.failing = "ConnectionClosed";
  await poll(c, 0);
  await poll(c, fast_ms);
  expect(c.items.filter(i => i.kind === "note").length).toBe(1);
  d.failing = null;
  d.add({ kind: "turn", session: "s1", turn: "", phase: "started" }, { kind: "ended" });
  await poll(c, 2 * fast_ms);
  expect(c.session).toBe("");
  expect(c.state).toBe("idle");
  expect(c.attention()).toBe("none");
  expect(d.calls.at(-1)?.op).toBe("headless.stop");
});

test("interrupting a turn, and its end saying it stopped", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.interrupt();
  expect(d.sent()).toEqual([]);
  c.send("long task", () => start());
  await settle();
  expect(c.stopping).toBe(false);
  c.interrupt();
  expect(d.sent()).toEqual([{ kind: "interrupt" }]);
  expect(c.stopping).toBe(true);
  d.add({ kind: "turn", session: "s1", turn: "", phase: "ended", outcome: "interrupted" });
  await poll(c, 0);
  expect(c.items.at(-1)).toEqual({ kind: "note", text: "Stopped.", tone: "faint" });
  expect(c.stopping).toBe(false);
});

test("a stop while the session starts reaches it once it arrives, and what waited isn't sent", async () => {
  const d = new Fake();
  let resolve!: (v: { provider: any; session: string }) => void;
  d.starting = new Promise(r => (resolve = r));
  const c = conversation(d);
  c.send("one", () => start());
  c.send("two", () => start());
  c.interrupt();
  expect([c.state, c.stopping]).toEqual(["starting", true]);
  resolve({ provider: "claude", session: "s1" });
  await settle();
  expect(d.sent()).toEqual([{ kind: "interrupt" }]);
  // A turn that only begins now hears it again.
  d.add({ kind: "turn", session: "s1", turn: "t", phase: "started" });
  await poll(c, 0);
  expect(d.sent()).toEqual([{ kind: "interrupt" }, { kind: "interrupt" }]);
  d.add({ kind: "turn", session: "s1", turn: "t", phase: "ended", outcome: "interrupted" });
  await poll(c, 60_000);
  expect([c.state, c.stopping]).toEqual(["idle", false]);
});

test("a conversation let go after an exchange stores what it should, unseen, then stops", async () => {
  const d = new Fake(),
    c = new Conversation(d, {
      inside: () => false,
      wait: () => settle() as Promise<void>,
    });
  c.send("we ship on fridays", () => start());
  await settle();
  d.add({ kind: "turn", session: "s1", turn: "t", phase: "ended", outcome: "completed" });
  await poll(c, 0);
  const stopped = c.reset("Memory flush.");
  // The card starts over at once; the flush runs where nothing shows it.
  expect(c.items).toEqual([]);
  await settle();
  await settle();
  expect(d.sent().at(-1)).toEqual({ kind: "prompt", text: "Memory flush." });
  // Nobody sees it to answer, so whatever it asks is refused.
  d.pending = [
    { id: "r1", session: "s1", ask: { tool: true, name: "Bash", summary: "corgi memory add 'Ships Fridays'" } },
    { id: "r2", session: "s1", ask: { tool: true, name: "Bash", summary: "rm -rf ~" } },
  ];
  for (let i = 0; i < 4; i++) await settle();
  expect(d.sent().filter(i => i.kind === "answer")).toEqual([
    { kind: "answer", request: "r1", allow: false },
    { kind: "answer", request: "r2", allow: false },
  ]);
  expect(d.calls.some(call => call.op === "headless.stop")).toBe(false);
  d.add({ kind: "turn", session: "s1", turn: "t2", phase: "ended", outcome: "completed" });
  await stopped;
  expect(d.calls.at(-1)).toEqual({ op: "headless.stop", payload: { provider: "claude", session: "s1" } });
});

test("a conversation with nothing said, or one at work, isn't flushed", async () => {
  const d = new Fake(),
    c = conversation(d);
  c.send("long task", () => start());
  await settle();
  // Still working: it just stops.
  await c.reset("Memory flush.");
  expect(d.sent().some(i => i.kind === "prompt" && i.text === "Memory flush.")).toBe(false);
  expect(d.calls.at(-1)?.op).toBe("headless.stop");
});

test("a reset while starting stops the session once it arrives", async () => {
  const d = new Fake();
  let resolve!: (v: { provider: any; session: string }) => void;
  d.starting = new Promise(r => (resolve = r));
  const c = conversation(d);
  c.send("hi", () => start());
  await c.reset();
  expect(c.items).toEqual([]);
  resolve({ provider: "claude", session: "late" });
  await settle();
  expect(c.session).toBe("");
  expect(d.calls.at(-1)).toEqual({ op: "headless.stop", payload: { provider: "claude", session: "late" } });
});

test("attaching follows a session from the start of its journal, as already seen", async () => {
  const d = new Fake(),
    c = conversation(d);
  d.add(
    { kind: "message", session: "s1", text: "earlier reply" },
    { kind: "turn", session: "s1", turn: "", phase: "ended", outcome: "completed" },
  );
  c.attach(start({ provider: "codex", account: "/accounts/work", persist: false }), "s1", true);
  expect(c.state).toBe("working");
  await poll(c, 0);
  expect(d.calls[0]).toEqual({
    op: "headless.events",
    payload: { provider: "codex", session: "s1", after: 0n, pane: null },
  });
  expect(c.items).toEqual([{ kind: "text", text: "earlier reply", partial: false }]);
  expect(c.state).toBe("idle");
  expect(c.attention()).toBe("none");
  expect(c.started?.account).toBe("/accounts/work");
  expect(c.used).toEqual([
    { provider: "codex", session: "s1", account: "/accounts/work", persist: false, transcript: "" },
  ]);
  // What arrives after the replay is new.
  d.add({ kind: "turn", session: "s1", turn: "", phase: "ended", outcome: "completed" });
  await poll(c, slow_ms);
  expect(c.attention()).toBe("finished");
});

test("every session the thread used is kept, with its transcript learned before it stops", async () => {
  const d = new Fake(),
    c = conversation(d, { now: 0 }, { s1: "/t/s1.jsonl", s2: "/t/s2.jsonl" });
  c.send("one", () => start());
  await settle();
  await c.stop();
  d.starting = Promise.resolve({ provider: "codex", session: "s2" });
  c.send("two", () => start({ provider: "codex", persist: true }));
  expect(c.launching).not.toBeNull();
  expect(await c.launching).toMatchObject({ provider: "codex", session: "s2" });
  await settle();
  expect(c.used.map(u => [u.session, u.transcript])).toEqual([
    ["s1", "/t/s1.jsonl"],
    ["s2", ""],
  ]);
  const used = c.used;
  await c.reset();
  expect(used[1].transcript).toBe("/t/s2.jsonl");
  expect(c.used).toEqual([]);
});

test("text from the daemon is cleaned before it's measured or drawn", async () => {
  expect(clean("a\tb\x1b]52;c;ZXZpbA==\x07 c\x1b[2J d\x9b e\x00f")).toBe("a   b c d  e f");
  expect(clean("ab\tc\r\nd\re", true)).toBe("ab  c\nd\ne");
  expect(clean("one\ntwo")).toBe("one two");
  const d = new Fake(),
    c = conversation(d);
  c.send("hi", () => start());
  await settle();
  d.add(
    { kind: "message", session: "s1", text: "copy\x1b]52;c;ZXZpbA==\x07 this\tnow" },
    { kind: "tool", session: "s1", turn: "", id: "t", done: false, wrote: [], name: "Bash", summary: "echo \x1b[2J" },
  );
  await poll(c, 0);
  expect(c.items.slice(1)).toEqual([
    { kind: "text", text: "copy this   now", partial: false },
    { kind: "tool", id: "t", name: "Bash", summary: "echo ", done: false },
  ]);
});

test("a memory line shows without its list marker", () => {
  expect(shownLine("- [ ] CI runs in parallel")).toBe("CI runs in parallel");
  expect(shownLine("* note")).toBe("note");
});

test("a conversation handed to a pane goes on from where it was read, claimed by that pane", async () => {
  const d = new Fake(),
    card = conversation(d);
  card.send("hi", () => start());
  await settle();
  d.add(
    { kind: "message", session: "s1", text: "hello there" },
    { kind: "conversation", session: "sub", parent: "s1", role: "explorer", shown: false },
  );
  await poll(card, 0);
  const handed = card.handoff()!;
  expect(handed).toMatchObject({ provider: "claude", session: "s1", after: "2", running: true });
  // The card lets it go without stopping it, and starts fresh.
  card.release();
  expect(card.items).toEqual([]);
  expect(card.session).toBe("");
  expect(d.calls.some(c => c.op === "headless.stop")).toBe(false);
  const pane = conversation(d);
  pane.claim = 12;
  pane.adopt(JSON.parse(JSON.stringify(handed)));
  expect(pane.items.map(i => i.kind)).toEqual(["user", "text"]);
  // The subagent's turn and reply stay its own.
  d.add(
    { kind: "message", session: "sub", text: "found it" },
    { kind: "turn", session: "sub", turn: "x", phase: "ended", outcome: "completed" },
    { kind: "message", session: "s1", text: "and more" },
  );
  await poll(pane, 0);
  expect(d.calls.at(-1)).toEqual({
    op: "headless.events",
    payload: { provider: "claude", session: "s1", after: 2n, pane: 12 },
  });
  expect(pane.state).toBe("working");
  expect(pane.items.filter(i => i.kind === "text").map(i => (i as any).text)).toEqual(["hello there", "and more"]);
  // Nothing to hand over before a session runs.
  expect(conversation(new Fake()).handoff()).toBeNull();
});

test("live searches update in place before the shell reply and ignore stale revisions", async () => {
  const d = new Fake(),
    c = conversation(d),
    state = {
      id: "q",
      revision: 1,
      phase: "searching",
      expression: "branch|worktree",
      workspace: "/work",
      found: 0,
      scanned: 0,
      total: 20,
      limited: false,
      matches: [],
      error: "",
    };
  c.send("find that PR", () => start());
  await settle();
  d.add(
    { kind: "tool", session: "s1", id: "bash", name: "Bash", summary: "search", done: false },
    { kind: "search", session: "s1", search: state },
  );
  await poll(c, 0);
  expect(c.tool()?.done).toBe(false);
  expect(c.items.at(-1)).toMatchObject({ kind: "search", search: { phase: "searching" } });
  d.add(
    { kind: "search", session: "other", search: { ...state, id: "other" } },
    { kind: "search", session: "s1", search: { ...state, revision: 3, phase: "done", found: 2, scanned: 20 } },
    { kind: "search", session: "s1", search: { ...state, revision: 2 } },
  );
  await poll(c, fast_ms);
  expect(c.items.filter(i => i.kind === "search")).toHaveLength(1);
  expect(c.items.at(-1)).toMatchObject({ search: { phase: "done", found: 2 } });
  d.add(
    { kind: "search", session: "s1", search: { ...state, id: "unfinished" } },
    { kind: "turn", session: "s1", phase: "ended", outcome: "interrupted" },
  );
  await poll(c, fast_ms * 2);
  expect(c.items.find(i => i.kind === "search" && i.search.id === "unfinished")).toMatchObject({
    search: { phase: "cancelled" },
  });
  d.add({ kind: "search", session: "s1", search: { ...state, id: "unfinished", revision: 9 } });
  await poll(c, fast_ms * 2 + slow_ms);
  expect(c.items.find(i => i.kind === "search" && i.search.id === "unfinished")).toMatchObject({
    search: { phase: "cancelled" },
  });
});
