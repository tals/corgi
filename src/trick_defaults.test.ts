import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as defaults from "./trick_defaults";

test("default account colors are ordinary editable code, installed once without replacing user choices", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-default-tricks-")),
    file = join(root, "account-colors/main.mjs"),
    marker = join(root, ".defaults");
  try {
    defaults.install(root);
    expect(readFileSync(file, "utf8")).toBe(
      readFileSync(new URL("../examples/tricks/account-colors/main.mjs", import.meta.url), "utf8"),
    );
    writeFileSync(file, "// my own colors\n");
    rmSync(marker);
    defaults.install(root);
    expect(readFileSync(file, "utf8")).toBe("// my own colors\n");
    rmSync(join(root, "account-colors"), { recursive: true });
    defaults.install(root);
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
