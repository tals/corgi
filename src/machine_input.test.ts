import { test, expect } from "bun:test";
import { Parser } from "./machine_input";

test("idle viewer polling does not postpone a lone Escape", () => {
  const parser = new Parser();
  expect(parser.feed(Uint8Array.of(27), 100)).toEqual([]);
  parser.feed(new Uint8Array(), 140);
  expect(parser.expire(151)).toEqual([{ bytes: Uint8Array.of(27), paste: false }]);
});

test("machine shortcuts cannot escape bracketed paste, including split markers", () => {
  const parser = new Parser();
  const inputs = ["\x1b[20", "0~hello\x1d", "\x1b[<0;1;1M", "\x1b[20", "1~\x1d"].flatMap(s =>
    parser.feed(Buffer.from(s)),
  );
  expect(inputs.slice(0, -1).every(i => i.paste)).toBe(true);
  expect(inputs.at(-1)?.paste).toBe(false);
  expect(Buffer.concat(inputs.map(i => Buffer.from(i.bytes))).toString()).toBe(
    "\x1b[200~hello\x1d\x1b[<0;1;1M\x1b[201~\x1d",
  );
});

test("a fragmented UTF-8 key or mouse report is routed once", () => {
  const parser = new Parser();
  const input = Buffer.from("🐶\x1b[<0;1;1M");
  const result = [...input].flatMap(byte => parser.feed(Uint8Array.of(byte), 0));
  expect(result.map(i => Buffer.from(i.bytes).toString())).toEqual(["🐶", "\x1b[<0;1;1M"]);
  expect(parser.feed(Buffer.from("\x1b"), 0)).toEqual([]);
  expect(parser.expire(51)[0].bytes).toEqual(Uint8Array.of(27));
});

test("large pastes are bounded into chunks without dropping bytes", () => {
  const value = "\x1b[200~" + "a".repeat(1024 * 1024) + "\x1b[201~";
  const result = new Parser().feed(Buffer.from(value));
  expect(result.length).toBeLessThan(300);
  expect(Buffer.concat(result.map(r => Buffer.from(r.bytes))).toString()).toBe(value);
});
