import { expect, test } from "bun:test";
import * as markup from "./trick_markup";
import * as tricks from "./tricks";
import * as ui from "./trick_ui";
import { Writer } from "./text";

test("inline markup draws emphasis, literal code and bundled icons", () => {
  const spans = markup.parse("**Ready** *now* `!(brand:claude)` !(brand:claude)");
  expect(spans).toEqual([
    { text: "Ready", bold: true },
    { text: " " },
    { text: "now", italic: true },
    { text: " " },
    { text: "!(brand:claude)", color: "muted" },
    { text: " " },
    { text: "*", icon: "claude", color: { brand: "claude" } },
  ]);
  expect(tricks.views([{ kind: "decorate", surface: "popover", suffix: spans }])).toHaveLength(1);
  const w = new Writer();
  ui.write(w, spans, 80);
  expect(w.s).toContain("\x1b[1m");
  expect(w.s).toContain("\x1b[3m");
  expect(w.s).toEndWith("\x1b[22;23m");
});

test("unknown markup stays literal and escaped metadata cannot insert formatting or controls", () => {
  const literal = "**unfinished !(https://example.com/icon.svg) <b>hello</b>";
  expect(markup.parse(literal)).toEqual([{ text: literal }]);
  const name = "**name** !(brand:claude) \\ `x`\n\x1b";
  expect(markup.parse(markup.escape(name))).toEqual([{ text: name.replace(/[\n\x1b]/g, " ") }]);
  expect(markup.parse("!(unknown) !(provider:pi)")).toEqual([{ text: "?" }, { text: " " }, { text: "π" }]);
});

test("markup and wire styles have bounded lengths and reject terminal controls", () => {
  for (const text of ["x\x1b[2J", "x\n", "x\u009b", "x\u2028"])
    expect(() => markup.parse(text)).toThrow("ControlCharacter");
  expect(() => markup.parse("猫".repeat(171))).toThrow("InvalidString");
  expect(() => markup.parse("**x** ".repeat(9))).toThrow("InvalidSpans");
  expect(() => tricks.view({ kind: "decorate", suffix: [{ text: "x", bold: "yes" }] })).toThrow("InvalidStyle");
  expect(() => tricks.view({ kind: "decorate", surface: "terminal" })).toThrow("InvalidSurface");
});
