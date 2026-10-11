import { readFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { version } from "./viewer_version";
import { parse as parseAction } from "./action";
import * as surface from "./pane/surface";
import * as session from "./session";
import { microTimestamp } from "./clock";
import { stringify } from "./json";
import type { View as WireView, Control } from "./protocol";
import type { Snapshot as Resources } from "./trackers/resources";
export type { Control } from "./protocol";
export type View = WireView<ReturnType<typeof session.viewerSnapshot>, Resources>;
export interface Interest {
  pane: number;
  cols: number;
  rows: number;
  offset?: number | null;
  known?: {
    identity: number | bigint;
    revision: number | bigint;
    offset: number | null;
  } | null;
}
export interface Open {
  cwd?: string;
  onboarding?: boolean;
  theme?: unknown;
}
export interface Sync {
  interests: Interest[];
  focus: number | null;
  workspace: number;
  watched: boolean;
  active: boolean;
  ack: number;
  session_hash: number;
  resources_hash: number;
  resources: boolean;
  resource_detail: number | null;
  worktree_detail: number | null;
}
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
export async function open(s: any, cl: any, q: Open) {
  if (cl.subscribed || cl.launch_preview != null || cl.viewer) throw new Error("AlreadyAttached");
  if (s.runtime.panes.length === 0 && s.initialWorkspace().model.count === 0) {
    if (s.default_folder_pending && q.cwd) {
      await s.runtime.workspaces.edit(s.initialWorkspace().id, s.initialWorkspace().customName(), q.cwd);
      s.default_folder_pending = false;
      await s.saveWorkspaces();
    }
    if (!q.onboarding)
      await s.execute({
        "pane.create": { workspace: s.initialWorkspace().id },
      });
  }
  const first = !s.clients.some((other: any) => other.viewer && !other.dead);
  cl.viewer = true;
  cl.viewer_id = s.next_viewer++;
  cl.active_seq = ++s.next_active;
  cl.view_workspace = s.initialWorkspace().id;
  cl.protocol_version = 1;
  if (first) s.updateTheme(q.theme ?? null);
  cl.reply("viewer.open", {
    viewer_protocol: version,
    bell_seq: s.bell_seq,
    workspace: s.initialWorkspace().id,
  });
}
function equal(a: any, b: any) {
  return stringify(a) === stringify(b);
}
function hash(bytes: string) {
  return Bun.hash(bytes);
}
export async function sync(s: any, cl: any, q: Sync) {
  if (!cl.viewer) throw new Error("NotAttached");
  validateInterests(q.interests);
  if (q.ack >= cl.next_control || q.ack < cl.last_control) throw new Error("InvalidAcknowledgement");
  cl.controls = cl.controls.filter((c: Control) => c.seq > q.ack);
  cl.last_control = q.ack;
  cl.interests = q.interests.filter(i => s.runtime.pane(i.pane) !== null);
  cl.view_focus = cl.interests.some((i: Interest) => i.pane === q.focus) ? q.focus : null;
  cl.watched = q.watched;
  cl.resources = q.resources;
  cl.resource_detail =
    q.resource_detail !== null && s.runtime.workspaces.get(q.resource_detail) ? q.resource_detail : null;
  cl.worktree_detail =
    q.worktree_detail !== null && s.runtime.workspaces.get(q.worktree_detail) ? q.worktree_detail : null;
  if (q.active) cl.active_seq = ++s.next_active;
  if (s.runtime.workspaces.index(q.workspace) !== null) cl.view_workspace = q.workspace;
  if (cl.watched) {
    s.visitWorkspace(cl.view_workspace);
    if (s.preferred_workspace !== cl.view_workspace) {
      s.preferred_workspace = cl.view_workspace;
      await s.saveWorkspaces();
    }
  }
  await resize(s);
  const frames: surface.View[] = [];
  for (const interest of cl.interests as Interest[]) {
    const pane = s.runtime.pane(interest.pane),
      shown = pane.displayed();
    if (interest.known && equal(interest.known, surface.stamp(shown, interest.offset ?? null))) continue;
    const view = surface.captureView(interest.pane, shown, interest.offset ?? null);
    view.modes = surface.modes(pane.terminal);
    frames.push(view);
  }
  const bucket = Math.floor(microTimestamp() / 5e6),
    rebuild =
      cl.session_shown !== s.runtime.shown || cl.session_bucket !== bucket || q.session_hash !== cl.session_hash;
  let snapshot: any = null;
  if (rebuild) {
    snapshot = session.viewerSnapshot(s.runtime);
    cl.session_hash = hash(stringify(snapshot));
    cl.session_shown = s.runtime.shown;
    cl.session_bucket = bucket;
  }
  const readings = s.runtime.resources?.current?.forViewer
      ? s.runtime.resources.current.forViewer(cl.resource_detail)
      : (s.runtime.resources?.current ?? s.runtime.resources ?? {}),
    resourcesHash = hash(stringify(readings));
  const view: View = {
    type: "view",
    viewer_protocol: version,
    session: q.session_hash === cl.session_hash ? null : (snapshot ?? session.viewerSnapshot(s.runtime)),
    session_hash: cl.session_hash,
    resources: q.resources_hash === resourcesHash ? null : readings,
    resources_hash: resourcesHash,
    surfaces: frames,
    bell_seq: s.bell_seq,
    bell_kind: s.last_bell_kind,
    controls: cl.controls,
    viewer: cl.viewer_id,
    detach: s.runtime.panes.length === 0 && s.runtime.workspaces.items.length === 1,
  };
  cl.queue(view);
}
export async function search(s: any, cl: any, q: any) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  cl.reply("viewer.search", await p.displayed().search(q.needle, q.skip));
}
/** The pane `q` names, if it still runs the agent the viewer showed. */
function shownPane(s: any, q: any) {
  const p = s.runtime.pane(q.pane);
  if (!p) throw new Error("NoPane");
  const bound = p.attachment.actor?.id ?? 0;
  if (
    q.session !== p.agent().sessionId() ||
    (q.binding !== null && q.binding !== undefined && BigInt(q.binding) !== BigInt(p.attachment.generation)) ||
    (q.conversation !== null && q.conversation !== undefined && q.conversation !== bound)
  )
    throw new Error("StaleAcknowledgement");
  return p;
}
export function acknowledge(s: any, cl: any, q: any) {
  const p = shownPane(s, q),
    agent = p.agent();
  if (agent.attention !== "none" || agent.observation.unread()) {
    if (p.attachment.actor) p.attachment.actor.acknowledge(q.through, q.attention_at);
    else {
      if (q.attention_at === agent.changed_at) agent.attention = "none";
      agent.readThrough(q.through);
    }
    s.runtime.changed();
    s.dirty = true;
  }
  cl.queue({ ok: true });
}
export function markUnread(s: any, cl: any, q: any) {
  if (shownPane(s, q).agent().markUnread()) {
    s.runtime.changed();
    s.dirty = true;
  }
  cl.queue({ ok: true });
}
export async function paste(s: any, cl: any, q: any) {
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
  cl.reply("pane.paste", { pasted: await p.terminal.pasteEvent(contents) });
}
export async function resize(s: any) {
  for (const p of s.runtime.panes) {
    let chosen: Interest | null = null,
      latest = 0;
    for (const cl of s.clients) {
      if (!cl.viewer || cl.dead || (chosen !== null && cl.active_seq <= latest)) continue;
      const interest = cl.interests.find((i: Interest) => i.pane === p.id);
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
  }
}
export function targetViewer(s: any, id: number | null | undefined) {
  const target = s.clients.find((cl: any) => cl.viewer && !cl.dead && (id == null || cl.viewer_id === id));
  if (!target) throw new Error("NoViewer");
  return target;
}
export function viewerShowing(s: any, pane: number) {
  const targets = s.clients.filter((cl: any) => cl.viewer && !cl.dead && cl.view_focus === pane);
  if (targets.length > 1) throw new Error("AmbiguousViewer");
  if (!targets.length) throw new Error("NoViewer");
  return targets[0];
}
export function queue(target: any, value: Omit<Control, "seq">) {
  if (target.controls.length >= 64) throw new Error("ViewerBusy");
  target.controls.push({ ...value, seq: target.next_control++ });
}
function send(cl: any, target: any, value: Omit<Control, "seq">) {
  queue(target, value);
  cl.queue({ ok: true, viewer: target.viewer_id, queued: true });
}
export function action(s: any, cl: any, q: any) {
  const act = parseAction(q.name, q.value ?? "");
  let target: any;
  if (act.name === "relaunch") {
    if (q.pane == null) throw new Error("NoViewer");
    target = viewerShowing(s, q.pane);
    if (!isAbsolute(String(act.value))) throw new Error("InvalidExecutable");
  } else if ((act.name === "onboard" || act.name === "open") && q.pane != null) target = viewerShowing(s, q.pane);
  else target = targetViewer(s, q.viewer);
  send(cl, target, { kind: "action", name: q.name, value: q.value ?? "" });
}
export function focus(s: any, cl: any, q: any) {
  const target = targetViewer(s, q.viewer);
  if (!s.runtime.pane(q.pane)) throw new Error("NoPane");
  send(cl, target, { kind: "focus", id: q.pane });
}
export function switchWorkspace(s: any, cl: any, q: any) {
  const target = targetViewer(s, q.viewer);
  s.runtime.getWorkspace(q.workspace);
  send(cl, target, { kind: "workspace", id: q.workspace });
}
export function copy(s: any, pane: number, text: string) {
  let target: any = null;
  for (const view of s.clients)
    if (
      view.viewer &&
      !view.dead &&
      (!target || view.active_seq > target.active_seq) &&
      view.interests.some((i: Interest) => i.pane === pane)
    )
      target = view;
  if (!target) return;
  target.controls = target.controls.filter((c: Control) => c.kind !== "action" || c.name !== "copy");
  queue(target, { kind: "action", name: "copy", value: text });
}
export function viewers(s: any) {
  return s.clients
    .filter((cl: any) => cl.viewer && !cl.dead)
    .map((cl: any) => ({
      id: cl.viewer_id,
      workspace: cl.view_workspace,
      pane: cl.view_focus,
      watched: cl.watched,
    }));
}
