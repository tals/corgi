import { createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  ftruncateSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { flock } from "../native_bridge";
import { Info, Window, expired, restoreLimits } from "./account";
import { Text } from "../providers/common";
import { parse, stringify } from "../json";
export const interval = 60,
  cooldown = 300;
export class State {
  info = new Info();
  next_usage = 0;
  next_profile = 0;
  rate_limited = false;
  update(fresh: Info, now: number) {
    const previous = this.info;
    this.info = Object.assign(new Info(), fresh);
    if (fresh.limits !== "none") this.info.usage_fetched_at = now;
    else if (fresh.signed_in === true && previous.limits !== "none") {
      this.info.limits = previous.limits;
      this.info.usage_fetched_at = previous.usage_fetched_at;
    }
  }
  display(now: number) {
    const result = Object.assign(new Info(), this.info);
    if (this.rate_limited && !result.usage_error.len)
      result.usage_error = new Text("server returned 429");
    if (
      typeof result.limits === "object" &&
      expired(result.usage_fetched_at, now) &&
      !result.usage_error.len
    )
      result.usage_error = new Text(
        result.usage_fetched_at <= 0
          ? "fetch time unknown"
          : "last success 10m+ ago",
      );
    else if (result.limits === "none" && this.rate_limited)
      result.limits = "rate_limited";
    return result;
  }
  failed(reason: string) {
    this.rate_limited = false;
    this.info.usage_error = new Text(reason);
  }
  failedResponse(status: number) {
    this.failed(status ? `server returned ${status}` : "request failed");
    this.rate_limited = status === 429;
  }
}
function lock(fd: number, operation: number) {
  return flock(fd, operation !== 8);
}

function restoreState(value: any) {
  const state = Object.assign(new State(), value);
  state.info = Object.assign(new Info(), value.info ?? {});
  for (const key of ["account", "plan", "usage_error"] as const)
    state.info[key] = new Text(
      typeof value.info?.[key] === "string" ? value.info[key] : "",
    );
  state.info.limits = restoreLimits(value.info?.limits ?? "none");
  return state;
}
export function Locked<T extends object>(
  make: () => T,
  dir: string,
  restore: (value: any) => T = (v) => Object.assign(make(), v),
) {
  return class LockedFile {
    constructor(
      public file: number,
      public state: T,
    ) {}
    static async open(kind: string, identity: string, stopping: any = false) {
      if (!process.env.HOME) throw Error("NoHome");
      const root = process.env.XDG_STATE_HOME
        ? join(process.env.XDG_STATE_HOME, "corgi", dir)
        : join(process.env.HOME, ".local", "state", "corgi", dir);
      mkdirSync(root, { recursive: true });
      const digest = createHash("sha256").update(identity).digest("hex");
      const fd = openSync(join(root, `${kind}-${digest}.json`), "a+", 0o600),
        deadline = Date.now() + 10000;
      try {
        while (!lock(fd, 2 | 4)) {
          if (
            stopping === true ||
            stopping?.aborted ||
            stopping?.load?.() ||
            Date.now() >= deadline
          )
            throw Error("CacheBusy");
          await Bun.sleep(10);
        }
        let state = make();
        const bytes = readFileSync(fd);
        if (bytes.length > 16384) throw Error("StreamTooLong");
        if (bytes.length)
          try {
            state = restore(parse(bytes.toString()));
          } catch {}
        return new LockedFile(fd, state);
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
    save() {
      const bytes = Buffer.from(stringify(this.state));
      ftruncateSync(this.file, 0);
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(
          this.file,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
      fsyncSync(this.file);
    }
    close() {
      lock(this.file, 8);
      closeSync(this.file);
    }
  };
}
export const Cache = Locked(
  () => new State(),
  "account-previews",
  restoreState,
);
export type Response = {
  status: number;
  retry_at: number | null;
  body: string;
};
export function response(bytes: string, now: number): Response {
  let rest = bytes,
    result: Response = { status: 0, retry_at: null, body: "" };
  while (rest.startsWith("HTTP/")) {
    const end = rest.indexOf("\r\n\r\n");
    if (end < 0) return { status: 0, retry_at: null, body: "" };
    const lines = rest.slice(0, end).split("\r\n"),
      status = Number(lines.shift()?.split(" ")[1]);
    result = {
      status:
        Number.isInteger(status) && status >= 0 && status <= 65535 ? status : 0,
      retry_at: null,
      body: "",
    };
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0 || line.slice(0, colon).toLowerCase() !== "retry-after")
        continue;
      const value = line.slice(colon + 1).trim();
      if (/^\d+$/.test(value) && Number(value) <= 0xffffffff)
        result.retry_at = now + Number(value);
      else {
        const parsed = Date.parse(value) / 1000;
        if (Number.isFinite(parsed) && parsed > now) result.retry_at = parsed;
      }
    }
    rest = rest.slice(end + 4);
  }
  result.body = rest;
  return result;
}
export function nextAttempt(reply: Response, now: number) {
  return reply.status === 429
    ? Math.max(now + interval, reply.retry_at ?? now + cooldown)
    : now + interval;
}
