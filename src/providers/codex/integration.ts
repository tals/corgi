//! What Codex needs beyond its hooks file: the thread ID in its title, its
//! trust in Corgi's hooks, and approvals that follow the user's own hooks.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as config from "./config";
import { failed, message, type Removal } from "../hooks_file";
import type { IntegrationStepResult } from "../adapter";
import { AppServer } from "./app_server";
/** Adds the thread ID to Codex's terminal title, which is how Corgi learns
 * which thread a pane shows. */
export async function installTitle(directory: string, cwd = process.cwd()): Promise<IntegrationStepResult> {
  const path = join(directory, "config.toml");
  if (!existsSync(directory)) return { item: "title", subject: "thread ID", outcome: "no_config", path: directory };
  const discovery = await import("../../discovery"),
    server = new AppServer(3000, await discovery.resolve("codex", cwd), directory);
  try {
    const reply = await server.request("config/read", { includeLayers: true });
    const edit = config.edit(reply.result, path);
    if (!edit) return { item: "title", subject: "thread ID", outcome: "present", path };
    config.backup(path);
    await server.request("config/value/write", edit);
    return { item: "title", subject: "thread ID", outcome: "added", path };
  } finally {
    server.close();
  }
}
export function titleStatus(directory: string): IntegrationStepResult {
  const path = join(directory, "config.toml");
  try {
    const title = existsSync(path) ? (Bun.TOML.parse(readFileSync(path, "utf8")) as any).tui?.terminal_title : null,
      shown = Array.isArray(title) && title.includes("thread-id");
    return { item: "title", subject: "thread ID", outcome: shown ? "present" : "absent", path };
  } catch (error) {
    return failed("title", path, error);
  }
}
async function* jsonLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        yield JSON.parse(line);
      } catch {}
    }
  }
}
/** Asks a short-lived Codex app server whether it trusts `command` in
 * `files`, as a note for the hooks line. The inference one can't say: it runs
 * with hooks turned off. */
export async function trust(
  command: string,
  files: string[],
  directory: string,
): Promise<{ note: string; todo: boolean }> {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const discovery = await import("../../discovery"),
      spawned = (child = Bun.spawn([await discovery.resolve("codex"), "app-server", "--listen", "stdio://"], {
        cwd: homedir(),
        env: { ...process.env, CODEX_HOME: directory },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      })),
      messages = jsonLines(spawned.stdout),
      call = async (id: number, method: string, params: unknown) => {
        spawned.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        await spawned.stdin.flush();
        for (;;) {
          const { value, done } = await messages.next();
          if (done) throw Error("CodexExited");
          if (value?.id !== id) continue;
          if (value.error) throw Error(String(value.error.message ?? "CodexError"));
          return value.result;
        }
      },
      ask = async () => {
        await call(1, "initialize", { clientInfo: { name: "corgi", version: "1" }, capabilities: {} });
        spawned.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        return await call(2, "hooks/list", { cwds: [homedir()] });
      },
      result = await Promise.race([
        ask(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Error("Timeout")), 5000))),
      ]);
    const hooks = (result?.data ?? [])
        .flatMap((entry: any) => entry?.hooks ?? [])
        .filter((h: any) => h?.handlerType === "command" && h.command === command && files.includes(h.sourcePath)),
      trusted = hooks.filter((h: any) => h.enabled && ["trusted", "managed"].includes(h.trustStatus)).length;
    if (!hooks.length) return { note: "; Codex doesn't load them", todo: false };
    if (trusted === hooks.length) return { note: ", trusted", todo: false };
    if (!trusted) return { note: "; not trusted yet, approve them in Codex's /hooks", todo: true };
    return { note: `; Codex trusts ${trusted} of ${hooks.length}, approve the rest in /hooks`, todo: true };
  } catch (error) {
    return { note: `; couldn't ask Codex if it trusts them: ${message(error)}`, todo: false };
  } finally {
    clearTimeout(timer);
    child?.kill();
  }
}
/** Codex's approvals for the hooks Corgi removed, and the thread ID in its
 * title, edited through its config API. */
export async function uninstallConfig(directory: string, removal: Removal | null): Promise<IntegrationStepResult[]> {
  const path = join(directory, "config.toml");
  if (!existsSync(path)) return [];
  let original = null;
  try {
    original = Bun.TOML.parse(readFileSync(path + ".corgi-backup", "utf8"));
  } catch {}
  const server = new AppServer(3000, null, directory);
  try {
    const reply = await server.request("config/read", { includeLayers: true });
    const layer = config.userLayer(reply.result, path),
      state = layer.config?.hooks?.state,
      results: IntegrationStepResult[] = [],
      edits = [];
    if (removal && state && typeof state === "object") {
      const hooks = join(directory, "hooks.json"),
        files = [hooks, ...(existsSync(hooks) ? [realpathSync(hooks)] : [])],
        file = files.find(f => Object.keys(state).some(key => key.startsWith(f + ":"))),
        approvals = file ? config.movedApprovals(state, file, removal) : null;
      if (approvals) {
        const value = Object.keys(approvals.state).length ? approvals.state : null;
        edits.push({ keyPath: "hooks.state", value, mergeStrategy: "replace" });
        results.push({
          item: "approvals",
          outcome: "removed",
          path,
          note: approvals.moved ? `; renumbered ${approvals.moved} of yours so they stay trusted` : undefined,
        });
      }
    }
    const title = config.restoredTitle(layer.config?.tui?.terminal_title, original);
    if (title !== undefined) edits.push({ keyPath: "tui.terminal_title", value: title, mergeStrategy: "replace" });
    results.push({ item: "title", subject: "thread ID", outcome: title === undefined ? "absent" : "removed", path });
    if (edits.length)
      await server.request("config/batchWrite", { edits, filePath: path, expectedVersion: layer.version });
    return results;
  } catch (error) {
    return (removal ? ["approvals", "title"] : ["title"]).map(item => failed(item, path, error));
  } finally {
    server.close();
  }
}
