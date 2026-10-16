import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Browser,
  Dialog,
  create_hold_ms,
  eased,
  isFolder,
  label,
  make,
  ring_lit,
  size,
  stat,
  subfolders,
  type Found,
} from "./new_workspace";
import { printable } from "./name_dialog";
import { Writer } from "./text";
import { Style, bgRgb, colors, fgRgb, mix } from "./palette";

const c = (s: string) => s.charCodeAt(0);
const tree: Record<string, string[]> = {
  "/": ["home", "tmp"],
  "/home": ["me"],
  "/home/me": [".config", "code", "Documents", "docs"],
  "/home/me/code": ["corgi", "other"],
  "/home/me/code/corgi": [],
};
const fake = (folder: string) => (folder.endsWith("/locked") ? null : (tree[folder] ?? null));
const folder: Found = { kind: "folder", size: 0, modified: 0 };
/** Things in the tree that aren't folders. */
const others: Record<string, Found> = {
  "/home/me/code/notes": { kind: "file", size: 2048, modified: Date.now() - 3 * 86400 * 1000 },
};
/** The tree's folders and others; one called "locked" is there but can't be read. */
const at = (path: string) => (path in tree || path.endsWith("/locked") ? folder : (others[path] ?? null));
const browse = (cwd = "/home/me") => Browser.init(cwd, "/home/me", fake, at);

test("the browser starts at the folder and lists the folders in it", () => {
  const b = browse("/home/me/code");
  expect(b.field.raw()).toBe("~/code/");
  expect(b.entries).toEqual(["corgi", "other"]);
  expect(b.folder()).toBe("/home/me/code");
  expect(browse("/").field.raw()).toBe("/");
  expect(browse("/").entries).toEqual(["home", "tmp"]);
});

test("typing filters by the name after the last slash; a dot shows dot folders", () => {
  const b = browse();
  b.focused = true;
  b.key(c("d"));
  expect(b.entries).toEqual(["Documents", "docs"]);
  b.key(c("o"));
  b.key(c("c"));
  b.key(c("s"));
  expect(b.entries).toEqual(["docs"]);
  for (let i = 0; i < 4; i++) b.key(127);
  b.key(c("."));
  expect(b.entries).toEqual([".config"]);
  b.key(127);
  expect(b.entries).toEqual(["code", "Documents", "docs"]);
});

test("moving through the list writes each folder into the field, and back to what was typed", () => {
  const b = browse();
  b.key(c("d"));
  b.sequence("\x1b[B");
  expect(b.field.raw()).toBe("~/Documents");
  expect(b.folder()).toBe("/home/me/Documents");
  b.sequence("\x1b[B");
  expect(b.highlight).toBe(1);
  expect(b.field.raw()).toBe("~/docs");
  // The list stays as typed while browsing it.
  expect(b.entries).toEqual(["Documents", "docs"]);
  // Past them, the offer to create leaves the field as typed.
  b.sequence("\x1b[B");
  b.sequence("\x1b[B");
  expect(b.highlight).toBe(2);
  expect(b.field.raw()).toBe("~/d");
  for (let i = 0; i < 3; i++) b.sequence("\x1b[A");
  expect(b.highlight).toBeNull();
  expect(b.field.raw()).toBe("~/d");
});

test("right opens the highlighted folder and left goes up, each picking the first folder there", () => {
  const b = browse();
  // At the end of the folder the field names, left goes up.
  b.sequence("\x1b[D");
  expect(b.entries).toEqual(["me"]);
  expect(b.highlight).toBe(0);
  expect(b.field.raw()).toBe("/home/me");
  b.sequence("\x1b[C");
  expect(b.field.raw()).toBe("~/code");
  b.sequence("\x1b[C");
  expect(b.entries).toEqual(["corgi", "other"]);
  expect(b.field.raw()).toBe("~/code/corgi");
  b.sequence("\x1b[D");
  expect(b.field.raw()).toBe("~/code");
  b.sequence("\x1b[D");
  b.sequence("\x1b[D");
  expect(b.field.raw()).toBe("/home");
  // Above the first entry is the folder itself.
  b.sequence("\x1b[A");
  expect(b.field.raw()).toBe("/");
  // Right at the end of a name opens the first folder it starts.
  b.key(c("h"));
  b.sequence("\x1b[C");
  expect(b.field.raw()).toBe("/home/me");
  // Inside the text, left and right move the cursor.
  b.key(127);
  b.sequence("\x1b[D");
  b.sequence("\x1b[D");
  expect(b.field.raw()).toBe("/home/m");
  expect(b.field.cursor).toBe(5);
  b.sequence("\x1b[C");
  expect(b.field.cursor).toBe(6);
});

test("opening a folder writes it plainly", () => {
  const b = browse("/home/me/code");
  for (const byte of Buffer.from("../")) b.paste(byte);
  b.move(1);
  expect(b.field.raw()).toBe("~/code/../code");
  b.open();
  expect(b.field.raw()).toBe("~/code/corgi");
});

test("the field resolves home, relative names and dot-dots", () => {
  const b = browse("/home/me/code");
  for (const [text, folder] of [
    ["~", "/home/me"],
    ["corgi/", "/home/me/code/corgi"],
    ["../docs", "/home/me/docs"],
    ["/tmp/", "/tmp"],
    ["", "/home/me/code"],
  ]) {
    b.field.clear();
    for (const byte of Buffer.from(text)) b.paste(byte);
    expect(b.folder()).toBe(folder);
  }
  expect(label("/home/meow", "/home/me")).toBe("/home/meow");
});

test("an unreadable folder says so", () => {
  const b = browse("/home/me");
  for (const byte of Buffer.from("locked/")) b.paste(byte);
  expect(b.readable).toBe(false);
  expect(b.entries).toEqual([]);
  expect(b.create).toBeNull();
  const d = new Dialog(b);
  const w = new Writer();
  d.view(100, 30)!.draw(d, w, 1);
  expect(w.s).toContain("Can't read this folder");
});

test("clicking an entry highlights it, and clicking it again opens it", () => {
  const b = browse("/home/me/code");
  b.click({ tag: "entry", index: 0 }, 0);
  expect(b.focused).toBe(true);
  expect(b.field.raw()).toBe("~/code/corgi");
  // An empty folder has nothing to pick.
  b.click({ tag: "entry", index: 0 }, 0);
  expect(b.field.raw()).toBe("~/code/corgi/");
  expect(b.highlight).toBeNull();
  b.click({ tag: "up" }, 0);
  expect(b.field.raw()).toBe("~/code/corgi");
});

test("the window keeps the highlight in view", () => {
  tree["/many"] = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const b = browse("/many");
  expect(b.window(5)).toBe(0);
  for (let i = 0; i < 8; i++) b.move(1);
  expect(b.window(5)).toBe(3);
  b.move(-1);
  expect(b.window(5)).toBe(3);
  for (let i = 0; i < 5; i++) b.move(-1);
  expect(b.window(5)).toBe(1);
});

test("the dialog moves between the name and the folder with tab", () => {
  const d = new Dialog(browse());
  d.key(c("x"));
  expect(d.name()).toBe("x");
  d.key(9);
  d.key(c("c"));
  expect(d.name()).toBe("x");
  expect(d.browser.field.raw()).toBe("~/c");
  d.browser.problem = "not_created";
  d.key(127);
  expect(d.browser.problem).toBeNull();
  // Enter alone doesn't create; it's held.
  expect(d.key(13)).toBe("none");
  d.sequence("\x1b[Z");
  expect(d.browser.focused).toBe(false);
  d.sequence("\x1b[B");
  expect(d.browser.highlight).toBeNull();
});

test("the new-workspace card shows the folders and answers clicks on them", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const f = v.folders;
  expect(f.rows).toBe(10);
  expect(v.height).toBe(23);
  expect(f.label_y - v.field_y).toBe(2);
  expect(v.hit(v.text_x, v.field_y)).toEqual({ tag: "field", field: 0 });
  expect(v.at(v.text_x + 2, f.field_y)).toEqual({ tag: "folder", field: 2 });
  expect(v.at(v.text_x, f.list_y + 1)).toEqual({ tag: "entry", index: 1 });
  expect(v.at(v.text_x, f.list_y + 3)).toEqual({ tag: "none" });
  const hits = v.buttons().map(b => v.at(b.x, v.buttons_y).tag);
  expect(hits).toEqual(["save", "up", "cancel"]);
  const arrows = v.buttons()[1];
  expect(v.at(arrows.x + 5, v.buttons_y).tag).toBe("open");
  expect(v.at(arrows.x + arrows.width - 1, v.buttons_y).tag).toBe("open");
  const w = new Writer();
  d.browser.move(1);
  v.draw(d, w, 3);
  for (const text of ["New workspace", "Name", "Folder", "~/code/corgi", "▌", "other", "create"])
    expect(w.s).toContain(text);
  // Without room for the list, the plain dialog takes over.
  expect(d.view(100, 17)).toBeNull();
  expect(d.view(100, 18)!.folders.rows).toBe(3);
});

test("subfolders lists folders and links to them, sorted", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-folders-"));
  mkdirSync(join(root, "b"));
  mkdirSync(join(root, "A"));
  writeFileSync(join(root, "file"), "");
  symlinkSync(join(root, "b"), join(root, "link"));
  symlinkSync(join(root, "gone"), join(root, "dangling"));
  expect(subfolders(root)).toEqual(["A", "b", "link"]);
  expect(subfolders(join(root, "file"))).toBeNull();
  expect(isFolder(join(root, "link"))).toBe(true);
  expect(isFolder(join(root, "file"))).toBe(false);
  rmSync(root, { recursive: true });
});

test("folder names never reach the terminal as controls", () => {
  expect(printable("a\x1b[2Jb\x7f\u009b31mc")).toBe("a?[2Jb??31mc");
  const evil = "\x1b]0;x\x07\u009b2J";
  tree["/evil"] = [evil];
  const d = new Dialog(browse("/evil"));
  d.browser.focused = true;
  d.browser.move(1);
  expect(d.browser.field.raw()).toBe("/evil/" + evil);
  const w = new Writer();
  d.view(100, 30)!.draw(d, w, 1);
  expect(w.s).not.toContain("\x07");
  expect(w.s).not.toContain("\u009b");
  expect(w.s).not.toContain("\x1b]0;");
  expect(w.s).toContain("/evil/?]0;x??2J");
});

test("a missing folder is made, with the folders above it, when the workspace is created", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  writeFileSync(join(root, "file"), "");
  const b = Browser.init(root, "/nowhere", subfolders);
  expect(b.confirm()).toBe(root);
  for (const byte of Buffer.from("new/deeper")) b.paste(byte);
  expect(b.create).toBe("new/deeper");
  expect(b.confirm()).toBe(join(root, "new/deeper"));
  expect(isFolder(join(root, "new/deeper"))).toBe(true);
  // A link to a folder gives the folder's own path, as `corgi action open` does.
  symlinkSync(join(root, "new"), join(root, "link"));
  expect(Browser.init(join(root, "link"), "/nowhere", subfolders).confirm()).toBe(join(root, "new"));
  b.field.clear();
  for (const byte of Buffer.from("file")) b.paste(byte);
  expect(b.create).toBeNull();
  expect(b.confirm()).toBeNull();
  expect(b.problem).toBe("not_folder");
  expect(make(join(root, "file", "under"))).toBe(false);
  rmSync(root, { recursive: true });
});

test("a folder that isn't there is offered to create, nested too", () => {
  const b = browse("/home/me/code");
  for (const byte of Buffer.from("co")) b.paste(byte);
  expect(b.entries).toEqual(["corgi"]);
  expect(b.create).toBe("co");
  for (const byte of Buffer.from("/new/deeper")) b.paste(byte);
  expect(b.entries).toEqual([]);
  expect(b.create).toBe("co/new/deeper");
  expect(b.count()).toBe(1);
  const d = new Dialog(b);
  const w = new Writer();
  d.view(100, 30)!.draw(d, w, 1);
  expect(w.s).toContain("Create ");
  expect(w.s).toContain("co/new/deeper");
  expect(w.s).not.toContain("Can't read this folder");
  // A folder that is there offers nothing.
  for (let i = 0; i < "/new/deeper".length; i++) b.key(127);
  for (const byte of Buffer.from("rgi")) b.paste(byte);
  expect(b.create).toBeNull();
});

test("opening the offer makes the folders and lists the last", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  const b = Browser.init(root, "/nowhere", subfolders);
  for (const byte of Buffer.from("a/b")) b.paste(byte);
  b.move(1);
  expect(b.highlight).toBe(0);
  expect(b.field.raw()).toBe(root + "/a/b");
  b.sequence("\x1b[C");
  expect(isFolder(join(root, "a/b"))).toBe(true);
  expect(b.field.raw()).toBe(root + "/a/b/");
  expect(b.create).toBeNull();
  rmSync(root, { recursive: true });
});

test("the name follows the folder until it is edited", () => {
  const d = new Dialog(browse("/home/me/code"));
  expect(d.name()).toBe("code");
  expect(d.selected).toBe(true);
  // Typing starts in the name; down goes to the folder.
  expect(d.browser!.focused).toBe(false);
  d.sequence("\x1b[B");
  expect(d.browser!.focused).toBe(true);
  d.sequence("\x1b[B");
  expect(d.name()).toBe("corgi");
  d.sequence("\x1b[C");
  for (const byte of Buffer.from("new_task")) d.key(byte);
  expect(d.browser!.field.raw()).toBe("~/code/corgi/new_task");
  expect(d.name()).toBe("new_task");
  expect(d.follows_folder).toBe(true);
  // Moving through the name doesn't edit it.
  d.key(9);
  d.sequence("\x1b[F");
  expect(d.follows_folder).toBe(true);
  d.key(c("s"));
  expect(d.follows_folder).toBe(false);
  d.key(9);
  d.key(127);
  expect(d.name()).toBe("new_tasks");
});

test("clearing the name stops it following", () => {
  const d = new Dialog(browse("/home/me/code"));
  d.key(3);
  expect(d.follows_folder).toBe(false);
  d.sequence("\x1b[B");
  d.sequence("\x1b[B");
  expect(d.name()).toBe("");
});

test("up and down go round the name, the folder and its folders", () => {
  const d = new Dialog(browse("/home/me/code"));
  const b = d.browser!;
  d.sequence("\x1b[B");
  expect(b.focused).toBe(true);
  expect(b.highlight).toBeNull();
  for (let i = 0; i < 2; i++) d.sequence("\x1b[B");
  expect(b.field.raw()).toBe("~/code/other");
  expect(d.name()).toBe("other");
  // Past the bottom, back to the name, the folder as typed.
  d.sequence("\x1b[B");
  expect(b.focused).toBe(false);
  expect(b.field.raw()).toBe("~/code/");
  expect(d.name()).toBe("code");
  // Up from the name is the bottom of the list.
  d.sequence("\x1b[A");
  expect(b.focused).toBe(true);
  expect(b.highlight).toBe(1);
  for (let i = 0; i < 2; i++) d.sequence("\x1b[A");
  expect(b.highlight).toBeNull();
  d.sequence("\x1b[A");
  expect(b.focused).toBe(false);
  // With no folders listed, the name, the field and the offer to create.
  d.key(9);
  d.key(c("x"));
  d.key(9);
  d.sequence("\x1b[B");
  expect(b.focused).toBe(true);
  expect(b.entries).toEqual([]);
  d.sequence("\x1b[B");
  expect(b.highlight).toBe(0);
  expect(b.create).toBe("x");
  d.sequence("\x1b[B");
  expect(b.focused).toBe(false);
});

test("a workspace is created on a hold of enter, not a tap", () => {
  const d = new Dialog(browse());
  const hold = d.create!;
  expect(d.key(13, 0)).toBe("none");
  hold.advance(300);
  expect(hold.progress).toBeGreaterThan(0);
  // Let go, it drains away.
  hold.advance(3000);
  expect(hold.active).toBe(false);
  // Held, it creates on the repeat that comes once the border has closed.
  let now = 5000,
    saved = null;
  expect(d.key(13, now)).toBe("none");
  for (now += 400; now < 5000 + create_hold_ms + 3000 && saved === null; now += 30)
    if (d.key(13, now) === "save") saved = now;
  expect(saved).not.toBeNull();
  expect(saved! - 5000).toBeGreaterThanOrEqual(create_hold_ms);
  expect(hold.active).toBe(false);
  // The key still down afterwards doesn't start another.
  expect(d.key(13, now)).toBe("none");
  expect(hold.active).toBe(false);
});

test("the create button is held with the mouse until it fills", () => {
  const d = new Dialog(browse());
  const hold = d.create!;
  hold.down(0);
  hold.advance(500);
  expect(hold.done()).toBe(false);
  hold.release(500);
  hold.advance(2000);
  expect(hold.active).toBe(false);
  hold.down(3000);
  hold.advance(3000 + create_hold_ms - 100);
  expect(hold.done()).toBe(false);
  hold.advance(3000 + create_hold_ms);
  expect(hold.done()).toBe(true);
});

test("holding enter lights the card's border from the bottom", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const lit = (progress: number) => {
    d.ring.x = progress;
    const w = new Writer();
    v.draw(d, w, 1);
    // The border cells written in the accent, a cursor move and a character each.
    const after = w.s.split(ring_lit)[1] ?? "";
    return after.match(/^(?:\x1b\[\d+;\d+H[^\x1b])*/)![0].match(/\x1b\[\d+;\d+H/g) ?? [];
  };
  expect(lit(0)).toEqual([]);
  const bottom = `\x1b[${v.y + v.height};${v.x + Math.floor(v.width / 2) + 1}H`;
  expect(lit(0.1)).toContain(bottom);
  expect(lit(0.1)).not.toContain(`\x1b[${v.y + 1};${v.x + Math.floor(v.width / 2) + 1}H`);
  expect(lit(1).length).toBe(2 * (v.width + v.height) - 4);
  // Less than a cell, as the spring comes to rest, lights nothing.
  expect(lit(0.002)).toEqual([]);
});

test("the name is selected only until the keys first leave it", () => {
  const d = new Dialog(browse("/home/me/code"));
  expect(d.selected).toBe(true);
  d.sequence("\x1b[B");
  expect(d.selected).toBe(false);
  d.sequence("\x1b[B");
  expect(d.name()).toBe("corgi");
  // Back on the name, typing adds to it.
  d.key(9);
  expect(d.selected).toBe(false);
  d.key(c("2"));
  expect(d.name()).toBe("corgi2");
});

test("the arrows are keys of their own, quiet until the folder has the keys", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const arrows = v.buttons()[1];
  expect(arrows.split).toBe(true);
  expect(v.at(arrows.x + 1, v.buttons_y).tag).toBe("up");
  expect(v.at(arrows.x + 5, v.buttons_y).tag).toBe("open");
  expect(v.at(arrows.x + arrows.width - 1, v.buttons_y).tag).toBe("open");
  expect(v.buttons().map(b => b.label)).toEqual(["hold to create", "out / in", "cancel"]);
  const quiet = fgRgb(colors.line) + bgRgb(mix(colors.surface, colors.selected, 50)) + " ← ";
  const drawn = () => {
    const w = new Writer();
    v.draw(d, w, 1);
    return w.s;
  };
  expect(drawn()).toContain(quiet);
  d.sequence("\x1b[B");
  expect(drawn()).not.toContain(quiet);
  expect(drawn()).toContain(" → ");
});

test("a tap of enter fills the border until its repeat is due, then snaps it back", () => {
  const d = new Dialog(browse());
  expect(d.key(13, 1000)).toBe("none");
  // A swing counts once it is past a cell of the border.
  const cell = 1 / 80;
  let highest = 0,
    lowest = 0,
    swings = 0,
    side = 1,
    now = 1000;
  for (; d.animate(now) && now < 4000; now += 16) {
    // It keeps up with the key, and stops within a frame of when the repeat was due.
    if (now >= 1450 && d.ring.x > 0) expect(d.ring.x).toBeLessThan(highest + cell / 2);
    highest = Math.max(highest, d.ring.x);
    lowest = Math.min(lowest, d.ring.x);
    if (Math.abs(d.ring.x) >= cell && Math.sign(d.ring.x) !== side) {
      swings++;
      side = Math.sign(d.ring.x);
    }
  }
  expect(highest).toBeCloseTo(eased(400 / create_hold_ms), 2);
  expect(lowest).toBeLessThan(0);
  expect(swings).toBeLessThanOrEqual(1);
  // It comes to rest, and stops asking for frames.
  expect(now).toBeLessThan(3000);
  expect(d.ring.x).toBe(0);
  expect(d.moving).toBe(false);
});

test("the border fills fast, then slows to close, still moving at the end", () => {
  expect(eased(0)).toBe(0);
  expect(eased(1)).toBe(1);
  expect(eased(0.33)).toBeGreaterThan(0.5);
  for (let p = 0; p < 1; p += 0.01) expect(eased(p + 0.01)).toBeGreaterThan(eased(p));
  // Twice the hold's pace at first; at the end, half of it, never still.
  expect(eased(0.001) / 0.001).toBeGreaterThan(1.99);
  expect((1 - eased(0.999)) / 0.001).toBeGreaterThan(0.49);
});

test("a full hold snaps the border back like a rubber band, bouncing once", () => {
  const d = new Dialog(browse());
  const cell = 1 / 80;
  let saved = false,
    now = 0;
  d.key(13, 0);
  for (; !saved && now < create_hold_ms + 3000; now += 16) {
    if (now >= 400) saved = d.key(13, now) === "save";
    d.animate(now);
  }
  expect(saved).toBe(true);
  expect(d.ring.x).toBeGreaterThan(0.9);
  let lowest = 0,
    swings = 0,
    side = 1;
  for (const end = now + 3000; d.animate(now) && now < end; now += 16) {
    lowest = Math.min(lowest, d.ring.x);
    if (Math.abs(d.ring.x) >= cell && Math.sign(d.ring.x) !== side) {
      swings++;
      side = Math.sign(d.ring.x);
    }
  }
  expect(lowest).toBeLessThan(-5 * cell);
  expect(swings).toBe(1);
});

test("the border's arc moves between cells, its ends part lit", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const cells = 2 * (v.width + v.height) - 4;
  // Twenty cells long: the cells ten either side of the middle are half lit.
  d.ring.x = 20 / cells;
  const w = new Writer();
  v.draw(d, w, 1);
  expect(w.s.split("╌").length - 1).toBe(2);
});

test("the arc's ends are dashes that close up as they fill", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const cells = 2 * (v.width + v.height) - 4;
  // Each end three cells short of meeting at the top, `lit` into its cell.
  const ends = cells / 2 - 3;
  const drawn = (lit: number) => {
    d.ring.x = (2 * ends - 1 + 2 * lit) / cells;
    const w = new Writer();
    v.draw(d, w, 1);
    return w.s;
  };
  for (const [lit, dash] of [
    [0.1, "┈"],
    [0.3, "┄"],
    [0.6, "╌"],
  ] as const)
    expect(drawn(lit).split(dash).length - 1).toBe(2);
  expect(drawn(0.9)).not.toMatch(/[┈┄╌]/);
  // The arc stays a light line throughout.
  expect(drawn(0.6)).not.toMatch(/[━┃╾╼╿╽]/);
});

test("the enter key stays lit while held and a moment after", () => {
  const d = new Dialog(browse("/home/me/code"));
  const v = d.view(100, 30)!;
  const drawn = () => {
    const w = new Writer();
    v.draw(d, w, 1);
    return w.s;
  };
  const cap = bgRgb(colors.accent);
  expect(drawn()).not.toContain(cap);
  d.key(13, 1000);
  d.animate(1000);
  expect(d.lit).toBe(1);
  expect(drawn()).toContain(cap);
  // The tap's release shows 80 ms past the assumed repeat delay; the key
  // stays lit 200 ms more, fading over the last 80.
  for (let now = 1016; now <= 1600; now += 16) d.animate(now);
  expect(d.lit).toBe(1);
  d.animate(1640);
  expect(d.lit).toBeGreaterThan(0);
  expect(d.lit).toBeLessThan(1);
  d.animate(1700);
  expect(d.lit).toBe(0);
  expect(drawn()).not.toContain(cap);
});

test("something else where the field names a folder is shown, with its size and age", () => {
  const b = browse("/home/me/code");
  for (const byte of Buffer.from("notes")) b.paste(byte);
  expect(b.create).toBeNull();
  expect(b.blocked?.name).toBe("notes");
  // Under it too.
  for (const byte of Buffer.from("/sub")) b.paste(byte);
  expect(b.blocked?.name).toBe("notes");
  expect(b.create).toBeNull();
  const d = new Dialog(b);
  const w = new Writer();
  d.view(100, 30)!.draw(d, w, 1);
  expect(w.s).toContain("notes is a file, not a folder");
  expect(w.s).toContain("2.0 KB · modified 3 days ago");
  expect(w.s).not.toContain("No folders match");
});

test("stat tells what a path holds, a link to nothing included", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  writeFileSync(join(root, "file"), "hello");
  symlinkSync(join(root, "gone"), join(root, "dangling"));
  expect(stat(root)?.kind).toBe("folder");
  expect(stat(join(root, "file"))).toMatchObject({ kind: "file", size: 5 });
  expect(stat(join(root, "dangling"))?.kind).toBe("link");
  expect(stat(join(root, "gone"))).toBeNull();
  rmSync(root, { recursive: true });
  expect([0, 980, 1229, 34 * 1048576].map(size)).toEqual(["0 B", "980 B", "1.2 KB", "34 MB"]);
});
