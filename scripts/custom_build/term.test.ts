import { expect, test } from "bun:test";
import { link, paint } from "./term";

test("a link is underlined so it looks like one, through any reset inside it, and plain off a terminal", () => {
  expect(link("tals/corgi#5", "https://github.com/tals/corgi/pull/5", true)).toBe(
    "\x1b]8;;https://github.com/tals/corgi/pull/5\x1b\\\x1b[4mtals/corgi#5\x1b[24m\x1b]8;;\x1b\\",
  );
  const painted = `${paint("a", "red", true)}b`;
  expect(link(painted, "https://x", true)).toContain("\x1b[0m\x1b[4mb\x1b[24m");
  expect(link("tals/corgi#5", "https://github.com/tals/corgi/pull/5", false)).toBe("tals/corgi#5");
  expect(link("plain", null, true)).toBe("plain");
});
