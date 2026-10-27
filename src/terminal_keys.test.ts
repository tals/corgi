import { test, expect } from "bun:test";
import { keys, incomplete } from "./terminal_keys";

test("a read that ends inside a key or a paste is cut before it", () => {
  expect(incomplete("abc")).toBe(3);
  expect(incomplete("ab\x1b")).toBe(2);
  expect(incomplete("ab\x1b[")).toBe(2);
  expect(incomplete("ab\x1bO")).toBe(2);
  expect(incomplete("q\x1b[<0;5;3")).toBe(1);
  expect(incomplete("\x1b[1;5")).toBe(0);
  expect(incomplete("\x1b[Aq")).toBe(4);
  expect(incomplete("\x1b[<0;5;3M")).toBe(9);
  expect(incomplete("x\x1b[200~pas")).toBe(1);
  expect(incomplete("\x1b[200~pasted\x1b[201~y")).toBe(19);
  // The rest, once it arrives, makes the key the read split.
  const first = "m\x1b[",
    cut = incomplete(first);
  expect(keys(first.slice(0, cut))).toEqual([{ kind: "text", text: "m" }]);
  expect(keys(first.slice(cut) + "B")).toEqual([{ kind: "down" }]);
});

test("clicks and wheel notches come from SGR mouse reports", () => {
  expect(keys("\x1b[<0;5;3M\x1b[<0;5;3m")).toEqual([{ kind: "click", x: 4, y: 2 }]);
  expect(keys("\x1b[<64;10;3M\x1b[<65;1;1M")).toEqual([
    { kind: "wheel", dir: 1, x: 9, y: 2 },
    { kind: "wheel", dir: -1, x: 0, y: 0 },
  ]);
  expect(keys("\x1b[<2;5;3M\x1b[<35;5;3M")).toEqual([]);
});

test("named keys, text and pastes", () => {
  expect(keys("\x1b[5~\x1b[6~\x1b[A\x1bOB\r\t\x7f\x03")).toEqual([
    { kind: "pageup" },
    { kind: "pagedown" },
    { kind: "up" },
    { kind: "down" },
    { kind: "enter" },
    { kind: "tab" },
    { kind: "backspace" },
    { kind: "cancel" },
  ]);
  expect(keys("q\x1b[200~pasted\x1b[201~\x1b")).toEqual([
    { kind: "text", text: "q" },
    { kind: "text", text: "pasted" },
    { kind: "esc" },
  ]);
  expect(keys("\x1b[1;5Cx")).toEqual([{ kind: "text", text: "x" }]);
  // Ctrl and a letter, for vi-style paging.
  expect(keys("\x04\x15\x06\x02")).toEqual(["d", "u", "f", "b"].map(key => ({ kind: "ctrl", key })));
  // SS3 keys without a name (F1 here) are skipped whole, not read as Esc.
  expect(keys("\x1bOPx")).toEqual([{ kind: "text", text: "x" }]);
});
