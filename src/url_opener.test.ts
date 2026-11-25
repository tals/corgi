import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import { scopedEnv } from "./fixtures/env";
import { Openers } from "./url_opener";

const command = process.platform === "darwin" ? "open" : "xdg-open";

test("the native opener gets one validated image path and reports a failed launch", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-image-opener-")));
  const log = join(dir, "opened");
  using env = scopedEnv({ PATH: dir, CORGI_TEST_OPENER_LOG: log, CORGI_TEST_OPENER_EXIT: "0" });
  try {
    writeFileSync(
      join(dir, command),
      '#!/bin/sh\nprintf "%s\\n" "$#" "$@" >> "$CORGI_TEST_OPENER_LOG"\nexit "$CORGI_TEST_OPENER_EXIT"\n',
      { mode: 0o700 },
    );
    const image = join(dir, "a shot #1.png");
    const mislabeled = join(dir, "text.png");
    const blob = join(dir, "blob");
    const alias = join(dir, "alias.png");
    const png = Buffer.from(png_base64, "base64");
    writeFileSync(image, png);
    writeFileSync(mislabeled, "plain text");
    writeFileSync(blob, png);
    symlinkSync(blob, alias);

    const openers = new Openers();
    await openers.openImage(image);
    await expect(openers.openImage(mislabeled)).rejects.toThrow("NotAnImage");
    await expect(openers.openImage(alias)).rejects.toThrow("NotAnImage");
    expect(readFileSync(log, "utf8")).toBe(`1\n${image}\n`);

    using failed = scopedEnv({ CORGI_TEST_OPENER_EXIT: "1" });
    await expect(openers.openImage(image)).rejects.toThrow("OpenImageFailed");
    expect(readFileSync(log, "utf8")).toBe(`1\n${image}\n1\n${image}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("images Bun can't decode here still open, by their header", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-image-opener-")));
  const log = join(dir, "opened");
  using env = scopedEnv({ PATH: dir, CORGI_TEST_OPENER_LOG: log });
  try {
    writeFileSync(join(dir, command), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CORGI_TEST_OPENER_LOG"\n', { mode: 0o700 });
    const iso = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp" + brand + "\0\0\0\0")]);
    const files = {
      "scan.tiff": Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]),
      "scan.TIF": Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]),
      "photo.heic": iso("heic"),
      "photo.avif": iso("avif"),
    };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, "clip.heic"), iso("isom"));

    const openers = new Openers();
    for (const name of Object.keys(files)) await openers.openImage(join(dir, name));
    await expect(openers.openImage(join(dir, "clip.heic"))).rejects.toThrow("NotAnImage");
    expect(readFileSync(log, "utf8")).toBe(
      Object.keys(files)
        .map(name => join(dir, name) + "\n")
        .join(""),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a viewer left open counts as opened and frees its launch slot", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-image-opener-")));
  const sleep = Bun.which("sleep")!;
  using env = scopedEnv({ PATH: dir });
  try {
    // Like xdg-open without a desktop: it returns when the viewer's window closes, perhaps with an error.
    writeFileSync(join(dir, command), `#!/bin/sh\n${sleep} 1\nexit 1\n`, { mode: 0o700 });
    const image = join(dir, "shot.png");
    writeFileSync(image, Buffer.from(png_base64, "base64"));
    const openers = new Openers(50);
    for (let i = 0; i < 9; i++) await openers.openImage(image);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
