import { expect, test } from "bun:test";
import { TextArea } from "./text_area";

const at = (text: string, caret = text.length) => Object.assign(new TextArea(text), { caret });

test("typing goes in at the caret and over a selection", () => {
  const a = at("hello world", 5);
  a.insert(",");
  expect(a.text).toBe("hello, world");
  a.move("word_right", true);
  expect(a.selection()).toEqual([6, 12]);
  a.insert(" there");
  expect(a.text).toBe("hello, there");
  expect(a.caret).toBe(12);
});

test("words and lines erase back and forward", () => {
  const a = at("one two  three");
  a.erase("word_back");
  expect(a.text).toBe("one two  ");
  a.erase("word_back");
  expect(a.text).toBe("one ");
  a.caret = 0;
  a.erase("word_forward");
  expect(a.text).toBe(" ");
  const b = at("first\nsecond line", 9);
  b.erase("line_back");
  expect(b.text).toBe("first\nond line");
  // At a line's start, it takes the break and joins the lines.
  b.erase("line_back");
  expect(b.text).toBe("firstond line");
  b.erase("line_forward");
  expect(b.text).toBe("first");
});

test("a selection erases whole, and plain left and right land on its edges", () => {
  const a = at("abcdef", 1);
  a.move("right", true);
  a.move("right", true);
  a.erase("word_back");
  expect(a.text).toBe("adef");
  const b = at("abcdef", 4);
  b.move("left", true);
  b.move("left", true);
  b.move("right");
  expect([b.caret, b.selection()]).toEqual([4, null]);
});

test("lines wrap between words, and up and down follow them", () => {
  const a = at("the quick brown fox jumps");
  a.width = 10;
  expect(a.lines().map(l => a.text.slice(l.start, l.end))).toEqual(["the quick", "brown fox", "jumps"]);
  expect(a.position()).toEqual({ row: 2, col: 5 });
  a.move("up");
  expect(a.position()).toEqual({ row: 1, col: 5 });
  a.move("line_start");
  expect(a.caret).toBe(10);
  a.move("up");
  a.move("line_end");
  expect(a.caret).toBe(9);
  // A word longer than a line breaks inside it.
  expect(at("abcdefghijkl").lines(5).length).toBe(3);
  // Up from the first line goes to the start; down from the last to the end.
  a.move("up");
  expect(a.caret).toBe(0);
  a.move("down");
  a.move("down");
  a.move("down");
  expect(a.caret).toBe(a.text.length);
});

test("a lead shortens only the first line, and clicks and up and down count it as box columns", () => {
  const a = at("the quick brown fox jumps");
  a.width = 10;
  a.lead = 4;
  expect(a.lines().map(l => a.text.slice(l.start, l.end))).toEqual(["the", "quick", "brown fox", "jumps"]);
  // Box column 6 is "e" on the first line, which starts 4 in; below, the
  // short "quick" ends first, and "brown fox" has its "f" there.
  a.place(0, 6);
  expect(a.caret).toBe(2);
  a.move("down");
  expect(a.caret).toBe(9);
  a.move("down");
  expect(a.text[a.caret]).toBe("f");
  // A click in the lead lands on the first line's start.
  a.place(0, 1);
  expect(a.caret).toBe(0);
});

test("a click places the caret on a shown line, and a drag selects", () => {
  const a = at("one\ntwo three");
  a.place(1, 2);
  expect(a.caret).toBe(6);
  a.place(1, 7, true);
  expect(a.selection()).toEqual([6, 11]);
  a.place(9, 0);
  expect(a.caret).toBe(a.text.length);
});

test("characters outside the basic plane move and erase whole", () => {
  const a = at("a😀b", 3);
  a.move("left");
  expect(a.caret).toBe(1);
  a.caret = 3;
  a.erase("back");
  expect(a.text).toBe("ab");
});

test("edits by name: select all, cut, and newlines only where lines break", () => {
  const a = new TextArea("one two");
  a.apply("select_all");
  expect(a.selectedText()).toBe("one two");
  a.apply("select_word_left");
  expect(a.selectedText()).toBe("one ");
  a.apply("cut");
  expect(a.text).toBe("two");
  a.apply("newline");
  expect(a.text).toBe("\ntwo");
  const single = new TextArea("a long single line that would wrap", false);
  single.width = 5;
  expect(single.lines().length).toBe(1);
  single.apply("newline");
  single.apply("line_start");
  expect([single.text.includes("\n"), single.caret]).toEqual([false, 0]);
});
