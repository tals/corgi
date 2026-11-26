//! Corgi's Pi or omp extension, loaded by a test's driver script as its host would load it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An agent folder holding the extension's `source` as extension.mjs, beside a
 * stand-in for corgi-hook that logs each hook, with its arguments, to hooks.jsonl. */
export class Folder implements AsyncDisposable {
  readonly extension: string;
  readonly log: string;
  private readonly sender: string;
  private proc: ReturnType<typeof spawn> | null = null;
  private constructor(readonly root: string) {
    this.extension = join(root, "extension.mjs");
    this.sender = join(root, "hook");
    this.log = join(root, "hooks.jsonl");
  }
  static async create(prefix: string, source: string): Promise<Folder> {
    const folder = new Folder(await mkdtemp(join(tmpdir(), prefix)));
    await writeFile(folder.extension, source);
    await writeFile(
      folder.sender,
      `#!${process.execPath}
import {appendFileSync} from "node:fs";
let text="";for await(const chunk of process.stdin)text+=chunk;
appendFileSync(${JSON.stringify(folder.log)},JSON.stringify({argv:process.argv.slice(2),...JSON.parse(text)})+"\\n");
`,
      { mode: 0o755 },
    );
    return folder;
  }
  /** Runs `driver` as driver.mjs in Corgi's pane 1, with this folder as the agent's. */
  async run(driver: string, env: Record<string, string> = {}, cwd?: string) {
    const path = join(this.root, "driver.mjs");
    await writeFile(path, driver);
    this.proc = spawn(
      path,
      {
        ...process.env,
        CORGI_PI_OWNER: "",
        CORGI_OMP_OWNER: "",
        CORGI_PANE: "1",
        CORGI_SOCKET: "/tmp/unused",
        CORGI_BIN: this.sender,
        PI_CODING_AGENT_DIR: this.root,
        ...env,
      },
      cwd,
    );
    return this.proc;
  }
  /** The hooks sent so far. */
  async hooks(): Promise<any[]> {
    const text = await readFile(this.log, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
  async [Symbol.asyncDispose]() {
    this.proc?.kill();
    await this.proc?.exited;
    await rm(this.root, { recursive: true, force: true });
  }
}
// Without --no-install, Bun fetches the extension's missing SDK imports from npm.
function spawn(path: string, env: Record<string, string | undefined>, cwd?: string) {
  return Bun.spawn([process.execPath, "--no-install", path], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}
