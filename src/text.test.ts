import { expect, test } from "bun:test";
import { shortPath } from "./text";

test("a short path keeps its first two components, then its last, then those nearest the last", () => {
  expect(shortPath("./.claude/worktrees/bonus-round", 40)).toBe("./.claude/worktrees/bonus-round");
  expect(shortPath("./.claude/worktrees/bonus-round", 24)).toBe("./.claude/…/bonus-round");
  expect(shortPath("~/src/github.com/acme/billing-service/worktrees/fix-invoice-rounding", 40)).toBe(
    "~/src/…/worktrees/fix-invoice-rounding",
  );
  // An absolute path's top directory is one component.
  expect(shortPath("/tmp/claude-501/worktrees/green-field-dc53", 40)).toBe("/tmp/claude-501/…/green-field-dc53");
  // The second component goes before the last is cut; the last is cut only
  // when nothing else is left.
  expect(shortPath("$TMPDIR/corgi-wt/scroll-fix", 24)).toBe("$TMPDIR/…/scroll-fix");
  expect(shortPath("$TMPDIR/corgi-wt/scroll-fix", 18)).toBe("$TMPDIR/…/scroll-…");
  expect(shortPath("../corgi-remote-input", 18)).toBe("../corgi-remote-i…");
});
