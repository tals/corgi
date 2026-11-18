import { test, expect } from "bun:test";
import { Parser } from "./machine_input";

test("Escape and pasted controls preserve paste boundaries at every split", () => {
  const payload = "hello\x1d\x1b[200~\x1b[20\x1b[0n\x1b",
    paste = `\x1b[200~${payload}\x1b[201~`,
    data = Buffer.from(`\x1b${paste}\x1d`);
  for (let split = 0; split <= data.length; split++) {
    const parser = new Parser(),
      inputs = [...parser.feed(data.subarray(0, split), 0), ...parser.feed(data.subarray(split), 1)];
    expect(inputs[0]).toEqual({ bytes: Uint8Array.of(27), paste: false });
    expect(inputs.at(-1)).toEqual({ bytes: Uint8Array.of(29), paste: false });
    expect(inputs.slice(1, -1).every(input => input.paste)).toBe(true);
    expect(Buffer.concat(inputs.slice(1, -1).map(input => Buffer.from(input.bytes))).toString()).toBe(paste);
  }
});

test("pasted Escape and a delayed terminator do not hold later shortcuts", () => {
  const parser = new Parser(),
    data = Buffer.from("\x1b[200~hello\x1b\x1b[201~"),
    inputs = [
      ...parser.feed(Buffer.from("\x1b[200~"), 0),
      ...[...Buffer.from("hello\x1b\x1b[201~")].flatMap((byte, i) => [
        ...parser.feed(Uint8Array.of(byte), i * 200),
        ...parser.expire(i * 200 + 100),
      ]),
    ];
  expect(inputs.every(input => input.paste)).toBe(true);
  expect(Buffer.concat(inputs.map(input => Buffer.from(input.bytes)))).toEqual(data);
  expect(parser.feed(Uint8Array.of(29))).toEqual([{ bytes: Uint8Array.of(29), paste: false }]);
});

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
