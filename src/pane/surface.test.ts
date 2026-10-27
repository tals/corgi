import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Terminal } from "./terminal";
import { capture, view } from "./surface";
const links = (t: Terminal) => t.native({ op: "links" }) as { uri: string; start: number; end: number }[];
test("named hyperlinks survive capture and a second terminal render without leaking", () => {
  const ts = Array.from({ length: 3 }, () => Terminal.create(32, 3)),
    [t, mirror, host] = ts;
  try {
    t.feed("\x1b]8;id=docs;https://example.com/docs\x1b\\\x1b[4mDocs 界\x1b]8;;\x1b\\\x1b[0m plain");
    const captured = capture(7, t);
    expect(captured.lines[0]).toContain(";https://example.com/docs\x1b\\");
    mirror.feed(captured.lines[0]);
    host.feed(capture(7, mirror).lines[0]);
    const found = links(host);
    expect(found).toHaveLength(1);
    expect(found[0].uri).toBe("https://example.com/docs");
    expect(found[0].start).toBe(0);
    expect(found[0].end).toBe(7);
    expect(capture(7, t).lines[0]).toBe(captured.lines[0]);
  } finally {
    for (const t of ts) t.destroy();
  }
});
test("hyperlinks retain completed frame during synchronized output and disappear on overwrite", () => {
  const t = Terminal.create(20, 2);
  try {
    t.feed("\x1b]8;;https://example.com/old\x1b\\OLD\x1b]8;;\x1b\\");
    const before = capture(1, t);
    t.feed("\x1b[?2026h\x1b[2J\x1b[HNEW");
    expect(capture(1, t).lines[0]).toBe(before.lines[0]);
    t.feed("\x1b[?2026l");
    expect(capture(1, t).lines[0]).not.toContain("\x1b]8;");
  } finally {
    t.destroy();
  }
});
test("plain web links map Unicode cells, trim punctuation and preserve explicit targets", () => {
  const t = Terminal.create(100, 4);
  try {
    t.feed(
      "界é (https://example.com/a_(b)). plain\r\n\x1b]8;;https://explicit.example/\x1b\\https://printed.example/\x1b]8;;\x1b\\ \x1b[8mhttps://hidden.example/\x1b[0m",
    );
    const found = links(t);
    expect(found).toHaveLength(2);
    expect(found[0].uri).toBe("https://example.com/a_(b)");
    expect(found[0].start).toBe(5);
    expect(found[0].end).toBe(30);
    expect(found[1].uri).toBe("https://explicit.example/");
  } finally {
    t.destroy();
  }
});
test("plain links span soft wraps but not hard newlines and remain snapshot owned", () => {
  const t = Terminal.create(20, 5);
  try {
    const url = "https://example.com/a-long-path";
    t.feed(url + " ");
    const before = capture(9, t),
      found = links(t);
    expect(found).toHaveLength(2);
    for (const link of found) expect(link.uri).toBe(url);
    for (const line of before.lines.slice(0, 2)) expect(line).toContain(`;${url}\x1b\\`);
    t.feed("\x1b[?2026h\x1b[2J\x1b[Hhttps://new.example/");
    expect(capture(9, t).lines[0]).toBe(before.lines[0]);
    t.feed("\x1b[?2026l\x1b[2J\x1b[Hhttp://\r\nexample.com");
    capture(9, t);
    expect(links(t)).toHaveLength(0);
  } finally {
    t.destroy();
  }
});
test("plain links keep apostrophes inside URLs and trim surrounding punctuation", () => {
  const t = Terminal.create(100, 6);
  try {
    const url = "https://example.com/it's?body=doesn't%20stop";
    for (const printed of [url, `'${url}'`, `(${url}).`, `\"${url}\"`, `\`${url}\``]) {
      t.feed(`\x1b[2J\x1b[H${printed}`);
      expect(links(t).map(link => link.uri)).toEqual([url]);
    }
  } finally {
    t.destroy();
  }
});
test("plain links join indented full rows and map only their URL cells", () => {
  const t = Terminal.create(40, 6);
  const url = "https://example.com/?body=" + "it's%20a%20long%20report%20".repeat(5);
  const text = `Open (${url}).`,
    rows = text.match(/.{1,38}/g)!;
  try {
    for (const separator of ["\r\n", ""]) {
      t.feed("\x1b[2J\x1b[H" + rows.map(row => "  " + row).join(separator));
      const found = t.hyperlinks();
      expect(found).toHaveLength(rows.length);
      for (const [row, link] of found.entries()) {
        expect(link.uri).toBe(url);
        expect(link.id).toBe(found[0].id);
        expect(link.row).toBe(row);
        expect(link.start).toBe(row === 0 ? 8 : 2);
        expect(link.end).toBe(row === rows.length - 1 ? rows[row].length : 40);
      }
    }
  } finally {
    t.destroy();
  }
});
test("plain link continuation stops at paragraphs, indentation changes and explicit links", () => {
  const t = Terminal.create(40, 5),
    first = "https://example.com/" + "a".repeat(19);
  try {
    for (const next of [
      "  ordinary words on another line",
      "   /different-indent",
      "",
      "  https://another.example/",
      "  \x1b]8;;https://explicit.example/\x1b\\/named\x1b]8;;\x1b\\",
      "  \x1b[8m/hidden\x1b[0m",
    ]) {
      t.feed(`\x1b[2J\x1b[H  ${first}\r\n${next}`);
      expect(links(t)[0].uri).toBe(first);
    }
    t.feed("\x1b[2J\x1b[H  https://example.com/short\r\n  /separate");
    expect(links(t).map(link => link.uri)).toEqual(["https://example.com/short"]);
  } finally {
    t.destroy();
  }
});
test("the reported PR URL survives wrapping at different pane widths", () => {
  const url = readFileSync(new URL("../fixtures/wrapped_pr_url.txt", import.meta.url), "utf8");
  for (const cols of [40, 80, 97, 120, 154, 180, 200]) {
    const t = Terminal.create(cols, 100),
      text = `Open the PR (${url})`,
      rows: string[] = [];
    for (let at = 0; at < text.length; at += cols - 2) rows.push("  " + text.slice(at, at + cols - 2));
    try {
      t.feed(rows.join("\r\n"));
      const found = t.hyperlinks();
      expect(found).toHaveLength(rows.length);
      for (const link of found) expect(link.uri).toBe(url);
    } finally {
      t.destroy();
    }
  }
});
test.each(["", "id=long"])("long OSC 8 targets with parameters %j survive fragmented input and capture", params => {
  const t = Terminal.create(40, 4),
    mirror = Terminal.create(40, 4),
    url = "https://example.com/?body=" + "it's%20long%20".repeat(300);
  try {
    const output = `\x1b]8;${params};${url}\x1b\\Docs\x1b]8;;\x1b\\ plain`;
    for (let at = 0; at < output.length; at += 137) t.feed(output.slice(at, at + 137));
    const frame = capture(7, t);
    mirror.feed(frame.lines[0]);
    expect(links(mirror).map(link => link.uri)).toEqual([url]);
    expect(links(mirror)[0]).toMatchObject({ start: 0, end: 4 });
  } finally {
    t.destroy();
    mirror.destroy();
  }
});
test("OSC 8 accepts large targets within its bound and discards oversized sequences", () => {
  const t = Terminal.create(40, 4);
  try {
    for (const length of [2050, 4096, 16384, 65000, 66000]) {
      const url = "https://example.com/" + "a".repeat(length);
      t.feed(`\x1b[2J\x1b[H\x1b]8;;${url}\x1b\\Docs\x1b]8;;\x1b\\ plain`);
      expect(links(t).map(link => link.uri)).toEqual(length < 65536 ? [url] : []);
      expect(t.text()).toContain("Docs plain");
    }
  } finally {
    t.destroy();
  }
});
test("native surfaces and links expose exact bigint identities and numeric viewports", () => {
  const t = Terminal.create(32, 3);
  try {
    t.feed("\x1b]8;;https://example.com/\x1b\\Docs\x1b]8;;\x1b\\");
    const native = t.surface(1);
    expect(typeof t.surface_identity).toBe("bigint");
    expect(typeof t.surface_revision).toBe("bigint");
    expect(typeof t.title_revision).toBe("bigint");
    expect(typeof t.hyperlinks()[0].id).toBe("bigint");
    for (const identity of [1, 0xffffffffffffffffn]) {
      const normalized = view({ ...native, stamp: { identity, revision: 1, offset: 0 } });
      expect(normalized.stamp.identity).toBe(BigInt(identity));
      expect(normalized.stamp.revision).toBe(1n);
      expect(normalized.stamp.offset).toBe(0);
      expect(typeof normalized.bottom).toBe("number");
    }
  } finally {
    t.destroy();
  }
});
