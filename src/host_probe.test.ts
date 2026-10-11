import { test, expect } from "bun:test";
import { Probe } from "./host_probe";
function fragmented(p: Probe, bytes: string) {
  return Buffer.concat(Array.from(Buffer.from(bytes), byte => p.feed(Buffer.from([byte])))).toString();
}
test("host color probe separates fragmented replies from keys and paste", () => {
  const p = new Probe();
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
  const p = new Probe();
  expect(fragmented(p, "a\x1b[?997;1nb")).toBe("ab");
  expect(p.scheme_changed).toBe(true);
});
test("frame status answers are consumed across fragments but not inside pasted text", () => {
  const p = new Probe();
  p.pacer.stamp(0);
  expect(fragmented(p, "a\x1b[0nb")).toBe("ab");
  expect(p.pacer.stamp(10)).not.toBe("");
  expect(fragmented(p, "\x1b[3~")).toBe("\x1b[3~");
  const pasted = "\x1b[200~\x1b[0n\x1b[201~";
  expect(p.feed(pasted).toString()).toBe(pasted);
  expect(p.pacer.unanswered()).toBe(true);
});
test("badge replies are consumed across fragments but not inside pasted text", () => {
  const p = new Probe(),
    reply = "\x1b_Gi=730031;OK\x1b\\";
  expect(fragmented(p, "x" + reply + "y")).toBe("xy");
  expect(p.badge.status).toBe("supported");
  const pasted = "\x1b[200~" + reply + "\x1b[201~";
  expect(p.feed(pasted).toString()).toBe(pasted);
});
test("graphics replies never leak into input and only matching IDs confirm the badge", () => {
  const p = new Probe();
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
  const p = new Probe();
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
