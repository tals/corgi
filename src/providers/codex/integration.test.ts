import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter } from "../../providers";
import * as discovery from "../../discovery";
import * as integration from "./integration";

test("Codex startup sets up titles with the workspace's executable without running its shim", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-codex-title-"))),
    keys = [
      "PATH",
      "HOME",
      "CODEX_HOME",
      "CORGI_CODEX_BIN",
      "CORGI_TEST_SYSTEM_ROOT",
      "MISE_DATA_DIR",
      "MISE_CONFIG_DIR",
      "MISE_SHIMS_DIR",
      "XDG_DATA_HOME",
    ],
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]])),
    cwd = join(root, "workspace"),
    account = join(root, "account"),
    executable = join(root, "installed", "codex"),
    shim = join(root, "shim-ran"),
    edit = join(root, "edit.json"),
    title = spyOn(integration, "installTitle");
  try {
    for (const key of keys) delete process.env[key];
    process.env.HOME = root;
    process.env.CODEX_HOME = join(root, "default");
    process.env.CORGI_TEST_SYSTEM_ROOT = join(root, "system");
    process.env.MISE_SHIMS_DIR = join(root, "shims");
    process.env.PATH = join(root, "bin") + ":" + process.env.MISE_SHIMS_DIR;
    for (const directory of ["bin", "shims", "installed", "workspace", "account"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "shims", "codex"), `#!/bin/sh\n: > '${shim}'\nexit 1\n`, { mode: 0o755 });
    writeFileSync(
      join(root, "bin", "mise"),
      `#!/bin/sh\n[ "$PWD" = '${cwd}' ] && [ "$1:$2" = 'which:codex' ] || exit 1\n` +
        `if [ "$3" = --version ]; then echo '0.166.0'; else echo '${executable}'; fi\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      executable,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] !== "app-server") throw Error("UnexpectedInvocation");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "config/read")
    result = { layers: [{ name: { type: "user", file: process.env.CODEX_HOME + "/config.toml" }, version: "original", config: {} }] };
  if (request.method === "config/value/write") writeFileSync(${JSON.stringify(edit)}, JSON.stringify(request.params));
  console.log(JSON.stringify({ id: request.id, result }));
}
`,
      { mode: 0o755 },
    );
    await adapter("codex").integration.startup(account, false, cwd);
    expect(title).toHaveBeenCalledTimes(1);
    expect(await title.mock.results[0].value).toMatchObject({ outcome: "added" });
    expect(JSON.parse(readFileSync(edit, "utf8"))).toMatchObject({
      keyPath: "tui.terminal_title",
      value: ["app-name", "thread-id", "activity", "project"],
      filePath: join(account, "config.toml"),
    });
    expect(discovery.installed("codex")).toBe(false);
    expect(discovery.installed("codex", cwd)).toBe(true);
    expect(existsSync(shim)).toBe(false);
  } finally {
    title.mockRestore();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
