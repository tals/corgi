import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXE, JsonSocket, sleep, tempDir, versioned } from "./support";

const removePrefixes = [
  "CORGI_",
  "CMUX_",
  "HERDR_",
  "CODEX_",
  "CLAUDE_",
  "XDG_",
  "GHOSTTY_",
  "TMUX",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
];

export class ImportFixture {
  temp = tempDir("corgi-import-");
  root = this.temp.name;
  path = join(this.root, "control.sock");
  env: Record<string, string> = {};
  proc: any;
  viewers: any[] = [];
  log = join(this.root, "daemon.log");

  constructor() {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !removePrefixes.some(prefix => key.startsWith(prefix))) this.env[key] = value;
    }
    for (const name of ["home", "config", "state", "bin"]) mkdirSync(join(this.root, name));
    // Debian's zsh opens its new-user wizard in a home without startup files.
    writeFileSync(join(this.root, "home/.zshrc"), "");
    Object.assign(this.env, {
      HOME: join(this.root, "home"),
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      CORGI_SOCKET: this.path,
      CODEX_HOME: join(this.root, "home/.codex"),
      CLAUDE_CONFIG_DIR: join(this.root, "home/.claude"),
      CORGI_INFERENCE_PROVIDER: "off",
      CORGI_SUMMARY_COMMAND: "off",
      CORGI_BELL: "off",
      CORGI_CODEX_BIN: "/usr/bin/false",
      CORGI_CLAUDE_BIN: "/usr/bin/false",
      SHELL: "/bin/sh",
      PATH: join(this.root, "bin") + ":/usr/bin:/bin",
    });
  }

  async start() {
    this.proc = Bun.spawn([EXE, "serve"], {
      env: this.env,
      cwd: this.root,
      stdin: "ignore",
      stdout: Bun.file(this.log),
      stderr: Bun.file(this.log),
    });
    try {
      await this.until(async () => {
        try {
          return await this.rpc({ op: "ping" });
        } catch {
          return false;
        }
      });
    } catch (error) {
      const log = existsSync(this.log) ? readFileSync(this.log, "utf8") : "";
      throw new Error(`Import fixture failed to start: ${String(error)}\n${log}`);
    }
  }

  async rpc(message: { op: string; [field: string]: unknown }, allowError = false) {
    const response = await this.exchange(this.path, versioned(message));
    if (!allowError && "err" in response) throw new Error(`RPC error: ${JSON.stringify(response)}`);
    return response;
  }

  async exchange(path: string, message: Record<string, unknown>, timeoutMs = 3000): Promise<any> {
    if (!path.startsWith(this.root + "/")) throw new Error(`socket outside test fixture: ${path}`);
    const end = Date.now() + timeoutMs;
    const client = await JsonSocket.connect(path, timeoutMs);
    try {
      client.send(message);
      return await client.read(Math.max(0, end - Date.now()));
    } finally {
      client.close();
    }
  }

  async until<T>(predicate: () => Promise<T> | T, timeoutSeconds = 8): Promise<T> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await predicate();
        if (result) return result;
        last = result;
      } catch (error) {
        last = error;
      }
      await sleep(0.02);
    }
    throw new Error(`condition timed out: ${String(last)}`);
  }

  async close() {
    for (const viewer of this.viewers) await viewer.close();
    if (this.proc) {
      try {
        await this.rpc({ op: "shutdown" });
      } catch {
        /* daemon may have exited */
      }
      const exited = await Promise.race([this.proc.exited, sleep(5).then(() => null)]);
      if (exited === null) {
        this.proc.kill();
        await this.proc.exited;
      }
    }
    const log = existsSync(this.log) ? readFileSync(this.log, "utf8") : "";
    this.temp.cleanup();
    if (log.includes("panic:")) throw new Error(`daemon panic:\n${log}`);
  }
}
