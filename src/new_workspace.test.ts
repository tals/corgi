import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Browser, Dialog, Reader, here, label, remote, size, type Place } from "./new_workspace";
import type { Found, Op } from "./folders";
import { Machine } from "./machine";
import * as machineAdd from "./machine_add";
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
const folder: Found = { kind: "folder", size: 0, modified: 0 };
/** Things in the tree that aren't folders. */
const others: Record<string, Found> = {
  "/home/me/code/notes": { kind: "file", size: 2048, modified: Date.now() - 3 * 86400 * 1000 },
};
/** The tree as a computer answers folder requests, the folders it makes
 * added; one called "locked" is there but can't be read. */
function answers() {
  const shown: Record<string, string[]> = structuredClone(tree);
  const at = (p: string) => (p in shown || p.endsWith("/locked") ? folder : (others[p] ?? null));
  return (op: Op, path: string): object => {
    switch (op) {
      case "folder.list":
        return { folders: path.endsWith("/locked") ? null : (shown[path] ?? null), home: "/home/me" };
      case "folder.find": {
        let p = path;
        while (at(p) === null && p !== dirname(p)) p = dirname(p);
        const found = at(p);
        return { deepest: found && { path: p, found } };
      }
      case "folder.open": {
        const missing: string[] = [];
        for (let p = path; !(p in shown); p = dirname(p)) missing.unshift(p);
        for (const p of missing) {
          shown[p] = [];
          shown[dirname(p)] = [...shown[dirname(p)], basename(p)].sort((a, b) => a.localeCompare(b));
        }
        return { opened: { path } };
      }
    }
  };
}
/** The tree as this computer, answering at once. */
function computer(): Place {
  const answer = answers();
  return { home: "/home/me", ask: async (op, path) => answer(op, path), lost: () => false };
}
/** Lets the browser take in what it asked. */
const settle = () => Bun.sleep(0);
const browse = async (cwd = "/home/me") => {
  const b = Browser.init(cwd, new Reader(computer()));
  await settle();
  return b;
};
/** Waits for reads of this disk to bring `done` about. */
async function until(done: () => boolean) {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}
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

test("the browser starts at the folder and lists the folders in it", async () => {
  const b = await browse("/home/me/code");
  expect(b.field.raw()).toBe("~/code/");
  expect(b.entries).toEqual(["corgi", "other"]);
  expect(b.folder()).toBe("/home/me/code");
  const root = await browse("/");
  expect(root.field.raw()).toBe("/");
  expect(root.entries).toEqual(["home", "tmp"]);
});

test("typing filters by the name after the last slash; a dot shows dot folders", async () => {
  const b = await browse();
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

test("moving through the list writes each folder into the field, and back to what was typed", async () => {
  const b = await browse();
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

test("right opens the highlighted folder and left goes up, each picking the first folder there", async () => {
  const b = await browse();
  const press = async (seq: string) => {
    b.sequence(seq);
    await settle();
  };
  // At the end of the folder the field names, left goes up.
  await press("\x1b[D");
  expect(b.entries).toEqual(["me"]);
  expect(b.highlight).toBe(0);
  expect(b.field.raw()).toBe("/home/me");
  await press("\x1b[C");
  expect(b.field.raw()).toBe("~/code");
  await press("\x1b[C");
  expect(b.entries).toEqual(["corgi", "other"]);
  expect(b.field.raw()).toBe("~/code/corgi");
  await press("\x1b[D");
  expect(b.field.raw()).toBe("~/code");
  await press("\x1b[D");
  await press("\x1b[D");
  expect(b.field.raw()).toBe("/home");
  // Above the first entry is the folder itself.
  await press("\x1b[A");
  expect(b.field.raw()).toBe("/");
  // Right at the end of a name opens the first folder it starts.
  b.key(c("h"));
  await press("\x1b[C");
  expect(b.field.raw()).toBe("/home/me");
  // Inside the text, left and right move the cursor.
  b.key(127);
  await press("\x1b[D");
  await press("\x1b[D");
  expect(b.field.raw()).toBe("/home/m");
  expect(b.field.cursor).toBe(5);
  await press("\x1b[C");
  expect(b.field.cursor).toBe(6);
});

test("opening a folder writes it plainly", async () => {
  const b = await browse("/home/me/code");
  paste(b, "../");
  b.move(1);
  expect(b.field.raw()).toBe("~/code/../code");
  b.open();
  await settle();
  expect(b.field.raw()).toBe("~/code/corgi");
});

test("the field resolves home, relative names and dot-dots", async () => {
  const b = await browse("/home/me/code");
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

test("an unreadable folder says so", async () => {
  const b = await browse("/home/me");
  paste(b, "locked/");
  await settle();
  expect(b.readable).toBe(false);
  expect(b.entries).toEqual([]);
  expect(b.create).toBeNull();
  expect(draw(new Dialog(b))).toContain("Can't read this folder");
});

test("clicking an entry highlights it, and clicking it again opens it", async () => {
  const b = await browse("/home/me/code");
  b.click({ tag: "entry", index: 0 }, 0);
  expect(b.focused).toBe(true);
  expect(b.field.raw()).toBe("~/code/corgi");
  // An empty folder has nothing to pick.
  b.click({ tag: "entry", index: 0 }, 0);
  await settle();
  expect(b.field.raw()).toBe("~/code/corgi/");
  expect(b.highlight).toBeNull();
  b.click({ tag: "up" }, 0);
  await settle();
  expect(b.field.raw()).toBe("~/code/corgi");
});

test("the window keeps the highlight in view", async () => {
  tree["/many"] = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const b = await browse("/many");
  expect(b.window(5)).toBe(0);
  for (let i = 0; i < 8; i++) b.move(1);
  expect(b.window(5)).toBe(3);
  b.move(-1);
  expect(b.window(5)).toBe(3);
  for (let i = 0; i < 5; i++) b.move(-1);
  expect(b.window(5)).toBe(1);
});

test("the dialog moves between the name and the folder with tab", async () => {
  const d = new Dialog(await browse());
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

test("the new-workspace card shows the folders and answers clicks on them", async () => {
  const d = new Dialog(await browse("/home/me/code"));
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

test("too short for the list, moving a workspace keeps its folder field and the keys", async () => {
  const d = new Dialog(await browse("/home/me/code"), { workspace: 2, name: "corgi" });
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
  expect(new Dialog(await browse()).view(100, 12)).toBeNull();
});

test("folder names never reach the terminal as controls", async () => {
  expect(printable("a\x1b[2Jb\x7f\u009b31mc")).toBe("a?[2Jb??31mc");
  const evil = "\x1b]0;x\x07\u009b2J";
  tree["/evil"] = [evil];
  const d = new Dialog(await browse("/evil"));
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
  const b = Browser.init(root, new Reader(here("/nowhere")));
  expect(await b.confirm()).toBe(root);
  paste(b, "new/deeper");
  await until(() => b.create === "new/deeper");
  expect(await b.confirm()).toBe(join(root, "new/deeper"));
  expect(existsSync(join(root, "new/deeper"))).toBe(true);
  // A link to a folder gives the folder's own path, as `corgi action open` does.
  symlinkSync(join(root, "new"), join(root, "link"));
  expect(await Browser.init(join(root, "link"), new Reader(here("/nowhere"))).confirm()).toBe(join(root, "new"));
  b.field.clear();
  paste(b, "file");
  await until(() => b.blocked?.name === "file");
  expect(b.create).toBeNull();
  expect(await b.confirm()).toBeNull();
  expect(b.problem).toBe("not_folder");
  rmSync(root, { recursive: true });
});

test("a folder that isn't there is offered to create, nested too", async () => {
  const b = await browse("/home/me/code");
  paste(b, "co");
  expect(b.entries).toEqual(["corgi"]);
  expect(b.create).toBe("co");
  paste(b, "/new/deeper");
  await settle();
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
  await settle();
  expect(b.create).toBeNull();
});

test("translated Create rows preserve the folder list border when the path fills the row", async () => {
  const original = i18n.language();
  try {
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      const b = await browse("/home/me/code");
      paste(b, "folder".repeat(20));
      await settle();
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
  const b = Browser.init(root, new Reader(here("/nowhere")));
  paste(b, "a/b");
  await until(() => b.create === "a/b");
  b.move(1);
  expect(b.highlight).toBe(0);
  expect(b.field.raw()).toBe(root + "/a/b");
  b.sequence("\x1b[C");
  await until(() => b.field.raw() === root + "/a/b/" && b.create === null);
  expect(existsSync(join(root, "a/b"))).toBe(true);
  rmSync(root, { recursive: true });
});

/** A remote machine whose daemon answers from the tree only as `flush`
 * lets it. `link.up` false loses the link; an old daemon knows no folder
 * requests. */
function remoteMachine(opts: { home?: string; old?: boolean } = {}) {
  const answer = answers();
  const held: (() => void)[] = [];
  const asked: string[] = [];
  const link = { up: true };
  const expand = (p: string) => (p === "~" || p.startsWith("~/") ? resolve("/home/me", "." + p.slice(1)) : p);
  const reply = (op: Op, path: string) =>
    opts.old ? { err: "UnknownOperation" } : { ok: true, ...answer(op, expand(path)) };
  const request = (op: Op, payload: { path: string }) =>
    new Promise((resolve, reject) => {
      asked.push(`${op} ${payload.path}`);
      held.push(() => (link.up ? resolve(reply(op, payload.path)) : reject(Error("StaleConnection"))));
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
  return { machine, asked, link, flush, reader: () => new Reader(remote(machine)) };
}

test("a remote machine's folders are listed by its daemon, blank until it answers", async () => {
  const { machine, flush, reader } = remoteMachine();
  const d = new Dialog(Browser.init("/home/me", reader()));
  let changes = 0;
  d.changed = () => changes++;
  expect(d.browser.field.raw()).toBe("/home/me/");
  expect(d.browser.reading).toBe(true);
  expect(draw(d)).not.toContain("No folders");
  await flush();
  expect(d.browser.entries).toEqual(["code", "Documents", "docs"]);
  expect(machine.home).toBe("/home/me");
  expect(changes).toBeGreaterThan(0);
});

test("typing a name offers to create it from the folders listed, before the machine answers", async () => {
  const { flush, reader } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me/code", reader());
  await flush();
  paste(b, "c");
  expect(b.create).toBe("c");
  paste(b, "t");
  expect([b.entries, b.create]).toEqual([[], "ct"]);
  for (let i = 0; i < 2; i++) b.key(127);
  paste(b, "corgi");
  expect(b.create).toBeNull();
  await flush();
  expect(b.create).toBeNull();
});

test("→ and ← show their folders at once, read ahead of them", async () => {
  const { flush, reader } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me/code", reader());
  await flush();
  b.move(1);
  await flush();
  b.sequence("\x1b[C");
  expect([b.reading, b.field.raw()]).toEqual([false, "~/code/corgi/"]);
  b.sequence("\x1b[D");
  await flush();
  b.sequence("\x1b[D");
  expect([b.reading, b.entries]).toEqual([false, ["code", "Documents", "docs"]]);
});

test("a folder made on a remote machine shows at once, there and above it", async () => {
  const { flush, reader } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me/code", reader());
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
  const { asked, link, flush, reader } = remoteMachine({ home: "/home/me" });
  link.up = false;
  const d = new Dialog(Browser.init("/home/me", reader()));
  await flush();
  expect(d.browser.reading).toBe(true);
  expect(draw(d)).not.toContain("Can't read this folder");
  link.up = true;
  paste(d.browser, "c");
  await flush();
  expect(d.browser.entries).toEqual(["code"]);
  expect(asked.filter(q => q === "folder.list /home/me")).toHaveLength(2);
  const old = remoteMachine({ old: true });
  const o = new Dialog(Browser.init("/home/me", old.reader()));
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
  const { asked, flush, reader } = remoteMachine();
  const b = Browser.init("/home/me/code", reader());
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

test("~/.. typed before a remote machine's home is known still goes above it", async () => {
  const { asked, flush, reader } = remoteMachine();
  const b = Browser.init("/home/me/code", reader());
  b.field.clear();
  paste(b, "~/../shared/");
  expect(b.folder()).toBe("~/../shared");
  const saved = b.confirm();
  await flush();
  expect(await saved).toBe("/home/shared");
  expect(asked).toContain("folder.open ~/../shared");
});

test("→ pressed before a remote folder is read goes on into its first folder, as on this disk", async () => {
  const { flush, reader } = remoteMachine({ home: "/home/me" });
  const b = Browser.init("/home/me", reader());
  const local = await browse("/home/me");
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
  const { asked, flush, reader } = remoteMachine();
  const d = new Dialog(Browser.init("~", reader()));
  expect(d.browser.field.raw()).toBe("~/");
  await flush();
  expect(asked[0]).toBe("folder.list ~");
  expect(d.browser.folder()).toBe("/home/me");
  expect(d.browser.entries).toEqual(["code", "Documents", "docs"]);
  expect(d.name()).toBe("me");
});

test("the name follows the folder until it is edited", async () => {
  const d = new Dialog(await browse("/home/me/code"));
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

test("the root folder names a workspace /", async () => {
  expect(new Dialog(await browse("/")).name()).toBe("/");
});

test("clearing the name stops it following", async () => {
  const d = new Dialog(await browse("/home/me/code"));
  d.key(3);
  expect(d.follows_folder).toBe(false);
  d.sequence("\x1b[B");
  d.sequence("\x1b[B");
  expect(d.name()).toBe("");
});

test("up and down go round the name, the folder and its folders", async () => {
  const d = new Dialog(await browse("/home/me/code"));
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

test("enter, or a click on its button, creates the workspace at once", async () => {
  const d = new Dialog(await browse("/home/me/code"));
  expect(d.key(13)).toBe("save");
  // From the folder field too.
  d.key(9);
  expect(d.key(13)).toBe("save");
  const v = d.view(100, 30)!;
  const create = v.buttons()[0];
  expect(d.press(v, create.x, v.buttons_y, 0)).toBe("save");
});

test("the name is selected only until the keys first leave it", async () => {
  const d = new Dialog(await browse("/home/me/code"));
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

test("the arrows are keys of their own, quiet until the folder has the keys", async () => {
  const d = new Dialog(await browse("/home/me/code"));
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

test("something else where the field names a folder is shown, with its size and age", async () => {
  const b = await browse("/home/me/code");
  paste(b, "notes");
  await settle();
  expect(b.create).toBeNull();
  expect(b.blocked?.name).toBe("notes");
  // Under it too.
  paste(b, "/sub");
  await settle();
  expect(b.blocked?.name).toBe("notes");
  expect(b.create).toBeNull();
  const drawn = draw(new Dialog(b));
  expect(drawn).toContain("notes is a file, not a folder");
  expect(drawn).toContain("2.0 KB · modified 3 days ago");
  expect(drawn).not.toContain("No folders match");
});

test("sizes read in bytes, then KB or MB", () => {
  expect([0, 980, 1229, 34 * 1048576].map(size)).toEqual(["0 B", "980 B", "1.2 KB", "34 MB"]);
});

/** This computer and two remote machines, `devbox` online and `gpu-box`
 * connecting, whose folders `places` reads. */
function machines() {
  const transport = { request: async () => ({}) } as unknown as Transport;
  const presence =
    (online: boolean, quality: 0 | 1 | 2 | 3 | 4 | null = null) =>
    () => ({
      online,
      link_quality: quality,
      connecting: !online,
      stopped: false,
      connection_status: online ? null : { label: "connecting", seconds: 3, color: "warm" as const },
      description: "",
      cached: [],
      seen: true,
      stale: false,
    });
  const local = new Machine(transport, "studio"),
    devbox = new Machine(transport, "devbox", true),
    gpu = new Machine(transport, "gpu-box", true);
  devbox.presence = presence(true, 4);
  gpu.presence = presence(false);
  const devboxTree: Record<string, string[]> = { "/home/me": ["code"], "/home/me/code": ["infra", "llm-evals"] };
  const link = { up: false };
  /** gpu-box's daemon answers once `link` is up. */
  const places = (machine: Machine): Place => {
    if (machine === local) return computer();
    const tree = machine === devbox ? devboxTree : { "/home/me": ["code"], "/home/me/code": ["training"] };
    return {
      home: "/home/me",
      ask: async (op, path) => {
        if (machine === gpu && !link.up) throw Error("StaleConnection");
        return op === "folder.list"
          ? { folders: tree[path] ?? null, home: "/home/me" }
          : { deepest: { path, found: folder } };
      },
      lost: () => true,
    };
  };
  /** Each machine first browses its code folder. */
  const start = () => "/home/me/code";
  const dialog = async (moving: { workspace: number; name: string } | null = null, all = [local, devbox, gpu]) => {
    const d = new Dialog(await browse("/home/me/code"), moving, { machine: local, machines: all, start });
    d.places = places;
    d.fit(100, 30);
    return d;
  };
  return { local, devbox, gpu, link, places, dialog };
}
/** The dialog's rows as text, as a 100×30 terminal shows them. */
function screen(d: Dialog): string {
  const terminal = new Terminal(100, 30);
  try {
    terminal.feed(draw(d));
    return terminal.text();
  } finally {
    terminal.destroy();
  }
}
const labels = (d: Dialog) =>
  d
    .view(100, 30)!
    .buttons()
    .map(b => b.label);

test("with other machines, the title names the one the workspace goes on, and ^O lists them", async () => {
  const { local, devbox, dialog } = machines();
  const d = await dialog();
  expect(screen(d)).toContain("New workspace on studio ▾");
  expect(labels(d)).toEqual(["create", "out / in", "machine", "cancel"]);
  d.key(15);
  expect([d.choosing, d.highlight]).toEqual([true, 0]);
  expect(labels(d)).toEqual(["choose", "machine", "close"]);
  const open = screen(d);
  for (const text of [/✓ studio +this machine/, /devbox +▂▄▆█/, /gpu-box +connecting 3s/]) expect(open).toMatch(text);
  // The list has the keys, and the cursor sits in its field: typing searches it, not the name.
  expect(draw(d)).toEndWith("\x1b[7;26H\x1b[?25h");
  d.key(c("x"));
  expect([d.name(), d.list.query, d.highlight]).toEqual(["code", "x", 0]);
  // Leaving the search keeps the machine it found.
  d.key(27);
  expect([d.choosing, d.highlight]).toEqual([true, 1]);
  expect(d.key(13)).toBe("none");
  expect([d.choosing, d.machine]).toEqual([false, devbox]);
  // Its own folders are browsed there, and the name follows them.
  await settle();
  expect([d.browser.field.raw(), d.browser.entries, d.name()]).toEqual(["~/code/", ["infra", "llm-evals"], "code"]);
  expect(screen(d)).toContain("New workspace on devbox ▾");
  expect(d.key(13)).toBe("save");
  // Esc closes the list, not the dialog.
  d.key(15);
  expect(d.key(27)).toBe("none");
  expect([d.choosing, d.machine]).toEqual([false, devbox]);
  d.key(15);
  d.sequence("\x1b[A");
  d.key(13);
  expect(d.machine).toBe(local);
});

test("a machine still connecting is chosen, and its folders show and ↵ creates once it's online", async () => {
  const { gpu, link, dialog } = machines();
  const d = await dialog();
  d.key(15);
  d.sequence("\x1b[B");
  d.sequence("\x1b[B");
  expect(d.highlight).toBe(2);
  d.key(13);
  await settle();
  expect([d.machine, d.ready(), d.browser.reading]).toEqual([gpu, false, true]);
  expect(draw(d)).toContain("Connecting to gpu-box…");
  expect(d.key(13)).toBe("none");
  const v = d.view(100, 30)!;
  expect(d.press(v, v.buttons()[0].x, v.buttons_y, 0)).toBe("none");
  // Looking again before it's online asks nothing new.
  d.catchUp();
  await settle();
  expect(d.browser.reading).toBe(true);
  link.up = true;
  const connecting = gpu.presence();
  gpu.presence = () => ({ ...connecting, online: true, connecting: false, connection_status: null });
  d.catchUp();
  await settle();
  expect([d.browser.reading, d.browser.entries]).toEqual([false, ["training"]]);
  expect(screen(d)).toContain("training");
  expect(d.key(13)).toBe("save");
});

test("the machine's name opens its list on every click; a machine chooses it, and a press elsewhere closes it", async () => {
  const { devbox, dialog } = machines();
  const d = await dialog();
  const v = d.view(100, 30)!;
  const chip = v.chip!;
  expect(v.at(chip.x, chip.y)).toEqual({ tag: "machine" });
  expect(v.points(chip.x + chip.width - 1, chip.y)).toBe(true);
  expect(d.hover(v, chip.x, chip.y)).toBe(true);
  expect(d.hover(v, chip.x + 1, chip.y)).toBe(false);
  expect(d.hovering).toBe(true);
  expect(d.press(v, chip.x, chip.y, 0)).toBe("none");
  expect(d.choosing).toBe(true);
  // Again, it stays open.
  d.press(v, chip.x, chip.y, 0);
  expect(d.choosing).toBe(true);
  // Under the field.
  const list = v.machineList()!;
  expect(d.hover(v, list.box.x + 2, list.box.y + 4)).toBe(true);
  expect(d.highlight).toBe(2);
  expect(v.points(list.box.x + 2, list.box.y + 3)).toBe(true);
  expect(v.points(list.box.x + 2, list.box.y + 1)).toBe(false);
  d.press(v, list.box.x + 2, list.box.y + 1, 0);
  expect(d.choosing).toBe(true);
  d.press(v, list.box.x + 2, list.box.y + 3, 0);
  expect([d.choosing, d.machine]).toEqual([false, devbox]);
  // Off the list, a press closes it, and doesn't cancel the dialog.
  d.press(v, chip.x, chip.y, 0);
  expect(d.press(v, v.x - 1, v.y, 0)).toBe("none");
  expect([d.choosing, d.machine]).toEqual([false, devbox]);
  // ^O's key opens it too, and so does its cap after the name.
  d.press(v, v.buttons()[2].x, v.buttons_y, 0);
  expect(d.choosing).toBe(true);
  d.key(27);
  expect(screen(d)).toMatch(/New workspace on devbox ▾ +\^O/);
  const key = d.view(100, 30)!.chip!.key!;
  expect(d.press(v, key + 1, chip.y, 0)).toBe("none");
  expect(d.choosing).toBe(true);
});

test("each machine keeps its own folder field, as left, while the dialog is open", async () => {
  const { local, dialog } = machines();
  const d = await dialog();
  const choose = (index: number) => {
    d.openMachines();
    d.highlight = index;
    d.key(13);
  };
  const type = (text: string) => {
    for (const ch of text) d.key(c(ch));
  };
  d.key(9);
  type("corgi");
  expect([d.browser.field.raw(), d.name()]).toEqual(["~/code/corgi", "corgi"]);
  choose(1);
  await settle();
  // devbox starts at its own folder, not the one typed on studio.
  expect([d.browser.field.raw(), d.browser.entries, d.name(), d.browser.focused]).toEqual([
    "~/code/",
    ["infra", "llm-evals"],
    "code",
    true,
  ]);
  type("infra");
  choose(0);
  expect([d.machine, d.browser.field.raw(), d.name()]).toEqual([local, "~/code/corgi", "corgi"]);
  choose(1);
  expect([d.browser.field.raw(), d.name()]).toEqual(["~/code/infra", "infra"]);
});

test("under a divider, the list offers the SSH config's other hosts; one added is chosen while the list is open", async () => {
  const { local, devbox, gpu, places } = machines();
  const all = [local, devbox, gpu];
  const runs: { host: string; finish: () => void }[] = [];
  const adds = new machineAdd.Adds({
    hosts: () => ["devbox", "pi", "lab"],
    saved: () => [],
    add: async host => {
      await new Promise<void>(resolve => runs.push({ host, finish: resolve }));
      return { name: host, target: host, executable: "/corgi", socket: "/socket", home: "/home/me" };
    },
    probe: () => new Promise(() => {}),
  });
  const d = new Dialog(await browse("/home/me/code"), null, {
    machine: local,
    machines: all,
    adds,
    start: () => "/home/me",
  });
  d.places = places;
  d.fit(100, 30);
  d.key(15);
  const open = screen(d);
  expect(open).toMatch(/│ +Search or type a host +│/);
  expect(open).toMatch(/gpu-box +connecting 3s/);
  expect(open).toMatch(/├─+┤/);
  expect(open).toMatch(/│ +pi +│/);
  expect(open).toMatch(/│ +lab +│/);
  expect(open).not.toMatch(/│ +devbox +│/);
  // Down from the last machine steps over the divider.
  d.highlight = 2;
  d.sequence("\x1b[B");
  expect(d.highlight).toBe(4);
  expect(screen(d)).toMatch(/pi +add/);
  d.sequence("\x1b[A");
  expect(d.highlight).toBe(2);
  // The divider is no row: hovering it keeps the highlight, and it doesn't point.
  const v = d.view(100, 30)!,
    list = v.machineList()!,
    rule = list.box.y + 2 + 3;
  expect(d.hover(v, list.box.x + 2, rule)).toBe(false);
  expect(v.points(list.box.x + 2, rule)).toBe(false);
  // ↵ on a host adds it, and the list stays open with its progress.
  d.sequence("\x1b[B");
  expect(d.key(13)).toBe("none");
  expect([d.choosing, d.machine, runs.map(r => r.host)]).toEqual([true, local, ["pi"]]);
  expect(screen(d)).toMatch(/pi +Checking…/);
  // Once it's a machine, it's the one the workspace goes on.
  const pi = new Machine(devbox.connection, "pi", true);
  pi.presence = devbox.presence;
  adds.added = () => all.push(pi);
  runs[0].finish();
  await settle();
  d.catchUp();
  await settle();
  const hosts = () => d.list.rows().flatMap(row => (row.kind === "host" ? [row.target] : []));
  expect([d.choosing, d.machine, hosts()]).toEqual([false, pi, ["lab"]]);
  expect(screen(d)).toContain("New workspace on pi ▾");
  // An add whose list was closed meanwhile leaves the choice alone.
  d.key(15);
  d.highlight = 5;
  d.key(13);
  d.key(27);
  const lab = new Machine(devbox.connection, "lab", true);
  all.push(lab);
  d.catchUp();
  expect(d.machine).toBe(pi);
});

test("typing in the list of machines searches it, offers a host nothing names, and esc leaves the search first", async () => {
  const { local, devbox, gpu, places } = machines();
  const adds = new machineAdd.Adds({
    hosts: () => ["pi"],
    saved: () => [],
    add: () => new Promise(() => {}),
    probe: () => new Promise(() => {}),
  });
  const d = new Dialog(await browse("/home/me/code"), null, {
    machine: local,
    machines: [local, devbox, gpu],
    adds,
    start: () => "/home/me",
  });
  d.places = places;
  d.fit(100, 30);
  d.key(15);
  const box = () => d.view(100, 30)!.machineList()!.box;
  const opened = box();
  for (const ch of "dev") d.key(c(ch));
  let shown = screen(d);
  expect(shown).toMatch(/│  dev +│/);
  expect(shown).toMatch(/devbox +▂▄▆█/);
  expect(shown).toMatch(/\+ dev/);
  expect(shown).not.toMatch(/this machine|gpu-box|│ +pi +│/);
  expect(box()).toEqual(opened);
  expect(labels(d)).toEqual(["choose", "machine", "back"]);
  // A paste goes in the search too; ⌫ edits it.
  for (const byte of Buffer.from("-2")) d.pasteByte(byte);
  d.key(127);
  expect(d.list.query).toBe("dev-");
  expect(screen(d)).toMatch(/\+ dev-/);
  d.key(27);
  expect([d.choosing, d.list.query, labels(d)]).toEqual([true, null, ["choose", "machine", "close"]]);
  d.key(27);
  expect([d.choosing, d.machine]).toEqual([false, local]);
  // Reopened, nothing typed is kept.
  d.key(15);
  expect(screen(d)).toMatch(/Search or type a host/);
});

test("up from the name opens the list of machines, whose arrows move by key or click, and down past the last closes it", async () => {
  const { local, dialog } = machines();
  const d = await dialog();
  d.sequence("\x1b[A");
  expect([d.choosing, d.highlight]).toEqual([true, 0]);
  const v = d.view(100, 30)!,
    arrows = v.buttons()[1];
  d.press(v, arrows.x + 4, v.buttons_y, 0);
  expect(d.highlight).toBe(1);
  d.press(v, arrows.x, v.buttons_y, 0);
  expect(d.highlight).toBe(0);
  d.sequence("\x1b[B");
  d.sequence("\x1b[B");
  expect([d.choosing, d.highlight]).toEqual([true, 2]);
  d.sequence("\x1b[B");
  expect([d.choosing, d.machine, d.browser.focused]).toEqual([false, local, false]);
  // Down from the name still goes to the folder.
  d.sequence("\x1b[B");
  expect([d.choosing, d.browser.focused]).toEqual([false, true]);
});

test("a long list of machines scrolls only to keep the highlight in view", async () => {
  const { local, devbox, gpu, places } = machines();
  const transport = { request: async () => ({}) } as unknown as Transport;
  const all = [local, devbox, gpu, ...Array.from({ length: 20 }, (_, i) => new Machine(transport, `m${i}`, true))];
  const d = new Dialog(await browse("/home/me/code"), null, { machine: local, machines: all, start: () => "/home/me" });
  d.places = places;
  d.fit(100, 20);
  d.key(15);
  for (let i = 0; i < 20; i++) d.sequence("\x1b[B");
  const v = d.view(100, 20)!,
    list = v.machineList()!;
  expect(list.choices.length).toBeLessThan(all.length);
  expect(list.first + list.choices.length - 1).toBe(20);
  // The pointer on the top row, under the field, highlights it, and the rows stay put under it.
  d.hover(v, list.box.x + 2, list.box.y + 2);
  expect(d.highlight).toBe(list.first);
  expect(v.machineList()!.first).toBe(list.first);
  d.sequence("\x1b[A");
  expect(v.machineList()!.first).toBe(list.first - 1);
});

test("a machine that stopped trying says it isn't connected, and not that it will", async () => {
  const { gpu, dialog } = machines();
  const d = await dialog();
  const waiting = gpu.presence();
  gpu.presence = () => ({ ...waiting, stopped: true, connection_status: null });
  d.choose(2);
  await settle();
  const text = screen(d);
  expect(text).toContain("gpu-box isn't connected");
  expect(text).not.toContain("once it connects");
});

test("choosing a machine puts out the light on its name, whose width changed", async () => {
  const { dialog } = machines();
  const d = await dialog();
  const chip = d.view(100, 30)!.chip!;
  d.hover(d.view(100, 30)!, chip.x, chip.y);
  expect(d.hovering).toBe(true);
  d.choose(1);
  expect(d.hovering).toBe(false);
});

test("a workspace being created stays on its machine", async () => {
  const { local, dialog } = machines();
  const d = await dialog();
  const v = d.view(100, 30)!;
  d.saving = true;
  d.key(15);
  d.sequence("\x1b[A");
  d.press(v, v.chip!.x, v.chip!.y, 0);
  expect([d.choosing, d.machine]).toEqual([false, local]);
});

test("in a narrow card, the machine's name stays inside it, the title giving way", async () => {
  const { dialog } = machines();
  const original = i18n.language();
  try {
    for (const locale of i18n.locales) {
      i18n.setLanguage(locale);
      const d = await dialog();
      d.fit(32, 30);
      const v = d.view(32, 30)!,
        chip = v.chip!,
        w = new Writer(),
        terminal = new Terminal(32, 30);
      expect(chip.x + chip.width).toBeLessThanOrEqual(v.x + v.width - 2);
      expect(chip.key).toBeNull();
      try {
        v.draw(d, w, 1);
        terminal.feed(w.s);
        const row = terminal.text().split("\n")[chip.y].trimEnd();
        expect(row).toContain(" studio ▾");
        expect(row.endsWith("│")).toBe(true);
        expect(displayWidth(row)).toBe(v.x + v.width);
      } finally {
        terminal.destroy();
      }
    }
  } finally {
    i18n.setLanguage(original);
  }
});

test("with one machine, or moving a workspace, the title names none and ^O does nothing", async () => {
  const { local, dialog } = machines();
  for (const d of [await dialog(null, [local]), await dialog({ workspace: 1, name: "code" })]) {
    expect(draw(d)).not.toContain("▾");
    expect(d.view(100, 30)!.chip).toBeNull();
    expect(labels(d)).not.toContain("machine");
    d.key(15);
    expect(d.choosing).toBe(false);
  }
  // Too small for the card, the plain dialog has no list to open.
  const d = await dialog();
  d.fit(100, 12);
  d.key(15);
  expect(d.choosing).toBe(false);
});
