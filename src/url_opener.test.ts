import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import { scopedEnv } from "./fixtures/env";
import { Openers } from "./url_opener";

test("the native opener gets one validated image path and reports a failed launch", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-image-opener-")));
  const log = join(dir, "opened");
  using env = scopedEnv({ PATH: dir, CORGI_TEST_OPENER_LOG: log, CORGI_TEST_OPENER_EXIT: "0" });
  try {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
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
    await expect(openers.openImage(mislabeled)).rejects.toThrow();
    await expect(openers.openImage(alias)).rejects.toThrow("NotAnImage");
    expect(readFileSync(log, "utf8")).toBe(`1\n${image}\n`);

    using failed = scopedEnv({ CORGI_TEST_OPENER_EXIT: "1" });
    await expect(openers.openImage(image)).rejects.toThrow("OpenImageFailed");
    expect(readFileSync(log, "utf8")).toBe(`1\n${image}\n1\n${image}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
