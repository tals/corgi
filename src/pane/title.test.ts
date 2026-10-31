import { expect, spyOn, test } from "bun:test";
import { Terminal } from "./terminal";

function equivalent(terminal: Terminal) {
  const info = terminal.native({ op: "info" }),
    expected = { text: info.title, pid: info.title_pid, revision: BigInt(info.title_revision) };
  expect(terminal.titleInfo()).toEqual(expected);
  expect(terminal.title).toBe(expected.text);
  expect(terminal.title_pid).toBe(expected.pid);
  expect(terminal.title_revision).toBe(expected.revision);
  return expected;
}

test("direct title reads match the full info reply for empty, fragmented and Unicode titles", () => {
  const terminal = new Terminal(20, 4);
  try {
    expect(equivalent(terminal).text).toBe("");
    terminal.feed('\x1b]0;Owned 界é 🐕 "quoted"\\path\x07');
    expect(equivalent(terminal).text).toBe('Owned 界é 🐕 "quoted"\\path');
    terminal.feed("\x1b]2;partial");
    expect(equivalent(terminal).text).toContain("Owned");
    terminal.feed(" title\x1b\\");
    expect(equivalent(terminal).text).toBe("partial title");
    terminal.feed("\x1b]2;\x07");
    expect(equivalent(terminal).text).toBe("");
  } finally {
    terminal.destroy();
  }
});

test("title text stays fresh when a status changes without changing its session revision", () => {
  const terminal = new Terminal(20, 4),
    session = "11111111-1111-4111-8111-111111111111";
  try {
    terminal.restore(Buffer.from(`\x1b]2;${session} | Ready\x07`), 42);
    const ready = equivalent(terminal);
    expect(ready.pid).toBe(42);
    for (const status of ["Working", "Action Required", "Ready"]) {
      terminal.feed(`\x1b]2;${session} | ${status}\x07`);
      const next = equivalent(terminal);
      expect(next.text).toBe(`${session} | ${status}`);
      expect(next.revision).toBe(ready.revision);
    }
    terminal.feed("\x1b]2;22222222-2222-4222-8222-222222222222 | Ready\x07");
    expect(equivalent(terminal).revision).toBeGreaterThan(ready.revision);
    expect(ready.text).toBe(`${session} | Ready`);
  } finally {
    terminal.destroy();
  }
});

test("title metadata preserves signed restored process IDs", () => {
  const terminal = new Terminal(20, 4);
  try {
    for (const pid of [0, 42, -1, -2147483648, 2147483647]) {
      terminal.restore(Buffer.from("\x1b]2;restored\x07"), pid);
      expect(equivalent(terminal).pid).toBe(pid);
    }
  } finally {
    terminal.destroy();
  }
});

test("direct title strings own their bytes across mutation, other terminals and destruction", () => {
  const first = new Terminal(20, 4),
    second = new Terminal(20, 4);
  let held = "";
  try {
    first.feed("\x1b]2;Owned 界🐕\x07");
    held = first.titleInfo().text;
    for (let i = 0; i < 30; i++) {
      second.restore(Buffer.from(`\x1b]2;other ${i}\x07`), i);
      equivalent(second);
      first.feed(`\x1b]2;replacement ${i}\x07`);
      equivalent(first);
    }
  } finally {
    first.destroy();
    second.destroy();
  }
  expect(held).toBe("Owned 界🐕");
  expect(() => first.titleInfo()).toThrow("TerminalClosed");
  expect(() => first.title).toThrow("TerminalClosed");
  expect(() => first.title_pid).toThrow("TerminalClosed");
  expect(() => first.title_revision).toThrow("TerminalClosed");
});

test("title readers do not request a serialized terminal info object", () => {
  const terminal = new Terminal(20, 4),
    native = spyOn(terminal, "native");
  try {
    terminal.feed("\x1b]2;title\x07");
    expect(terminal.titleInfo().text).toBe("title");
    expect(terminal.title).toBe("title");
    expect(terminal.title_pid).toBe(0);
    expect(terminal.title_revision).toBe(0n);
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    terminal.destroy();
  }
});
