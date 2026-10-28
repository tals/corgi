import { expect, test } from "bun:test";
import * as viewer from "./viewer";

const text = (chunk: Uint8Array) => Buffer.from(chunk).toString();

test("keys that arrive while input is handled reach the next call", async () => {
  const input = [...Buffer.from("t")],
    decoder = new TextDecoder("utf-8", { ignoreBOM: true }),
    seen: string[] = [];
  await viewer.takeInput(input, decoder, async chunk => {
    seen.push(text(chunk));
    // Stdin appends to the same queue while a handler waits on the daemon.
    input.push(...Buffer.from("printf ok\r"));
  });
  await viewer.takeInput(input, decoder, async chunk => void seen.push(text(chunk)));
  expect(seen).toEqual(["t", "printf ok\r"]);
});

test("a split character waits for its last byte and an invalid byte keeps the keys after it", async () => {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true }),
    seen: string[] = [],
    handle = async (chunk: Uint8Array) => void seen.push(text(chunk));
  await viewer.takeInput([0x61, 0xc3], decoder, handle);
  await viewer.takeInput([0xa9], decoder, handle);
  await viewer.takeInput([0x62, 0xff, 0x63, 0x64, 0x65, 0x66], decoder, handle);
  expect(seen).toEqual(["a", "é", "b�cdef"]);
});
