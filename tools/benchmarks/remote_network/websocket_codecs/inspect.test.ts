import { expect, test } from "bun:test";
import { Inspect } from "./inspect";

test("wire observer parses split HTTP, masked hello and compressed binary frames", () => {
  const observer = new Inspect(),
    hello = Buffer.from('{"op":"hello","accept_encoding":["zstd"]}\n'),
    mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([Buffer.from([130, 128 | hello.length]), mask, hello]);
  for (let i = 0; i < hello.length; i++) frame[6 + i] ^= mask[i % 4];
  const wire = Buffer.concat([
    Buffer.from("GET /rpc HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"),
    frame,
    Buffer.from([194, 3, 0, 1, 2]),
  ]);
  for (const byte of wire) observer.read(Buffer.from([byte]));
  const result = observer.result();
  expect(result.bytes).toBe(wire.length);
  expect(result.payload).toBe(hello.length + 3);
  expect(result.frames).toBe(2);
  expect(result.compressed).toBe(1);
  expect(result.masked).toBe(1);
  expect(result.hello).toEqual({ op: "hello", accept_encoding: ["zstd"] });
  expect(result.incomplete).toBe(0);
});
