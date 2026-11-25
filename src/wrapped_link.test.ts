import { expect, test } from "bun:test";
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
    await t.probeLink(2, 20, () => {});
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

test("a stalled lookup releases a click without sending another request", async () => {
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
    await t.pressLink(2, 2, () => {});
    expect(calls).toBe(1);
    hold.resolve();
    await started;
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
