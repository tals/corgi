import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as trickConfig from "./trick_config";
import type { Status } from "./trick_config";
import * as trickWatch from "./trick_watch";
import * as trickDefaults from "./trick_defaults";
import * as tricks from "./tricks";
import * as settings from "./settings";
import * as os from "./os";
import * as budget from "./trick_budget";
import { adapter, type Provider } from "./providers";
import * as json from "./json";
import * as accounts from "./accounts";
import * as agentEnv from "./agent_env";
import * as trickPalette from "./trick_palette";
import * as paletteStore from "./trick_palette_store";
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
  if (m.version !== 1) throw Error("UnsupportedTrickVersion");
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
      account: p.detection.claim
        ? null
        : accounts.metadata(a.provider, a.account ?? accounts.describe(a.provider, p.account())),
      env: p.agent_env,
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
      account: accounts.metadata(s.provider, a.account ?? accounts.describe(s.provider, s.account)),
      env: s.env,
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
interface Running {
  palettes: Set<string>;
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
  private config: trickConfig.Config = { autoreload: true, enabled: {} };
  private root = directory();
  private watcher: trickWatch.Watcher | null = null;
  private watch_error: string | null = null;
  private work: Promise<void> = Promise.resolve();
  private epoch = 0;
  revision = 0n;
  readonly palettes: paletteStore.Store;
  constructor(
    readonly socket: string,
    private executable: string,
    private source: () => tricks.Snapshot,
    private changed: () => void,
    private focus?: (viewer: number, agent: string) => void,
  ) {
    this.palettes = paletteStore.open(socket, (ref, state) => {
      for (const r of this.running)
        for (const name of r.palettes)
          if (trickPalette.reference(r.manifest.id, name) === ref)
            this.send(r, { event: "palette.changed", name, state });
      this.invalidate();
    });
  }
  palette(ref: string): trickPalette.Info {
    const state = this.palettes.get(ref),
      agents = this.source().agents;
    return {
      ref,
      entries: state.keys.length,
      colors: state.colors,
      assignments: state.keys.map((encoded, index) => {
        const key = JSON.parse(encoded) as trickPalette.Key;
        const agent = agents.find(a => a.account?.id === key);
        return {
          key,
          label: agent?.account
            ? adapter(agent.provider).name + " · " + agent.account.name
            : typeof key === "string"
              ? key
              : encoded,
          color: trickPalette.color(state, index),
          override: state.overrides[index] !== null,
        };
      }),
    };
  }
  info(): trickConfig.Info {
    return {
      directory: this.root,
      autoreload: this.config.autoreload,
      watch_error: this.watcher?.error ?? this.watch_error,
      tricks: this.status(),
    };
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.work.then(run);
    this.work = next.catch(() => {});
    return next;
  }
  private unwatch() {
    this.watcher?.close();
    this.watcher = null;
    this.watch_error = null;
  }
  private watch() {
    if (!this.config.autoreload || this.watcher) return;
    try {
      const watcher = new trickWatch.Watcher(this.root, names => {
        void this.enqueue(async () => {
          if (this.watcher === watcher) await this.restart(names);
        }).catch(error => log.warn("Cannot reload tricks", { error }));
      });
      this.watcher = watcher;
    } catch {
      this.watch_error = "Cannot watch trick files; use Reload to retry.";
    }
  }
  async configure(q: Request<"tricks.configure">) {
    return this.enqueue(async () => {
      if ((q.id === null) !== (q.enabled === null)) throw Error("InvalidTrickSetting");
      const current = trickConfig.config(settings.read(settings.path(this.socket)).tricks);
      if (q.id !== null) {
        tricks.key(q.id);
        if (this.statuses.filter(s => s.id === q.id).length !== 1) throw Error("NoTrick");
        current.enabled = { ...current.enabled, [q.id]: q.enabled! };
      }
      if (q.autoreload !== null) current.autoreload = q.autoreload;
      settings.update(settings.path(this.socket), { tricks: current });
      this.config = current;
      if (!current.autoreload) this.unwatch();
      if (q.id !== null) {
        const found = this.statuses.find(s => s.id === q.id)!;
        await this.restart(new Set([basename(dirname(found.path))]));
      }
      this.watch();
      this.invalidate();
    });
  }
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
    if (!this.running.some(r => r.status.running)) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
  private async stopProcesses(selected: Set<string> | null = null) {
    const running = this.running.filter(r => !selected || selected.has(basename(dirname(r.status.path))));
    for (const r of running) this.kill(r);
    await Promise.all(running.map(r => r.exited));
    this.running = this.running.filter(r => !running.includes(r));
  }
  stop() {
    this.epoch++;
    this.palettes.close();
    this.unwatch();
    return this.enqueue(() => this.stopProcesses());
  }
  reload(root = directory()) {
    const epoch = ++this.epoch;
    this.unwatch();
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      this.root = resolve(root);
      if (process.env.CORGI_TRICKS_DIR === undefined) {
        try {
          trickDefaults.install(this.root);
        } catch (error) {
          log.warn("Cannot install default Tricks", { error });
        }
      }
      this.config = trickConfig.config(settings.read(settings.path(this.socket)).tricks);
      this.watch();
      await this.restart(null);
    });
  }
  private async restart(selected: Set<string> | null) {
    await this.stopProcesses(selected);
    this.statuses = this.statuses.filter(s => selected && !selected.has(basename(dirname(s.path))));
    this.previous = this.source();
    this.next_publish = 0;
    let names: string[];
    try {
      names = trickWatch.folders(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        log.warn("Cannot read tricks", { root: this.root, error });
      await this.stopProcesses();
      this.statuses = [];
      this.invalidate();
      return;
    }
    const missing = new Set(
      this.statuses.filter(s => !names.includes(basename(dirname(s.path)))).map(s => basename(dirname(s.path))),
    );
    await this.stopProcesses(missing);
    this.statuses = this.statuses.filter(s => !missing.has(basename(dirname(s.path))));
    const ids = new Set(this.statuses.map(s => s.id));
    for (const name of names.filter(name => !this.statuses.some(s => s.path === join(this.root, name, "trick.toml")))) {
      const path = join(this.root, name, "trick.toml");
      const status: Status = { id: name, path, enabled: true, running: false, error: null };
      this.statuses.push(status);
      try {
        const m = manifest(readFileSync(path, "utf8"));
        status.id = m.id;
        if (ids.has(m.id)) throw Error("DuplicateTrickId");
        ids.add(m.id);
        status.enabled = Object.hasOwn(this.config.enabled, m.id) ? this.config.enabled[m.id] : m.enabled;
        if (!status.enabled) continue;
        const file = join(settings.path(this.socket) + ".tricks", m.id + ".json");
        let kv: Record<string, unknown> = {};
        try {
          const saved = readFileSync(file);
          if (saved.length > tricks.max_bytes) throw Error("StoreTooLarge");
          const store = tricks.object(JSON.parse(saved.toString()));
          if (store.version !== 1) throw Error("UnsupportedStoreVersion");
          kv = tricks.object(store.values);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const cwd = resolve(this.root, name),
          command = m.entry ? [this.executable, "__trick", resolve(cwd, m.entry)] : [...m.command!];
        if (command[0].includes("/")) command[0] = resolve(cwd, command[0]);
        const child = spawn(command[0], command.slice(1), {
          cwd,
          env: { ...agentEnv.trick(process.env), CORGI_SOCKET: this.socket },
          detached: true,
          stdio: "pipe",
        });
        const exited = new Promise<void>(done => child.once("close", () => done()));
        const r: Running = {
          palettes: new Set(),
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
    this.statuses.sort((a, b) => a.path.localeCompare(b.path));
    this.invalidate();
    if (!this.timer && this.running.some(r => r.status.running))
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
  private async receive(r: Running, line: string) {
    let id: string | number | null = null;
    try {
      const value = tricks.object(JSON.parse(line));
      if (typeof value.id === "string" || typeof value.id === "number") id = value.id;
      const parsed = tricks.command(value);
      id = parsed.id;
      const c = parsed.command;
      let result: unknown = null;
      switch (c.op) {
        case "palette.define":
          if (!r.palettes.has(c.name) && r.palettes.size >= 16) throw Error("TooManyPalettes");
          r.palettes.add(c.name);
          result = await this.palettes.define(r.manifest.id, c.name, c.colors, r.kv["palette." + c.name]);
          break;
        case "palette.assign":
          if (!r.palettes.has(c.name)) throw Error("NoPalette");
          result = await this.palettes.assign(trickPalette.reference(r.manifest.id, c.name), c.key);
          break;
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
          const saved = JSON.stringify({ version: 1, values });
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
