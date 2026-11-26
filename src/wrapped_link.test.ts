import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as wrapped from "./wrapped_link";
import { Dictionary } from "./link_evidence";
import { Terminal } from "./pane/terminal";
import * as mirror from "./mirror";
import { transport } from "./fixtures/transport";

function resolve(
  rows: wrapped.Row[],
  x: number,
  y: number,
  known: Dictionary | null,
  files: Parameters<typeof wrapped.resolve>[1],
  cwd: string,
) {
  return wrapped.resolve(wrapped.inspect(rows, x, y, known), files, cwd);
}

function rows(text: string[], cols = 50): wrapped.Row[] {
  return text.map((s, row) => ({ row, wrap: false, cells: [...s.padEnd(cols)] }));
}
const noFiles = {
  async find(): Promise<never> {
    throw Error("unexpected file");
  },
};
test("feed evidence joins eight hard-wrapped rows from either edge and the middle without file IO", async () => {
  const parts = ["https://example.org/", "inter", "medi", "ate/", "a/", "b/", "image.", "png"];
  const url = parts.join(""),
    dict = new Dictionary(),
    cells = rows(parts);
  dict.add(url);
  for (const y of [0, 2, 7]) {
    const result = await resolve(cells, 1, y, dict, noFiles, "/");
    expect(result?.uri).toBe(url);
    expect(result?.spans).toHaveLength(8);
    expect(
      wrapped
        .regions(
          cells.map(r => r.cells.join("")),
          y,
        )
        .some(s => s.start <= 1 && s.end > 1),
    ).toBe(true);
  }
});
test("use the owning filesystem for soft-wrapped image paths and preserve wide-cell coordinates", async () => {
  const term = Terminal.create(17, 4),
    tried: string[] = [];
  const file = "docs/help-small.png";
  try {
    term.feed("界 " + file);
    const cells = term.native({ op: "linkWindow", x: 1, y: 1 });
    const found = await resolve(
      cells,
      1,
      1,
      null,
      {
        async find(path, cwd) {
          tried.push(path);
          expect(cwd).toBe("/repo");
          if (path !== file) throw Error("missing");
          return { path: "/repo/" + path, size: 1, id: "x", mtime: 0 };
        },
      },
      "/repo",
    );
    expect(tried).toEqual([file]);
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
    let reads = 0;
    const files = {
      async find(): Promise<never> {
        reads++;
        throw Error("missing");
      },
    };
    expect(await resolve(rows(["public/", "index.html"]), 1, 1, dict, files, "/")).toBeNull();
    expect(reads).toBe(0);
    term.feed("https://abc/" + "x".repeat(119));
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 0 }), 2, 0, dict, files, "/")).toBeNull();
    term.feed("\x1b[2J\x1b[Hhttps://abc/" + "x".repeat(83) + ".org/rest");
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 0 }), 2, 0, dict, files, "/")).toBeNull();
    term.feed("\x1b[2J\x1b[Hsrc/dir\r\n\x1b]8;;https://other.test\x1b\\file.ts\x1b]8;;\x1b\\");
    dict.add("src/dirfile.ts");
    expect(await resolve(term.native({ op: "linkWindow", x: 2, y: 1 }), 2, 1, dict, files, "/")).toBeNull();
  } finally {
    term.destroy();
  }
});
test("pointer travel, ordinary text and repeated redraws incur no extra requests; a notice retries a stationary hit", async () => {
  const source = Terminal.create(32, 24),
    calls: string[] = [];
  const conn = transport(async op => {
    calls.push(op);
    return { ok: true, target: null, range: { start: 0, end: 23 } };
  });
  const t = new mirror.Terminal(conn, 1, 32, 24);
  try {
    source.feed("some ordinary prose\r\nmore words here\r\n\r\nhttps://example.org/abc\r\ndef");
    t.receive(source.surface(1));
    t.linkContext(0n, true, "/repo");
    for (let x = 0; x < 20; x++)
      t.hoverLink(
        x,
        0,
        () => true,
        () => {},
      );
    await Bun.sleep(100);
    expect(calls).toEqual([]);
    for (let x = 1; x < 12; x++)
      t.hoverLink(
        x,
        3,
        () => true,
        () => {},
      );
    await Bun.sleep(100);
    expect(calls).toEqual(["viewer.wrapped_link"]);
    for (let x = 0; x < 20; x++) await t.probeLink(x, 3, () => {});
    for (let i = 0; i < 20; i++) {
      source.feed("\x1b[20;1H" + i);
      t.receive(source.surface(1));
      await t.probeLink(11, 3, () => {});
    }
    expect(calls).toHaveLength(1);
    t.linkNotice(1);
    await t.probeLink(11, 3, () => {});
    expect(calls).toHaveLength(2);
  } finally {
    source.destroy();
    t.destroy();
  }
});

test("a click retries a completed hover miss after the named file appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    name = "new file.txt";
  const source = Terminal.create(32, 4);
  let requests = 0;
  const conn = transport(async (_op, fields) => {
    requests++;
    const { x, y } = fields as { x: number; y: number };
    const probe = wrapped.inspect(source.native({ op: "linkWindow", x, y }), x, y, null);
    return { ok: true, target: await wrapped.resolve(probe, fileAccess.here, dir), range: probe.range };
  });
  const term = new mirror.Terminal(conn, 1, 32, 4);
  try {
    source.feed("See `new file.txt`.");
    term.receive(source.surface(1));
    term.linkContext(0n, true, dir);
    expect(await term.probeLink(5, 0, () => {})).toBeNull();
    writeFileSync(join(dir, name), "ready");
    await term.probeLink(8, 0, () => {});
    expect(term.pressLink(0, 0, () => {})).toBeNull();
    expect(requests).toBe(1);
    expect(await term.pressLink(8, 0, () => {})).toMatchObject({ uri: name, file: join(dir, name) });
    expect(term.pressLink(6, 0, () => {})).toBeNull();
    expect(term.wrappedFile(name)).toBe(join(dir, name));
    expect(requests).toBe(2);
  } finally {
    term.destroy();
    source.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected request leaves the cell retryable without polling on redraw", async () => {
  const source = Terminal.create(32, 4),
    hold = Promise.withResolvers<void>();
  let requests = 0;
  const conn = transport(async () => {
    requests++;
    if (requests === 1) throw Error("Disconnected");
    await hold.promise;
    return { ok: true, target: null, range: { start: 5, end: 17 } };
  });
  const term = new mirror.Terminal(conn, 1, 32, 4);
  try {
    source.feed("See `new file.txt`.");
    term.receive(source.surface(1));
    term.linkContext(0n, true, "/repo");
    expect(await term.probeLink(6, 0, () => {})).toBeNull();
    for (let i = 0; i < 10; i++)
      term.hoverLink(
        6,
        0,
        () => true,
        () => {},
      );
    await Bun.sleep(100);
    expect(requests).toBe(1);
    // A new probe can use the same cell; a click during that check shares its miss.
    const retry = term.probeLink(6, 0, () => {});
    const click = term.pressLink(6, 0, () => {});
    expect(requests).toBe(2);
    hold.resolve();
    await Promise.all([retry, click]);
    expect(requests).toBe(2);
  } finally {
    hold.resolve();
    term.destroy();
    source.destroy();
  }
});

test("a target ending at the right margin is complete before a soft-wrapped space", async () => {
  const term = Terminal.create(12, 4);
  try {
    const url = "https://example.org/abcd";
    term.feed(url + " words");
    const cells = term.native({ op: "linkWindow", x: 2, y: 1 });
    expect(await resolve(cells, 2, 1, null, noFiles, "/")).toMatchObject({ uri: url });
  } finally {
    term.destroy();
  }
});

test("a click after a pending hover resolves its own cell, and obsolete underlines disappear", async () => {
  const source = Terminal.create(32, 24);
  const hold = Promise.withResolvers<void>();
  const requests: number[] = [];
  const conn = transport(async (_op, fields) => {
    const { y } = fields as { y: number };
    requests.push(y);
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
  const t = new mirror.Terminal(conn, 1, 32, 24);
  try {
    source.feed("https://first.test/\r\nimage\r\n\r\nhttps://second.test/\r\nimage");
    t.receive(source.surface(1));
    t.linkContext(0n, true, "/repo");
    const first = t.probeLink(1, 0, () => {});
    const same = t.pressLink(2, 0, () => {});
    const click = t.pressLink(1, 3, () => {});
    expect(requests).toEqual([0]);
    hold.resolve();
    await Promise.all([first, same, click]);
    expect(requests).toEqual([0, 3]);
    const link = t.hyperlinks().find(l => l.row === 4)!;
    expect(link.uri).toBe("https://second.test/image");
    const picked = await t.pick("word", 1, 4);
    expect(picked?.copy).toBe(link.uri);
    expect(picked?.match).toEqual({ x: 0, y: 3, end_x: 4, end_y: 4 });
    t.pin(picked!.match!, picked!.shown);
    expect(t.pinnedMatches()).toBe(true);
    t.clearSelection();
    expect(requests).toEqual([0, 3]);
    const painted = t.rows(1, 0, 0, 32, 24, false, link.id);
    expect(painted.split("https://second.test/image").length - 1).toBe(2);
    expect(painted).toMatch(/\x1b\[[0-9;]*\b4(?:;|m)/);
    expect(t.pressLink(2, 20, () => {})).toBeNull();
    source.feed("\x1b[4;1H\x1b[2Kplain text\x1b[5;1H\x1b[2K");
    t.receive(source.surface(1));
    expect(t.hyperlinks().some(l => l.uri === link.uri)).toBe(false);
  } finally {
    hold.resolve();
    t.destroy();
    source.destroy();
  }
});

test("returning to a pane renews its evidence watch after another pane took it", async () => {
  const source = Terminal.create(32, 4),
    requests: number[] = [];
  const conn = transport(async (_op, fields) => {
    requests.push((fields as { pane: number }).pane);
    return { ok: true, target: null };
  });
  const panes = [1, 2].map(id => new mirror.Terminal(conn, id, 32, 4));
  try {
    source.feed("https://example.org/im\r\nage");
    for (const pane of panes) {
      pane.receive(source.surface(pane.id));
      pane.linkContext(0n, true, "/repo");
    }
    for (const pane of [panes[0], panes[1], panes[0]]) await pane.probeLink(2, 0, () => {});
    expect(requests).toEqual([1, 2, 1]);
  } finally {
    for (const pane of panes) pane.destroy();
    source.destroy();
  }
});

test("a stalled lookup leaves a click pending without blocking input or issuing concurrent requests", async () => {
  const hold = Promise.withResolvers<void>();
  let calls = 0;
  const conn = transport(async () => {
    calls++;
    await hold.promise;
    return { ok: true, target: null };
  });
  const source = Terminal.create(32, 6),
    t = new mirror.Terminal(conn, 1, 32, 6);
  try {
    source.feed("https://first.test/\r\nfirst\r\nhttps://second.test/\r\nsecond");
    t.receive(source.surface(1));
    t.linkContext(0n, true, "/repo");
    const started = t.probeLink(2, 0, () => {});
    const click = t.pressLink(2, 2, () => {});
    expect(click).toBeInstanceOf(Promise);
    expect(calls).toBe(1);
    hold.resolve();
    await Promise.all([started, click]);
    expect(calls).toBe(2);
  } finally {
    hold.resolve();
    t.destroy();
    source.destroy();
  }
}, 1000);

test("a filesystem miss tries at most four distinct spellings", async () => {
  const cells = rows(
    ["tmp/path", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext", "file.ext"],
    8,
  );
  const probe = wrapped.inspect(cells, 1, 0, null),
    checked: string[] = [];
  expect(probe.matches.length).toBeGreaterThan(4);
  const target = await wrapped.resolve(
    probe,
    {
      async find(path) {
        checked.push(path);
        throw Error("missing");
      },
    },
    "/",
  );
  expect(target).toBeNull();
  expect(new Set(checked).size).toBe(4);
  expect(checked).toHaveLength(4);
});

test("Markdown filenames cover the spaces on one row or across a word wrap", async () => {
  const tried: string[] = [];
  const files = {
    async find(path: string) {
      tried.push(path);
      if (!["Release Notes", "a `draft` file.md", "assets/preview notes.txt"].includes(path)) throw Error("missing");
      return { path: "/cwd/" + path, size: 2, mtime: 0, id: path };
    },
  };
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
    tried.length = 0;
    const target = await resolve(rows([...lines]), x, y, null, files, "/cwd");
    expect(target).toMatchObject({ uri: name, spans });
    expect(tried).toEqual([name]);
  }
  tried.length = 0;
  expect(await resolve(rows(["`Release Notes`"]), 0, 0, null, files, "/cwd")).toBeNull();
  expect(tried).toEqual([]);
});

test("a terminal period and backticks stay outside an extensionless file's hover span", async () => {
  const lines = ["Open `filename`."],
    cells = rows(lines);
  const checked: string[] = [];
  const files = {
    async find(path: string) {
      checked.push(path);
      return { path, size: 1, mtime: 0, id: path };
    },
  };
  expect(wrapped.regions(lines, 0)).toEqual([{ row: 0, start: 6, end: 14 }]);
  expect(await resolve(cells, 6, 0, null, files, "/")).toMatchObject({ uri: "filename" });
  for (const x of [5, 14, 15]) expect(await resolve(cells, x, 0, null, files, "/")).toBeNull();
  expect(checked).toEqual(["filename"]);
  expect(wrapped.regions(["Open filename."], 0, true)).toEqual([]);
});

test("a styled extensionless basename before a period needs exact transcript evidence", async () => {
  const t = Terminal.create(60, 4);
  const checked: string[] = [];
  const files = {
    async find(path: string) {
      checked.push(path);
      return { path, size: 1, mtime: 0, id: path };
    },
  };
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
      expect(await resolve(cells, 5, 0, dictionary, files, "/")).toMatchObject({ uri: "filename", spans: region });
      expect(await resolve(cells, 12, 0, dictionary, files, "/")).toBeNull();
    }
    expect(checked).toEqual(["filename", "filename"]);
  } finally {
    t.destroy();
  }
});

test("a sentence period on the next soft-wrapped row stays outside the filename", async () => {
  const dict = new Dictionary();
  dict.add("Open `filename`.");
  const files = {
    async find(path: string) {
      return { path, size: 1, mtime: 0, id: path };
    },
  };
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
      expect(await resolve(cells, start, 0, dict, files, "/")).toMatchObject({ uri: "filename", spans: region });
      expect(await resolve(cells, 0, 1, dict, files, "/")).toBeNull();
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
    tried: string[] = [];
  const files = {
    async find(path: string) {
      tried.push(path);
      return { path, size: 1, mtime: 0, id: path };
    },
  };
  expect(wrapped.regions(lines, 0, false)).toEqual([]);
  expect(wrapped.regions(lines, 0, true).some(s => s.start <= x && x < s.end)).toBe(true);
  const miss = wrapped.inspect(cells, x, 0, dictionary);
  expect(miss.missing.has("Release Notes.pdf")).toBe(true);
  expect(await wrapped.resolve(miss, files, "/cwd")).toBeNull();
  expect(tried).toEqual([]);
  dictionary.add("Open `Release Notes.pdf` now");
  const hit = await resolve(cells, x, 0, dictionary, files, "/cwd");
  expect(hit).toMatchObject({ uri: "Release Notes.pdf", spans: [{ row: 0, start: 5, end: 22 }] });
  expect(tried).toEqual(["Release Notes.pdf"]);
});

test("rendered titles, directory paths, and filenames with punctuation need conversation evidence", async () => {
  for (const path of ["Release Notes", "Makefile", "assets/Release Notes", "Q1 (draft) notes.pdf"]) {
    const lines = ["Open " + path + " now."],
      cells = rows(lines);
    const dictionary = new Dictionary();
    dictionary.add("`" + path + "`");
    const tried: string[] = [];
    const files = {
      async find(name: string) {
        tried.push(name);
        if (name !== path) throw Error("missing");
        return { path: name, size: 1, mtime: 0, id: name };
      },
    };
    expect(wrapped.regions(lines, 0, true).some(s => s.start <= 5 && 5 < s.end)).toBe(true);
    expect((await resolve(cells, 5, 0, dictionary, files, "/"))?.uri).toBe(path);
    expect(tried).toEqual([path]);
  }
  expect(wrapped.regions(["These are ordinary words in a sentence."], 0, true)).toEqual([]);
});

test("an earlier row's closing backticks cannot quote the prose before the next filename", async () => {
  const lines = ["Compare `old notes.md` with `new", "notes.md` then open `draft.md`."];
  const x = lines[1].indexOf("then");
  const checked: string[] = [];
  const files = {
    async find(path: string) {
      checked.push(path);
      throw Error("missing");
    },
  };
  expect(wrapped.regions(lines, 1).some(s => s.start <= x && x < s.end)).toBe(false);
  expect(await resolve(rows(lines), x, 1, null, files, "/")).toBeNull();
  expect(checked).toEqual([]);
});

test("a styled lowercase code span resolves only after its complete spelling is in the transcript", async () => {
  const t = Terminal.create(60, 4),
    dictionary = new Dictionary(),
    checked: string[] = [];
  const files = {
    async find(path: string) {
      checked.push(path);
      return { path, size: 1, mtime: 0, id: path };
    },
  };
  try {
    t.feed("Open \x1b[38;5;45mrelease notes\x1b[0m now");
    const lines = t.surface(1).surface.lines,
      cells = t.native({ op: "linkWindow", x: 5, y: 0 });
    expect(wrapped.regions(lines, 0, true).some(s => s.start === 5 && s.end === 18)).toBe(true);
    expect(await resolve(cells, 5, 0, dictionary, files, "/")).toBeNull();
    expect(checked).toEqual([]);
    dictionary.add("Open `release notes` now");
    expect(await resolve(cells, 12, 0, dictionary, files, "/")).toMatchObject({
      uri: "release notes",
      spans: [{ row: 0, start: 5, end: 18 }],
    });
    expect(checked).toEqual(["release notes"]);
  } finally {
    t.destroy();
  }
});
