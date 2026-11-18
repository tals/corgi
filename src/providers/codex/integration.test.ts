import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter } from "../../providers";
import * as discovery from "../../discovery";
import * as integration from "./integration";
import * as mise from "../../fixtures/mise";

test("Codex startup sets up titles with the workspace's executable without running its shim", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-codex-title-"))),
    cwd = join(root, "workspace"),
    account = join(root, "account"),
    executable = join(root, "installed", "codex"),
    edit = join(root, "edit.json"),
    title = spyOn(integration, "installTitle");
  try {
    using env = mise.home(root, { CODEX_HOME: join(root, "default"), CORGI_CODEX_BIN: undefined });
    for (const directory of ["installed", "workspace", "account"]) mkdirSync(join(root, directory));
    const shim = mise.shim(root, "codex");
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
    rmSync(root, { recursive: true, force: true });
  }
});
