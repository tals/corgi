import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { imageFiles } from "./prompt_attach";

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
