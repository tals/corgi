import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Terminal } from "./terminal";
import { capture, view } from "./surface";
import * as viewer_native from "../viewer_native";
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
test("plain image paths link to their file, and other paths stay plain", () => {
  const t = Terminal.create(100, 4);
  try {
    t.feed("GIF: /tmp/a-1/fleas.GIF (31 KB). /tmp/n.txt, src/b.png, https://x.example/c.png (/c/d.webp).");
    expect(links(t)).toEqual([
      expect.objectContaining({ uri: "file:///tmp/a-1/fleas.GIF", start: 5, end: 23 }),
      expect.objectContaining({ uri: "https://x.example/c.png" }),
      expect.objectContaining({ uri: "file:///c/d.webp" }),
    ]);
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
test("plain link prefixes survive soft wraps, repeated h and preceding graphemes", () => {
  const t = Terminal.create(20, 5),
    url = "https://example.com/";
  try {
    for (const prefix of ["h", "é ", "👩‍💻 ", ...[1, 2, 3].map(n => "x".repeat(20 - n))]) {
      t.feed("\x1b[2J\x1b[H" + prefix + url);
      const found = links(t);
      expect(found.length).toBeGreaterThan(0);
      for (const link of found) expect(link.uri).toBe(url);
    }
    for (const text of ["ht\r\ntps://example.com/", "htt\x1b[8mp\x1b[0ms://example.com/", "plain text"]) {
      t.feed("\x1b[2J\x1b[H" + text);
      expect(links(t)).toHaveLength(0);
    }
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
    for (const [printed, uris] of [
      ["['https://a.example/x','https://b.example/y']", ["https://a.example/x", "https://b.example/y"]],
      ["{'url':'https://a.example','n':1}", ["https://a.example"]],
    ] as const) {
      t.feed(`\x1b[2J\x1b[H${printed}`);
      expect(links(t).map(link => link.uri)).toEqual([...uris]);
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
      "\x1b]8;;https://explicit.example/\x1b\\ab\x1b]8;;\x1b\\/tail",
      "\x1b[8mab\x1b[0m/tail",
      "  - a list item",
      "  /path then words",
      "  Done",
      "  Thanks!",
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
test("plain link continuation allows a small right margin and keeps image paths apart", () => {
  const t = Terminal.create(40, 5);
  try {
    for (const width of [40, 39, 38]) {
      const first = "https://example.com/" + "a".repeat(width - 22);
      t.feed(`\x1b[2J\x1b[H  ${first}\r\n  /tail`);
      expect(links(t)[0].uri).toBe(first + "/tail");
    }
    const short = "https://example.com/" + "a".repeat(15);
    t.feed(`\x1b[2J\x1b[H  ${short}\r\n  /tail`);
    expect(links(t).map(link => link.uri)).toEqual([short]);
    const full = "https://example.com/" + "a".repeat(18);
    t.feed(`\x1b[2J\x1b[H  ${full}\r\n  /tmp/shot.png`);
    expect(links(t).map(link => link.uri)).toEqual([full, "file:///tmp/shot.png"]);
  } finally {
    t.destroy();
  }
});
test("plain links continue under list markers and before trailing text", () => {
  const t = Terminal.create(40, 8),
    url = "https://example.com/?body=" + "it's%20a%20long%20report%20".repeat(3);
  try {
    for (const [marker, hang] of [
      ["⏺ PR: ", 2],
      ["• ", 2],
      ["- ", 2],
      ["1. ", 3],
      ["  12. ", 6],
      ["  ", 2],
    ] as const) {
      const text = `${marker}(${url}) to review.`,
        rows = [text.slice(0, 40)];
      for (let at = 40; at < text.length; at += 40 - hang) rows.push(" ".repeat(hang) + text.slice(at, at + 40 - hang));
      t.feed("\x1b[2J\x1b[H" + rows.join("\r\n"));
      expect(links(t).map(link => link.uri)).toEqual(
        rows.slice(0, rows.findIndex(row => row.includes(")")) + 1).map(() => url),
      );
    }
  } finally {
    t.destroy();
  }
});
// The URL is longer than Ghostty's 2 KiB OSC buffer, so the mirror drops the
// pane's OSC 8 and finds the link again in the plain text.
test("the reported PR URL survives wrapping at different pane widths and reaches a mirror", () => {
  const url = readFileSync(new URL("../fixtures/wrapped_pr_url.txt", import.meta.url), "utf8");
  for (const cols of [40, 80, 97, 120, 154, 180, 200]) {
    const t = Terminal.create(cols, 100),
      mirror = Terminal.create(1, 1),
      text = `Open the PR (${url})`,
      rows: string[] = [];
    for (let at = 0; at < text.length; at += cols - 2) rows.push("  " + text.slice(at, at + cols - 2));
    try {
      t.feed(rows.join("\r\n"));
      viewer_native.receiveFrame(mirror.handle, t.surface(7));
      mirror.updateRender();
      for (const found of [t.hyperlinks(), mirror.hyperlinks()]) {
        expect(found).toHaveLength(rows.length);
        for (const link of found) expect(link.uri).toBe(url);
      }
    } finally {
      t.destroy();
      mirror.destroy();
    }
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
