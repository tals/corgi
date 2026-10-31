import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as tricks from "./tricks";
import * as settings from "./settings";
import * as os from "./os";
import * as budget from "./trick_budget";
import { adapter, type Provider } from "./providers";
import * as json from "./json";
import { getLogger } from "./log";
import type { Runtime } from "./runtime";
import type { Request } from "./protocol";

const log = getLogger("tricks");
export interface Manifest {
  id: string;
  command: string[] | null;
  entry: string | null;
  subscribe: tricks.Subscription;
  config: Record<string, unknown>;
  enabled: boolean;
}
export function manifest(source: string): Manifest {
  if (Buffer.byteLength(source) > tricks.max_bytes) throw Error("ManifestTooLarge");
  const m = tricks.object(Bun.TOML.parse(source));
  if (m.version !== tricks.version) throw Error("UnsupportedTrickVersion");
  if (m.entry !== undefined) {
    if (typeof m.entry !== "string" || !m.entry || m.entry.includes("\0") || m.command !== undefined)
      throw Error("InvalidEntry");
    if (m.subscribe !== undefined) throw Error("SubscribeInRegister");
  } else if (
    !Array.isArray(m.command) ||
    !m.command.length ||
    m.command.some(a => typeof a !== "string" || a.includes("\0"))
  )
    throw Error("InvalidCommand");
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") throw Error("InvalidEnabled");
  return {
    id: tricks.key(m.id),
    command: m.entry === undefined ? (m.command as string[]) : null,
    entry: typeof m.entry === "string" ? m.entry : null,
    subscribe: tricks.subscription(m.subscribe ?? { events: [] }),
    config: tricks.object(m.config ?? {}),
    enabled: m.enabled !== false,
  };
}
export function directory() {
  return (
    process.env.CORGI_TRICKS_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/", ".config"), "corgi", "tricks")
  );
}
export function snapshot(r: Runtime): tricks.Snapshot {
  const agents: tricks.Agent[] = [];
  for (const p of r.panes) {
    const a = p.agent();
    if (!a.provider) continue;
    const workspace = r.workspaces.items.find(w => w.model.tabForPane(p.id) !== null)?.id ?? 0;
    agents.push({
      id: `pane:${p.id}`,
      provider: a.provider,
      account: p.account(),
      workspace,
      session: a.sessionId(),
      name: p.label || a.displayName(),
      state: a.state,
      attention: a.attention,
      activity: a.activity.text(),
      completed: String(a.observation.completed),
    });
  }
  for (const s of r.sessions) {
    const a = s.attachment.agent();
    agents.push({
      id: `headless:${s.id}`,
      provider: s.provider,
      account: "",
      workspace: s.workspace_id,
      session: s.session,
      name: a.displayName(),
      state: s.status(),
      attention: s.attention(),
      activity: a.activity.text(),
      completed: String(a.observation.completed),
    });
  }
  return { agents, workspaces: r.workspaces.items.map(w => ({ id: w.id, name: w.name(), cwd: w.cwd })) };
}
export interface Status {
  id: string;
  path: string;
  running: boolean;
  error: string | null;
}
interface Running {
  instance: string;
  status: Status;
  manifest: Manifest;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  subscription: tricks.Subscription;
  views: Map<string, tricks.View>;
  kv: Record<string, unknown>;
  file: string;
  budget: budget.Budget;
  previous: tricks.Snapshot;
  previous_key: string;
}
export class Host {
  private running: Running[] = [];
  private statuses: Status[] = [];
  private previous: tricks.Snapshot = { agents: [], workspaces: [] };
  private sequence = 0n;
  private next_publish = 0;
  private timer?: ReturnType<typeof setInterval>;
  revision = 0n;
  constructor(
    readonly socket: string,
    private executable: string,
    private source: () => tricks.Snapshot,
    private changed: () => void,
    private focus?: (viewer: number, agent: string) => void,
  ) {}
  status(): Status[] {
    return this.statuses.map(s => ({ ...s }));
  }
  views(): tricks.View[] {
    return this.running.flatMap(r =>
      [...r.views.values()].map(view =>
        view.content
          ? {
              ...view,
              content: tricks.mapActions(
                view.content,
                action => `${r.instance}.${action}`,
                slot => `${r.instance}.${slot}`,
              ),
            }
          : view,
      ),
    );
  }
  press(action: string, viewer: number) {
    tricks.reference(action);
    const at = action.indexOf("."),
      instance = action.slice(0, at),
      local = action.slice(at + 1);
    const r = this.running.find(r => r.status.running && r.instance === instance);
    if (!r || ![...r.views.values()].some(view => tricks.actions(view.content).includes(local))) return false;
    this.send(r, { event: "ui.press", action: local, viewer });
    return true;
  }
  private invalidate() {
    this.revision++;
    this.changed();
  }
  private send(r: Running, value: unknown) {
    if (!r.status.running) return;
    const line = json.stringify(value) + "\n";
    if (r.child.stdin.writableLength + Buffer.byteLength(line) > 1024 * 1024) {
      this.fail(r, "SlowConsumer");
      return;
    }
    r.child.stdin.write(line);
  }
  private deliver(r: Running, event: tricks.Event) {
    if (!r.subscription.events.includes(event.event)) return;
    const where = r.subscription.where;
    if (event.event === "snapshot") event = { ...event, agents: event.agents.filter(a => tricks.matches(where, a)) };
    else if (
      !tricks.matches(where, event.agent ?? (event.event === "hook" ? { provider: event.provider } : {})) &&
      !(event.event === "agent.changed" && event.previous && tricks.matches(where, event.previous))
    )
      return;
    this.send(r, { ...event, seq: String(++this.sequence), at: Date.now() });
  }
  publish() {
    if (!this.running.some(r => r.status.running && r.subscription.events.length)) return;
    const now = performance.now();
    if (now < this.next_publish) return;
    this.next_publish = now + 100;
    const next = this.source();
    const key = JSON.stringify(next);
    const after = new Set(next.agents.map(a => a.id));
    for (const r of this.running) {
      if (!r.status.running || r.previous_key === key) continue;
      const before = new Map(r.previous.agents.map(a => [a.id, a]));
      this.deliver(r, { event: "snapshot", ...next });
      for (const agent of next.agents) {
        const previous = before.get(agent.id) ?? null;
        if (JSON.stringify(previous) !== JSON.stringify(agent))
          this.deliver(r, { event: "agent.changed", agent, previous });
      }
      for (const agent of r.previous.agents)
        if (!after.has(agent.id)) this.deliver(r, { event: "agent.removed", agent });
      r.previous = next;
      r.previous_key = key;
    }
    this.previous = next;
  }
  hook(q: Request<"hook">) {
    if (!this.running.some(r => r.status.running && r.subscription.events.includes("hook"))) return;
    const hook = adapter(q.provider).hook(q.event);
    if (!hook) return;
    const agent = this.source().agents.find(a => a.id === `pane:${q.pane}` && a.provider === q.provider) ?? null;
    for (const r of this.running)
      this.deliver(r, { event: "hook", agent, provider: q.provider, kind: hook.kind, tool: hook.tool.slice(0, 128) });
  }
  transcript(provider: Provider, session: string, record: unknown, bytes: number) {
    const subscribers = this.running.filter(r => r.status.running && r.subscription.events.includes("transcript"));
    if (!subscribers.length) return;
    const agents = this.source().agents.filter(a => a.provider === provider && a.session === session);
    for (const agent of agents)
      for (const r of subscribers)
        this.deliver(r, {
          event: "transcript",
          agent,
          record: bytes <= 32768 ? record : null,
          truncated: bytes > 32768,
        });
  }
  private fail(r: Running, error: string) {
    if (!r.status.running) return;
    r.status.error = error;
    log.warn("Trick stopped", { trick: r.manifest.id, error });
    this.kill(r);
  }
  private kill(r: Running) {
    if (!r.status.running) return;
    r.status.running = false;
    if (!this.running.some(r => r.status.running)) clearInterval(this.timer);
    r.views.clear();
    this.invalidate();
    if (r.child.pid) {
      try {
        process.kill(-r.child.pid, "SIGKILL");
      } catch {
        r.child.kill("SIGKILL");
      }
    }
  }
  async stop() {
    clearInterval(this.timer);
    const running = this.running;
    for (const r of running) this.kill(r);
    await Promise.all(running.map(r => r.exited));
    this.running = [];
  }
  async reload(root = directory()) {
    await this.stop();
    this.statuses = [];
    this.previous = this.source();
    this.next_publish = 0;
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Cannot read tricks", { root, error });
      return;
    }
    const ids = new Set<string>();
    for (const name of names.slice(0, 16)) {
      const path = join(root, name, "trick.toml");
      const status: Status = { id: name, path, running: false, error: null };
      this.statuses.push(status);
      try {
        const m = manifest(readFileSync(path, "utf8"));
        status.id = m.id;
        if (ids.has(m.id)) throw Error("DuplicateTrickId");
        ids.add(m.id);
        if (!m.enabled) continue;
        const file = join(settings.path(this.socket) + ".tricks", m.id + ".json");
        let kv: Record<string, unknown> = {};
        try {
          const saved = readFileSync(file);
          if (saved.length > tricks.max_bytes) throw Error("StoreTooLarge");
          const store = tricks.object(JSON.parse(saved.toString()));
          if (store.version !== tricks.version) throw Error("UnsupportedStoreVersion");
          kv = tricks.object(store.values);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const cwd = resolve(root, name),
          command = m.entry ? [this.executable, "__trick", resolve(cwd, m.entry)] : [...m.command!];
        if (command[0].includes("/")) command[0] = resolve(cwd, command[0]);
        const child = spawn(command[0], command.slice(1), {
          cwd,
          env: { ...process.env, CORGI_SOCKET: this.socket },
          detached: true,
          stdio: "pipe",
        });
        const exited = new Promise<void>(done => child.once("close", () => done()));
        const r: Running = {
          instance: crypto.randomUUID(),
          status,
          manifest: m,
          child,
          exited,
          subscription: m.subscribe,
          views: new Map(),
          kv,
          file,
          budget: new budget.Budget(),
          previous: this.previous,
          previous_key: JSON.stringify(this.previous),
        };
        status.running = true;
        this.running.push(r);
        child.on("error", error => this.fail(r, error.message));
        child.stdin.on("error", () => this.fail(r, "BrokenPipe"));
        child.on("exit", code => {
          if (r.status.running) this.fail(r, `Exited:${code}`);
        });
        let pending = "",
          window = Date.now(),
          count = 0,
          stderr = false,
          stderr_bytes = 0;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (!r.status.running) return;
          pending += chunk;
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (Date.now() - window > 1000) {
              window = Date.now();
              count = 0;
              stderr_bytes = 0;
            }
            if (++count > 1000 || Buffer.byteLength(line) > tricks.max_bytes) {
              this.fail(r, "OutputLimit");
              return;
            }
            this.receive(r, line);
            if (!r.status.running) return;
          }
          if (Buffer.byteLength(pending) > tricks.max_bytes) this.fail(r, "OutputLimit");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (!r.status.running) return;
          if (Date.now() - window > 1000) {
            window = Date.now();
            count = 0;
            stderr_bytes = 0;
          }
          stderr_bytes += chunk.length;
          if (stderr_bytes > tricks.max_bytes) {
            this.fail(r, "OutputLimit");
            return;
          }
          if (!stderr) log.warn("Trick stderr", { trick: m.id, text: chunk.toString().slice(0, 2048) });
          stderr = true;
        });
        this.send(r, { event: "ready", version: tricks.version, config: m.config, kv });
        this.deliver(r, { event: "snapshot", ...this.previous });
        for (const agent of this.previous.agents) this.deliver(r, { event: "agent.changed", agent, previous: null });
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error);
        log.warn("Cannot start trick", { path, error });
      }
    }
    if (this.running.some(r => r.status.running))
      this.timer = setInterval(() => {
        for (const r of this.running) {
          if (!r.status.running || !r.child.pid) continue;
          try {
            const error = r.budget.check(budget.sample(r.child.pid));
            if (error) this.fail(r, error);
          } catch {
            this.fail(r, "ResourceCheckFailed");
          }
        }
      }, 1000).unref();
  }
  private receive(r: Running, line: string) {
    let id: string | number | null = null;
    try {
      const value = tricks.object(JSON.parse(line));
      if (typeof value.id === "string" || typeof value.id === "number") id = value.id;
      const parsed = tricks.command(value);
      id = parsed.id;
      const c = parsed.command;
      let result: unknown = null;
      switch (c.op) {
        case "ui.focus":
          if (!this.source().agents.some(agent => agent.id === c.agent)) throw Error("NoAgent");
          if (!this.focus) throw Error("NoViewer");
          this.focus(c.viewer, c.agent);
          break;
        case "ui.set":
          if (JSON.stringify(r.views.get(c.key)) === JSON.stringify(c.view)) break;
          if (!r.views.has(c.key) && r.views.size >= tricks.max_views) throw Error("TooManyViews");
          if (
            Buffer.byteLength(
              JSON.stringify([...r.views.entries()].filter(([key]) => key !== c.key).concat([[c.key, c.view]])),
            ) > tricks.max_bytes
          )
            throw Error("ViewsTooLarge");
          r.views.set(c.key, c.view);
          this.invalidate();
          break;
        case "ui.remove":
          if (r.views.delete(c.key)) this.invalidate();
          break;
        case "subscribe":
          r.subscription = c.subscription;
          if (c.subscription.events.includes("snapshot") || c.subscription.events.includes("agent.changed")) {
            const snapshot = this.source();
            r.previous = snapshot;
            r.previous_key = JSON.stringify(snapshot);
            this.deliver(r, { event: "snapshot", ...snapshot });
            for (const agent of snapshot.agents) this.deliver(r, { event: "agent.changed", agent, previous: null });
          }
          break;
        case "kv.get":
          result = Object.hasOwn(r.kv, c.key) ? r.kv[c.key] : null;
          break;
        case "kv.set":
        case "kv.delete": {
          const values = { ...r.kv };
          if (c.op === "kv.set")
            Object.defineProperty(values, c.key, {
              value: c.value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          else delete values[c.key];
          const saved = JSON.stringify({ version: tricks.version, values });
          if (Buffer.byteLength(saved) > tricks.max_bytes) throw Error("StoreTooLarge");
          os.atomicWrite(r.file, saved);
          r.kv = values;
          break;
        }
      }
      if (id !== null) this.send(r, { id, ok: true, result });
    } catch (error) {
      this.send(r, { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
