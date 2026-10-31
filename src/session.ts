import * as protocol from "./protocol";
import { Runtime, Launch } from "./runtime";
import { Store } from "./workspace";
import type { Create } from "./runtime";
import { Model, Tab } from "./layout";
import { label } from "./pane/label";
import { Entry, Semantics, resolve, analyze, shellStatus } from "./launch/command";
import { ResumeHint } from "./resume_hint";
import { Text, adapter } from "./providers";
import { logicalKey } from "./keys";
import * as viewerNative from "./viewer_native";
import * as accounts from "./accounts";
import * as agentName from "./agent_name";
import * as launcherConfig from "./launcher_config";
import * as profiles from "./agent_profiles";
import * as launcherOrder from "./launch/order";
import * as integration from "./integration";
import * as worktreeAgents from "./worktree_agents";
import { Row } from "./launch/row";
import type { Provider } from "./providers";
export type Context = { socket: string; executable: string; theme: any };
/** The account a request names for `provider`: "" for the default. */
function named(provider: Provider, spelled: string) {
  if (!spelled) return "";
  if (!spelled.startsWith("/")) throw Error("InvalidAccount");
  return accounts.normalize(provider, spelled);
}
/** The account a request names for `provider`, ready for an agent. */
async function account(provider: Provider, spelled: string) {
  const account = named(provider, spelled);
  if (account) await integration.prepare(provider, account);
  return account;
}
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
/** Where shells wait at their prompt: in `workspace` and `cwd` unless they're
 * 0 and "", and only the first when asked. */
export async function idle(r: Runtime, q: { workspace: number; cwd: string; first: boolean }) {
  if (q.workspace) r.getWorkspace(q.workspace);
  const shells = r.idleShells({
      workspace: q.workspace || undefined,
      cwd: q.cwd ? await Store.directory(q.cwd) : undefined,
    }),
    found = q.first ? shells.take(1).toArray() : [...shells];
  return found.map(p => {
    const { pane, tab, workspace } = location(r, p.id);
    return { pane, tab, workspace, cwd: p.cwd };
  });
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
    case "agent.pin": {
      const ws = r.getWorkspace(request.payload.workspace);
      r.starAgent(ws, request.payload.target, request.payload.pinned, request.payload.before ?? null);
      break;
    }
    case "agent.place": {
      const ws = r.getWorkspace(request.payload.workspace);
      ws.activity_order.move(r.agentTargets(ws), request.payload.target, request.payload.before ?? null);
      break;
    }
    case "agent.command": {
      if (request.payload.name !== null && request.payload.name !== undefined)
        agentName.check(request.payload.name, true);
      if (request.payload.index < 0 || request.payload.index >= r.agent_commands.length) throw Error("InvalidCommand");
      const source =
          request.payload.resolve && request.payload.command
            ? await resolve(request.payload.command, request.payload.cwd ?? null)
            : request.payload.command,
        e = r.agent_commands[Number(request.payload.index)],
        unchanged = !request.payload.resolve && source === e.command;
      e.set(source);
      if (request.payload.original !== null && request.payload.original !== undefined)
        e.setOriginal(request.payload.original);
      else if (request.payload.resolve) e.setOriginal(request.payload.command);
      if (request.payload.name !== null && request.payload.name !== undefined) e.name = request.payload.name;
      if (!source) {
        r.agent_commands[Number(request.payload.index)] = new Entry();
        // A command saved in its slot later starts shown everywhere.
        const row = Row.ofCommand(Number(request.payload.index));
        for (const w of r.workspaces.items) w.launcher_hidden = w.launcher_hidden.filter(h => h !== row);
      } else if (request.payload.semantics) e.semantics = Object.assign(new Semantics(), request.payload.semantics);
      // A viewer that can't read the provider sends none, so the stored ones stand.
      else if (!unchanged) e.semantics = analyze(source, request.payload.cwd ?? ".");
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
    case "agent.visibility": {
      const hidden = request.payload.hidden_accounts;
      if (hidden?.some(a => !a.startsWith("/"))) throw Error("InvalidAccount");
      // A viewer that doesn't know a provider leaves it as it was.
      r.agent_hidden = { ...r.agent_hidden, ...request.payload.hidden };
      // An older viewer sends no accounts, which keeps the hidden ones.
      if (hidden) r.account_hidden = [...new Set(hidden)];
      r.changed();
      return {};
    }
    case "agent.workspace_visibility": {
      const { row, shown } = request.payload,
        ws = r.getWorkspace(request.payload.workspace);
      if (Row.parse(row) === null) throw Error("InvalidRow");
      ws.launcher_hidden = [...ws.launcher_hidden.filter(h => h !== row), ...(shown ? [] : [row])];
      r.changed();
      return {};
    }
    case "agent.launcher.move": {
      const q = request.payload,
        ws = r.getWorkspace(q.workspace),
        row = Row.parse(q.row),
        before = q.before === null ? null : Row.parse(q.before);
      if (!row || (q.before !== null && !before) || q.order.length > 4096 || q.order.some(r => Row.parse(r) === null))
        throw Error("InvalidRow");
      ws.launcher_order = launcherOrder.move(
        launcherOrder.arrange(q.order as Row[], ws.launcher_order as Row[]),
        row,
        before,
      );
      ws.launcher_hidden = [...ws.launcher_hidden.filter(h => h !== row), ...(q.shown ? [] : [row])];
      r.changed();
      return {};
    }
    case "agent.launcher.copy": {
      launcherConfig.copy(r, request.payload.from, request.payload.workspace);
      r.changed();
      return {};
    }
    case "agent.launcher.configure": {
      const row = launcherConfig.configure(r, request.payload);
      r.changed();
      return { text: row };
    }
    case "agent.launcher.remove": {
      const agent = launcherConfig.get(r, request.payload.row),
        id = Row.profile(agent.row),
        index = Row.custom(agent.row);
      if (id) profiles.remove(id);
      else if (index !== null) r.agent_commands[index] = new Entry();
      else throw Error("UseLauncherHide");
      for (const ws of r.workspaces.items) {
        ws.launcher_order = ws.launcher_order.filter(row => row !== agent.row);
        ws.launcher_hidden = ws.launcher_hidden.filter(row => row !== agent.row);
      }
      r.changed();
      return {};
    }
    case "agent.profile.create": {
      const profile = profiles.find(request.payload.id);
      if (!profile) throw Error("InvalidAgent");
      if (profile.account && !accounts.find(profile.provider, profile.account)) throw Error("AccountNotFound");
      const chosen = await account(profile.provider, profile.account),
        launch = Launch.in(profile.provider, chosen, profile.yolo, profile.options),
        pane = await r.create({
          ...spawnOptions(r, ctx, request.payload.workspace, null, request.payload.cwd),
          ...launch.run(ctx.executable, launch.typed()),
        });
      r.pane(pane)!.launch = launch;
      r.rememberAgent(pane, profile.provider);
      return location(r, pane);
    }
    case "agent.yolo": {
      const { provider } = request.payload,
        enabled = adapter(provider).bypass !== false && request.payload.enabled,
        account = named(provider, request.payload.account);
      if (!account) r.agent_yolo[provider] = enabled;
      else r.account_yolo = [...r.account_yolo.filter(a => a !== account), ...(enabled ? [account] : [])];
      r.changed();
      return {};
    }
    case "agent.create": {
      const provider = request.payload.provider ?? r.lastAgent(r.getWorkspace(request.payload.workspace)),
        chosen = await account(provider, request.payload.account),
        launch = Launch.in(provider, chosen, r.yolo(provider, chosen)),
        pane = await r.create({
          ...spawnOptions(r, ctx, request.payload.workspace, null, request.payload.cwd ?? ""),
          ...launch.run(ctx.executable, launch.typed()),
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
      const chosen = await account(request.payload.provider, request.payload.account);
      return location(
        r,
        await r.resumeAgent(
          opts,
          Launch.in(request.payload.provider, chosen, r.yolo(request.payload.provider, chosen)),
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
      const ws = r.workspaces.owner(request.payload.target)!,
        opts = spawnOptions(r, ctx, ws.id, request.payload.target, "");
      opts.cwd = worktreeAgents.folder(
        r.worktree_tracker.snapshot(r, ws),
        { pane: p.id },
        p.agent().directory() || opts.cwd,
      );
      return location(r, await r.forkAgent(opts, request.payload.target, request.payload.name ?? null));
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
      await r.workspaces.edit(request.payload.target, request.payload.name ?? ws.customName(), request.payload.cwd);
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
          (request.payload.enter ? viewerNative.encodeKey(p.terminal.handle, logicalKey("enter")) : ""),
      );
      return location(r, request.payload.target);
    }
    case "pane.keys": {
      const p = r.pane(request.payload.target);
      if (!p) throw Error("NoPane");
      const output = request.payload.text
        .split(" ")
        .filter(Boolean)
        .map((k: string) => viewerNative.encodeKey(p.terminal.handle, logicalKey(k)))
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
    compacting_since: a.compacting_since,
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
  // An agent's new state and its place at the top of its new section go out
  // together, or a viewer would show it at its old place first. The tick
  // would then find nothing to raise, so the change is marked here.
  if (r.raiseEntered()) r.changed();
  const coarse = (s: number) => (s <= 0 ? s : Math.floor(s / 5000000) * 5000000);
  const followed = viewer ? r.followed() : null;
  const conversations = r.conversations.items
    .filter(a => !followed || followed.has(a))
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
          checklist: a.checklist ?? { items: [], partial: false, at: 0 },
          model: text(a.model?.id),
          model_name: text(a.model?.name),
          model_price: a.model?.price ?? null,
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
    protocol: protocol.version,
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
    account_yolo: r.account_yolo,
    account_hidden: r.account_hidden,
    agent_commands: r.agent_commands,
    accounts: accounts.known().map(a => ({ provider: a.provider, account: a.dir, name: a.name, managed: a.managed })),
    workspaces: r.workspaces.items.map((w: any) => ({
      agent_order: w.agent_order.slice(),
      pinned_agents: w.pinned_agents.slice(),
      starred_sessions: w.starred_sessions.slice(),
      activity_order: w.activity_order.slice(),
      starting_agents: r.startingAgents(w),
      last_agent: w.last_agent,
      launcher_hidden: w.launcher_hidden,
      launcher_order: w.launcher_order,
      closed_agents: r.closedCount(w.id),
      git_commits:
        w.git_commits.items?.slice(0, w.git_commits.len).map((c: any) => ({
          timestamp: c.timestamp,
          hash: text(c.hash),
          subject: text(c.subject),
          author: text(c.author),
          date: text(c.date),
          diff: { ...c.diff },
        })) ?? [],
      git_diff: { ...w.git_commits.diff },
      id: w.id,
      name: w.name(),
      cwd: w.cwd,
      custom_name: w.customName(),
      git_ahead: w.git_ahead,
      worktrees: r.worktree_tracker.snapshot(r, w),
      git_ref: w.git_ref.view?.() ?? w.git_ref,
      git_push: w.git_push.view?.() ?? w.git_push,
      worktree_removal: r.worktree_tracker.removal(w.id),
      worktree_briefs: r.worktree_briefs.view(w.worktrees),
      stats: w.away.counts ?? {},
      model: w.model,
    })),
    panes: r.panes.map(p => ({
      ...location(r, p.id),
      id: p.id,
      binding: p.attachment.generation,
      name: p.label,
      cwd: p.cwd,
      command: p.command,
      brand: p.brand,
      pid: p.terminal.pid,
      cols: p.terminal.vt.cols,
      rows: p.terminal.vt.rows,
      exited: p.terminal.exited,
      agent: agentView(p.agent(), p.attachment.actor?.id ?? 0),
      account: p.account(),
      restoring: p.restoring(),
      forking: p.ghost?.fork !== null && p.ghost !== null,
      dormant: p.dormant,
    })),
    headless_sessions: r.sessions.map(s => ({
      agent: agentView(s.attachment.agent(), s.attachment.actor?.id ?? 0),
      session: s.session,
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
