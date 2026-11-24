import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, recordingLock, stills } from "./ghostty_screenshot";

/** A 40-cell frame, black but for the given cells. */
function frame(...cells: number[]): Uint8Array {
  const pixels = new Uint8Array(40 * 3);
  for (const cell of cells) pixels.fill(255, cell * 3, cell * 3 + 3);
  return pixels;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("changes", () => {
  test("counts a change of 8 or more cells", async () => {
    const big = frame(...range(0, 8));
    expect(await changes([frame(), frame(), big, big, frame()], 2)).toEqual([0, 2, 4]);
  });

  test("ignores a few cells changing back and forth", async () => {
    const blink = [frame(), frame(1, 2), frame(), frame(3), frame(1, 2), frame(), frame(), frame()];
    expect(await changes(blink, 2)).toEqual([0]);
  });

  test("adds up typing", async () => {
    const typed = range(1, 13).map(n => frame(...range(0, n)));
    expect(await changes([frame(), ...typed], 2)).toEqual([0, 8, 11]);
  });

  test("ends on the last screen when it differs a little", async () => {
    const toggled = frame(5);
    expect(await changes([frame(), frame(), toggled, toggled, toggled, toggled, toggled], 2)).toEqual([0, 5]);
  });
});

describe("stills", () => {
  test("cuts pauses longer than hold down to hold, keeping the lead into the next change", () => {
    expect(stills([0, 30, 300, 315], 60, 15)).toEqual([
      [75, 285],
      [375, null],
    ]);
  });

  test("keeps pauses up to hold", () => {
    expect(stills([0, 60, 120], 60, 15)).toEqual([[180, null]]);
  });

  test("holds a screen that never changes", () => {
    expect(stills([0], 60, 15)).toEqual([[60, null]]);
  });
});

// Owners are told apart by their start time in /proc.
describe.skipIf(process.platform !== "linux")("recordingLock", () => {
  const inSession = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "corgi-recording-lock-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("lets one record command use the session's files at a time", () =>
    inSession(async dir => {
      await recordingLock(dir, async () => {
        await expect(recordingLock(dir, async () => {})).rejects.toThrow(
          "another record start or stop is still running",
        );
      });
      expect(await recordingLock(dir, async () => "next")).toBe("next");
      expect(existsSync(join(dir, "recording.lock"))).toBe(false);
    }));

  test("takes over a lock whose command died", () =>
    inSession(async dir => {
      // The same PID, but started at another time.
      writeFileSync(join(dir, "recording.lock"), JSON.stringify({ pid: process.pid, started: "0" }));
      expect(await recordingLock(dir, async () => "taken")).toBe("taken");
    }));
});
