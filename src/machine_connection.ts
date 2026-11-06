import { Stats } from "./connection_stats";
import type { Output } from "./composition";
import { Remote } from "./daemon_transport";
import { Controller } from "./controller";
import { Machine, type Focus } from "./machine";
import type { Transport } from "./mirror";
import { Connection } from "./rpc";
import { compatible, image, type Profile } from "./machines";
import * as viewer from "./viewer";
import * as errors from "./errors";
import type { Probe } from "./terminal_info";
import type { Host } from "./host";
import type { WorkspaceEntry } from "./sidebar";
import { Cache } from "./machine_cache";
import { Stream } from "./machine_stream";
import * as protocol from "./protocol";
import { sshViewer } from "./trackers/ports";

/** A request that must run once, waiting for its reply. It gets its number
 * the first time it's sent and keeps it when it's sent again. */
interface Numbered {
  body: object;
  seq: bigint | null;
  resolve: (reply: any) => void;
  reject: (error: Error) => void;
}
/** Requests waiting on a machine's replies, at most. */
const numbered_limit = 256;

export type Status = "connecting" | "online" | "stalled" | "offline" | "paused" | "incompatible";
export const stalled_ms = 1000;
/** How often an idle viewer's machines are stepped. */
export const quiet_ms = 500;
/** A remote machine silent this long gets a second connection beside the first. */
export const race_ms = 4000;
export class Endpoint {
  readonly stats = new Stats();
  get stallMs(): number {
    return this.profile ? this.stats.stallMs : stalled_ms;
  }
  get raceMs(): number {
    return Math.max(race_ms, this.stallMs * 2);
  }
  private healthAge(now: number): number {
    return this.stream?.age(now) ?? now - Math.max(this.task_started, this.stats.lastReceived ?? this.task_started);
  }
  status: Status = "connecting";
  error = "";
  generation = 0;
  instance = "";
  workspaces_instance = "";
  fresh = false;
  ready = false;
  input_epoch = 0;
  updated = 0;
  workspaces: WorkspaceEntry[] = [];
  /** The machine has shown a fresh screen, which the controller can draw. */
  private rendered = false;
  private displayed = false;
  private acknowledging = false;
  /** This daemon as the viewer sees it. */
  readonly machine: Machine;
  /** The view showing the machines; one is made when none is given. */
  controller: Controller | null = null;
  detached = false;
  /** The local viewer opens on onboarding's welcome. */
  onboarding = false;
  /** The local daemon was replaced and asked its viewers to run this. */
  relaunch: string | null = null;
  /** The local daemon speaks another viewer protocol, which ends the viewer. */
  fatal: Error | null = null;
  /** The installation the local daemon ran from is gone, which ends the viewer. */
  uninstalled = false;
  private connection: Connection | null = null;
  /** The connection once its hello checked out; the view's requests use it. */
  private checked: Connection | null = null;
  /** The daemon's hold on this endpoint across reconnects; see link.ts. */
  private link: string | null = null;
  /** Whether the current connection carries the link, so numbered requests go out. */
  private linked = false;
  /** The link came back with the viewer it had: no new viewer opens. */
  private resumed = false;
  private numbered: Numbered[] = [];
  /** A second connection is being dialed beside a silent one. */
  private racing = false;
  /** When the last race began; races come at most every `race_ms`. */
  private raced_at = -Infinity;
  /** The dial that won a race, for the next connect to carry on over. */
  private dialed: { tunnel: Remote; conn: Connection; hello: protocol.Reply<"hello"> } | null = null;
  /** The machine may have gone while the computer slept: race at once. */
  private suspect = false;
  private fresh_connection = false;
  private probe_tunnel: Remote | null = null;
  private seq = 0n;
  /** The highest numbered request answered; replies come in order. */
  private answered = 0n;
  private replies = new Set<bigint>();
  private listeners = new Set<(event: protocol.Event) => void>();
  private stream: Stream | null = null;
  private tunnel: Remote | null = null;
  private task: Promise<void> | null = null;
  private task_started = 0;
  private interruption = 0;
  private stopped = false;
  private next = 0;
  private opened = false;
  private input: number[] = [];
  private resource_detail: number | null = null;
  private bell = { seq: 0n };
  private retries = 0;
  private selection = 0;
  private cancellation = new AbortController();
  private focus: { instance: string; at: Focus } | null = null;
  private local_started = false;
  private cache: Cache;
  folder: string | null = null;
  onChange: () => void = () => {};
  onMachines: () => void = () => {};
  onEffects: (view: Controller) => void = () => {};
  onClipboard: (view: Controller) => Promise<void> = async () => {};
  constructor(
    readonly profile: Profile | null,
    readonly local: string,
    readonly probe: Probe,
    readonly host: Host,
    private readonly start_local?: () => Promise<void>,
  ) {
    this.machine = new Machine(this.transport(), this.name, profile !== null);
    this.machine.order_scope = JSON.stringify([this.name, profile?.target ?? "", profile?.socket ?? local]);
    // Links point at the daemon's machine: another one, or this one when the
    // viewer itself runs over SSH.
    this.machine.remote_links = profile !== null || sshViewer();
    this.machine.presence = () => ({
      online: this.status === "online",
      connecting: this.status === "connecting" || this.status === "stalled" || this.status === "offline",
      description: this.description(),
      cached: this.workspaces,
      seen: this.updated > 0,
      stale: this.workspaces_instance !== "" && this.workspaces_instance !== this.instance,
    });
    this.cache = new Cache(profile, local);
    const cached = this.cache.read();
    if (cached) {
      this.instance = this.workspaces_instance = cached.instance;
      this.workspaces = cached.workspaces;
      this.updated = cached.updated;
    }
  }
  get name(): string {
    return this.profile?.name ?? "local";
  }
  activate(): void {
    this.selection++;
    this.stream?.reset();
    this.fresh = false;
    this.ready = false;
    this.next = 0;
  }
  presented(): void {
    if (this.fresh && this.status === "online") this.ready = this.displayed = true;
  }
  deactivate(): void {
    this.selection++;
    this.stream?.reset();
    this.fresh = false;
    this.displayed = false;
    this.clearInput();
    this.next = 0;
  }
  choose(at: Focus, instance: string): void {
    this.focus = { at, instance };
    this.activate();
  }
  /** The machine's screen, once it has shown a fresh one; the controller
   * must be showing it. */
  render(): Output {
    if (!this.can_render) return "";
    const view = this.view();
    view.instant_ready = this.profile !== null && this.ready && this.fresh && this.status === "online";
    return view.compose();
  }
  get can_render(): boolean {
    return this.rendered;
  }
  /** The view, made for this machine alone when none is shared. */
  private view(): Controller {
    return (this.controller ??= new Controller(this.machine, this.host));
  }
  /** Whether the view shows this machine, so input and screens are its. */
  private get shown(): boolean {
    return this.view().machine === this.machine;
  }
  private wake(): void {
    this.next = 0;
    this.onChange();
  }
  enqueue(bytes: Uint8Array): void {
    if (!this.ready || !this.fresh || this.status !== "online") return;
    if (this.input.length + bytes.length > 1024 * 1024) {
      this.error = "Input queue full; unsent input discarded";
      this.clearInput();
      this.fresh = false;
      return;
    }
    for (const byte of bytes) this.input.push(byte);
    this.wake();
  }
  watchResources(workspace: number | null): void {
    if (this.resource_detail === workspace) return;
    this.resource_detail = workspace;
    this.wake();
  }
  retry(): void {
    if (this.stopped) return;
    this.interruption++;
    this.disconnect();
    this.fresh_connection = true;
    this.status = "connecting";
    this.error = "";
    this.next = 0;
    this.retries = 0;
  }
  pause(): void {
    if (this.stopped) return;
    this.interruption++;
    this.disconnect();
    // Paused, nothing sends them again.
    this.settleNumbered(() => true);
    this.status = "paused";
    this.error = "";
  }
  description(now = performance.now()): string {
    switch (this.status) {
      case "connecting":
        return `${this.instance ? "Reconnecting" : "Connecting"}…${this.tunnel ? ` · ${this.tunnel.progress()}` : ""}${this.task && now - this.task_started >= stalled_ms ? ` (${Math.floor((now - this.task_started) / 1000)}s)` : ""}`;
      case "stalled":
        return `Connection stalled (${Math.max(1, Math.floor((this.stream?.age(now) ?? now - this.task_started) / 1000))}s)${this.racing ? " · trying a fresh SSH connection" : ""}`;
      case "offline":
        return `offline · ${this.error} · retry in ${Math.max(0, Math.ceil((this.next - now) / 1000))}s`;
      case "paused":
        return "Paused · automatic retries stopped";
      case "incompatible":
        return "Incompatible Corgi · install a matching version, then retry";
      case "online":
        return this.error || "online";
    }
  }
  /** When the machine next wants a step, in `performance.now()` time; a
   * running step says when it's done. */
  due(): number {
    if (this.stopped || this.status === "paused" || this.status === "incompatible" || this.task) return Infinity;
    return Math.min(this.next, this.stream?.due() ?? Infinity);
  }
  /** Tells the daemon the host's colors changed, for its panes' programs. */
  theme(theme: Probe["theme"]): void {
    if (!this.opened) return;
    this.machine.tasks.start(async lane => {
      // Best effort: the next open sends the colors anyway.
      try {
        await lane.call("theme", { theme });
      } catch {}
    });
  }
  /** Steps the machine when it's due; `idle` says no one is typing or
   * watching anything move. */
  pump(visible: boolean, idle = false): void {
    if (this.stopped || this.status === "paused" || this.status === "incompatible") return;
    const now = performance.now();
    if (this.stream && this.status === "online" && this.stream.age(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.fresh = false;
      this.clearInput();
    }
    if (this.task && !this.stream && this.status === "online" && this.healthAge(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.fresh = false;
      this.clearInput();
    }
    const quiet = this.healthAge(now);
    const due = !this.racing && now - this.raced_at >= this.raceMs;
    if (this.profile && this.link && due && (this.suspect || (this.status === "stalled" && quiet >= this.raceMs)))
      void this.race(now);
    if (this.task) return;
    if (now < this.due()) return;
    // Completion wakes presentation, but only new work bypasses this cadence.
    this.next = now + (!visible && !this.opened ? 1000 : visible && !idle ? 16 : quiet_ms);
    if (!this.connection) this.status = "connecting";
    const selection = this.selection;
    const interruption = this.interruption,
      status = this.status;
    let changed = false;
    this.task_started = now;
    const task = this.step(visible, selection)
      .then(drawn => {
        changed = drawn;
      })
      .catch(error => {
        if (this.stopped || interruption !== this.interruption) return;
        if (!this.profile && incompatible(error)) this.fatal = Error("IncompatibleViewerProtocol");
        this.error = errors.name(error) ?? "ConnectionFailed";
        const diagnostic = this.tunnel?.diagnostic();
        if (diagnostic) this.error += ` · ${diagnostic}`;
        this.status =
          errors.is(error, "IncompatibleRemoteCorgi") || errors.is(error, "IncompatibleViewerProtocol")
            ? "incompatible"
            : "offline";
        this.fresh_connection = this.profile !== null;
        this.disconnect(true);
        this.retries++;
      })
      .finally(() => {
        if (this.task !== task) return;
        this.task = null;
        if (interruption !== this.interruption) return;
        // The first retry goes at once; later ones back off to 15 s.
        if (this.status === "offline")
          this.next =
            performance.now() + (this.retries <= 1 ? 0 : Math.min(15_000, 500 * 2 ** Math.min(this.retries - 1, 5)));
        // A step that changed nothing on screen leaves an idle viewer asleep.
        if (changed || this.status !== status) this.onChange();
      });
    this.task = task;
  }
  private current(generation: number): void {
    if (generation !== this.generation || this.stopped) throw Error("StaleConnection");
  }
  /** Dials the machine again beside a connection gone quiet. A network that
   * changed answers on the new one, which takes over; a daemon that's only
   * busy answers on neither until it's done, and the old one carries on.
   * Over a link either can: nothing in flight is lost or run twice. */
  private async race(now: number): Promise<void> {
    const profile = this.profile!,
      interruption = this.interruption,
      tunnel = new Remote(profile, true);
    this.probe_tunnel = tunnel;
    this.racing = true;
    this.raced_at = now;
    this.suspect = false;
    let conn: Connection | null = null;
    try {
      await tunnel.open();
      let established = false;
      conn = new Connection(tunnel.socket, {
        timeout_ms: () => (established ? this.stats.timeoutMs : 30000),
        stats: this.stats,
      });
      const hello = await conn.call("hello");
      established = true;
      // The old connection answering again, or anything else moving on, wins.
      if (interruption !== this.interruption || this.stopped || this.status !== "stalled") throw Error("RaceLost");
      if (compatible(hello) !== this.instance) throw Error("RaceLost");
      // The old connection is let go; the next connect resumes the link here.
      this.interruption++;
      this.probe_tunnel = null;
      this.disconnect();
      this.dialed = { tunnel, conn, hello };
      this.status = "connecting";
      this.next = 0;
      this.retries = 0;
      this.wake();
    } catch {
      conn?.close();
      tunnel.close();
    } finally {
      if (this.probe_tunnel === tunnel) {
        this.probe_tunnel = null;
        this.racing = false;
      }
    }
  }
  /** The computer slept: a remote machine's connection may be gone. */
  woke(): void {
    if (this.profile && (this.status === "online" || this.status === "stalled")) this.suspect = true;
  }
  private async connect(): Promise<void> {
    const previous = this.instance;
    const generation = ++this.generation;
    if (this.profile === null && this.start_local && !this.local_started) {
      await this.start_local();
      this.current(generation);
      this.local_started = true;
    }
    let conn: Connection, hello: protocol.Reply<"hello">;
    const dialed = this.dialed;
    this.dialed = null;
    if (dialed) {
      this.tunnel = dialed.tunnel;
      conn = this.connection = dialed.conn;
      hello = dialed.hello;
    } else {
      if (this.profile) {
        this.tunnel = new Remote(this.profile, this.fresh_connection);
        this.fresh_connection = false;
        await this.tunnel.open();
        this.current(generation);
      }
      this.current(generation);
      const socket = this.tunnel?.socket ?? this.local;
      let established = false;
      conn = this.connection = new Connection(socket, {
        timeout_ms: () => (this.profile ? (established ? this.stats.timeoutMs : 30000) : 10000),
        stats: this.stats,
      });
      hello = await conn.call("hello");
      established = true;
      this.current(generation);
    }
    conn.onEvent(event => {
      if (this.connection !== conn) return;
      if (event.type === "uninstalled" && !this.profile) {
        this.uninstalled = true;
        this.onChange();
      }
      for (const listener of this.listeners) listener(event);
    });
    this.instance = compatible(hello);
    if (!hello.capabilities.includes("viewer.stream")) throw Error("IncompatibleRemoteCorgi");
    this.checked = conn;
    // A view outlives its connections to one daemon. Another daemon's ids
    // mean nothing to it.
    const same = previous === this.instance;
    const view = this.view();
    if (!same) {
      this.focus = null;
      this.rendered = false;
      if (this.shown) view.closeMachineUi();
      this.machine.forget();
    }
    this.resumed = hello.capabilities.includes("link.resume") && (await this.relink(conn, same));
    this.current(generation);
    // A resumed viewer keeps what its connection agreed with the daemon.
    if (!this.resumed) view.resetConnection(this.machine);
    const snapshot = await conn.call("session.snapshot", { resources: this.host.prefs.resources.enabled });
    this.current(generation);
    view.receiveSnapshot(snapshot, this.machine);
    this.machine.runtime.receiveResources(snapshot.resources);
  }
  /** Resumes this endpoint's link, or opens a fresh one; true when the link
   * still had its viewer, which this connection now is. */
  private async relink(conn: Connection, same: boolean): Promise<boolean> {
    let viewer = false;
    if (this.link && same) {
      try {
        viewer = (await conn.call("link.resume", { link: this.link })).viewer;
      } catch (error) {
        if (!errors.is(error, "NoLink")) throw error;
        this.link = null;
      }
    }
    if (!this.link || !same) {
      // What went out over the old link may or may not have run; what never
      // went out goes now, unless another daemon has replaced this one.
      this.settleNumbered(request => !same || request.seq !== null);
      this.link = (await conn.call("link.open")).link;
      this.seq = this.answered = 0n;
      this.replies.clear();
    }
    this.linked = true;
    for (const request of this.numbered) this.send(request, conn);
    return viewer;
  }
  /** Sends a request that must run once; it waits while no connection
   * carries the link, and goes again after a resume. */
  private sendOnce(op: protocol.Op, payload: unknown): Promise<any> {
    if (this.numbered.length >= numbered_limit) return Promise.reject(Error("RequestBackpressure"));
    return new Promise((resolve, reject) => {
      const request: Numbered = {
        body: protocol.envelope(op, payload as Record<string, unknown>),
        seq: null,
        resolve,
        reject,
      };
      this.numbered.push(request);
      if (this.linked && this.checked) this.send(request, this.checked);
    });
  }
  private send(request: Numbered, conn: Connection): void {
    request.seq ??= ++this.seq;
    const seq = request.seq;
    conn.rawRequest({ ...request.body, seq, answered: this.answered }).then(
      reply => {
        const index = this.numbered.indexOf(request);
        if (index < 0) return;
        this.numbered.splice(index, 1);
        this.replies.add(seq);
        while (this.replies.delete(this.answered + 1n)) this.answered++;
        request.resolve(reply);
      },
      // The connection went; the request goes again once the link is resumed.
      () => {},
    );
  }
  /** Fails the numbered requests `lost` picks, which can't be sent again. */
  private settleNumbered(lost: (request: Numbered) => boolean): void {
    const kept: Numbered[] = [];
    for (const request of this.numbered)
      if (lost(request)) request.reject(Error("StaleConnection"));
      else kept.push(request);
    this.numbered = kept;
  }
  /** Requests that go over whichever connection is current, and fail when
   * they span a reconnect. Those that must run once go numbered over the
   * link, and survive one. */
  private transport(): Transport {
    const endpoint = this,
      profile = this.profile;
    return {
      get socket() {
        return profile ? endpoint.tunnel?.socket : endpoint.local;
      },
      onEvent: listener => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      remote: profile !== null,
      predictionMs: () => this.stats.predictionMs,
      image: profile
        ? async (path, mime, progress) => {
            const generation = this.generation,
              epoch = this.input_epoch;
            if (!this.checked) throw Error("StaleConnection");
            const result = await image(
              profile,
              path,
              mime,
              this.instance,
              this.cancellation.signal,
              (received, total) => {
                if (generation !== this.generation || epoch !== this.input_epoch || this.stopped) return;
                progress?.(received, total);
                this.wake();
              },
            );
            this.current(generation);
            if (epoch !== this.input_epoch) throw Error("StaleConnection");
            return result;
          }
        : undefined,
      request: async (op, ...args) => {
        if (this.link && protocol.once(op)) return this.sendOnce(op, args[0]);
        const generation = this.generation,
          conn = this.checked;
        if (!conn) throw Error("StaleConnection");
        const reply = await conn.request(op, ...args);
        this.current(generation);
        return reply;
      },
    };
  }
  /** Brings the machine's data up to date, and for the shown machine, its
   * input and screen. Says whether anything it did needs drawing. */
  private async step(visible: boolean, selection: number): Promise<boolean> {
    if (!this.connection) await this.connect();
    let changed = false;
    const generation = this.generation;
    this.current(generation);
    const view = this.view(),
      machine = this.machine;
    // Only the machine shown takes input and draws; the rest keep their data current.
    visible &&= this.shown;
    if (visible && !this.opened) {
      changed = true;
      if (this.resumed) {
        // The link brought the viewer back; its id and controls carry on.
        view.input_state.attached = true;
        view.launch_previews.connect(machine.connection);
        view.updateLaunchPreview();
      } else {
        const navigation = machine.navigation;
        const workspace = navigation.workspace_id;
        this.bell.seq = await viewer.openMode(
          view,
          this.profile?.home ?? process.cwd(),
          this.probe.theme,
          this.onboarding,
        );
        this.current(generation);
        this.onboarding = false;
        if (navigation.entries.length) {
          navigation.workspace_id = workspace;
          machine.navigation = navigation;
        }
      }
      machine.remote_links = this.profile !== null || sshViewer();
      this.opened = true;
      this.stream = new Stream(this.connection!, () => {
        if (generation === this.generation && !this.stopped) this.wake();
      });
      visible &&= this.shown && selection === this.selection;
      if (visible && this.folder !== null) {
        const folder = this.folder;
        this.folder = null;
        await view.perform({ name: "open", value: folder });
        this.current(generation);
      }
    }
    visible &&= this.shown && selection === this.selection;
    if (this.opened) {
      const stream = this.stream!;
      stream.check();
      const taken = stream.take(),
        reply = taken?.frame ?? null;
      if (taken?.news) changed = true;
      if (reply) {
        const snapshot_epoch = machine.runtime.snapshot_epoch;
        const attached = await viewer.receive(view, reply, this.bell, visible, machine);
        this.current(generation);
        if (machine.runtime.snapshot_epoch !== snapshot_epoch + (reply.session ? 1 : 0)) stream.reset();
        if (!attached) {
          // A replaced local daemon has the viewer run its build; a remote
          // one's build isn't on this computer, so it's only reconnected to.
          if (view.executable && !this.profile) {
            this.relaunch = view.executable;
            this.detached = true;
          } else if (view.executable) {
            view.executable = "";
            this.disconnect();
          } else if (visible) this.detached = true;
          return true;
        }
      }
      const snapshot_epoch = machine.runtime.snapshot_epoch;
      if (visible && this.displayed && selection === this.selection && !this.acknowledging) {
        this.displayed = false;
        this.acknowledging = true;
        stream.send(async () => {
          try {
            await viewer.presented(view);
          } finally {
            if (generation === this.generation) this.acknowledging = false;
          }
        });
      }
      if (visible) {
        const size = viewer.dimensions();
        view.width = size.cols;
        view.height = size.rows;
        if (this.focus) {
          const focus = this.focus;
          this.focus = null;
          if (focus.instance === this.instance) show(view, focus.at);
          changed = true;
        }
        const input = this.input.splice(0);
        if (input.length) changed = true;
        view.instant_ready = this.profile !== null && this.ready && this.fresh && this.status === "online";
        try {
          const current = () => this.shown && selection === this.selection && generation === this.generation;
          if (input.length) await view.input(Uint8Array.from(input), current);
          this.current(generation);
          if (!current()) return changed;
          await view.expireInput(current);
          if (!current()) return changed;
        } catch (error) {
          this.current(generation);
          if (!this.shown || selection !== this.selection) return changed;
          if (this.connection?.socket.destroyed) throw error;
          view.notice(errors.name(error) ?? "ActionFailed");
        }
        await this.onClipboard(view);
        this.current(generation);
      }
      if (machine.runtime.snapshot_epoch !== snapshot_epoch) stream.reset();
      for (const pane of machine.runtime.panes) {
        const held = visible && view.selection !== null && view.selection.pane === pane.id;
        if (pane.terminal.holding_selection && !held) pane.terminal.clearSelection();
        if (pane.terminal.pending.length) stream.send(() => pane.terminal.flush(), pane.terminal.pending.length);
      }
      stream.configure(
        { ...viewer.syncRequest(view, visible, machine), resource_detail: this.resource_detail },
        selection,
      );
      if (visible) view.input_state.active = false;
      if (visible && selection === this.selection) {
        this.displayed = false;
        view.dirty = false;
        if (reply && stream.fresh && stream.age() < this.stallMs) this.fresh = this.rendered = true;
        this.onEffects(view);
      }
    } else {
      const snapshot = await this.connection!.call("session.snapshot", {
        resources: this.host.prefs.resources.enabled,
      });
      this.current(generation);
      view.receiveSnapshot(snapshot, machine);
      machine.runtime.receiveResources(snapshot.resources);
      changed = true;
    }
    if (!this.stream || this.stream.age() < this.stallMs) {
      this.status = "online";
      this.error = "";
    }
    this.retries = 0;
    this.workspaces = view.workspaceEntries(machine);
    this.workspaces_instance = this.instance;
    this.updated = Date.now();
    this.cache.write({ instance: this.instance, updated: this.updated, workspaces: this.workspaces });
    return changed;
  }
  private clearInput(): void {
    this.input_epoch++;
    this.cancellation.abort();
    this.cancellation = new AbortController();
    this.ready = false;
    this.input = [];
    for (const pane of this.machine.runtime.panes) {
      pane.terminal.pending = [];
      pane.terminal.resetPrediction();
    }
    // Keys on their way belong to the machine shown.
    if (!this.controller || !this.shown) return;
    const view = this.controller;
    view.instant_ready = false;
    view.cancelInput();
    view.paste_target = null;
    view.paste_progress = null;
    view.prefix = false;
  }
  private disconnect(keepTask = false): void {
    this.generation++;
    if (!keepTask) this.task = null;
    this.racing = false;
    this.probe_tunnel?.close();
    this.probe_tunnel = null;
    this.connection?.close();
    this.connection = null;
    this.checked = null;
    // A won race not yet taken up goes with the rest.
    this.dialed?.conn.close();
    this.dialed?.tunnel.close();
    this.dialed = null;
    // Numbered requests wait for the link to be resumed.
    this.linked = false;
    this.stream = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.opened = false;
    this.acknowledging = false;
    this.fresh = false;
    this.clearInput();
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.disconnect();
    this.settleNumbered(() => true);
    await this.task;
    this.machine.runtime.destroy();
  }
}
/** Goes where switching to the machine asked, if it's still there. */
function show(view: Controller, at: Focus): void {
  const runtime = view.runtime;
  if ("workspace" in at) {
    if (runtime.workspaces.index(at.workspace) !== null) view.switchWorkspace(at.workspace);
  } else if ("pane" in at ? runtime.workspaces.owner(at.pane) : runtime.sessions.some(s => s.id === at.headless))
    view.selectAgent(at);
}
/** Whether the daemon speaks another viewer protocol than this viewer. */
function incompatible(error: unknown): boolean {
  switch (errors.name(error)) {
    case "IncompatibleViewerProtocol":
    case "UnsupportedViewerProtocol":
    case "UnsupportedProtocol":
    case "ProtocolRequired":
    case "IncompatibleRemoteCorgi":
      return true;
    default:
      return false;
  }
}
