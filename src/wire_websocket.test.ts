import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as websocket from "./wire_websocket";

const upgrade = Buffer.from(
  "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n" +
    `Sec-WebSocket-Protocol: ${websocket.protocol}\r\nSec-WebSocket-Version: 13\r\n` +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
);
function masked(payload: Buffer, opcode = 2, final = true): Buffer {
  const plain = websocket.frame(payload, opcode),
    head = plain.length - payload.length,
    mask = crypto.randomBytes(4),
    out = Buffer.concat([plain.subarray(0, head), mask, payload]);
  out[0] = (final ? 128 : 0) | opcode;
  out[1] |= 128;
  for (let i = 0; i < payload.length; i++) out[head + 4 + i] ^= mask[i & 3];
  return out;
}
function fixture() {
  const writes: Buffer[] = [],
    reads: Buffer[] = [];
  return {
    writes,
    reads,
    server: new websocket.Server(
      bytes => writes.push(bytes),
      bytes => reads.push(bytes),
    ),
  };
}
test("HTTP upgrade and binary messages survive a handoff at every byte boundary", () => {
  const messages = [Buffer.from("first\n"), Buffer.from("second\n")],
    wire = Buffer.concat([upgrade, ...messages.map(value => masked(value))]);
  for (let cut = 0; cut <= wire.length; cut++) {
    const f = fixture();
    f.server.receive(wire.subarray(0, cut));
    const next = new websocket.Server(
      bytes => f.writes.push(bytes),
      bytes => f.reads.push(bytes),
      f.server.save(),
    );
    next.receive(wire.subarray(cut));
    expect(f.reads).toEqual(messages);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].toString()).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n");
    expect(f.writes[0].toString()).not.toContain("Sec-WebSocket-Extensions");
  }
});
test("fragmented messages allow interleaved ping and survive partial-frame handoff", () => {
  const wire = Buffer.concat([
    masked(Buffer.from("first"), 2, false),
    masked(Buffer.from("ping"), 9),
    masked(Buffer.from(" middle"), 0, false),
    masked(Buffer.from(" last\n"), 0),
  ]);
  for (let cut = 0; cut <= wire.length; cut++) {
    const f = fixture();
    f.server.receive(upgrade);
    f.server.receive(wire.subarray(0, cut));
    const next = new websocket.Server(
      bytes => f.writes.push(bytes),
      bytes => f.reads.push(bytes),
      f.server.save(),
    );
    next.receive(wire.subarray(cut));
    expect(f.reads.map(bytes => bytes.toString())).toEqual(["first middle last\n"]);
    expect(f.writes[1]).toEqual(websocket.frame(Buffer.from("ping"), 10));
  }
});
test("list headers may be repeated and an unselected compression extension stays disabled", () => {
  const f = fixture();
  const request = upgrade
    .toString()
    .replace("Connection: keep-alive, Upgrade", "Connection: keep-alive\r\nConnection: Upgrade")
    .replace(
      `Sec-WebSocket-Protocol: ${websocket.protocol}`,
      `Sec-WebSocket-Protocol: other\r\nSec-WebSocket-Protocol: ${websocket.protocol}\r\nSec-WebSocket-Extensions: permessage-deflate`,
    );
  f.server.receive(Buffer.from(request));
  expect(f.writes[0].toString()).toContain("101 Switching Protocols");
  expect(f.writes[0].toString()).not.toContain("Sec-WebSocket-Extensions");
});
test.each([0, 125, 126, 65535, 65536, 1024 * 1024])("binary length %s survives byte-stream fragmentation", size => {
  const f = fixture(),
    payload = crypto.randomBytes(size),
    wire = masked(payload);
  f.server.receive(upgrade);
  for (let offset = 0; offset < wire.length; offset += 4093) f.server.receive(wire.subarray(offset, offset + 4093));
  expect(f.reads).toEqual([payload]);
});
test.each([
  Buffer.from([0x82, 0]),
  Buffer.from([0xc2, 0x80]),
  Buffer.from([0x80, 0x80]),
  Buffer.from([0x09, 0x80]),
  Buffer.from([0x89, 0xfe]),
  Buffer.from([0x82, 0xfe, 0, 1]),
  Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0, 0, 1]),
  Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x80, 0, 0]),
  masked(Buffer.from([0]), 8),
  masked(Buffer.from([3, 237]), 8),
  masked(Buffer.from([3, 232, 255]), 8),
  masked(Buffer.from("text"), 1),
])("invalid frames fail before reaching RPC: %s", wire => {
  const f = fixture();
  f.server.receive(upgrade);
  expect(() => f.server.receive(wire)).toThrow();
  expect(f.reads).toHaveLength(0);
});
test("fragmented message size is bounded across frames", () => {
  const f = fixture();
  f.server.receive(upgrade);
  f.server.receive(masked(Buffer.alloc(websocket.capacity - 16), 2, false));
  expect(() => f.server.receive(masked(Buffer.alloc(17), 0))).toThrow("MessageTooLarge");
});
test("close is echoed once and excludes trailing application messages", () => {
  const f = fixture(),
    close = Buffer.from([3, 232]);
  f.server.receive(upgrade);
  f.server.receive(Buffer.concat([masked(close, 8), masked(Buffer.from("ignored"))]));
  expect(f.writes[1]).toEqual(websocket.frame(close, 8));
  expect(f.reads).toHaveLength(0);
  expect(f.server.closing).toBe(true);
});
test.each([
  ["GET /rpc", "POST /rpc"],
  ["GET /rpc", "GET /other"],
  ["Version: 13", "Version: 12"],
  ["Key: dGhlIHNhbXBsZSBub25jZQ==", "Key: bad"],
  [`Protocol: ${websocket.protocol}`, "Protocol: other"],
  ["Host: localhost", "Host: localhost\r\nContent-Length: 4"],
  ["Host: localhost", "Host: localhost\r\nTransfer-Encoding: chunked"],
  ["Host: localhost", "Host: localhost\r\nHost: duplicate"],
])("invalid upgrades fail: %s → %s", (from, to) => {
  const f = fixture();
  expect(() => f.server.receive(Buffer.from(upgrade.toString().replace(from, to)))).toThrow();
  expect(f.writes).toHaveLength(0);
});
