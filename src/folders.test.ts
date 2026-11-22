import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as folders from "./folders";

test("a remote viewer's folder requests are answered from this computer's folders", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-folders-")));
  const ask = (op: folders.Op, path: string) => folders.answer({ op, payload: { path } });
  try {
    mkdirSync(join(root, "b"));
    mkdirSync(join(root, "A"));
    writeFileSync(join(root, "file"), "hello");
    symlinkSync(join(root, "b"), join(root, "link"));
    symlinkSync(join(root, "gone"), join(root, "dangling"));
    expect(await ask("folder.list", root)).toEqual({ folders: ["A", "b", "link"], home: homedir() });
    expect(await ask("folder.list", join(root, "file"))).toEqual({ folders: null, home: homedir() });
    expect(await ask("folder.find", join(root, "new/deeper"))).toMatchObject({
      deepest: { path: root, found: { kind: "folder" } },
    });
    expect(await ask("folder.find", join(root, "file/under"))).toMatchObject({
      deepest: { path: join(root, "file"), found: { kind: "file", size: 5 } },
    });
    expect(await ask("folder.find", join(root, "dangling"))).toMatchObject({ deepest: { found: { kind: "link" } } });
    expect(await ask("folder.open", join(root, "new/deeper"))).toEqual({ opened: { path: join(root, "new/deeper") } });
    expect(folders.isFolder(join(root, "new/deeper"))).toBe(true);
    // A link to a folder gives the folder's own path.
    expect(await ask("folder.open", join(root, "link"))).toEqual({ opened: { path: join(root, "b") } });
    expect(await ask("folder.open", join(root, "file"))).toEqual({ opened: { problem: "not_folder" } });
    expect(await ask("folder.open", join(root, "file/under"))).toEqual({ opened: { problem: "not_created" } });
    expect(await ask("folder.open", join(root, "dangling"))).toEqual({ opened: { problem: "not_created" } });
    await expect(ask("folder.list", "relative")).rejects.toThrow("InvalidDirectory");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a remote viewer names a folder absolutely, or under the home folder as ~", () => {
  expect(folders.named("~", "/home/me")).toBe("/home/me");
  expect(folders.named("~/code", "/home/me")).toBe("/home/me/code");
  expect(folders.named("~/../shared", "/home/me")).toBe("/home/shared");
  expect(folders.named("/srv", "/home/me")).toBe("/srv");
  expect(() => folders.named("code", "/home/me")).toThrow("InvalidDirectory");
  expect(() => folders.named("/" + "a".repeat(4096))).toThrow("InvalidDirectory");
});
