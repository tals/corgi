import * as viewerRef from "./viewer_ref";
import { test, expect, setSystemTime, spyOn } from "bun:test";
import { State, geometry, copyAt, draw, filePath } from "./link_tooltip";
import type { Controller } from "./controller";
import { attached, mouse, onePane } from "./fixtures/viewer";
import * as viewer from "./viewer";
import * as viewerNative from "./viewer_native";
import * as palette from "./palette";
import * as protocol from "./protocol";
import { Writer } from "./text";
import { Rect } from "./layout";
import { png_base64 } from "./assets/corgi_badge";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Signin } from "./signin";
import { Terminal } from "./pane/terminal";
import { Menu } from "./corgi_setup";
const source = { updateRender() {}, hyperlinks: () => [] };
const pointed = { source, id: 1n, uri: "https://example.com", x: 5, y: 2 },
  retargeted = { ...pointed, uri: "https://other.example.com" };
test.each([
  [
    "resource card",
    { resource: viewerRef.workspace(1, 1) },
    { resource: viewerRef.workspace(1, 2) },
    { resource: viewerRef.workspace(1, 1) },
  ],
  // The same URL in another pane is another link.
  ["link", { link: pointed }, { link: retargeted }, { link: { ...retargeted, source: { ...source } } }],
] as const)(
  "a %s wakes the viewer after 150 ms, and each new target restarts the delay",
  (_, target, changed, next) => {
    const s = new State();
    s.move();
    expect(s.ready(target, 100)).toBe(false);
    expect(s.due(249)).toBe(false);
    expect(s.ready(target, 249)).toBe(false);
    expect(s.due(250)).toBe(true);
    expect(s.ready(target, 250)).toBe(true);
    expect(s.due(251)).toBe(false);
    expect(s.ready(changed, 251)).toBe(false);
    expect(s.due(400)).toBe(false);
    expect(s.ready(changed, 401)).toBe(true);
    expect(s.ready(next, 402)).toBe(false);
  },
);
test("a link found to name a file waits for its peek rather than showing its copy card", () => {
  const s = new State();
  s.move();
  expect(s.ready({ link: pointed }, 0)).toBe(false);
  expect(s.ready({ link: pointed, file: true }, 100)).toBe(false);
  expect(s.target?.file).toBe(true);
  expect(s.ready({ link: pointed, file: true }, 249)).toBe(false);
  expect(s.ready({ link: pointed, file: true }, 250)).toBe(true);
});
test("tooltip waits for rest and requires fresh movement after interaction", () => {
  const s = new State(),
    target = { git: viewerRef.workspace(1, 1) };
  expect(s.ready(target, 0)).toBe(false);
  s.move();
  expect(s.ready(target, 100)).toBe(false);
  expect(s.ready(target, 599)).toBe(false);
  expect(s.ready(target, 600)).toBe(true);
  s.cancel();
  expect(s.ready(target, 2000)).toBe(false);
  s.move();
  expect(s.ready(target, 2001)).toBe(false);
  expect(s.ready(target, 2501)).toBe(true);
  expect(s.ready({ git: viewerRef.workspace(1, 2) }, 2502)).toBe(false);
  expect(s.ready(null, 4000)).toBe(false);
  expect(s.ready(target, 4001)).toBe(false);
});

test("the link popover fits at screen edges and only its middle row copies", () => {
  const below = geometry(100, 30, { x: 40, y: 5 })!;
  expect(below).toMatchObject({ x: 40, y: 6, w: 17, h: 3 });
  const edge = geometry(100, 30, { x: 99, y: 29 })!;
  expect(edge).toMatchObject({ x: 83, y: 26, w: 17, h: 3 });
  expect(geometry(16, 30, { x: 0, y: 0 })).toBeNull();
  expect(geometry(100, 3, { x: 0, y: 0 })).toBeNull();
  expect(copyAt(below, 42, 7)).toBe(true);
  expect(copyAt(below, 40, 7)).toBe(false);
  expect(copyAt(below, 42, 6)).toBe(false);
});

test("both link popover labels keep the right border aligned and stay inside the box", () => {
  const terminal = new Terminal(40, 10);
  try {
    for (const x of [2, 39]) {
      const rect = geometry(40, 10, { x, y: 5 })!;
      for (const [uri, label] of [
        ["https://example.com", "c  Copy link"],
        ["file:///tmp/shot.png", "c  Copy path"],
        ["https://example.com", "✓  Copied"],
      ]) {
        const w = new Writer();
        for (let y = 0; y < 10; y++) w.write(`\x1b[${y + 1};1H` + "#".repeat(40));
        const link = { source, id: 1n, uri, x, y: 5 };
        draw(w, rect, { link, copied: label.includes("Copied"), thumbnail: null }, "copy");
        terminal.feed(w.buffered());
        const rows = terminal.text().split("\n");
        expect(rows[rect.y][rect.x + rect.w - 1]).toBe("┐");
        expect(rows[rect.y + 1][rect.x + rect.w - 1]).toBe("│");
        expect(rows[rect.y + 2][rect.x + rect.w - 1]).toBe("┘");
        expect(rows[rect.y + 1]).toContain(label);
        if (rect.x + rect.w < 40) expect(rows[rect.y + 1][rect.x + rect.w]).toBe("#");
        expect(rows[rect.y + 3]).toBe("#".repeat(40));
      }
    }
  } finally {
    terminal.destroy();
  }
});

const url = "https://example.com/docs";
function linkViewer(output = url, host: "pane" | "signin" = "pane", height = 30) {
  const s = attached(100, height);
  s.sidebar_open = false;
  s.receiveSnapshot(onePane({}, { cols: 100 }));
  if (host === "signin") {
    const signin = new Signin(true, false, { changed() {}, done() {} });
    signin.provider = "claude";
    signin.child = Terminal.create(s.width - 2, s.height - 5);
    signin.resize(s.width, s.height);
    signin.child.feed(output);
    s.signin = signin;
  } else {
    const source = new Terminal(100, height - 1);
    try {
      source.feed(output);
      s.runtime.pane(1)!.terminal.receive(source.surface(1));
    } finally {
      source.destroy();
    }
  }
  s.frame();
  return s;
}
function close(s: Controller) {
  s.signin?.child?.destroy();
  s.signin = null;
  viewer.close(s);
}

test.each(["pane", "signin"] as const)(
  "%s link popover waits, stays reachable, copies, and confirms inline",
  async host => {
    for (const output of [
      url,
      `\x1b]8;;${url}\x1b\\Named docs\x1b]8;;\x1b\\`,
      `\x1b]8;;${url}\x1b\\\x1b[1;4;38;5;33mfoo\x1b[0m\x1b]8;;\x1b\\`,
    ]) {
      const s = linkViewer(output, host);
      try {
        setSystemTime(new Date(1000));
        await s.input(mouse(35, 2, 1));
        const initial = s.frame();
        expect(initial).not.toContain("Copy link");
        expect(initial).toContain("\x1b]22;pointer\x1b\\");
        expect(initial).toContain("\x1b[4m");
        setSystemTime(new Date(1149));
        expect(s.frame()).not.toContain("Copy link");
        s.dirty = false;
        setSystemTime(new Date(1150));
        await s.expireInput();
        expect(s.dirty).toBe(true);
        const frame = s.frame();
        const rendered = new Terminal(s.width, s.height);
        try {
          rendered.feed(frame);
          expect(rendered.text()).toContain("Copy link");
          viewerNative.updateRender(rendered.handle);
          expect(viewerNative.cursor(rendered.handle)).toBeNull();
        } finally {
          rendered.destroy();
        }
        await s.input(mouse(35, 2, 2)); // Cross the top border.
        expect(s.frame()).toContain("Copy link");
        await s.input(mouse(35, 4, 3));
        expect(s.frame()).toContain("\x1b]22;pointer\x1b\\");
        await s.input(mouse(0, 4, 3));
        expect(s.clipboard).toBeNull();
        await s.input(mouse(0, 4, 3, true));
        expect(s.clipboard).toBe(url);
        expect(s.effects).toEqual([{ write_terminal: `\x1b]52;c;${Buffer.from(url).toString("base64")}\x07` }]);
        expect(s.frame()).toMatch(/✓ +Copied/);
        expect(s.frame()).not.toContain("Copied to clipboard");
        setSystemTime(new Date(2150));
        await s.expireInput();
        expect(s.frame()).toContain("Copy link");
        await s.input(mouse(35, 90, 20));
        expect(s.frame()).not.toContain("Copy link");
      } finally {
        setSystemTime();
        close(s);
      }
    }
  },
);

test.each(["pane", "signin"] as const)("%s link popover dismisses on input or changed content", async host => {
  const s = linkViewer(url, host);
  const child = s.signin?.child ?? s.runtime.pane(1)!.terminal.inner;
  const send = spyOn(child, "send").mockImplementation(() => {});
  let now = 1000;
  const show = async () => {
    now += 1000;
    setSystemTime(new Date(now));
    await s.input(mouse(35, 3, 1));
    s.frame();
    setSystemTime(new Date(now + 150));
    expect(s.frame()).toContain("Copy link");
  };
  try {
    for (const input of [Buffer.from("a"), mouse(64, 3, 1), mouse(0, 3, 1)]) {
      await show();
      await s.input(input);
      expect(s.frame()).not.toContain("Copy link");
      setSystemTime(new Date(now + 1000));
      expect(s.frame()).not.toContain("Copy link");
      await s.input(mouse(0, 4, 1, true));
      await s.input(mouse(35, 90, 20));
    }
    await show();
    await s.input(mouse(35, 4, 3));
    child.feed("\r\x1b[2Kgone");
    s.runtime.pane(1)!.terminal.render_dirty = true;
    expect(s.frame()).not.toContain("Copy link");
    await s.input(mouse(0, 4, 3));
    await s.input(mouse(0, 4, 3, true));
    expect(s.clipboard).toBeNull();
  } finally {
    setSystemTime();
    send.mockRestore();
    close(s);
  }
});

test.each(["pane", "signin"] as const)(
  "%s card takes its keys while it shows, but not from sign-in or review typing",
  async host => {
    const s = linkViewer(url, host);
    const child = s.signin?.child ?? s.runtime.pane(1)!.terminal.inner;
    const send = spyOn(child, "send").mockImplementation(() => {});
    const show = async (at: number) => {
      setSystemTime(new Date(at));
      await s.input(mouse(35, 3, 1));
      s.frame();
      setSystemTime(new Date(at + 150));
      const rendered = new Terminal(s.width, s.height);
      try {
        rendered.feed(s.frame());
        return rendered.text();
      } finally {
        rendered.destroy();
      }
    };
    try {
      const shown = await show(1000);
      await s.input(Buffer.from("c"));
      if (host === "pane") {
        expect(shown).toMatch(/│  c  Copy link +│/);
        expect(s.clipboard).toBe(url);
        expect(s.frame()).toMatch(/✓ +Copied/);
        // While the review panel has the keyboard, the card leaves typing to it.
        await s.input(mouse(35, 90, 20));
        await s.input(Buffer.from("\x02e"));
        expect(s.keyboard).toBe("review");
        s.clipboard = null;
        expect(await show(3000)).toMatch(/│ {5}Copy link +│/);
        await s.input(Buffer.from("c"));
        expect(s.clipboard).toBeNull();
      } else {
        // Sign-in takes typing, so its card shows no keys and c reaches it.
        expect(shown).toMatch(/│ {5}Copy link +│/);
        expect(s.clipboard).toBeNull();
        expect(send).toHaveBeenCalled();
        expect(s.frame()).not.toContain("Copy link");
      }
    } finally {
      setSystemTime();
      send.mockRestore();
      close(s);
    }
  },
);

test.each(["pane", "signin"] as const)(
  "%s popover clicks and cancelled drags do not reach mouse-aware programs",
  async host => {
    const s = linkViewer("\x1b[?1003h\x1b[?1006h" + url, host);
    const terminal = s.signin?.child ?? s.runtime.pane(1)!.terminal;
    const send = spyOn(terminal, "send").mockImplementation(() => {});
    try {
      setSystemTime(new Date(1000));
      await s.input(mouse(35, 2, 1));
      s.frame();
      setSystemTime(new Date(1150));
      expect(s.frame()).toContain("Copy link");
      expect(send).toHaveBeenCalled(); // Motion still reaches a program that asks for it.
      send.mockClear();
      await s.input(mouse(35, 4, 3));
      await s.input(mouse(0, 4, 3));
      await s.input(mouse(0, 4, 3, true));
      expect(s.clipboard).toBe(url);
      expect(send).not.toHaveBeenCalled();
      await s.input(mouse(35, 4, 3));
      await s.input(mouse(0, 4, 3));
      await s.input(mouse(32, 90, 20));
      s.frame();
      await s.input(mouse(0, 90, 20, true));
      expect(s.clipboard).toBe(url);
      expect(send).not.toHaveBeenCalled();
    } finally {
      setSystemTime();
      send.mockRestore();
      close(s);
    }
  },
);

test("the sign-in copies the whole wrapped URL from a continuation row", async () => {
  const wrapped = "https://example.com/authorize?state=" + "abcdef".repeat(30);
  const s = linkViewer(wrapped, "signin");
  try {
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 8, 2));
    s.frame();
    setSystemTime(new Date(1150));
    expect(s.frame()).toContain("Copy link");
    await s.input(mouse(35, 10, 4));
    await s.input(mouse(0, 10, 4));
    await s.input(mouse(0, 10, 4, true));
    expect(s.clipboard).toBe(wrapped);
  } finally {
    setSystemTime();
    close(s);
  }
});

test("sign-in selections and dialogs hide the link card and never target the pane behind them", async () => {
  const s = linkViewer(url, "signin");
  const signin = s.signin! as Signin;
  s.runtime.pane(1)!.terminal.inner.feed(url);
  s.runtime.pane(1)!.terminal.render_dirty = true;
  const show = async (now: number) => {
    setSystemTime(new Date(now));
    await s.input(mouse(35, 90, 20));
    await s.input(mouse(35, 2, 1));
    s.frame();
    setSystemTime(new Date(now + 150));
    expect(s.frame()).toContain("Copy link");
  };
  try {
    await show(1000);
    await s.input(mouse(0, 1, 1));
    await s.input(mouse(32, 8, 1));
    expect(s.frame()).not.toContain("Copy link");
    await s.input(mouse(0, 8, 1, true));
    expect(s.clipboard).toBe("https://");
    expect(s.frame()).not.toContain("Copy link");
    signin.child!.clearSelection();
    await show(2000);
    signin.working = "Checking sign-in…";
    expect(s.frame()).not.toContain("Copy link");
    expect(s.frame()).toContain("\x1b]22;default\x1b\\");
    signin.working = null;
    await show(3000);
    signin.stopped("Sign-in failed.");
    expect(signin.stage.kind).toBe("dialog");
    expect(s.frame()).not.toContain("Copy link");
    await s.input(mouse(35, 3, 1));
    s.frame();
    setSystemTime(new Date(4000));
    expect(s.frame()).not.toContain("Copy link");
    expect(s.frame()).toContain("\x1b]22;default\x1b\\");
  } finally {
    setSystemTime();
    close(s);
  }
});

test("file links copy their path", () => {
  expect(filePath("file:///tmp/corgi-501/paste/a%20shot.png")).toBe("/tmp/corgi-501/paste/a shot.png");
  expect(filePath("FILE://localhost/Users/me/notes.md")).toBe("/Users/me/notes.md");
  expect(filePath("file://other-host/srv/log.txt")).toBe("/srv/log.txt");
  expect(filePath("https://example.com/a.png")).toBeNull();
});

test("a thumbnail grows the popover under its copy row and needs room on one side", () => {
  const cell = { width: 10, height: 20 },
    thumbnail = { width: 235, height: 90, cell };
  const below = geometry(100, 30, { x: 40, y: 5 }, thumbnail)!;
  expect(below).toMatchObject({ x: 40, y: 6, w: 26, h: 9 });
  expect(copyAt(below, 42, 7)).toBe(true);
  expect(copyAt(below, 42, 9)).toBe(false);
  expect(geometry(100, 30, { x: 40, y: 25 }, thumbnail)).toMatchObject({ y: 16, h: 9 });
  expect(geometry(100, 12, { x: 40, y: 6 }, thumbnail)).toBeNull();
  expect(geometry(100, 12, { x: 40, y: 6 })).not.toBeNull();
  expect(geometry(100, 30, { x: 40, y: 5 }, { width: 30, height: 20, cell })).toMatchObject({ w: 17, h: 5 });
});

test("a file link's popover offers and copies its path", async () => {
  const s = linkViewer("\x1b]8;;file:///tmp/corgi%20shot.png\x1b\\[Image #1]\x1b]8;;\x1b\\");
  try {
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 2, 1));
    s.frame();
    setSystemTime(new Date(1150));
    expect(s.frame()).toContain("Copy path");
    await s.input(mouse(0, 4, 3));
    await s.input(mouse(0, 4, 3, true));
    expect(s.clipboard).toBe("/tmp/corgi shot.png");
    expect(s.effects).toEqual([
      { write_terminal: `\x1b]52;c;${Buffer.from("/tmp/corgi shot.png").toString("base64")}\x07` },
    ]);
  } finally {
    setSystemTime();
    viewer.close(s);
  }
});

test("an image link's popover copies its path and opens the original from its thumbnail or button", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, await new Bun.Image(Buffer.from(png_base64, "base64")).resize(1000, 400).png().buffer());
  const s = linkViewer(`\x1b]8;;file://${path}\x1b\\[Image #1]\x1b]8;;\x1b\\`);
  s.host.opens_desktop = true;
  s.supports_kitty_graphics = true;
  s.cell_pixels = { width: 10, height: 20 };
  try {
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 2, 1));
    s.frame();
    // It loads once the link is known to name a file.
    await Promise.all(s.file_refs.checks);
    s.frame();
    await s.thumbnails.loading;
    expect(s.dirty).toBe(true);
    setSystemTime(new Date(1150));
    const frame = s.frame();
    expect(frame).toContain("Copy path");
    expect(frame).toContain("Open image");
    expect(frame).toContain("├" + "─".repeat(64) + "┤");
    // 1000×400 shrinks to 280×112: 28 cells by 6, centered in the rows under the Open row and rule.
    const shown = s.host.images.present(),
      id = /\x1b\[7;4H\x1b_Ga=p,i=(\d+),p=\d+,Y=2,z=1,C=1,q=1\x1b\\/.exec(shown.draw)?.[1];
    expect(id).toBeDefined();
    // The viewer sends it ahead of the frame, once.
    expect(shown.send).toContain(`\x1b_Ga=t,t=d,f=100,i=${id},q=1,m=`);
    s.frame();
    expect(s.host.images.present()).toMatchObject({ send: "", draw: "" });
    await s.input(mouse(0, 4, 3));
    await s.input(mouse(0, 4, 3, true));
    expect(s.clipboard).toBe(path);
    s.clearEffects();
    await s.input(mouse(0, 4, 3));
    await s.input(mouse(0, 4, 6, true));
    expect(s.effects).toEqual([]);
    await s.input(mouse(0, 4, 6));
    await s.input(mouse(0, 4, 6, true));
    expect(s.effects).toEqual([{ open_image: path }]);
    await s.input(mouse(35, 2, 1));
    s.clearEffects();
    const binding = spyOn(s.prefs, "bindings").mockReturnValue([
      { key: 111, mods: { alt: true }, prefixed: false, action: { name: "open-image" } },
    ]);
    try {
      await s.input(Buffer.from("\x1b[111;3u"));
      expect(s.effects).toEqual([{ open_image: path }]);
    } finally {
      binding.mockRestore();
    }
    s.clearEffects();
    await viewer.receive(
      s,
      {
        type: "view",
        viewer_protocol: protocol.viewer_version,
        session: null,
        session_hash: 0,
        resources: null,
        resources_hash: 0,
        surfaces: [],
        controls: [{ seq: 1, kind: "action", name: "open-image" }],
        viewer: 1,
        bell_seq: 0,
        bell_kind: "none",
        detach: false,
      },
      { seq: 0n },
      false,
    );
    expect(s.effects).toEqual([{ open_image: path }]);
    await s.input(mouse(35, 90, 20));
    s.frame();
    const closed = s.host.images.present();
    expect(closed.draw).toContain(`a=d,d=i,i=${id},`);
    expect(closed.redraw).not.toContain(`a=p,i=${id},`);
    expect(closed.free).toContain(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`);
    s.supports_kitty_graphics = false;
    s.clearEffects();
    await s.input(mouse(35, 2, 1));
    s.frame();
    setSystemTime(new Date(1300));
    expect(s.frame()).toContain("Open image");
    await s.input(mouse(0, 4, 4));
    await s.input(mouse(0, 4, 4, true));
    expect(s.effects).toEqual([{ open_image: path }]);
    s.host.opens_desktop = false;
    s.supports_kitty_graphics = true;
    s.clearEffects();
    const headless = s.frame();
    expect(headless).toContain("Copy path");
    expect(headless).not.toContain("Open image");
    expect(s.host.images.present().draw).toContain(`a=p,i=${id},`);
    await s.input(mouse(0, 4, 6));
    await s.input(mouse(0, 4, 6, true));
    expect(s.effects).toEqual([]);
  } finally {
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a card shows its keys as keycaps with Open above the picture, and takes c and o while shown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, await new Bun.Image(Buffer.from(png_base64, "base64")).resize(1000, 400).png().buffer());
  const s = linkViewer(`\x1b]8;;file://${path}\x1b\\[Image #1]\x1b]8;;\x1b\\`);
  s.host.opens_desktop = true;
  s.supports_kitty_graphics = true;
  s.cell_pixels = { width: 10, height: 20 };
  const show = async (at: number) => {
    await s.input(mouse(35, 90, 20));
    setSystemTime(new Date(at));
    await s.input(mouse(35, 2, 1));
    s.frame();
    await Promise.all(s.file_refs.checks);
    s.frame();
    await s.thumbnails.loading;
    setSystemTime(new Date(at + 150));
    return s.frame();
  };
  try {
    const rendered = new Terminal(s.width, s.height);
    try {
      rendered.feed(await show(1000));
      const rows = rendered.text().split("\n");
      expect(rows[3]).toMatch(/│  c  Copy path +│/);
      expect(rows[4]).toMatch(/│  o  Open image +│/);
      expect(rows[5]).toMatch(/├─+┤/);
    } finally {
      rendered.destroy();
    }
    // c copies and the card stays to confirm it; o opens the image.
    await s.input(Buffer.from("c"));
    expect(s.clipboard).toBe(path);
    expect(s.frame()).toMatch(/✓ +Copied/);
    s.clearEffects();
    await s.input(Buffer.from("o"));
    expect(s.effects).toEqual([{ open_image: path }]);
    // Other keys dismiss the card and reach the pane, and so do c and o after it.
    s.clipboard = null;
    await s.input(Buffer.from("x"));
    expect(s.frame()).not.toContain("Copy path");
    s.clearEffects();
    await s.input(Buffer.from("co"));
    expect(s.clipboard).toBeNull();
    expect(s.effects).toEqual([]);
    // Without a desktop the card has no Open row, and o goes to the pane.
    s.host.opens_desktop = false;
    expect(await show(2000)).toContain("Copy path");
    await s.input(Buffer.from("o"));
    expect(s.effects).toEqual([]);
    expect(s.frame()).not.toContain("Copy path");
  } finally {
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("arrows choose a card's row, which Enter acts on and Escape closes, until the pointer moves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, Buffer.from(png_base64, "base64"));
  const s = linkViewer(`\x1b]8;;file://${path}\x1b\\[Image #1]\x1b]8;;\x1b\\`);
  s.host.opens_desktop = true;
  const sent = spyOn(s as any, "sendInput").mockImplementation(() => {});
  const show = async (at: number) => {
    await s.input(mouse(35, 90, 20));
    setSystemTime(new Date(at));
    await s.input(mouse(35, 2, 1));
    s.frame();
    await Promise.all(s.file_refs.checks);
    setSystemTime(new Date(at + 150));
    expect(s.frame()).toContain("Open image");
  };
  const chosen = () => s.link_tooltip.chosen?.button ?? null;
  try {
    await show(1000);
    // Down comes in at the top row, and up at the bottom one; the next ones move, and stop at the ends.
    const lit = (key: string) =>
      new palette.Style({ fg: "strong", bg: "selected" }).sgr() + " " + palette.keycap + ` ${key} `;
    await s.input(Buffer.from("\x1b[B"));
    expect(chosen()).toBe("copy");
    expect(s.frame()).toContain(lit("c"));
    await s.input(Buffer.from("\x1b[B"));
    await s.input(Buffer.from("\x1b[B"));
    expect(chosen()).toBe("open");
    const frame = s.frame();
    expect([frame.includes(lit("c")), frame.includes(lit("o"))]).toEqual([false, true]);
    await s.input(Buffer.from("\r"));
    expect(s.effects).toEqual([{ open_image: path }]);
    await s.input(Buffer.from("\x1b[A"));
    await s.input(Buffer.from("\r"));
    expect(s.clipboard).toBe(path);
    expect(s.frame()).toMatch(/✓ +Copied/);
    // Escape closes the card rather than reach the pane, as Kitty's Escape does.
    await s.input(Buffer.from("\x1b"));
    await s.expireInput();
    expect(s.frame()).not.toContain("Copy path");
    await show(2000);
    await s.input(Buffer.from("\x1b[A"));
    expect(chosen()).toBe("open");
    await s.input(Buffer.from("\x1b[A"));
    await s.input(Buffer.from("\x1b[A"));
    expect(chosen()).toBe("copy");
    await s.input(Buffer.from("\x1b[27u"));
    expect(s.frame()).not.toContain("Copy path");
    expect(sent).not.toHaveBeenCalled();
    // The pointer moving takes over from the arrows, and Enter goes to the pane.
    await show(3000);
    await s.input(Buffer.from("\x1b[B"));
    await s.input(mouse(35, 3, 1));
    s.clipboard = null;
    s.clearEffects();
    await s.input(Buffer.from("\r"));
    expect([s.clipboard, s.effects]).toEqual([null, []]);
    expect(sent).toHaveBeenCalled();
  } finally {
    sent.mockRestore();
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("an image card too tight for both keeps its picture and leaves opening to the shortcut", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, await new Bun.Image(Buffer.from(png_base64, "base64")).resize(1000, 400).png().buffer());
  // Three rows fit a picture below the link, and none above it.
  const s = linkViewer(`\x1b[4;1H\x1b]8;;file://${path}\x1b\\[Image #1]\x1b]8;;\x1b\\`, "pane", 12);
  s.host.opens_desktop = true;
  s.cell_pixels = { width: 10, height: 20 };
  const binding = spyOn(s.prefs, "bindings").mockReturnValue([
    { key: 111, mods: { alt: true }, prefixed: false, action: { name: "open-image" } },
  ]);
  try {
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 2, 4));
    s.frame();
    await Promise.all(s.file_refs.checks);
    setSystemTime(new Date(1150));
    // Without a picture, the card has room for the open row.
    expect(s.frame()).toContain("Open image");
    s.supports_kitty_graphics = true;
    s.frame();
    await s.thumbnails.loading;
    const frame = s.frame();
    expect(frame).toContain("Copy path");
    expect(frame).not.toContain("Open image");
    expect(s.host.images.present().draw).toContain("a=p,");
    // The picture and the card's key still open it.
    await s.input(mouse(0, 4, 8));
    await s.input(mouse(0, 4, 8, true));
    expect(s.effects).toEqual([{ open_image: path }]);
    s.clearEffects();
    await s.input(Buffer.from("o"));
    expect(s.effects).toEqual([{ open_image: path }]);
    s.clearEffects();
    await s.input(Buffer.from("\x1b[111;3u"));
    expect(s.effects).toEqual([{ open_image: path }]);
  } finally {
    binding.mockRestore();
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("the image shortcut leaves alone a link a card covers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-image-covered-"));
  const path = join(dir, "secret.png");
  writeFileSync(path, Buffer.from(png_base64, "base64"));
  const s = linkViewer(`\x1b[6;1H\x1b]8;;file://${path}\x1b\\[Image]\x1b]8;;\x1b\\`);
  s.host.opens_desktop = true;
  const binding = spyOn(s.prefs, "bindings").mockReturnValue([
    { key: 111, mods: { alt: true }, prefixed: false, action: { name: "open-image" } },
  ]);
  try {
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 2, 6));
    s.frame();
    await Promise.all(s.file_refs.checks);
    s.connection_card = { rect: new Rect(0, 4, 40, 5), lines: [{ text: "atlas · online" }] };
    await s.input(Buffer.from("\x1b[111;3u"));
    expect(s.effects).toEqual([]);
    s.connection_card = null;
    await s.input(Buffer.from("\x1b[111;3u"));
    expect(s.effects).toEqual([{ open_image: path }]);
  } finally {
    binding.mockRestore();
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test.each([
  ["preview", true, 6],
  ["Open image button", false, 4],
] as const)("image shortcuts over the %s open the card's link", async (_, graphics, row) => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-image-shortcut-"));
  const original = join(dir, "original.png"),
    underneath = join(dir, "underneath.png");
  const png = Buffer.from(png_base64, "base64");
  writeFileSync(original, png);
  writeFileSync(underneath, png);
  const link = (path: string) => `\x1b]8;;file://${path}\x1b\\[Image]\x1b]8;;\x1b\\`;
  const s = linkViewer(link(original) + `\x1b[${row};1H` + link(underneath));
  s.host.opens_desktop = true;
  s.supports_kitty_graphics = graphics;
  s.cell_pixels = { width: 10, height: 20 };
  s.prefs.prefix = "ctrl+b";
  const binding = spyOn(s.prefs, "bindings").mockReturnValue([
    { key: 111, mods: { alt: true }, prefixed: false, action: { name: "open-image" } },
    { key: 111, mods: {}, prefixed: false, action: { name: "open-image" } },
    { key: 111, mods: {}, prefixed: true, action: { name: "open-image" } },
  ]);
  const show = async (at: number) => {
    setSystemTime(new Date(at));
    await s.input(mouse(35, 2, 1));
    s.frame();
    await Promise.all(s.file_refs.checks);
    s.frame();
    await s.thumbnails.loading;
    setSystemTime(new Date(at + 150));
    expect(s.frame()).toContain("Open image");
    await s.input(mouse(35, 4, row));
    expect(s.frame()).toContain("Open image");
  };
  try {
    // Resolve the link the card will cover so falling through to it would open a different file.
    setSystemTime(new Date(1000));
    await s.input(mouse(35, 4, row));
    s.frame();
    await Promise.all(s.file_refs.checks);
    await s.input(Buffer.from("\x1b[111;3u"));
    expect(s.effects).toEqual([{ open_image: underneath }]);
    s.clearEffects();

    await show(1200);
    await s.input(Buffer.from("\x1b[111;3u"));
    expect(s.effects).toEqual([{ open_image: original }]);
    s.clearEffects();

    await show(1400);
    await s.input(Buffer.from("\x02"));
    s.frame();
    await s.input(Buffer.from("o"));
    expect(s.effects).toEqual([{ open_image: original }]);
    s.clearEffects();

    await show(1600);
    await s.input(Buffer.from("\x02"));
    await s.input(mouse(35, 90, 20));
    await s.input(Buffer.from("o"));
    expect(s.effects).toEqual([]);

    await show(1800);
    await s.input(Buffer.from("\x02"));
    await s.input(Buffer.from("xo"));
    expect(s.effects).toEqual([{ open_image: underneath }]);
    s.clearEffects();

    await show(2000);
    await s.input(Buffer.from("\x02"));
    const updated = new Terminal(100, 29);
    try {
      updated.feed(link(underneath) + `\x1b[${row};1H` + link(underneath));
      s.runtime.pane(1)!.terminal.receive(updated.surface(2));
      await s.input(Buffer.from("o"));
      expect(s.effects).toEqual([]);
    } finally {
      updated.destroy();
    }
  } finally {
    binding.mockRestore();
    setSystemTime();
    viewer.close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("an arrow over the resource card selects its top row first, or else moves from the hovered one", async () => {
  const s = linkViewer();
  s.prefs.resources.enabled = true;
  s.runtime.receiveResources({
    workspaces: [
      {
        id: 1,
        cpu: 30,
        processes: [
          { pid: 10, start: 1, name: "first", cpu: 20 },
          { pid: 11, start: 1, name: "second", cpu: 10 },
          { pid: 12, start: 1, name: "third", cpu: 5 },
        ],
      },
    ],
  } as any);
  const hover = () => {
    s.resource_card.release();
    s.link_tooltip.target = { resource: s.workspaceRef(1) };
    s.link_tooltip.shown = true;
    s.resource_card.update({ ...s.runtime.resources.workspaces[0], id: s.workspaceRef(1) }, true);
  };
  hover();
  await s.input(Buffer.from("\x1b[B"));
  expect([s.resource_card.pinned, s.resource_card.selected?.pid]).toEqual([true, 10]);
  await s.input(Buffer.from("\x1b[B"));
  expect(s.resource_card.selected?.pid).toBe(11);
  hover();
  s.resource_card.selected = s.resource_card.order[1];
  await s.input(Buffer.from("\x1b[B"));
  expect([s.resource_card.pinned, s.resource_card.selected?.pid]).toEqual([true, 12]);
});

test("setup's issue link shows the link card, which copies it", async () => {
  const s = linkViewer("");
  const setup = Menu.open();
  setup.item = "report_bug";
  // Already under way, so drawing doesn't ask the real daemon.
  (setup as unknown as { gathering: boolean }).gathering = true;
  setup.report = {
    corgi: "1.2.3 (abc1234), linux-x64",
    install: { path: "/usr/bin/corgi", auto_update: null },
    system: {
      os: "Ubuntu 24.04.1 LTS",
      os_timed_out: false,
      kernel: "Linux 6.8.0",
      locale: "C.UTF-8",
      shell: { path: "/usr/bin/fish", version: "fish, version 3.7.1" },
      agents: [],
    },
    daemon: null,
    slow: { daemon: false, sessions: false, report: false },
    terminal: null,
    overrides: [],
    logs: { server: "/tmp/server.log", crashes: 0 },
    warnings: [],
    hook_trouble: null,
    inference: null,
  };
  s.corgi_setup = setup;
  try {
    setSystemTime(new Date(1000));
    s.frame();
    const [link] = setup.hyperlinks();
    expect(link.uri).toContain("https://github.com/tals/corgi/issues/new?body=");
    await s.input(mouse(35, link.start + 2, link.row));
    s.frame();
    setSystemTime(new Date(1150));
    await s.expireInput();
    expect(s.frame()).toContain("Copy link");
    await s.input(mouse(35, link.start + 4, link.row + 2));
    await s.input(mouse(0, link.start + 4, link.row + 2));
    await s.input(mouse(0, link.start + 4, link.row + 2, true));
    expect(s.clipboard).toBe(link.uri);
    expect(s.frame()).toMatch(/✓ +Copied/);
  } finally {
    setSystemTime();
    close(s);
  }
});
