import * as viewerRef from "./viewer_ref";
import * as agentRows from "./agent_rows";
import * as telemetry from "./telemetry";
import { Queue, pasting, type Input } from "./terminal_input";
import { Stats } from "./connection_stats";
import type { Output } from "./composition";
import { Controller } from "./controller";
import { Machine, type Focus } from "./machine";
import type { Transport } from "./mirror";
import { Connection } from "./rpc";
import * as machine_path from "./machine_path";
import * as viewer from "./viewer";
import * as errors from "./errors";
import * as buildInfo from "./machine_build";
import type * as progress from "./machine_progress";
import * as machine_update from "./machine_update";
import type { Probe } from "./terminal_info";
import type { Host } from "./host";
import type { WorkspaceEntry } from "./sidebar";
import { Cache, metadata } from "./machine_cache";
import { Stream, input_chunk } from "./machine_stream";
import * as viewer_data from "./viewer_data";
import * as protocol from "./protocol";
import * as rpc_http from "./rpc_http";
import * as i18n from "./i18n";
import { sshViewer } from "./trackers/ports";
import * as webLinks from "./web_links";
import { Forwards, type Link } from "./port_forwards";

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
/** How long typing held across a reload waits for the same viewer. */
const handoff_ms = 30_000;

export type Status = "connecting" | "online" | "stalled" | "offline" | "incompatible" | "attention";
/** Parsed input and whether its machine was dropping input when it arrived. */
type Typed = Input & { dropped: boolean };
/** How often an idle viewer's machines are stepped. */
export const quiet_ms = 500;
/** A remote machine silent this long gets a second connection beside the first. */
export const race_ms = 4000;
/** Most connects are done by then: until it, a machine looks as it did. */
const quiet_connect_ms = 1000;
/** The longest a failing connection waits before trying again. */
const max_retry_ms = 15_000;
/** An outage this long is no blip: fresh dials beside it slow to the retries' pace. */
const long_outage_ms = 120_000;
export class Endpoint {
  readonly stats = new Stats();
  get stallMs(): number {
    return this.sample.stallMs(this.stats);
  }
  get raceMs(): number {
    return Math.max(race_ms, this.stallMs * 2);
  }
  private healthAge(now: number): number {
    const control = now - Math.max(this.task_started, this.stats.lastReceived ?? this.task_started);
    return this.stream?.age(now) ?? Math.max(control, this.data?.age(now) ?? 0);
  }
  private current_status: Status = "connecting";
  /** When the machine began connecting, and its status before; none at startup. */
  private connecting: { since: number; from: Status | null } = { since: performance.now(), from: null };
  get status(): Status {
    return this.current_status;
  }
  /** The status the viewer shows, and whether it's a connect's `quiet`
   * first second. Most connects are done by then, so meanwhile one from
   * online still looks online, and one at startup shows no progress yet.
   * One after an outage that showed shows at once. */
  display(now = performance.now()): { status: Status; quiet: boolean } {
    const from = this.connecting.from,
      quiet =
        this.status === "connecting" &&
        (from === null || from === "online") &&
        now - this.connecting.since < quiet_connect_ms;
    return { status: quiet && from === "online" ? "online" : this.status, quiet };
  }
  set status(value: Status) {
    if (value === "connecting" && this.current_status !== "connecting")
      this.connecting = { since: performance.now(), from: this.current_status };
    this.current_status = value;
  }
  error = "";
  issue: Exclude<machine_path.Issue, "fatal"> = "error";
  generation = 0;
  instance = "";
  workspaces_instance = "";
  fresh = false;
  ready = false;
  input_epoch = 0;
  updated = 0;
  workspaces: WorkspaceEntry<number>[] = [];
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
  /** How often a review read or a streamed search pings its connection, well
   * inside the 10 s of silence it allows. */
  private review_ping_ms = 3_000;
  private separate = false;
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
  /** The path that won a race, for the next connect to carry on over. */
  private dialed: {
    path: machine_path.Path;
    conn: Connection;
    hello: machine_path.Hello;
    data: viewer_data.Connection | null;
  } | null = null;
  /** The machine may have gone while the computer slept: race at once. */
  private suspect = false;
  /** The daemon was shut down on purpose: connecting doesn't start it again. */
  private shut_down = false;
  private fresh_connection = false;
  private probe_path: machine_path.Path | null = null;
  private seq = 0n;
  /** The highest numbered request answered; replies come in order. */
  private answered = 0n;
  private replies = new Set<bigint>();
  private listeners = new Set<(event: protocol.Event) => void>();
  private stream: Stream | null = null;
  /** How this endpoint reaches its daemon now. */
  private path: machine_path.Path | null = null;
  /** A path never opened, which says how this machine's paths behave while none is. */
  private readonly sample: machine_path.Path;
  private task: Promise<void> | null = null;
  private task_started = 0;
  private interruption = 0;
  private stopped = false;
  private next = 0;
  private opened = false;
  private connected = false;
  private input = new Queue<Typed>();
  private last_dropped = false;
  private handoff: {
    instance: string;
    selection: number;
    navigation: number;
    pane: number | null;
    generation: number;
    until: number;
    input: Queue<Typed>;
  } | null = null;
  private ui_task: Promise<void> | null = null;
  private ui_paste = false;
  private resource_detail: number | null = null;
  private bell = { seq: 0n };
  private retries = 0;
  private selection = 0;
  private navigation_revision = 0;
  private cancellation = new AbortController();
  private focus: { instance: string; at: Focus } | null = null;
  private cache: Cache;
  private updating: AbortController | null = null;
  daemonVersion: buildInfo.Identity | null = null;
  /** The computer whose viewer moved the daemon to its build, when it said. */
  movedBy = "";
  /** The update this endpoint starts with, which Ctrl+R runs again for a
   * machine another viewer moved to a release this one can't talk to. */
  private readonly follow: typeof this.update;
  get daemonVersionLive(): boolean {
    return !!this.connection;
  }
  updateProgress: progress.Status | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  get updateMessage(): string {
    return this.updateProgress?.message ?? "";
  }
  private updateFailure: machine_update.Failure | null = null;
  get updateError(): string {
    return this.updateFailure?.summary ?? "";
  }
  get updateLog(): string {
    return this.updateFailure?.detail ?? "";
  }
  folder: string | null = null;
  onChange: () => void = () => {};
  onMachines: () => void = () => {};
  onEffects: (view: Controller) => void = () => {};
  onClipboard: (view: Controller) => Promise<void> = async () => {};
  /** `name` is the machine's, "local" for this one; `remote` whether its
   * daemon runs on another machine; `identity` what tells it apart for its
   * cached workspaces and their order. */
  constructor(
    readonly name: string,
    readonly remote: boolean,
    identity: string[],
    private newPath: machine_path.Factory,
    readonly probe: Probe,
    readonly host: Host,
    /** Brings the machine's daemon to this build: a new way to reach it, or null when it needed nothing. */
    private update?: (signal: AbortSignal, progress: progress.Report) => Promise<machine_path.Factory | null>,
    private currentBuild?: (hello: machine_path.Hello) => boolean,
  ) {
    this.follow = update;
    this.sample = newPath(false, false);
    this.machine = new Machine(this.transport(), this.name, remote);
    // Forwards outlive paths: each connection takes the current one's way.
    // With no browser here, there's nothing to forward links to.
    if (this.sample.ports && webLinks.opensLinks())
      this.machine.forwards = new Forwards({
        prepare: signal => this.ports().prepare(signal),
        dial: (host, port) => this.ports().dial(host, port),
      });
    this.machine.order_scope = JSON.stringify(identity);
    // Links point at the daemon's machine: another one, or this one when the
    // viewer itself runs over SSH.
    this.machine.remote_links = remote || sshViewer();
    this.machine.presence = () => {
      const { status, quiet } = this.display();
      return {
        online: status === "online",
        link_quality: remote ? (status === "online" ? this.stats.quality : quiet ? null : 0) : null,
        connecting: !quiet && (status === "connecting" || status === "stalled" || status === "offline"),
        stopped: status === "attention" || status === "incompatible",
        connection_status: quiet && !this.updateMessage && !this.updateError ? null : this.headerStatus(),
        description: this.description(),
        cached: this.workspaces,
        seen: this.updated > 0,
        stale: this.workspaces_instance !== "" && this.workspaces_instance !== this.instance,
      };
    };
    this.cache = new Cache(identity);
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
  private ports(): Link {
    return this.path?.ports ?? this.sample.ports!;
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
  /** This viewer has had the machine online. */
  get reached(): boolean {
    return this.connected;
  }
  /** Its last attempts to reach the daemon failed: a step now is another try. */
  get failing(): boolean {
    return this.retries > 0;
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
      this.ready = this.displayed = this.settled = true;
    }
  }
  /** The machine's state has been drawn at least once. */
  private settled = false;
  /** Keys typed before a menu opened still reach their pane. */
  deactivate(): void {
    this.selection++;
    this.stream?.reset();
    this.fresh = false;
    this.displayed = false;
    this.interruptInput(true);
    this.next = 0;
  }
  /** Retain unrouted keys only before a cancelled paste; a later Enter must not submit its partial text. */
  takeInput(): Typed[] {
    const input = this.input.take();
    if (this.ui_paste || (this.controller && this.shown && this.controller.input_state.paste !== null)) return [];
    const paste = input.findIndex(pasting);
    return paste < 0 ? input : input.slice(0, paste);
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
    // Typing doesn't hurry an SSH machine's backed-off dial: each would be a
    // handshake, and the keys wait in their pane meanwhile.
    if (!(this.remote && this.status === "offline")) this.next = 0;
    this.onChange();
  }
  enqueue(input: Input, dropped = false): void {
    const queue = this.handoff?.input ?? this.input;
    const limit = this.handoff ? handoff_input_limit : 1024 * 1024;
    if (queue.bytes + input.bytes.length > limit) {
      this.error = "Input queue full; unsent input discarded";
      this.clearInput();
      this.fresh = false;
      return;
    }
    queue.push({ ...input, dropped });
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
        this.interruptInput();
      else if (this.ready && this.resumed && this.generation > held.generation) {
        this.input = held.input;
        this.handoff = null;
      } else return;
    }
    const view = this.view(),
      selection = this.selection,
      epoch = this.input_epoch,
      dirty = view.dirty;
    // Before the machine's state is first drawn, a view with no pane in
    // focus has nowhere for keys to go: they wait for the pane it's making.
    if (!view.input_state.attached || (!this.settled && !view.focused())) return;
    const current = () => this.shown && selection === this.selection && epoch === this.input_epoch && !this.stopped;
    const input = this.input.take();
    this.ui_paste = input.some(pasting);
    this.ui_task = (async () => {
      try {
        for (let start = 0; start < input.length;) {
          if (!current()) return;
          const dropped = input[start].dropped;
          let end = start + 1;
          while (end < input.length && input[end].dropped === dropped) end++;
          await view.input(input.slice(start, end), current, dropped);
          this.last_dropped = dropped;
          start = end;
        }
        this.ui_paste = false;
        if (current()) await view.expireInput(current, this.last_dropped);
      } catch (error) {
        if (current()) view.notice(errors.name(error) ?? "ActionFailed");
      } finally {
        this.ui_paste = false;
        this.ui_task = null;
        // Typing waits in its pane for the next step, which an idle viewer
        // paces at `quiet_ms`: it goes now.
        if (current() && input.length) this.wake();
        else if (current() && !dirty && view.dirty) this.onChange();
      }
    })();
  }
  watchResources(workspace: number | null): void {
    if (this.resource_detail === workspace) return;
    this.resource_detail = workspace;
    this.wake();
  }
  /** The update belongs to the machine. Losing a tunnel leaves its build or transfer running. */
  private async startUpdate(): Promise<void> {
    if (!this.update || this.updating || this.updateError) return;
    const job = (this.updating = new AbortController());
    this.updateProgress = { message: "Checking…" };
    try {
      const factory = await this.update(job.signal, (message, extra) => {
        if (job.signal.aborted) return;
        this.updateProgress = { message, ...extra };
        this.onChange();
      });
      if (job.signal.aborted) return;
      this.update = undefined;
      if (factory) this.newPath = factory;
      // An incompatible or unreachable daemon may now be usable, also when
      // another window or computer moved it meanwhile. A live link does its
      // own handoff; an incompatible daemon left none, whatever keys it held.
      if (!this.shut_down && (this.status === "incompatible" || (factory && !this.checked && !this.handoff)))
        this.reconnect();
    } catch (error) {
      if (job.signal.aborted) return;
      this.updateFailure =
        error instanceof machine_update.Failure
          ? error
          : new machine_update.Failure(errors.name(error) || "MachineUpdateFailed");
      // Its hello says what the machine runs now; an incompatible one doesn't retry the update.
      if (this.status === "incompatible" && !this.shut_down) this.reconnect();
    } finally {
      if (this.updating === job) {
        this.updating = null;
        this.updateProgress = null;
        this.onChange();
      }
    }
  }
  private clearUpdateTimer(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
  }
  private cancelUpdate(): void {
    this.updating?.abort();
    this.updating = null;
    this.updateProgress = null;
    this.updateFailure = null;
    this.clearUpdateTimer();
  }
  /** Whether Ctrl+R takes the machine back from another viewer's release. */
  get reclaimable(): boolean {
    return this.status === "incompatible" && !!this.follow;
  }
  retry(): void {
    if (this.stopped) return;
    if (this.reclaimable) this.update = this.follow;
    if (this.updateError) {
      this.updateFailure = null;
      void this.startUpdate();
      if (this.status === "online") return;
    }
    this.reconnect();
  }
  private reconnect(): void {
    this.shut_down = false;
    this.releaseHandoff();
    this.interruption++;
    this.disconnect();
    this.fresh_connection = this.issue === "error";
    this.status = "connecting";
    this.error = "";
    this.next = 0;
    this.retries = 0;
  }
  headerStatus(now = performance.now()): WorkspaceEntry["connection_status"] {
    if (this.updateError && !this.error)
      return { label: "Update failed", seconds: null, color: "hot", diagnostic: true };
    if (this.updateMessage)
      return {
        label: this.updateMessage,
        metrics: this.updateProgress?.metrics,
        compact: this.updateProgress?.compact,
        seconds: null,
        color: "warm",
        diagnostic: !!this.error,
      };
    const status = this.connectionStatus(now);
    // An SSH machine's failure opens its details from the header, whatever comes next.
    return status && this.remote && this.error ? { ...status, diagnostic: true } : status;
  }
  private connectionStatus(now: number): WorkspaceEntry["connection_status"] {
    switch (this.status) {
      case "attention":
        return { label: this.remote && this.issue === "auth" ? "! auth" : "! error", seconds: null, color: "hot" };
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
      case "incompatible":
        return { label: i18n.t`incompatible`, seconds: null, color: "hot" };
      case "online":
        return this.remote && this.error ? { label: "! error", seconds: null, color: "hot" } : null;
    }
  }
  description(now = performance.now()): string {
    if (this.updateProgress)
      return [this.updateProgress.message, this.updateProgress.metrics].filter(Boolean).join(" ");
    // A move that lost to another viewer's says whose release won; its details keep the failure.
    return this.updateError && !this.reclaimable ? "Update failed" : this.connectionDescription(now);
  }
  connectionDescription(now = performance.now()): string {
    switch (this.status) {
      case "attention":
        return `Attention · ${this.error}`;
      case "connecting":
        return `${this.connected ? "Reconnecting" : "Connecting"}…${this.task ? ` ${Math.max(0, Math.floor((now - this.task_started) / 1000))}s` : ""}${this.path?.progress() ? ` · ${this.path.progress()}` : ""}`;
      case "stalled":
        return `Connection stalled (${Math.max(1, Math.floor((this.stream?.age(now) ?? now - this.task_started) / 1000))}s)${this.racing ? " · trying a fresh SSH connection" : ""}`;
      case "offline":
        return `offline · ${this.error} · retry in ${Math.max(0, Math.ceil((this.next - now) / 1000))}s`;
      case "incompatible":
        if (!this.follow) return "Incompatible Corgi · install a matching version, then retry";
        return `Moved to Corgi ${this.daemonVersion?.version || "another build"}${this.movedBy ? ` by ${this.movedBy}` : ""} · Ctrl+R takes it back`;
      case "online":
        return this.error || "online";
    }
  }
  /** When the machine next wants a step, in `performance.now()` time; a
   * running step says when it's done. */
  due(): number {
    if (this.stopped || this.status === "incompatible" || this.task) return Infinity;
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
    if (this.stopped || this.status === "incompatible") return;
    const now = performance.now();
    if (this.stream && this.status === "online" && this.stream.age(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.trace("remote.connection", "stalled");
      this.fresh = this.ready = false;
    }
    if (this.task && !this.stream && this.status === "online" && this.healthAge(now) >= this.stallMs) {
      this.status = "stalled";
      this.stats.stalled(now);
      this.trace("remote.connection", "stalled");
      this.fresh = this.ready = false;
    }
    const quiet = this.healthAge(now);
    this.stats.progress(quiet, this.stallMs);
    // Failed dials are not progress: keep probing from the last received byte.
    const silent = Math.max(now - (this.stats.lastReceived ?? this.task_started), this.data?.age(now) ?? 0),
      recovering =
        this.connected && (this.status === "connecting" || this.status === "offline") && silent >= this.raceMs,
      // Early in an outage a fresh dial goes every few seconds; a long one
      // gets one as often as retries go, rather than an SSH start every 4 s.
      every = recovering ? (silent < long_outage_ms ? this.stallMs : max_retry_ms) : this.raceMs;
    const due = !this.racing && now - this.raced_at >= every;
    if (
      this.sample.races &&
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
        // A reload closes every connection; the same viewer comes back on
        // the new daemon, and typing waits for it.
        if (errors.is(error, "ServerReloading")) {
          if (this.link && !this.handoff) {
            this.trace("remote.connection", "handoff");
            this.holdHandoffInput();
          }
          this.disconnect(true);
          this.status = "connecting";
          this.next = 0;
          return;
        }
        // This computer's daemon shut down on purpose: the viewer ends, as on a detach.
        if (!this.remote && errors.is(error, "ServerShutdown")) {
          this.detached = true;
          this.onChange();
          return;
        }
        // An SSH machine's is left stopped until the user retries.
        if (errors.is(error, "ServerShutdown")) this.shut_down = true;
        const { issue, detail } = this.path?.diagnose(error) ?? { issue: "error", detail: "" };
        if (issue === "fatal")
          this.fatal = Error(errors.is(error, "ServerRolledBack") ? "ServerRolledBack" : "IncompatibleViewerProtocol");
        this.error = errors.name(error) ?? "ConnectionFailed";
        this.trace("remote.connection", "failed", { error: this.error });
        this.issue = issue === "fatal" ? "error" : issue;
        if (detail) this.error += ` · ${detail}`;
        this.status =
          errors.is(error, "IncompatibleRemoteCorgi") ||
          errors.is(error, "IncompatibleViewerProtocol") ||
          errors.is(error, "ServerRolledBack")
            ? "incompatible"
            : this.issue === "error"
              ? "offline"
              : "attention";
        this.fresh_connection = this.issue === "error";
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
            performance.now() +
            (this.retries <= 1 ? 0 : Math.min(max_retry_ms, 500 * 2 ** Math.min(this.retries - 1, 5)));
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
    const interruption = this.interruption,
      path = this.newPath(true, true, !this.shut_down),
      // Its data connection is dialed alongside, so a race that wins needn't
      // set up another SSH connection before the panes come back.
      data =
        this.remote && this.shown
          ? new viewer_data.Connection(path, this.stats, { machine: this.name, path: "race" })
          : null;
    this.probe_path = path;
    this.racing = true;
    this.raced_at = now;
    this.trace("remote.race", "start");
    // After a sleep the old connection reads online until it's heard from
    // again. A machine not shown has no stream to hear it by: it keeps its own.
    const stream = this.suspect ? this.stream : null,
      heard = stream?.heard ?? 0;
    this.suspect = false;
    let conn: Connection | null = null;
    try {
      const opened = await path.open("control", this.stats, {
        machine: this.name,
        generation: this.generation,
        path: "race",
      });
      conn = opened.connection;
      const hello = opened.hello;
      this.trace("remote.race", "hello");
      // The old connection answering again, or anything else moving on, wins.
      const answered =
        this.status !== "stalled" &&
        this.status !== "connecting" &&
        this.status !== "offline" &&
        !(stream !== null && this.stream === stream && stream.heard <= heard);
      if (interruption !== this.interruption || this.stopped || answered) throw Error("RaceLost");
      if (machine_path.compatible(hello) !== this.instance) throw Error("RaceLost");
      // The old connection is let go; the next connect resumes the link here.
      this.trace("remote.race", "won");
      this.interruption++;
      this.probe_path = null;
      this.disconnect();
      this.dialed = { path, conn, hello, data };
      this.status = "connecting";
      this.next = 0;
      this.retries = 0;
      this.wake();
    } catch (error) {
      this.trace("remote.race", "failed", { error: errors.name(error) ?? "ConnectionFailed" });
      conn?.close();
      data?.close();
      path.close();
    } finally {
      if (this.probe_path === path) {
        this.probe_path = null;
        this.racing = false;
      }
    }
  }
  /** The computer slept: a remote machine's connection may be gone. */
  woke(): void {
    if (this.sample.races && (this.status === "online" || this.status === "stalled")) this.suspect = true;
  }
  /** Keys held for a reload go on as typed: a retry ends the wait, not them. */
  private releaseHandoff(): void {
    if (this.handoff) {
      for (const input of this.input.take()) this.handoff.input.push(input);
      this.input = this.handoff.input;
    }
    this.handoff = null;
  }
  private holdHandoffInput(): void {
    const input = this.input;
    this.input = new Queue<Typed>();
    if (input.bytes > handoff_input_limit) {
      this.clearInput();
      this.error = "Input queue full; unsent input discarded";
    }
    this.handoff = {
      instance: this.instance,
      selection: this.selection,
      navigation: this.navigation_revision,
      pane: this.view().focused()?.id ?? null,
      generation: this.generation,
      until: performance.now() + handoff_ms,
      input: input.bytes <= handoff_input_limit ? input : new Queue<Typed>(),
    };
    this.ready = this.fresh = false;
    this.wake();
  }
  private async connect(): Promise<void> {
    // A quick hello can confirm the last deployment without spawning a helper.
    // A slow or broken dial still lets the update run independently.
    if (this.update && this.currentBuild) {
      this.updateTimer ??= setTimeout(() => {
        this.updateTimer = null;
        void this.startUpdate();
      }, 1500);
    } else void this.startUpdate();
    const previous = this.instance;
    const had_viewer = this.machine.viewer_id !== 0;
    const generation = ++this.generation;
    this.trace("remote.connection", "start");
    let conn: Connection, hello: machine_path.Hello;
    const dialed = this.dialed;
    this.dialed = null;
    const path = (this.path = dialed?.path ?? this.newPath(this.fresh_connection, false, !this.shut_down));
    if (dialed?.data) this.data = dialed.data;
    this.fresh_connection = false;
    // Setting up a remote connection can take many round trips. Open both
    // connections together; bind the data one only after the control one
    // confirms support and the daemon's identity.
    if ((this.remote && this.shown) || (this.separate && this.machine.viewer_id !== 0)) this.openData();
    if (dialed) {
      conn = this.connection = dialed.conn;
      hello = dialed.hello;
    } else {
      ({ connection: conn, hello } = await path.open("control", this.stats, {
        machine: this.name,
        generation,
        path: "primary",
      }));
      // A race may have won meanwhile: this one is left closed, not current.
      try {
        this.current(generation);
      } catch (error) {
        conn.close();
        throw error;
      }
      this.connection = conn;
    }
    this.clearUpdateTimer();
    this.daemonVersion = buildInfo.identity(hello);
    this.movedBy =
      typeof hello.moved_by === "string" ? hello.moved_by.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64) : "";
    if (
      this.update &&
      !this.updating &&
      hello.protocol === protocol.version &&
      hello.viewer_protocol === protocol.viewer_version &&
      this.currentBuild?.(hello)
    ) {
      this.update = undefined;
      this.updateFailure = null;
    } else void this.startUpdate();
    this.trace("remote.connection", "hello");
    conn.onEvent(event => {
      if (this.connection !== conn) return;
      if (event.type === "uninstalled" && !this.remote) {
        this.uninstalled = true;
        this.onChange();
      }
      if (event.type === "viewer.controls") {
        this.controls = event.controls;
        this.wake();
      }
      for (const listener of this.listeners) listener(event);
    });
    this.instance = machine_path.compatible(hello);
    this.machine.executable = hello.executable;
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
    } else if (this.shown) this.openData();
    this.checked = conn;
    // A failed check can follow the same network outage as the dial. Try it again once SSH is back.
    if (this.updateError) {
      this.updateFailure = null;
      void this.startUpdate();
    }
    // A view outlives its connections to one daemon. Another daemon's ids
    // mean nothing to it.
    const same = previous === this.instance;
    const view = this.view();
    if (!same) {
      this.focus = null;
      if (this.shown) {
        view.closeMachineUi();
        // Its agents may have been updated: read their model lists again.
        view.model_cache.expire();
      } else if (
        view.worktree_card.workspace &&
        viewerRef.parts(view.worktree_card.workspace).machine === this.machine.id
      )
        view.worktree_card.clear();
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
    if (!this.resumed) {
      if (had_viewer || this.ui_paste || (this.shown && view.input_state.paste !== null)) this.interruptInput(true);
      view.resetConnection(this.machine);
    }
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
  /** Fails the numbered requests `lost` picks, which can't be sent again:
   * one that went out may have run, so says so. */
  private settleNumbered(lost: (request: Numbered) => boolean): void {
    const kept: Numbered[] = [];
    for (const request of this.numbered)
      if (lost(request)) request.reject(Error(request.seq === null ? "StaleConnection" : "ReplyLost"));
      else kept.push(request);
    this.numbered = kept;
  }
  private daemon: rpc_http.Client | null = null;
  /** The daemon over HTTP where it listens here, for a request that may
   * outlast a connection. */
  private http(): rpc_http.Client | undefined {
    const socket = this.path?.socket;
    if (!socket) return undefined;
    if (this.daemon?.socket !== socket) this.daemon = new rpc_http.Client(socket);
    return this.daemon;
  }
  /** Requests that go over whichever connection is current, and fail when
   * they span a reconnect. Those that must run once go numbered over the
   * link, and survive one. */
  private transport(): Transport {
    const endpoint = this;
    return {
      get daemon() {
        return endpoint.http();
      },
      onEvent: listener => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      remote: this.remote,
      // A remote machine needs a pasted image's file sent to it.
      image: this.remote
        ? async (path, mime, progress) => {
            const generation = this.generation,
              epoch = this.input_epoch,
              upload = this.path?.upload;
            if (!this.checked || !upload) throw Error("StaleConnection");
            const result = await upload(path, mime, this.instance, this.cancellation.signal, (received, total) => {
              if (generation !== this.generation || epoch !== this.input_epoch || this.stopped) return;
              progress?.(received, total);
              this.wake();
            });
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
        // Pane contents take the data connection, apart from input. Review's
        // file lists and diffs, the file peek's and link pictures' reads, and
        // a chat moved into a pane take it too, and never the control
        // connection, opening it on a machine not shown, such as a prompt
        // conversation's.
        let conn: Connection | null, keepalive: ReturnType<typeof setInterval> | undefined;
        if (
          [
            "review.read",
            "review.diffs",
            "file.stat",
            "file.read",
            "file.count",
            "file.scan",
            "file.thumbnail",
            "job.poll",
            "job.cancel",
            "headless.handoff",
          ].includes(op)
        ) {
          if (!this.checked) throw Error("StaleConnection");
          // One that failed or closed is dialed again, unless a viewer's stream
          // is bound to it: then the reconnect that brings the stream back does.
          if (this.data?.dead && !this.opened) {
            this.data.close();
            this.data = null;
          }
          const data = await this.openData().openedTo(this.instance);
          this.current(generation);
          // Git may take longer than the silence a connection allows, and one
          // with no stream on it hears nothing else meanwhile.
          keepalive = setInterval(() => void data.request("ping").catch(() => {}), this.review_ping_ms);
          conn = data;
        } else conn = protocol.readsPane(op) && this.opened ? (this.data?.channel ?? this.checked) : this.checked;
        if (!conn) throw Error("StaleConnection");
        try {
          const reply = await conn.request(op, ...args);
          this.current(generation);
          return reply;
        } finally {
          clearInterval(keepalive);
        }
      },
      streamed: async (op, fields, more) => {
        const generation = this.generation,
          conn = this.checked;
        if (!conn) throw Error("StaleConnection");
        // A search may find nothing for longer than the silence a connection
        // allows, and over SSH the viewer's stream runs on another one.
        const keepalive = setInterval(() => void conn.request("ping").catch(() => {}), this.review_ping_ms);
        try {
          // Parts from a connection since replaced belong to no one.
          const reply = await conn.streamed(op, fields, part => {
            if (generation === this.generation) more(part);
          });
          this.current(generation);
          return reply;
        } finally {
          clearInterval(keepalive);
        }
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
        // A viewer opened on a folder starts there, so the daemon's first
        // workspace takes it rather than one more being made for it.
        this.bell.seq = await viewer.openMode(view, this.folder ?? this.path!.home, this.probe.theme, this.onboarding);
        this.current(generation);
        this.onboarding = false;
      }
      machine.remote_links = this.remote || sshViewer();
      const previews = view.launch_previews;
      let data = this.connection!;
      if (this.separate && this.link) {
        const lane = this.openData();
        data = await lane.bind(this.link, this.instance);
        this.current(generation);
        machine.viewer_id = lane.viewer;
      }
      this.opened = true;
      // Switching machines during attachment may have replaced the history stream.
      if (this.shown && view.launch_previews !== previews) view.launch_previews.connect(machine.connection);
      this.stream = new Stream(
        this.connection!,
        () => {
          if (generation === this.generation && !this.stopped) this.wake();
        },
        this.incremental,
        data,
        // Over SSH a link is stalled after 4 s or more: a frame a second shows
        // it's alive. Each costs a round trip on the wire.
        this.remote ? 1000 : 250,
      );
      visible &&= this.shown && selection === this.selection;
      if (visible && this.folder !== null) {
        const folder = this.folder;
        this.folder = null;
        try {
          await view.perform({ name: "open", value: folder });
        } catch (error) {
          view.notice((error as Error).message);
        }
        this.current(generation);
      }
    }
    visible &&= this.shown && selection === this.selection;
    if (this.opened) {
      const stream = this.stream!;
      stream.check();
      const taken = stream.take();
      let reply = taken?.frame ?? null;
      if (
        this.controls.length &&
        (visible ||
          viewer.leadingLinks(this.controls, machine.last_control).some(c => BigInt(c.seq) > machine.last_control))
      ) {
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
        if (machine.waiting_controls.length) {
          // Tried again each step, until the session shows what they name.
          const seen = new Set(machine.waiting_controls.map(c => c.seq));
          this.controls = [...machine.waiting_controls, ...this.controls.filter(c => !seen.has(c.seq))];
          machine.waiting_controls = [];
        }
        if (machine.runtime.snapshot_epoch !== snapshot_epoch + (reply.session ? 1 : 0)) stream.reset();
        if (!attached) {
          // A replaced local daemon has the viewer run its build; a remote
          // one's build isn't on this computer, so it's only reconnected to.
          if (view.executable && !this.remote) {
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
      if (visible && this.displayed && selection === this.selection && !this.acknowledging && stream.room()) {
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
        // Without room, typing waits in the pane and goes once some lands.
        const bytes = Math.min(pane.terminal.pending.length, input_chunk);
        if (bytes && this.status === "online" && stream.room(bytes))
          stream.send(() => pane.terminal.flush(input_chunk), bytes);
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
        worktree_detail: view.worktreeDetailWanted(machine),
      });
      this.current(generation);
      view.receiveSnapshot(snapshot, machine);
      machine.runtime.receiveResources(snapshot.resources);
      changed = true;
      // Typing held for a machine no longer shown goes once it's back.
      for (const pane of machine.runtime.panes) if (pane.terminal.pending.length) await pane.terminal.flush();
      this.current(generation);
    }
    if (!this.stream || this.stream.age() < this.stallMs) {
      if (this.status !== "online") this.trace("remote.connection", "online");
      this.status = "online";
      this.error = "";
    }
    this.retries = 0;
    this.connected = true;
    // Started again since, it's started again should it stop.
    this.shut_down = false;
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
  /** Ends pastes and uploads, and unless kept, keys the view hasn't routed;
   * keys already typed into panes still go once the machine is reachable. */
  private interruptInput(keepUnrouted = false): void {
    this.handoff = null;
    this.input_epoch++;
    this.cancellation.abort();
    this.cancellation = new AbortController();
    this.ready = false;
    if (keepUnrouted) {
      for (const input of this.takeInput()) this.input.push(input);
    } else this.input = new Queue<Typed>();
    if (this.controller && this.shown) this.controller.cancelPaste();
  }
  private clearInput(): void {
    for (const pane of this.machine.runtime.panes) {
      pane.terminal.pending = [];
    }
    this.interruptInput();
    // Keys on their way belong to the machine shown.
    if (!this.controller || !this.shown) return;
    const view = this.controller;
    view.cancelInput();
    view.paste_target = null;
    view.paste_progress = null;
    view.prefix = false;
  }
  /** Starts the data connection on the current path, unless one is open. */
  private openData(): viewer_data.Connection {
    if (!this.path) throw Error("StaleConnection");
    return (this.data ??= new viewer_data.Connection(this.path, this.stats, { machine: this.name, path: "data" }));
  }
  private disconnect(keepTask = false, keepProbe = false): void {
    this.generation++;
    if (!keepTask) this.task = null;
    if (!keepProbe) {
      this.racing = false;
      this.probe_path?.close();
      this.probe_path = null;
    }
    this.data?.close();
    this.data = null;
    this.controls = [];
    this.connection?.close();
    this.connection = null;
    this.checked = null;
    // A won race not yet taken up goes with the rest.
    this.dialed?.conn.close();
    this.dialed?.data?.close();
    this.dialed?.path.close();
    this.dialed = null;
    // Numbered requests wait for the link to be resumed.
    this.linked = false;
    this.stream = null;
    this.path?.close();
    this.path = null;
    this.opened = false;
    this.acknowledging = false;
    this.fresh = this.ready = false;
    // Uploads end with the connection; typing waits for the next one.
    this.cancellation.abort();
    this.cancellation = new AbortController();
    if (this.stopped) this.clearInput();
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.machine.forwards?.close();
    this.cancelUpdate();
    this.disconnect();
    this.settleNumbered(() => true);
    await this.task;
    await this.ui_task;
    this.machine.runtime.destroy();
  }
}
/** The endpoint for this machine's daemon on `socket`; `start` starts it if needed. */
export function localEndpoint(
  socket: string,
  probe: Probe,
  host: Host,
  start?: () => Promise<void>,
  running?: boolean,
): Endpoint {
  return new Endpoint("local", false, [socket], machine_path.local(socket, start, running), probe, host);
}
/** Goes where switching to the machine asked, if it's still there. */
function show(view: Controller, at: Focus): void {
  const runtime = view.runtime;
  if ("workspace" in at) {
    if (runtime.workspaces.index(at.workspace) !== null) view.switchWorkspace(at.workspace);
  } else if (
    "pane" in at ? runtime.workspaces.owner(at.pane) : agentRows.sessions(runtime).some(s => s.id === at.headless)
  )
    view.selectAgent(
      "pane" in at ? viewerRef.pane(view.machine.id, at.pane) : viewerRef.headless(view.machine.id, at.headless),
    );
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
