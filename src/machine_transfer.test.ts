import * as test from "bun:test";
import * as transfer from "./machine_transfer";

function channel(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(bytes, controller) {
      for (let p = 0; p < bytes.length; p += 7) controller.enqueue(bytes.subarray(p, p + 7));
    },
  });
}
function pair(): [transfer.Transport, transfer.Transport] {
  const a = channel(),
    b = channel();
  return [
    { readable: b.readable, writable: a.writable },
    { readable: a.readable, writable: b.writable },
  ];
}
function sha(bytes: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
const old = Buffer.from("basis data that repeats; ".repeat(5000));
const newer = Buffer.concat([old.subarray(1111), Buffer.from("new bytes"), old.subarray(0, 1111)]);

test.test("generic transport survives fragmentation and output backpressure", async () => {
  const [sender, receiver] = pair(),
    output: Buffer[] = [];
  const [result, applied] = await Promise.all([
    transfer.send(sender, newer, sha(newer)),
    transfer.receive(receiver, old, async bytes => {
      await Bun.sleep(1);
      output.push(Buffer.from(bytes));
    }),
  ]);
  test.expect(Buffer.concat(output)).toEqual(newer);
  test.expect(applied.sha256).toBe(sha(newer));
  test.expect(result.sent_bytes).toBeGreaterThan(0);
  test.expect(result.received_bytes).toBeGreaterThan(0);
  test.expect(Math.max(...output.map(b => b.length))).toBeLessThanOrEqual(65536);
});
test.test("empty file transfer", async () => {
  const [sender, receiver] = pair();
  const empty = Buffer.alloc(0);
  const results = await Promise.all([
    transfer.send(sender, empty, sha(empty)),
    transfer.receive(receiver, old, () => {}),
  ]);
  test.expect(results[1].bytes).toBe(0);
});
test.test("both peers fail when final verification fails", async () => {
  const [sender, receiver] = pair();
  const results = await Promise.allSettled([
    transfer.send(sender, newer, "0".repeat(64)),
    transfer.receive(receiver, old, () => {}),
  ]);
  test.expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
});
test.test("receiver binds the transfer to the expected artifact", async () => {
  const [sender, receiver] = pair();
  const results = await Promise.allSettled([
    transfer.send(sender, newer, sha(newer)),
    transfer.receive(
      receiver,
      old,
      () => {
        throw Error("ShouldNotWrite");
      },
      "0".repeat(64),
    ),
  ]);
  test.expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
  test.expect(results[1].status === "rejected" && results[1].reason.message).toBe("UnexpectedArtifact");
});
test.test("oversized metadata and decompression output are rejected", async () => {
  const frame = (bytes: Uint8Array) => {
    const b = Buffer.alloc(4 + bytes.length);
    b.writeUInt32BE(bytes.length);
    b.set(bytes, 4);
    return b;
  };
  const manifest = frame(
    Buffer.from(JSON.stringify({ version: 1, bytes: 0, block: 32768, sha256: sha(Buffer.alloc(0)) })),
  );
  const oversized = Buffer.from([255, 255, 255, 255]);
  const bomb = Buffer.concat([manifest, frame(Bun.zstdCompressSync(Buffer.alloc(1024 * 1024 + 1)))]);
  for (const bytes of [oversized, bomb]) {
    const transport: transfer.Transport = {
      readable: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      writable: new WritableStream({ write() {} }),
    };
    await test.expect(transfer.receive(transport, old, () => {})).rejects.toThrow();
  }
});
