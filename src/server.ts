import { mkdirSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { Runtime } from "./runtime";
import { Store } from "./workspace";
import { Client } from "./peer";
import { n, ReadyLoop, READ } from "./native_bridge";
import { closeReadiness } from "./pane/terminal";
import { Theme } from "./theme";
import { Provider } from "./providers";
import * as protocol from "./protocol";
import * as session from "./session";
import * as viewer from "./viewer_protocol";
import * as clock from "./clock";
import { SocketPath, listen } from "./os";
import * as json from "./json";
import * as recovery from "./persist/recovery";
import * as launch from "./launch_service";
import * as integration from "./integration";
import * as observers from "./observer_service";
import * as trackers from "./trackers";
import * as updates from "./updates";
import * as importer from "./import_service";
import { testBuild } from "./build_assets";
export class Server {
  runtime = new Runtime();
  clients: Client[] = [];
  theme = new Theme();
  next_viewer = 1;
  next_active = 0;
  preferred_workspace = 1;
  default_folder_pending = true;
  bell_seq = 0;
  last_bell_kind = "none";
  bell = false;
  bell_kind = "none";
  last_bell = 0;
  resource_readings = true;
  dirty = true;
  listener = -1;
  private socketPath: SocketPath | null = null;
  private loop = new ReadyLoop();
  private registration?: ReturnType<ReadyLoop["watch"]>;
  private jobs: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private subscribedRevision: number | bigint = -1;
  private watched = new WeakSet<object>();
  private frozen = false;
  private savedDurable = 0n;
  private durableAt = 0;
  private lastRecovery = 0;
  private workspaceWrites: Promise<void> = Promise.resolve();
  private collecting = false;
  constructor(
    readonly socket: string,
    readonly executable: string,
    readonly build_id: string,
  ) {}
  initialWorkspace() {
    return this.runtime.workspaces.get(this.preferred_workspace) ?? this.runtime.workspaces.items[0];
  }
  onlyWorkspace() {
    if (this.runtime.workspaces.items.length !== 1) throw Error("MissingWorkspace");
    return this.runtime.workspaces.items[0];
  }
  saveWorkspaces(): Promise<void> {
    this.workspaceWrites = this.workspaceWrites.then(async () => {
      try {
        await this.runtime.workspaces.save(Store.statePath(this.socket), this.initialWorkspace().id);
      } catch (error) {
        console.error("workspace save:", error);
      }
    });
    return this.workspaceWrites;
  }
  async flushWorkspaceWrites(): Promise<void> {
    await this.workspaceWrites;
  }
  visitWorkspace(id: number): void {
    const w = this.runtime.workspaces.get(id);
    if (w?.away.visit(Date.now())) {
      this.runtime.changed();
      this.dirty = true;
    }
  }
  attention(ding: boolean, state: string): void {
    if (!ding) return;
    this.bell = true;
    if (this.bell_kind !== "needs_input") this.bell_kind = state === "blocked" ? "needs_input" : "finished";
  }
  private flushBell(now: number): void {
    if (this.bell && this.bell_kind === "finished") {
      const unread =
        this.runtime.conversations.items.some(actor => actor.state.observation.unread()) ||
        this.runtime.sessions.some(session => session.attention() === "finished");
      if (!unread) {
        this.bell = false;
        this.bell_kind = "none";
      }
    }
    if (this.bell && now - this.last_bell > 1500) {
      this.bell_seq++;
      this.last_bell_kind = this.bell_kind;
      this.bell = false;
      this.bell_kind = "none";
      this.last_bell = now;
      this.dirty = true;
    }
  }
  updateTheme(theme: any): void {
    if (!theme) return;
    const next = Object.assign(new Theme(), theme);
    this.theme.merge(next);
    for (const p of this.runtime.panes) p.terminal.applyTheme(this.theme);
    this.dirty = true;
  }
  async execute(command: protocol.Command): Promise<protocol.Result> {
    importer.admit(this, "session.command");
    const result = await session.execute(
      this.runtime,
      { socket: this.socket, executable: this.executable, theme: this.theme },
      protocol.decodeCommand(command),
    );
    this.bindPanes();
    this.dirty = true;
    await this.saveWorkspaces();
    await this.followWorkspaceDirectories();
    return { ...protocol.emptyResult(), ...result };
  }
  private bindPanes(): void {
    for (const pane of this.runtime.panes)
      if (!this.watched.has(pane)) {
        this.watched.add(pane);
        pane.terminal.on("change", () => {
          this.runtime.wrote();
          this.dirty = true;
          this.wakeViewers();
        });
        pane.terminal.on("ioError", error => console.error("terminal:", error));
      }
  }
  private async followWorkspaceDirectories(): Promise<void> {
    let changed = false;
    for (const w of this.runtime.workspaces.items)
      if (w.model.count) {
        const p = this.runtime.pane(w.model.firstPane(w.model.tabs[0].root));
        if (p) changed = w.follow(p.cwd) || changed;
      }
    if (changed) {
      this.runtime.refreshed();
      this.dirty = true;
      await this.saveWorkspaces();
    }
  }
  private wakeSeq(id: number): bigint {
    let seq = BigInt(this.runtime.shown) + BigInt(this.bell_seq);
    for (const c of this.clients)
      if (c.viewer && c.viewer_id === id) {
        seq += BigInt(c.next_control);
        for (const interest of c.interests) {
          const p = this.runtime.pane(interest.pane);
          if (p) seq += BigInt(p.displayed().surface_revision);
        }
      }
    return BigInt.asUintN(64, seq);
  }
  private wakeViewers(): void {
    for (const c of this.clients)
      if (c.watching && !c.dead && c.output.length === 0) {
        const next = this.wakeSeq(c.watch_viewer);
        if (BigInt(c.woken) !== next) {
          c.woken = next;
          c.queue({ type: "viewer.wake" });
        }
      }
  }
  private publish(): void {
    if (this.subscribedRevision === this.runtime.revision && !this.dirty) return;
    if (this.subscribedRevision !== this.runtime.revision) {
      const snapshot = session.snapshot(this.runtime);
      for (const c of this.clients) if (c.subscribed) c.queue(snapshot);
      this.subscribedRevision = this.runtime.revision;
    }
    this.wakeViewers();
    this.dirty = false;
  }
  async run(): Promise<void> {
    try {
      let selected: number | null = null;
      if (this.listener < 0) {
        if (await recovery.load(this.runtime, this.socket, this.executable)) {
          const preferences = new Store();
          try {
            selected = await preferences.load(Store.statePath(this.socket));
          } catch (error) {
            console.error("workspace load:", error);
          }
          this.default_folder_pending = false;
        } else
          try {
            selected = await this.runtime.workspaces.load(Store.statePath(this.socket));
          } catch (error) {
            console.error("workspace load:", error);
          }
        if (!this.runtime.workspaces.items.length) await this.runtime.workspaces.add("", process.cwd());
        this.preferred_workspace = selected ?? this.runtime.workspaces.items[0].id;
        this.default_folder_pending = selected === null;
        this.listener = listen(this.socket);
        chmodSync(this.socket, 0o600);
        this.socketPath = SocketPath.claim(this.socket);
        for (const provider of Provider.all)
          try {
            await integration.install(provider);
          } catch (error) {
            console.error("hook setup:", error);
          }
        void integration.installCodexTitle().catch(error => console.error("Codex title setup:", error));
      } else this.socketPath = SocketPath.claim(this.socket);
      this.bindPanes();
      observers.start(this);
      for (const p of this.runtime.panes) if (p.terminal.imported) p.terminal.adopt(p.terminal.fd, p.terminal.pid);
      for (const c of this.clients) c.resume();
      this.startLoop();
      process.on("SIGTERM", () => void this.shutdown());
      process.on("SIGINT", () => void this.shutdown());
      await this.saveWorkspaces();
    } catch (error) {
      clearInterval(this.timer);
      this.registration?.close();
      for (const c of [...this.clients]) c.close();
      if (this.listener >= 0) n.probe_close(this.listener);
      this.listener = -1;
      this.runtime.deinit();
      this.loop.close();
      closeReadiness();
      this.socketPath?.release();
      throw error;
    }
  }
  private enqueue(work: () => Promise<void>): void {
    this.jobs = this.jobs.then(work).catch(error => console.error("daemon job:", error));
  }
  private startLoop(): void {
    n.probe_nonblock(this.listener);
    this.registration = this.loop.watch(this.listener, () => {
      this.accept();
      this.registration?.arm(READ);
    });
    this.registration.arm(READ);
    this.timer = setInterval(() => {
      if (this.collecting || this.frozen) return;
      this.collecting = true;
      this.enqueue(async () => {
        try {
          await this.collect();
        } finally {
          this.collecting = false;
        }
      });
    }, 50);
  }
  pause(): void {
    this.frozen = true;
    clearInterval(this.timer);
    this.registration?.close();
    this.registration = undefined;
    for (const c of this.clients) c.pause();
    for (const p of this.runtime.panes) p.terminal.pause();
    for (const s of this.runtime.sessions) s.pause();
  }
  resume(): void {
    this.frozen = false;
    for (const c of this.clients) c.resume();
    for (const p of this.runtime.panes) p.terminal.resume();
    for (const s of this.runtime.sessions) s.resume();
    this.startLoop();
  }
  addClient(fd: number, saved?: any): Client {
    const client = new Client(
      fd,
      this.loop,
      cl => {
        // A hook sender may close as soon as it has written, as `corgi hook`
        // does; the event it sent still applies. Other requests die with their client.
        this.enqueue(async () => {
          if (cl.dead && cl.pending[0]?.op !== "hook") return;
          const v = cl.take();
          try {
            await this.request(cl, v);
          } catch (error) {
            cl.queue({ err: error instanceof Error ? error.message : String(error) });
          } finally {
            cl.done();
          }
          this.publish();
        });
      },
      () => {
        this.clients = this.clients.filter(c => !c.dead);
        this.dirty = true;
        void viewer.resize(this);
      },
      !saved,
    );
    if (saved) {
      const { input, output, fd: _, ...fields } = saved;
      Object.assign(client, fields);
      client.restoreInput(Buffer.from(input, "base64"));
      client.output = Buffer.from(output, "base64");
      client.sent = 0;
    }
    this.clients.push(client);
    return client;
  }
  private accept(): void {
    for (;;) {
      const fd = n.probe_accept(this.listener);
      if (fd < 0) break;
      if (this.clients.length >= 32) n.probe_close(fd);
      else this.addClient(fd);
    }
  }
  private async collect(): Promise<void> {
    if (this.stopped || this.frozen) return;
    await importer.tick(this);
    const now = Date.now();
    for (const p of [...this.runtime.panes]) {
      p.terminal.read();
      const copied = p.terminal.takeCopied();
      if (copied !== null) viewer.copy(this, p.id, copied);
      p.terminal.refreshRedraw(now);
      p.watchGhost(now);
      const cwd = p.cwd;
      p.refreshCwd();
      // Viewers inherit a pane's folder for new tabs, so a `cd` wakes them.
      if (p.cwd !== cwd) {
        this.runtime.changed();
        this.dirty = true;
      }
      if (p.failed()) {
        if (p.keepFailed()) this.dirty = true;
      } else if (p.terminal.exited) this.runtime.close(p.id);
    }
    await this.followWorkspaceDirectories();
    this.runtime.reapStopped();
    await this.runtime.advanceRenames(clock.milliTimestamp());
    await observers.tick(this);
    const gitStatusChanged = this.runtime.git_status.tick(this.runtime.workspaces);
    const gitPushChanged = this.runtime.git_push.tick(this.runtime.workspaces, this.runtime.git_status);
    const portsChanged = this.runtime.ports.tick(this.runtime);
    let tracked = gitStatusChanged || gitPushChanged || portsChanged;
    const viewers = this.clients.filter(c => c.viewer && !c.dead);
    if (viewers.length) this.resource_readings = viewers.some(c => c.resources);
    if (this.resource_readings)
      tracked =
        this.runtime.resources.tick(
          this.runtime,
          viewers.some(c => c.watched && c.resource_detail !== null),
        ) || tracked;
    else tracked = this.runtime.resources.stop() || tracked;
    if (tracked) this.runtime.refreshed();
    this.flushBell(now);
    for (const c of this.clients) launch.publish(this, c);
    if (this.savedDurable !== this.runtime.durable) {
      if (!this.durableAt) this.durableAt = now;
      if (now - this.durableAt >= 2000 || now - this.lastRecovery >= 10000) {
        await recovery.save(this.runtime, this.socket);
        this.savedDurable = this.runtime.durable;
        this.lastRecovery = now;
        this.durableAt = 0;
      }
    }
    this.publish();
  }
  async request(cl: Client, v: any): Promise<void> {
    const op = protocol.parse(v);
    if (!op) throw Error("UnknownOperation");
    if (!testBuild && (op === "test.advance" || op === "test.settle")) throw Error("UnknownOperation");
    const check = protocol.check(op);
    if (check === "viewer" && v.viewer_protocol !== protocol.viewer_version) {
      cl.queue({ err: "UnsupportedViewerProtocol", viewer_protocol: protocol.viewer_version });
      return;
    }
    if (check !== "none") protocol.require(v, check === "negotiate" ? null : cl.protocol_version);
    const q = protocol.decode(op, v);
    if (!["onboarding.copy", "onboarding.handoff"].includes(op)) importer.admit(this, op);
    switch (op) {
      case "hello":
        cl.protocol_version = protocol.version;
        cl.queue({
          type: "hello",
          protocol: protocol.version,
          capabilities: protocol.capabilities,
          server_pid: process.pid,
          build_id: this.build_id,
          executable: this.executable,
          release_version: updates.release(this.executable).version,
          update_abi: updates.abi,
        });
        return;
      case "ping":
        cl.queue({ ok: true, pid: process.pid });
        return;
      case "shutdown":
        cl.queue({ ok: true });
        setTimeout(() => void this.shutdown(), 0);
        return;
      case "session.command":
        cl.reply(op, { result: await this.execute(q.command) });
        return;
      case "session.locate":
        cl.reply(op, { result: { ...protocol.emptyResult(), ...session.location(this.runtime, q.pane) } });
        return;
      case "session.list":
        cl.queue({ ok: true, result: session.snapshot(this.runtime), viewers: viewer.viewers(this) });
        return;
      case "session.snapshot":
        cl.queue(session.snapshot(this.runtime));
        return;
      case "session.subscribe":
        if (cl.viewer || cl.launch_preview || cl.watching) throw Error("AlreadyAttached");
        cl.subscribed = true;
        cl.queue(session.snapshot(this.runtime));
        return;
      case "viewer.open":
        await viewer.open(this, cl, { cwd: "", onboarding: false, theme: null, ...q });
        return;
      case "viewer.sync":
        await viewer.sync(this, cl, {
          session_hash: null,
          focus: null,
          watched: true,
          workspace: 0,
          ack: 0,
          active: false,
          resource_detail: null,
          resources: true,
          resources_hash: null,
          ...q,
        });
        return;
      case "viewer.search":
        await viewer.search(this, cl, { skip: 0, ...q });
        return;
      case "viewer.watch":
        if (cl.viewer || cl.subscribed || cl.launch_preview) throw Error("AlreadyAttached");
        cl.watching = true;
        cl.watch_viewer = q.viewer;
        cl.woken = this.wakeSeq(q.viewer);
        cl.queue({ ok: true });
        return;
      case "viewer.list":
        cl.queue({ ok: true, viewers: viewer.viewers(this) });
        return;
      case "pane.acknowledge":
        viewer.acknowledge(this, cl, {
          session: "",
          through: 0,
          binding: null,
          conversation: null,
          attention_at: null,
          ...q,
        });
        return;
      case "pane.paste":
        await viewer.paste(this, cl, q);
        return;
      case "action":
        await viewer.action(this, cl, { name: "", value: "", viewer: null, pane: null, ...q });
        return;
      case "focus":
        viewer.focus(this, cl, { viewer: null, ...q });
        return;
      case "workspace.switch":
        viewer.switchWorkspace(this, cl, { viewer: null, ...q });
        return;
      case "conversation.list":
        cl.queue({ ok: true, conversations: session.snapshot(this.runtime).conversations });
        return;
      case "conversation.acknowledge": {
        const actor = this.runtime.conversations.byId(q.conversation);
        if (!actor) throw Error("NoConversation");
        actor.acknowledge(q.through, q.attention_at ?? null);
        this.runtime.changed();
        cl.queue({ ok: true });
        return;
      }
      case "pane.surface": {
        const p = this.runtime.pane(q.pane);
        if (!p) throw Error("NoPane");
        cl.queue({
          type: "surface",
          protocol: 1,
          server_pid: process.pid,
          revision: this.runtime.revision,
          surface: p.terminal.surface(p.id).surface,
        });
        return;
      }
      case "theme":
        this.updateTheme(q.theme);
        cl.queue({ ok: true });
        return;
      case "hook":
        await observers.hook(this, q);
        cl.queue({ ok: true });
        return;
      case "test.advance":
        clock.advance(q.ms);
        observers.poke(this);
        cl.queue({ ok: true });
        return;
      case "test.settle":
        await observers.settle(this);
        await trackers.settle(this.runtime, () => this.collect());
        cl.queue({ ok: true });
        return;
      case "server.reload": {
        if (!isAbsolute(q.executable ?? "")) throw Error("InvalidExecutable");
        const handoff = await import("./persist/handoff");
        await handoff.replace(this, cl, q.executable);
        return;
      }
      case "recovery.save": {
        const recovery = await import("./persist/recovery");
        await recovery.save(this.runtime, this.socket);
        cl.queue({ ok: true, path: recovery.path(this.socket) });
        return;
      }
      case "native.start":
      case "native.list":
      case "native.stop":
      case "native.send":
      case "native.events": {
        const native = await import("./native");
        await native.request(this, cl, op, q);
        return;
      }
      case "agent.command.preview":
        await launch.request(this, cl, op, q);
        return;
      case "agent.preview":
      case "agent.track_usage":
      case "agent.subscribe":
      case "agent.history": {
        const launch = await import("./launch_service");
        await launch.request(this, cl, op, q);
        return;
      }
      case "inference.configure": {
        const inference = await import("./inference_service");
        await inference.configure(this, cl, q);
        return;
      }
      case "git.push": {
        const git = await import("./trackers/git_push");
        await git.start(this.runtime, q.workspace, q.ref);
        this.runtime.changed();
        this.dirty = true;
        cl.queue({ ok: true });
        return;
      }
      case "onboarding.status":
      case "onboarding.handoff":
      case "onboarding.copy": {
        const importer = await import("./import");
        await importer.request(this, cl, op, q);
        return;
      }
    }
  }
  private async hook(q: any): Promise<void> {
    if (!["codex", "claude"].includes(q.provider)) throw Error("InvalidEnumTag");
    const event = Provider.backend(q.provider).hook(q.event);
    if (!event) return;
    const p = this.runtime.pane(q.pane ?? 0);
    let actor: any = null;
    if (p) actor = this.runtime.conversations.routeHook(p.attachment, q.provider, event);
    if (!actor && q.background && event.session) actor = this.runtime.conversations.get(q.provider, event.session);
    if (!actor) return;
    actor.workspace ||= p ? (this.runtime.workspaces.owner(p.id)?.id ?? 0) : this.initialWorkspace().id;
    const now = clock.microTimestamp();
    const ding = this.runtime.conversations.observeHook(actor, event, q.seq ?? now, false, now);
    this.attention(ding, actor.state.state);
    this.runtime.changed();
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.registration?.close();
    try {
      await recovery.save(this.runtime, this.socket);
    } catch (error) {
      console.error("recovery save:", error);
    }
    launch.stop(this);
    observers.stop(this);
    importer.stop(this);
    for (const cl of [...this.clients]) cl.close();
    if (this.listener >= 0) n.probe_close(this.listener);
    this.listener = -1;
    this.runtime.deinit();
    this.loop.close();
    closeReadiness();
    this.socketPath?.release();
  }
}
