import { test, expect } from "bun:test";
import * as terminal_info from "./terminal_info";
function fragmented(p: terminal_info.Probe, bytes: string) {
  return Buffer.concat(Array.from(Buffer.from(bytes), byte => p.feed(Buffer.from([byte])))).toString();
}
test("host color probe separates fragmented replies from keys and paste", () => {
  const p = new terminal_info.Probe();
  expect(fragmented(p, "hi\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\\x1b]11;rgb:12/34/56\x07\x1b]4;2;rgb:1/2/3\x07!")).toBe(
    "hi!",
  );
  expect(p.theme.foreground).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  expect(p.theme.background).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
  expect(p.theme.palette[2]).toEqual({ r: 0x11, g: 0x22, b: 0x33 });
  const paste = "\x1b[200~\x1b]11;rgb:ff/ff/ff\x07\x1b[201~";
  expect(fragmented(p, paste)).toBe(paste);
  expect(p.theme.background?.r).toBe(0x12);
  const unknown = "\x1b[A\x1b]11;broken\x07\x1b]52;abc\x07";
  expect(p.feed(unknown).toString()).toBe(unknown);
  expect(p.feed("\x1b").length).toBe(0);
  expect(p.expire(p.touched + 101).toString()).toBe("\x1b");
});
test("a color scheme report is consumed and asks for the colors again", () => {
  const p = new terminal_info.Probe();
  expect(fragmented(p, "a\x1b[?997;1nb")).toBe("ab");
  expect(p.scheme_changed).toBe(true);
});
test("frame status answers are consumed across fragments but not inside pasted text", () => {
  const p = new terminal_info.Probe();
  p.pacer.stamp(0);
  expect(fragmented(p, "a\x1b[0nb")).toBe("ab");
  expect(p.pacer.stamp(10)).not.toBe("");
  expect(fragmented(p, "\x1b[3~")).toBe("\x1b[3~");
  const pasted = "\x1b[200~\x1b[0n\x1b[201~";
  expect(p.feed(pasted).toString()).toBe(pasted);
  expect(p.pacer.unanswered()).toBe(true);
});
test("badge replies are consumed across fragments but not inside pasted text", () => {
  const p = new terminal_info.Probe(),
    reply = "\x1b_Gi=730031;OK\x1b\\";
  expect(fragmented(p, "x" + reply + "y")).toBe("xy");
  expect(p.badge.status).toBe("supported");
  const pasted = "\x1b[200~" + reply + "\x1b[201~";
  expect(p.feed(pasted).toString()).toBe(pasted);
});
test("graphics replies never leak into input and only matching IDs confirm the badge", async () => {
  const p = new terminal_info.Probe();
  p.badge.accept("\x1b_Gi=730031;OK\x1b\\");
  p.badge.upload(0, { width: 9, height: 18 });
  await p.badge.loading;
  p.badge.upload(0, { width: 9, height: 18 });
  p.badge.status = "confirming";
  const wrong = "\x1b_Gi=0;OK\x1b\\",
    reply = "\x1b_Gp=1,i=730031;OK\x1b\\";
  expect(fragmented(p, "x" + wrong + "y")).toBe("xy");
  expect(p.badge.status).toBe("confirming");
  expect(fragmented(p, reply + "z")).toBe("z");
  expect(p.badge.mode()).toBe("image");
  expect(p.badge.supports_kitty_graphics).toBe(true);
  const pasted = "\x1b[200~" + wrong + "\x1b[201~";
  expect(fragmented(p, pasted)).toBe(pasted);
});
test("clipboard packets and their questions' answers never reach the keys", () => {
  const p = new terminal_info.Probe();
  p.clipboard.start(Date.now());
  p.clipboard.takeOutput();
  const replies =
    "a\x1bP>|ghostty 1.3.2\x1b\\b\x1b[?5522;2$yc\x1b]5522;type=read:status=OK:id=corgi-probe\x07\x1b]5522;type=read:status=DATA:id=corgi-probe:mime=Lg==;aW1hZ2UvcG5nCg==\x1b\\\x1b]5522;type=read:status=DONE:id=corgi-probe\x1b\\d";
  expect(fragmented(p, replies)).toBe("abcd");
  expect(p.clipboard.terminal.text()).toBe("ghostty 1.3.2");
  expect(p.clipboard.support).toBe("on");
  const long = "\x1b]5522;type=read:status=DATA:id=x;" + "A".repeat(600) + "\x1b\\";
  expect(p.feed("e" + long + "f").toString()).toBe("ef");
  expect(p.feed("\x1b]5522;type=read\x1b[A").toString()).toBe("\x1b[A");
  const pasted = "\x1b[200~\x1b]5522;type=read:status=OK\x07\x1b[?5522;1$y\x1b[201~";
  expect(p.feed(pasted).toString()).toBe(pasted);
});

test("Moonlander image replies reach the viewer across fragments and stay out of keys and pastes", () => {
  const p = new terminal_info.Probe(),
    reply = "\x1b_Gi=730202;OK\x1b\\";
  expect(fragmented(p, "x" + reply + "y")).toBe("xy");
  expect(p.graphics).toEqual([reply]);
  const paste = "\x1b[200~" + reply + "\x1b[201~";
  expect(fragmented(p, paste)).toBe(paste);
  expect(p.graphics).toEqual([reply]);
});

const pty = { cols: 100, rows: 30, width: 900, height: 540 };
const missing = { ...pty, width: 0, height: 0 };

test("a terminal snapshot keeps the probe data unchanged for other clients", async () => {
  const p = new terminal_info.Probe();
  p.measure(30);
  p.feed("\x1b[6;18;9t\x1b[?62c");
  const snapshot = await p.snapshot(
    { source: "viewer", cols: 100, rows: 30, pty, used: { width: 9, height: 18 } },
    { TERM: "xterm-kitty", UNRELATED_SECRET: "omit" },
  );
  expect(snapshot.info).toBe(p.info);
  expect(snapshot.env).toEqual({ TERM: "xterm-kitty" });
  expect(snapshot).not.toHaveProperty("answers");
  const received = JSON.parse(JSON.stringify(snapshot));
  expect(received.info).toEqual(p.info);
  expect(received.info.replies[0]).toBe("\x1b[6;18;9t");
  expect(received.info.widths[0]).toEqual({ kind: "emoji", text: "👍", sequence: false, columns: null });
});

test("terminal measurements expose parsed data without a report consumer", () => {
  const p = new terminal_info.Probe();
  p.measure(30);
  const paste = "\x1b[200~\x1b[?2026;1$y\x1b[201~";
  expect(fragmented(p, "a\x1b[30;2R" + paste + "\x1b[30;3Rb")).toBe("a" + paste + "b");
  expect(fragmented(p, "\x1b[?2026;2$y\x1b[?0u\x1b[4;600;800t\x1b[6;20;10t\x1bP1+r536d756c78=31\x1b\\\x1b[?62c")).toBe(
    "",
  );
  expect(p.info.status).toBe("done");
  expect(p.info.answered).toBe(true);
  expect(p.info.widths.slice(0, 2).map(sample => sample.columns)).toEqual([1, 2]);
  expect(p.info.modes).toEqual({ "2026": 2 });
  expect(p.info.keyboard).toBe(0);
  expect(p.info.window).toEqual({ width: 800, height: 600 });
  expect(p.info.cell).toEqual({ width: 10, height: 20 });
  expect(p.info.capabilities).toEqual({ Smulx: "1" });
  expect(p.info.replies[0]).toBe("\x1b[30;2R");
  expect(p.info.replies).not.toContain("\x1b[?2026;1$y");
});

test("cell pixels use a direct answer over PTY metadata, with independent fallbacks", () => {
  const size = new terminal_info.Size();
  expect(size.update(pty)).toBe("\x1b[14t\x1b[16t");
  expect(size.pixels(pty)).toEqual({ width: 9, height: 18 });
  expect(size.pixels(missing)).toBeNull();
  size.accept("\x1b[4;600;1000t");
  expect(size.pixels(missing)).toEqual({ width: 10, height: 20 });
  size.accept("\x1b[6;22;11t");
  expect(size.pixels(pty)).toEqual({ width: 11, height: 22 });
  expect(size.pixels(null)).toEqual({ width: 11, height: 22 });
  for (const reply of ["\x1b[6;0;0t", "\x1b[6;999999999999999999;9t"]) {
    size.accept(reply);
    expect(size.pixels(pty)).toEqual({ width: 9, height: 18 });
  }
});

test("resizing discards old query measurements and asks again even with unchanged PTY metadata", () => {
  const size = new terminal_info.Size();
  size.update(missing);
  size.accept("\x1b[6;18;9t");
  expect(size.update(missing)).toBe("");
  expect(size.update(missing, true)).toBe("\x1b[14t\x1b[16t");
  expect(size.pixels(missing)).toBeNull();
  size.accept("\x1b[6;36;18t");
  expect(size.pixels(missing)).toEqual({ width: 18, height: 36 });
  expect(size.update({ ...missing, cols: 50 })).toBe("\x1b[14t\x1b[16t");
  expect(size.pixels(missing)).toBeNull();
});

test("size queries compare owned dimensions, including missing and mutated metadata", () => {
  const size = new terminal_info.Size(),
    current = { ...pty },
    query = "\x1b[14t\x1b[16t";
  expect(size.update(null)).toBe(query);
  expect(size.update(null)).toBe("");
  expect(size.update(current)).toBe(query);
  expect(size.update({ height: current.height, width: current.width, rows: current.rows, cols: current.cols })).toBe(
    "",
  );
  for (const field of ["cols", "rows", "width", "height"] as const) {
    size.accept("\x1b[6;22;11t");
    current[field] += 1;
    expect(size.update(current)).toBe(query);
    expect(size.pixels(null)).toBeNull();
    expect(size.update({ ...current })).toBe("");
  }
  expect(size.update(null)).toBe(query);
  expect(size.update(null)).toBe("");
});

test("a terminal that never answers measurement queries holds input only until it gives up", () => {
  const p = new terminal_info.Probe(),
    now = Date.now();
  p.measure(30, now);
  expect(p.feed("x\x1b[?1;2$y").toString()).toBe("x");
  p.expire(now + 5001);
  expect(p.info.status).toBe("done");
  expect(p.info.answered).toBe(false);
  // Answers that come late are dropped, not typed into a pane, and not
  // recorded; a modified F3 still reads as a key.
  expect(fragmented(p, "a\x1b[30;3R\x1b[?2026;2$y\x1b[1;5Rb\x1bP1+r536d756c78=31\x1b\\")).toBe("a\x1b[1;5Rb");
  expect(p.info.widths[0].columns).toBeNull();
  expect(p.info.modes).toEqual({ "1": 2 });
  // The device attributes, asked last, end the wait.
  expect(fragmented(p, "\x1b[?62c")).toBe("");
  expect(p.feed("\x1b[30;3R").toString()).toBe("\x1b[30;3R");
});

test("late and fragmented size replies reach rendering without becoming pane input", () => {
  const probe = new terminal_info.Probe(),
    missing = { cols: 100, rows: 30, width: 0, height: 0 };
  probe.size.update(missing);
  probe.measure(30);
  probe.feed("\x1b[?62c");
  expect(probe.info.status).toBe("done");
  const output = [...Buffer.from("a\x1b[6;18;9tb")].map(byte => probe.feed(Buffer.from([byte])));
  expect(Buffer.concat(output).toString()).toBe("ab");
  expect(probe.size.pixels(missing)).toEqual({ width: 9, height: 18 });
  const paste = "\x1b[200~\x1b[6;36;18t\x1b[201~";
  expect(probe.feed(paste).toString()).toBe(paste);
  expect(probe.size.pixels(missing)).toEqual({ width: 9, height: 18 });
  expect(probe.feed("\x1b[4;2~").toString()).toBe("\x1b[4;2~");
});
