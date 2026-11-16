import { expect, test } from "bun:test";
import * as copyMode from "./copy_mode";
import * as mirror from "./mirror";
import { Terminal } from "./pane/terminal";
import { transport } from "./fixtures/transport";

function fixture(text: string, cols = 16, rows = 4) {
  const source = new Terminal(cols, rows);
  const term = new mirror.Terminal(
    transport(async () => ({})),
    1,
    cols,
    rows,
  );
  source.feed(text);
  term.receive(source.surface(1));
  const state = new copyMode.State(term);
  return {
    source,
    term,
    state,
    arrive() {
      term.receive(source.surface(1, term.offset));
      state.sync();
    },
    close() {
      term.destroy();
      source.destroy();
    },
  };
}

test("copy selects inclusive characters forwards and backwards", () => {
  const f = fixture("hello world\r\nsecond\x1b[H");
  try {
    f.state.act("select");
    for (let i = 0; i < 4; i++) f.state.act("right");
    expect(f.state.text()).toBe("hello");
    expect(f.term.selectedText()).toBe("hello");
    f.state.act("swap");
    expect(f.state.text()).toBe("hello");
    f.state.act("select");
    expect(f.term.selection).toBeNull();
    f.state.act("end");
    f.state.act("select");
    f.state.act("home");
    expect(f.state.text()).toBe("hello world");
  } finally {
    f.close();
  }
});

test.each([
  ["hello world", 6, "hello "],
  ["    value", 4, "    "],
  ["hello  ", 7, "hello  "],
  ["界  ", 3, "界  "],
])("copy preserves selected whitespace in %j", (text, count, expected) => {
  const f = fixture(text + "\x1b[H");
  try {
    f.state.act("select");
    for (let i = 1; i < count; i++) f.state.act("right");
    expect(f.state.text()).toBe(expected);
    f.state.act("swap");
    expect(f.state.text()).toBe(expected);
  } finally {
    f.close();
  }
});

test("copy preserves selected whitespace across rows", () => {
  const f = fixture("ab  \r\n  cd\x1b[1;3H", 4);
  try {
    f.state.act("select");
    f.state.act("down");
    f.state.act("left");
    expect(f.state.text()).toBe("  \n  ");
  } finally {
    f.close();
  }
});

test("copy selects whole lines in reverse and switches selection kind", () => {
  const f = fixture("first\r\nsecond\x1b[2;3H");
  try {
    f.state.act("select");
    f.state.act("lines");
    f.state.act("up");
    expect(f.state.text()).toBe("first\nsecond\n");
  } finally {
    f.close();
  }
});

test("copy walks wide characters and keeps combining marks", () => {
  const f = fixture("a界e\u0301😀z\x1b[H");
  try {
    f.state.act("right");
    expect(f.state.cursor.x).toBe(1);
    f.state.act("select");
    f.state.act("right");
    expect(f.state.cursor.x).toBe(3);
    expect(f.state.text()).toBe("界é");
    f.state.act("right");
    expect(f.state.text()).toBe("界é😀");
    f.state.act("right");
    expect(f.state.cursor.x).toBe(6);
    f.state.act("left");
    expect(f.state.cursor.x).toBe(4);
  } finally {
    f.close();
  }
});

test("copy holds output and resumes it on exit", () => {
  const f = fixture("before\x1b[H");
  try {
    f.source.feed("after!");
    f.arrive();
    f.state.act("lines");
    expect(f.state.text()).toBe("before\n");
    f.state.close();
    expect(f.term.holding_selection).toBe(false);
    expect(f.term.selection).toBeNull();
    expect(f.term.offset).toBeNull();
    f.term.receive(f.source.surface(1));
    expect(f.term.inner.text()).toContain("after!");
  } finally {
    f.close();
  }
});

test("copy keeps a search match on the current viewport", async () => {
  const f = fixture("hello world\x1b[H");
  try {
    f.term.conn = transport(async () => ({ ok: true, ...f.source.search("world") }));
    expect(await f.term.search("world", 0)).toBe(true);
    f.state.found();
    expect(f.state.text()).toBe("world");
  } finally {
    f.close();
  }
});

test("copy fills intervening scrollback for top and bottom jumps", () => {
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i}`);
  const f = fixture(lines.join("\r\n"), 16, 4);
  try {
    f.state.act("lines");
    f.state.act("top");
    expect(f.state.text()).toBeNull();
    for (let i = 0; i < 10 && !f.term.holding_selection; i++) f.arrive();
    expect(f.state.cursor.y).toBe(0);
    expect(f.state.text()).toBe(lines.join("\n") + "\n");
    f.state.act("lines");
    f.state.act("lines");
    f.state.act("bottom");
    for (let i = 0; i < 10 && !f.term.holding_selection; i++) f.arrive();
    expect(f.state.text()).toBe(lines.join("\n") + "\n");
  } finally {
    f.close();
  }
});

test("copy wheel scrolling moves the viewport and clamps the cursor at its edges", () => {
  const f = fixture(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\r\n"));
  try {
    f.state.act({ scroll: -3 });
    f.state.act({ scroll: 3 });
    expect(f.state.text()).toBeNull();
    f.arrive();
    expect(f.term.displayedOffset).toBe(7);
    expect(f.state.cursor.y).toBe(10);
    expect(f.state.text()).toBeNull();
    f.arrive();
    expect(f.term.displayedOffset).toBe(10);
    expect(f.state.visibleCursor()?.y).toBe(0);
    expect(f.state.text()).not.toBeNull();
    f.state.act({ scroll: 3 });
    expect(f.term.offset).toBe(10);
    expect(f.term.holding_selection).toBe(true);
    f.state.act("top");
    f.arrive();
    f.state.act({ scroll: -3 });
    expect(f.term.offset).toBe(0);
    expect(f.state.visibleCursor()?.y).toBe(0);
    expect(f.term.holding_selection).toBe(true);
  } finally {
    f.close();
  }
});

test("copy resets selection when a navigated viewport changes size", () => {
  const f = fixture("first\r\nsecond\r\nthird\r\nfourth\r\nfifth", 16, 3);
  try {
    f.state.act("lines");
    f.state.act("top");
    f.source.resize(12, 3);
    f.arrive();
    expect(f.state.selection).toBeNull();
    expect(f.state.visibleCursor()).not.toBeNull();
  } finally {
    f.close();
  }
});
