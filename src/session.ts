import { Runtime, Launch } from "./runtime";
import type { Create } from "./runtime";
import { Model, Tab, max_tabs } from "./layout";
import { label } from "./pane/label";
import { Entry, resolve, analyze } from "./launch/command";
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
export function location(r: Runtime, pane: number): Result {
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
  const ws = r.workspaces.items.find((w) => w.model.tabIndex(id) !== null);
  if (!ws) throw Error("NoTab");
  return ws;
}
function tabIndex(m: Model, id: number) {
  const i = m.tabIndex(id);
  if (i === null) throw Error("NoTab");
  return i;
}
function spawnOptions(
  r: Runtime,
  ctx: Context,
  workspace: number,
  from: number | null,
  cwd: string,
): Create {
  const ws = r.getWorkspace(workspace);
  let dir = cwd;
  if (!dir && from !== null) {
    const p = r.pane(from);
    if (!p) throw Error("NoPane");
    if (r.workspaces.owner(from)?.id !== workspace)
      throw Error("InvalidDestination");
    p.refreshCwd();
    dir = p.cwd;
  }
  return { workspace, cwd: dir || ws.cwd, cols: 80, rows: 24, ...ctx };
}
async function executeInner(
  r: Runtime,
  ctx: Context,
  cmd: any,
): Promise<Result> {
  const op = cmd.op ?? Object.keys(cmd)[0],
    q = cmd.op ? cmd : cmd[op];
  switch (op) {
    case "agent.move": {
      const ws = r.getWorkspace(q.workspace);
      ws.agent_order.move(r.agentTargets(ws), q.target, q.before ?? null);
      break;
    }
    case "agent.command": {
      if (q.index < 0 || q.index >= r.agent_commands.length)
        throw Error("InvalidCommand");
      const source =
          q.resolve && q.command
            ? await resolve(q.command, q.cwd ?? null)
            : q.command,
        e = r.agent_commands[q.index];
      e.set(source);
      if (q.original !== null && q.original !== undefined)
        e.setOriginal(q.original);
      else if (q.resolve) e.setOriginal(q.command);
      if (q.name !== null && q.name !== undefined) e.name = q.name;
      if (!source) r.agent_commands[q.index] = new Entry();
      else e.semantics = q.semantics ?? analyze(source, q.cwd ?? ".");
      r.agent_commands[q.index].hidden = !!source && q.hidden;
      r.changed();
      return {};
    }
    case "agent.command.create": {
      const e = r.agent_commands[q.index];
      if (!e?.command) throw Error("InvalidCommand");
      const pane = await r.create({
        ...spawnOptions(r, ctx, q.workspace, null, q.cwd ?? ""),
        command: e.text(),
        interactive_command: true,
      });
      r.pane(pane)!.launch = new Launch(undefined, e.command);
      return location(r, pane);
    }
    case "agent.visibility":
      r.agent_hidden =
        q.hidden instanceof Each ? q.hidden : new Each(false, q.hidden);
      r.changed();
      return {};
    case "agent.yolo":
      r.agent_yolo.set(q.provider, q.enabled);
      r.changed();
      return {};
    case "agent.create": {
      const provider = q.provider ?? r.lastAgent(r.getWorkspace(q.workspace)),
        launch = new Launch({ provider, yolo: r.agent_yolo.get(provider) }),
        pane = await r.create({
          ...spawnOptions(r, ctx, q.workspace, null, q.cwd ?? ""),
          command: launch.paneCommand(ctx.executable, launch.typed()),
        });
      r.pane(pane)!.launch = launch;
      r.rememberAgent(pane, provider);
      return location(r, pane);
    }
    case "agent.resume": {
      const opts = spawnOptions(r, ctx, q.workspace, null, q.cwd ?? ""),
        closed = r.closedConversation(q.provider, q.session);
      if (closed !== null)
        return location(r, await r.reopenClosed(closed, opts));
      const h = new ResumeHint();
      h.provider = q.provider;
      h.session = new Text(q.session);
      return location(
        r,
        await r.resumeAgent(
          opts,
          new Launch({
            provider: q.provider,
            yolo: r.agent_yolo.get(q.provider),
          }),
          h,
          null,
        ),
      );
    }
    case "agent.rename":
      await r.renameAgent(q.target, q.name ?? null);
      return location(r, q.target);
    case "agent.fork": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      if (q.check) {
        Runtime.forkSource(p);
        return location(r, q.target);
      }
      const ws = r.workspaces.owner(q.target)!;
      return location(
        r,
        await r.forkAgent(
          spawnOptions(r, ctx, ws.id, q.target, ""),
          q.target,
          q.name ?? null,
        ),
      );
    }
    case "pane.create":
      return location(
        r,
        await r.create({
          ...spawnOptions(r, ctx, q.workspace, q.from ?? null, q.cwd ?? ""),
          command: q.command,
          title: q.title,
        }),
      );
    case "pane.split": {
      const ws = r.workspaces.owner(q.target);
      if (!ws) throw Error("NoPane");
      return location(
        r,
        await r.create({
          ...spawnOptions(r, ctx, ws.id, q.target, q.cwd ?? ""),
          command: q.command,
          title: q.title,
          split: {
            pane: q.target,
            axis:
              q.direction === "left" || q.direction === "right"
                ? "horizontal"
                : "vertical",
            before: q.direction === "left" || q.direction === "up",
          },
        }),
      );
    }
    case "workspace.create": {
      const id = await r.createWorkspace(q.name, {
          workspace: 0,
          cwd: q.cwd,
          cols: 80,
          rows: 24,
          ...ctx,
        }),
        ws = r.getWorkspace(id);
      return location(r, ws.model.firstPane(ws.model.tabs[0].root));
    }
    case "workspace.edit": {
      const ws = r.getWorkspace(q.target);
      await r.workspaces.edit(
        q.target,
        q.name ?? ws.customName(),
        q.cwd ?? ws.cwd,
      );
      break;
    }
    case "workspace.close":
      r.closeWorkspace(q.target, q.close_contents);
      break;
    case "workspace.move":
      r.workspaces.moveBefore(q.target, q.before);
      break;
    case "pane.restore":
      return location(
        r,
        await r.reopen(spawnOptions(r, ctx, q.workspace, null, "")),
      );
    case "pane.close":
      location(r, q.target);
      r.close(q.target);
      return { closed_panes: [q.target] };
    case "tab.close": {
      const ws = tabOwner(r, q.target),
        root = ws.model.tabs[tabIndex(ws.model, q.target)].root,
        ids = ws.model.nodes.flatMap((n) =>
          n && "pane" in n && ws.model.contains(root, n.pane) ? [n.pane] : [],
        );
      for (const id of ids) r.close(id);
      return { closed_panes: ids };
    }
    case "pane.read": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      let text = q.view === "screen" ? p.terminal.text() : p.terminal.history();
      if (q.view !== "screen") {
        if (!q.lines || q.lines > 10000) throw Error("InvalidLines");
        text = text.trimEnd().split("\n").slice(-q.lines).join("\n");
        if (Buffer.byteLength(text) > 512 * 1024) throw Error("OutputTooLarge");
      }
      return { ...location(r, q.target), text };
    }
    case "pane.send": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      const bracketed = (p.terminal as any).bracketed_paste ?? false;
      await p.terminal.send(
        (bracketed ? "\x1b[200~" : "") +
          q.text +
          (bracketed ? "\x1b[201~" : "") +
          (q.enter ? encode(logicalKey("enter")) : ""),
      );
      return location(r, q.target);
    }
    case "pane.keys": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      const output = q.text
        .split(" ")
        .filter(Boolean)
        .map((k: string) => encode(logicalKey(k)))
        .join("");
      p.detection.observeInput(output, Date.now() * 1000);
      await p.terminal.send(output);
      return location(r, q.target);
    }
    case "pane.input": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      p.detection.observeInput(q.data, Date.now() * 1000);
      await p.terminal.send(q.data);
      return location(r, q.target);
    }
    default:
      return arrange(r, { [op]: q });
  }
  r.changed();
  return {};
}
const clone = (m: Model) => {
  const n = Model.fromData(m.toJSON());
  n.next_id = m.next_id;
  return n;
};
export function arrange(r: Runtime, cmd: any): Result {
  const op = Object.keys(cmd)[0],
    q = cmd[op],
    tabOp = ["tab.rename", "tab.move", "tab.merge"].includes(op),
    source = tabOp ? tabOwner(r, q.target) : r.workspaces.owner(q.target);
  if (!source) throw Error("NoPane");
  let src = clone(source.model),
    original = clone(src);
  const index = tabOp ? tabIndex(src, q.target) : src.tabForPane(q.target)!,
    representative = tabOp ? src.firstPane(src.tabs[index].root) : q.target;
  switch (op) {
    case "tab.rename":
      src.tabs[index].rename(q.name);
      break;
    case "pane.rename": {
      const p = r.pane(q.target);
      if (!p) throw Error("NoPane");
      p.label = label(q.name);
      break;
    }
    case "split.resize":
      src.resize(q.target, q.direction);
      break;
    case "pane.resize":
      if (q.ratio < 100 || q.ratio > 900) throw Error("InvalidRatio");
      src.setShare(q.target, q.axis, q.ratio);
      break;
    case "split.ratio": {
      if (source.model.revision !== BigInt(q.expected))
        throw Error("StaleLayout");
      if (q.ratio < 100 || q.ratio > 900) throw Error("InvalidRatio");
      const n = src.nodes.find(
        (n) =>
          n &&
          "split" in n &&
          src.firstPane(n.split.first) === q.target &&
          src.firstPane(n.split.second) === q.other,
      );
      if (!n || !("split" in n)) throw Error("NoSplit");
      n.split.ratio = q.ratio;
      break;
    }
    default: {
      const place: any =
        op === "pane.swap"
          ? { swap: q.other }
          : op === "pane.move"
            ? q.destination
            : op === "tab.merge"
              ? { beside: { other: q.other, direction: q.direction } }
              : op === "tab.move"
                ? { tab: q.destination }
                : null;
      if (!place) throw Error("InvalidCommand");
      const kind = Object.keys(place)[0],
        p = place[kind];
      let destination = source;
      if (kind === "swap" || kind === "beside") {
        destination = r.workspaces.owner(kind === "swap" ? p : p.other)!;
        if (!destination) throw Error("NoPane");
      } else if (kind === "tab")
        destination =
          "workspace" in p
            ? r.getWorkspace(p.workspace)
            : tabOwner(r, p.before ?? p.after);
      const dst = source === destination ? src : clone(destination.model);
      if (kind === "swap") {
        const a = src.findNode(q.target)!,
          b = dst.findNode(p)!;
        [src.nodes[a], dst.nodes[b]] = [dst.nodes[b], src.nodes[a]];
      } else if (kind === "tab" && source === destination) {
        if (!("workspace" in p))
          src.moveTab(
            q.target,
            tabIndex(src, p.before ?? p.after) + Number("after" in p),
          );
      } else {
        if (
          kind === "beside" &&
          src.contains(src.tabs[index].root, p.other) &&
          (tabOp || q.target === p.other)
        )
          throw Error("InvalidDestination");
        const saved = Object.assign(
            new Tab(src.tabs[index].id, src.tabs[index].root),
            src.tabs[index],
          ),
          root = tabOp ? saved.root : src.findNode(q.target)!;
        if (tabOp) src.removeTab(index);
        else src.close(q.target);
        const copied = dst.copyTree(original, root);
        if (kind === "beside") dst.insertTree(copied, p.other, p.direction);
        else {
          if (dst.count === max_tabs) throw Error("TooManyTabs");
          saved.root = copied;
          if (!tabOp) {
            saved.id = r.workspaces.next_pane_id;
            saved.rename(p);
          }
          dst.tabs[dst.count++] = saved;
          if (kind === "tab" && !("workspace" in p))
            dst.moveTab(
              saved.id,
              tabIndex(dst, p.before ?? p.after) + Number("after" in p),
            );
        }
      }
      if (source !== destination) {
        dst.revision = BigInt.asUintN(64, dst.revision + 1n);
        destination.model = dst;
      }
      if (kind === "new_tab") r.workspaces.next_pane_id++;
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
    provider: a.provider,
    state: a.state,
    attention: a.attention,
    observation: a.observation,
    recent_activity: a.recentLabel(),
    name: a.displayName(),
    session: a.sessionId(),
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
  const coarse = (s: number) =>
    s <= 0 ? s : Math.floor(s / 5000000) * 5000000;
  const conversations = r.conversations.items
    .filter((a) => !viewer || r.followed(a))
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
              a.activity_timeline?.points
                ?.slice(0, a.activity_timeline.len)
                .map((p: any) => ({
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
        out.background_tasks.observed_at = coarse(
          out.background_tasks.observed_at,
        );
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
    system_usage: r.system_usage,
    system_working: r.system_working,
    server_pid: process.pid,
    ports: r.link_labels.snapshot?.(r.ports.current) ?? [],
    resources: viewer ? {} : (r.resources.current ?? {}),
    revision: viewer ? 0 : r.revision,
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
      git_ref: w.git_ref.view?.() ?? w.git_ref,
      git_push: w.git_push.view?.() ?? w.git_push,
      stats: w.away.counts ?? {},
      model: w.model,
    })),
    panes: r.panes.map((p) => ({
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
    })),
    native_sessions: r.sessions.map((s) => ({
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

export async function execute(
  r: Runtime,
  ctx: Context,
  cmd: any,
): Promise<Result> {
  return {
    pane: 0,
    tab: 0,
    workspace: 0,
    text: null,
    closed_panes: [],
    ...(await executeInner(r, ctx, cmd)),
  };
}
