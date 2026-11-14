import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as copyCleanup from "./copy_cleanup";
import { displayWidth } from "./text";
import type { CopyCleanup, Mode, Snapshot, Trigger } from "./copy_cleanup";

interface Fixture {
  name: string;
  snapshot: Snapshot;
  screen: string;
  expected: string;
}
/** The corpus in `fixtures/copy_cleanup/<folder>`; see its README. */
function corpus(folder: "commands" | "documents"): Fixture[] {
  const dir = new URL(`./fixtures/copy_cleanup/${folder}/`, import.meta.url);
  return readdirSync(dir)
    .filter(name => name.endsWith(".txt"))
    .sort()
    .map(name => {
      const file = readFileSync(new URL(name, dir), "utf8").replace(/\n$/, "");
      const blank = file.indexOf("\n\n");
      const header = file.slice(0, blank);
      const body = file.slice(blank + 2);
      const fields = Object.fromEntries(header.split("\n").map(line => line.split(": ")));
      const separator = body.indexOf("\n---\n");
      const screen = body.slice(0, separator);
      const rows = screen.split("\n");
      const start_x = Number(fields.start_x);
      return {
        name,
        screen,
        expected: body.slice(separator + 5),
        snapshot: {
          lines: [rows[0].slice(start_x), ...rows.slice(1)],
          start_x,
          first_indent: Number(fields.first_indent),
          width: Number(fields.width),
        },
      };
    });
}
const commands = corpus("commands");
const documents = corpus("documents");

test("mode follows the preference for plain and modifier drags, and a mention always dedents", () => {
  const table: Record<CopyCleanup, Record<Trigger, Mode>> = {
    on_drag: { plain: "clean", modifier: "raw", mention: "dedent" },
    with_modifier: { plain: "raw", modifier: "clean", mention: "dedent" },
    off: { plain: "raw", modifier: "raw", mention: "dedent" },
  };
  for (const [pref, triggers] of Object.entries(table))
    for (const [trigger, mode] of Object.entries(triggers))
      expect(copyCleanup.mode(pref as CopyCleanup, trigger as Trigger)).toBe(mode);
});

test("parse takes the three values and nothing else", () => {
  expect(["on_drag", "with_modifier", "off"].map(copyCleanup.parse)).toEqual(["on_drag", "with_modifier", "off"]);
  for (const value of ["On drag", "", 1, null, undefined, {}]) expect(copyCleanup.parse(value)).toBeNull();
});

test("quotes count only when balanced on their line", () => {
  const marks = (line: string) =>
    copyCleanup
      .quoted(line)
      .map(inside => (inside ? "q" : "."))
      .join("");
  expect(marks(`a "b c" d`)).toBe("..qqqqq..");
  expect(marks(`don't x`)).toBe(".......");
  expect(marks(`don't "x"`)).toBe("......qqq");
  expect(marks(`'a' "b"`)).toBe("qqq.qqq");
  expect(marks(`"a \\" b"`)).toBe("qqqqqqqq");
  expect(marks(`"a\\\\" "b"`)).toBe("qqqqq.qqq");
});

test("data guard: mappings, list items, comments and open brackets, but not quoted text", () => {
  const data = (...lines: string[]) => copyCleanup.isData(lines);
  expect(data("name: web")).toBe(true);
  expect(data("  - name: web")).toBe(true);
  expect(data("key:")).toBe(true);
  expect(data(`"key": 1`)).toBe(true);
  expect(data("- item")).toBe(true);
  expect(data("# comment")).toBe(true);
  expect(data("echo {a", "b")).toBe(true);
  expect(data("echo $(date", "+%s)")).toBe(false);
  expect(data(`curl -H "Content-Type: application/json"`)).toBe(false);
  expect(data(`echo "{" '['`)).toBe(false);
  expect(data("http://example.com", "image:latest")).toBe(false);
  expect(data("don't stop")).toBe(false);
  expect(data(`"foo" # note`, `'a' - b`)).toBe(false);
});

test("raw mode returns the selection unchanged", () => {
  for (const { snapshot } of [...commands, ...documents])
    expect(copyCleanup.clean(snapshot, "raw")).toEqual({ text: snapshot.lines.join("\n"), kind: "raw" });
});

test("a single line is trimmed, and loses a `$ ` prompt when cleaned", () => {
  const line = (text: string, mode: Mode) =>
    copyCleanup.clean({ lines: [text], start_x: 0, first_indent: 0, width: 80 }, mode);
  expect(line("  $ ls -la \\  ", "clean")).toEqual({ text: "ls -la \\", kind: "line" });
  expect(line("  $ ls -la", "dedent")).toEqual({ text: "$ ls -la", kind: "line" });
  expect(line("\tname: web ", "dedent")).toEqual({ text: "name: web", kind: "line" });
});

test("command fixtures flatten to one line when cleaned", () => {
  expect(commands.length).toBeGreaterThanOrEqual(10);
  for (const { name, snapshot, expected } of commands) {
    expect([name, copyCleanup.clean(snapshot, "clean")]).toEqual([name, { text: expected, kind: "command" }]);
  }
});

test("command fixtures are never flattened when only dedented", () => {
  for (const { name, snapshot } of commands) {
    const result = copyCleanup.clean(snapshot, "dedent");
    expect([name, result.kind, result.text.split("\n").length]).toEqual([name, "document", snapshot.lines.length]);
  }
});

test("document fixtures keep their lines and lose only the shared indent", () => {
  expect(documents.filter(fixture => fixture.snapshot.lines.length > 1).length).toBeGreaterThanOrEqual(10);
  for (const { name, snapshot, expected } of documents) {
    const kind = snapshot.lines.length === 1 ? "line" : "document";
    for (const mode of ["clean", "dedent"] as const)
      expect([name, mode, copyCleanup.clean(snapshot, mode)]).toEqual([name, mode, { text: expected, kind }]);
  }
});

test("YAML documents parse to the same document as shown on screen", () => {
  const yaml = documents.filter(fixture => fixture.name.startsWith("yaml_") || fixture.name.startsWith("start_"));
  expect(yaml.length).toBeGreaterThanOrEqual(4);
  for (const { name, snapshot, screen } of yaml) {
    // A mid-line start drops the first key, so compare with what was selected.
    const shown = snapshot.start_x > snapshot.first_indent ? screen.split("\n").slice(1).join("\n") : screen;
    const copied = copyCleanup.clean(snapshot, "clean").text.split("\n");
    const text = snapshot.start_x > snapshot.first_indent ? copied.slice(1).join("\n") : copied.join("\n");
    expect([name, Bun.YAML.parse(text)]).toEqual([name, Bun.YAML.parse(shown)]);
  }
});

test("wrap_margin is the smallest that wraps every command and flattens no document", () => {
  const wraps = (margin: number) =>
    commands.every(({ snapshot }) =>
      snapshot.lines
        .slice(1)
        .every((_, i) => snapshot.lines[i].trimEnd().endsWith("\\") || copyCleanup.isWrap(snapshot, i, margin)),
    );
  expect(copyCleanup.wrap_margin).toBe([0, 1, 2, 3, 4, 5, 6, 7, 8].find(wraps)!);
  for (const { name, snapshot } of documents)
    expect([name, copyCleanup.clean(snapshot, "clean").kind]).not.toEqual([name, "command"]);
});

test("isWrap measures the row's end, and a soft-wrapped row or an over-wide next word is no wrap", () => {
  const wrap = (lines: string[], start_x: number, width: number) =>
    copyCleanup.isWrap({ lines, start_x, first_indent: 0, width }, 0);
  // "ab" ends at 4; "cd" would end at 7, past 6.
  expect(wrap(["ab", "cd"], 2, 6)).toBe(true);
  expect(wrap(["ab", "cd"], 0, 6)).toBe(false);
  expect(wrap(["a".repeat(6), "cd"], 0, 6)).toBe(true);
  // The terminal soft-wrapped these rows, so no harness wrapped them.
  expect(wrap(["a".repeat(13), "cd"], 0, 6)).toBe(false);
  expect(wrap(["a".repeat(12), "cd"], 0, 6)).toBe(false);
  expect(wrap(["a".repeat(10), "cd"], 0, 6)).toBe(false);
  // A word wider than a row would have been split, not moved down whole.
  expect(wrap(["ab", "abcdefg"], 0, 6)).toBe(false);
  expect(wrap(["abcd", "abcdef"], 0, 6)).toBe(true);
});

test("a backslash continues a line only when it isn't escaped", () => {
  const two = (first: string) =>
    copyCleanup.clean({ lines: [`  ${first}`, "  rm -rf build"], start_x: 0, first_indent: 2, width: 80 }, "clean");
  expect(two("echo C:\\\\")).toEqual({ text: "echo C:\\\\\nrm -rf build", kind: "document" });
  expect(two("echo a \\\\\\")).toEqual({ text: "echo a \\\\ rm -rf build", kind: "command" });
});

test("cleaning up a full 200x60 selection takes under 2 ms", () => {
  const row = (i: number) => `  ${`key_${i}: "value ${i}" -flag ./path/to/file [x] (y) {z}`.padEnd(196, "w")}`;
  const snapshot: Snapshot = {
    lines: Array.from({ length: 60 }, (_, i) => row(i)),
    start_x: 0,
    first_indent: 2,
    width: 200,
  };
  const runs = 50;
  for (let i = 0; i < 5; i++) copyCleanup.clean(snapshot, "clean");
  const started = performance.now();
  for (let i = 0; i < runs; i++) {
    copyCleanup.clean(snapshot, "clean");
    copyCleanup.clean({ ...snapshot, lines: snapshot.lines.map(line => line.replace(":", "")) }, "clean");
  }
  expect((performance.now() - started) / (2 * runs)).toBeLessThan(2);
});

test("the copy toast's note says what cleanup changed", () => {
  const note = (lines: string[]) =>
    copyCleanup.note(lines.join("\n"), copyCleanup.clean(copyCleanup.fromColumnZero(lines, 80), "clean"));
  expect(note(["  git push origin main \\", "    --force-with-lease"])).toBe("joined");
  expect(note(["  spec:", "    replicas: 3"])).toBe("dedented");
  expect(note(["spec:", "  replicas: 3"])).toBeNull();
  expect(note(["  ls -la  "])).toBeNull();
});
