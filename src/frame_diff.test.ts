import { expect, test } from "bun:test";
import { Differ } from "./frame_diff";
import * as native from "./native_ffi";
import * as rowGlide from "./row_glide";
import { Terminal } from "./pane/terminal";

const render = (d: Differ, frame: string) => d.diff(frame).toString();

const picture = (row: number, col: number, id = 1) => `\x1b[${row};${col}H\x1b_Ga=p,i=${id},p=1,C=1,q=2\x1b\\`;
const canvas = "\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[Junchanged text\x1b[2;1Hsecond line";
const done = "\x1b[1;1H\x1b[?2026l";

test("frame diffs preserve long hyperlink targets when the URL or label changes", () => {
  const d = Differ.create(40, 4),
    host = Terminal.create(40, 4),
    base = "https://example.com/?body=" + "it's%20long%20".repeat(300);
  try {
    for (const [url, label] of [
      [base, "Docs"],
      [base + "changed", "Docs"],
      [base + "changed", "More docs"],
    ]) {
      const frame = `\x1b[?2026h\x1b[H\x1b[2J\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\\x1b[?2026l`;
      host.feed(render(d, frame));
      host.updateRender();
      expect(host.hyperlinks().map(link => link.uri)).toEqual([url]);
      expect(host.hyperlinks()[0].end).toBe(label.length);
      expect(render(d, frame)).toBe("");
    }
  } finally {
    d.destroy();
    host.destroy();
  }
});

test("external image writes replay unchanged placements without repainting text", () => {
  const d = Differ.create(30, 8),
    frame = canvas + picture(3, 5) + done;
  try {
    render(d, frame);
    expect(render(d, frame)).toBe("");
    d.invalidateImages();
    const out = render(d, frame);
    expect(out).toContain(picture(3, 5));
    expect(out).not.toContain("unchanged text");
    expect(out).not.toContain("second line");
    expect(render(d, frame)).toBe("");
  } finally {
    d.destroy();
  }
});

test("moving an image writes its new placement without repainting text", () => {
  const d = Differ.create(30, 8),
    whole = native.terminal(),
    delta = native.terminal();
  whole.resize(30, 8);
  delta.resize(30, 8);
  try {
    for (const row of [3, 4, 6]) {
      const frame = canvas + picture(row, 5) + done,
        out = render(d, frame);
      whole.feed(frame);
      delta.feed(out);
      expect(delta.snapshot()).toEqual(whole.snapshot());
      if (row !== 3) {
        expect(out).toContain(picture(row, 5));
        expect(out).not.toContain("unchanged text");
        expect(out).not.toContain("second line");
      }
      expect(render(d, frame)).toBe("");
    }
    const textChange = canvas.replace("second line", "second Line") + picture(6, 5) + done,
      out = render(d, textChange);
    expect(out).not.toContain("\x1b_G");
    whole.feed(textChange);
    delta.feed(out);
    expect(delta.snapshot()).toEqual(whole.snapshot());
  } finally {
    d.destroy();
    whole.close();
    delta.close();
  }
});

test("image deletions and placements retain their order and saved cursor anchors", () => {
  const d = Differ.create(30, 8),
    hide = "\x1b_Ga=d,d=r,x=1,y=2,q=2\x1b\\",
    removeAtCursor = "\x1b_Ga=d,d=c,q=2\x1b\\";
  try {
    render(d, canvas + picture(3, 5) + done);
    // The delete after restore must run at (2, 4), not the last placement.
    const frame = canvas + "\x1b[2;4H\x1b7" + hide + picture(4, 7, 2) + "\x1b8" + removeAtCursor + done,
      out = render(d, frame);
    expect(out).toContain("\x1b[2;4H" + hide + picture(4, 7, 2) + "\x1b[2;4H" + removeAtCursor);
    expect(out).not.toContain("unchanged text");
    const deletion = render(d, canvas + "\x1b[1;1H" + hide + done);
    expect(deletion).toContain(hide);
    expect(deletion).not.toContain("a=p");
    expect(deletion).not.toContain("second line");
    // Omitting image commands does not invent a deletion of persistent images.
    expect(render(d, canvas + done)).not.toContain("\x1b_G");
  } finally {
    d.destroy();
  }
});

test("complete chunked uploads travel with their placements without repainting text", () => {
  const d = Differ.create(30, 8),
    upload = "\x1b_Ga=T,f=24,s=1,v=1,i=7,p=1,C=1,m=1;AAAA\x1b\\\x1b_Gm=0;\x1b\\";
  try {
    render(d, canvas + "\x1b[3;2H" + upload + done);
    const out = render(d, canvas + "\x1b[4;3H" + upload + done);
    expect(out).toContain("\x1b[4;3H\x1b_Ga=T");
    expect(out).toContain("\x1b[4;3H\x1b_Gm=0;\x1b\\");
    expect(out.indexOf("a=T")).toBeLessThan(out.indexOf("_Gm=0"));
    expect(out).not.toContain("unchanged text");
    expect(render(d, canvas + "\x1b[4;3H" + upload + done)).toBe("");
  } finally {
    d.destroy();
  }
});

test("the sidebar's moving and fading tint no longer resends its text", () => {
  const d = Differ.create(120, 40),
    text = canvas + "\x1b[3;1H" + "x".repeat(110),
    frame = (y: number, alpha: number) =>
      text +
      rowGlide.hide +
      rowGlide.place(0, y, 30, 2, { top: 0, bottom: 40 }, alpha, { width: 10, height: 22 }) +
      done;
  try {
    render(d, frame(4, 0.2));
    for (const [y, alpha] of [
      [4.5, 0.2],
      [5, 0.15],
      [5, 0.05],
    ]) {
      const out = render(d, frame(y, alpha));
      expect(out).toContain("a=T");
      expect(out).toContain("a=d,d=i");
      expect(out).not.toContain("unchanged text");
      expect(out).not.toContain("x".repeat(110));
    }
  } finally {
    d.destroy();
  }
});

test("cursor-moving images, unknown APCs and incomplete uploads keep full frames", () => {
  for (const image of [
    "\x1b_Ga=p,i=1,p=1\x1b\\",
    "\x1b_Ga=T,f=24,s=1,v=1,i=7,p=1;AAAA\x1b\\",
    "\x1b_Ga=T,f=24,s=1,v=1,i=7,p=1,C=1,m=1;AAAA\x1b\\",
    "\x1b_unknown\x1b\\",
    "\x1b_Ga=p,i=1,C=1",
  ]) {
    const d = Differ.create(30, 8);
    try {
      for (const row of [3, 4]) {
        const frame = canvas + `\x1b[${row};2H` + image;
        expect(render(d, frame)).toBe(frame);
      }
      const safe = canvas + picture(5, 5) + done;
      expect(render(d, safe)).toBe(safe);
    } finally {
      d.destroy();
    }
  }
});

test("clears, screen switches and scrolling retain their ordering with images", () => {
  for (const reset of ["\x1b[2J", "\x1b[3J", "\x1bc", "\x1b[?1049h", "\x1b[1S", "\x1bD", "\n"]) {
    const d = Differ.create(30, 8);
    try {
      for (const row of [3, 4]) {
        const frame = canvas + picture(row, 5) + reset + done;
        expect(render(d, frame)).toBe(frame);
      }
    } finally {
      d.destroy();
    }
  }
});

test("foreground changes preserve the background and bold style", () => {
  const d = Differ.create(20, 2);
  try {
    render(d, "\x1b[H\x1b[0m\x1b[Jold");
    const background = "\x1b[48;2;20;30;40m",
      first = "\x1b[38;2;100;110;120m",
      second = "\x1b[38;2;130;140;150m",
      out = render(d, `\x1b[H\x1b[0m\x1b[J\x1b[1m${background}${first}A${second}B\x1b[0m`);
    expect(out).toContain(`A${second}B`);
    expect(out.split(background).length - 1).toBe(1);
    expect(out.split("\x1b[1m").length - 1).toBe(1);
  } finally {
    d.destroy();
  }
});

test("style deltas reproduce full rendering for every pair of colors and attributes", () => {
  const d = Differ.create(5, 2),
    whole = native.terminal(),
    delta = native.terminal();
  // Cover independent resets, the shared bold/faint reset, underline variants,
  // and changes between default, indexed and truecolor attributes.
  const styles = [
    "",
    "1",
    "2",
    "1;2",
    "3",
    "5",
    "7",
    "8",
    "9",
    "53",
    "4",
    "4:2",
    "4:3",
    "4:4",
    "4:5",
    "31",
    "48;5;200",
    "58;5;100",
    "38;2;120;130;140",
    "48;2;10;20;30",
    "58;2;200;210;220",
    "1;2;3;5;7;8;9;53",
    "4:3;38;2;120;130;140;48;5;200;58;5;100",
  ];
  whole.resize(5, 2);
  delta.resize(5, 2);
  let tick = 0;
  try {
    for (const from of styles)
      for (const to of styles) {
        const glyphs = tick++ % 2 ? "AB" : "ab",
          frame = `\x1b[H\x1b[0m\x1b[J\x1b[${from}m${glyphs[0]}\x1b[0m\x1b[${to}m${glyphs[1]}\x1b[0m`;
        // A caller may change terminal attributes between presentations.
        delta.feed("\x1b[1;2;3;4;7;48;5;123m");
        whole.feed(frame);
        delta.feed(render(d, frame));
        expect(delta.snapshot(), `${from} -> ${to}`).toEqual(whole.snapshot());
      }
  } finally {
    d.destroy();
    whole.close();
    delta.close();
  }
});

test("a frame that changes one cell writes that cell", () => {
  const d = Differ.create(20, 4);
  const first = "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mworld\x1b[0m\x1b[?2026l";
  expect(render(d, first)).toBe(first);
  expect(render(d, first)).toBe("");
  expect(render(d, "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mwOrld\x1b[0m\x1b[?2026l")).toBe(
    "\x1b[?2026h\x1b[?25l\x1b[2;2H\x1b[0m\x1b[38;5;1mO\x1b[0m\x1b[2;6H\x1b[?25h\x1b[?2026l",
  );
  d.destroy();
});

test("a changed control sends the whole frame", () => {
  const d = Differ.create(20, 4);
  for (const frame of [
    "\x1b[H\x1b[Jtext\x1b]22;default\x1b\\",
    "\x1b[H\x1b[Jtext\x1b]22;pointer\x1b\\",
    "\x1b[H\x1b[J\x1b[2;3H\x1b_Ga=p,i=1\x1b\\text",
    "\x1b[H\x1b[J\x1b[3;3H\x1b_Ga=p,i=1\x1b\\text",
  ])
    expect(render(d, frame)).toBe(frame);
  d.destroy();
});

test("a moved cursor is written without cells", () => {
  const d = Differ.create(20, 4);
  render(d, "\x1b[H\x1b[J$ \x1b[1;3H\x1b[?25h");
  expect(render(d, "\x1b[H\x1b[J$ \x1b[2;5H\x1b[?25h")).toBe("\x1b[?2026h\x1b[?25l\x1b[2;5H\x1b[?25h\x1b[?2026l");
  d.destroy();
});

test("wide characters and links are rewritten whole", () => {
  const d = Differ.create(20, 2);
  render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://a.example\x1b\\ab\x1b]8;;\x1b\\界c");
  const changed = render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界d");
  expect(changed).toContain("\x1b]8;id=x;https://b.example\x1b\\");
  expect(changed).toContain("界d");
  const tail = render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界e");
  expect(tail).toContain("\x1b[1;5H");
  expect(tail).not.toContain("界");
  d.destroy();
});

test("sparse runs skip long gaps and carry style across rows", () => {
  const d = Differ.create(120, 4);
  const frame = (letter: string) =>
    `\x1b[?7l\x1b[H\x1b[0m\x1b[J\x1b[31m${letter}${".".repeat(100)}${letter}\x1b[3;1H${letter}\x1b[0m`;
  try {
    render(d, frame("a"));
    const out = render(d, frame("b"));
    expect(out).not.toContain(".");
    expect(out).toContain("\x1b[1;102H");
    expect(out.split("\x1b[38;5;1m").length - 1).toBe(1);
    expect(out.length).toBeLessThan(90);
  } finally {
    d.destroy();
  }
});

test("short plain gaps merge but expensive styled gaps are skipped", () => {
  const d = Differ.create(80, 2);
  try {
    render(d, "\x1b[H\x1b[0m\x1b[Ja..a");
    expect(render(d, "\x1b[H\x1b[0m\x1b[Jb..b")).toContain("b..b");
    render(d, "\x1b[H\x1b[0m\x1b[Ja\x1b[38;2;100;110;120m.\x1b[0ma");
    const out = render(d, "\x1b[H\x1b[0m\x1b[Jb\x1b[38;2;100;110;120m.\x1b[0mb");
    expect(out).not.toContain("100;110;120");
    expect(out).toContain("\x1b[1;3H");
  } finally {
    d.destroy();
  }
});

test("split runs preserve wide cells, graphemes, long links, and colored erasures", () => {
  const d = Differ.create(80, 5),
    whole = native.terminal(),
    delta = native.terminal();
  whole.resize(80, 5);
  delta.resize(80, 5);
  const uri = `https://example.test/${"x".repeat(300)}`;
  let seed = 42;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const cells = Array.from({ length: 4 }, () => Array<string>(20).fill("    "));
  const choices = [
    "abcd",
    "界ab",
    "a界b",
    "ab界",
    "éabc",
    "\x1b[31;44m    \x1b[0m",
    "\x1b[1;4:3mword\x1b[0m",
    `\x1b]8;id=test;${uri}\x1b\\link\x1b]8;;\x1b\\`,
    "    ",
  ];
  try {
    for (let i = 0; i < 160; i++) {
      for (let j = 0; j < (i % 9 === 0 ? 80 : 3); j++) cells[random(4)][random(20)] = choices[random(choices.length)];
      const frame =
        "\x1b[?7l\x1b[H\x1b[0m\x1b[J" +
        cells.map((row, y) => `\x1b[${y + 1};1H${row.join("")}`).join("") +
        "\x1b[0m\x1b[2;4H";
      whole.feed(frame);
      delta.feed(render(d, frame));
      expect(delta.snapshot(), `frame ${i}`).toEqual(whole.snapshot());
    }
  } finally {
    d.destroy();
    whole.close();
    delta.close();
  }
});
