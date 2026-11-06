//! Talk to the background service at the address and password it advertises
//! in its state directory; the installed CLI only starts the service, and
//! reads that shouldn't start it borrow a private server instead. Model
//! names cross only through its API; the TUI's model choice is read from its
//! state directory.
import type { Progress } from "../../startup";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as subprocess from "../../subprocess";
import * as discovery from "../../discovery";
import { field, str, number } from "../common";
import { Tokens } from "../../usage/live";
import * as server from "./server";
/** Largest reply or event Corgi reads; an oversized context fails whole. */
const limit = 8 * 1024 * 1024;
export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME!, ".config"), "opencode");
}
export function dataDir(env = process.env) {
  return join(env.XDG_DATA_HOME ?? join(env.HOME!, ".local/share"), "opencode");
}
export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME ?? join(env.HOME!, ".local/state"), "opencode");
}
/** The claims in an OAuth access token, when it is a JWT. */
export function accessClaims(value: unknown) {
  const token = str(value, "access"),
    part = token.split(".")[1];
  if (!part) return null;
  try {
    return object(JSON.parse(Buffer.from(part, "base64url").toString()));
  } catch {
    return null;
  }
}
export const validSession = (id: string) => /^ses_[A-Za-z0-9]+$/.test(id) && id.length <= 128;
/** A credential's account label, excluding generic sign-in/provider labels. */
export function credentialLabel(credential: unknown, provider: string): string {
  const label = str(credential, "label");
  return label && ![provider, "OAuth", "API key", "Environment"].includes(label) ? label : "";
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("BadOpenCodeResponse");
  return value as Record<string, unknown>;
}
export function data(value: unknown) {
  return object(object(value).data);
}
export function items(value: unknown): Record<string, unknown>[] {
  const entries = object(value).data;
  if (!Array.isArray(entries)) throw Error("BadOpenCodeResponse");
  return entries.map(object);
}
export function model(value: unknown) {
  const id = str(value, "id"),
    provider = str(value, "providerID"),
    variant = str(value, "variant");
  return id && provider ? provider + "/" + id + (variant && variant !== "default" ? "#" + variant : "") : "";
}
export function modelRef(value: string) {
  const match = /^([^/]+)\/([^#]+)(?:#(.+))?$/.exec(value);
  if (!match) throw Error("InvalidOpenCodeModel");
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) };
}
export function tokens(value: unknown) {
  const cache = field(value, "cache");
  return new Tokens({
    input: (number(value, "input") ?? 0n) + (number(cache, "read") ?? 0n) + (number(cache, "write") ?? 0n),
    cached_input: number(cache, "read") ?? 0n,
    output: (number(value, "output") ?? 0n) + (number(value, "reasoning") ?? 0n),
  });
}
/** The context window each catalog model lists, by `provider/id`. */
export function windows(models: unknown) {
  const out = new Map<string, bigint>();
  for (const entry of items(models)) {
    const id = str(entry, "providerID") + "/" + str(entry, "id"),
      limit = number(field(entry, "limit"), "context");
    if (limit !== null && limit > 0n) out.set(id, limit);
  }
  return out;
}
export type Endpoint = { url: string; authorization: string };
/** Where the background service listens, as its `service.json` says. */
export function endpoint(env = process.env): Endpoint | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(stateDir(env), "service.json"), "utf8"));
  } catch {
    return null;
  }
  const url = str(value, "url");
  if (!/^https?:\/\//.test(url)) return null;
  return { url, authorization: "Basic " + Buffer.from("opencode:" + str(value, "password")).toString("base64") };
}
/** The background service, when it answers where it says it listens. */
async function running(): Promise<Endpoint | null> {
  const found = endpoint();
  if (!found) return null;
  try {
    const reply = await fetch(found.url + "/api/info", {
      headers: { authorization: found.authorization },
      signal: AbortSignal.timeout(2000),
    });
    await reply.body?.cancel();
    return reply.ok ? found : null;
  } catch {
    return null;
  }
}
/** Whether OpenCode keeps a provider login. Read-only connections can't open
 * its database once OpenCode has closed it and dropped the WAL files. */
export function login(): boolean {
  try {
    const db = new Database(join(dataDir(), "opencode.db"), { readwrite: true, create: false });
    try {
      return db.query("SELECT 1 FROM credential LIMIT 1").get() !== null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
/** The session an event is about, read the way OpenCode's own clients do. */
export function eventSession(event: Record<string, unknown>) {
  const value = field(event, "data");
  return str(value, "sessionID") || str(field(value, "form"), "sessionID");
}
/** Each event's data in a server-sent event stream. */
export async function* sse(body: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "",
    lines: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line.startsWith("data:")) lines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      else if (!line && lines.length) {
        yield lines.join("\n");
        lines = [];
      }
    }
    if (buffer.length + lines.reduce((n, l) => n + l.length, 0) > limit) throw Error("OpenCodeEventTooLarge");
  }
}
async function text(reply: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of reply.body ?? []) {
    size += chunk.length;
    if (size > limit) throw Error("OpenCodeResponseTooLarge");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString().trim();
}
/** Hears about each (re)connection to the event stream, so it can catch up
 * on what it missed, then about each event, and when the stream drops. */
export type Listener = {
  connected(): void;
  event(value: Record<string, unknown>): void;
  lost(): void;
};
export class API {
  service: Endpoint | null = null;
  constructor(
    readonly executable: string,
    readonly cwd = process.cwd(),
    /** Whether the CLI may start the background service. */
    readonly starts = true,
    readonly progress?: Progress,
  ) {}
  static async open(cwd = process.cwd()) {
    return new API(await discovery.resolve("opencode2", cwd), cwd);
  }
  /** Runs `read` without starting the background service: on it when it
   * answers, else on a private server while OpenCode keeps a login, unless
   * `borrow` is false. Null when neither is there. */
  static async peek<T>(cwd: string, read: (api: API) => Promise<T>, borrow = true): Promise<T | null> {
    const at = (service: Endpoint) => Object.assign(new API("", cwd, false), { service });
    const service = await running();
    if (service) return read(at(service));
    if (!borrow || !login()) return null;
    const lease = await server.hold(() => discovery.resolve("opencode2", cwd));
    try {
      return await read(at(lease.endpoint));
    } finally {
      lease.release();
    }
  }
  /** The service's address; the CLI starts the service when none answers there. */
  async locate(failed: Endpoint | null = null) {
    if (!this.starts) throw Error("OpenCodeServiceUnavailable");
    let found = endpoint();
    if (!found || (failed && found.url === failed.url && found.authorization === failed.authorization)) {
      this.progress?.update("service");
      const result = await subprocess.run([this.executable, "api", "GET", "/api/info"], {
        cwd: this.cwd,
        timeout_ms: this.progress ? null : 10000,
        detached: this.progress ? true : false,
        quit: this.progress?.quit,
        stderr: !!this.progress,
        capture: !this.progress,
        on_output: this.progress ? (bytes, stream) => this.progress!.output(bytes, stream) : undefined,
      });
      if (!result.ok()) throw Error("OpenCodeServiceUnavailable");
      found = endpoint();
    }
    if (!found) throw Error("OpenCodeServiceUnavailable");
    this.progress?.update("session");
    return (this.service = found);
  }
  /** A request that never reached the service is sent once more, past a restart. */
  async request(path: string, init: RequestInit & { headers?: Record<string, string> }, timeout?: number) {
    let at = this.service ?? (await this.locate());
    for (let retried = false; ; retried = true) {
      let reply: Response;
      try {
        const signal =
          timeout === undefined
            ? init.signal
            : AbortSignal.any([AbortSignal.timeout(timeout), ...(init.signal ? [init.signal] : [])]);
        reply = await fetch(at.url + path, {
          ...init,
          signal,
          headers: { ...init.headers, authorization: at.authorization },
        });
      } catch (error) {
        const code = field(error, "code");
        if (retried || (code !== "ConnectionRefused" && code !== "ECONNREFUSED")) throw error;
        at = await this.locate(at);
        continue;
      }
      if (reply.status !== 401 || retried) return reply;
      at = await this.locate(at);
    }
  }
  async call(method: string, path: string, body?: unknown, quit?: subprocess.Quit, timeout = 10000): Promise<unknown> {
    quit ??= this.progress?.quit;
    if (quit?.aborted) throw Error("Cancelled");
    try {
      const reply = await this.request(
        path,
        {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: quit?.abortSignal,
        },
        timeout,
      );
      if (!reply.ok) throw Error("OpenCodeRequestFailed");
      const out = await text(reply);
      return out ? JSON.parse(out) : null;
    } catch (error) {
      if (quit?.aborted) throw Error("Cancelled");
      if (error instanceof Error && error.name === "TimeoutError") throw Error("Timeout");
      // Corgi's own failures keep their names; fetch's and JSON's don't.
      throw error instanceof Error && error.name === "Error" ? error : Error("OpenCodeRequestFailed");
    }
  }
  /** Follows the service's event stream until `signal` aborts, reconnecting
   * after it drops. */
  async follow(signal: AbortSignal, listener: Listener) {
    for (let delay = 250; !signal.aborted; delay = Math.min(delay * 2, 5000)) {
      try {
        const reply = await this.request("/api/event", { headers: { accept: "text/event-stream" }, signal });
        if (!reply.ok || !reply.body) throw Error("OpenCodeRequestFailed");
        delay = 250;
        listener.connected();
        for await (const data of sse(reply.body)) {
          let value: Record<string, unknown>;
          try {
            value = object(JSON.parse(data));
          } catch {
            continue;
          }
          listener.event(value);
        }
      } catch {}
      if (signal.aborted) return;
      listener.lost();
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        signal.addEventListener("abort", done);
      });
    }
  }
  async sessions(query: string, stopping: () => boolean) {
    const entries: Record<string, unknown>[] = [];
    let cursor = "";
    for (let page = 0; page < 100 && !stopping(); page++) {
      const reply = await this.call(
        "GET",
        "/api/session?limit=100" + query + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      const found = items(reply);
      entries.push(...found);
      const next = str(field(reply, "cursor"), "next");
      if (!found.length || !next) return { entries, complete: true };
      if (next === cursor) break;
      cursor = next;
    }
    return { entries, complete: false };
  }
}
