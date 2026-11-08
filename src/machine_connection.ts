import * as ssh from "./ssh";
import * as telemetry from "./telemetry";
import { Stats } from "./connection_stats";
import type { Output } from "./composition";
import { Remote, startup_ms } from "./daemon_transport";
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
import { Cache, metadata } from "./machine_cache";
import { Stream } from "./machine_stream";
import * as viewer_data from "./viewer_data";
import * as protocol from "./protocol";
import * as i18n from "./i18n";
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
const handoff_input_limit = 64 * 1024;

export type Status = "connecting" | "online" | "stalled" | "offline" | "paused" | "incompatible" | "attention";
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
    const control = now - Math.max(this.task_started, this.stats.lastReceived ?? this.task_started);
    return this.stream?.age(now) ?? Math.max(control, this.data?.age(now) ?? 0);
  }
  status: Status = "connecting";
  error = "";
  issue: ssh.Failure = "error";
  generation = 0;
  instance = "";
  workspaces_instance = "";
  fresh = false;
  ready = false;
  input_epoch = 0;
  updated = 0;
  workspaces: WorkspaceEntry[] = [];
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
  private data: viewer_data.Connection | null = null;
  private separate = false;
  private fresh_data = false;
  private controls: protocol.Wire<protocol.Control[]> = [];
  /** The connection once its hello checked out; the view's requests use it. */
  private checked: Connection | null = null;
  private incremental = false;
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
  private connected = false;
  private input: number[] = [];
  private handoff: {
    instance: string;
    selection: number;
    navigation: number;
    pane: number | null;
    generation: number;
    until: number;
    input: number[];
  } | null = null;
  private ui_task: Promise<void> | null = null;
  private resource_detail: number | null = null;
  private bell = { seq: 0n };
  private retries = 0;
  private selection = 0;
  private navigation_revision = 0;
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
      link_quality: this.profile ? (this.status === "online" ? this.stats.quality : 0) : null,
      connecting: this.status === "connecting" || this.status === "stalled" || this.status === "offline",
      connection_status: this.headerStatus(),
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
      if (cached.metadata) {
        this.machine.runtime.receive(this.machine.connection, cached.metadata);
        this.machine.runtime.workspaces.loaded = false;
      }
    }
  }
  private trace(name: "remote.connection" | "remote.race", phase: string, details: telemetry.Details = {}): void {
    if (telemetry.enabled)
      telemetry.event(name, {
        machine: this.name,
        generation: this.generation,
        phase,
        status: this.status,
        age_ms: this.healthAge(performance.now()),
        stall_ms: this.stallMs,
        race_ms: this.raceMs,
        ...details,
      });
  }
  get name(): string {
    return this.profile?.name ?? "local";
  }
  activate(): void {
    this.navigation_revision = this.machine.navigation.revision;
    this.selection++;
    this.stream?.reset();
    this.fresh = false;
    this.ready = false;
    this.next = 0;
  }
  presented(): void {
    if (this.fresh && this.status === "online") {
      if (!this.ready) this.trace("remote.connection", "presented");
      this.ready = this.displayed = true;
    }
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
    this.focus = null;
    if (instance !== this.instance) {
      this.activate();
      return;
    }
    if ("workspace" in at) this.view().switchWorkspace(at.workspace);
    else {
      if (this.machine.runtime.workspaces.loaded) show(this.view(), at);
      else this.focus = { at, instance };
    }
    this.activate();
  }
  /** Draw organization immediately, with placeholders for missing screens. */
  render(): Output {
    this.syncNavigation();
    const view = this.view();
    view.instant_ready = this.profile !== null && this.ready && this.fresh && this.status === "online";
    return view.compose();
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
    if (this.handoff) {
      if (this.handoff.input.length + bytes.length <= handoff_input_limit)
        for (const byte of bytes) this.handoff.input.push(byte);
      else this.clearInput();
      this.wake();
      return;
    }
    if (this.input.length + bytes.length > 1024 * 1024) {
      this.error = "Input queue full; unsent input discarded";
      this.clearInput();
      this.fresh = false;
      return;
    }
    for (const byte of bytes) this.input.push(byte);
    this.wake();
  }
  private syncNavigation(): void {
    if (this.navigation_revision === this.machine.navigation.revision) return;
    this.navigation_revision = this.machine.navigation.revision;
    this.stream?.reset();
    this.fresh = this.ready = false;
    this.next = 0;
  }
  /** UI work never waits behind a connection's snapshot or attachment. */
  private pumpUi(): void {
    if (this.ui_task || !this.shown || this.stopped) return;
    if (this.handoff) {
      const held = this.handoff;
      if (
        held.instance !== this.instance ||
        held.selection !== this.selection ||
        held.navigation !== this.navigation_revision ||
        held.pane !== (this.view().focused()?.id ?? null) ||
        performance.now() > held.until
      )
        this.clearInput();
      else if (this.ready && this.resumed && this.generation > held.generation) {
        this.input = held.input;
        this.handoff = null;
      } else return;
    }
    const view = this.view(),
      selection = this.selection,
      dirty = view.dirty;
    if (!view.input_state.attached) return;
    const current = () => this.shown && selection === this.selection && !this.stopped;
    const input = this.input.splice(0);
    this.ui_task = (async () => {
      try {
        if (input.length) await view.input(Uint8Array.from(input), current);
        if (current()) await view.expireInput(current);
      } catch (error) {
        if (current()) view.notice(errors.name(error) ?? "ActionFailed");
      } finally {
        this.ui_task = null;
        if (current() && (input.length || (!dirty && view.dirty))) this.onChange();
      }
    })();
  }
  watchResources(workspace: number | null): void {
    if (this.resource_detail === workspace) return;
    this.resource_detail = workspace;
    this.wake();
  }
  retry(): void {
    if (this.stopped) return;
    this.handoff = null;
    this.interruption++;
    this.disconnect();
    this.fresh_connection = this.issue === "error";
    this.status = "connecting";
    this.error = "";
    this.next = 0;
    this.retries = 0;
  }
  pause(): void {
    if (this.stopped) return;
    this.handoff = null;
    this.interruption++;
    this.disconnect();
    // Paused, nothing sends them again.
    this.settleNumbered(() => true);
    this.status = "paused";
    this.error = "";
  }
  headerStatus(now = performance.now()): WorkspaceEntry["connection_status"] {
    if (this.error && this.profile)
      return { label: this.issue === "auth" ? "! auth" : "! error", seconds: null, color: "hot", diagnostic: true };
    switch (this.status) {
      case "attention":
        return { label: "! error", seconds: null, color: "hot" };
      case "connecting":
        return {
          label: this.connected ? i18n.t`reconnecting` : i18n.t`connecting`,
          seconds: this.task ? Math.max(0, Math.floor((now - this.task_started) / 1000)) : 0,
          color: "warm",
        };
      case "stalled":
        return { label: i18n.t`stalled`, seconds: Math.max(1, Math.floor(this.healthAge(now) / 1000)), color: "warm" };
      case "offline":
        return { label: i18n.t`retry in`, seconds: Math.max(0, Math.ceil((this.next - now) / 1000)), color: "hot" };
      case "paused":
        return { label: i18n.t`paused`, seconds: null, color: "muted" };
      case "incompatible":
        return { label: i18n.t`incompatible`, seconds: null, color: "hot" };
      case "online":
        return null;
    }
  }
  description(now = performance.now()): string {
    switch (this.status) {
      case "attention":
        return `Attention · ${this.error}`;
      case "connecting":
        return `${this.connected ? "Reconnecting" : "Connecting"}…${this.task ? ` ${Math.max(0, Math.floor((now - this.task_started) / 1000))}s` : ""}${this.tunnel ? ` · ${this.tunnel.progress()}` : ""}`;
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
    if (visible) {
      this.syncNavigation();
      this.pumpUi();
    }
    if (this.stopped || this.status === "paused" || this.status === "incompatible") return;
    const now = performance.now();
    if (this.stream && this.status === "online" && this.stream.age(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.trace("remote.connection", "stalled");
      this.fresh = false;
      this.clearInput();
    }
    if (this.task && !this.stream && this.status === "online" && this.healthAge(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.trace("remote.connection", "stalled");
      this.fresh = false;
      this.clearInput();
    }
    const quiet = this.healthAge(now);
    this.stats.progress(quiet, this.stallMs);
    // Failed dials are not progress: keep probing from the last received byte.
    const recovering =
      this.connected &&
      (this.status === "connecting" || this.status === "offline") &&
      Math.max(now - (this.stats.lastReceived ?? this.task_started), this.data?.age(now) ?? 0) >= this.raceMs;
    const due = !this.racing && now - this.raced_at >= (recovering ? this.stallMs : this.raceMs);
    if (
      this.profile &&
      this.link &&
      due &&
      (this.suspect || recovering || (this.status === "stalled" && quiet >= this.raceMs))
    )
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
        if (!this.profile && incompatible(error))
          this.fatal = Error(errors.is(error, "ServerRolledBack") ? "ServerRolledBack" : "IncompatibleViewerProtocol");
        this.error = errors.name(error) ?? "ConnectionFailed";
        this.trace("remote.connection", "failed", { error: this.error });
        const diagnostic = this.tunnel?.diagnostic();
        this.issue = ssh.failure(diagnostic ?? "");
        if (diagnostic) this.error += ` · ${diagnostic}`;
        this.status =
          errors.is(error, "IncompatibleRemoteCorgi") ||
          errors.is(error, "IncompatibleViewerProtocol") ||
          errors.is(error, "ServerRolledBack")
            ? "incompatible"
            : this.issue === "error"
              ? "offline"
              : "attention";
        this.fresh_connection = this.profile !== null && this.issue === "error";
        // A spare handshake can still answer after the primary has timed out.
        this.disconnect(true, this.status === "offline");
        this.retries++;
      })
      .finally(() => {
        if (this.task !== task) return;
        this.task = null;
        if (interruption !== this.interruption) return;
        if (this.status === "attention") this.next = performance.now() + 30_000;
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
      tunnel = new Remote(profile, true, Math.min(startup_ms, this.stats.timeoutMs));
    this.probe_tunnel = tunnel;
    this.racing = true;
    this.raced_at = now;
    this.trace("remote.race", "start");
    this.suspect = false;
    let conn: Connection | null = null;
    try {
      await tunnel.open();
      let established = false;
      conn = new Connection(tunnel.socket, {
        compression: true,
        timeout_ms: () => (established ? this.stats.timeoutMs : Math.min(startup_ms, this.stats.timeoutMs)),
        stats: this.stats,
        trace: { machine: this.name, generation: this.generation, path: "race" },
      });
      const hello = await conn.call("hello");
      established = true;
      this.trace("remote.race", "hello");
      // The old connection answering again, or anything else moving on, wins.
      if (
        interruption !== this.interruption ||
        this.stopped ||
        (this.status !== "stalled" && this.status !== "connecting" && this.status !== "offline")
      )
        throw Error("RaceLost");
      if (compatible(hello) !== this.instance) throw Error("RaceLost");
      // The old connection is let go; the next connect resumes the link here.
      this.trace("remote.race", "won");
      this.interruption++;
      this.probe_tunnel = null;
      this.disconnect();
      this.dialed = { tunnel, conn, hello };
      this.status = "connecting";
      this.next = 0;
      this.retries = 0;
      this.wake();
    } catch (error) {
      this.trace("remote.race", "failed", { error: errors.name(error) ?? "ConnectionFailed" });
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
  private holdHandoffInput(): void {
    const input = this.input;
    this.input = [];
    if (input.length > handoff_input_limit) {
      this.clearInput();
      this.error = "Input queue full; unsent input discarded";
    }
    this.handoff = {
      instance: this.instance,
      selection: this.selection,
      navigation: this.navigation_revision,
      pane: this.view().focused()?.id ?? null,
      generation: this.generation,
      until: performance.now() + startup_ms,
      input: input.length <= handoff_input_limit ? input : [],
    };
    this.ready = this.fresh = false;
    this.wake();
  }
  private async connect(): Promise<void> {
    const previous = this.instance;
    const generation = ++this.generation;
    this.trace("remote.connection", "start");
    if (this.profile === null && this.start_local && !this.local_started) {
      await this.start_local();
      this.current(generation);
      this.local_started = true;
    }
    let conn: Connection, hello: protocol.Reply<"hello">;
    const dialed = this.dialed;
    this.fresh_data = !!dialed || this.fresh_connection;
    this.dialed = null;
    // SSH setup can take many round trips. Open both lanes together; bind
    // only after the primary confirms support and the daemon's identity.
    if ((this.profile && this.shown) || (this.separate && this.machine.viewer_id !== 0))
      this.data = new viewer_data.Connection(this.profile, this.local, this.stats, this.fresh_data);
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
        compression: this.profile !== null,
        timeout_ms: () => (this.profile ? (established ? this.stats.timeoutMs : startup_ms) : 10000),
        stats: this.stats,
        trace: { machine: this.name, generation, path: "primary" },
      });
      hello = await conn.call("hello");
      established = true;
      this.current(generation);
    }
    this.trace("remote.connection", "hello");
    conn.onEvent(event => {
      if (this.connection !== conn) return;
      if (event.type === "viewer.reconnect" && this.link) {
        this.trace("remote.connection", "handoff");
        this.holdHandoffInput();
      }
      if (event.type === "uninstalled" && !this.profile) {
        this.uninstalled = true;
        this.onChange();
      }
      if (event.type === "viewer.controls") {
        this.controls = event.controls;
        this.wake();
      }
      for (const listener of this.listeners) listener(event);
    });
    this.instance = compatible(hello);
    if (!hello.capabilities.includes("viewer.stream")) throw Error("IncompatibleRemoteCorgi");
    this.incremental = hello.capabilities.includes("viewer.receipt");
    this.separate =
      this.incremental &&
      hello.capabilities.includes("viewer.data") &&
      hello.capabilities.includes("viewer.stream.configure") &&
      hello.capabilities.includes("link.resume");
    if (!this.separate) {
      this.data?.close();
      this.data = null;
    } else if (this.shown)
      this.data ??= new viewer_data.Connection(this.profile, this.local, this.stats, this.fresh_data);
    this.checked = conn;
    // A view outlives its connections to one daemon. Another daemon's ids
    // mean nothing to it.
    const same = previous === this.instance;
    const view = this.view();
    if (!same) {
      this.focus = null;
      if (this.shown) view.closeMachineUi();
      this.machine.forget();
      this.workspaces = [];
      this.workspaces_instance = this.instance;
      this.updated = 0;
    }
    const linking = hello.capabilities.includes("link.resume") ? this.relink(conn, same) : Promise.resolve(false);
    const snapshotRequest = () => conn.call("session.snapshot", { resources: this.host.prefs.resources.enabled });
    // A snapshot must follow replayed mutations. Otherwise it can share the link's round trip.
    const [resumed, snapshot] = await Promise.all([
      linking,
      this.numbered.length ? linking.then(snapshotRequest) : snapshotRequest(),
    ]);
    this.resumed = resumed;
    this.trace("remote.connection", "linked", { resumed: Number(this.resumed) });
    this.current(generation);
    if (!this.resumed) view.resetConnection(this.machine);
    this.trace("remote.connection", "snapshot");
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
      inputReady: pane =>
        this.ready &&
        this.fresh &&
        this.status === "online" &&
        this.navigation_revision === this.machine.navigation.revision &&
        this.machine.runtime.pane(pane)?.terminal.known != null,
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
        if (protocol.once(op)) {
          if (!this.checked || !this.machine.runtime.workspaces.loaded) throw Error("StaleConnection");
          if (this.link) return this.sendOnce(op, args[0]);
        }
        const generation = this.generation;
        const bulk = ["viewer.surfaces", "viewer.image", "viewer.search", "viewer.pick", "pane.surface"].includes(op);
        const conn = bulk && this.opened ? (this.data?.channel ?? this.checked) : this.checked;
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
        this.bell.seq = await viewer.openMode(
          view,
          this.profile?.home ?? process.cwd(),
          this.probe.theme,
          this.onboarding,
        );
        this.current(generation);
        this.onboarding = false;
      }
      machine.remote_links = this.profile !== null || sshViewer();
      let data = this.connection!;
      if (this.separate && this.link) {
        this.data ??= new viewer_data.Connection(this.profile, this.local, this.stats, this.fresh_data);
        data = await this.data.bind(this.link, this.instance);
        this.current(generation);
        machine.viewer_id = this.data.viewer;
      }
      this.opened = true;
      this.stream = new Stream(
        this.connection!,
        () => {
          if (generation === this.generation && !this.stopped) this.wake();
        },
        this.incremental,
        data,
      );
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
      const taken = stream.take();
      let reply = taken?.frame ?? null;
      if (visible && this.controls.length) {
        reply ??= {
          type: "view",
          viewer_protocol: protocol.viewer_version,
          session: null,
          session_hash: machine.runtime.snapshot_hash ?? 0n,
          resources: null,
          resources_hash: machine.runtime.resources_hash ?? 0n,
          surfaces: [],
          controls: [],
          viewer: machine.viewer_id,
          bell_seq: this.bell.seq,
          bell_kind: "none",
          detach: false,
        };
        reply = { ...reply, controls: this.controls };
        this.controls = [];
        changed = true;
      }
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
        if (reply && stream.fresh && stream.age() < this.stallMs) this.fresh = true;
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
      if (this.status !== "online") this.trace("remote.connection", "online");
      this.status = "online";
      this.error = "";
    }
    this.retries = 0;
    this.connected = true;
    this.workspaces = view.workspaceEntries(machine);
    this.workspaces_instance = this.instance;
    this.updated = Date.now();
    this.cache.write({
      instance: this.instance,
      updated: this.updated,
      workspaces: this.workspaces,
      metadata: metadata(machine.runtime),
    });
    return changed;
  }
  private clearInput(keepHandoff = false): void {
    if (!keepHandoff) this.handoff = null;
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
  private disconnect(keepTask = false, keepProbe = false): void {
    this.generation++;
    if (!keepTask) this.task = null;
    if (!keepProbe) {
      this.racing = false;
      this.probe_tunnel?.close();
      this.probe_tunnel = null;
    }
    this.data?.close();
    this.data = null;
    this.controls = [];
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
    this.clearInput(!this.stopped);
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.disconnect();
    this.settleNumbered(() => true);
    await this.task;
    await this.ui_task;
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
    case "ServerRolledBack":
    case "UnsupportedViewerProtocol":
    case "UnsupportedProtocol":
    case "ProtocolRequired":
    case "IncompatibleRemoteCorgi":
      return true;
    default:
      return false;
  }
}
