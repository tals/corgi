import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Terminal } from "./terminal";
import { Tracker, PromptWatch } from "../detection";
import { adapter } from "../providers";
import type { Known } from "../providers/adapter";
import { n } from "../native_ffi";

let reading: ReturnType<typeof spyOn<typeof n, "terminal_live_text">>;
beforeEach(() => {
  reading = spyOn(n, "terminal_live_text");
});
afterEach(() => {
  reading.mockRestore();
});

class ReadingTerminal extends Terminal {
  get reads(): number {
    return reading.mock.calls.filter(call => call[0] === this.handle).length;
  }
  uncachedText(): string {
    return super.native({ op: "liveText" });
  }
}

function known(fields: Partial<Known> = {}): Known {
  return {
    state: "working",
    authoritative: true,
    pending_stop: false,
    permission_review: false,
    prompt: new PromptWatch(),
    ...fields,
  };
}

test("live text is retained until feed, resize or restore changes the terminal revision", () => {
  const terminal = new ReadingTerminal(8, 4);
  try {
    let reads = 0;
    const capture = () => {
      const expected = terminal.uncachedText();
      expect(terminal.liveText()).toBe(expected);
      expect(terminal.liveText()).toBe(expected);
      expect(terminal.reads).toBe(++reads);
    };
    capture();
    terminal.feed("abcdefghi 界é");
    capture();
    terminal.resize(20, 5);
    capture();
    expect(terminal.liveText()).toContain("abcdefghi 界é");
    terminal.restore(Buffer.from("\x1b[2J\x1b[HRESTORED"));
    capture();
    expect(terminal.liveText()).toContain("RESTORED");
    terminal.feed("");
    terminal.resize(20, 5);
    terminal.liveText();
    expect(terminal.reads).toBe(reads);
  } finally {
    terminal.destroy();
  }
  expect(() => terminal.liveText()).toThrow("TerminalClosed");
});

test("replacing a terminal cannot reuse another identity's text at the same revision", () => {
  const first = new ReadingTerminal(20, 4),
    replacement = new ReadingTerminal(20, 4);
  try {
    first.feed("FIRST");
    replacement.feed("REPLACEMENT");
    expect(first.surface_revision).toBe(replacement.surface_revision);
    expect(first.surface_identity).not.toBe(replacement.surface_identity);
    let terminal = first;
    const view = () => terminal.liveText();
    expect(view()).toContain("FIRST");
    terminal = replacement;
    expect(view()).toContain("REPLACEMENT");
    expect(view()).not.toContain("FIRST");
    expect(first.reads).toBe(1);
    expect(replacement.reads).toBe(1);
  } finally {
    first.destroy();
    replacement.destroy();
  }
});

test("cached live text follows active output during synchronized and alternate screens", () => {
  const terminal = new ReadingTerminal(40, 6);
  try {
    terminal.feed("PRIMARY");
    expect(terminal.liveText()).toContain("PRIMARY");
    terminal.feed("\x1b[?2026h\x1b[2J\x1b[HMID_UPDATE");
    expect(terminal.liveText()).toBe(terminal.uncachedText());
    expect(terminal.liveText()).toContain("MID_UPDATE");
    terminal.feed("\x1b[?2026l\x1b[?1049hALTERNATE");
    expect(terminal.liveText()).toContain("ALTERNATE");
    terminal.feed("\x1b[?1049l");
    expect(terminal.liveText()).toContain("MID_UPDATE");
    expect(terminal.reads).toBe(4);
  } finally {
    terminal.destroy();
  }
});

test("viewer scrollback captures do not change the cached active screen", () => {
  const terminal = new ReadingTerminal(20, 3);
  try {
    terminal.feed("HISTORY\r\n1\r\n2\r\n3\r\nACTIVE");
    const text = terminal.liveText(),
      revision = terminal.surface_revision;
    expect(text).toContain("ACTIVE");
    expect(text).not.toContain("HISTORY");
    terminal.surface(1, 0);
    expect(terminal.surface_revision).toBe(revision);
    expect(terminal.liveText()).toBe(text);
    expect(terminal.liveText()).toBe(terminal.uncachedText());
    expect(terminal.reads).toBe(1);
  } finally {
    terminal.destroy();
  }
});

test("raw live text owns Unicode strings after native mutation and destruction", () => {
  const terminal = new ReadingTerminal(40, 6);
  let captured = "",
    expected = "";
  try {
    terminal.feed('\x1b[31mOwned 界é 🐕 "quoted"\\path\x1b[0m');
    captured = terminal.liveText();
    expected = terminal.uncachedText();
    for (let i = 0; i < 20; i++) {
      terminal.feed(`\x1b[2J\x1b[Hreplacement ${i}`);
      expect(terminal.liveText()).toBe(terminal.uncachedText());
    }
  } finally {
    terminal.destroy();
  }
  expect(captured).toBe(expected);
  expect(captured).toContain("Owned 界é 🐕");
});

test("unchanged live text still confirms screen states and observes changed titles", () => {
  const terminal = new ReadingTerminal(80, 8),
    watcher = adapter("codex").watch(""),
    memory = new Tracker(),
    view = { id: 1, title: "", text: () => terminal.liveText() };
  try {
    terminal.feed("› ");
    expect(watcher.read(view, memory, null, 0).shown).toBeNull();
    expect(watcher.read(view, memory, null, 250000).shown).toBeNull();
    expect(watcher.read(view, memory, null, 500000).shown).toEqual({ state: "idle", tool: false });
    expect(memory.confirmations).toBe(3);
    expect(terminal.reads).toBe(1);
    view.title = "Action Required";
    expect(watcher.read(view, memory, null, 750000).shown).toBeNull();
    expect(watcher.read(view, memory, null, 1000000).shown).toEqual({ state: "blocked", tool: false });
    expect(memory.confirmations).toBe(2);
    expect(terminal.reads).toBe(1);
  } finally {
    terminal.destroy();
  }
});

test("unchanged live text still expires a Claude interruption timeout", () => {
  const terminal = new ReadingTerminal(80, 8),
    watcher = adapter("claude").watch(""),
    memory = new Tracker(),
    view = { id: 1, title: "✳ Task", text: () => terminal.liveText() },
    state = known(),
    start = 10000000;
  try {
    terminal.feed("> \r\n  ? for shortcuts");
    expect(watcher.read(view, memory, state, start).interrupted).toBe(false);
    expect(watcher.read(view, memory, state, start + 1499999).interrupted).toBe(false);
    expect(watcher.read(view, memory, state, start + 1500000).interrupted).toBe(true);
    expect(memory.idle_since).toBe(0);
    expect(terminal.reads).toBe(1);
    expect(watcher.read(view, memory, known({ pending_stop: true }), start + 3000000).interrupted).toBe(false);
    expect(terminal.reads).toBe(1);
  } finally {
    terminal.destroy();
  }
});

test("unchanged live text still confirms a covered and then answered Claude prompt", () => {
  const terminal = new ReadingTerminal(80, 8),
    watcher = adapter("claude").watch(""),
    memory = new Tracker(),
    view = { id: 1, title: "", text: () => terminal.liveText() },
    state = known({ state: "blocked" });
  try {
    terminal.feed("Enter to confirm · Esc to cancel");
    expect(watcher.read(view, memory, state, 0).answered).toBeNull();
    expect(watcher.read(view, memory, state, 250000).answered).toBeNull();
    expect(state.prompt.seen).toBe(true);
    expect(terminal.reads).toBe(1);
    terminal.feed("\x1b[2J\x1b[H──────────\r\n❯ \r\n──────────");
    expect(watcher.read(view, memory, state, 500000).answered).toBeNull();
    expect(watcher.read(view, memory, state, 750000).answered).toBe("idle");
    expect(state.prompt.seen).toBe(false);
    expect(terminal.reads).toBe(2);
  } finally {
    terminal.destroy();
  }
});
