import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { open, overrides } from "./launcher";
import { Quit } from "../../subprocess";

let root: string, account: string, executable: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-omp-launcher-"));
  account = join(root, "account");
  mkdirSync(account);
  executable = process.env.CORGI_OMP_BIN;
  process.env.CORGI_OMP_BIN = join(root, "omp");
  writeFileSync(
    process.env.CORGI_OMP_BIN,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";
const root = process.env.PI_CODING_AGENT_DIR;
appendFileSync(join(root, "starts"), process.cwd() + "\\n");
const id = /default: (\\S+)/.exec(readFileSync(join(root, "config.yml"), "utf8"))[1];
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ type: "response", id: request.id, success: true, data: { model: { provider: "custom", id } } }));
});
`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  if (executable === undefined) delete process.env.CORGI_OMP_BIN;
  else process.env.CORGI_OMP_BIN = executable;
  rmSync(root, { recursive: true, force: true });
});
const config = (model: string) => writeFileSync(join(account, "config.yml"), `modelRoles:\n  default: ${model}\n`);
const starts = () =>
  existsSync(join(account, "starts")) ? readFileSync(join(account, "starts"), "utf8").trim().split("\n").length : 0;

test("omp starts once until its config changes, and once more per folder that sets a model", async () => {
  config("first");
  const launcher = open(account);
  try {
    expect(await launcher.model(root, new Quit())).toMatchObject({
      model: "custom/first",
      source: "Effective omp settings",
    });
    await launcher.model(root, new Quit());
    expect(starts()).toBe(1);
    config("second-choice");
    expect((await launcher.model(root, new Quit())).model).toBe("custom/second-choice");
    expect(starts()).toBe(2);
    // A folder's settings matter only when they set a model, from any file omp layers in.
    const project = (folder: string, file: string, text: string) => {
      mkdirSync(join(root, folder, dirname(file)), { recursive: true });
      writeFileSync(join(root, folder, file), text);
    };
    project("plain", ".claude/settings.json", JSON.stringify({ model: "opus" }));
    project("native", ".omp/config.yml", "modelRoles:\n  default: native\n");
    project("claude", ".claude/settings.json", JSON.stringify({ modelRoles: { default: "borrowed" } }));
    for (const folder of ["plain", "native", "claude", "native", "claude"])
      await launcher.model(join(root, folder), new Quit());
    expect(starts()).toBe(4);
    const started = readFileSync(join(account, "starts"), "utf8").trim().split("\n");
    expect(started.slice(2).map(cwd => cwd.slice(cwd.lastIndexOf("/") + 1))).toEqual(["native", "claude"]);
    // It picks among sign-ins when no default is set.
    const db = new Database(join(account, "agent.db"));
    db.run(
      "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, identity_key TEXT, disabled_cause TEXT)",
    );
    db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'api_key', '{}')");
    await launcher.model(root, new Quit());
    db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', '{}')");
    await launcher.model(root, new Quit());
    db.close();
    expect(starts()).toBe(5);
    expect(overrides(join(root, "plain"))).toEqual([]);
  } finally {
    launcher.close();
  }
});
