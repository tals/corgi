import { test, expect } from "bun:test";
import { runPlayer, yip } from "./sound";
test("audio player failures and timeouts are bounded", async () => {
  expect(await runPlayer(["/bin/sh", "-c", "exit 0"], 1_000_000_000)).toBe(true);
  expect(await runPlayer(["/bin/sh", "-c", "exit 1"], 1_000_000_000)).toBe(false);
  expect(await runPlayer(["/nonexistent-corgi-player"], 1_000_000_000)).toBe(false);
  expect(await runPlayer(["/bin/sh", "-c", "exec sleep 5"], 50_000_000)).toBe(false);
});
test("Corgi's yip is a short WAV of its own: two notes for an answer, three when it needs you", () => {
  const answered = yip(false),
    needs = yip(true);
  expect(answered.subarray(0, 4).toString()).toBe("RIFF");
  expect(answered.subarray(8, 16).toString()).toBe("WAVEfmt ");
  expect(answered.readUInt32LE(24)).toBe(22_050);
  expect(answered.readUInt32LE(40)).toBe(answered.length - 44);
  // Three notes take half again as long as two.
  expect((needs.length - 44) / (answered.length - 44)).toBeCloseTo(1.5, 2);
  // Not silent, and never clipped.
  let loudest = 0;
  for (let i = 44; i < answered.length; i += 2) loudest = Math.max(loudest, Math.abs(answered.readInt16LE(i)));
  expect(loudest).toBeGreaterThan(5000);
  expect(loudest).toBeLessThan(32767);
});
