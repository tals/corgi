import { expect, test } from "bun:test";
import * as evidence from "./link_evidence";

test("transcript and screen spellings share path locations and UTF-16 spans", () => {
  const text =
    "🐾 see `docs/部署 plan.png`, a/src/a.ts(12, 3), read.md#L5 or Makefile:17. " + 'File "/tmp/long name.py", line 21';
  expect(Array.from(evidence.tokens(text), t => [text.slice(t.start, t.end), t.uri, t.path])).toEqual([
    ["docs/部署 plan.png", "docs/部署 plan.png", true],
    ["a/src/a.ts(12, 3)", "a/src/a.ts:12:3", true],
    ["read.md#L5", "read.md:5", true],
    ["Makefile:17", "Makefile:17", true],
    ["/tmp/long name.py", "/tmp/long name.py:21", true],
  ]);
  expect(Array.from(evidence.tokens('open "Build Rules:17"'), t => t.uri)).toEqual(["Build Rules:17"]);
});

test("web tokens keep balanced parentheses and stop before adjacent Markdown and JSON punctuation", () => {
  const text =
    "['https://a.example/it's/a_(b)','HTTPS://b.test/read?q=a%20b']. " +
    "[docs](https://c.test/guide). ftp://d.test/doc/file.txt ./real.sh";
  expect(Array.from(evidence.tokens(text), t => [text.slice(t.start, t.end), t.path])).toEqual([
    ["https://a.example/it's/a_(b)", false],
    ["HTTPS://b.test/read?q=a%20b", false],
    ["https://c.test/guide", false],
    ["./real.sh", true],
  ]);
});

test("ignores prose, directory names, versions and oversized UTF-8 targets", () => {
  for (const text of [
    "Ordinary sentences end here.",
    "1.84 GB at 12:30",
    "see ./src/",
    "a/b".repeat(400),
    "/" + "数".repeat(350),
    "https://x/" + "🐾".repeat(1024),
  ])
    expect(Array.from(evidence.tokens(text))).toEqual([]);
});

test("only membership changes the evidence revision, and repeated names survive eviction", () => {
  const dictionary = new evidence.Dictionary();
  dictionary.add("src/keep.ts");
  const first = dictionary.revision;
  dictionary.add("Same src/keep.ts twice: src/keep.ts");
  expect(dictionary.revision).toBe(first);
  for (let n = 0; n < 255; n++) dictionary.add("src/test-" + n);
  dictionary.add("src/keep.ts src/last.ts");
  expect(dictionary.has("src/keep.ts")).toBe(true);
  expect(dictionary.has("src/test-0")).toBe(false);
  expect(dictionary.has("src/test-1")).toBe(true);
  expect(dictionary.revision).toBeGreaterThan(first);
  dictionary.clear();
  expect(dictionary.has("src/last.ts")).toBe(false);
  const other = new evidence.Dictionary();
  other.add("src/last.ts");
  expect(other.revision).toBeGreaterThan(dictionary.revision);
});

test("large tool outputs retain whole lines within 8 KiB of either end", () => {
  const dictionary = new evidence.Dictionary();
  const first = "assets/first.png\n",
    last = "\nassets/last.png";
  const prefix = '"assets/front.png',
    suffix = 'back.png"';
  const head = first + " ".repeat(8192 - first.length - prefix.length) + prefix;
  const tail = suffix + " ".repeat(8192 - last.length - suffix.length) + last;
  dictionary.add(head + ' cropped"\nassets/middle.png\n"assets/cropped ' + tail);
  expect(dictionary.has("assets/first.png")).toBe(true);
  expect(dictionary.has("assets/last.png")).toBe(true);
  for (const omitted of ["assets/middle.png", "assets/front.png", "back.png"])
    expect(dictionary.has(omitted)).toBe(false);
  dictionary.add(first + "数".repeat(3000) + "\nassets/outside.png\n" + "数".repeat(3000) + last);
  expect(dictionary.has("assets/outside.png")).toBe(false);
});

test("Markdown paths use matching backtick runs and retain filename spaces and literal ticks", () => {
  const text = "Use `Release Notes` or `` a `draft` file.md ``:12 and `https://example.org`, then `Plan B.pdf`.";
  expect(Array.from(evidence.tokens(text), t => [text.slice(t.start, t.end), t.uri])).toEqual([
    ["Release Notes", "Release Notes"],
    ["a `draft` file.md", "a `draft` file.md:12"],
    ["https://example.org", "https://example.org"],
    ["Plan B.pdf", "Plan B.pdf"],
  ]);
  expect([...evidence.tokens("`Release\r\nNotes`")][0]).toMatchObject({ uri: "Release Notes", start: 1, end: 15 });
  for (const value of ["\\`Release Notes`", "``Release Notes```", "`Release\n\nNotes`"])
    expect([...evidence.tokens(value)].some(t => t.code)).toBe(false);
});

test("ordinary inline identifiers do not crowd filenames out of a conversation", () => {
  const dict = new evidence.Dictionary();
  dict.add("See `My spec.md`");
  for (let i = 0; i < 300; i++) dict.add("Set `flag" + i + "` to `true` and run `command number " + i + "`");
  expect(dict.has("My spec.md")).toBe(true);
  expect(dict.has("true")).toBe(false);
  expect(dict.has("command number 0")).toBe(false);
  expect(dict.has("command number 299")).toBe(true);
});

test("a sentence period after a Markdown code span can identify an extensionless basename", () => {
  const text = "Read `filename`. See also `` dépôt-2 ``.";
  expect([...evidence.tokens(text)].map(t => [text.slice(t.start, t.end), t.uri])).toEqual([
    ["filename", "filename"],
    ["dépôt-2", "dépôt-2"],
  ]);
  for (const prose of ["Read filename.", "Use `filename` here.", "Use `filename`.value", "Use `filename`..."])
    expect([...evidence.tokens(prose)].some(t => t.uri === "filename")).toBe(false);

  const dictionary = new evidence.Dictionary();
  dictionary.add("Open docs/keep.md and `filename`.");
  expect(dictionary.has("filename")).toBe(true);
  expect(dictionary.has("filename.")).toBe(false);
  for (let i = 0; i < 40; i++) dictionary.add("Set `flag" + i + "`.");
  expect(dictionary.has("docs/keep.md")).toBe(true);
  expect(dictionary.has("filename")).toBe(false);
  expect(dictionary.has("flag39")).toBe(true);
});
