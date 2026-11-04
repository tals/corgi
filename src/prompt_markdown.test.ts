import { expect, test } from "bun:test";
import * as palette from "./palette";
import * as markdown from "./prompt_markdown";

const shown = (lines: markdown.Line[]) =>
  lines.map(line => ("segs" in line ? line.segs.map(seg => seg.text).join("") : `[${line.conversations}]`));
const styleOf = (lines: markdown.Line[], text: string) =>
  lines.flatMap(line => ("segs" in line ? line.segs : [])).find(seg => seg.text === text)?.style;
const look = (value: ConstructorParameters<typeof palette.Style>[0]) => new palette.Style({ bg: "bg", ...value }).sgr();

test("commit links keep their target through wrapping and tables", () => {
  for (const text of [
    "[review these changes](main..topic@../repo)",
    "| Review |\n|---|\n| [review these changes](main..topic@../repo) |",
  ])
    for (const room of [18, 80]) {
      const segs = markdown.layout(text, room).flatMap(line => ("segs" in line ? line.segs : []));
      const links = segs.filter(seg => seg.review);
      expect(links.length).toBeGreaterThan(0);
      expect(links.every(seg => seg.review?.folder === "../repo" && seg.review.source.kind === "range")).toBe(true);
      expect(segs.map(seg => seg.text).join("")).not.toContain("main..topic@");
    }
  const lines = markdown.layout(
    "`abc1234@/repo` `user@example.com`\n\n```commits\nHEAD@.\nmain..topic@../repo\n```",
    80,
  );
  expect(lines.flatMap(line => ("segs" in line ? line.segs : [])).filter(seg => seg.review)).toHaveLength(3);
  expect(shown(lines)).toEqual(["abc1234 user@example.com", "", "HEAD, main..topic"]);
});

test("ordinary prose recognizes hashes while Markdown links stay inline with their labels", () => {
  const text =
    "The [sidebar fix](7165f82b@.) landed after ee11c852. Compare 7165f82b..ee11c852, or [the original](7165f82b).";
  const lines = markdown.layout(text, 140);
  expect(shown(lines)).toEqual(["The sidebar fix landed after ee11c852. Compare 7165f82b..ee11c852, or the original."]);
  const segs = lines.flatMap(line => ("segs" in line ? line.segs : [])).filter(seg => seg.review);
  expect(segs.map(seg => seg.text)).toEqual(["sidebar fix", "ee11c852", "7165f82b..ee11c852", "the original"]);
  expect(segs.every(seg => seg.review!.folder === ".")).toBe(true);
  const code = markdown.layout("```sh\necho 7165f82b\n```", 80);
  expect(code.flatMap(line => ("segs" in line ? line.segs : [])).some(seg => seg.review)).toBe(false);
});

test("bare hashes in existing replies refer to this workspace, with explicit links taking precedence", () => {
  const text =
    "- `7165f82b` viewer: show the Corgi prompt\n- `7165f82b..ee11c852` changes\n- [`7165f82b`](7165f82b@../other)\n- [`7165f82b`](https://example.com/commit/7165f82b)";
  const segs = markdown.layout(text, 80).flatMap(line => ("segs" in line ? line.segs : []));
  expect(segs.filter(seg => seg.review).map(seg => seg.review!.folder)).toEqual([".", ".", "../other"]);
  expect(shown(markdown.layout("[**`7165f82b@elsewhere`**](7165f82b@/repo)", 80))).toEqual(["7165f82b@elsewhere"]);
});

test("a paragraph wraps between words, and its rows copy back as one line", () => {
  const lines = markdown.layout("one two three four", 9);
  expect(shown(lines)).toEqual(["one two", "three", "four"]);
  expect(lines.map(line => ("segs" in line ? line.cont : null))).toEqual([
    undefined,
    { join: " ", skip: 0 },
    { join: " ", skip: 0 },
  ]);
  // A line break the reply wrote is its own row.
  expect(shown(markdown.layout("one\ntwo", 40))).toEqual(["one", "two"]);
});

test("marks: bold, italic, struck, code, links, headings", () => {
  const lines = markdown.layout(
    "# Top\n\n## Next\n\n**b** *i* ~~s~~ `c` [site](https://x.com) https://y.com mail@z.com",
    80,
  );
  expect(shown(lines)).toEqual(["Top", "", "Next", "", "b i s c site (https://x.com) https://y.com mail@z.com"]);
  expect(styleOf(lines, "Top")).toBe(look({ fg: "strong", bold: true, underline: true }));
  expect(styleOf(lines, "Next")).toBe(look({ fg: "strong", bold: true }));
  expect(styleOf(lines, "b")).toBe(look({ fg: "strong", bold: true }));
  expect(styleOf(lines, "i")).toBe(look({ fg: "text", italic: true }));
  expect(styleOf(lines, "s")).toBe(look({ fg: "text", strike: true }));
  expect(styleOf(lines, "c")).toBe(look({ fg: "strong", bg: "surface" }));
  expect(styleOf(lines, "site")).toBe(look({ fg: "text", underline: true }));
  expect(styleOf(lines, " (https://x.com)")).toBe(look({ fg: "faint" }));
});

test("lists hang their text under its start, number to the right, and check tasks", () => {
  const lines = markdown.layout("Steps:\n\n9. nine and more\n10. ten\n    - deep\n\n- [x] done\n- [ ] open", 16);
  expect(shown(lines)).toEqual([
    "Steps:",
    "",
    " 9. nine and",
    "    more",
    "10. ten",
    "    ◦ deep",
    "",
    "☑ done",
    "☐ open",
  ]);
  expect((lines[3] as { cont?: object }).cont).toEqual({ join: " ", skip: 4 });
  // A list that runs on from its line keeps to it.
  expect(shown(markdown.layout("Steps:\n1. one", 16))).toEqual(["Steps:", "1. one"]);
});

test("a quote bars every row, wrapped ones too, and copies without the bar", () => {
  const lines = markdown.layout("> one two three\n> > inner", 10);
  expect(shown(lines)).toEqual(["│ one two", "│ three", "│ ", "│ │ inner"]);
  expect((lines[1] as { cont?: object }).cont).toEqual({ join: " ", skip: 2 });
  expect(styleOf(lines, "one two")).toBe(look({ fg: "muted" }));
});

test("a table fits the room, aligns its columns and wraps its cells", () => {
  const table = "| Name | Size |\n|:-----|-----:|\n| a | 1 |\n| bb | 22 |";
  expect(shown(markdown.layout(table, 40))).toEqual([
    "┌──────┬──────┐",
    "│ Name │ Size │",
    "├──────┼──────┤",
    "│ a    │    1 │",
    "│ bb   │   22 │",
    "└──────┴──────┘",
  ]);
  // Cells that wrap keep their rows apart.
  expect(shown(markdown.layout("| A | B |\n|---|---|\n| one two | x |\n| y | z |", 14))).toEqual([
    "┌────────┬───┐",
    "│ A      │ B │",
    "├────────┼───┤",
    "│ one    │ x │",
    "│ two    │   │",
    "├────────┼───┤",
    "│ y      │ z │",
    "└────────┴───┘",
  ]);
  // Too narrow for its borders, it shows as typed.
  const narrow = shown(markdown.layout(table, 6));
  expect(narrow.join(" ")).toContain("Name");
  expect(narrow.some(row => row.includes("┌"))).toBe(false);
});

test("code is indented and colored as the review panel colors it", () => {
  const lines = markdown.layout("```ts\nconst x = 1;\n```\n\n```\nplain\n```", 40);
  expect(shown(lines)).toEqual(["  const x = 1;", "", "  plain"]);
  expect(styleOf(lines, "const")).toBe(look({ fg: "text" }) + palette.fgRgb(palette.syntax.keyword));
  expect(styleOf(lines, "plain")).toBe(look({ fg: "muted" }));
});

test("as in Pi: two tildes strike, math shows as Unicode, prices stay text", () => {
  expect(shown(markdown.layout("~~gone~~, ~5 to ~10 min", 40))).toEqual(["gone, ~5 to ~10 min"]);
  expect(shown(markdown.layout("$E = mc^2$ and $\\alpha$, costs $5 and $10", 60))).toEqual([
    "E = mc² and α, costs $5 and $10",
  ]);
  expect(shown(markdown.layout("$$\n\\sqrt{2}\n$$", 40))).toEqual(["√2"]);
});

test("entities show as what they name", () => {
  expect(shown(markdown.layout("a &amp; b &lt;c&gt; &#x1F600; &bogus;", 40))).toEqual(["a & b <c> 😀 &bogus;"]);
  expect(shown(markdown.layout("a&#10;b&#9;c", 40))).toEqual(["a", "b c"]);
});

test("an entity naming a control stays as written, out of the terminal", () => {
  const text = "&#27;]52;c;aGk=&#7; &#x1b;[2J &#155; &#xD800;";
  for (const source of [text, `**${text}**`, `| a |\n|---|\n| ${text} |`]) {
    const out = shown(markdown.layout(source, 80)).join("\n");
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\ud800-\udfff]/);
    expect(out).toContain("&#27;");
  }
});

test("a streaming reply closes what it left open, and waits on a half-typed mark", () => {
  expect(markdown.settle("Here is **bo")).toBe("Here is **bo**");
  expect(markdown.settle("Here is **")).toBe("Here is ");
  expect(markdown.settle("Here is *")).toBe("Here is ");
  expect(markdown.settle("Here is **bold*")).toBe("Here is **bold**");
  expect(markdown.settle("an *italic*")).toBe("an *italic*");
  expect(markdown.settle("**a `b")).toBe("**a `b`**");
  expect(markdown.settle("```ts\nx = **")).toBe("```ts\nx = **");
  expect(markdown.settle("done **a** and `b`")).toBe("done **a** and `b`");
  const lines = markdown.layout("Here is **bo", 40, true);
  expect(shown(lines)).toEqual(["Here is bo"]);
  expect(styleOf(lines, "bo")).toBe(look({ fg: "strong", bold: true }));
  // A closing fence on its way doesn't show as code.
  expect(shown(markdown.layout("```ts\nconst x = 1;\n``", 40, true))).toEqual(["  const x = 1;"]);
  expect(shown(markdown.layout("```ts\nconst x = 1;\n``", 40))).toEqual(["  const x = 1;", "  ``"]);
});

test("a conversations fence comes out whole, in its place", () => {
  expect(shown(markdown.layout("Here:\n\n```conversations\nclaude a\ncodex b\n```\n\nPick one.", 40))).toEqual([
    "Here:",
    "",
    "[claude a,codex b]",
    "",
    "Pick one.",
  ]);
});

test("a reply's lines are kept until its text or the room changes", () => {
  const reply = { text: "**a**", partial: false };
  const first = markdown.lines(reply, 20);
  expect(markdown.lines(reply, 20)).toBe(first);
  expect(markdown.lines(reply, 30)).not.toBe(first);
  reply.text = "**b**";
  expect(shown(markdown.lines(reply, 30))).toEqual(["b"]);
});
