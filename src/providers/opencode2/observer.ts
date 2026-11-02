import { resolve } from "node:path";
import type { Observer } from "../adapter";
import type { Runtime } from "../../runtime";
import { Child, Name, Role, Snapshot, Turn, type Request } from "../snapshot";
import { Path } from "../../bounded_text";
import { Text, field, str } from "../common";
import { Failure } from "../../failure";
import { getLogger } from "../../log";
import { API, data, eventSession, items, model, tokens, validSession, windows } from "./api";
import { outcome } from "./worker";
import * as activity from "./activity";
import { Model } from "../model";
import { Reading } from "../../usage/context_window";
import * as modelCatalog from "./catalog";
import { Accounts } from "./identity";
const log = getLogger("opencode2.observer");
export async function snapshot(
  api: API,
  request: Request,
  active: Record<string, unknown>,
  catalog = new Map<string, bigint>(),
  models = new Map<string, Model>(),
  accounts?: Accounts,
) {
  const session = request.prefix.text(),
    base = `/api/session/${session}`;
  const [info, messages, permissions, forms] = await Promise.all([
    api.call("GET", base).then(data),
    api.call("GET", base + "/context").then(items),
    api.call("GET", base + "/permission").then(items),
    api.call("GET", base + "/form").then(items),
  ]);
  if (str(info, "id") !== session) throw Error("WrongSession");
  const state = permissions.length || forms.length ? "blocked" : active[session] ? "working" : "idle";
  const out = new Snapshot(request, session, state);
  out.account = accounts ? await accounts.describe(info) : null;
  const tail = messages.at(-1);
  out.compacting = state === "working" && tail?.type === "compaction" && tail.status === "running";
  out.name = new Name(str(info, "title"));
  const cwd = str(field(info, "location"), "directory");
  if (cwd.startsWith("/")) out.cwd = new Path(cwd);
  out.model = model(info.model);
  const listed = models.get(out.model.split("#")[0]),
    variant = str(info.model, "variant");
  if (listed) {
    const resolved = Model.resolve(out.model);
    out.model_info = new Model({
      ...listed,
      id: resolved.id,
      name:
        variant && variant !== "default" && listed.name.len
          ? new Name(`${listed.name.text()} (${variant})`)
          : listed.name,
    });
  }
  const latest = messages.findLast(m => m.type === "assistant");
  out.usage = { total: tokens(info.tokens), last: latest?.tokens ? tokens(latest.tokens) : null };
  const full = str(field(info, "model"), "providerID") + "/" + str(field(info, "model"), "id"),
    window = catalog.get(full);
  if (out.usage.last && window) {
    const reading = new Reading();
    reading.used = out.usage.last.total();
    reading.window = window;
    reading.at = Date.now();
    reading.model = Model.resolve(out.model);
    out.context = reading;
  }
  out.updated_at = Math.floor(Number(field(info.time, "updated") ?? 0) / 1000);
  const user = messages.findLast(m => m.type === "user"),
    idle = messages.findLast(m => m.type === "idle");
  if (user) out.turn = new Turn(str(user, "id"));
  if (idle && (!user || messages.indexOf(idle) > messages.indexOf(user)) && !active[session])
    out.outcome = outcome(idle.outcome);
  out.evidence = activity.evidence(messages);
  const current = messages.slice(user ? messages.indexOf(user) : 0);
  const tools = current
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(p => str(p, "type") === "tool" && typeof field(field(p, "time"), "completed") !== "number");
  out.tool_active = state !== "idle" && tools.length > 0;
  if (out.tool_active) out.tool = str(tools.at(-1), "name");
  const files = field(field(latest, "snapshot"), "files");
  if (Array.isArray(files) && cwd)
    out.location = {
      cwd,
      basis: "default",
      ran: [],
      writes: files.filter((p): p is string => typeof p === "string").map(p => resolve(cwd, p)),
    };
  const children = await api.sessions("&parentID=" + session, () => false);
  out.children_complete = children.complete;
  for (const value of children.entries.slice(0, 256)) {
    const child = new Child();
    child.session = str(value, "id");
    if (!validSession(child.session)) continue;
    child.name = new Name(str(value, "title"));
    child.role = new Role(str(value, "agent"));
    child.state = active[child.session] ? "working" : "idle";
    if (child.state === "working") {
      const [permissions, forms] = await Promise.all([
        api.call("GET", `/api/session/${child.session}/permission`).then(items),
        api.call("GET", `/api/session/${child.session}/form`).then(items),
      ]);
      if (permissions.length || forms.length) child.state = "blocked";
    }
    child.updated_at = Math.floor(Number(field(value.time, "updated") ?? 0) / 1000);
    if (child.state === "working") out.subagents.running++;
    if (child.state === "blocked") out.subagents.blocked++;
    out.children.push(child);
  }
  if (children.entries.length > 256) out.children_complete = false;
  return out;
}
export class Worker implements Observer {
  running = false;
  stopping = false;
  requests: Request[] = [];
  results: Snapshot[] = [];
  api: API | null = null;
  accounts: Accounts | null = null;
  /** Sessions to look at again: an event touched them, or they are new here. */
  due = new Set<string>();
  /** When each session whose snapshot failed is tried again. */
  retry = new Map<string, number>();
  /** Each subagent's parent, whose snapshot reports it. */
  parents = new Map<string, string>();
  /** While the event stream is down, every session is polled each second. */
  live = false;
  swept = 0;
  /** The context window each catalog model lists, by `provider/id`. */
  catalog = new Map<string, bigint>();
  models = new Map<string, Model>();
  failure = new Failure();
  abort = new AbortController();
  timer: ReturnType<typeof setInterval>;
  constructor() {
    this.timer = setInterval(() => void this.run(), 250);
  }
  /** Marks the sessions an event touched, and the parent that reports a
   * subagent. Streamed text alone changes nothing a snapshot reports. */
  observe(event: Record<string, unknown>) {
    const type = str(event, "type"),
      session = eventSession(event);
    if (this.accounts?.invalidate(type)) {
      for (const request of this.requests) this.due.add(request.prefix.text());
    }
    if (!session || type.endsWith(".delta")) return;
    for (const id of [session, this.parents.get(session), str(field(event, "data"), "parentID")])
      if (id && this.requests.some(r => r.prefix.text() === id)) this.due.add(id);
  }
  reconcile(runtime: Runtime) {
    const known = new Set(this.requests.map(r => r.prefix.text()));
    this.requests = runtime.conversations.items
      .filter(
        a =>
          a.provider() === "opencode2" &&
          !runtime.sessions.some(s => s.members.includes(a)) &&
          validSession(a.state.sessionId()) &&
          (runtime.panes.some(p => !p.terminal.exited && p.attachment.actor === a) ||
            a.child_refresh ||
            ["working", "blocked"].includes(a.state.state)),
      )
      .slice(0, 64)
      .map(a => ({
        pane: 0,
        pid: 0,
        actor: a.id,
        prefix: new Text(a.state.sessionId()),
        generation: 0n,
        title_revision: 0n,
      }));
    const tracked = new Set(this.requests.map(r => r.prefix.text()));
    for (const session of tracked) if (!known.has(session)) this.due.add(session);
    for (const session of this.retry.keys()) if (!tracked.has(session)) this.retry.delete(session);
  }
  async run() {
    if (this.running || this.stopping || !this.requests.length) return;
    this.running = true;
    const now = Date.now(),
      sweep = now - this.swept >= (this.live ? 30000 : 1000),
      requests = this.requests.filter(r => {
        const session = r.prefix.text();
        return sweep || this.due.has(session) || (this.retry.get(session) ?? Infinity) <= now;
      });
    try {
      if (!requests.length) return;
      if (sweep) this.swept = now;
      for (const request of requests) this.due.delete(request.prefix.text());
      if (!this.api) {
        this.api = await API.open();
        this.accounts = new Accounts(this.api);
        void this.api.follow(this.abort.signal, {
          connected: () => {
            this.live = true;
            this.swept = 0;
          },
          event: event => this.observe(event),
          lost: () => (this.live = false),
        });
      }
      const active = data(await this.api.call("GET", "/api/session/active"));
      if (sweep) {
        try {
          const reply = await this.api.call("GET", "/api/model");
          this.catalog = windows(reply);
          this.models = modelCatalog.read(reply);
        } catch (error) {
          if (this.failure.changed(error)) log.warn("Model catalog failed", { err: error });
        }
      }
      let ok = true;
      for (const request of requests) {
        if (this.stopping) return;
        const session = request.prefix.text();
        try {
          const result = await snapshot(
            this.api,
            request,
            active,
            this.catalog,
            this.models,
            this.accounts ?? undefined,
          );
          this.retry.delete(session);
          for (const [child, parent] of this.parents) if (parent === session) this.parents.delete(child);
          for (const child of result.children) this.parents.set(child.session, session);
          if (!this.stopping) {
            this.results = this.results.filter(r => r.request.actor !== request.actor);
            this.results.push(result);
          }
        } catch (error) {
          ok = false;
          this.failed(session, error);
        }
      }
      if (ok && !this.retry.size && this.failure.clear()) log.info("Snapshots recovered");
    } catch (error) {
      for (const request of requests) this.failed(request.prefix.text(), error);
    } finally {
      this.running = false;
    }
  }
  failed(session: string, error: unknown) {
    this.retry.set(session, Date.now() + 2000);
    if (this.failure.changed(error)) log.warn("Snapshot failed", { session, err: error });
  }
  take() {
    const results = this.results;
    this.results = [];
    return results;
  }
  takeMissed() {
    return [];
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.abort.abort();
    this.results = [];
  }
}
