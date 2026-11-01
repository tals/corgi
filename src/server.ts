import * as launcherConfig from "./launcher_config";
import * as agentModels from "./agent_models";
import { Quit as ModelQuit } from "./subprocess";
import * as telemetry from "./telemetry";
import type { Worker as SummaryWorker } from "./activity/worker";
import type { Worker as UsageWorker } from "./usage/worker";
import { chmodSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Runtime } from "./runtime";
import { Store } from "./workspace";
import { Client, Reply } from "./peer";
import { n, ReadyLoop, READ } from "./native_bridge";
import { closeReadiness } from "./pane/terminal";
import { Theme } from "./theme";
import * as protocol from "./protocol";
import * as session from "./session";
import * as viewer from "./viewer_protocol";
import * as clock from "./clock";
import { SocketPath, listen, running } from "./os";
import * as json from "./json";
import * as recovery from "./persist/recovery";
import * as launch from "./launch_service";
import * as launch_command from "./launch/command";
import * as settings from "./settings";
import * as integration from "./integration";
import * as observers from "./observer_service";
import * as trackers from "./trackers";
import * as updates from "./updates";
import * as importer from "./import_service";
import * as worktreeAdd from "./worktree_add";
import { testBuild } from "./build_assets";
export class Server {
  summaries: SummaryWorker | null = null;
  usage: UsageWorker | null = null;
  runtime = new Runtime();
  clients: Client[] = [];
  theme = new Theme();
  started_at = Date.now();
  next_viewer = 1;
  next_active = 0;
  preferred_workspace = 1;
  default_folder_pending = true;
  bell_seq = 0n;
  last_bell_kind: protocol.View["bell_kind"] = "none";
  bell = false;
  bell_kind: protocol.View["bell_kind"] = "none";
  last_bell = 0;
  resource_readings = true;
  dirty = true;
  listener = -1;
  private socketPath: SocketPath | null = null;
  private loop = new ReadyLoop();
  private registration?: ReturnType<ReadyLoop["watch"]>;
  private jobs: Promise<void> = Promise.resolve();
  private modelReads = new Map<Client, () => void>();
  /** Deferred replies, each with whether it changes state and how to answer it early. */
  private deferred = new Map<Promise<void>, { busy: protocol.Busy | null; drop: () => void }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private subscribedRevision = -1n;
  private watched = new WeakSet<object>();
  private frozen = false;
  private savedDurable = 0n;
  private durableAt = 0;
  private lastRecovery = 0;
  private workspaceWrites: Promise<void> = Promise.resolve();
  private collecting = false;
  private collected = -Infinity;
  // Test builds stop with the test process that owns their runtime.
  private owner = testBuild ? Number(process.env.CORGI_TEST_OWNER) || 0 : 0;
  private ownerChecked = 0;
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
        this.runtime.panes.some(pane => pane.agent().observation.unread()) ||
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
  updateTheme(theme: Theme | null): void {
    if (!theme) return;
    const next = Object.assign(new Theme(), theme);
    this.theme.merge(next);
    for (const p of this.runtime.panes) p.terminal.applyTheme(this.theme);
    this.dirty = true;
  }
  async execute(command: protocol.CommandInput): Promise<protocol.Result> {
    importer.admit(this, "session.command");
    const result = await session.execute(
      this.runtime,
      { socket: this.socket, executable: this.executable, theme: this.theme },
      protocol.decodeCommand(command),
    );
    this.bindPanes();
    this.dirty = true;
    await this.saveWorkspaces();
    return { ...protocol.emptyResult(), ...result };
  }
  private bindPanes(): void {
    for (const pane of this.runtime.panes)
      if (!this.watched.has(pane.terminal)) {
        this.watched.add(pane.terminal);
        pane.terminal.on("change", () => {
          this.runtime.wrote();
          this.dirty = true;
          this.wakeViewers();
        });
        pane.terminal.on("ioError", error => console.error("terminal:", error));
      }
  }
  private wakeSeq(id: number): bigint {
    let seq = this.runtime.shown + this.bell_seq;
    for (const c of this.clients)
      if (c.viewer && c.viewer_id === id) {
        seq += c.next_control;
        for (const interest of c.interests) {
          const p = this.runtime.pane(interest.pane);
          if (p) seq += p.displayed().surface_revision;
        }
      }
    return BigInt.asUintN(64, seq);
  }
  private wakeViewer(c: Client): void {
    if (!c.watching || c.dead || c.output.length > 0) return;
    const next = this.wakeSeq(c.watch_viewer);
    if (c.woken !== next) {
      c.woken = next;
      c.queue({ type: "viewer.wake" });
    }
  }
  private wakeViewers(): void {
    for (const c of this.clients) this.wakeViewer(c);
  }
  private publish(): void {
    const telemetry_started = telemetry.begin();
    try {
      if (this.subscribedRevision === this.runtime.revision && !this.dirty) return;
      if (this.subscribedRevision !== this.runtime.revision) {
        const subscribers = this.clients.filter(c => c.subscribed && !c.dead);
        if (subscribers.length) {
          const snapshot = session.snapshot(this.runtime);
          for (const c of subscribers) c.queue(snapshot);
        } else {
          // A snapshot settles agent order and launch accounts; without one, settle them here.
          if (this.runtime.raiseEntered()) this.runtime.changed();
          for (const pane of this.runtime.panes) pane.account();
        }
        this.subscribedRevision = this.runtime.revision;
      }
      this.wakeViewers();
      this.dirty = false;
    } finally {
      telemetry.end("daemon.publish", telemetry_started);
    }
  }
  async run(): Promise<void> {
    this.runtime.ports.configure(settings.smartLinks(settings.path(this.socket)));
    try {
      let selected: number | null = null;
      const handoff = this.listener >= 0;
      if (!handoff) {
        if (await recovery.load(this.runtime, this.socket, this.executable)) {
          const preferences = new Store();
          try {
            selected = await preferences.load(Store.statePath(this.socket));
          } catch (error) {
            console.error("workspace load:", error);
          }
        } else
          try {
            selected = await this.runtime.workspaces.load(Store.statePath(this.socket));
          } catch (error) {
            console.error("workspace load:", error);
          }
        // Only a starter made now waits for the first viewer's folder and name.
        this.default_folder_pending = !this.runtime.workspaces.items.length;
        if (this.default_folder_pending) await this.runtime.workspaces.add("", process.cwd());
        this.preferred_workspace = selected ?? this.runtime.workspaces.items[0].id;
        this.listener = listen(this.socket);
        chmodSync(this.socket, 0o600);
        this.socketPath = SocketPath.claim(this.socket);
      } else this.socketPath = SocketPath.claim(this.socket);
      // A handoff to a newer Corgi may hook more events than the old one did.
      await integration.startup(handoff);
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
      this.runtime.destroy();
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
      const now = performance.now();
      if (now - this.collected < 250 && !this.urgent()) return;
      this.collected = now;
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
  /** Whether the next collect can't wait for the idle cadence. */
  private urgent(): boolean {
    return (
      this.dirty ||
      this.bell ||
      this.runtime.renames.length > 0 ||
      this.runtime.wanted_names.length > 0 ||
      this.clients.some(c => c.headless_start !== null || launch.due(this, c)) ||
      this.runtime.panes.some(p => p.terminal.due() || p.ghost !== null) ||
      this.runtime.sessions.some(s => !s.exited)
    );
  }
  pause(): void {
    this.frozen = true;
    clearInterval(this.timer);
    this.registration?.close();
    this.registration = undefined;
    for (const c of this.clients) c.pause();
    // Queue cancellation before handoff captures output; paused clients keep later input queued.
    for (const cancel of this.modelReads.values()) cancel();
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
  addClient(fd: number, start = true): Client {
    const client = new Client(
      fd,
      this.loop,
      cl => {
        // A hook sender may close as soon as it has written, as `corgi hook`
        // does; the event it sent still applies. Other requests die with their client.
        this.enqueue(async () => {
          if (cl.dead && cl.pending[0]?.op !== "hook") return;
          const v = cl.take();
          let deferred = false;
          let reply = new Reply(cl);
          try {
            reply = new Reply(cl, protocol.requestId(v));
            deferred = (await this.request(cl, v, reply)) === "deferred";
          } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            // An invalid id is echoed as sent, so its client can still match the error.
            if (reply.id === null && v && typeof v === "object" && Object.hasOwn(v, "request_id"))
              cl.queue({ err, request_id: v.request_id });
            else reply.send({ err });
          } finally {
            if (!deferred && !cl.headless_start && !cl.held) cl.done();
          }
          this.publish();
        });
      },
      () => {
        this.modelReads.get(client)?.();
        if (client.headless_start) {
          const session = this.runtime.sessions.find(s => s.id === client.headless_start!.id);
          if (session && !session.session) {
            session.destroy();
            this.runtime.sessions.splice(this.runtime.sessions.indexOf(session), 1);
            this.runtime.changed();
          }
          client.headless_start = null;
        }
        this.clients = this.clients.filter(c => !c.dead);
        this.dirty = true;
        void viewer.resize(this);
      },
      start,
      cl => this.wakeViewer(cl),
    );
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
    const telemetry_started = telemetry.begin();
    try {
      await this.collectNow();
    } finally {
      telemetry.end("daemon.collect", telemetry_started);
    }
  }
  private async collectNow(): Promise<void> {
    if (this.owner && Date.now() - this.ownerChecked >= 1000) {
      this.ownerChecked = Date.now();
      if (!running(this.owner)) {
        void this.shutdown();
        return;
      }
    }
    const import_started = telemetry.begin();
    await importer.tick(this);
    telemetry.end("daemon.import", import_started);
    const now = Date.now();
    for (const p of [...this.runtime.panes]) {
      // Panes read their output as it comes; the tick follows up on a pane
      // that printed, and keeps time for one waiting on more than output.
      if (p.terminal.due()) {
        if (p.terminal.maintain()) {
          const copied = p.terminal.takeCopied();
          if (copied !== null) viewer.copy(this, p.id, copied);
          const cwd = p.cwd;
          p.refreshCwd();
          // Viewers inherit a pane's folder for new tabs, so a `cd` wakes them.
          if (p.cwd !== cwd) {
            this.runtime.changed();
            this.dirty = true;
          }
        }
        if (p.terminal.redrawing) p.terminal.refreshRedraw(now);
      }
      if (p.watchGhost(now)) this.runtime.changed();
      if (p.failed()) {
        if (p.keepFailed()) this.dirty = true;
      } else if (p.terminal.exited && !p.dormant) this.runtime.close(p.id);
    }
    this.runtime.reapStopped();
    if (this.runtime.raiseEntered()) this.runtime.changed();
    await this.runtime.advanceRenames(clock.milliTimestamp());
    const observers_started = telemetry.begin();
    await observers.tick(this);
    telemetry.end("daemon.observers", observers_started);
    if (this.clients.some(c => c.headless_start)) {
      const headless = await import("./headless");
      headless.finishStarts(this);
    }
    const trackers_started = telemetry.begin();
    const gitStatusChanged = this.runtime.git_status.tick(this.runtime.workspaces);
    const gitPushChanged = this.runtime.git_push.tick(this.runtime.workspaces, this.runtime.git_status);
    const portsChanged = this.runtime.ports.tick(this.runtime);
    let tracked = gitStatusChanged || gitPushChanged || portsChanged;
    const viewers = this.clients.filter(c => c.viewer && !c.dead);
    const overviews = new Set(
      viewers.filter(c => c.watched && c.worktree_detail !== null).map(c => c.worktree_detail!),
    );
    tracked = this.runtime.worktree_tracker.tick(this.runtime, overviews) || tracked;
    const inference = this.runtime.inference;
    tracked =
      this.runtime.worktree_briefs.tick(this.runtime, overviews, {
        enabled: (this.summaries?.uses.worktrees ?? false) && !!inference?.model,
        provider: inference?.provider ?? null,
        model: inference?.model ?? "",
        account: inference?.account ?? "",
        file: settings.path(this.socket),
      }) || tracked;
    if (viewers.length) this.resource_readings = viewers.some(c => c.resources);
    if (this.resource_readings && (viewers.length || this.runtime.panes.length || this.runtime.sessions.length))
      tracked =
        this.runtime.resources.tick(
          this.runtime,
          viewers.some(c => c.watched && c.resource_detail !== null),
        ) || tracked;
    else tracked = this.runtime.resources.stop() || tracked;
    telemetry.end("daemon.trackers.schedule", trackers_started);
    if (tracked) this.runtime.refreshed();
    this.flushBell(now);
    launch.sample(this);
    for (const c of this.clients) launch.publish(this, c);
    if (this.savedDurable !== this.runtime.durable) {
      if (!this.durableAt) this.durableAt = now;
      if (now - this.durableAt >= 2000 || now - this.lastRecovery >= 10000) {
        const recovery_started = telemetry.begin();
        await recovery.save(this.runtime, this.socket);
        telemetry.end("daemon.recovery", recovery_started);
        this.savedDurable = this.runtime.durable;
        this.lastRecovery = now;
        this.durableAt = 0;
      }
    }
    this.publish();
  }
  async request(
    cl: Client,
    value: unknown,
    reply = new Reply(cl, protocol.requestId(value)),
  ): Promise<void | "deferred"> {
    const op = protocol.parse(value);
    if (!op) throw Error("UnknownOperation");
    const v = json.object(value);
    if (!testBuild && (op === "test.advance" || op === "test.settle")) throw Error("UnknownOperation");
    const check = protocol.check(op);
    if (check === "viewer" && v.viewer_protocol !== protocol.viewer_version) {
      reply.send({ err: "UnsupportedViewerProtocol", viewer_protocol: protocol.viewer_version });
      return;
    }
    if (check === "management") protocol.require(v, null, "management");
    else if (check !== "none") protocol.require(v, cl.protocol_version);
    const request = protocol.decoded(op, v);
    if (!["onboarding.copy", "onboarding.handoff"].includes(op)) importer.admit(this, op);
    switch (request.op) {
      case "hello":
        cl.protocol_version = v.runtime_protocol === protocol.version ? protocol.version : null;
        reply.send({
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
        reply.send({ ok: true, pid: process.pid });
        return;
      case "shutdown":
        reply.send({ ok: true });
        setTimeout(() => void this.shutdown(), 0);
        return;
      case "session.command":
        reply.ok({ result: await this.execute(request.payload.command) });
        return;
      case "session.locate":
        reply.ok({
          result: { ...protocol.emptyResult(), ...session.location(this.runtime, request.payload.pane) },
        });
        return;
      case "launcher.catalog":
        reply.ok({ agents: launcherConfig.catalog(this.runtime) });
        return;
      case "launcher.models": {
        const agent = launcherConfig.get(this.runtime, request.payload.row);
        if (!agent.provider) throw Error("CustomCommandOptions");
        const quit = new ModelQuit();
        let settled = false;
        const finish = (result: { ok: true; models: agentModels.Choice[] } | { err: string }) => {
          if (settled) return;
          settled = true;
          this.modelReads.delete(cl);
          clearTimeout(timeout);
          quit.signal();
          reply.send(result);
          cl.done();
        };
        const timeout = setTimeout(() => finish({ err: "TimedOut" }), 15000);
        this.modelReads.set(cl, () => finish({ err: "Cancelled" }));
        void agentModels.read(agent.provider, agent.account, quit).then(
          models => finish({ ok: true, models }),
          error => finish({ err: error instanceof Error ? error.message : String(error) }),
        );
        return "deferred";
      }
      case "session.list":
        reply.send({ ok: true, result: session.snapshot(this.runtime), viewers: viewer.viewers(this) });
        return;
      case "session.snapshot":
        reply.send(session.snapshot(this.runtime));
        return;
      case "session.subscribe":
        if (cl.viewer || cl.launch_preview || cl.watching) throw Error("AlreadyAttached");
        cl.subscribed = true;
        reply.send(session.snapshot(this.runtime));
        return;
      case "viewer.open":
        await viewer.open(this, cl, request.payload, reply);
        return;
      case "viewer.sync":
        await viewer.sync(this, cl, request.payload, reply);
        return;
      case "viewer.surfaces":
        viewer.surfaces(this, cl, reply);
        return;
      case "viewer.search":
        await viewer.search(this, cl, request.payload, reply);
        return;
      case "viewer.pick":
        await viewer.pick(this, cl, request.payload, reply);
        return;
      case "viewer.image":
        viewer.image(this, cl, request.payload, reply);
        return;
      case "viewer.watch":
        if (cl.viewer || cl.subscribed || cl.launch_preview) throw Error("AlreadyAttached");
        viewer.targetViewer(this, request.payload.viewer);
        cl.watching = true;
        cl.watch_viewer = request.payload.viewer;
        cl.woken = this.wakeSeq(request.payload.viewer);
        reply.send({ ok: true });
        return;
      case "viewer.list":
        reply.send({ ok: true, viewers: viewer.viewers(this) });
        return;
      case "pane.acknowledge":
        viewer.acknowledge(this, cl, request.payload, reply);
        return;
      case "pane.mark_unread":
        viewer.markUnread(this, cl, request.payload, reply);
        return;
      case "pane.paste":
        await viewer.paste(this, cl, request.payload, reply);
        return;
      case "pane.idle":
        reply.ok({ panes: await session.idle(this.runtime, request.payload) });
        return;
      case "pane.agent":
        observers.claimPane(this, request.payload);
        reply.ok({});
        return;
      case "action":
        await viewer.action(this, cl, request.payload, reply);
        return;
      case "focus":
        viewer.focus(this, cl, request.payload, reply);
        return;
      case "workspace.switch":
        viewer.switchWorkspace(this, cl, request.payload, reply);
        return;
      case "conversation.list":
        reply.send({ ok: true, conversations: session.snapshot(this.runtime).conversations });
        return;
      case "conversation.acknowledge": {
        const actor = this.runtime.conversations.byId(request.payload.conversation);
        if (!actor) throw Error("NoConversation");
        actor.acknowledge(request.payload.through, request.payload.attention_at ?? null);
        this.runtime.changed();
        reply.send({ ok: true });
        return;
      }
      case "pane.surface": {
        const p = this.runtime.pane(request.payload.pane);
        if (!p) throw Error("NoPane");
        reply.send({
          type: "surface",
          protocol: protocol.version,
          server_pid: process.pid,
          revision: this.runtime.revision,
          surface: p.terminal.surface(p.id).surface,
        });
        return;
      }
      case "theme":
        this.updateTheme(request.payload.theme);
        reply.send({ ok: true });
        return;
      case "viewer.terminal":
        cl.terminal = request.payload.terminal;
        reply.send({ ok: true });
        return;
      case "bugreport": {
        const now = clock.microTimestamp();
        reply.send({
          ok: true,
          pid: process.pid,
          uptime_ms: Date.now() - this.started_at,
          viewers: this.clients
            .filter(c => c.viewer && !c.dead)
            .sort((a, b) => b.input_at - a.input_at)
            .map(c => ({ id: c.viewer_id, terminal: c.terminal })),
          hooks: Object.fromEntries(
            this.runtime.conversations.items
              .filter((a: any) => a.hooked_at > 0)
              .map((a: any) => [String(a.id), Math.max(0, Math.round((now - a.hooked_at) / 1000))]),
          ),
        });
        return;
      }
      case "hook":
        await observers.hook(this, request.payload);
        reply.send({ ok: true });
        return;
      case "test.advance": {
        const ms = Number(request.payload.ms);
        if (!Number.isSafeInteger(ms)) throw Error("Overflow");
        clock.advance(ms);
        observers.poke(this);
        reply.send({ ok: true });
        return;
      }
      case "test.settle":
        await observers.settle(this);
        await trackers.settle(this.runtime, () => this.collect());
        reply.send({ ok: true });
        return;
      case "server.reload": {
        if (!isAbsolute(request.payload.executable ?? "")) throw Error("InvalidExecutable");
        const busy = [...this.deferred.values()].find(d => d.busy)?.busy;
        if (busy) {
          reply.send({ err: "ReloadBusy", busy });
          return;
        }
        for (const d of this.deferred.values()) d.drop();
        const handoff = await import("./persist/handoff");
        await handoff.replace(this, cl, request.payload.executable, reply.id);
        return;
      }
      case "recovery.save": {
        const recovery = await import("./persist/recovery");
        await recovery.save(this.runtime, this.socket);
        reply.send({ ok: true, path: recovery.path(this.socket) });
        return;
      }
      case "headless.start":
      case "headless.list":
      case "headless.stop":
      case "headless.send":
      case "headless.events": {
        const headless = await import("./headless");
        await headless.request(this, cl, request, reply);
        return;
      }
      case "agent.command.preview":
        await launch.request(this, cl, request, reply);
        return;
      case "agent.preview":
      case "agent.track_usage":
      case "agent.subscribe":
      case "agent.history": {
        const launch = await import("./launch_service");
        await launch.request(this, cl, request, reply);
        return;
      }
      case "inference.configure": {
        const inference = await import("./inference_service");
        await inference.configure(this, cl, request.payload, reply);
        return;
      }
      case "shell.configure": {
        const shell = request.payload.shell.trim();
        if (shell && launch_command.locate(shell) === null) throw Error("ShellNotFound");
        settings.update(settings.path(this.socket), { shell: shell || undefined });
        this.runtime.changed();
        this.dirty = true;
        reply.ok({ shell: launch_command.shellStatus() });
        return;
      }
      case "smart_links.configure": {
        settings.update(settings.path(this.socket), { smart_links: request.payload.enabled });
        this.runtime.ports.configure(request.payload.enabled);
        this.runtime.changed();
        this.dirty = true;
        reply.ok({ smart_links: request.payload.enabled });
        return;
      }
      case "git.push": {
        const git = await import("./trackers/git_push");
        await git.start(this.runtime, request.payload.workspace, request.payload.ref);
        this.runtime.changed();
        this.dirty = true;
        reply.send({ ok: true });
        return;
      }
      case "worktree.remove": {
        const removal = await this.runtime.worktree_tracker.remove(
          this.runtime,
          request.payload.workspace,
          request.payload.path,
          request.payload.locked,
        );
        this.runtime.changed();
        this.dirty = true;
        reply.send({ ok: true, removal });
        return;
      }
      case "worktree.stop":
        this.runtime.worktree_tracker.stopRemoval(request.payload.workspace);
        reply.send({ ok: true });
        return;
      case "process.signal": {
        const { workspace, pid, start, signal } = request.payload;
        trackers.resources.signal(this.runtime.resources.current, workspace, pid, start, signal);
        this.runtime.resources.next_refresh = 0;
        reply.send({ ok: true });
        return;
      }
      case "worktree.brief":
        this.runtime.worktree_briefs.refresh(this.runtime, request.payload.workspace);
        this.runtime.refreshed();
        reply.send({ ok: true });
        return;
      case "git.branches":
        this.defer(cl, reply, null, async () => ({
          branches: await worktreeAdd.branches(this.runtime, request.payload.workspace),
        }));
        return;
      case "worktree.add":
        this.defer(cl, reply, { op: "worktree.add", path: request.payload.path }, async () => {
          await worktreeAdd.add(
            this.runtime,
            request.payload.workspace,
            request.payload.path,
            request.payload.branch,
            request.payload.base,
          );
          this.runtime.changed();
          this.dirty = true;
          return {};
        });
        return;
      case "onboarding.status":
      case "onboarding.handoff":
      case "onboarding.copy": {
        const importer = await import("./import");
        await importer.request(this, cl, request, reply);
        return;
      }
    }
  }
  /** Replies once `work` finishes, letting the client's later requests run
   * meanwhile. A request without an id holds them, so its replies stay in order.
   * Reload refuses while `busy` work runs, saying which, and answers the rest with `Reloading`. */
  private defer(cl: Client, reply: Reply, busy: protocol.Busy | null, work: () => Promise<object>): void {
    let held = reply.id === null;
    cl.held ||= held;
    const release = () => {
      if (!held) return;
      held = false;
      cl.held = false;
      cl.done();
    };
    let answered = false;
    const answer = (value: object) => {
      if (answered) return;
      answered = true;
      reply.send(value);
    };
    const pending = work().then(
      value => answer({ ok: true, ...value }),
      error => answer({ err: error instanceof Error ? error.message : String(error) }),
    );
    this.deferred.set(pending, {
      busy,
      drop: () => {
        answer({ err: "Reloading" });
        release();
      },
    });
    void pending
      .catch(error => console.error("deferred reply:", error))
      .finally(() => {
        this.deferred.delete(pending);
        release();
      });
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
    await launch.stop(this);
    observers.stop(this);
    importer.stop(this);
    for (const cl of [...this.clients]) cl.close();
    if (this.listener >= 0) n.probe_close(this.listener);
    this.listener = -1;
    this.runtime.destroy();
    this.loop.close();
    closeReadiness();
    this.socketPath?.release();
  }
}
