import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Server } from "../server";
import type { Client } from "../peer";
import { ReadyLoop, AsyncFD, n, ptr } from "../native_bridge";
import { native as fdNative } from "../fd_loop";
import { Theme } from "../theme";
import * as checkpoint from "./checkpoint";
import * as recovery from "./recovery";
import * as migrations from "./migrations";
import * as handoff_rollback from "./handoff_rollback";
import * as json from "../json";
import * as os from "../os";
import * as rpc_http from "../rpc_http";
import * as text from "../text";
import * as wire_websocket from "../wire_websocket";
import { Worker as SummaryWorker } from "../activity/worker";
import { Worker as UsageWorker } from "../usage/worker";
import * as build_id from "../build_id";
import * as setup from "../inference/setup";
import * as breadcrumbs from "../breadcrumbs";
import * as observers from "../observer_service";
import * as link from "../link";
import * as start_lock from "../start_lock";

export const terminal_abi = 0xa826bd22ebcdbe60n;
export const update_abi = `1-${terminal_abi.toString(16)}`;
// Shell launchers use low descriptors (dash reads its script through fd 10).
// Keep transferred handles above that range even when the candidate is a script.
const inherited_start = 64;

/** What a handoff carries: the runtime and the links clients resume, never
 * their connections. `requester` is the socket the candidate answers the
 * reload on; this process relays the answer. */
export function captureManifest(
  server: Server,
  requester = -1,
  request_id: number | null = null,
  lock = -1,
  older_updater = false,
) {
  return {
    version: migrations.handoff_version,
    update_abi,
    terminal_abi,
    instance: server.instance,
    requester,
    request_id,
    /** XXX: Remove for next protocol bump. An older build asked for this
     * reload, and checks the candidate in with JSON lines. */
    older_updater,
    /** The start lock, held until the candidate listens: clients wait meanwhile. */
    start_lock: lock,
    runtime: checkpoint.capture(server.runtime, true),
    summaries: server.summaries?.capture() ?? null,
    usage: server.usage?.capture() ?? null,
    links: [...server.links.values()].map(l => {
      const saved = l.capture();
      // The connection carrying it closes with the handoff; its client resumes it.
      const client = server.clients.find(client => !client.dead && client.link === l);
      if (client) {
        saved.detached_at = Date.now();
        if (client.viewer) saved.viewer = link.viewerOf(client);
      }
      return saved;
    }),
    theme: server.theme,
    preferred_workspace: server.preferred_workspace,
    default_folder_pending: server.default_folder_pending,
    next_viewer: server.next_viewer,
    next_active: server.next_active,
    bell_seq: server.bell_seq,
    last_bell: server.last_bell,
    last_bell_kind: server.last_bell_kind,
  };
}
export function restoreMetadata(server: Server, value: unknown): void {
  const saved = json.object(value);
  if (typeof saved.instance === "string") Object.assign(server, { instance: saved.instance });
  for (const key of [
    "preferred_workspace",
    "default_folder_pending",
    "next_viewer",
    "next_active",
    "last_bell",
    "last_bell_kind",
  ] as const)
    if (saved[key] !== undefined) Object.assign(server, { [key]: saved[key] });
  if (saved.bell_seq !== undefined) server.bell_seq = BigInt(saved.bell_seq);
  for (const l of saved.links ?? []) {
    const restored = link.Link.restore(l);
    server.links.set(restored.id, restored);
  }
}
async function line(control: AsyncFD, limit = 1024): Promise<string> {
  const bytes = Buffer.alloc(limit);
  let used = 0;
  while (used < bytes.length) {
    const size = await control.read(bytes.subarray(used));
    if (!size) throw Error("ReloadCandidateFailed");
    used += size;
    const end = bytes.indexOf(10, 0);
    if (end >= 0 && end < used) return bytes.toString("utf8", 0, end);
  }
  throw Error("ReloadCandidateFailed");
}
function descriptors(manifest: any): { fds: number[]; state: any } {
  const state = json.clone(manifest),
    fds: number[] = [],
    mapped = new Map<number, number>();
  const add = (fd: number) => {
    if (fd < 0) return fd;
    let target = mapped.get(fd);
    if (target === undefined) {
      target = inherited_start + fds.length;
      mapped.set(fd, target);
      fds.push(fd);
    }
    return target;
  };
  // XXX: Remove for next protocol bump. An older candidate also takes a listener and its clients.
  if ("listener" in state) state.listener = add(state.listener);
  if ("start_lock" in state) state.start_lock = add(state.start_lock);
  for (const client of state.clients ?? []) client.fd = add(client.fd);
  state.requester = add(state.requester);
  for (const pane of state.runtime.panes) pane.screen.fd = add(pane.screen.fd);
  for (const session of state.runtime.sessions) session.client.handles = session.client.handles.map(add);
  for (const slot of state.summaries?.pool?.slots ?? []) if (slot) slot.client.handles = slot.client.handles.map(add);
  return { fds, state };
}
export async function replace(
  server: Server,
  requester: Client,
  executable: string,
  request_id: number | null = null,
  /** XXX: Remove for next protocol bump. A retry for a format-6 candidate. */
  legacy = false,
): Promise<void> {
  if (!isAbsolute(executable)) throw Error("InvalidExecutable");
  // XXX: Remove for next protocol bump. A daemon still answering an older
  // build's listener finishes that first, unless that build asked: then a
  // reload that doesn't happen leaves it answering.
  if (!server.older(requester)) await server.serving();
  // From here, a request that arrives waits for the new daemon, or for this
  // one if the reload doesn't happen.
  server.hold();
  try {
    await prepare(server);
  } catch (error) {
    server.release();
    throw error;
  }
  server.closeVoice();
  // Connections stay open and hold their requests until the candidate commits or fails.
  server.pause();
  breadcrumbs.record("reloading");
  const fds = new Int32Array(2);
  let stateFD = -1,
    controlFD = -1,
    childFD = -1,
    replyFD = -1,
    relayFD = -1,
    listener = -1,
    lock = -1,
    loop: ReadyLoop | undefined,
    candidate: Bun.Subprocess | undefined,
    timeout: ReturnType<typeof setTimeout> | undefined,
    committed = false;
  // XXX: Remove for next protocol bump. An older candidate adopts a listener
  // here, which moves over the socket once it commits.
  const listening = legacy ? join(dirname(server.socket), `.r${process.pid}`) : null;
  try {
    // The candidate answers the reload with one line on this pair; this process relays it.
    if (n.probe_pair(ptr(fds))) throw Error("SocketPairFailed");
    [replyFD, relayFD] = fds;
    // Clients that find no daemon while it's held wait; this process and the
    // candidate hold it until the candidate listens and this one is gone.
    lock = (await start_lock.take(server.socket)) ?? -1;
    const captured = captureManifest(server, relayFD, request_id, lock, server.older(requester));
    if (listening) {
      rmSync(listening, { force: true });
      listener = os.listen(listening);
    }
    const manifest = listening ? handoff_rollback.downgrade(captured, listener) : captured;
    const transfer = descriptors(manifest),
      bytes = Buffer.from(json.stringify(transfer.state));
    if (bytes.length > 256 * 1024 * 1024) throw Error("CheckpointTooLarge");
    const filename = `${server.socket}.handoff-${process.pid}-${crypto.randomUUID()}`;
    stateFD = openSync(filename, "wx+", 0o600);
    unlinkSync(filename);
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(stateFD, bytes, offset, bytes.length - offset, offset);
    if (n.probe_pair(ptr(fds))) throw Error("SocketPairFailed");
    [controlFD, childFD] = fds;
    loop = new ReadyLoop();
    const control = new AsyncFD(loop, controlFD);
    const staged: number[] = [],
      minimum = inherited_start + transfer.fds.length + 64;
    const stage = (fd: number) => {
      const copy = n.probe_dup_above(fd, minimum);
      if (copy < 0) throw Error("DescriptorCopyFailed");
      staged.push(copy);
      return copy;
    };
    const empty = openSync("/dev/null", "r+");
    try {
      // posix_spawn file actions run in order: source handles must not alias
      // any target slot, including the placeholders protecting shell fd 10.
      const state = stage(stateFD),
        control = stage(childFD),
        inherited = transfer.fds.map(stage),
        placeholder = stage(empty);
      const reserved = Array.from({ length: inherited_start - 5 }, () => placeholder);
      try {
        candidate = Bun.spawn([executable, "__handoff", "3", "4"], {
          env: { ...process.env, CORGI_APP_EXE: executable, CORGI_HANDOFF_RESERVED_FDS: `5:${inherited_start}` },
          stdio: ["ignore", 1, 2, state, control, ...reserved, ...inherited],
        });
      } catch {
        throw Error("ReloadCandidateFailed");
      }
    } finally {
      closeSync(empty);
      for (const fd of staged) n.probe_close(fd);
    }
    for (const fd of [childFD, relayFD, listener]) if (fd >= 0) n.probe_close(fd);
    childFD = relayFD = listener = -1;
    closeSync(stateFD);
    stateFD = -1;
    const ready = await Promise.race([
      line(control),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Error("ReloadCandidateFailed")), 15000);
      }),
    ]);
    clearTimeout(timeout);
    if (ready !== "ready") {
      if (
        ["MissingStateVersion", "InvalidStateVersion", "UnsupportedStateVersion", "InvalidCheckpoint"].includes(ready)
      )
        throw Error(ready);
      console.error("reload candidate:", ready);
      throw Error("ReloadCandidateFailed");
    }
    await control.write(Buffer.from("commit\n"));
    committed = true;
    // Closing a connection must not end what its client started: the candidate runs it now.
    server.handed_off = true;
    if (listening) renameSync(listening, server.socket);
    // The candidate answers once it listens on the socket.
    let answer: unknown;
    try {
      answer = json.parse(
        await Promise.race([
          line(new AsyncFD(loop, replyFD), 1024 * 1024),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(Error("ReloadReplyTimedOut")), 30000);
          }),
        ]),
      );
    } catch (error) {
      console.error("reload reply:", error);
    }
    await handOver(server, requester, answer, legacy);
    // Destructors would kill processes the candidate now runs.
    process.exit(0);
  } catch (error) {
    // Commit is irreversible: the candidate runs the session now.
    if (committed) process.exit(0);
    candidate?.kill("SIGKILL");
    if (candidate) await candidate.exited;
    if (legacy || !handoff_rollback.supported(error)) throw error;
  } finally {
    clearTimeout(timeout);
    loop?.close();
    for (const fd of [stateFD, controlFD, childFD, replyFD, relayFD, listener]) if (fd >= 0) n.probe_close(fd);
    if (!committed && lock >= 0) start_lock.release(lock);
    if (listening) rmSync(listening, { force: true });
    if (!committed) {
      server.resume();
      observers.unpause(server);
    }
  }
  // XXX: Remove for next protocol bump. A candidate that reads no newer than format 6.
  return replace(server, requester, executable, request_id, true);
}
/** Saves and settles what a reload hands over: workspaces, recovery, input
 * panes haven't read yet, and the observers. */
async function prepare(server: Server): Promise<void> {
  await server.flushWorkspaceWrites();
  await recovery.save(server.runtime, server.socket);
  const deadline = Date.now() + 1500;
  for (;;) {
    let pending = false;
    for (const p of server.runtime.panes) {
      p.terminal.flush();
      pending ||= p.terminal.pendingBytes > 0;
    }
    if (!pending) break;
    if (Date.now() >= deadline) {
      // A program that stops reading must not block reloads; its unread input is lost.
      for (const p of server.runtime.panes) {
        const bytes = p.terminal.pendingBytes;
        if (!bytes) continue;
        console.error(`reload: dropped ${bytes} unread input bytes for pane ${p.id}`);
        p.terminal.dropPending();
      }
      break;
    }
    await Bun.sleep(5);
  }
  await observers.pause(server);
}
/** After a commit: answers the reload, sends requests that arrived meanwhile
 * to the new daemon, and closes every connection so its client reconnects. */
async function handOver(server: Server, requester: Client, answer: unknown, legacy: boolean): Promise<void> {
  requester.queue(answer ?? { err: "ReloadReplyTimedOut" });
  // Requests held during the reload, and any still arriving, go on to the
  // candidate, which has the socket now. A sender that hangs up cancels its
  // request there too.
  const candidate = new rpc_http.Client(server.socket),
    relayed: Promise<void>[] = [],
    senders = new Map<Client, AbortController>();
  server.relay = client => {
    const sent = new AbortController();
    senders.set(client, sent);
    relayed.push(
      (async () => {
        const value = client.take();
        try {
          client.queue(answer ? await candidate.post(value, undefined, undefined, sent.signal) : { err: "Reloading" });
        } catch (error) {
          client.queue({ err: error instanceof Error ? error.message : String(error) });
        }
      })(),
    );
  };
  server.closing = client => senders.get(client)?.abort();
  // A sender that hung up meanwhile gave its request up, but a hook's event still applies.
  for (const client of server.clients)
    if (client.http && client.waiting && (!client.dead || client.pending[0]?.op === "hook")) server.relay(client);
  // A connection the kernel queued but this daemon never took is reset; its
  // sender sees the start lock this process still holds, and sends again.
  server.stopListening();
  const stopped = performance.now();
  // A compressed reply may still be in its encoder; closing would drop it.
  const until = performance.now() + 1000;
  while (server.clients.some(client => !client.dead && client.queued) && performance.now() < until) await Bun.sleep(5);
  // Viewers move to the new daemon now, not after a slow forwarded request.
  for (const client of [...server.clients])
    if (!client.http)
      client.close(
        legacy ? wire_websocket.rolled_back : wire_websocket.reloading,
        legacy ? "rolled back" : "reloading",
      );
  // Replies and close frames leave before the process does, with those to
  // requests that were still arriving when listening stopped.
  for (let seen = -1; seen !== relayed.length;) {
    seen = relayed.length;
    await Promise.all(relayed);
    while (server.answering() && relayed.length === seen && performance.now() < until + 1000) await Bun.sleep(5);
  }
  // The lock outlives the listener long enough for a reset sender to see it.
  await Bun.sleep(Math.max(0, stopped + 100 - performance.now()));
}
export async function importAndRun(
  socket: string,
  executable: string,
  stateFD: number,
  controlFD: number,
): Promise<void> {
  const loop = new ReadyLoop(),
    control = new AsyncFD(loop, controlFD);
  let server: Server | null = null;
  try {
    fdNative.fd_cloexec(stateFD);
    fdNative.fd_cloexec(controlFD);
    const bytes = readFileSync(stateFD, "utf8");
    n.probe_close(stateFD);
    if (process.env.CORGI_HANDOFF_RESERVED_FDS === `5:${inherited_start}`) {
      const nullDevice = fstatSync(0);
      for (let fd = 5; fd < inherited_start; fd++)
        try {
          const stat = fstatSync(fd);
          // The interpreter may already have reused a placeholder slot.
          if (stat.isCharacterDevice() && stat.dev === nullDevice.dev && stat.rdev === nullDevice.rdev)
            n.probe_close(fd);
        } catch {}
      delete process.env.CORGI_HANDOFF_RESERVED_FDS;
    }
    if (Buffer.byteLength(bytes) > 256 * 1024 * 1024) throw Error("CheckpointTooLarge");
    const { value: m } = migrations.decode("handoff", bytes);
    if (
      (m.update_abi !== null && m.update_abi !== undefined && m.update_abi !== update_abi) ||
      BigInt(m.terminal_abi) !== terminal_abi
    )
      throw Error("IncompatibleCheckpoint");
    server = new Server(socket, executable, build_id.of(executable));
    server.imported = true;
    restoreMetadata(server, m);
    for (const fd of [m.requester, m.start_lock ?? -1, ...retiredFds(m)]) if (fd >= 0) fdNative.fd_cloexec(fd);
    server.start_lock = m.start_lock ?? -1;
    // XXX: Remove for next protocol bump. An older build that asked for this
    // reload checks the daemon in: on the listener a JSON-lines daemon handed
    // over, or on one bound for it.
    server.older_updater = m.older_updater === true;
    if (m.retired?.listener >= 0) {
      server.older_listener = m.retired.listener;
      server.older_updater = m.retired.clients.some((client: any) => client.fd === m.requester);
    }
    server.theme = Object.assign(new Theme(), m.theme);
    const repairs = await checkpoint.restore(server.runtime, m.runtime, true, socket, executable);
    // The snapshot keeps what programs set, not the host colors under them.
    for (const pane of server.runtime.panes) pane.terminal.applyTheme(server.theme);
    await recovery.recordRepairs(socket, m.runtime, repairs, executable);
    if (m.summaries) {
      server.summaries = SummaryWorker.restore(m.summaries);
      // Handoffs carry the model choice; what it is used for lives in settings.
      server.summaries.uses = setup.loadUses(setup.path(server.socket));
      server.summaries.link_names = !setup.off(setup.path(server.socket));
    }
    if (m.usage) server.usage = UsageWorker.restore(m.usage);
    for (const pane of server.runtime.panes) if (pane.terminal.fd >= 0) fdNative.fd_cloexec(pane.terminal.fd);
    // The requester hears back once this daemon answers on the socket.
    const restored = server;
    server.listened = () => answer(m, restored.runtime.panes.length);
    // A socket this daemon can't bind stops the reload while the old one can carry on.
    server.bind();
    await control.write(Buffer.from("ready\n"));
    if ((await line(control, 32)) !== "commit") throw Error("ReloadNotCommitted");
    control.close();
    loop.close();
    server.runtime.adopt();
    for (const session of server.runtime.sessions) session.adopt();
    server.summaries?.inherit();
    server.summaries?.activate();
    server.usage?.activate();
    await server.run();
  } catch (error) {
    server?.unbind();
    try {
      await control.write(Buffer.from((error instanceof Error ? error.message : String(error)) + "\n"));
    } catch {}
    if (process.env.CORGI_DEBUG) console.error(error);
    process.exit(1);
  }
}
/** Answers the reload on the socket its sender gave, and lets go of an older sender's connections. */
function answer(m: any, panes: number): void {
  const reply = json.stringify({
    ok: true,
    server_pid: process.pid,
    panes,
    ...(m.request_id === null || m.request_id === undefined ? {} : { request_id: m.request_id }),
  });
  const retired = m.retired;
  // XXX: Remove for next protocol bump. A format-6 sender hands over its
  // listener and its clients' JSON-line connections. Their viewers can't
  // reach this daemon; they hear why, as an older daemon would say it.
  if (retired) {
    for (const client of retired.clients)
      if (client.fd !== m.requester) {
        if (client.viewer) send(client.fd, '{"err":"UnsupportedViewerProtocol"}\n');
        n.probe_close(client.fd);
      }
  }
  if (m.requester < 0) return;
  // A format-6 daemon, which hands over its listener, doesn't hand over an
  // HTTP requester as a client, nor its reply; this daemon sends it.
  const http = retired && retired.listener >= 0 && !retired.clients.some((client: any) => client.fd === m.requester);
  const body = reply + "\n";
  send(
    m.requester,
    http
      ? `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${text.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      : body,
  );
  n.probe_close(m.requester);
}
/** Writes a short message to a socket, for best effort. */
function send(fd: number, message: string): void {
  try {
    writeSync(fd, message);
  } catch {}
}
function retiredFds(m: any): number[] {
  if (!m.retired) return [];
  return [m.retired.listener, ...m.retired.clients.map((client: any) => client.fd)];
}
