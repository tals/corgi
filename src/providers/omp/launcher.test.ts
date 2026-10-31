import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./launcher";
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
import { join } from "node:path";
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

test("omp starts once per folder until its config changes", async () => {
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
  } finally {
    launcher.close();
  }
});
