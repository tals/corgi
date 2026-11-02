import { expect, test } from "bun:test";
import { legacy, tokens } from "./prompt_pane";

const bytes = (text: string) => Buffer.from(text);

test("input splits into keys, sequences, pastes and mouse reports", () => {
  expect(tokens(bytes("hé\x1b[A\x1bb\x1b\r")).tokens).toEqual([
    { kind: "byte", byte: 0x68 },
    { kind: "byte", byte: 0xc3 },
    { kind: "byte", byte: 0xa9 },
    { kind: "sequence", text: "\x1b[A" },
    { kind: "sequence", text: "\x1bb" },
    { kind: "sequence", text: "\x1b\r" },
  ]);
  expect(tokens(bytes("\x1b[200~line one\r\nlíne two\x1b[201~x")).tokens).toEqual([
    { kind: "paste", text: "line one\r\nlíne two" },
    { kind: "byte", byte: 0x78 },
  ]);
  expect(tokens(bytes("\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<65;3;4M\x1b[<35;7;8M")).tokens).toEqual([
    { kind: "mouse", button: 0, x: 9, y: 4, release: false },
    { kind: "mouse", button: 0, x: 9, y: 4, release: true },
    { kind: "mouse", button: 65, x: 2, y: 3, release: false },
    { kind: "mouse", button: 35, x: 6, y: 7, release: false },
  ]);
  expect(tokens(bytes("\x1bOB")).tokens).toEqual([{ kind: "sequence", text: "\x1bOB" }]);
});

test("an unfinished sequence or paste waits for the rest", () => {
  for (const partial of ["\x1b", "\x1b[", "\x1b[1;5", "\x1b[200~half a pas"]) {
    const split = tokens(bytes("a" + partial));
    expect(split.tokens).toEqual([{ kind: "byte", byte: 0x61 }]);
    expect(Buffer.from(split.rest).toString()).toBe(partial);
  }
  const first = tokens(bytes("\x1b[200~abc"));
  expect(tokens([...first.rest, ...bytes("def\x1b[201~")]).tokens).toEqual([{ kind: "paste", text: "abcdef" }]);
});

test("Kitty's key reports reach the card as the viewer passes keys to it, Ctrl+/ included", () => {
  const keys = (text: string) => tokens(bytes(text)).tokens.flatMap(legacy);
  expect(keys("\x1b[47;5u")).toEqual([{ kind: "byte", byte: 0x1f }]);
  expect(keys("\x1b[99;5u")).toEqual([{ kind: "byte", byte: 3 }]);
  expect(keys("\x1b[27u")).toEqual([{ kind: "byte", byte: 0x1b }]);
  expect(keys("\x1b[13;2u")).toEqual([{ kind: "sequence", text: "\x1b\r" }]);
  expect(keys("\x1b[A\x1b[1;5D")).toEqual([
    { kind: "sequence", text: "\x1b[A" },
    { kind: "sequence", text: "\x1b[1;5D" },
  ]);
  expect(keys("a\x1b[<0;10;5M")).toEqual([
    { kind: "byte", byte: 0x61 },
    { kind: "mouse", button: 0, x: 9, y: 4, release: false },
  ]);
});
