import { expect, test } from "bun:test";
import * as releaseLabel from "./release_label";

test("a dated release was built when its version says, from its commit", () => {
  const dated = releaseLabel.of("20260925T183012Z-be82c7b9090a", "");
  expect(dated).toEqual({ built_ms: Date.UTC(2026, 8, 25, 18, 30, 12), commit: "be82c7b9090a", dirty: false });
  const full = releaseLabel.of("20260925T183012Z-be82c7b9090a", "be82c7b9090a" + "0".repeat(28));
  expect(full.commit).toHaveLength(40);
});

test("a development build reads as its local build time and commit, marked when dirty", () => {
  const built_at = new Date(2026, 9, 12, 14, 3).toISOString();
  const dirty = releaseLabel.of("0.1.0-dev", "0123abcdef45-dirty", built_at);
  expect(releaseLabel.parts(dirty)).toEqual(["2026-10-12 14:03 · ", "0123abc", "-dirty"]);
  expect(releaseLabel.text(dirty)).toBe("2026-10-12 14:03 · 0123abc-dirty");
  expect(releaseLabel.text(releaseLabel.of("0.1.0-dev", "0123abcdef45"))).toBe("0123abc");
  expect(releaseLabel.text(releaseLabel.of("0.1.0-dev", "development", built_at))).toBe("2026-10-12 14:03");
  expect(releaseLabel.text(releaseLabel.of("0.1.0-dev", "development"))).toBe("");
});
