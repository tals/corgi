import { expect, test } from "bun:test";
import { Writer, shortPath, wrap, displayWidth } from "./text";

test("prose wrapping measures cells and breaks text without spaces", () => {
  expect(wrap("Choose familiar keys.", 16)).toEqual(["Choose familiar", "keys."]);
  expect(wrap("请选择熟悉的快捷键", 8)).toEqual(["请选择熟", "悉的快捷", "键"]);
  expect(wrap("日本語の設定\n한국어 설정", 8)).toEqual(["日本語の", "設定", "한국어", "설정"]);
  expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  expect(wrap("字", 1)).toEqual(["…"]);
  expect(wrap("one\n\ntwo", Infinity)).toEqual(["one", "", "two"]);
  for (const line of wrap("日本語 and 한국어", 8)) expect(displayWidth(line)).toBeLessThanOrEqual(8);
});

test("positioned output scopes columns without changing buffer ownership", () => {
  const writer = new Writer();
  writer.write(writer.cup(2, 3) + "outside");
  writer.withColumns(4, () => {
    writer.write(writer.cup(2, 3) + "inside");
    writer.withColumns(2, () => writer.write(writer.cup(3, 1)));
    const faded = new Writer(writer.column);
    faded.write(faded.cup(4, 2) + "temporary");
    writer.write(faded.buffered());
    writer.splat(".", 2);
  });
  writer.write(writer.cup(5, 1));
  expect(writer.buffered()).toBe("\x1b[2;3Houtside\x1b[2;7Hinside\x1b[3;7H\x1b[4;6Htemporary..\x1b[5;1H");
  expect(writer.column).toBe(0);
  writer.withColumns(3, () => {
    writer.clear();
    writer.write(writer.cup(1, 1));
  });
  expect(writer.s).toBe("\x1b[1;4H");
  expect(writer.column).toBe(0);
});

test("positioned output restores the origin when drawing throws", () => {
  const writer = new Writer(7);
  expect(() =>
    writer.withColumns(3, () => {
      writer.write(writer.cup(1, 1));
      throw Error("InterruptedDraw");
    }),
  ).toThrow("InterruptedDraw");
  expect(writer.column).toBe(7);
  writer.write(writer.cup(2, 1));
  expect(writer.s).toBe("\x1b[1;11H\x1b[2;8H");
});

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
