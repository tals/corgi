import { test, expect } from "bun:test";
import { Parser, pasting, type Input } from "./terminal_input";

const text = (events: Input[]) => Buffer.concat(events.map(event => event.bytes)).toString();
function normalized(events: Input[]): object[] {
  const result: Input[] = [];
  for (const event of events) {
    const last = result.at(-1);
    if (last?.kind === event.kind && (event.kind === "text" || event.kind === "paste"))
      last.bytes = Buffer.concat([last.bytes, event.bytes]);
    else result.push({ ...event });
  }
  return result.map(event => ({ ...event, bytes: Array.from(event.bytes) }));
}

test("framing is independent of every pair of read boundaries", () => {
  for (const value of [
    "hé🐶\x1b[A\x1bb\x1bé\x1b\r\x1bOB",
    "\x1b\x1b[0n\x1b[\x1b[0nx",
    "\x1b]5522;data\x1b\\x\x1b]11;rgb:1/2/3\x07",
    "\x1bP>|ghostty\x1b\\\x1b_Gi=1;OK\x1b\\\x1b[?1;2$y",
    "\x1b[200~hé🐶\x1b[0n\x1b[200~\x1b\x1b[201~x",
    "\x1b[<0;10;5M\x1b[<0;10;5m\x1b[27u",
  ]) {
    const bytes = Buffer.from(value),
      expected = normalized(new Parser().feed(bytes, 0));
    for (let first = 0; first <= bytes.length; first++) {
      for (let second = first; second <= bytes.length; second++) {
        const parser = new Parser();
        expect(
          normalized([
            ...parser.feed(bytes.subarray(0, first), 0),
            ...parser.feed(bytes.subarray(first, second), 1),
            ...parser.feed(bytes.subarray(second), 2),
          ]),
        ).toEqual(expected);
      }
    }
  }
});

test("legacy Alt introducers survive a following reply and expire only once", () => {
  for (const prefix of ["\x1b", "\x1b[", "\x1bO", "\x1b]", "\x1bP", "\x1b_"]) {
    const parser = new Parser();
    const first = parser.feed(Buffer.from(prefix), 0);
    expect(first).toEqual([]);
    const events = parser.feed(Buffer.from("\x1b[0n"), 1);
    expect(events[0]).toMatchObject({ kind: "key" });
    expect(text(events)).toBe(prefix + "\x1b[0n");
    expect(events.at(-1)?.kind).toBe("sequence");
    expect(parser.expire(1000)).toEqual([]);
  }
});

test("sequence and UTF-8 fragments outlive the short Escape window", () => {
  for (const [head, tail] of [
    ["\x1b[0", "n"],
    ["\x1b[<0;1", ";1M"],
    ["\x1b]11;", "rgb:1/2/3\x07"],
  ]) {
    const parser = new Parser();
    expect(parser.feed(Buffer.from(head), 0)).toEqual([]);
    expect(parser.expire(100)).toEqual([]);
    expect(text(parser.feed(Buffer.from(tail), 200))).toBe(head + tail);
  }
  const parser = new Parser(),
    bytes = Buffer.from("é");
  expect(parser.feed(bytes.subarray(0, 1), 0)).toEqual([]);
  expect(parser.expire(100)).toEqual([]);
  expect(text(parser.feed(bytes.subarray(1), 200))).toBe("é");
});

test("legacy CSI and SS3 introducers survive control and Unicode followers", () => {
  for (const prefix of ["\x1b[", "\x1bO"]) {
    for (const tail of ["\r", "\x03", "\x7f", "é", "🐶"]) {
      const bytes = Buffer.from(prefix + tail);
      for (let split = 0; split <= bytes.length; split++) {
        const parser = new Parser(),
          events = [...parser.feed(bytes.subarray(0, split), 0), ...parser.feed(bytes.subarray(split), 1)];
        expect(events[0]).toMatchObject({ kind: "key", key: { mods: { alt: true } } });
        expect(Buffer.from(events[0].bytes).toString()).toBe(prefix);
        expect(text(events)).toBe(prefix + tail);
      }
    }
  }
});

test("oversized and expired controls drain their tails without becoming keys", () => {
  for (const prefix of ["\x1b[", "\x1b]5522;", "\x1bP>|", "\x1b_G"]) {
    const parser = new Parser(),
      string = prefix !== "\x1b[";
    const events = parser.feed(Buffer.from(prefix + "1".repeat(20000)), 0);
    expect(events).toEqual([]);
    expect(parser.due()).toBe(1000);
    expect(text(parser.feed(Buffer.from((string ? "\x1b\\" : "n") + "x"), 1))).toBe("x");
  }
  const parser = new Parser();
  parser.feed(Buffer.from("\x1b[0"), 0);
  expect(parser.expire(1001)).toEqual([]);
  expect(text(parser.feed(Buffer.from("nkey"), 1100))).toBe("key");
  parser.feed(Buffer.from("\x1b]5522;broken"), 1200);
  parser.expire(12000);
  expect(text(parser.feed(Buffer.from("\x1b[A"), 12001))).toBe("\x1b[A");
});

test("unknown complete sequences retain their bytes", () => {
  const value = "\x1b[123;456z\x1b]52;abc\x07\x1bP0+zxyz\x1b\\";
  const events = new Parser().feed(Buffer.from(value), 0);
  expect(events.every(event => event.kind === "sequence")).toBe(true);
  expect(text(events)).toBe(value);
});

test("an unterminated reply cannot indefinitely consume later typing", () => {
  // Only a clipboard packet may take seconds to arrive; a short reply that lost its end gives up in one.
  for (const [prefix, deadline] of [
    ["\x1b]5522;partial", 10000],
    ["\x1b]11;rgb:1/2", 1000],
    ["\x1b]1", 1000],
    ["\x1bP>|partial", 1000],
    ["\x1bP:", 1000],
    ["\x1b_Gpartial", 1000],
  ] as const) {
    const parser = new Parser();
    expect(parser.feed(Buffer.from(prefix), 0)).toEqual([]);
    for (let now = 100; now < deadline; now += 100) {
      expect(parser.feed(Buffer.from("a"), now)).toEqual([]);
      expect(parser.due()).toBe(deadline);
    }
    expect(parser.expire(deadline)).toEqual([]);
    expect(parser.feed(Buffer.from("late"), deadline + 500)).toEqual([]);
    expect(parser.due()).toBe(deadline + 1000);
    expect(text(parser.feed(Buffer.from("abc\r\x03"), deadline + 1000))).toBe("abc\r\x03");
    expect(parser.due()).toBe(Infinity);
  }
});

test("oversized replies stop draining on a fixed deadline", () => {
  const parser = new Parser();
  parser.feed(Buffer.from("\x1b]5522;" + "x".repeat(20000)), 0);
  expect(parser.feed(Buffer.from("tail"), 999)).toEqual([]);
  expect(text(parser.feed(Buffer.from("typed"), 1000))).toBe("typed");
});

test("legacy Alt string introducers followed by text are keys", () => {
  for (const prefix of ["\x1bP", "\x1b_", "\x1b]"]) {
    const value = prefix + "abc\r\x1b[0n";
    for (let split = 0; split <= value.length; split++) {
      const parser = new Parser(),
        events = [
          ...parser.feed(Buffer.from(value.slice(0, split)), 0),
          ...parser.feed(Buffer.from(value.slice(split)), 1),
        ];
      expect(events[0]).toMatchObject({ kind: "key", key: { mods: { alt: true } } });
      expect(text(events)).toBe(value);
      expect(events.at(-1)?.kind).toBe("sequence");
    }
  }
});

test("Escape and pasted controls preserve paste boundaries at every split", () => {
  const payload = "hello\x1d\x1b[200~\x1b[20\x1b[0n\x1b",
    paste = `\x1b[200~${payload}\x1b[201~`,
    data = Buffer.from(`\x1b${paste}\x1d`);
  for (let split = 0; split <= data.length; split++) {
    const parser = new Parser(),
      inputs = [...parser.feed(data.subarray(0, split), 0), ...parser.feed(data.subarray(split), 1)];
    expect(inputs[0]).toEqual({ kind: "key", bytes: Uint8Array.of(27), key: { codepoint: 27, mods: {} } });
    expect(inputs.at(-1)).toEqual({ kind: "text", bytes: Uint8Array.of(29) });
    expect(inputs.slice(1, -1).every(pasting)).toBe(true);
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
  expect(inputs.every(pasting)).toBe(true);
  expect(Buffer.concat(inputs.map(input => Buffer.from(input.bytes)))).toEqual(data);
  expect(parser.feed(Uint8Array.of(29))).toEqual([{ kind: "text", bytes: Uint8Array.of(29) }]);
});

test("idle viewer polling does not postpone a lone Escape", () => {
  const parser = new Parser();
  expect(parser.feed(Uint8Array.of(27), 100)).toEqual([]);
  parser.feed(new Uint8Array(), 140);
  expect(parser.expire(151)).toEqual([{ kind: "key", bytes: Uint8Array.of(27), key: { codepoint: 27, mods: {} } }]);
});

test("machine shortcuts cannot escape bracketed paste, including split markers", () => {
  const parser = new Parser();
  const inputs = ["\x1b[20", "0~hello\x1d", "\x1b[<0;1;1M", "\x1b[20", "1~\x1d"].flatMap(s =>
    parser.feed(Buffer.from(s)),
  );
  expect(inputs.slice(0, -1).every(pasting)).toBe(true);
  expect(pasting(inputs.at(-1)!)).toBe(false);
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
