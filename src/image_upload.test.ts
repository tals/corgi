import { expect, test } from "bun:test";
import { receive, Receipts, max_bytes } from "./image_upload";

test("upload receipts follow actual remote reads and stay bounded for small chunks", async () => {
  const progress: number[] = [];
  let consumed = 0;
  const bytes = await receive(
    (async function* () {
      for (let i = 0; i < 1025; i++) {
        consumed += 1024;
        yield new Uint8Array(1024).fill(i % 256);
      }
    })(),
    received => {
      expect(received).toBe(consumed);
      progress.push(received);
    },
  );
  expect(progress).toEqual([...Array.from({ length: 17 }, (_, i) => i * 65536), 1049600]);
  expect(bytes.length).toBe(consumed);
  expect(bytes[1024]).toBe(1);
});

test("oversized uploads fail before a success receipt", async () => {
  const progress: number[] = [];
  await expect(
    receive(
      (async function* () {
        yield new Uint8Array(max_bytes + 1);
      })(),
      n => progress.push(n),
    ),
  ).rejects.toThrow("StreamTooLong");
  expect(progress).toEqual([0]);
});

test("fragmented receipts are monotone and legacy helpers remain usable", () => {
  const progress: number[][] = [];
  const receipts = new Receipts(4096, (n, total) => progress.push([n, total]));
  for (const char of 'shell banner\n{"received":0}\n{"received":1024}\n{"received":4096}\n{"path":"/tmp/貼.png"}\n')
    receipts.feed(char);
  expect(progress).toEqual([
    [0, 4096],
    [1024, 4096],
    [4096, 4096],
  ]);
  expect(receipts.finish()).toBe("/tmp/貼.png");
  const legacy = new Receipts(1024, () => {
    throw Error("No receipts from old helper");
  });
  legacy.feed('{"path":"/tmp/image.png"}\n');
  expect(legacy.finish()).toBe("/tmp/image.png");
});

test("malformed and out of range receipts cannot create false progress", () => {
  for (const received of [-1, 1.5, 4097, "50", null]) {
    expect(() => new Receipts(4096).feed(JSON.stringify({ received }) + "\n")).toThrow("InvalidImageProgress");
  }
  const receipts = new Receipts(4096);
  receipts.feed('{"received":2048}\n');
  expect(() => receipts.feed('{"received":1024}\n')).toThrow("InvalidImageProgress");
  expect(() => new Receipts(1).feed("x".repeat(65537))).toThrow("ImageUploadFailed");
  const incomplete = new Receipts(4096);
  incomplete.feed('{"received":4096}\n');
  expect(() => incomplete.finish()).toThrow("ImageUploadFailed");
  const truncated = new Receipts(4096);
  truncated.feed('{"received":1024}\n{"path":"/tmp/image.png"}\n');
  expect(() => truncated.finish()).toThrow("ImageUploadFailed");
});
