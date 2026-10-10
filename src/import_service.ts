//! Daemon adapter for onboarding ownership and copy transactions.
import { Manager, importBridge } from "./import/herdr";
import { Job } from "./import/onboarding";
import { exclusion } from "./protocol";
import type { Server } from "./server";
import type { Client } from "./peer";
export { importBridge };
class Service {
  herdr_import = new Manager();
  onboarding_copy = new Job();
  handoff_operation = 0n;
  starter: { id: number; revision: bigint } | null = null;
  copying = false;
  remember(server: Server) {
    this.starter = null;
    const r = server.runtime;
    if (r.workspaces.items.length !== 1 || r.sessions.length) return;
    const ws = r.workspaces.items[0];
    if (!ws.model.count && !ws.name_len) this.starter = { id: ws.id, revision: ws.model.revision };
  }
  async finish(server: Server, destination: number | null) {
    const starter = this.starter;
    this.starter = null;
    if (
      !starter ||
      destination === null ||
      destination === starter.id ||
      server.runtime.workspaces.index(destination) === null
    )
      return;
    const ws = server.runtime.workspaces.get(starter.id);
    if (!ws || ws.model.count || ws.name_len || ws.model.revision !== starter.revision) return;
    try {
      await server.runtime.closeWorkspace(starter.id, false);
    } catch {
      return;
    }
    server.default_folder_pending = false;
    server.preferred_workspace = destination;
    for (const client of server.clients) if (client.view_workspace === starter.id) client.view_workspace = destination;
  }
}
const services = new WeakMap<Server, Service>();
export function service(server: Server): Service {
  let value = services.get(server);
  if (!value) {
    value = new Service();
    services.set(server, value);
  }
  return value;
}
export function admit(server: Server, op: string): void {
  const s = services.get(server),
    kind = exclusion(op),
    importing = !!s && (s.herdr_import.busy() || s.onboarding_copy.busy()),
    reloading = (server as any).reload_executable != null;
  if (kind === "layout" && (s?.herdr_import.locked() || s?.onboarding_copy.busy())) throw Error("ImportInProgress");
  if (kind === "import" && (importing || reloading)) throw Error("ImportInProgress");
  if (kind === "push" && reloading) throw Error("ReloadInProgress");
  if (kind === "reload") {
    if (importing) throw Error("ImportInProgress");
    if (reloading) throw Error("ReloadInProgress");
    if (server.runtime.git_push.busy()) throw Error("GitPushInProgress");
  }
  if (kind === "shutdown" && importing) throw Error("ImportInProgress");
}
export async function request(server: Server, client: Client, op: string, q: any): Promise<void> {
  const s = service(server),
    operation = BigInt(q.operation ?? 0);
  if (op === "onboarding.status") {
    if (operation !== 0n && operation === s.handoff_operation) client.reply(op, { progress: s.herdr_import.status() });
    else if (operation !== 0n && operation === s.onboarding_copy.operation)
      client.reply(op, { progress: s.onboarding_copy.progress });
    else throw Error("NoImport");
    return;
  }
  if (operation === 0n) throw Error("InvalidImport");
  const current = op === "onboarding.handoff" ? s.handoff_operation : s.onboarding_copy.operation;
  if (operation === current) {
    client.queue({ ok: true });
    return;
  }
  admit(server, op);
  if (op === "onboarding.handoff") {
    if (!Number.isInteger(q.viewer_pgid) || q.viewer_pgid <= 0) throw Error("InvalidImport");
    s.herdr_import.start(q.socket ?? "", server.executable, server.theme, q.viewer_pgid);
    s.handoff_operation = operation;
  } else if (op === "onboarding.copy")
    s.onboarding_copy.start({
      ...q,
      operation,
      herdr_session: q.herdr_session ?? null,
    });
  else throw Error("UnknownOp");
  s.remember(server);
  client.queue({ ok: true });
}
export async function tick(server: Server): Promise<void> {
  const s = services.get(server);
  if (!s || s.copying) return;
  s.copying = true;
  try {
    const handed = s.herdr_import.tick(server.runtime),
      copied = await s.onboarding_copy.tick(server.runtime, {
        workspace: 0,
        cwd: "/",
        cols: 80,
        rows: 24,
        theme: server.theme,
        socket: server.socket,
        executable: server.executable,
      });
    if (handed) await s.finish(server, s.herdr_import.status().workspace);
    if (copied && s.onboarding_copy.progress.phase === "complete")
      await s.finish(server, s.onboarding_copy.progress.workspace);
    if (handed || copied) {
      server.dirty = true;
      await server.saveWorkspaces();
    }
  } finally {
    s.copying = false;
  }
}
export function stop(server: Server): void {
  const s = services.get(server);
  s?.herdr_import.cancel();
  s?.onboarding_copy.stop();
  services.delete(server);
}
