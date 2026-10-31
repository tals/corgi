import { isAbsolute } from "node:path";
import { Worker as CommandWorker } from "./launch/command";
import { Worker as PreviewWorker, Preview, Option, active_every, idle_every } from "./launch/preview";
import { byProvider } from "./providers";
import { Worker as HistoryWorker } from "./launch/history";
import { stringify } from "./json";
import * as launcherConfig from "./launcher_config";
import type { Server } from "./server";
import type { Client } from "./peer";
import type { DecodedRequest } from "./protocol";
type Request = Extract<
  DecodedRequest,
  { op: "agent.history" | "agent.command.preview" | "agent.subscribe" | "agent.preview" | "agent.track_usage" }
>;
export type Subscription = {
  cwd: string;
  /** Manage agents is open, which lists every account, shown or not. */
  all: boolean;
  preview: Preview;
  checked: number;
  history_asked: boolean;
  history_epoch: bigint;
  history_sent: bigint;
};
export class Service {
  command_previews = CommandWorker.start();
  launch_previews = PreviewWorker.start();
  launch_history: HistoryWorker | null = null;
  /** When the preview worker last learned what its rows are used for, in ms. */
  used_at = 0;
  startHistory() {
    return (this.launch_history ??= HistoryWorker.start());
  }
  async stop() {
    await Promise.all([this.command_previews.stop(), this.launch_previews.stop(), this.launch_history?.stop()]);
  }
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
export async function request(server: Server, client: Client, request: Request) {
  const s = service(server);
  if (request.op === "agent.history") {
    const q = request.payload;
    const reader = s.startHistory();
    if (q.follow) {
      const subscription = client.launch_preview;
      if (!subscription) throw Error("NotSubscribed");
      subscription.history_asked = true;
      subscription.history_epoch = 0n;
    } else client.reply(request.op, { history: reader.snapshot() });
    return;
  }
  const q = request.payload;
  const ws = server.runtime.getWorkspace(q.workspace),
    cwd = q.cwd || ws.cwd;
  if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
  if (request.op === "agent.command.preview") {
    client.reply(request.op, {
      resolution: s.command_previews.request(request.payload.request, request.payload.command, cwd),
    });
    return;
  }
  const subscribe = request.op === "agent.subscribe",
    all = request.op === "agent.subscribe" && request.payload.all;
  if (subscribe && (client.viewer || client.subscribed)) throw Error("AlreadyAttached");
  if (all) use(server, s, true);
  const preview =
    request.op === "agent.track_usage" ? s.launch_previews.trackUsage(cwd) : s.launch_previews.preview(cwd, subscribe);
  if (subscribe) {
    client.launch_preview = {
      cwd,
      all,
      preview,
      checked: Date.now(),
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    } satisfies Subscription;
    client.queue({ type: "agent.preview", cwd, preview });
  } else client.queue({ ok: true, preview });
}
/** Input this recent in any viewer reads accounts every `active_every`. */
const active_ms = 5 * 60 * 1000;
/** How often the preview worker learns what its rows are used for, in ms. */
const use_ms = 1000;
/** Tells the preview worker which rows its launchers, agents and Manage
 * agents use, so it reads no others. */
function use(server: Server, s: Service, all = false) {
  s.used_at = Date.now();
  all ||= server.clients.some(c => !c.dead && c.launch_preview?.all);
  s.launch_previews.use(launcherConfig.uses(server.runtime, all));
}
/** Lets the preview worker read accounts on its own schedule, often while
 * someone uses a viewer and rarely when no one does or none is attached. */
export function sample(server: Server) {
  const now = Date.now(),
    s = service(server),
    active = server.clients.some(c => c.viewer && !c.dead && now - c.input_at < active_ms);
  if (now - s.used_at >= use_ms) use(server, s);
  s.launch_previews.sample(active ? active_every : idle_every);
}
export function publish(server: Server, client: Client) {
  const subscription = client.launch_preview;
  if (!subscription) return;
  const s = service(server);
  if (!subscription || !s || client.dead || client.output.length || Date.now() - subscription.checked < 100) return;
  subscription.checked = Date.now();
  if (subscription.history_asked) {
    s.startHistory();
  }
  if (subscription.history_asked && s.launch_history) {
    const update = s.launch_history.update(subscription.history_epoch, subscription.history_sent);
    if (update) {
      client.queue({ type: "agent.history", update });
      subscription.history_epoch = update.epoch;
      subscription.history_sent = update.revision;
    }
  }
  let preview = s.launch_previews.preview(subscription.cwd);
  if (preview.pending) {
    // A restored subscription can have readings its new worker has not read yet.
    const previous = subscription.preview,
      keep = (next: Option, old: Option | undefined) =>
        next.pending && old ? Object.assign(new Option(), old, { pending: true }) : next;
    preview = Object.assign(new Preview(), preview, {
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
  if (stringify(preview) === stringify(subscription.preview)) return;
  client.queue({ type: "agent.preview", cwd: subscription.cwd, preview });
  subscription.preview = preview;
}
