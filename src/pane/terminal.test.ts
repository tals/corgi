import { test, expect } from "bun:test";
import { Terminal, closeReadiness } from "./terminal";
import { Theme } from "../theme";
import { n } from "../native_bridge";
const info = (t: Terminal) => t.native({ op: "info" });
const pending = (t: Terminal) => t.native({ op: "takePending" }) as string;
test("user input and terminal replies share an ordered bounded queue", () => {
  const t = Terminal.create(20, 4);
  try {
    t.send("first");
    t.feed("\x1b[5n");
    t.send("last");
    expect(pending(t)).toBe("first\x1b[0nlast");
    expect(t.pendingBytes).toBe(0);
    t.send("x".repeat(1024 * 1024));
    expect(t.pendingBytes).toBe(1024 * 1024);
    expect(() => t.send("overflow")).toThrow("InputBackpressure");
    expect(t.pendingBytes).toBe(1024 * 1024);
    t.stop();
    expect(t.pendingBytes).toBe(0);
  } finally {
    t.destroy();
  }
});
function terminals(cols: number, rows: number, count: number, body: (ts: Terminal[]) => void) {
  const ts = Array.from({ length: count }, () => Terminal.create(cols, rows));
  try {
    body(ts);
  } finally {
    for (const t of ts) t.destroy();
  }
}
test("Ghostty keeps fragmented escapes, unicode, alternate screen and resize", () =>
  terminals(20, 4, 1, ([t]) => {
    t.feed("hello\x1b[");
    t.feed("2;1Hworld");
    expect(t.text()).toContain("hello");
    expect(t.text()).toContain("world");
    t.feed("\x1b[?1049halt\x1b[?1049l");
    t.resize(30, 5);
    expect(t.text()).toContain("hello");
  }));
test("a program's clipboard copy is kept until passed on, and reads are refused", () =>
  terminals(20, 4, 1, ([t]) => {
    t.feed("\x1b]52;c;Zmlyc3Q=\x07\x1b]52;c;c2Vjb25k\x1b\\");
    expect(t.takeCopied()).toBe("second");
    t.feed("\x1b]52;c;?\x07\x1b]52;s;dGV4dA==\x07\x1b]52;c;\x07");
    expect(t.takeCopied()).toBeNull();
    // The FFI result grows beyond its first buffer without consuming the copy.
    const large = "x".repeat(96 * 1024);
    t.feed(`\x1b]52;c;${Buffer.from(large).toString("base64")}\x07`);
    expect(t.takeCopied()).toBe(large);
    expect(t.takeCopied()).toBeNull();
  }));
test("a paste event's password grants the program one read of the held clipboard", () =>
  terminals(20, 4, 1, ([t]) => {
    t.feed("\x1b[?5522h");
    expect(
      t.pasteEvent([
        { mime: "text/plain", data: "hi" },
        { mime: "image/png", data: "PNG" },
      ]),
    ).toBe(true);
    const event = pending(t);
    expect(event.startsWith("\x1b]5522;type=read:status=OK:pw=")).toBe(true);
    const password = /pw=([^\x1b]+)/.exec(event)![1];
    t.feed("\x1b]5522;type=read;aW1hZ2UvcG5n\x1b\\");
    expect(pending(t)).toContain("status=EPERM");
    const read = `\x1b]5522;type=read:pw=${password}:name=YXBw;aW1hZ2UvcG5n\x1b\\`;
    t.feed(read);
    const data = pending(t);
    expect(data).toContain("status=DATA");
    expect(data).toContain(";UE5H");
    t.feed(read);
    expect(pending(t)).toContain("status=EPERM");
    t.feed("\x1b[?5522l\x1b[?2004h");
    expect(t.pasteEvent([{ mime: "text/plain", data: "hi" }])).toBe(true);
    expect(pending(t)).toBe("\x1b[200~hi\x1b[201~");
  }));
test("synchronized redraw retains completed cells and cursor even during text capture", () =>
  terminals(40, 8, 1, ([t]) => {
    t.feed("\x1b[5;5HREADY\x1b[5;5H\x1b[?25h");
    const before = t.text(),
      cursor = t.surface(0).surface.cursor;
    t.feed("\x1b[?2026");
    t.feed("h\x1b[2;20HMID_SYNC\x1b[2;20H\x1b[?25l");
    expect(t.text()).toBe(before);
    expect(t.surface(0).surface.cursor).toEqual(cursor);
    expect(cursor).not.toBeNull();
    t.feed("\x1b[5;5HDONE_SYNC\x1b[5;5H\x1b[?25h\x1b[?2026");
    t.updateRender();
    expect(t.surface(0).surface.cursor).toEqual(cursor);
    t.feed("l");
    expect(t.text()).toContain("DONE_SYNC");
    expect(t.surface(0).surface.cursor).toEqual(cursor);
  }));
test("unfinished synchronized output expires or releases on process exit", async () => {
  const t = Terminal.create(40, 8);
  try {
    t.feed("\x1b[?2026hTIMEOUT");
    t.read();
    expect(t.vt.modes.get("synchronized_output")).toBe(true);
    await Bun.sleep(Math.max(0, info(t).synchronized_since + 1005 - Date.now()));
    expect(t.read()).toBe(true);
    expect(t.text()).toContain("TIMEOUT");
    t.feed("\x1b[?2026hEXIT");
    t.exited = true;
    expect(t.read()).toBe(true);
    expect(t.vt.modes.get("synchronized_output")).toBe(false);
  } finally {
    t.destroy();
  }
});
test("the daemon tick visits a terminal after output and while it waits on time", () => {
  const t = Terminal.create(40, 8);
  try {
    expect(t.due()).toBe(false);
    t.feed("$ ");
    expect(t.due()).toBe(true);
    t.read();
    expect(t.due()).toBe(false);
    t.feed("\x1b[?2026hHALF");
    t.read();
    expect(t.due()).toBe(true);
    t.feed("\x1b[?2026l");
    t.read();
    expect(t.due()).toBe(false);
    t.prefill("make");
    expect(t.due()).toBe(true);
    // No line editor reads it yet.
    t.read();
    expect(t.due()).toBe(true);
  } finally {
    t.destroy();
  }
});
test("snapshot restores primary history and alternate output without input modes", () =>
  terminals(30, 4, 2, ([old, fresh]) => {
    old.feed("EARLY_HISTORY\r\n1\r\n2\r\n3\r\n4\r\n5\r\n");
    old.feed("\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[31mALT_OUTPUT\x1b[");
    old.stop();
    fresh.feed(old.snapshot());
    fresh.feed("\x1b[0m\r\nNEW_SHELL");
    expect(info(fresh).active_screen).toBe("primary");
    expect(info(fresh).modes.mouse_event).toBe("none");
    expect(fresh.bracketed_paste).toBe(false);
    const before = fresh.surface(0);
    for (const text of ["EARLY_HISTORY", "ALT_OUTPUT", "NEW_SHELL"]) expect(fresh.search(text).offset).not.toBeNull();
    expect(fresh.surface(0)).toEqual(before);
  }));
test("a faded snapshot keeps each style and draws all of it faint", () =>
  terminals(30, 4, 2, ([old, fresh]) => {
    old.feed("\x1b[1;31mRED\x1b[0m PLAIN \x1b[2;22mNORMAL");
    fresh.feed(old.fadedSnapshot());
    const row = fresh.surface(0).surface.lines[0];
    expect(row).toContain("\x1b[1m\x1b[2mRED");
    expect(row).toContain("\x1b[2m PLAIN NORMAL");
    expect(row).toMatch(/38;2;(?!255;255;255)[0-9;]+m\x1b\[1m\x1b\[2mRED/);
  }));
test("a faded snapshot puts back the blank rows and the cursor", () => {
  for (const input of [
    "A\r\nB\r\n",
    "A\r\nB",
    "\x1b[2J\x1b[HTOP\x1b[5;1HBOX\r\n",
    "\x1b[3;4H",
    "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\x1b[2;3H",
  ])
    terminals(20, 6, 2, ([old, fresh]) => {
      old.feed(input);
      fresh.feed(old.fadedSnapshot());
      expect(fresh.liveText()).toBe(old.liveText());
      expect(info(fresh).cursor).toEqual(info(old).cursor);
    });
});
test("terminal reports host colors and keeps application overrides", () =>
  terminals(20, 4, 1, ([t]) => {
    t.feed("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
    expect(pending(t)).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\");
    const theme = new Theme();
    theme.foreground = { r: 220, g: 220, b: 220 };
    theme.background = { r: 30, g: 30, b: 30 };
    theme.palette[2] = { r: 12, g: 200, b: 30 };
    t.applyTheme(theme);
    t.feed("\x1b]10;?\x1b\\\x1b]11;?\x07\x1b]4;2;?\x1b\\");
    expect(pending(t)).toBe(
      "\x1b]10;rgb:dcdc/dcdc/dcdc\x1b\\\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b]4;2;rgb:0c0c/c8c8/1e1e\x1b\\",
    );
    t.feed("\x1b]11;rgb:01/02/03\x1b\\\x1b]4;2;rgb:04/05/06\x1b\\");
    theme.background = { r: 50, g: 50, b: 50 };
    t.applyTheme(theme);
    t.feed("\x1b]11;?\x1b\\\x1b]4;2;?\x1b\\");
    expect(pending(t)).toBe("\x1b]11;rgb:0101/0202/0303\x1b\\\x1b]4;2;rgb:0404/0505/0606\x1b\\");
    t.feed("\x1b]111\x1b\\\x1b]104;2\x1b\\\x1b]11;?\x1b\\\x1b]4;2;?\x1b\\");
    expect(pending(t)).toBe("\x1b]11;rgb:3232/3232/3232\x1b\\\x1b]4;2;rgb:0c0c/c8c8/1e1e\x1b\\");
  }));
test("reap collects the terminal's own shell once and nothing for a stopped one", () =>
  terminals(20, 4, 1, ([t]) => {
    expect(t.reap()).toBe(false);
    const pid = n.probe_fixture_exit(3);
    expect(pid).toBeGreaterThan(0);
    t.pid = pid;
    expect(t.reap()).toBe(true);
    expect(t.exited).toBe(true);
    expect(t.exit_status).toBe(3 << 8);
    expect(t.reap()).toBe(false);
  }));
test("a command exits only once its status arrives, not when its PTY hangs up", async () => {
  const t = new Terminal(20, 4);
  try {
    await t.spawn("/tmp", "", 1, process.execPath, "sleep 0.3; exit 3");
    // Bun learns of the exit on a later turn, so a busy read sees the hang-up first.
    const deadline = Date.now() + 5000;
    while (!t.hung_up && !t.exited && Date.now() < deadline) t.read();
    expect(t.hung_up).toBe(true);
    expect(t.exited).toBe(false);
    while (!t.exited && Date.now() < deadline) await Bun.sleep(10);
    expect(t.exit_status).toBe(3 << 8);
  } finally {
    t.destroy();
    closeReadiness();
  }
});
