import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Sandbox } from "./sandbox";
import * as preferences from "../src/preferences";
import * as state_formats from "../src/persist/state_formats";

test.each([
  ["Ctrl+A", false, "ctrl+b"],
  ["control+a", false, "ctrl+b"],
  ["Ctrl+B", false, "ctrl+a"],
  ["control+b", false, "ctrl+a"],
  ["f9", false, "ctrl+b"],
  ["ctrl+space", false, "ctrl+b"],
  ["ctrl_a", true, "ctrl+b"],
  ["ctrl_b", true, "ctrl+a"],
])("nested sandboxes avoid the outer prefix %s (legacy: %s)", (prefix, legacy, expected) => {
  const root = mkdtempSync(join(tmpdir(), "corgi-sandbox-prefix-")),
    saved = Object.fromEntries(["CORGI_PANE", "CORGI_ENV_DIR", "XDG_STATE_HOME"].map(key => [key, process.env[key]]));
  try {
    process.env.CORGI_PANE = "1";
    process.env.CORGI_ENV_DIR = join(root, "env");
    process.env.XDG_STATE_HOME = join(root, "state");
    const where = preferences.paths(),
      files = legacy
        ? ([[where.viewer, { prefix }]] as const)
        : ([
            [where.viewer, { format: state_formats.viewer.current }],
            [where.config, { prefix }],
          ] as const);
    for (const [file, value] of files) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value));
    }
    const sandbox = new Sandbox("prefix-test", { seed() {}, arrange() {}, intro: () => [] }, root, "unused");
    expect(sandbox.prefix).toBe(expected);
    expect(sandbox.intro()).toContain(`this sandbox uses ${sandbox.prefixName}`);
    for (const [file, value] of files) expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
