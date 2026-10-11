import { isAbsolute } from "node:path";
import { Worker as CommandWorker } from "./launch/command";
import { Worker as PreviewWorker, Preview } from "./launch/preview";
import { Worker as HistoryWorker } from "./launch/history";
import { stringify } from "./json";
import type { Server } from "./server";
import type { Client } from "./peer";
export type Subscription = {
  cwd: string;
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
export async function request(server: Server, client: Client, op: string, q: any) {
  const s = service(server);
  if (op === "agent.history") {
    const reader = s.startHistory();
    if (q.follow) {
      const subscription = client.launch_preview as Subscription | null;
      if (!subscription) throw Error("NotSubscribed");
      subscription.history_asked = true;
      subscription.history_epoch = 0n;
    } else client.reply(op, { history: reader.snapshot() });
    return;
  }
  const ws = server.runtime.getWorkspace(q.workspace),
    cwd = q.cwd || ws.cwd;
  if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
  if (op === "agent.command.preview") {
    client.reply(op, {
      resolution: s.command_previews.request(q.request, q.command ?? "", cwd),
    });
    return;
  }
  const subscribe = op === "agent.subscribe";
  if (subscribe && (client.viewer || client.subscribed)) throw Error("AlreadyAttached");
  const preview = op === "agent.track_usage" ? s.launch_previews.trackUsage(cwd) : s.launch_previews.preview(cwd);
  if (subscribe) {
    client.launch_preview = {
      cwd,
      preview,
      checked: Date.now(),
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    } satisfies Subscription;
    client.queue({ type: "agent.preview", cwd, preview });
  } else client.queue({ ok: true, preview });
}
export function publish(server: Server, client: Client) {
  const subscription = client.launch_preview as Subscription | null;
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
  if (preview.pending)
    preview = Object.assign(new Preview(), subscription.preview, {
      pending: true,
    });
  if (stringify(preview) === stringify(subscription.preview)) return;
  client.queue({ type: "agent.preview", cwd: subscription.cwd, preview });
  subscription.preview = preview;
}
