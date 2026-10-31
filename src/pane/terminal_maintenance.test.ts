import { expect, spyOn, test } from "bun:test";
import { n, ptr, symbols } from "../native_bridge";
import { closeReadiness, Terminal } from "./terminal";

test("maintenance and legacy ticks preserve JSON tick state and leave clipboard data held", () => {
  for (const tick of [n.terminal_tick, n.terminal_maintain]) {
    const direct = new Terminal(20, 4),
      reference = new Terminal(20, 4);
    try {
      for (const [input, exited] of [
        ["text", false],
        ["\x1b[?2026hpartial", false],
        ["\x1b]52;c;aGVsZA==\x07", false],
        ["", true],
        ["\x1b[?2026hnext\x1b[?2026l", false],
      ] as const) {
        direct.feed(input);
        reference.feed(input);
        const expected = reference.native({ op: "tick", exited });
        const flags = tick(direct.handle, exited);
        expect((flags & 1) !== 0).toBe(expected.changed);
        expect((flags & 2) !== 0).toBe(expected.expecting);
        const copied = reference.takeCopied();
        expect((flags & 4) !== 0).toBe(copied !== null);
        expect(n.terminal_has_copied(direct.handle)).toBe(copied !== null);
        expect(direct.takeCopied()).toBe(copied);
        expect(n.terminal_has_copied(direct.handle)).toBe(false);
        expect(direct.liveText()).toBe(reference.liveText());
        expect(direct.vt.modes.get("synchronized_output")).toBe(reference.vt.modes.get("synchronized_output"));
      }
      direct.prefill("make");
      reference.prefill("make");
      const expected = reference.native({ op: "tick", exited: false });
      expect(tick(direct.handle, false) & 3).toBe(Number(expected.changed) | (Number(expected.expecting) << 1));
      expect(expected.expecting).toBe(true);
    } finally {
      direct.destroy();
      reference.destroy();
    }
  }
});

test("ordinary terminal maintenance avoids JSON while retaining read and clipboard behavior", () => {
  class TracedTerminal extends Terminal {
    operations: unknown[] = [];
    override native(request: object) {
      if ("op" in request) this.operations.push(request.op);
      return super.native(request);
    }
  }
  const terminal = new TracedTerminal(20, 4);
  try {
    terminal.feed("output");
    expect(terminal.due()).toBe(true);
    expect(terminal.maintain()).toBe(true);
    expect(terminal.due()).toBe(false);
    expect(terminal.maintain()).toBe(false);
    terminal.flush();
    expect(terminal.takeCopied()).toBeNull();
    expect(terminal.operations).toEqual([]);
    terminal.feed("\x1b]52;c;aGVsZA==\x07");
    expect(terminal.takeCopied()).toBe("held");
    expect(terminal.takeCopied()).toBeNull();
    expect(terminal.operations).toEqual(["takeCopied"]);
    terminal.pause();
    terminal.feed("still pending");
    expect(terminal.read()).toBe(true);
    expect(terminal.operations).toEqual(["takeCopied"]);
  } finally {
    terminal.destroy();
  }
  expect(() => terminal.flush()).toThrow("TerminalClosed");
  expect(() => terminal.takeCopied()).toThrow("TerminalClosed");
});

test("maintenance leaves queued output for the reader and manual reads stay fresh", () => {
  const terminal = new Terminal(20, 4),
    fds = new Int32Array(2);
  expect(n.probe_pair(ptr(fds))).toBe(0);
  const [master, slave] = fds;
  n.probe_nonblock(master);
  terminal.fd = master;
  symbols.app_terminal_fd(terminal.handle, master, -1);
  try {
    const output = Buffer.from("QUEUED");
    expect(n.probe_write(slave, ptr(output), output.length)).toBe(output.length);
    expect(terminal.maintain()).toBe(false);
    expect(terminal.liveText()).not.toContain("QUEUED");
    expect(terminal.read()).toBe(true);
    expect(terminal.liveText()).toContain("QUEUED");
    expect(terminal.maintain()).toBe(false);
  } finally {
    terminal.destroy();
    n.probe_close(slave);
  }
});

test("readiness owns reads across maintenance pause resume and descriptor handoff", async () => {
  const terminal = new Terminal(30, 4),
    fds = new Int32Array(2);
  expect(n.probe_pty(ptr(fds))).toBe(0);
  const [master, slave] = fds;
  let transferred = -1;
  const send = (text: string) => {
    const bytes = Buffer.from(text);
    expect(n.probe_write(slave, ptr(bytes), bytes.length)).toBe(bytes.length);
  };
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 2000;
    let done = ready();
    while (!done && Date.now() < deadline) {
      await Bun.sleep(5);
      done = ready();
    }
    expect(done).toBe(true);
  };
  try {
    terminal.adopt(master, -1);
    send("FIRST");
    await until(() => terminal.liveText().includes("FIRST"));
    const read = spyOn(n, "probe_read");
    try {
      expect(terminal.maintain()).toBe(true);
      expect(terminal.maintain()).toBe(false);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    terminal.pause();
    send("PAUSED");
    expect(terminal.read()).toBe(false);
    expect(terminal.liveText()).not.toContain("PAUSED");
    terminal.resume();
    await until(() => terminal.liveText().includes("PAUSED"));
    expect(terminal.maintain()).toBe(true);
    transferred = terminal.releaseFD();
    expect(transferred).toBe(master);
    send("TRANSFER");
    expect(terminal.read()).toBe(false);
    expect(terminal.liveText()).not.toContain("TRANSFER");
    const bytes = Buffer.alloc(32);
    let used = 0;
    await until(() => {
      const count = n.probe_read(transferred, ptr(bytes.subarray(used)), bytes.length - used);
      if (count > 0) used += count;
      else expect([-11, -35]).toContain(count);
      return used === 8;
    });
    expect(bytes.subarray(0, 8).toString()).toBe("TRANSFER");
  } finally {
    terminal.destroy();
    if (transferred >= 0) n.probe_close(transferred);
    n.probe_close(slave);
    closeReadiness();
  }
});

test("direct flush drains backpressure without reordering input or terminal replies", () => {
  const terminal = new Terminal(20, 4),
    fds = new Int32Array(2);
  expect(n.probe_pair(ptr(fds))).toBe(0);
  const [writer, reader] = fds;
  n.probe_nonblock(writer);
  n.probe_nonblock(reader);
  terminal.fd = writer;
  symbols.app_terminal_fd(terminal.handle, writer, -1);
  try {
    const chunk = "x".repeat(65536);
    let input = "";
    for (let i = 0; i < 256 && terminal.pendingBytes === 0; i++) {
      terminal.send(chunk);
      input += chunk;
    }
    expect(terminal.pendingBytes).toBeGreaterThan(0);
    terminal.feed("\x1b[5n");
    terminal.send("last");
    const expected = input + "\x1b[0nlast",
      buffer = Buffer.alloc(65536),
      chunks: Buffer[] = [];
    let total = 0;
    for (let i = 0; i < 512 && total < expected.length; i++) {
      const count = n.probe_read(reader, ptr(buffer), buffer.length);
      if (count > 0) {
        chunks.push(Buffer.from(buffer.subarray(0, count)));
        total += count;
      } else expect([-11, -35]).toContain(count);
      terminal.flush();
    }
    expect(Buffer.concat(chunks).toString()).toBe(expected);
    expect(terminal.pendingBytes).toBe(0);
    terminal.flush();
  } finally {
    terminal.destroy();
    n.probe_close(reader);
  }
});
