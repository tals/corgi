import { milliTimestamp } from "../clock";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces, endianness } from "node:os";
import { readFile, readdir, readlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { identify } from "../detection";
import { processTree } from "../os";
import type { Runtime } from "../runtime";
export type Kind = "loopback" | "tailscale" | "vpn" | "network";
export type Interface = {
  name: string;
  address: string;
  kind: Kind;
  ipv6: boolean;
};
export type Scheme = "unknown" | "http" | "https";
export type Endpoint = {
  label: string;
  label_pending: boolean;
  pid: number;
  pane: number;
  name: string;
  transport: "tcp" | "udp";
  bind_address: string;
  port: number;
  ipv6: boolean;
  interfaces: Interface[];
  scheme: Scheme;
  http_status: number | null;
  probed_at: number;
};
export type Work = { id: number; background: number; endpoints: Endpoint[] };
export class Snapshot {
  processes_available = false;
  ports_available = false;
  workspaces: Work[] = [];
  workspace(id: number): Work {
    return (
      this.workspaces.find(w => w.id === id) ?? {
        id,
        background: 0,
        endpoints: [],
      }
    );
  }
  same(other: Snapshot) {
    return (
      JSON.stringify(this, (_k, v) => (_k === "probed_at" ? undefined : v)) ===
      JSON.stringify(other, (_k, v) => (_k === "probed_at" ? undefined : v))
    );
  }
}
export function sshViewer() {
  return ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].some(k => !!process.env[k]);
}
export function loopback(address: string) {
  return address.startsWith("127.") || address === "::1";
}
export function wildcard(address: string) {
  return ["*", "0.0.0.0", "::"].includes(address);
}
export function kind(name: string, address: string): Kind {
  if (loopback(address)) return "loopback";
  const tunnel = ["utun", "tun", "wg", "ppp", "tap"].some(p => name.startsWith(p)),
    parts = address.split("."),
    second = Number(parts[1]);
  if (
    name.startsWith("tailscale") ||
    (tunnel && ((parts[0] === "100" && second >= 64 && second <= 127) || address.startsWith("fd7a:115c:a1e0:")))
  )
    return "tailscale";
  return tunnel ? "vpn" : "network";
}
export function host(e: Endpoint, remote: boolean) {
  if (!remote && (["127.0.0.1", "::1"].includes(e.bind_address) || wildcard(e.bind_address))) return "localhost";
  const rank = { loopback: 0, tailscale: 1, vpn: 2, network: 3 };
  const found = e.interfaces
    .filter(
      i => !(remote && i.kind === "loopback") && !i.address.startsWith("fe80:") && !i.address.startsWith("169.254."),
    )
    .sort((a, b) => rank[a.kind] - rank[b.kind] || Number(a.ipv6) - Number(b.ipv6))[0];
  return found?.address ?? (!remote && !wildcard(e.bind_address) ? e.bind_address : null);
}
export function browserResponse(status: number | null) {
  return status !== null && status >= 200 && status < 400;
}
export function url(e: Endpoint, remote: boolean): string | null {
  if (e.scheme === "unknown" || !browserResponse(e.http_status)) return null;
  const address = host(e, remote);
  return address ? `${e.scheme}://${address.includes(":") ? "[" + address + "]" : address}:${e.port}` : null;
}
export type Root = {
  pid: number;
  pane: number;
  workspace: number;
  agent_pid: number;
};
export type Process = {
  pid: number;
  parent: number;
  group: number;
  name: string;
};
export function processes(text: string): Process[] {
  return text.split("\n").flatMap(l => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m
      ? [
          {
            pid: Number(m[1]),
            parent: Number(m[2]),
            group: Number(m[3]),
            name: m[4].trim(),
          },
        ]
      : [];
  });
}
/** The panes' processes, as `ps -o pid=,ppid=,pgid=,comm=` lists them, read
 * from the panes' own trees. Null where the kernel can't list children. */
export function paneProcesses(roots: Root[]): Process[] | null {
  const tree = processTree(roots.map(r => r.pid));
  if (!tree) return null;
  return tree.flatMap(pid => {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8"),
        end = text.lastIndexOf(")"),
        fields = text.slice(end + 2).split(" ");
      return [
        { pid, parent: Number(fields[1]), group: Number(fields[2]), name: text.slice(text.indexOf("(") + 1, end) },
      ];
    } catch {
      return [];
    }
  });
}
export function workload(p: Process, root: Root) {
  if (p.pid === root.agent_pid) return false;
  const name = basename(p.name).replace(/^-+/, "");
  return !["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"].includes(name) && identify([name]) === null;
}
export function owner(pid: number, list: Process[], roots: Root[]): Root | null {
  let current = pid;
  for (let i = 0; i <= list.length; i++) {
    const root = roots.find(r => r.pid === current);
    if (root) return root;
    const parent = list.find(p => p.pid === current)?.parent;
    if (parent === undefined || parent <= 1 || parent === current) return null;
    current = parent;
  }
  return null;
}
export function socketCommand(list: Process[], roots: Root[]): string[] {
  const owned = list.filter(process => owner(process.pid, list, roots) !== null);
  // lsof's default OR selection would include every network socket despite -p.
  // With no owned processes, a harmless self query still checks availability.
  const pids = owned.map(process => process.pid).join(",") || String(process.pid);
  if (pids.length > 60000) return ["lsof", "-nP", "-iTCP", "-iUDP", "-FpcftPnT"];
  return ["lsof", "-nP", "-a", "-p", pids, "-iTCP", "-iUDP", "-FpcftPnT"];
}
export function interfaces(): Interface[] {
  const out: Interface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces()))
    for (const a of addresses ?? []) {
      let address = a.address;
      const ipv6 = a.family === "IPv6";
      if (ipv6 && address.startsWith("fe80:")) address += "%" + name;
      out.push({ name, address, kind: kind(name, a.address), ipv6 });
    }
  return out;
}
export function matching(address: string, ipv6: boolean, all: Interface[]) {
  return all.filter(i => i.ipv6 === ipv6 && (wildcard(address) || address === i.address));
}
export function sockets(text: string, list: Process[], roots: Root[], all: Interface[]): Endpoint[] {
  const out: Endpoint[] = [];
  let pid = 0,
    name = "",
    ipv6 = false,
    transport: "tcp" | "udp" | null = null,
    address = "",
    listening = false;
  const flush = () => {
    if (!address || !(transport === "udp" || (transport === "tcp" && listening))) return;
    const root = owner(pid, list, roots),
      p = list.find(p => p.pid === pid);
    if (!root || !p || !workload(p, root)) return;
    const local = address.split("->")[0],
      colon = local.lastIndexOf(":");
    if (colon < 0) return;
    const port = Number(local.slice(colon + 1)),
      bind = local.slice(0, colon).replace(/^\[|\]$/g, "");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    if (
      out.some(
        e =>
          e.pid === pid && e.port === port && e.ipv6 === ipv6 && e.bind_address === bind && e.transport === transport,
      )
    )
      return;
    out.push({
      label: "",
      label_pending: false,
      pid,
      pane: root.pane,
      name,
      transport: transport!,
      bind_address: bind,
      port,
      ipv6,
      interfaces: matching(bind, ipv6, all),
      scheme: "unknown",
      http_status: null,
      probed_at: 0,
    });
  };
  for (const line of [...text.split("\n"), null]) {
    if (line === null || line.startsWith("p") || line.startsWith("f")) {
      flush();
      address = "";
      listening = false;
      transport = null;
      ipv6 = false;
    }
    if (!line) continue;
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        pid = Number(value) || 0;
        break;
      case "c":
        name = value;
        break;
      case "t":
        ipv6 = value === "IPv6";
        break;
      case "P":
        transport = value === "TCP" ? "tcp" : value === "UDP" ? "udp" : null;
        break;
      case "n":
        address = value;
        break;
      case "T":
        if (value === "ST=LISTEN") listening = true;
        break;
    }
  }
  return out;
}
/** What `lsof -FpcftPnT` reports for the processes under `roots`, read from
 * /proc. lsof walks every descriptor on the host, which takes seconds on a
 * busy Linux machine. */
export async function procInventory(list: Process[], roots: Root[]): Promise<string> {
  const held: { process: Process; fds: [string, string][] }[] = [];
  for (const p of list) {
    if (owner(p.pid, list, roots) === null) continue;
    const dir = `/proc/${p.pid}/fd`;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const fds: [string, string][] = [];
    for (const entry of entries) {
      let link: string;
      try {
        link = await readlink(`${dir}/${entry}`);
      } catch {
        continue;
      }
      if (link.startsWith("socket:[") && link.endsWith("]")) fds.push([entry, link.slice("socket:[".length, -1)]);
    }
    if (fds.length) held.push({ process: p, fds });
  }
  // The host's socket tables are read only when a pane's process has a socket.
  if (!held.length) return "";
  const table = new Map<string, Socket>();
  for (const [name, socket] of [
    ["/proc/net/tcp", { transport: "TCP", ipv6: false }],
    ["/proc/net/tcp6", { transport: "TCP", ipv6: true }],
    ["/proc/net/udp", { transport: "UDP", ipv6: false }],
    ["/proc/net/udp6", { transport: "UDP", ipv6: true }],
  ] as const) {
    let text: string;
    try {
      text = await readFile(name, "latin1");
    } catch {
      continue;
    }
    procSockets(text, { ...socket, address: "", listening: false }, table);
  }
  let out = "";
  for (const { process: p, fds } of held) {
    let named = false;
    for (const [entry, inode] of fds) {
      const socket = table.get(inode);
      if (!socket) continue;
      if (!named) out += `p${p.pid}\nc${basename(p.name)}\n`;
      named = true;
      out += `f${entry}\nt${socket.ipv6 ? "IPv6" : "IPv4"}\nP${socket.transport}\nn${socket.address}\n`;
      if (socket.listening) out += "TST=LISTEN\n";
    }
  }
  return out;
}
export interface Socket {
  transport: "TCP" | "UDP";
  ipv6: boolean;
  address: string;
  listening: boolean;
}
/** Adds a /proc/net table's sockets by inode, with local addresses as lsof
 * writes them: `*:port` for a wildcard bind, `[address]:port` for IPv6. */
export function procSockets(text: string, kind_of: Socket, table: Map<string, Socket>): void {
  const lines = text.split("\n").slice(1);
  rows: for (const line of lines) {
    const columns = line.split(" ").filter(field => field.length > 0);
    if (columns.length < 10) continue;
    const local = columns[1];
    const colon = local.indexOf(":");
    if (colon < 0) continue;
    const port = parseInt(local.slice(colon + 1), 16);
    if (!/^[0-9A-Fa-f]{1,4}$/.test(local.slice(colon + 1))) continue;
    if (!/^\d+$/.test(columns[9])) continue;
    const inode = columns[9];
    if (BigInt(inode) === 0n) continue;
    // Each 32-bit word is printed in host byte order.
    const hex = local.slice(0, colon);
    const size = kind_of.ipv6 ? 16 : 4;
    if (hex.length !== size * 2) continue;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size / 4; i++) {
      const word = hex.slice(i * 8, i * 8 + 8);
      if (!/^[0-9A-Fa-f]{8}$/.test(word)) continue rows;
      if (endianness() === "LE") bytes.writeUInt32LE(parseInt(word, 16), i * 4);
      else bytes.writeUInt32BE(parseInt(word, 16), i * 4);
    }
    const shown = bytes.every(b => b === 0) ? "*" : kind_of.ipv6 ? ntop6(bytes) : Array.from(bytes).join(".");
    table.set(inode, {
      ...kind_of,
      address: kind_of.ipv6 && shown !== "*" ? `[${shown}]:${port}` : `${shown}:${port}`,
      // TCP_LISTEN
      listening: columns[3] === "0A",
    });
  }
}
/** inet_ntop for IPv6, as glibc writes it. */
function ntop6(bytes: Buffer): string {
  const words = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2));
  // The longest run of two or more zero words becomes "::".
  let best = { base: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > best.len) best = { base: i, len: j - i };
    i = j;
  }
  if (best.len < 2) best = { base: -1, len: 0 };
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best.base >= 0 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ":";
      continue;
    }
    if (i !== 0) out += ":";
    // An embedded IPv4 address: ::a.b.c.d or ::ffff:a.b.c.d.
    if (i === 6 && best.base === 0 && (best.len === 6 || (best.len === 5 && words[5] === 0xffff))) {
      out += Array.from(bytes.subarray(12)).join(".");
      break;
    }
    out += words[i].toString(16);
  }
  if (best.base >= 0 && best.base + best.len === 8) out += ":";
  return out;
}
async function command(argv: string[], allowPartial = false, signal?: AbortSignal) {
  try {
    const { stdout } = await promisify(execFile)(argv[0], argv.slice(1), {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return stdout;
  } catch (e) {
    // A selected PID may exit before lsof reaches it; other records remain valid.
    return allowPartial && (e as any).code === 1 && typeof (e as any).stdout === "string" ? (e as any).stdout : null;
  }
}
export async function probe(e: Endpoint, signal?: AbortSignal) {
  const address = wildcard(e.bind_address) ? (e.ipv6 ? "::1" : "127.0.0.1") : e.bind_address;
  for (const scheme of ["http", "https"] as const) {
    const target = `${scheme}://${e.ipv6 ? "[" + address + "]" : address}:${e.port}/`,
      result = await command(
        [
          "curl",
          "-q",
          "--noproxy",
          "*",
          "--silent",
          "--insecure",
          "--range",
          "0-4095",
          "--connect-timeout",
          "0.3",
          "--max-time",
          "0.6",
          "--output",
          "/dev/null",
          "--write-out",
          "%{http_code}",
          "--",
          target,
        ],
        false,
        signal,
      ),
      status = Number(result);
    if (result !== null && Number.isInteger(status) && status >= 100 && status <= 599) return { scheme, status };
  }
  return { scheme: "unknown" as const, status: null };
}
export class Tracker {
  current = new Snapshot();
  pending = new Snapshot();
  roots: Root[] = [];
  thread: Promise<void> | null = null;
  done = false;
  stopping = false;
  next_refresh = 0;
  abort = new AbortController();
  deinit() {
    this.stopping = true;
    this.abort.abort();
  }
  busy() {
    return this.thread !== null;
  }
  tick(runtime: Runtime) {
    let changed = false;
    if (this.thread) {
      if (!this.done) return false;
      this.thread = null;
      const valid = this.roots.every(
        root =>
          runtime.pane(root.pane)?.terminal.pid === root.pid &&
          runtime.workspaces.owner(root.pane)?.id === root.workspace,
      );
      if (valid) {
        changed = !this.current.same(this.pending);
        this.current = this.pending;
      }
    }
    const now = milliTimestamp();
    if (now < this.next_refresh) return changed;
    this.next_refresh = now + 3000;
    this.roots = runtime.panes
      .filter(p => !p.terminal.exited)
      .flatMap(p => {
        const w = runtime.workspaces.owner(p.id);
        return w
          ? [
              {
                pid: p.terminal.pid,
                pane: p.id,
                workspace: w.id,
                agent_pid: p.detection.pid,
              },
            ]
          : [];
      });
    this.pending = new Snapshot();
    this.done = false;
    this.thread = this.scan()
      .catch(() => {
        this.pending = new Snapshot();
      })
      .finally(() => {
        this.done = true;
      });
    return changed;
  }
  async scan() {
    let list = process.platform === "linux" ? paneProcesses(this.roots) : null;
    if (!list) {
      const ps = await command(["ps", "-axo", "pid=,ppid=,pgid=,comm="], false, this.abort.signal);
      if (ps === null) return;
      list = processes(ps);
    }
    const all = interfaces(),
      files =
        process.platform === "linux"
          ? await procInventory(list, this.roots).catch(() => null)
          : await command(socketCommand(list, this.roots), true, this.abort.signal),
      endpoints = files === null ? [] : sockets(files, list, this.roots, all),
      works: Work[] = [],
      now = milliTimestamp();
    for (const root of this.roots) {
      if (works.some(w => w.id === root.workspace)) continue;
      const work: Work = { id: root.workspace, background: 0, endpoints: [] };
      for (const p of list) {
        const o = owner(p.pid, list, this.roots);
        if (o?.workspace === root.workspace && workload(p, o)) work.background++;
      }
      for (const endpoint of endpoints) {
        if (owner(endpoint.pid, list, this.roots)?.workspace !== root.workspace) continue;
        const e = { ...endpoint },
          old = this.current
            .workspace(work.id)
            .endpoints.find(
              x =>
                x.pid === e.pid &&
                x.pane === e.pane &&
                x.port === e.port &&
                x.ipv6 === e.ipv6 &&
                x.transport === e.transport &&
                x.bind_address === e.bind_address,
            );
        if (old) {
          e.scheme = old.scheme;
          e.http_status = old.http_status;
          e.probed_at = old.probed_at;
        }
        work.endpoints.push(e);
      }
      works.push(work);
    }
    for (let i = 0; i < 4 && !this.stopping; i++) {
      const oldest = works
        .flatMap(w => w.endpoints)
        .filter(e => e.transport === "tcp" && now - e.probed_at > (browserResponse(e.http_status) ? 60000 : 15000))
        .sort((a, b) => a.probed_at - b.probed_at)[0];
      if (!oldest) break;
      const result = await probe(oldest, this.abort.signal);
      oldest.scheme = result.scheme;
      oldest.http_status = result.status;
      oldest.probed_at = now;
    }
    this.pending = Object.assign(new Snapshot(), {
      processes_available: true,
      ports_available: files !== null,
      workspaces: works,
    });
  }
}
