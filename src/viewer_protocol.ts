import * as telemetry from "./telemetry";
import { readFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { version } from "./viewer_version";
import { parse as parseAction } from "./action";
import * as surface from "./pane/surface";
import * as session from "./session";
import * as workspace from "./workspace";
import { microTimestamp } from "./clock";
import { stringify } from "./json";
import { version as wire_version, type View as WireView, type Control, type Request } from "./protocol";
import type { Server } from "./server";
import { Reply, type Client } from "./peer";
import type { Snapshot as Resources } from "./trackers/resources";
import * as viewer_stream from "./viewer_stream";
export type { Control } from "./protocol";
export type View = WireView<ReturnType<typeof session.viewerSnapshot>, Resources>;
export interface Interest {
  pane: number;
  cols: number;
  rows: number;
  cell?: { width: number; height: number } | null;
  offset?: number | null;
  known?: {
    identity: bigint;
    revision: bigint;
    offset: number | null;
  } | null;
}
export type Open = Request<"viewer.open">;
export type Sync = Request<"viewer.sync">;
export const viewer_protocol = version;
export function validateInterests(interests: Interest[]) {
  if (interests.length > 64) throw new Error("TooManyPanes");
  const seen = new Set<number>();
  for (const i of interests) {
    if (
      !Number.isInteger(i.cols) ||
      !Number.isInteger(i.rows) ||
      i.cols < 1 ||
      i.cols > 500 ||
      i.rows < 1 ||
      i.rows > 200
    )
      throw new Error("InvalidSize");
    if (seen.has(i.pane)) throw new Error("InvalidTarget");
    seen.add(i.pane);
  }
}
export async function open(s: Server, cl: Client, q: Open, reply = new Reply(cl)) {
  if (cl.subscribed || cl.launch_preview != null || cl.viewer || cl.watching) throw new Error("AlreadyAttached");
  const initial = s.initialWorkspace();
  if (initial && s.runtime.panes.length === 0 && initial.model.count === 0) {
    const starter = s.default_folder_pending;
    if (starter && q.onboarding && !s.runtime.sessions.some(x => x.workspace_id === initial.id)) {
      // A fresh install starts with no workspace, on the button that makes
      // one. The next workspace takes the starter's id unless a later one
      // was made, even one since closed.
      s.runtime.closeWorkspace(initial.id, false);
      if (s.runtime.workspaces.next_id === initial.id + 1) s.runtime.workspaces.next_id = initial.id;
      s.default_folder_pending = false;
      await s.saveWorkspaces();
    } else {
      if (starter && q.cwd) {
        // The starter waited for this folder, and takes its name.
        await s.runtime.workspaces.edit(initial.id, null, q.cwd);
        initial.rename(workspace.folderName(initial.cwd));
        s.default_folder_pending = false;
        await s.saveWorkspaces();
      }
      if (!q.onboarding)
        await s.execute({
          "pane.create": { workspace: initial.id },
        });
    }
  }
  const first = !s.clients.some(other => other.viewer && !other.dead);
  cl.viewer = true;
  cl.viewer_id = s.next_viewer++;
  cl.viewer_pid = q.pid;
  cl.active_seq = ++s.next_active;
  cl.input_at = Date.now();
  const ws = s.initialWorkspace();
  // With every workspace closed, the viewer opens on none.
  cl.view_workspace = ws?.id ?? workspace.Workspace.Id.none;
  cl.protocol_version = wire_version;
  if (first) s.updateTheme(q.theme ?? null);
  reply.ok({
    viewer_protocol: version,
    bell_seq: s.bell_seq,
    workspace: cl.view_workspace,
    focus: ws && ws.model.tabForPane(ws.focus) !== null ? ws.focus : null,
  });
}
function equal(a: surface.Stamp, b: surface.Stamp) {
  return a.identity === b.identity && a.revision === b.revision && a.offset === b.offset;
}
function hash(bytes: string) {
  return BigInt(Bun.hash(bytes));
}
// The sampler publishes a new snapshot; a viewer's frame clock does not change it.
const resource_views = new WeakMap<Resources, Map<number | null, { readings: Resources; hash: bigint }>>();
function resourceView(snapshot: Resources, detail: number | null) {
  let views = resource_views.get(snapshot);
  if (!views) resource_views.set(snapshot, (views = new Map()));
  let view = views.get(detail);
  if (!view) {
    const readings = snapshot.forViewer(detail);
    views.set(detail, (view = { readings, hash: hash(stringify(readings)) }));
  }
  return view;
}
function viewport(value: bigint | null): number | null {
  return value === null ? null : Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value);
}
export async function sync(s: Server, cl: Client, q: Sync, reply = new Reply(cl)) {
  const telemetry_started = telemetry.begin();
  try {
    const view = await synchronize(s, cl, q);
    reply.send(view);
  } finally {
    telemetry.end("daemon.viewer_sync", telemetry_started);
  }
}
export async function synchronize(s: Server, cl: Client, q: Sync) {
  if (!cl.viewer) throw new Error("NotAttached");
  const interests: Interest[] = q.interests.map(i => ({
    ...i,
    offset: viewport(i.offset),
    known: i.known ? { ...i.known, offset: viewport(i.known.offset) } : null,
  }));
  validateInterests(interests);
  if (q.ack >= cl.next_control || q.ack < cl.last_control) throw new Error("InvalidAcknowledgement");
  cl.controls = cl.controls.filter(c => c.seq > q.ack);
  cl.last_control = q.ack;
  cl.interests = interests.filter(i => s.runtime.pane(i.pane) !== null);
  prune(s, cl);
  const before = cl.view_focus;
  cl.view_focus = cl.interests.some(i => i.pane === q.focus) ? q.focus : null;
  cl.watched = q.watched;
  cl.resources = q.resources;
  cl.resource_detail =
    q.resource_detail !== null && s.runtime.workspaces.get(q.resource_detail) ? q.resource_detail : null;
  cl.worktree_detail =
    q.worktree_detail !== null && s.runtime.workspaces.get(q.worktree_detail) ? q.worktree_detail : null;
  if (q.active) {
    cl.active_seq = ++s.next_active;
    cl.input_at = Date.now();
  }
  if (s.runtime.workspaces.index(q.workspace) !== null) cl.view_workspace = q.workspace;
  if (cl.watched) {
    s.visitWorkspace(cl.view_workspace);
    if (s.preferred_workspace !== cl.view_workspace) {
      s.preferred_workspace = cl.view_workspace;
      await s.saveWorkspaces();
    }
    // Only a move counts, so two watched viewers don't trade it every sync.
    const ws = s.runtime.workspaces.get(cl.view_workspace);
    if (
      ws &&
      cl.view_focus !== null &&
      cl.view_focus !== before &&
      ws.focus !== cl.view_focus &&
      ws.model.tabForPane(cl.view_focus) !== null
    ) {
      ws.focus = cl.view_focus;
      s.runtime.wrote();
    }
  }
  await resize(s);
  return capture(s, cl, q.session_hash, q.resources_hash, q.surfaces);
}
function capture(
  s: Server,
  cl: Client,
  session_hash: bigint | null,
  resources_hash: bigint | null,
  surfaces = true,
): View {
  const bucket = Math.floor(microTimestamp() / 5e6),
    rebuild = cl.session_shown !== s.runtime.shown || cl.session_bucket !== bucket || session_hash !== cl.session_hash;
  let snapshot: View["session"] = null;
  if (rebuild) {
    snapshot = session.viewerSnapshot(s.runtime);
    cl.session_hash = hash(stringify(snapshot));
    cl.session_shown = s.runtime.shown;
    cl.session_bucket = bucket;
  }
  const { readings, hash: resourcesHash } = resourceView(s.runtime.resources.current, cl.resource_detail);
  const view: View = {
    type: "view",
    viewer_protocol: version,
    session: session_hash === cl.session_hash ? null : (snapshot ?? session.viewerSnapshot(s.runtime)),
    session_hash: cl.session_hash,
    resources: resources_hash === resourcesHash ? null : readings,
    resources_hash: resourcesHash,
    surfaces: surfaces ? frames(s, cl) : [],
    bell_seq: s.bell_seq,
    bell_kind: s.last_bell_kind,
    controls: cl.controls,
    viewer: cl.viewer_id,
    detach: false,
  };
  return view;
}
/** Pane data has its own socket and codec, bound to the control connection's link. */
export function data(s: Server, control: Client): Client | undefined {
  return s.clients.find(client => client.stream_data && client.watch_viewer === control.viewer_id && !client.dead);
}
export function bindData(s: Server, cl: Client, id: string): number {
  if (cl.viewer || cl.subscribed || cl.launch_preview || cl.link || cl.watching) throw Error("AlreadyAttached");
  const control = s.clients.find(client => client.viewer && client.link?.id === id && !client.dead);
  if (!control) throw Error("NoViewer");
  control.cancelFrame();
  control.stream = null;
  data(s, control)?.close();
  cl.watching = cl.stream_data = true;
  cl.watch_viewer = control.viewer_id;
  if (control.controls.length) control.queue({ type: "viewer.controls", controls: control.controls });
  return control.viewer_id;
}
export async function configure(s: Server, cl: Client, q: Request<"viewer.stream.configure">): Promise<void> {
  const output = data(s, cl);
  if (!cl.viewer || !output) throw Error("NoViewerData");
  const initial = await start(s, cl, q, true);
  output.queue({ ...initial, type: "viewer.frame" }, cl.stream?.delivery);
}
/** Stream messages have their own envelope; they never consume an RPC reply. */
export async function start(s: Server, cl: Client, q: Request<"viewer.stream">, separate = false) {
  cl.cancelFrame();
  cl.stream = null;
  const view = await synchronize(s, cl, { ...q, surfaces: true });
  if (separate) view.controls = [];
  cl.stream = {
    separate,
    sequence: q.sequence,
    session_hash: null,
    resources_hash: null,
    sent: 0,
    wake: 0n,
    heartbeat: Math.min(5000, Math.max(250, q.heartbeat_ms)),
    delivery: q.incremental ? new viewer_stream.Frames() : undefined,
  };
  const encoded = cl.stream.delivery?.offer(view);
  remember(cl, view, s.wakeSeq(cl.viewer_id));
  return {
    type: "viewer.stream" as const,
    viewer_protocol: version,
    sequence: q.sequence,
    view: encoded?.view ?? view,
    ...(encoded ? { frame: encoded.frame } : {}),
  };
}
export function receipt(s: Server, cl: Client, q: Request<"viewer.receipt">): boolean {
  if (!cl.viewer) throw Error("NotAttached");
  if (cl.stream?.sequence !== q.sequence || !cl.stream.delivery) return false;
  if (cl.stream.separate && !data(s, cl)) {
    cl.stream = null;
    return false;
  }
  if (q.active) {
    cl.active_seq = ++s.next_active;
    cl.input_at = Date.now();
  }
  cl.stream.delivery.acknowledge(q.frame);
  publish(s, cl, s.wakeSeq(cl.viewer_id));
  return true;
}
export function publish(s: Server, cl: Client, wake: bigint, now = Date.now(), scheduled = false): void {
  const stream = cl.stream;
  if (!stream || cl.dead || !cl.viewer) return;
  const output = stream.separate ? data(s, cl) : cl;
  if (!output) return;
  if (stream.delivery && !stream.delivery.available) return;
  if (stream.wake === wake && now - stream.sent < stream.heartbeat) return;
  if (output.queued || now - stream.sent < 16 || (stream.separate && !scheduled)) {
    output.deferFrame(stream.sent + 16, () => {
      if (cl.stream === stream) publish(s, cl, wake, Date.now(), true);
    });
    return;
  }
  const view = capture(s, cl, stream.session_hash, stream.resources_hash);
  if (stream.separate) view.controls = [];
  prune(s, cl);
  const encoded = stream.delivery?.offer(view);
  if (stream.delivery && !encoded) return;
  if (encoded?.probe) stream.sent = now;
  else remember(cl, view, wake, now);
  output.queue(
    {
      type: "viewer.frame",
      sequence: stream.sequence,
      view: encoded?.view ?? view,
      ...(encoded ? { frame: encoded.frame } : {}),
    },
    stream.delivery,
  );
}
/** Lets a stream forget the screens of panes the viewer stopped watching, or that closed. */
function prune(s: Server, cl: Client): void {
  cl.stream?.delivery?.keep(new Set(cl.interests.filter(i => s.runtime.pane(i.pane)).map(i => i.pane)));
}
export function remember(cl: Client, view: View, wake: bigint, now = Date.now()): void {
  cl.cancelFrame();
  if (!cl.stream) return;
  cl.stream.sent = now;
  cl.stream.wake = wake;
  cl.stream.session_hash = view.session_hash;
  cl.stream.resources_hash = view.resources_hash;
  for (const frame of view.surfaces) {
    const interest = cl.interests.find(i => i.pane === frame.surface.pane);
    if (interest) interest.known = frame.stamp;
  }
}
function frames(s: Server, cl: Client): surface.View[] {
  const frames: surface.View[] = [];
  for (const interest of cl.interests) {
    const pane = s.runtime.pane(interest.pane);
    if (!pane) continue;
    const shown = pane.displayed();
    if (interest.known && equal(interest.known, surface.stamp(shown, interest.offset ?? null))) continue;
    const view = surface.captureView(interest.pane, shown, interest.offset ?? null);
    if (shown !== pane.terminal) view.modes = surface.modes(pane.terminal);
    frames.push(view);
  }
  return frames;
}
/** The control connection owns viewer state; its data connection watches it. */
function owner(s: Server, cl: Client): Client {
  if (cl.viewer) return cl;
  if (!cl.watching) throw Error("NotAttached");
  return targetViewer(s, cl.watch_viewer);
}
export function surfaces(s: Server, cl: Client, reply = new Reply(cl)) {
  reply.ok({ surfaces: frames(s, owner(s, cl)) });
}
export async function search(s: Server, cl: Client, q: Request<"viewer.search">, reply = new Reply(cl)) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  reply.ok(await p.displayed().search(q.needle, viewport(q.skip)!));
}
export async function pick(s: Server, cl: Client, q: Request<"viewer.pick">, reply = new Reply(cl)) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  reply.ok(await p.displayed().pick(q.unit, q.x, q.y, q.to_x, q.to_y, viewport(q.offset)!));
}
export function image(s: Server, cl: Client, q: Request<"viewer.image">, reply = new Reply(cl)) {
  const viewer = owner(s, cl);
  const pane = s.runtime.pane(q.pane);
  if (!pane || !viewer.interests.some(i => i.pane === q.pane)) throw new Error("NoPane");
  reply.ok({ data: pane.displayed().native({ op: "image", text: q.image, skip: q.offset }) });
}
/** The pane `q` names, if it still runs the agent the viewer showed. */
function shownPane(s: Server, q: Request<"pane.mark_unread">) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  const bound = p.attachment.actor?.id ?? 0;
  if (
    q.session !== p.agent().sessionId() ||
    (q.binding !== null && q.binding !== undefined && q.binding !== p.attachment.generation) ||
    (q.conversation !== null && q.conversation !== undefined && q.conversation !== bound)
  )
    throw new Error("StaleAcknowledgement");
  return p;
}
export function acknowledge(s: Server, cl: Client, q: Request<"pane.acknowledge">, reply = new Reply(cl)) {
  const p = shownPane(s, q),
    agent = p.agent();
  if (agent.attention !== "none" || agent.observation.unread()) {
    if (p.attachment.actor) p.attachment.actor.acknowledge(q.through, q.attention_at);
    else {
      if (q.attention_at === BigInt(agent.changed_at)) agent.attention = "none";
      agent.readThrough(q.through);
    }
    s.runtime.changed();
    s.dirty = true;
  }
  reply.send({ ok: true });
}
export function markUnread(s: Server, cl: Client, q: Request<"pane.mark_unread">, reply = new Reply(cl)) {
  if (shownPane(s, q).agent().markUnread()) {
    s.runtime.changed();
    s.dirty = true;
  }
  reply.send({ ok: true });
}
export async function paste(s: Server, cl: Client, q: Request<"pane.paste">, reply = new Reply(cl)) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  const contents: { mime: string; data: Uint8Array }[] = [];
  if (q.text != null) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(q.text))
      throw new Error("InvalidBase64");
    contents.push({ mime: "text/plain", data: Buffer.from(q.text, "base64") });
  }
  if (q.image) {
    const folder = join(dirname(s.socket), "paste");
    if (!q.image.mime.startsWith("image/") || dirname(q.image.path) !== folder) throw new Error("InvalidTarget");
    const data = await readFile(q.image.path);
    if (data.length > 32 * 1024 * 1024) throw new Error("StreamTooLong");
    contents.push({ mime: q.image.mime, data });
  }
  reply.ok({ pasted: await p.terminal.pasteEvent(contents) });
}
export async function resize(s: Server) {
  for (const p of s.runtime.panes) {
    let chosen: Interest | null = null,
      latest = 0;
    for (const cl of s.clients) {
      if (!cl.viewer || cl.dead || (chosen !== null && cl.active_seq <= latest)) continue;
      const interest = cl.interests.find(i => i.pane === p.id);
      if (interest) {
        chosen = interest;
        latest = cl.active_seq;
      }
    }
    if (chosen && (p.terminal.cols !== chosen.cols || p.terminal.rows !== chosen.rows)) {
      await p.resize(chosen.cols, chosen.rows);
      s.runtime.changed();
      s.dirty = true;
    }
    if (chosen?.cell) {
      p.terminal.native({ op: "pixels", start_x: chosen.cell.width, start_y: chosen.cell.height });
    }
  }
}
export function targetViewer(s: Server, id: number | null | undefined) {
  const target = s.clients.find(cl => cl.viewer && !cl.dead && (id == null || cl.viewer_id === id));
  if (!target) throw new Error("NoViewer");
  return target;
}
export function viewerShowing(s: Server, pane: number) {
  const targets = s.clients.filter(cl => cl.viewer && !cl.dead && cl.view_focus === pane);
  if (targets.length > 1) throw new Error("AmbiguousViewer");
  if (!targets.length) throw new Error("NoViewer");
  return targets[0];
}
/** Hands `target` a control, and wakes it if it is watched. */
export function queue(s: Server, target: Client, value: Omit<Control, "seq">) {
  if (target.controls.length >= 64) throw new Error("ViewerBusy");
  target.controls.push({ ...value, seq: target.next_control++ });
  if (data(s, target)) target.queue({ type: "viewer.controls", controls: target.controls });
  s.dirty = true;
}
function send(s: Server, reply: Reply, target: Client, value: Omit<Control, "seq">) {
  queue(s, target, value);
  reply.send({ ok: true, viewer: target.viewer_id, queued: true });
}
export function action(s: Server, cl: Client, q: Request<"action">, reply = new Reply(cl)) {
  const act = parseAction(q.name, q.value ?? "");
  let target: Client;
  if (act.name === "relaunch") {
    if (q.pane == null) throw new Error("NoViewer");
    target = viewerShowing(s, q.pane);
    if (!isAbsolute(String(act.value))) throw new Error("InvalidExecutable");
  } else if ((act.name === "onboard" || act.name === "open") && q.pane != null) target = viewerShowing(s, q.pane);
  else target = targetViewer(s, q.viewer);
  send(s, reply, target, { kind: "action", name: q.name, value: q.value ?? "" });
}
export function focus(s: Server, cl: Client, q: Request<"focus">, reply = new Reply(cl)) {
  const target = targetViewer(s, q.viewer);
  if (!s.runtime.pane(q.pane)) throw new Error("NoPane");
  send(s, reply, target, { kind: "focus", id: q.pane });
}
export function switchWorkspace(s: Server, cl: Client, q: Request<"workspace.switch">, reply = new Reply(cl)) {
  const target = targetViewer(s, q.viewer);
  s.runtime.getWorkspace(q.workspace);
  send(s, reply, target, { kind: "workspace", id: q.workspace });
}
export function copy(s: Server, pane: number, text: string) {
  let target: Client | null = null;
  for (const view of s.clients)
    if (
      view.viewer &&
      !view.dead &&
      (!target || view.active_seq > target.active_seq) &&
      view.interests.some(i => i.pane === pane)
    )
      target = view;
  if (!target) return;
  target.controls = target.controls.filter(c => c.kind !== "action" || c.name !== "copy");
  queue(s, target, { kind: "action", name: "copy", value: text });
}
/** The attached viewers. `active` grows with each one's latest input, so the
 * highest is the one used last. */
export function viewers(s: Server) {
  return s.clients
    .filter(cl => cl.viewer && !cl.dead)
    .map(cl => ({
      id: cl.viewer_id,
      pid: cl.viewer_pid,
      active: cl.active_seq,
      workspace: cl.view_workspace,
      pane: cl.view_focus,
      watched: cl.watched,
    }));
}
