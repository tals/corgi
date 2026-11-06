import * as os from "./os";
import { basename, isAbsolute } from "node:path";
import { Worker as CommandWorker } from "./launch/command";
import { Worker as PreviewWorker, Option, active_every, idle_every, Preview } from "./launch/preview";
import { byProvider, type Provider } from "./providers";
import * as discovery from "./discovery";
import * as accounts from "./accounts";
import * as integration from "./integration";
import { Worker as HistoryWorker } from "./launch/history";
import type { Launch, Removed } from "./launch/row";
import { stringify } from "./json";
import type { Server } from "./server";
import type { Runtime } from "./runtime";
import { Reply, type Client } from "./peer";
import type { DecodedRequest } from "./protocol";
type Request = Extract<
  DecodedRequest,
  {
    op:
      | "agent.history"
      | "agent.command.preview"
      | "agent.subscribe"
      | "agent.preview"
      | "agent.preview.cached"
      | "agent.track_usage";
  }
>;
export type Subscription = {
  cwd: string;
  preview: Preview;
  checked: number;
  history_asked: boolean;
  history_epoch: bigint;
  history_sent: bigint;
};
/** The worker preview each subscription last published from; kept out of handoffs. */
const sources = new WeakMap<Subscription, Preview>();
export class Service {
  command_previews = CommandWorker.start();
  launch_previews = PreviewWorker.start();
  launch_history: HistoryWorker | null = null;
  startHistory(removed: Removed) {
    return (this.launch_history ??= HistoryWorker.start(removed));
  }
  /** Tells the workers which rows Manage agents took out, which they then don't read. */
  follow(removed: Removed) {
    this.launch_previews.follow(removed);
    void this.launch_history?.follow(removed);
  }
  async stop() {
    await Promise.all([this.command_previews.stop(), this.launch_previews.stop(), this.launch_history?.stop()]);
  }
}
/** What the workers leave unread: the rows Manage agents took out, but those
 * a saved command in the list starts in, its provider's default account. */
export function removed(r: Runtime): Removed {
  return {
    agent_hidden: r.agent_hidden,
    account_hidden: r.account_hidden,
    commands: r.agent_commands.flatMap(({ command, hidden, semantics: { provider, default_account } }): Launch[] =>
      command && !hidden && default_account && provider ? [{ provider, account: "" }] : [],
    ),
  };
}
const services = new WeakMap<Server, Service>();
export function service(server: Server) {
  let value = services.get(server);
  if (!value) {
    value = new Service();
    services.set(server, value);
  }
  return value;
}
export async function stop(server: Server) {
  const service = services.get(server);
  services.delete(server);
  await service?.stop();
}
export async function request(server: Server, client: Client, request: Request, reply = new Reply(client)) {
  if (request.op === "agent.preview.cached") {
    const q = request.payload,
      workspace = server.runtime.getWorkspace(q.workspace),
      cwd = q.cwd || workspace.cwd;
    if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
    reply.ok({ preview: services.get(server)?.launch_previews.cached(cwd) ?? new Preview().with({ pending: false }) });
    return;
  }
  const s = service(server);
  s.follow(removed(server.runtime));
  if (request.op === "agent.history") {
    const q = request.payload;
    const reader = s.startHistory(removed(server.runtime));
    if (q.follow) {
      const subscription = client.launch_preview;
      if (!subscription) throw Error("NotSubscribed");
      subscription.history_asked = true;
      subscription.history_epoch = 0n;
      // History follows as untagged events; the request itself still gets a reply.
      reply.ok();
    } else reply.ok({ history: reader.snapshot() });
    return;
  }
  const q = request.payload;
  const ws = server.runtime.getWorkspace(q.workspace),
    cwd = q.cwd || ws.cwd;
  if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
  if (request.op === "agent.command.preview") {
    reply.ok({
      resolution: s.command_previews.request(request.payload.request, request.payload.command, cwd),
    });
    return;
  }
  const subscribe = request.op === "agent.subscribe";
  if (subscribe && (client.watching || client.subscribed)) throw Error("AlreadyAttached");
  const preview =
    request.op === "agent.track_usage" ? s.launch_previews.trackUsage(cwd) : s.launch_previews.preview(cwd, subscribe);
  if (subscribe) {
    client.launch_preview = {
      cwd,
      preview,
      checked: Date.now(),
      history_asked: client.launch_preview?.history_asked ?? false,
      history_epoch: client.launch_preview?.history_epoch ?? 0n,
      history_sent: client.launch_preview?.history_sent ?? 0n,
    } satisfies Subscription;
    reply.send({ type: "agent.preview", cwd, preview });
  } else reply.send({ ok: true, preview });
}
/** Finds `providers` afresh, as Find agents asks or as an agent Corgi took
 * for a shim that would install it runs, and sets up those it finds:
 * Codex's title, for one, needs Codex to be there. */
export async function discover(server: Server, providers: readonly Provider[], cwd = process.cwd()) {
  await service(server).launch_previews.rediscover(providers, cwd);
  for (const p of providers)
    if (discovery.installed(p, cwd))
      for (const account of ["", ...accounts.known().flatMap(a => (a.provider === p ? [a.dir] : []))])
        void integration.prepare(p, account, false, cwd);
}
/** Keep waiting across preview reads that discover the installation first. */
const rescanned = new WeakMap<Server, Map<string, "waiting" | "rescanned">>();
/** Finds and sets up an install-on-use agent once its installer hands off. */
export function agentRan(server: Server, provider: Provider, pid: number): void {
  let seen = rescanned.get(server);
  const key = `${provider}:${pid}`,
    state = seen?.get(key);
  if (state === "rescanned") return;
  const cwd = os.processCwd(pid) ?? process.cwd();
  if (!state && !discovery.onDemand(provider, cwd)) return;
  if (!seen) rescanned.set(server, (seen = new Map()));
  seen.set(key, "waiting");
  const executable = os.processPath(pid);
  if (!executable || basename(executable) === "mise") return;
  seen.set(key, "rescanned");
  discover(server, [provider], cwd).catch(() => {});
}
/** Input this recent in any viewer reads accounts every `active_every`. */
const active_ms = 5 * 60 * 1000;
/** Lets the preview worker read accounts on its own schedule, often while
 * someone uses a viewer and rarely when no one does or none is attached. */
export function sample(server: Server) {
  const now = Date.now(),
    active = server.clients.some(c => c.viewer && !c.dead && now - c.input_at < active_ms),
    s = service(server);
  s.follow(removed(server.runtime));
  s.launch_previews.sample(active ? active_every : idle_every);
}
/** Whether the worker holds a preview this subscription wasn't sent; reads nothing. */
export function due(server: Server, client: Client): boolean {
  const subscription = client.launch_preview,
    s = services.get(server);
  if (!subscription || !s) return false;
  const job = s.launch_previews.jobs.find(j => j.cwd === subscription.cwd);
  return job !== undefined && job.preview !== (sources.get(subscription) ?? subscription.preview);
}
export function publish(server: Server, client: Client) {
  const subscription = client.launch_preview;
  if (!subscription) return;
  const s = service(server);
  if (!subscription || !s || client.dead || client.output.length || Date.now() - subscription.checked < 100) return;
  subscription.checked = Date.now();
  if (subscription.history_asked) {
    s.startHistory(removed(server.runtime));
  }
  if (subscription.history_asked && s.launch_history) {
    const update = s.launch_history.update(subscription.history_epoch, subscription.history_sent);
    if (update) {
      client.queue({ type: "agent.history", update });
      subscription.history_epoch = update.epoch;
      subscription.history_sent = update.revision;
    }
  }
  const source = s.launch_previews.preview(subscription.cwd);
  if (source === (sources.get(subscription) ?? subscription.preview)) return;
  sources.set(subscription, source);
  let preview = source;
  if (preview.pending) {
    // A restored subscription can have readings its new worker has not read yet.
    const previous = subscription.preview,
      keep = (next: Option, old: Option | undefined) =>
        next.pending && old ? Object.assign(new Option(), old, { pending: true }) : next;
    preview = preview.with({
      options: byProvider(p => keep(preview.options[p], previous.options[p])),
      accounts: preview.accounts.map(a => ({
        ...a,
        option: keep(
          a.option,
          previous.accounts?.find(old => old.provider === a.provider && old.account === a.account)?.option,
        ),
      })),
    });
  }
  if (stringify(preview) === stringify(subscription.preview)) {
    subscription.preview = preview;
    return;
  }
  client.queue({ type: "agent.preview", cwd: subscription.cwd, preview });
  subscription.preview = preview;
}
