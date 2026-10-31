import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as tricks from "./tricks";
import * as settings from "./settings";
import * as os from "./os";
import { getLogger } from "./log";
import type { Runtime } from "./runtime";
import type { Request } from "./protocol";

const log = getLogger("tricks");
export interface Manifest {
  id: string;
  command: string[];
  subscribe: tricks.Subscription;
  config: Record<string, unknown>;
  enabled: boolean;
}
export function manifest(source: string): Manifest {
  if (Buffer.byteLength(source) > tricks.max_bytes) throw Error("ManifestTooLarge");
  const m = tricks.object(Bun.TOML.parse(source));
  if (m.version !== tricks.version) throw Error("UnsupportedTrickVersion");
  if (!Array.isArray(m.command) || !m.command.length || m.command.some(a => typeof a !== "string" || a.includes("\0")))
    throw Error("InvalidCommand");
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") throw Error("InvalidEnabled");
  return {
    id: tricks.key(m.id),
    command: m.command as string[],
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
  status: Status;
  manifest: Manifest;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  subscription: tricks.Subscription;
  views: Map<string, tricks.View>;
  kv: Record<string, unknown>;
  file: string;
}
export class Host {
  private running: Running[] = [];
  private statuses: Status[] = [];
  private previous: tricks.Snapshot = { agents: [], workspaces: [] };
  private sequence = 0n;
  revision = 0n;
  constructor(
    readonly socket: string,
    private source: () => tricks.Snapshot,
    private changed: () => void,
  ) {}
  status(): Status[] {
    return this.statuses.map(s => ({ ...s }));
  }
  views(): tricks.View[] {
    return this.running.flatMap(r => [...r.views.values()]);
  }
  private invalidate() {
    this.revision++;
    this.changed();
  }
  private send(r: Running, value: unknown) {
    if (!r.status.running) return;
    const line = JSON.stringify(value) + "\n";
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
    const next = this.source();
    if (JSON.stringify(next) === JSON.stringify(this.previous)) return;
    const before = new Map(this.previous.agents.map(a => [a.id, a]));
    const after = new Set(next.agents.map(a => a.id));
    for (const r of this.running) {
      this.deliver(r, { event: "snapshot", ...next });
      for (const agent of next.agents) {
        const previous = before.get(agent.id) ?? null;
        if (JSON.stringify(previous) !== JSON.stringify(agent))
          this.deliver(r, { event: "agent.changed", agent, previous });
      }
      for (const agent of this.previous.agents)
        if (!after.has(agent.id)) this.deliver(r, { event: "agent.removed", agent });
    }
    this.previous = next;
  }
  hook(q: Request<"hook">) {
    if (!this.running.some(r => r.status.running && r.subscription.events.includes("hook"))) return;
    const agent = this.source().agents.find(a => a.id === `pane:${q.pane}` && a.provider === q.provider) ?? null;
    for (const r of this.running) this.deliver(r, { event: "hook", agent, provider: q.provider, data: q.event });
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
    const running = this.running;
    for (const r of running) this.kill(r);
    await Promise.all(running.map(r => r.exited));
    this.running = [];
  }
  async reload(root = directory()) {
    await this.stop();
    this.statuses = [];
    this.previous = this.source();
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
          command = [...m.command];
        if (command[0].includes("/")) command[0] = resolve(cwd, command[0]);
        const child = spawn(command[0], command.slice(1), {
          cwd,
          env: { ...process.env, CORGI_SOCKET: this.socket },
          detached: true,
          stdio: "pipe",
        });
        const exited = new Promise<void>(done => child.once("close", () => done()));
        const r: Running = {
          status,
          manifest: m,
          child,
          exited,
          subscription: m.subscribe,
          views: new Map(),
          kv,
          file,
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
          stderr = false;
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
        case "ui.set":
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
          this.deliver(r, { event: "snapshot", ...this.source() });
          for (const agent of this.source().agents) this.deliver(r, { event: "agent.changed", agent, previous: null });
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
