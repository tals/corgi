import * as startup from "./startup_service";
import * as archiveInventory from "./archive_inventory";
import * as launcherConfig from "./launcher_config";
import { Provider } from "./providers";
import * as discovery from "./discovery";
import * as agentModels from "./agent_models";
import { Quit as ModelQuit } from "./subprocess";
import * as telemetry from "./telemetry";
import * as wire_websocket from "./wire_websocket";
import type { Worker as SummaryWorker } from "./activity/worker";
import type { Worker as UsageWorker } from "./usage/worker";
import { existsSync, readFileSync, renameSync, rmSync, watch, type FSWatcher } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { Runtime } from "./runtime";
import * as agentEffort from "./agent_effort";
import { Store, Workspace } from "./workspace";
import { Client, Reply, type Transport } from "./peer";
import { ReadyLoop } from "./native_bridge";
import { closeReadiness } from "./pane/terminal";
import { Theme } from "./theme";
import * as protocol from "./protocol";
import * as session from "./session";
import * as viewer from "./viewer_protocol";
import * as clock from "./clock";
import { SocketPath, listen as bindSocket, running } from "./os";
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
import * as agentRetry from "./agent_retry";
import * as link from "./link";
import * as socket_server from "./socket_server";
import * as legacy_socket from "./legacy_socket";
import * as start_lock from "./start_lock";
export class Server {
  readonly instance = crypto.randomUUID();
  summaries: SummaryWorker | null = null;
  usage: UsageWorker | null = null;
  runtime = new Runtime();
  clients: Client[] = [];
  /** Links by id, carried by a connection or waiting for one to resume them. */
  links = new Map<string, link.Link>();
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
  /** Started by a handoff, with the old daemon's state. */
  imported = false;
  /** A handoff committed: the candidate owns the session, and this process only lets go. */
  handed_off = false;
  /** Called once the daemon answers on its socket. */
  listened: (() => void) | null = null;
  /** The start lock a handoff passed on, let go once this daemon listens. */
  start_lock = -1;
  /** XXX: Remove for next protocol bump. The listener a JSON-lines daemon handed over. */
  older_listener = -1;
  /** XXX: Remove for next protocol bump. An older build's updater checks this
   * daemon in with JSON lines before it names this release current. */
  older_updater = false;
  private legacy: legacy_socket.Listener | null = null;
  /** XXX: Remove for next protocol bump. Connections in JSON lines: older builds. */
  private older_clients = new WeakSet<Client>();
  /** XXX: Remove for next protocol bump. Ends the older updater's window now. */
  private endOlderWindow: (() => void) | null = null;
  /** Settles once Bun's server has the socket. */
  private swapped: Promise<void> = Promise.resolve();
  /** After a reload commits, where each HTTP request goes. */
  relay: ((client: Client) => void) | null = null;
  /** After a reload commits, told of each client that goes away. */
  closing: ((client: Client) => void) | null = null;
  private socketPath: SocketPath | null = null;
  private listening: socket_server.Server | null = null;
  private bound: socket_server.Bound | null = null;
  private loop = new ReadyLoop();
  private jobs: Promise<void> = Promise.resolve();
  private modelReads = new Map<Client, () => void>();
  /** Deferred replies, each with whether it changes state and how to answer it early. */
  private deferred = new Map<Promise<void>, { busy: protocol.Busy | null; drop: () => void }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private subscribedRevision = -1n;
  private subscribedShown = -1n;
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
  /** The installation this daemon runs from, once looked up; deleting it uninstalls Corgi. */
  private install: string | null | undefined;
  private installChecked = 0;
  private uninstalling = false;
  /** The folder holding the Omarchy plugin that installed this Corgi, watched
   * so that removing the plugin removes Corgi too. */
  private pluginWatch: FSWatcher | null = null;
  constructor(
    readonly socket: string,
    readonly executable: string,
    readonly build_id: string,
  ) {}
  /** The active workspace a viewer opens on, or null when none remain. */
  initialWorkspace(): Workspace | null {
    const preferred = this.runtime.workspaces.get(this.preferred_workspace);
    return preferred && !preferred.archived
      ? preferred
      : (this.runtime.workspaces.items.find(w => !w.archived) ?? null);
  }
  onlyWorkspace() {
    if (this.runtime.workspaces.items.length !== 1) throw Error("MissingWorkspace");
    return this.runtime.workspaces.items[0];
  }
  saveWorkspaces(): Promise<void> {
    this.workspaceWrites = this.workspaceWrites.then(async () => {
      try {
        await this.runtime.workspaces.save(
          Store.statePath(this.socket),
          this.initialWorkspace()?.id ?? Workspace.Id.none,
        );
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
        this.runtime.sessions.some(session => !session.corgi && session.attention() === "finished");
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
  /** Runs an `agent.message` beside the job queue: a provider's channel can
   * take seconds to answer, and the queue keeps every viewer going. */
  async message(command: protocol.CommandInput): Promise<protocol.Result> {
    const result = await session.execute(this.runtime, this.context(), protocol.decodeCommand(command));
    return { ...protocol.emptyResult(), ...result };
  }
  private context() {
    return { socket: this.socket, executable: this.executable, theme: this.theme };
  }
  async execute(command: protocol.CommandInput): Promise<protocol.Result> {
    importer.admit(this, "session.command");
    const lifecycle =
      "pane.hibernate" in command ||
      "workspace.archive" in command ||
      "workspace.unarchive" in command ||
      "pane.wake" in command;
    if (lifecycle) await recovery.save(this.runtime, this.socket);
    const result = await session.execute(this.runtime, this.context(), protocol.decodeCommand(command));
    this.bindPanes();
    this.dirty = true;
    await this.saveWorkspaces();
    if (lifecycle) await recovery.save(this.runtime, this.socket);
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
  wakeSeq(id: number): bigint {
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
    if (!c.watching || c.stream_data || c.dead || c.queued > 0) return;
    const next = this.wakeSeq(c.watch_viewer);
    if (c.woken !== next) {
      c.woken = next;
      c.queue({ type: "viewer.wake" });
    }
  }
  private wakeViewers(): void {
    for (const c of this.clients) if (c.stream) viewer.publish(this, c, this.wakeSeq(c.viewer_id));
    for (const c of this.clients) this.wakeViewer(c);
  }
  /** Sends what changed; whether it woke the viewers. */
  private publish(): boolean {
    const telemetry_started = telemetry.begin();
    try {
      if (this.subscribedRevision === this.runtime.revision && !this.dirty) return false;
      if (this.subscribedRevision !== this.runtime.revision) {
        const shown = this.subscribedShown !== this.runtime.shown,
          subscribers = this.clients.filter(c => c.subscribed && !c.dead && (shown || c.subscribed_output));
        if (subscribers.length) {
          const snapshot = session.snapshot(this.runtime);
          for (const c of subscribers) c.queue(snapshot);
        } else {
          // A snapshot settles agent order and launch accounts; without one, settle them here.
          if (this.runtime.raiseEntered()) this.runtime.changed();
          for (const pane of this.runtime.panes) pane.account();
        }
        this.subscribedRevision = this.runtime.revision;
        this.subscribedShown = this.runtime.shown;
      }
      this.wakeViewers();
      this.dirty = false;
      return true;
    } finally {
      telemetry.end("daemon.publish", telemetry_started);
    }
  }
  /** When someone last worked in `pane`, in ms: input it sent its program,
   * from a viewer, `corgi pane send` or Corgi itself, or input from a viewer
   * focused on it, such as the mouse; 0 if none did. */
  inputAt(pane: number) {
    let at = this.runtime.pane(pane)?.terminal.sent_at ?? 0;
    for (const c of this.clients) if (c.viewer && !c.dead && c.view_focus === pane) at = Math.max(at, c.input_at);
    return at;
  }
  async run(): Promise<void> {
    this.runtime.ports.configure(settings.smartLinks(settings.path(this.socket)));
    this.runtime.auto_retry = settings.autoRetry(settings.path(this.socket));
    try {
      let selected: number | null = null;
      const handoff = this.imported;
      if (!handoff) {
        // Saved state with every workspace closed stays that way.
        let saved = false;
        if (await recovery.load(this.runtime, this.socket, this.executable)) {
          saved = true;
          const preferences = new Store();
          try {
            selected = await preferences.load(Store.statePath(this.socket));
          } catch (error) {
            console.error("workspace load:", error);
          }
        } else
          try {
            selected = await this.runtime.workspaces.load(Store.statePath(this.socket));
            saved = selected !== null;
          } catch (error) {
            console.error("workspace load:", error);
          }
        // Only a starter made now waits for the first viewer's folder and name.
        this.default_folder_pending = !saved && !this.runtime.workspaces.items.length;
        if (this.default_folder_pending) await this.runtime.workspaces.add("", process.cwd());
        this.preferred_workspace = selected ?? this.runtime.workspaces.items[0]?.id ?? Workspace.Id.none;
      }
      // Setup asks which agents are there, so mise answers for its shims first.
      await discovery.ready();
      // A handoff to a newer Corgi may hook more events than the old one did.
      await integration.startup(handoff);
      this.bindPanes();
      observers.start(this);
      for (const p of this.runtime.panes) if (p.terminal.imported) p.terminal.adopt(p.terminal.fd, p.terminal.pid);
      // Before anyone can connect, so a plugin removed after the daemon answers is seen.
      this.watchInstall();
      this.listen();
      this.startLoop();
      process.on("SIGTERM", () => void this.shutdown());
      process.on("SIGINT", () => void this.shutdown());
      await this.saveWorkspaces();
    } catch (error) {
      clearInterval(this.timer);
      for (const c of [...this.clients]) c.close();
      void this.listening?.stop(true);
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
  /** `older`: its connections speak JSON lines. */
  private accept(older = false): socket_server.Accept {
    // Connections stay open, so they're few; HTTP requests come and go.
    const count = (http: boolean) => this.clients.reduce((n, c) => n + (c.http === http ? 1 : 0), 0);
    return {
      connection: transport => {
        if (count(false) >= 32) return null;
        const client = this.addClient(transport, this.accepting);
        if (older) this.older_clients.add(client);
        return client;
      },
      request: (value, respond) => {
        if (count(true) >= 256) return null;
        const client = this.addClient(null, this.accepting, respond);
        client.request(value);
        this.relay?.(client);
        return client;
      },
    };
  }
  private listen(): void {
    // XXX: Remove for next protocol bump. Until an older build's updater has
    // made this release current, or the install moved on, a listener that also
    // speaks JSON lines answers: the one an older daemon handed over, or one
    // bound for it. An older build's reload that no updater holds the
    // install's activation lock for, such as `corgi reload`, has no update to
    // finish; nor does one into a build no install manages.
    const older = this.older_updater && updates.activating(this.executable);
    if (older && this.older_listener < 0) this.older_listener = bindOlder(this.socket);
    if (this.older_listener >= 0) {
      this.legacy = new legacy_socket.Listener(
        this.older_listener,
        this.loop,
        this.accept(true),
        () => this.endOlderWindow !== null,
      );
      this.older_listener = -1;
      this.socketPath = SocketPath.claim(this.socket);
    }
    if (this.legacy && older) {
      // It answers; a new client's `hello` hears the update isn't done.
      this.releaseStartLock();
      const ended = new Promise<void>(resolve => (this.endOlderWindow = resolve));
      this.listened?.();
      this.swapped = Promise.race([updated(this.executable, () => this.stopped), ended])
        .catch(error => console.error("warning: older updater window:", error))
        .then(() => this.serve());
      return;
    }
    this.serve();
    this.listened?.();
  }
  /** Bun's server takes the socket, and anyone waiting on the start lock goes on. */
  private serve(): void {
    this.endOlderWindow = null;
    // A daemon that handed off has no socket to take: the candidate has it.
    if (this.stopped || this.handed_off) return;
    try {
      const bound = this.bound ?? socket_server.bind(this.socket, this.accept());
      this.bound = null;
      this.listening = bound.publish();
      this.legacy?.close();
      this.legacy = null;
      this.socketPath = SocketPath.claim(this.socket);
    } catch (error) {
      // Without an older listener to keep answering, the daemon can't run.
      if (!this.legacy) throw error;
      // It keeps answering HTTP; WebSockets can't connect.
      console.error("error: socket:", error);
    }
    this.releaseStartLock();
    resumeHooks(this.socket);
  }
  /** Lets anyone waiting on the start lock go on, after long enough for a
   * sender whose connection a swap reset to see it held. */
  private releaseStartLock(): void {
    const lock = this.start_lock;
    this.start_lock = -1;
    if (lock >= 0) setTimeout(() => start_lock.release(lock), 100);
  }
  /** Binds Bun's server beside the socket ahead of listening, so a reload
   * that can't bind fails before it commits. */
  bind(): void {
    this.bound = socket_server.bind(this.socket, this.accept());
  }
  /** XXX: Remove for next protocol bump. Whether `client` is an older build,
   * which checks a daemon it reloads in with JSON lines. */
  older(client: Client): boolean {
    return this.older_clients.has(client);
  }
  /** Lets go of a server bound for a reload that didn't commit. */
  unbind(): void {
    this.bound?.abandon();
    this.bound = null;
  }
  /** Stops taking connections; open ones carry on. */
  stopListening(): void {
    void this.listening?.stop();
    // XXX: Remove for next protocol bump. An older build's reload left its window open.
    this.legacy?.close();
    this.legacy = null;
    this.unbind();
  }
  /** Ends an older updater's window, if one is open, and settles once
   * Bun's server has the socket, as a reload waits for. */
  serving(): Promise<void> {
    this.endOlderWindow?.();
    return this.swapped;
  }
  /** Whether a reply or a closing connection hasn't left yet. */
  answering(): boolean {
    return (this.listening?.pendingRequests ?? 0) > 0 || (this.listening?.pendingWebSockets ?? 0) > 0;
  }
  private startLoop(): void {
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
      this.runtime.sessions.some(s => s.urgent())
    );
  }
  /** Whether a new request starts at once: not while a reload gets ready. */
  private get accepting(): boolean {
    return !this.frozen && !this.holding;
  }
  private holding = false;
  /** Holds requests that haven't started while a reload gets ready, so the
   * new daemon gets them; a reload that doesn't happen lets them go. */
  hold(): void {
    this.holding = true;
    for (const c of this.clients) c.pause();
  }
  /** Lets held requests go, when a reload stopped before it paused. */
  release(): void {
    this.holding = false;
    if (!this.frozen) for (const c of this.clients) c.resume();
  }
  /** Holds every request, for a handoff: connections stay open and queue them. */
  pause(): void {
    this.frozen = true;
    clearInterval(this.timer);
    for (const c of this.clients) c.pause();
    // Queue cancellation before handoff captures output.
    for (const cancel of this.modelReads.values()) cancel();
    for (const p of this.runtime.panes) p.terminal.pause();
    for (const s of this.runtime.sessions) s.pause();
  }
  resume(): void {
    this.frozen = false;
    this.holding = false;
    for (const c of this.clients) c.resume();
    for (const p of this.runtime.panes) p.terminal.resume();
    for (const s of this.runtime.sessions) s.resume();
    this.startLoop();
  }
  /** A client on `transport`, or with `respond` for one HTTP request; neither
   * for one with no connection. */
  addClient(transport: Transport | null, start = true, respond: ((value: unknown) => void) | null = null): Client {
    const client: Client = new Client(
      transport,
      cl => {
        // A hook sender may close as soon as it has written, as `corgi hook`
        // does; the event it sent still applies. Other requests die with their
        // client; a numbered one comes again over the link once it's resumed.
        this.enqueue(async () => {
          if (cl.dead && cl.pending[0]?.op !== "hook") return;
          const v = cl.take();
          let deferred = false;
          let reply = new Reply(cl);
          try {
            reply = new Reply(cl, protocol.requestId(v));
            const seq = numbered(v, "seq");
            if (seq !== null && cl.link) await this.once(cl, cl.link, seq, v, reply);
            else deferred = (await this.request(cl, v, reply)) === "deferred";
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
        this.closing?.(client);
        if (this.handed_off) return;
        if (client.viewer) viewer.data(this, client)?.close();
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
        this.detachLink(client);
        this.clients = this.clients.filter(c => !c.dead);
        this.dirty = true;
        void viewer.resize(this);
      },
      start,
      cl => this.wakeViewer(cl),
      respond,
    );
    this.clients.push(client);
    return client;
  }
  private collectStartups(): void {
    startup.collect(this.runtime, this.clients);
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
    if (Date.now() - this.installChecked >= 1000) {
      this.installChecked = Date.now();
      if (this.install === undefined)
        try {
          this.install = updates.managed(updates.release(this.executable), this.executable);
        } catch {
          this.install = null;
        }
      if (this.install && !existsSync(join(this.install, "current"))) {
        void this.uninstalled(this.install);
        return;
      }
    }
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
    this.collectStartups();
    this.runtime.reapStopped();
    if (this.runtime.raiseEntered()) this.runtime.changed();
    await this.runtime.advanceRenames(clock.milliTimestamp());
    agentEffort.advance(this.runtime, clock.milliTimestamp());
    agentRetry.advance(this.runtime, clock.milliTimestamp(), pane => this.inputAt(pane));
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
    const resource_clients = this.clients.filter(c => !c.dead && (c.viewer || c.resource_observer));
    if (resource_clients.length) this.resource_readings = resource_clients.some(c => c.resources);
    if (
      this.resource_readings &&
      (resource_clients.length || this.runtime.panes.length || this.runtime.sessions.length)
    )
      tracked =
        this.runtime.resources.tick(
          this.runtime,
          viewers.some(c => c.watched && c.resource_detail !== null),
        ) || tracked;
    else tracked = this.runtime.resources.stop() || tracked;
    telemetry.end("daemon.trackers.schedule", trackers_started);
    if (tracked) this.runtime.refreshed();
    this.flushBell(now);
    const launcher_started = telemetry.begin();
    launch.sample(this);
    this.expireLinks(now);
    for (const c of this.clients) launch.publish(this, c);
    telemetry.end("daemon.launcher", launcher_started);
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
    // Streams pace their own frames, so they hear every tick.
    if (!this.publish()) this.wakeViewers();
  }
  /** Runs numbered request `seq` once. Sent again, it gets the reply it had. */
  private async once(
    cl: Client,
    carried: link.Link,
    seq: bigint,
    v: unknown,
    reply = new Reply(cl, protocol.requestId(v)),
  ): Promise<void> {
    const answered = numbered(v, "answered");
    if (answered !== null) carried.confirm(answered);
    const pending = carried.pending.get(seq);
    if (pending) {
      void pending.then(value => reply.send(value));
      return;
    }
    const admitted = carried.admit(seq);
    if (!admitted.run) return reply.send(admitted.reply as object);
    let finish!: (value: object) => void;
    const result = new Promise<object>(resolve => {
      finish = resolve;
    });
    carried.pending.set(seq, result);
    let sent = false;
    const recorded = new Reply(cl, reply.id, value => {
      if (sent) return;
      sent = true;
      carried.record(seq, value);
      carried.pending.delete(seq);
      finish(value);
      reply.send(value);
    });
    try {
      const op = protocol.parse(v);
      if (op === null || !protocol.once(op)) throw Error("UnnumberedOperation");
      await this.request(cl, v, recorded);
    } catch (error) {
      recorded.send({ err: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Keeps a closed connection's link, with the viewer it carried, for a
   * client to resume. */
  private detachLink(cl: Client): void {
    const carried = cl.link;
    if (!carried) return;
    cl.link = null;
    if (cl.viewer) carried.viewer = link.viewerOf(cl);
    carried.detached_at = Date.now();
  }
  /** Gives `cl` the link `id`, taking it from a connection that still holds
   * it, which a client resuming has given up on. */
  private resumeLink(cl: Client, id: string): boolean {
    const carried = this.links.get(id);
    if (!carried) throw Error("NoLink");
    if (cl.link || cl.viewer) throw Error("AlreadyAttached");
    for (const other of this.clients)
      if (other !== cl && other.link === carried) {
        this.detachLink(other);
        other.close();
      }
    cl.link = carried;
    carried.detached_at = null;
    const viewer = carried.viewer;
    carried.viewer = null;
    if (!viewer) return false;
    cl.viewer = true;
    cl.protocol_version = protocol.version;
    Object.assign(cl, viewer);
    return true;
  }
  /** Drops links no client came back for. */
  private expireLinks(now: number): void {
    const detached = [...this.links.values()].filter(l => l.detached_at !== null);
    detached.sort((a, b) => a.detached_at! - b.detached_at!);
    for (const [i, l] of detached.entries())
      if (now - l.detached_at! > link.grace_ms || detached.length - i > link.detached_limit) this.links.delete(l.id);
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
      case "hello": {
        const encoding = protocol.encodings.find(encoding => request.payload.accept_encoding.includes(encoding));
        if (encoding && !cl.canCompress) throw Error("InvalidEncodingNegotiation");
        const compress = encoding && v.runtime_protocol === protocol.version;
        cl.protocol_version = v.runtime_protocol === protocol.version ? protocol.version : null;
        reply.send({
          type: "hello",
          protocol: protocol.version,
          capabilities: protocol.capabilities,
          transports: protocol.transports,
          server_pid: process.pid,
          build_id: this.build_id,
          executable: this.executable,
          release_version: updates.release(this.executable).version,
          update_abi: updates.abi,
          viewer_protocol: protocol.viewer_version,
          instance: this.instance,
          ...(compress ? { content_encoding: encoding } : {}),
        });
        if (compress) cl.compress();
        return;
      }
      case "ping":
        reply.send({ ok: true, pid: process.pid });
        return;
      case "link.open": {
        if (cl.link) throw Error("AlreadyAttached");
        const opened = new link.Link();
        this.links.set(opened.id, opened);
        cl.link = opened;
        reply.ok({ link: opened.id });
        return;
      }
      case "link.resume":
        reply.ok({ link: request.payload.link, viewer: this.resumeLink(cl, request.payload.link) });
        return;
      case "shutdown":
        reply.send({ ok: true });
        setTimeout(() => void this.shutdown(), 0);
        return;
      case "session.command":
        if ("agent.message" in request.payload.command) {
          const command = request.payload.command;
          this.defer(cl, reply, null, async () => ({ result: await this.message(command) }));
          return;
        }
        reply.ok({ result: await this.execute(request.payload.command) });
        return;
      case "workspace.archive.preview":
        reply.ok({
          preview: await archiveInventory.preview(this.runtime, request.payload.target, request.payload.remote),
        });
        return;
      case "session.locate":
        reply.ok({
          result: { ...protocol.emptyResult(), ...session.location(this.runtime, request.payload.pane) },
        });
        return;
      case "launcher.catalog": {
        const q = request.payload,
          cwd = q.cwd || (q.workspace ? this.runtime.getWorkspace(q.workspace).cwd : process.cwd());
        if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
        this.defer(cl, reply, null, async () => {
          const service = launch.service(this);
          service.follow(launch.removed(this.runtime));
          service.launch_previews.preview(cwd);
          await service.launch_previews.pump();
          return { agents: launcherConfig.catalog(this.runtime, service.launch_previews.preview(cwd)) };
        });
        return;
      }
      case "launcher.models": {
        const q = request.payload,
          cwd = q.cwd || (q.workspace ? this.runtime.getWorkspace(q.workspace).cwd : process.cwd()),
          agent = launcherConfig.get(this.runtime, q.row);
        if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
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
        void agentModels.read(agent.provider, agent.account, quit, cwd).then(
          models => finish({ ok: true, models }),
          error => finish({ err: error instanceof Error ? error.message : String(error) }),
        );
        return "deferred";
      }
      case "session.list":
        reply.send({ ok: true, result: session.snapshot(this.runtime), viewers: viewer.viewers(this) });
        return;
      case "session.snapshot":
        if (request.payload.resources !== null) {
          cl.resource_observer = true;
          cl.resources = request.payload.resources;
        }
        reply.send(session.snapshot(this.runtime));
        return;
      case "session.subscribe":
        if (cl.viewer || cl.launch_preview || cl.watching) throw Error("AlreadyAttached");
        cl.subscribed = true;
        cl.subscribed_output = request.payload.output;
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
      case "viewer.stream": {
        reply.send(await viewer.start(this, cl, request.payload));
        return;
      }
      case "viewer.data":
        reply.ok({ viewer: viewer.bindData(this, cl, request.payload.link) });
        return;
      case "viewer.stream.configure":
        await viewer.configure(this, cl, request.payload);
        reply.ok({ viewer_protocol: protocol.viewer_version });
        return;
      case "viewer.receipt":
        reply.ok({ stream: viewer.receipt(this, cl, request.payload) });
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
      case "startup":
        reply.send(startup.update(this.runtime, cl, request.payload));
        return;
      case "startup.kill":
        startup.kill(this.runtime, request.payload.id);
        reply.send({ ok: true });
        return;
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
        // A start's reply waits for the provider's session; its connection can't move.
        const starting = this.clients
          .map(c => c.headless_start && this.runtime.sessions.find(s => s.id === c.headless_start!.id))
          .find(s => !!s);
        const busy =
          [...this.deferred.values()].find(d => d.busy)?.busy ??
          (starting ? ({ op: "headless.start", provider: starting.provider } as const) : undefined);
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
      case "headless.search":
      case "headless.memory": {
        const headless = await import("./headless");
        await headless.request(this, cl, request, reply);
        return;
      }
      case "agent.command.preview":
        await launch.request(this, cl, request, reply);
        return;
      case "agent.discover": {
        const launch = await import("./launch_service"),
          provider = request.payload.provider;
        // Probes take seconds; other requests don't wait on them.
        this.defer(cl, reply, null, async () => {
          await launch.discover(this, provider ? [provider] : Provider.all, request.payload.cwd || process.cwd());
          return {};
        });
        return;
      }
      case "agent.preview":
      case "agent.preview.cached":
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
      case "retry.configure": {
        settings.update(settings.path(this.socket), { auto_retry: request.payload.enabled });
        this.runtime.auto_retry = request.payload.enabled;
        if (!request.payload.enabled) this.runtime.retries = [];
        this.runtime.changed();
        this.dirty = true;
        reply.ok({ auto_retry: request.payload.enabled });
        return;
      }
      case "retry.cancel":
        agentRetry.cancel(this.runtime, request.payload.pane);
        this.runtime.changed();
        this.dirty = true;
        reply.ok();
        return;
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
  /** Its installation at `root` was deleted: viewers see the corgi leave, the
   * launcher it left goes, and the runtime stops, keeping saved sessions. */
  private watchInstall(): void {
    try {
      this.install = updates.managed(updates.release(this.executable), this.executable);
    } catch {
      this.install = null;
    }
    if (this.install) this.watchPlugin(this.install);
  }
  /** Omarchy tells a plugin nothing when it's removed, so Corgi watches the
   * plugins folder (that folder alone, which changes only as plugins come and
   * go) for the plugin that installed it to disappear. */
  private watchPlugin(root: string): void {
    const plugin = updates.pluginOf(root);
    if (plugin === null) return;
    const gone = () => !existsSync(join(plugin, "manifest.json"));
    // Removed while Corgi wasn't running: Corgi is the user's own now.
    if (gone()) {
      updates.forgetPlugin(root);
      return;
    }
    const check = () => {
      if (gone()) void this.pluginRemoved(root, plugin);
    };
    try {
      this.pluginWatch = watch(dirname(plugin), { persistent: false }, check);
      this.pluginWatch.on("error", check);
    } catch (error) {
      console.error("watching the Omarchy plugin:", error);
    }
  }
  /** Uninstalls this Corgi after the plugin that installed it: viewers say
   * goodbye, the daemon saves and stops, then the installer it kept removes
   * the rest, as its own uninstall would, keeping sessions and settings. */
  private async pluginRemoved(root: string, plugin: string): Promise<void> {
    if (this.stopped || this.uninstalling) return;
    console.error(`The Omarchy plugin at ${plugin} was removed; uninstalling Corgi.`);
    const script = join(root, "uninstall.sh"),
      bin = updates.launcherOf(root);
    await this.uninstalled(root);
    if (!existsSync(script)) return;
    // Its binary may go while it runs: Linux keeps a running file until it exits.
    spawn("bash", [script, "uninstall"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CORGI_UNINSTALLING: "1", CORGI_INSTALL_ROOT: root, CORGI_INSTALL_BIN: bin },
    }).unref();
  }
  private async uninstalled(root: string): Promise<void> {
    if (this.stopped || this.uninstalling) return;
    this.uninstalling = true;
    for (const c of this.clients) if ((c.watching || c.stream) && !c.dead) c.queue({ type: "uninstalled" });
    updates.forget(root);
    // Long enough for viewers to hear it before their connections close.
    await Bun.sleep(300);
    await this.shutdown();
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.pluginWatch?.close();
    // Nothing new connects, and the path goes so pollers see it gone; replies
    // already on their way, such as the one to `shutdown`, still leave.
    void this.listening?.stop();
    this.legacy?.close();
    this.legacy = null;
    // One bound for an older updater's window never takes the socket now.
    this.unbind();
    this.endOlderWindow?.();
    this.socketPath?.release();
    if (this.start_lock >= 0) start_lock.release(this.start_lock);
    this.start_lock = -1;
    try {
      await recovery.save(this.runtime, this.socket);
    } catch (error) {
      console.error("recovery save:", error);
    }
    await launch.stop(this);
    observers.stop(this);
    importer.stop(this);
    // A request still waiting hears why it won't be answered, and a viewer
    // that there's nothing to reconnect to, unless a reload has handed over
    // to the daemon it should follow.
    for (const cl of [...this.clients])
      if (cl.http) cl.queue({ err: "ServerShutdown" });
      else cl.close(this.handed_off ? wire_websocket.reloading : wire_websocket.shutting_down);
    const until = performance.now() + 1000;
    while (this.answering() && performance.now() < until) await Bun.sleep(5);
    void this.listening?.stop(true);
    this.runtime.destroy();
    this.loop.close();
    closeReadiness();
    this.socketPath?.release();
  }
}
/** XXX: Remove for next protocol bump. Settles once the release the install
 * `exe` belongs to names current changes, as an older updater changes it to
 * this one after it checks in, however long that takes: until then, the older
 * build the install runs can still find this one. */
async function updated(exe: string, stopped: () => boolean): Promise<void> {
  const current = updates.currentOf(exe),
    named = current?.(),
    version = updates.release(exe).version;
  while (current && named !== version && !stopped() && current() === named) await Bun.sleep(100);
}
/** Lets hooks that gave up on Corgi try again, and says in server.log if
 * they had been skipping it. hooks.backoff holds `STRIKES UNTIL_US`. */
function resumeHooks(socket: string): void {
  const backoff = join(dirname(socket), "hooks.backoff");
  let skipped = false;
  try {
    skipped = Number(readFileSync(backoff, "utf8").split(/\s+/)[1]) > 0;
  } catch {
    return;
  }
  rmSync(backoff, { force: true });
  if (!skipped) return;
  let last = "";
  try {
    last =
      readFileSync(join(dirname(socket), "hooks.log"), "utf8")
        .trimEnd()
        .split("\n")
        .at(-1) ?? "";
  } catch {}
  console.error(`warning(hooks): hooks skipped Corgi for a while; last: ${last}`);
}
/** XXX: Remove for next protocol bump. A listener on `socket` for an older updater. */
function bindOlder(socket: string): number {
  const bound = join(dirname(socket), `.o${process.pid}`);
  rmSync(bound, { force: true });
  const fd = bindSocket(bound);
  renameSync(bound, socket);
  return fd;
}
/** A request's number in `field`, when its client numbered it. */
function numbered(value: unknown, field: "seq" | "answered"): bigint | null {
  const n = value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
  if (typeof n === "bigint") return n > 0n ? n : null;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? BigInt(n) : null;
}
