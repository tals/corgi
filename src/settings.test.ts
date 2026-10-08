import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as settings from "./settings";

test("saves keep settings they don't set", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-settings-"));
  try {
    const file = join(root, "nested", "settings.json");
    expect(settings.read(file)).toEqual({});
    settings.update(file, { inference: "claude" });
    writeFileSync(file, JSON.stringify({ ...settings.read(file), shell: "/bin/zsh", other: 1 }));
    settings.update(file, { inference: "off" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ inference: "off", shell: "/bin/zsh", other: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shell setting is a nonblank string; anything else is unset", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-settings-")),
    file = join(root, "settings.json");
  try {
    expect(settings.shell(file)).toBeNull();
    for (const [value, expected] of [
      [" /bin/zsh ", "/bin/zsh"],
      ["fish", "fish"],
      ["  ", null],
      [42, null],
      [null, null],
    ] as const) {
      writeFileSync(file, JSON.stringify({ shell: value }));
      expect(settings.shell(file)).toBe(expected);
    }
    for (const text of ["[]", "not json", JSON.stringify({ shell: "/bin/zsh", pad: "x".repeat(70000) })]) {
      writeFileSync(file, text);
      expect(settings.shell(file)).toBeNull();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smart links stay on unless the setting is false", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-settings-")),
    file = join(root, "settings.json");
  try {
    expect(settings.smartLinks(file)).toBe(true);
    for (const value of [true, "false", 0, null]) {
      writeFileSync(file, JSON.stringify({ smart_links: value }));
      expect(settings.smartLinks(file)).toBe(true);
    }
    writeFileSync(file, JSON.stringify({ smart_links: false }));
    expect(settings.smartLinks(file)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
