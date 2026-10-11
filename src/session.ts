import * as protocol from "./protocol";
import { Runtime, Launch } from "./runtime";
import type { Create } from "./runtime";
import { Model, Tab } from "./layout";
import { label } from "./pane/label";
import { Entry, Semantics, resolve, analyze, shellStatus } from "./launch/command";
import { ResumeHint } from "./resume_hint";
import { Text, Each } from "./providers";
import { logicalKey } from "./keys";
import { encode } from "./keyboard";
export type Context = { socket: string; executable: string; theme: any };
export type Result = {
  pane?: number;
  tab?: number;
  workspace?: number;
  closed_panes?: number[];
  text?: string | null;
};
export function location(r: Runtime, pane: number): protocol.Result {
  const ws = r.workspaces.owner(pane);
  if (!ws) throw Error("NoPane");
  return {
    text: null,
    closed_panes: [],
    pane,
    tab: ws.model.tabs[ws.model.tabForPane(pane)!].id,
    workspace: ws.id,
  };
}
function tabOwner(r: Runtime, id: number) {
  const ws = r.workspaces.items.find(w => w.model.tabIndex(id) !== null);
  if (!ws) throw Error("NoTab");
  return ws;
}
function tabIndex(m: Model, id: number) {
  const i = m.tabIndex(id);
  if (i === null) throw Error("NoTab");
  return i;
}
function spawnOptions(r: Runtime, ctx: Context, workspace: number, from: number | null, cwd: string): Create {
  const ws = r.getWorkspace(workspace);
  let dir = cwd;
  if (!dir && from !== null) {
    const p = r.pane(from);
    if (!p) throw Error("NoPane");
    if (r.workspaces.owner(from)?.id !== workspace) throw Error("InvalidDestination");
    p.refreshCwd();
    dir = p.cwd;
  }
  return { workspace, cwd: dir || ws.cwd, cols: 80, rows: 24, ...ctx };
}
async function executeInner(r: Runtime, ctx: Context, cmd: protocol.Command): Promise<Result> {
  const request = protocol.command(cmd);
  switch (request.op) {
    case "agent.move": {
      const ws = r.getWorkspace(request.payload.workspace);
      ws.agent_order.move(r.agentTargets(ws), request.payload.target, request.payload.before ?? null);
      break;
    }
    case "agent.command": {
      if (request.payload.index < 0 || request.payload.index >= r.agent_commands.length) throw Error("InvalidCommand");
      const source =
          request.payload.resolve && request.payload.command
            ? await resolve(request.payload.command, request.payload.cwd ?? null)
            : request.payload.command,
        e = r.agent_commands[Number(request.payload.index)];
      e.set(source);
      if (request.payload.original !== null && request.payload.original !== undefined)
        e.setOriginal(request.payload.original);
      else if (request.payload.resolve) e.setOriginal(request.payload.command);
      if (request.payload.name !== null && request.payload.name !== undefined) e.name = request.payload.name;
      if (!source) r.agent_commands[Number(request.payload.index)] = new Entry();
      else
        e.semantics = request.payload.semantics
          ? Object.assign(new Semantics(), request.payload.semantics)
          : analyze(source, request.payload.cwd ?? ".");
      r.agent_commands[Number(request.payload.index)].hidden = !!source && request.payload.hidden;
      r.changed();
      return {};
    }
    case "agent.command.create": {
      const e = r.agent_commands[Number(request.payload.index)];
      if (!e?.command) throw Error("InvalidCommand");
      const pane = await r.create({
        ...spawnOptions(r, ctx, request.payload.workspace, null, request.payload.cwd ?? ""),
        command: e.text(),
        interactive_command: true,
      });
      r.pane(pane)!.launch = new Launch(undefined, e.command);
      return location(r, pane);
    }
    case "agent.visibility":
      r.agent_hidden =
        request.payload.hidden instanceof Each ? request.payload.hidden : new Each(false, request.payload.hidden);
      r.changed();
      return {};
    case "agent.yolo":
      r.agent_yolo.set(request.payload.provider, request.payload.enabled);
      r.changed();
      return {};
    case "agent.create": {
      const provider = request.payload.provider ?? r.lastAgent(r.getWorkspace(request.payload.workspace)),
        launch = new Launch({ provider, yolo: r.agent_yolo.get(provider) }),
        pane = await r.create({
          ...spawnOptions(r, ctx, request.payload.workspace, null, request.payload.cwd ?? ""),
          command: launch.paneCommand(ctx.executable, launch.typed()),
        });
      r.pane(pane)!.launch = launch;
      r.rememberAgent(pane, provider);
      return location(r, pane);
    }
    case "agent.resume": {
      const opts = {
          ...spawnOptions(r, ctx, request.payload.workspace, null, request.payload.cwd ?? ""),
          asleep: request.payload.asleep === true,
        },
        closed = r.closedConversation(request.payload.provider, request.payload.session);
      if (closed !== null) return location(r, await r.reopenClosed(closed, opts));
      const h = new ResumeHint();
      h.provider = request.payload.provider;
      h.session = new Text(request.payload.session);
      h.name = new Text(request.payload.name ?? "");
      return location(
        r,
        await r.resumeAgent(
          opts,
          new Launch({
            provider: request.payload.provider,
            yolo: r.agent_yolo.get(request.payload.provider),
          }),
          h,
          null,
        ),
      );
    }
    case "agent.rename":
      await r.renameAgent(request.payload.target, request.payload.name ?? null);
      return location(r, request.payload.target);
    case "agent.fork": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      if (request.payload.check) {
        Runtime.forkSource(p);
        return location(r, request.payload.target);
      }
      const ws = r.workspaces.owner(request.payload.target)!;
      return location(
        r,
        await r.forkAgent(
          spawnOptions(r, ctx, ws.id, request.payload.target, ""),
          request.payload.target,
          request.payload.name ?? null,
        ),
      );
    }
    case "pane.create":
      return location(
        r,
        await r.create({
          ...spawnOptions(r, ctx, request.payload.workspace, request.payload.from ?? null, request.payload.cwd ?? ""),
          command: request.payload.command,
          title: request.payload.title,
        }),
      );
    case "pane.split": {
      const ws = r.workspaces.owner(request.payload.target);
      if (!ws) throw Error("NoPane");
      return location(
        r,
        await r.create({
          ...spawnOptions(r, ctx, ws.id, request.payload.target, request.payload.cwd ?? ""),
          command: request.payload.command,
          title: request.payload.title,
          split: {
            pane: request.payload.target,
            axis:
              request.payload.direction === "left" || request.payload.direction === "right" ? "horizontal" : "vertical",
            before: request.payload.direction === "left" || request.payload.direction === "up",
          },
        }),
      );
    }
    case "workspace.create": {
      const id = await r.createWorkspace(request.payload.name, {
          workspace: 0,
          cwd: request.payload.cwd,
          cols: 80,
          rows: 24,
          ...ctx,
        }),
        ws = r.getWorkspace(id);
      return location(r, ws.model.firstPane(ws.model.tabs[0].root));
    }
    case "workspace.edit": {
      const ws = r.getWorkspace(request.payload.target);
      await r.workspaces.edit(
        request.payload.target,
        request.payload.name ?? ws.customName(),
        request.payload.cwd ?? ws.cwd,
      );
      break;
    }
    case "workspace.close":
      r.closeWorkspace(request.payload.target, request.payload.close_contents);
      break;
    case "workspace.move":
      r.workspaces.moveBefore(request.payload.target, request.payload.before);
      break;
    case "pane.restore":
      return location(r, await r.reopen(spawnOptions(r, ctx, request.payload.workspace, null, "")));
    case "pane.wake":
      await r.wake(request.payload.target, ctx, request.payload.shell);
      return location(r, request.payload.target);
    case "pane.close":
      location(r, request.payload.target);
      r.close(request.payload.target);
      return { closed_panes: [request.payload.target] };
    case "tab.close": {
      const ws = tabOwner(r, request.payload.target),
        root = ws.model.tabs[tabIndex(ws.model, request.payload.target)].root,
        ids = ws.model.nodes.flatMap(n => (n && "pane" in n && ws.model.contains(root, n.pane) ? [n.pane] : []));
      for (const id of ids) r.close(id);
      return { closed_panes: ids };
    }
    case "pane.read": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      let text = request.payload.view === "screen" ? p.terminal.text() : p.terminal.history();
      if (request.payload.view !== "screen") {
        if (!request.payload.lines || request.payload.lines > 10000) throw Error("InvalidLines");
        text = text.trimEnd().split("\n").slice(-Number(request.payload.lines)).join("\n");
        if (Buffer.byteLength(text) > 512 * 1024) throw Error("OutputTooLarge");
      }
      return { ...location(r, request.payload.target), text };
    }
    case "pane.send": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      const bracketed = p.terminal.bracketed_paste ?? false;
      await p.terminal.send(
        (bracketed ? "\x1b[200~" : "") +
          request.payload.text +
          (bracketed ? "\x1b[201~" : "") +
          (request.payload.enter ? encode(logicalKey("enter")) : ""),
      );
      return location(r, request.payload.target);
    }
    case "pane.keys": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      const output = request.payload.text
        .split(" ")
        .filter(Boolean)
        .map((k: string) => encode(logicalKey(k)))
        .join("");
      p.detection.observeInput(output, Date.now() * 1000);
      await p.terminal.send(output);
      return location(r, request.payload.target);
    }
    case "pane.input": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      p.detection.observeInput(request.payload.data, Date.now() * 1000);
      if (p.typed(request.payload.data)) r.changed();
      await p.terminal.send(request.payload.data);
      return location(r, request.payload.target);
    }
    default:
      return arrangeInner(r, request);
  }
  r.changed();
  return {};
}
const clone = (m: Model) => {
  const n = Model.fromData(m.toJSON());
  n.next_id = m.next_id;
  return n;
};
type ArrangementName =
  | "tab.rename"
  | "pane.rename"
  | "split.resize"
  | "pane.resize"
  | "split.ratio"
  | "pane.swap"
  | "pane.move"
  | "tab.merge"
  | "tab.move";
type Arrangement = Extract<protocol.DecodedCommand, { op: ArrangementName }>;
export function arrange(r: Runtime, cmd: protocol.Command): Result {
  const request = protocol.command(cmd);
  switch (request.op) {
    case "tab.rename":
    case "pane.rename":
    case "split.resize":
    case "pane.resize":
    case "split.ratio":
    case "pane.swap":
    case "pane.move":
    case "tab.merge":
    case "tab.move":
      return arrangeInner(r, request);
    default:
      throw Error("InvalidCommand");
  }
}
function arrangeInner(r: Runtime, request: Arrangement): Result {
  const op = request.op,
    q = request.payload,
    tabOp = ["tab.rename", "tab.move", "tab.merge"].includes(op),
    source = tabOp ? tabOwner(r, q.target) : r.workspaces.owner(q.target);
  if (!source) throw Error("NoPane");
  let src = clone(source.model),
    original = clone(src);
  const index = tabOp ? tabIndex(src, q.target) : src.tabForPane(q.target)!,
    representative = tabOp ? src.firstPane(src.tabs[index].root) : q.target;
  switch (request.op) {
    case "tab.rename":
      src.tabs[index].rename(request.payload.name);
      break;
    case "pane.rename": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      p.label = label(request.payload.name);
      break;
    }
    case "split.resize":
      src.resize(request.payload.target, request.payload.direction);
      break;
    case "pane.resize":
      if (request.payload.ratio < 100 || request.payload.ratio > 900) throw Error("InvalidRatio");
      src.setShare(request.payload.target, request.payload.axis, request.payload.ratio);
      break;
    case "split.ratio": {
      if (source.model.revision !== request.payload.expected) throw Error("StaleLayout");
      if (request.payload.ratio < 100 || request.payload.ratio > 900) throw Error("InvalidRatio");
      const n = src.nodes.find(
        n =>
          n &&
          "split" in n &&
          src.firstPane(n.split.first) === request.payload.target &&
          src.firstPane(n.split.second) === request.payload.other,
      );
      if (!n || !("split" in n)) throw Error("NoSplit");
      n.split.ratio = request.payload.ratio;
      break;
    }
    default: {
      const place:
        | { swap: number }
        | { beside: { other: number; direction: "left" | "right" | "up" | "down" } }
        | { tab: protocol.CommandPayloads["tab.move"]["destination"] }
        | { new_tab: string }
        | null =
        request.op === "pane.swap"
          ? { swap: request.payload.other }
          : request.op === "pane.move"
            ? request.payload.destination
            : request.op === "tab.merge"
              ? { beside: { other: request.payload.other, direction: request.payload.direction } }
              : request.op === "tab.move"
                ? { tab: request.payload.destination }
                : null;
      if (!place) throw Error("InvalidCommand");
      const placement =
        "swap" in place
          ? { kind: "swap" as const, value: place.swap }
          : "beside" in place
            ? { kind: "beside" as const, value: place.beside }
            : "tab" in place
              ? { kind: "tab" as const, value: place.tab }
              : { kind: "new_tab" as const, value: place.new_tab };
      let destination = source;
      if (placement.kind === "swap" || placement.kind === "beside") {
        destination = r.workspaces.owner(placement.kind === "swap" ? placement.value : placement.value.other)!;
        if (!destination) throw Error("NoPane");
      } else if (placement.kind === "tab")
        destination =
          "workspace" in placement.value
            ? r.getWorkspace(placement.value.workspace)
            : tabOwner(r, "before" in placement.value ? placement.value.before : placement.value.after);
      const dst = source === destination ? src : clone(destination.model);
      if (placement.kind === "swap") {
        const a = src.findNode(request.payload.target)!,
          b = dst.findNode(placement.value)!;
        [src.nodes[a], dst.nodes[b]] = [dst.nodes[b], src.nodes[a]];
      } else if (placement.kind === "tab" && source === destination) {
        if (!("workspace" in placement.value))
          src.moveTab(
            request.payload.target,
            tabIndex(src, "before" in placement.value ? placement.value.before : placement.value.after) +
              Number("after" in placement.value),
          );
      } else {
        if (
          placement.kind === "beside" &&
          src.contains(src.tabs[index].root, placement.value.other) &&
          (tabOp || request.payload.target === placement.value.other)
        )
          throw Error("InvalidDestination");
        const saved = Object.assign(new Tab(src.tabs[index].id, src.tabs[index].root), src.tabs[index]),
          root = tabOp ? saved.root : src.findNode(request.payload.target)!;
        if (tabOp) src.removeTab(index);
        else src.close(request.payload.target);
        const copied = dst.copyTree(original, root);
        if (placement.kind === "beside") dst.insertTree(copied, placement.value.other, placement.value.direction);
        else {
          saved.root = copied;
          if (!tabOp) {
            saved.id = r.workspaces.next_pane_id;
            saved.rename(placement.kind === "new_tab" ? placement.value : "");
          }
          dst.tabs[dst.count++] = saved;
          if (placement.kind === "tab" && !("workspace" in placement.value))
            dst.moveTab(
              saved.id,
              tabIndex(dst, "before" in placement.value ? placement.value.before : placement.value.after) +
                Number("after" in placement.value),
            );
        }
      }
      if (source !== destination) {
        dst.revision = BigInt.asUintN(64, dst.revision + 1n);
        destination.model = dst;
      }
      if (placement.kind === "new_tab") r.workspaces.next_pane_id++;
      break;
    }
  }
  src.revision = BigInt.asUintN(64, src.revision + 1n);
  source.model = src;
  r.changed();
  return location(r, representative);
}
function agentView(a: any, conversation: number) {
  return {
    conversation,
    subagents: a.subagents,
    changed_at: a.changed_at,
    working_since: a.working_since,
    provider: a.provider,
    state: a.state,
    attention: a.attention,
    observation: a.observation,
    recent_activity: a.recentLabel(),
    name: a.displayName(),
    session: a.sessionId(),
    transcript: a.transcriptPath(),
    activity: a.activity.text(),
    cwd: a.directory(),
    tool_active: a.tool_active,
    compacting: a.compacting,
    paused: a.paused,
  };
}
const text = (v: any) => v?.text?.() ?? (typeof v === "string" ? v : "");
export function snapshot(r: Runtime) {
  return build(r, false);
}
export function viewerSnapshot(r: Runtime) {
  return build(r, true);
}
function build(r: Runtime, viewer: boolean) {
  const coarse = (s: number) => (s <= 0 ? s : Math.floor(s / 5000000) * 5000000);
  const conversations = r.conversations.items
    .filter(a => !viewer || r.followed(a))
    .map((a: any) => {
      const usage = a.usageView?.(Date.now()) ?? {},
        out: any = {
          id: a.id,
          parent: a.parent,
          workspace: a.workspace,
          observed_at: a.observed_at,
          attachments: r.attachments(a),
          role: text(a.role),
          background_tasks: a.background_tasks?.view?.() ?? {},
          model: text(a.model?.id),
          model_name: text(a.model?.name),
          usage,
          context: a.context?.view?.(r.conversations.compaction_points) ?? {},
          timeline: {
            points:
              a.activity_timeline?.points?.slice(0, a.activity_timeline.len).map((p: any) => ({
                at: p.at,
                activity: text(p.label),
                usage: p.usage,
              })) ?? [],
            pending: a.activity_timeline?.pending?.(usage) ?? null,
          },
          children_observed_at: a.children_observed_at,
          agent: agentView(a.state, a.id),
        };
      if (viewer) {
        out.observed_at = coarse(out.observed_at);
        out.children_observed_at = coarse(out.children_observed_at);
        out.background_tasks.observed_at = coarse(out.background_tasks.observed_at);
      }
      return out;
    });
  return {
    type: "session",
    protocol: 1,
    conversations,
    release_version: "",
    release_commit: "",
    staged_version: r.staged_version,
    system_model: text((r.system_model as any).id),
    system_model_name: text((r.system_model as any).name),
    inference: r.inference,
    shell: shellStatus(),
    smart_links: r.ports.enabled,
    system_usage: r.system_usage,
    system_working: r.system_working,
    server_pid: process.pid,
    ports: r.link_labels.snapshot?.(r.ports.current) ?? [],
    resources: viewer ? {} : (r.resources.current ?? {}),
    revision: viewer ? 0n : r.revision,
    last_agent: r.last_agent,
    agent_yolo: r.agent_yolo,
    agent_hidden: r.agent_hidden,
    agent_commands: r.agent_commands,
    workspaces: r.workspaces.items.map((w: any) => ({
      agent_order: w.agent_order.slice(),
      last_agent: w.last_agent,
      closed_agents: r.closedCount(w.id),
      git_commits:
        w.git_commits.items?.slice(0, w.git_commits.len).map((c: any) => ({
          timestamp: c.timestamp,
          hash: text(c.hash),
          subject: text(c.subject),
          author: text(c.author),
          date: text(c.date),
        })) ?? [],
      id: w.id,
      name: w.name(),
      cwd: w.cwd,
      custom_name: w.customName(),
      git_ahead: w.git_ahead,
      worktrees: w.worktrees,
      git_ref: w.git_ref.view?.() ?? w.git_ref,
      git_push: w.git_push.view?.() ?? w.git_push,
      worktree_removal: r.worktree_tracker.removal(w.id),
      stats: w.away.counts ?? {},
      model: w.model,
    })),
    panes: r.panes.map(p => ({
      ...location(r, p.id),
      id: p.id,
      binding: p.attachment.generation,
      name: p.label,
      cwd: p.cwd,
      pid: p.terminal.pid,
      cols: p.terminal.vt.cols,
      rows: p.terminal.vt.rows,
      exited: p.terminal.exited,
      agent: agentView(p.agent(), p.attachment.actor?.id ?? 0),
      restoring: p.restoring(),
      forking: p.ghost?.fork !== null && p.ghost !== null,
      dormant: p.dormant,
    })),
    native_sessions: r.sessions.map(s => ({
      agent: agentView(s.attachment.agent(), s.attachment.actor?.id ?? 0),
      id: s.id,
      workspace: s.workspace_id,
      provider: s.provider,
      cwd: s.cwd,
      ready: s.ready,
      exited: s.exited,
      state: s.status(),
      attention: s.attention(),
      observation: s.observation(),
      tool_active: s.toolActive(),
    })),
    closed_panes: r.closed.length,
  };
}

export async function execute(r: Runtime, ctx: Context, cmd: protocol.Command): Promise<protocol.Result> {
  return {
    pane: 0,
    tab: 0,
    workspace: 0,
    text: null,
    closed_panes: [],
    ...(await executeInner(r, ctx, cmd)),
  };
}
