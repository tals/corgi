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
    const manifest = join(root, "account-colors/trick.toml"),
      expected = readFileSync(new URL("../examples/tricks/account-colors/trick.toml", import.meta.url), "utf8");
    expect(readFileSync(manifest, "utf8")).toBe(expected);
    writeFileSync(manifest, 'version = 1\nid = "account-colors"\nentry = "main.mjs"\n');
    defaults.install(root);
    expect(readFileSync(manifest, "utf8")).toBe(expected);
    writeFileSync(manifest, expected.replace("Color sidebar markers", "My own markers"));
    defaults.install(root);
    expect(readFileSync(manifest, "utf8")).toContain("My own markers");
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
