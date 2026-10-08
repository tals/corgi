import { readFileSync, readdirSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { systemCall, sysconf } from "../native_bridge";
export type Identity = {
  pid: number;
  parent: number;
  start: bigint;
  name: string;
};
export type Counters = {
  start: bigint;
  cpu_ns: bigint;
  memory: bigint;
  read: bigint | null;
  written: bigint | null;
};
export type MemoryPressure = "unknown" | "normal" | "warning" | "critical";
export type Host = {
  busy: bigint;
  total: bigint;
  cores: number;
  memory: bigint;
  pressure: MemoryPressure;
};
export type Inventory = { items: Identity[]; truncated: boolean };
export type Stat = { identity: Identity; ticks: bigint; pages: bigint };
let native: (request: any) => any = systemCall;
export function setNative(call: (request: any) => any) {
  native = call;
}
export function parseStat(pid: number, text: string): Stat | null {
  const begin = text.indexOf("("),
    end = text.lastIndexOf(")");
  if (begin < 0 || end <= begin) return null;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 22) return null;
  try {
    return {
      identity: {
        pid,
        parent: Number(fields[1]),
        start: BigInt(fields[19]),
        name: Buffer.from(text.slice(begin + 1, end))
          .subarray(0, 63)
          .toString(),
      },
      ticks: BigInt(fields[11]) + BigInt(fields[12]),
      pages: /^\d+$/.test(fields[21]) ? BigInt(fields[21]) : 0n,
    };
  } catch {
    return null;
  }
}
function linuxStat(pid: number) {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}
export function inventory(): Inventory {
  if (process.platform === "darwin") {
    if (!native) throw Error("NativeBoundaryUnavailable");
    const result = native({ op: "resource.inventory" });
    return {
      ...result,
      items: result.items.map((item: any) => ({
        ...item,
        start: BigInt(item.start),
      })),
    };
  }
  if (process.platform !== "linux") throw Error("UnsupportedPlatform");
  const items: Identity[] = [];
  let truncated = false;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    if (items.length === 16384) {
      truncated = true;
      break;
    }
    const s = linuxStat(Number(name));
    if (s) items.push(s.identity);
  }
  return { items, truncated };
}
export function field(text: string, key: string): bigint | null {
  const l = text.split("\n").find((l) => l.startsWith(key));
  if (!l) return null;
  try {
    return BigInt(l.slice(key.length).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}
export function counters(pid: number): Counters | null {
  if (process.platform === "darwin") {
    if (!native) return null;
    const result = native({ op: "resource.counters", pid });
    return result
      ? {
          ...result,
          start: BigInt(result.start),
          cpu_ns: BigInt(result.cpu_ns),
          memory: BigInt(result.memory),
          read: result.read === null ? null : BigInt(result.read),
          written: result.written === null ? null : BigInt(result.written),
        }
      : null;
  }
  if (process.platform !== "linux") return null;
  const s = linuxStat(pid);
  if (!s) return null;
  const ticks = sysconf(false),
    pages = sysconf(true);
  if (ticks <= 0 || pages <= 0) return null;
  let io: string | null = null;
  try {
    io = readFileSync(`/proc/${pid}/io`, "utf8");
  } catch {}
  return {
    start: s.identity.start,
    cpu_ns: s.ticks * (1000000000n / BigInt(ticks)),
    memory: s.pages * BigInt(pages),
    read: io ? field(io, "read_bytes:") : null,
    written: io ? field(io, "write_bytes:") : null,
  };
}
export function host(): Host {
  if (process.platform === "darwin") {
    if (!native) throw Error("NativeBoundaryUnavailable");
    const result = native({ op: "resource.host" });
    return {
      ...result,
      busy: BigInt(result.busy),
      total: BigInt(result.total),
      memory: BigInt(result.memory),
    };
  }
  const out: Host = {
    busy: 0n,
    total: 0n,
    cores: Math.max(1, cpus().length),
    memory: BigInt(totalmem()),
    pressure: "unknown",
  };
  if (process.platform === "linux") {
    try {
      const values = readFileSync("/proc/stat", "utf8")
        .split("\n")[0]
        .trim()
        .split(/\s+/)
        .slice(1, 9)
        .map(BigInt);
      out.total = values.reduce((a, b) => a + b, 0n);
      out.busy = out.total - values[3] - values[4];
    } catch {}
    try {
      const p = readFileSync("/proc/pressure/memory", "utf8").match(
        /some avg10=([\d.]+)/,
      );
      if (p) {
        const value = Number(p[1]);
        out.pressure =
          value >= 10 ? "critical" : value >= 1 ? "warning" : "normal";
      }
    } catch {}
  }
  return out;
}
