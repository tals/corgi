import { test, expect } from "bun:test";
import * as wav from "./wav";

test("encode writes a mono 16-bit RIFF header and the samples", () => {
  const out = wav.encode(Int16Array.of(1, -2, 32767)),
    view = new DataView(out.buffer),
    text = (at: number) => String.fromCharCode(...out.subarray(at, at + 4));
  expect(out.length).toBe(44 + 6);
  expect(text(0)).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(36 + 6);
  expect(text(8)).toBe("WAVE");
  expect(text(12)).toBe("fmt ");
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(28, true)).toBe(32000);
  expect(view.getUint16(32, true)).toBe(2);
  expect(view.getUint16(34, true)).toBe(16);
  expect(text(36)).toBe("data");
  expect(view.getUint32(40, true)).toBe(6);
  expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([1, -2, 32767]);
  expect(new DataView(wav.encode(new Int16Array(0), 8000).buffer).getUint32(24, true)).toBe(8000);
});
