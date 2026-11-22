import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Browser, Dialog, Disk, Remote, label, size } from "./new_workspace";
import { deepest, isFolder, make, stat, subfolders, type Found } from "./folders";
import { Machine } from "./machine";
import type { Transport } from "./mirror";
import { printable } from "./name_dialog";
import { Writer, displayWidth } from "./text";
import * as i18n from "./i18n";
import { Terminal } from "./pane/terminal";
import { bgRgb, colors, fgRgb, mix } from "./palette";

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
const browse = (cwd = "/home/me") => Browser.init(cwd, new Disk("/home/me", fake, at));
/** Pastes `text` into the browser's field a byte at a time. */
const paste = (b: Browser, text: string) => {
  for (const byte of Buffer.from(text)) b.paste(byte);
};
/** What the dialog draws on a 100×30 screen. */
function draw(d: Dialog): string {
  const w = new Writer();
  d.view(100, 30)!.draw(d, w, 1);
  return w.s;
}

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
  paste(b, "../");
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
    paste(b, text);
    expect(b.folder()).toBe(folder);
  }
  expect(label("/home/meow", "/home/me")).toBe("/home/meow");
});

test("an unreadable folder says so", () => {
  const b = browse("/home/me");
  paste(b, "locked/");
  expect(b.readable).toBe(false);
  expect(b.entries).toEqual([]);
  expect(b.create).toBeNull();
  expect(draw(new Dialog(b))).toContain("Can't read this folder");
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

test("too short for the list, moving a workspace keeps its folder field and the keys", () => {
  const d = new Dialog(browse("/home/me/code"), { workspace: 2, name: "corgi" });
  d.fit(100, 12);
  const v = d.view(100, 12)!;
  expect([v.compact, d.compact, d.browser.focused]).toEqual([true, true, true]);
  const w = new Writer();
  v.draw(d, w, 2);
  for (const text of ["Change folder", "~/code/", "save"]) expect(w.s).toContain(text);
  expect(w.s).not.toContain("Name");
  expect(v.at(v.text_x + 2, v.field_y)).toEqual({ tag: "folder", field: 2 });
  expect(v.buttons().map(b => v.at(b.x, v.buttons_y).tag)).toEqual(["save", "up", "cancel"]);
  // Tab keeps the keys on the folder, the only field there is, and Up picks a folder into it.
  d.key(9);
  expect(d.browser.focused).toBe(true);
  d.sequence("\x1b[A");
  expect([d.browser.focused, d.browser.folder(), d.name()]).toEqual([true, "/home/me/code/other", "corgi"]);
  // A new workspace still falls back to the plain dialog on its name.
  expect(new Dialog(browse()).view(100, 12)).toBeNull();
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
  const drawn = draw(d);
  expect(drawn).not.toContain("\x07");
  expect(drawn).not.toContain("\u009b");
  expect(drawn).not.toContain("\x1b]0;");
  expect(drawn).toContain("/evil/?]0;x??2J");
});

test("a missing folder is made, with the folders above it, when the workspace is created", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  writeFileSync(join(root, "file"), "");
  const b = Browser.init(root, new Disk("/nowhere", subfolders));
  expect(await b.confirm()).toBe(root);
  paste(b, "new/deeper");
  expect(b.create).toBe("new/deeper");
  expect(await b.confirm()).toBe(join(root, "new/deeper"));
  expect(isFolder(join(root, "new/deeper"))).toBe(true);
  // A link to a folder gives the folder's own path, as `corgi action open` does.
  symlinkSync(join(root, "new"), join(root, "link"));
  expect(await Browser.init(join(root, "link"), new Disk("/nowhere", subfolders)).confirm()).toBe(join(root, "new"));
  b.field.clear();
  paste(b, "file");
  expect(b.create).toBeNull();
  expect(await b.confirm()).toBeNull();
  expect(b.problem).toBe("not_folder");
  expect(make(join(root, "file", "under"))).toBe(false);
  rmSync(root, { recursive: true });
});

test("a folder that isn't there is offered to create, nested too", () => {
  const b = browse("/home/me/code");
  paste(b, "co");
  expect(b.entries).toEqual(["corgi"]);
  expect(b.create).toBe("co");
  paste(b, "/new/deeper");
  expect(b.entries).toEqual([]);
  expect(b.create).toBe("co/new/deeper");
  expect(b.count()).toBe(1);
  const drawn = draw(new Dialog(b));
  expect(drawn).toContain("Create ");
  expect(drawn).toContain("co/new/deeper");
  expect(drawn).not.toContain("Can't read this folder");
  // A folder that is there offers nothing.
  for (let i = 0; i < "/new/deeper".length; i++) b.key(127);
  paste(b, "rgi");
  expect(b.create).toBeNull();
});

test("translated Create rows preserve the folder list border when the path fills the row", () => {
  const original = i18n.language();
  try {
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      const b = browse("/home/me/code");
      paste(b, "folder".repeat(20));
      const d = new Dialog(b),
        w = new Writer(),
        view = d.view(80, 30)!,
        terminal = new Terminal(80, 30);
      try {
        view.draw(d, w, 1);
        terminal.feed(w.s);
        const line = terminal
          .text()
          .split("\n")
          .find(row => row.includes("+ " + i18n.t`Create `))!;
        expect(line).toBeDefined();
        const end = line.indexOf("…") + 1,
          following = line.slice(end).trim();
        expect(following).toBe("│ │");
        expect(displayWidth(line.slice(0, end))).toBe(view.text_x + view.text_width - 1);
      } finally {
        terminal.destroy();
      }
    }
  } finally {
    i18n.setLanguage(original);
  }
});

test("opening the offer makes the folders and lists the last", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  const b = Browser.init(root, new Disk("/nowhere", subfolders));
  paste(b, "a/b");
  b.move(1);
  expect(b.highlight).toBe(0);
  expect(b.field.raw()).toBe(root + "/a/b");
  b.sequence("\x1b[C");
  await Bun.sleep(0);
  expect(isFolder(join(root, "a/b"))).toBe(true);
  expect(b.field.raw()).toBe(root + "/a/b/");
  expect(b.create).toBeNull();
  rmSync(root, { recursive: true });
});

test("a remote machine's folders are listed, and made, by its daemon", async () => {
  const asked: string[] = [];
  const request = async (op: string, payload: { path: string }) => {
    asked.push(`${op} ${payload.path}`);
    switch (op) {
      case "folder.list":
        return { ok: true, folders: fake(payload.path), home: "/home/me" };
      case "folder.find":
        return { ok: true, deepest: deepest(payload.path, at) };
      case "folder.open":
        return { ok: true, opened: { path: payload.path } };
    }
    return { err: "UnknownOperation" };
  };
  const machine = new Machine({ request } as unknown as Transport, "nocap", true);
  const d = new Dialog(Browser.init("/home/me", new Remote(machine)));
  let changes = 0;
  d.changed = () => changes++;
  const b = d.browser;
  // Until the daemon answers, the list is blank rather than empty.
  expect(b.field.raw()).toBe("/home/me/");
  expect(b.reading).toBe(true);
  expect(draw(d)).not.toContain("No folders");
  await Bun.sleep(0);
  expect(b.entries).toEqual(["code", "Documents", "docs"]);
  expect(machine.home).toBe("/home/me");
  expect(changes).toBeGreaterThan(0);
  // A folder entered before it's read picks its first folder once it is.
  b.move(1);
  b.sequence("\x1b[C");
  expect(b.field.raw()).toBe("~/code/");
  expect(b.highlight).toBeNull();
  await Bun.sleep(0);
  expect(b.field.raw()).toBe("~/code/corgi");
  expect(b.highlight).toBe(0);
  // What isn't there is offered from the daemon's answer, and made there.
  b.move(-1);
  paste(b, "ctf");
  await Bun.sleep(0);
  expect(b.create).toBe("ctf");
  expect(await d.confirm()).toBe("/home/me/code/ctf");
  expect(asked).toContain("folder.open /home/me/code/ctf");
  expect(isFolder("/home/me/code/ctf")).toBe(false);
});

/** A remote machine whose daemon answers from a copy of the tree only as
 * `flush` lets it. `link.up` false loses the link; an old daemon knows no
 * folder requests. */
function remoteMachine(opts: { home?: string; old?: boolean } = {}) {
  const shown: Record<string, string[]> = structuredClone(tree);
  const held: (() => void)[] = [];
  const asked: string[] = [];
  const link = { up: true };
  const expand = (p: string) => (p === "~" ? "/home/me" : p.startsWith("~/") ? "/home/me" + p.slice(1) : p);
  const answer = (op: string, path: string): object => {
    if (opts.old) return { err: "UnknownOperation" };
    if (op === "folder.list") return { ok: true, folders: shown[path] ?? null, home: "/home/me" };
    if (op === "folder.find")
      return { ok: true, deepest: deepest(path, p => (p in shown ? folder : (others[p] ?? null))) };
    const missing: string[] = [];
    for (let p = path; !(p in shown); p = dirname(p)) missing.unshift(p);
    for (const p of missing) {
      shown[p] = [];
      shown[dirname(p)] = [...shown[dirname(p)], basename(p)].sort((a, b) => a.localeCompare(b));
    }
    return { ok: true, opened: { path } };
  };
  const request = (op: string, payload: { path: string }) =>
    new Promise((resolve, reject) => {
      asked.push(`${op} ${payload.path}`);
      held.push(() => (link.up ? resolve(answer(op, expand(payload.path))) : reject(Error("StaleConnection"))));
    });
  const machine = new Machine({ request } as unknown as Transport, "nocap", true);
  machine.home = opts.home ?? "";
  /** Answers everything asked, and what the answers lead to. */
  const flush = async () => {
    while (held.length) {
      for (const go of held.splice(0)) go();
      await Bun.sleep(0);
    }
  };
  return { machine, asked, link, flush };
}

test("a folder made on a remote machine shows at once, there and above it", async () => {
  const { machine, flush } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me/code", new Remote(machine));
  await flush();
  paste(b, "ctf");
  await flush();
  expect(b.create).toBe("ctf");
  b.move(1);
  b.sequence("\x1b[C");
  await flush();
  expect(b.field.raw()).toBe("~/code/ctf/");
  expect(b.create).toBeNull();
  b.sequence("\x1b[D");
  await flush();
  expect(b.entries).toEqual(["corgi", "ctf", "other"]);
});

test("a remote folder is asked for again after a lost link; an older daemon's can't be read", async () => {
  const { machine, asked, link, flush } = remoteMachine({ home: "/home/me" });
  link.up = false;
  const d = new Dialog(Browser.init("/home/me", new Remote(machine)));
  await flush();
  expect(d.browser.reading).toBe(true);
  expect(draw(d)).not.toContain("Can't read this folder");
  link.up = true;
  paste(d.browser, "c");
  await flush();
  expect(d.browser.entries).toEqual(["code"]);
  expect(asked.filter(q => q === "folder.list /home/me")).toHaveLength(2);
  const old = remoteMachine({ old: true });
  const o = new Dialog(Browser.init("/home/me", new Remote(old.machine)));
  await old.flush();
  expect(draw(o)).toContain("Can't read this folder");
  // It takes the folder as named, `~` included.
  o.browser.field.clear();
  paste(o.browser, "~/code");
  const saved = o.confirm();
  await old.flush();
  expect(await saved).toBe("~/code");
});

test("~ typed before a remote machine's home is known is made there, and read from there once known", async () => {
  const { machine, asked, flush } = remoteMachine();
  const b = Browser.init("/home/me/code", new Remote(machine));
  b.field.clear();
  paste(b, "~/proj");
  expect(b.folder()).toBe("~/proj");
  expect(b.create).toBeNull();
  const saved = b.confirm();
  await flush();
  expect(await saved).toBe("/home/me/proj");
  expect(asked).toContain("folder.open ~/proj");
  expect(b.parent).toBe("/home/me");
  expect(b.entries).toEqual(["proj"]);
});

test("→ pressed before a remote folder is read goes on into its first folder, as on this disk", async () => {
  const { machine, flush } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me", new Remote(machine));
  const local = browse("/home/me");
  await flush();
  for (const each of [b, local]) {
    each.move(1);
    each.sequence("\x1b[C");
    each.sequence("\x1b[C");
  }
  await flush();
  expect(b.field.raw()).toBe("~/code/corgi/");
  expect(local.field.raw()).toBe("~/code/corgi/");
});

test("a remote machine's dialog can start at its home before knowing where that is", async () => {
  const { machine, asked, flush } = remoteMachine();
  const d = new Dialog(Browser.init("~", new Remote(machine)));
  expect(d.browser.field.raw()).toBe("~/");
  await flush();
  expect(asked[0]).toBe("folder.list ~");
  expect(d.browser.folder()).toBe("/home/me");
  expect(d.browser.entries).toEqual(["code", "Documents", "docs"]);
  expect(d.name()).toBe("me");
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

test("the root folder names a workspace /", () => {
  expect(new Dialog(browse("/")).name()).toBe("/");
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

test("enter, or a click on its button, creates the workspace at once", () => {
  const d = new Dialog(browse("/home/me/code"));
  expect(d.key(13)).toBe("save");
  // From the folder field too.
  d.key(9);
  expect(d.key(13)).toBe("save");
  const v = d.view(100, 30)!;
  const create = v.buttons()[0];
  expect(d.press(v, create.x, v.buttons_y, 0)).toBe("save");
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
  expect(v.buttons().map(b => b.label)).toEqual(["create", "out / in", "cancel"]);
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

test("something else where the field names a folder is shown, with its size and age", () => {
  const b = browse("/home/me/code");
  paste(b, "notes");
  expect(b.create).toBeNull();
  expect(b.blocked?.name).toBe("notes");
  // Under it too.
  paste(b, "/sub");
  expect(b.blocked?.name).toBe("notes");
  expect(b.create).toBeNull();
  const drawn = draw(new Dialog(b));
  expect(drawn).toContain("notes is a file, not a folder");
  expect(drawn).toContain("2.0 KB · modified 3 days ago");
  expect(drawn).not.toContain("No folders match");
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
