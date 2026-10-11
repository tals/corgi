import { closeSync, fstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Server } from "../server";
import type { Client } from "../peer";
import { ReadyLoop, AsyncFD, n, ptr } from "../native_bridge";
import { native as fdNative } from "../fd_loop";
import { Theme } from "../theme";
import * as checkpoint from "./checkpoint";
import * as recovery from "./recovery";
import * as migrations from "./migrations";
import * as json from "../json";
import { Worker as SummaryWorker } from "../activity/worker";
import * as build_id from "../build_id";

export const terminal_abi = 0xa826bd22ebcdbe60n;
export const update_abi = `1-${terminal_abi.toString(16)}`;
const savedFields = [
  "viewer",
  "viewer_id",
  "active_seq",
  "view_workspace",
  "view_focus",
  "interests",
  "watched",
  "controls",
  "next_control",
  "last_control",
  "protocol_version",
  "subscribed",
  "watching",
  "watch_viewer",
  "launch_preview",
  "snapshot_revision",
  "touched",
] as const;
// Shell launchers use low descriptors (dash reads its script through fd 10).
// Keep transferred handles above that range even when the candidate is a script.
const inherited_start = 64;

function captureClient(client: Client) {
  return {
    fd: client.fd,
    input: client.savedInput().toString("base64"),
    output: client.output.subarray(client.sent).toString("base64"),
    ...Object.fromEntries(savedFields.map(key => [key, client[key]])),
  };
}
export function restoreClient(server: Server, value: unknown): Client {
  const { fd, input, output, ...fields } = json.object(value),
    client = server.addClient(fd, false);
  checkpoint.hydrate(client, fields);
  if (client.snapshot_revision !== null) client.snapshot_revision = BigInt(client.snapshot_revision);
  for (const control of client.controls) control.seq = BigInt(control.seq);
  for (const interest of client.interests) {
    if (interest.known) {
      interest.known.identity = BigInt(interest.known.identity);
      interest.known.revision = BigInt(interest.known.revision);
    }
  }
  if (client.launch_preview) {
    client.launch_preview.history_epoch = BigInt(client.launch_preview.history_epoch);
    client.launch_preview.history_sent = BigInt(client.launch_preview.history_sent);
  }
  client.restoreInput(Buffer.from(input, "base64"));
  client.output = Buffer.from(output, "base64");
  return client;
}
export function captureManifest(server: Server, requester: Client) {
  return {
    version: migrations.handoff_version,
    update_abi,
    terminal_abi,
    listener: server.listener,
    requester: requester.fd,
    runtime: checkpoint.capture(server.runtime, true),
    summaries: server.summaries?.capture() ?? null,
    // A one-shot HTTP request is not handed over; its sender sees the close.
    clients: server.clients.filter(client => client.http === "no").map(captureClient),
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
  state.listener = add(state.listener);
  for (const client of state.clients) client.fd = add(client.fd);
  state.requester = add(state.requester);
  for (const pane of state.runtime.panes) pane.screen.fd = add(pane.screen.fd);
  for (const session of state.runtime.sessions) {
    session.stdin = add(session.stdin);
    session.stdout = add(session.stdout);
  }
  // Inference workers expose the same allowlisted pipe fields as native sessions.
  for (const session of state.summaries?.pool?.slots ?? []) {
    if (session) {
      session.stdin = add(session.stdin);
      session.stdout = add(session.stdout);
    }
  }
  return { fds, state };
}
export async function replace(server: Server, requester: Client, executable: string): Promise<void> {
  if (!isAbsolute(executable)) throw Error("InvalidExecutable");
  await server.flushWorkspaceWrites();
  await recovery.save(server.runtime, server.socket);
  const deadline = Date.now() + 1500;
  for (;;) {
    let pending = false;
    for (const p of server.runtime.panes) {
      p.terminal.flush();
      pending ||= p.terminal.pendingBytes > 0;
    }
    // Queued session input travels in the handoff.
    for (const s of server.runtime.sessions) s.flush();
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
  await server.summaries?.pause();
  server.pause();
  const fds = new Int32Array(2);
  let stateFD = -1,
    controlFD = -1,
    childFD = -1,
    loop: ReadyLoop | undefined,
    candidate: Bun.Subprocess | undefined,
    timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const manifest = captureManifest(server, requester);
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
    n.probe_close(childFD);
    childFD = -1;
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
      if (["MissingStateVersion", "InvalidStateVersion", "UnsupportedStateVersion"].includes(ready)) throw Error(ready);
      console.error("reload candidate:", ready);
      throw Error("ReloadCandidateFailed");
    }
    await control.write(Buffer.from("commit\n"));
    // Destructors would kill processes and unlink the inherited listener.
    process.exit(0);
  } catch (error) {
    candidate?.kill("SIGKILL");
    if (candidate) await candidate.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    loop?.close();
    for (const fd of [stateFD, controlFD, childFD]) if (fd >= 0) n.probe_close(fd);
    server.resume();
    server.summaries?.unpause();
  }
}
export async function importAndRun(
  socket: string,
  executable: string,
  stateFD: number,
  controlFD: number,
): Promise<void> {
  const loop = new ReadyLoop(),
    control = new AsyncFD(loop, controlFD);
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
      BigInt(m.terminal_abi) !== terminal_abi ||
      m.clients.length > 32
    )
      throw Error("IncompatibleCheckpoint");
    const server = new Server(socket, executable, build_id.of(executable));
    restoreMetadata(server, m);
    server.listener = m.listener;
    fdNative.fd_cloexec(m.listener);
    server.theme = Object.assign(new Theme(), m.theme);
    await checkpoint.restore(server.runtime, m.runtime, true, socket, executable);
    if (m.summaries) server.summaries = SummaryWorker.restore(m.summaries);
    for (const pane of server.runtime.panes) if (pane.terminal.fd >= 0) fdNative.fd_cloexec(pane.terminal.fd);
    for (const saved of m.clients) {
      if (saved.interests.length > 64) throw Error("InvalidCheckpoint");
      fdNative.fd_cloexec(saved.fd);
      const client = restoreClient(server, saved);
      if (saved.fd === m.requester)
        client.queue({ ok: true, server_pid: process.pid, panes: server.runtime.panes.length });
    }
    await control.write(Buffer.from("ready\n"));
    if ((await line(control, 32)) !== "commit") throw Error("ReloadNotCommitted");
    control.close();
    loop.close();
    server.runtime.adopt();
    for (const session of server.runtime.sessions) session.adopt();
    server.summaries?.inherit();
    server.summaries?.activate();
    await server.run();
  } catch (error) {
    try {
      await control.write(Buffer.from((error instanceof Error ? error.message : String(error)) + "\n"));
    } catch {}
    if (process.env.CORGI_DEBUG) console.error(error);
    process.exit(1);
  }
}
