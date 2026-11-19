import * as test from "bun:test";
import * as port from "./fast_rsync";
import fixtures from "./fixtures/fast_rsync.json";

test.test("matches fast_rsync WASM and librsync reference bytes", () => {
  for (const fixture of fixtures) {
    const basis = Buffer.from(fixture.basis, "base64"),
      newer = Buffer.from(fixture.newer, "base64");
    const signature = Buffer.from(fixture.signature, "base64"),
      delta = Buffer.from(fixture.delta, "base64");
    test.expect(port.signature(basis, fixture.block)).toEqual(signature);
    test.expect(port.delta(signature, newer)).toEqual(delta);
    test.expect(port.apply(basis, Buffer.from(fixture.cDelta, "base64"), newer.length)).toEqual(newer);
    test.expect(streamed(basis, delta, newer.length, 1)).toEqual(newer);
  }
});
function noise(size: number, seed: number): Buffer {
  const b = Buffer.allocUnsafe(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x;
  }
  return b;
}
function streamed(old: Buffer, patch: Buffer, size: number, chunk: number): Buffer {
  const decoder = new port.Decoder(old, size),
    out: Buffer[] = [];
  for (let p = 0; p < patch.length; p += chunk) out.push(...decoder.write(patch.subarray(p, p + chunk)));
  const result = Buffer.concat(out);
  test.expect(decoder.finish()).toBe(result.length);
  return result;
}
const old = noise(12003, 42);
const cases: [string, Buffer, Buffer][] = [
  ["empty", Buffer.alloc(0), Buffer.alloc(0)],
  ["create", Buffer.alloc(0), old],
  ["delete", old, Buffer.alloc(0)],
  ["tiny", Buffer.from("a"), Buffer.from("xyz")],
  ["unchanged", old, old],
  ["insert", old, Buffer.concat([old.subarray(0, 127), Buffer.from("new bytes"), old.subarray(127)])],
  ["remove middle", old, Buffer.concat([old.subarray(0, 127), old.subarray(655)])],
  ["reorder", old, Buffer.concat([old.subarray(4096), old.subarray(0, 4096)])],
  ["duplicates", Buffer.alloc(12003), Buffer.concat([Buffer.alloc(1024), old, Buffer.alloc(8192)])],
  ["unrelated", old, noise(13000, 84)],
  [
    "collision limit",
    Buffer.alloc(32, 100),
    Buffer.from(
      Array.from({ length: 1100 * 32 }, (_, i) => (i % 32 === 0 || i % 32 === 2 ? 101 : i % 32 === 1 ? 98 : 100)),
    ),
  ],
];
for (const [name, basis, newer] of cases) {
  test.test(`incremental reconstruction: ${name}`, () => {
    for (const block of [1, 31, 256, 8192, 65536]) {
      const sig = port.signature(basis, block),
        patch = port.delta(sig, newer);

      test.expect(streamed(basis, patch, newer.length, 7)).toEqual(newer);
    }
  });
}
test.test("truncated strong hashes reconstruct the target", () => {
  for (const strong of [0, 1, 4, 8, 15, 16]) {
    const sig = port.signature(old, 256, strong);
    const newer = Buffer.concat([old.subarray(100), old.subarray(0, 100)]);
    const patch = port.delta(sig, newer);

    test.expect(port.apply(old, patch, newer.length)).toEqual(newer);
  }
});
test.test("seeded edits cross-apply and tolerate arbitrary transport boundaries", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const basis = noise(seed * 47, seed),
      insertion = noise(seed % 39, seed + 1);
    const cut = Math.floor(basis.length * 0.3),
      end = cut + (seed % 71);
    const newer = Buffer.concat([basis.subarray(0, cut), insertion, basis.subarray(end)]);
    const block = [16, 31, 127, 256][seed % 4];
    const sig = port.signature(basis, block),
      patch = port.delta(sig, newer);

    test.expect(streamed(basis, patch, newer.length, (seed % 17) + 1)).toEqual(newer);
  }
});
test.test("decoding validates truncation, opcodes, limits, trailing data and 64-bit bounds", () => {
  const patch = port.delta(port.signature(old, 256), old);
  for (let n = 0; n < patch.length; n++) test.expect(() => port.apply(old, patch.subarray(0, n), old.length)).toThrow();
  test.expect(() => port.apply(old, patch, old.length - 1)).toThrow();
  test.expect(() => port.apply(old, Buffer.concat([patch, Buffer.from([0])]), old.length)).toThrow();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(port.deltaMagic);
  for (const command of [
    Buffer.from([0xff]),
    Buffer.from([0x45, 0, 0]),
    Buffer.from([0x45, 255, 1]),
    Buffer.from([0x54, ...Array(16).fill(255)]),
    Buffer.from([0x44, ...Array(8).fill(255)]),
  ]) {
    test.expect(() => port.apply(Buffer.alloc(10), Buffer.concat([header, command, Buffer.from([0])]), 100)).toThrow();
  }
  // Non-minimal but valid 64-bit arguments must work too.
  const copy = Buffer.alloc(18);
  copy[0] = 0x54;
  copy.writeBigUInt64BE(1n, 1);
  copy.writeBigUInt64BE(3n, 9);
  test.expect(streamed(old, Buffer.concat([header, copy]), 3, 1)).toEqual(old.subarray(1, 4));
});
test.test("signature parsing rejects malformed inputs", () => {
  for (const sig of [Buffer.alloc(0), Buffer.alloc(12), port.signature(old, 256).subarray(0, -1)])
    test.expect(() => port.delta(sig, old)).toThrow();
  const sig = port.signature(old, 256);
  sig.writeUInt32BE(0, 4);
  test.expect(() => port.delta(sig, old)).toThrow();
  sig.writeUInt32BE(256, 4);
  sig.writeUInt32BE(17, 8);
  test.expect(() => port.delta(sig, old)).toThrow();
});
