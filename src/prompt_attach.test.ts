import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { imageFiles, workspaceDiff } from "./prompt_attach";
import * as subprocess from "./subprocess";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-attach-"));
  folders.push(dir);
  return dir;
}

test("a pasted path names image files as a terminal pastes dropped ones", () => {
  const dir = folder(),
    shot = join(dir, "My Shot.png"),
    photo = join(dir, "photo.jpeg"),
    notes = join(dir, "notes.png");
  writeFileSync(shot, png);
  writeFileSync(photo, Buffer.from([255, 216, 255, 224, 0, 16]));
  // Named for an image, but not one.
  writeFileSync(notes, "just text");
  mkdirSync(join(dir, "folder.png"));
  const image = { path: shot, mime: "image/png" };
  expect(imageFiles(shot)).toEqual([image]);
  expect(imageFiles(` ${shot}\n`)).toEqual([image]);
  expect(imageFiles(shot.replace(/ /g, "\\ "))).toEqual([image]);
  expect(imageFiles(`'${shot}'`)).toEqual([image]);
  expect(imageFiles(`"${shot}"`)).toEqual([image]);
  expect(imageFiles(pathToFileURL(shot).href)).toEqual([image]);
  // Dropped together, escaped and apart.
  expect(imageFiles(`${shot.replace(/ /g, "\\ ")} ${photo}`)).toEqual([image, { path: photo, mime: "image/jpeg" }]);
  for (const text of [
    notes,
    join(dir, "folder.png"),
    join(dir, "gone.png"),
    "My Shot.png",
    `look at ${shot}`,
    `${shot} ${notes}`,
    `${shot}\n${photo}`.replace(/ /g, "\\ ") + "\nand more",
    "",
  ])
    expect(imageFiles(text)).toBeNull();
});

test("a diff too big to read whole still attaches its start, cut", async () => {
  const dir = folder(),
    git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "small.txt"), "one\n");
  writeFileSync(join(dir, "lock.json"), "");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start");
  writeFileSync(join(dir, "small.txt"), "two\n");
  writeFileSync(join(dir, "lock.json"), `${"x".repeat(100)}\n`.repeat(20_000));
  const text = await workspaceDiff(dir);
  expect(text).toStartWith(" lock.json");
  expect(text).toEndWith("\n(diff cut at 32 KB)");
  expect(Buffer.byteLength(text)).toBeLessThan(33 * 1024);
});
test("a stat too long to read whole is cut too, not an error", async () => {
  const run = spyOn(subprocess, "run").mockImplementation(async (argv: string[], options: subprocess.Options) => {
    const out = (text: string, cut = false) =>
      new subprocess.Output({ exited: cut ? 141 : 0 }, Buffer.from(text), Buffer.alloc(0), cut);
    if (argv.includes("rev-parse")) return out("abc\n");
    if (!options.cut) throw Error("OutputTooLarge");
    return argv.includes("--stat") ? out(" vendor/a.js | 1 +\n".repeat(8000), true) : out("diff --git a/x b/x\n+x\n");
  });
  try {
    const text = await workspaceDiff("/repo");
    expect(text).toStartWith(" vendor/a.js | 1 +");
    expect(text).toEndWith("\n(diff cut at 32 KB)");
  } finally {
    run.mockRestore();
  }
});
