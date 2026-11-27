import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as wrapped from "./wrapped_link";
import { Dictionary } from "./link_evidence";
import { Terminal } from "./pane/terminal";
import * as mirror from "./mirror";
import type { Request, Reply } from "./protocol";
import { transport } from "./fixtures/transport";

function resolve(
  rows: wrapped.Row[],
  x: number,
  y: number,
  known: Dictionary | null,
  files: Parameters<typeof wrapped.resolve>[1],
  cwd = "/",
) {
  return wrapped.resolve(wrapped.inspect(rows, x, y, known), files, cwd);
}

function rows(text: string[], cols = 50): wrapped.Row[] {
  return text.map((s, row) => ({ row, wrap: false, cells: [...s.padEnd(cols)] }));
}

function filesWith(...names: string[]) {
  const checked: string[] = [];
  return {
    checked,
    async find(name: string, cwd = "/") {
      checked.push(name);
      if (!names.includes(name)) throw Error("missing");
      return { path: join(cwd, name), id: name, size: 1, mtime: 0 };
    },
  };
}

type Lookup = Request<"viewer.wrapped_link">;
function lookupServer(
  answer: (q: Lookup) => Promise<Reply<"viewer.wrapped_link">> = async () => ({ ok: true, target: null }),
) {
  const calls: Lookup[] = [];
  const conn = transport(async (op, fields) => {
    expect(op).toBe("viewer.wrapped_link");
    const request = fields as Lookup;
    calls.push(request);
    return answer(request);
  });
  return { calls, conn };
}

const wake = () => {};
function displayed(text: string, conn: mirror.Transport, { height = 4, id = 1, cwd = "/repo" } = {}) {
  const source = Terminal.create(32, height);
  const term = new mirror.Terminal(conn, id, 32, height);
  function feed(text: string) {
    source.feed(text);
    term.receive(source.surface(id));
  }
  feed(text);
  term.linkContext(0n, true, cwd);
  return {
    term,
    source,
    feed,
    [Symbol.dispose]() {
      term.destroy();
      source.destroy();
    },
  };
}

test("feed evidence joins eight hard-wrapped rows from either edge and the middle without file IO", async () => {
  const parts = ["https://example.org/", "inter", "medi", "ate/", "a/", "b/", "image.", "png"];
  const url = parts.join(""),
    dict = new Dictionary(),
    cells = rows(parts),
    lines = cells.map(r => r.cells.join("")),
    noFiles = filesWith();
  dict.add(url);
  for (const y of [0, 2, 7]) {
    const result = await resolve(cells, 1, y, dict, noFiles);
    expect(result?.uri).toBe(url);
    expect(result?.spans).toHaveLength(8);
    expect(wrapped.regions(lines, y).some(s => s.start <= 1 && s.end > 1)).toBe(true);
  }
  expect(noFiles.checked).toEqual([]);
});

test("use the owning filesystem for soft-wrapped image paths and preserve wide-cell coordinates", async () => {
  const term = Terminal.create(17, 4),
    file = "docs/help-small.png",
    files = filesWith(file);
  try {
    term.feed("界 " + file);
    const found = await resolve(term.native({ op: "linkWindow", x: 1, y: 1 }), 1, 1, null, files, "/repo");
    expect(files.checked).toEqual([file]);
    expect(found).toEqual({
      uri: file,
      path: true,
      file: "/repo/" + file,
      spans: [
        { row: 0, start: 3, end: 17 },
        { row: 1, start: 0, end: 5 },
      ],
    });
  } finally {
    term.destroy();
  }
});

test("explicit hyperlinks, directory listings and truncated soft-wrapped URLs remain separate", async () => {
  const term = Terminal.create(12, 12),
    dict = new Dictionary();
  dict.add("public/index.html");
  try {
    const files = filesWith();
    expect(await resolve(rows(["public/", "index.html"]), 1, 1, dict, files)).toBeNull();
    expect(files.checked).toEqual([]);
    term.feed("https://abc/" + "x".repeat(119));
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 0 }), 2, 0, dict, files)).toBeNull();
    term.feed("\x1b[2J\x1b[Hhttps://abc/" + "x".repeat(83) + ".org/rest");
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 0 }), 2, 0, dict, files)).toBeNull();
    term.feed("\x1b[2J\x1b[Hsrc/dir\r\n\x1b]8;;https://other.test\x1b\\file.ts\x1b]8;;\x1b\\");
    dict.add("src/dirfile.ts");
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 1 }), 2, 1, dict, files)).toBeNull();
  } finally {
    term.destroy();
  }
});

test("pointer travel, ordinary text and repeated redraws incur no extra requests; a notice retries a stationary hit", async () => {
  const { calls, conn } = lookupServer(async () => ({ ok: true, target: null, range: { start: 0, end: 23 } }));
  using pane = displayed("some ordinary prose\r\nmore words here\r\n\r\nhttps://example.org/abc\r\ndef", conn, {
    height: 24,
  });
  const { term } = pane;
  for (let x = 0; x < 20; x++) term.hoverLink(x, 0, () => true, wake);
  await Bun.sleep(100);
  expect(calls).toEqual([]);
  for (let x = 1; x < 12; x++) term.hoverLink(x, 3, () => true, wake);
  await Bun.sleep(100);
  expect(calls).toHaveLength(1);
  for (let x = 0; x < 20; x++) await term.probeLink(x, 3, wake);
  for (let i = 0; i < 20; i++) {
    pane.feed("\x1b[20;1H" + i);
    await term.probeLink(11, 3, wake);
  }
  expect(calls).toHaveLength(1);
  term.recheckLink(1);
  await term.probeLink(11, 3, wake);
  expect(calls).toHaveLength(2);
});

test("a click retries a completed hover miss after the named file appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    name = "new file.txt";
  const { calls, conn } = lookupServer(async ({ x, y }) => {
    const probe = wrapped.inspect(pane.source.native({ op: "linkWindow", x, y }), x, y, null);
    return { ok: true, target: await wrapped.resolve(probe, fileAccess.here, dir), range: probe.range };
  });
  using pane = displayed("See `new file.txt`.", conn, { cwd: dir });
  const { term } = pane;
  try {
    expect(await term.probeLink(5, 0, wake)).toBeNull();
    writeFileSync(join(dir, name), "ready");
    await term.probeLink(8, 0, wake);
    expect(term.pressLink(0, 0, wake)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await term.pressLink(8, 0, wake)).toMatchObject({ uri: name, file: join(dir, name) });
    expect(term.pressLink(6, 0, wake)).toBeNull();
    expect(term.resolvedFile(name)).toBe(join(dir, name));
    expect(calls).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected request leaves the cell retryable without polling on redraw", async () => {
  const hold = Promise.withResolvers<void>();
  const { calls, conn } = lookupServer(async () => {
    if (calls.length === 1) throw Error("Disconnected");
    await hold.promise;
    return { ok: true, target: null, range: { start: 5, end: 17 } };
  });
  using pane = displayed("See `new file.txt`.", conn);
  const { term } = pane;
  try {
    expect(await term.probeLink(6, 0, wake)).toBeNull();
    for (let i = 0; i < 10; i++) term.hoverLink(6, 0, () => true, wake);
    await Bun.sleep(100);
    expect(calls).toHaveLength(1);
    // A new probe can use the same cell; a click during that check shares its miss.
    const retry = term.probeLink(6, 0, wake);
    const click = term.pressLink(6, 0, wake);
    expect(calls).toHaveLength(2);
    hold.resolve();
    await Promise.all([retry, click]);
    expect(calls).toHaveLength(2);
  } finally {
    hold.resolve();
  }
});

test("a target ending at the right margin is complete before a soft-wrapped space", async () => {
  const term = Terminal.create(12, 4);
  try {
    const url = "https://example.org/abcd";
    term.feed(url + " words");
    const cells = term.native({ op: "linkWindow", x: 2, y: 1 });
    expect(await resolve(cells, 2, 1, null, filesWith())).toMatchObject({ uri: url });
  } finally {
    term.destroy();
  }
});

test("a click after a pending hover resolves its own cell, and obsolete underlines disappear", async () => {
  const hold = Promise.withResolvers<void>();
  const { calls, conn } = lookupServer(async ({ y }) => {
    if (y === 0) await hold.promise;
    const prefix = y === 0 ? "https://first.test/" : "https://second.test/";
    return {
      ok: true,
      target: {
        uri: prefix + "image",
        path: false,
        file: null,
        spans: [
          { row: y, start: 0, end: prefix.length },
          { row: y + 1, start: 0, end: 5 },
        ],
      },
    };
  });
  using pane = displayed("https://first.test/\r\nimage\r\n\r\nhttps://second.test/\r\nimage", conn, { height: 24 });
  const { term } = pane;
  try {
    const first = term.probeLink(1, 0, wake);
    const same = term.pressLink(2, 0, wake);
    const click = term.pressLink(1, 3, wake);
    expect(calls.map(q => q.y)).toEqual([0]);
    hold.resolve();
    await Promise.all([first, same, click]);
    expect(calls.map(q => q.y)).toEqual([0, 3]);
    const link = term.hyperlinks().find(l => l.row === 4)!;
    expect(link.uri).toBe("https://second.test/image");
    const picked = await term.pick("word", 1, 4);
    expect(picked?.copy).toBe(link.uri);
    expect(picked?.match).toEqual({ x: 0, y: 3, end_x: 4, end_y: 4 });
    term.pin(picked!.match!, picked!.shown);
    expect(term.pinnedMatches()).toBe(true);
    term.clearSelection();
    expect(calls.map(q => q.y)).toEqual([0, 3]);
    const painted = term.rows(1, 0, 0, 32, 24, false, link.id);
    expect(painted.split("https://second.test/image").length - 1).toBe(2);
    expect(painted).toMatch(/\x1b\[[0-9;]*\b4(?:;|m)/);
    expect(term.pressLink(2, 20, wake)).toBeNull();
    pane.feed("\x1b[4;1H\x1b[2Kplain text\x1b[5;1H\x1b[2K");
    expect(term.hyperlinks().some(l => l.uri === link.uri)).toBe(false);
  } finally {
    hold.resolve();
  }
});

test("returning to a pane renews its evidence watch after another pane took it", async () => {
  const { calls, conn } = lookupServer();
  const text = "https://example.org/im\r\nage";
  using first = displayed(text, conn);
  using second = displayed(text, conn, { id: 2 });
  for (const { term } of [first, second, first]) await term.probeLink(2, 0, wake);
  expect(calls.map(q => q.pane)).toEqual([1, 2, 1]);
});

test("a stalled lookup leaves a click pending without blocking input or issuing concurrent requests", async () => {
  const hold = Promise.withResolvers<void>();
  const { calls, conn } = lookupServer(async () => {
    await hold.promise;
    return { ok: true, target: null };
  });
  using pane = displayed("https://first.test/\r\nfirst\r\nhttps://second.test/\r\nsecond", conn, { height: 6 });
  const { term } = pane;
  try {
    const started = term.probeLink(2, 0, wake);
    const click = term.pressLink(2, 2, wake);
    expect(click).toBeInstanceOf(Promise);
    expect(calls).toHaveLength(1);
    hold.resolve();
    await Promise.all([started, click]);
    expect(calls).toHaveLength(2);
  } finally {
    hold.resolve();
  }
}, 1000);

test("a filesystem miss tries at most four distinct spellings", async () => {
  const cells = rows(
    ["tmp/path", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext"],
    8,
  );
  const probe = wrapped.inspect(cells, 1, 0, null),
    files = filesWith();
  expect(probe.matches.length).toBeGreaterThan(4);
  expect(await wrapped.resolve(probe, files, "/")).toBeNull();
  expect(new Set(files.checked).size).toBe(4);
  expect(files.checked).toHaveLength(4);
});

test("Markdown filenames cover the spaces on one row or across a word wrap", async () => {
  const files = filesWith("Release Notes", "a `draft` file.md", "assets/preview notes.txt");
  for (const [lines, name, at, spans] of [
    [["See `Release Notes`."], "Release Notes", [11, 0], [{ row: 0, start: 5, end: 18 }]],
    [["`` a `draft` file.md ``"], "a `draft` file.md", [10, 0], [{ row: 0, start: 3, end: 20 }]],
    [
      ["See ``assets/preview", "  notes.txt``."],
      "assets/preview notes.txt",
      [2, 1],
      [
        { row: 0, start: 6, end: 20 },
        { row: 1, start: 2, end: 11 },
      ],
    ],
  ] as const) {
    const [x, y] = at;
    expect(wrapped.regions([...lines], y).some(s => s.start <= x && x < s.end)).toBe(true);
    files.checked.length = 0;
    const target = await resolve(rows([...lines]), x, y, null, files, "/cwd");
    expect(target).toMatchObject({ uri: name, spans });
    expect(files.checked).toEqual([name]);
  }
  files.checked.length = 0;
  expect(await resolve(rows(["`Release Notes`"]), 0, 0, null, files, "/cwd")).toBeNull();
  expect(files.checked).toEqual([]);
});

test("a terminal period and backticks stay outside an extensionless file's hover span", async () => {
  const lines = ["Open `filename`."],
    cells = rows(lines);
  const files = filesWith("filename");
  expect(wrapped.regions(lines, 0)).toEqual([{ row: 0, start: 6, end: 14 }]);
  expect(await resolve(cells, 6, 0, null, files)).toMatchObject({ uri: "filename" });
  for (const x of [5, 14, 15]) expect(await resolve(cells, x, 0, null, files)).toBeNull();
  expect(files.checked).toEqual(["filename"]);
  expect(wrapped.regions(["Open filename."], 0, true)).toEqual([]);
});

test("a styled extensionless basename before a period needs exact transcript evidence", async () => {
  const t = Terminal.create(60, 4);
  const files = filesWith("filename");
  try {
    for (const tail of ["filename\x1b[0m.", "filename.\x1b[0m"]) {
      t.feed("\x1b[H\x1b[2JSee \x1b[38;5;45m" + tail);
      const lines = t.surface(1).surface.lines,
        cells = t.native({ op: "linkWindow", x: 5, y: 0 });
      const region = [{ row: 0, start: 4, end: 12 }],
        dictionary = new Dictionary();
      expect(wrapped.regions(lines, 0, false)).toEqual([]);
      expect(wrapped.regions(lines, 0, true)).toEqual(region);
      const probe = wrapped.inspect(cells, 5, 0, dictionary);
      expect(probe.missing.has("filename")).toBe(true);
      expect(await wrapped.resolve(probe, files, "/")).toBeNull();
      dictionary.add("See `filename`.");
      expect(await resolve(cells, 5, 0, dictionary, files)).toMatchObject({ uri: "filename", spans: region });
      expect(await resolve(cells, 12, 0, dictionary, files)).toBeNull();
    }
    expect(files.checked).toEqual(["filename", "filename"]);
  } finally {
    t.destroy();
  }
});

test("a sentence period on the next soft-wrapped row stays outside the filename", async () => {
  const dict = new Dictionary();
  dict.add("Open `filename`.");
  const files = filesWith("filename");
  for (const [width, text, start] of [
    [15, "Open `filename`.", 6],
    [13, "Open \x1b[38;5;45mfilename\x1b[0m.", 5],
  ] as const) {
    const t = Terminal.create(width, 3);
    try {
      t.feed(text);
      const region = [{ row: 0, start, end: start + 8 }];
      const cells = t.native({ op: "linkWindow", x: start, y: 0 });
      expect(wrapped.regions(t.surface(1).surface.lines, 0, true)).toEqual(region);
      expect(await resolve(cells, start, 0, dict, files)).toMatchObject({ uri: "filename", spans: region });
      expect(await resolve(cells, 0, 1, dict, files)).toBeNull();
    } finally {
      t.destroy();
    }
  }
});

test("rendered Markdown uses an exact transcript spelling before checking a multiword name", async () => {
  const lines = ["Open Release Notes.pdf now"],
    cells = rows(lines),
    x = 5;
  const dictionary = new Dictionary(),
    files = filesWith("Release Notes.pdf");
  expect(wrapped.regions(lines, 0, false)).toEqual([]);
  expect(wrapped.regions(lines, 0, true).some(s => s.start <= x && x < s.end)).toBe(true);
  const miss = wrapped.inspect(cells, x, 0, dictionary);
  expect(miss.missing.has("Release Notes.pdf")).toBe(true);
  expect(await wrapped.resolve(miss, files, "/cwd")).toBeNull();
  expect(files.checked).toEqual([]);
  dictionary.add("Open `Release Notes.pdf` now");
  const hit = await resolve(cells, x, 0, dictionary, files, "/cwd");
  expect(hit).toMatchObject({ uri: "Release Notes.pdf", spans: [{ row: 0, start: 5, end: 22 }] });
  expect(files.checked).toEqual(["Release Notes.pdf"]);
});

test("rendered titles, directory paths, and filenames with punctuation need conversation evidence", async () => {
  for (const path of ["Release Notes", "Makefile", "assets/Release Notes", "Q1 (draft) notes.pdf"]) {
    const lines = ["Open " + path + " now."],
      cells = rows(lines);
    const dictionary = new Dictionary();
    dictionary.add("`" + path + "`");
    const files = filesWith(path);
    expect(wrapped.regions(lines, 0, true).some(s => s.start <= 5 && 5 < s.end)).toBe(true);
    expect((await resolve(cells, 5, 0, dictionary, files))?.uri).toBe(path);
    expect(files.checked).toEqual([path]);
  }
  expect(wrapped.regions(["These are ordinary words in a sentence."], 0, true)).toEqual([]);
});

test("an earlier row's closing backticks cannot quote the prose before the next filename", async () => {
  const lines = ["Compare `old notes.md` with `new", "notes.md` then open `draft.md`."];
  const x = lines[1].indexOf("then");
  const files = filesWith();
  expect(wrapped.regions(lines, 1).some(s => s.start <= x && x < s.end)).toBe(false);
  expect(await resolve(rows(lines), x, 1, null, files)).toBeNull();
  expect(files.checked).toEqual([]);
});

test("a blank soft-wrapped row separates Markdown paragraphs on both sides of a lookup", async () => {
  const lines = ["An earlier paragraph had a stray `", " ".repeat(40), "See `Release Notes`."];
  const cells = rows(lines, 40);
  cells[1].wrap = cells[2].continued = true;
  expect(wrapped.regions(lines, 2)).toEqual([{ row: 2, start: 5, end: 18 }]);
  expect(await resolve(cells, 7, 2, null, filesWith("Release Notes"))).toMatchObject({ uri: "Release Notes" });
});

test("a styled lowercase code span resolves only after its complete spelling is in the transcript", async () => {
  const t = Terminal.create(60, 4),
    dictionary = new Dictionary(),
    files = filesWith("release notes");
  try {
    t.feed("Open \x1b[38;5;45mrelease notes\x1b[0m now");
    const lines = t.surface(1).surface.lines,
      cells = t.native({ op: "linkWindow", x: 5, y: 0 });
    expect(wrapped.regions(lines, 0, true).some(s => s.start === 5 && s.end === 18)).toBe(true);
    expect(await resolve(cells, 5, 0, dictionary, files)).toBeNull();
    expect(files.checked).toEqual([]);
    dictionary.add("Open `release notes` now");
    expect(await resolve(cells, 12, 0, dictionary, files)).toMatchObject({
      uri: "release notes",
      spans: [{ row: 0, start: 5, end: 18 }],
    });
    expect(files.checked).toEqual(["release notes"]);
  } finally {
    t.destroy();
  }
});
