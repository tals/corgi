import path from "node:path";
import { Path } from "../../bounded_text";
import { Text, field, str } from "../common";
import { Child, Name, Role, Snapshot, Turn, type Request } from "../snapshot";
import type { Observer } from "../adapter";
import { commandDirectory, configDir, titleSession, writes } from "./index";
import { Client } from "./socket";
import * as errors from "../../errors";
import { Inventory, capacity } from "../../activity/background_tasks";
import { Text as SummaryText } from "../../activity/summary";
import type { State } from "../../agents";
import type { Runtime } from "../../runtime";
import type { Location } from "../../worktrees";
function transcriptPath(value: string) {
  try {
    return Path.init(value);
  } catch {
    return new Path();
  }
}
/** What a turn shows the summarizer: the latest agent message and the user's request. */
export function evidence(turn: any) {
  const items = field(turn, "items");
  if (!Array.isArray(items)) return new SummaryText();
  let latest = "",
    out = "";
  for (const item of items) if (str(item, "type") === "agentMessage") latest = str(item, "text");
  if (latest) out = `Latest agent update: ${latest.slice(0, 1400)}\n`;
  for (const item of items) {
    if (str(item, "type") !== "userMessage" || !Array.isArray(field(item, "content"))) continue;
    out += "User request: ";
    for (const part of field(item, "content")) if (str(part, "type") === "text") out += str(part, "text");
    break;
  }
  return new SummaryText(out.slice(0, 2048));
}
export function unique(ids: string[], prefix: Text) {
  const matching = ids.filter(id => typeof id === "string" && id.length === 36 && id.startsWith(prefix.text()));
  return matching.length === 1 ? matching[0] : null;
}
export function needsInput(status: any) {
  const flags = field(status, "activeFlags");
  return Array.isArray(flags) && flags.some(f => ["waitingOnApproval", "waitingOnUserInput"].includes(f));
}
export function threadState(status: any): State {
  switch (str(status, "type")) {
    case "active":
      return needsInput(status) ? "blocked" : "working";
    case "idle":
    case "notLoaded":
    case "systemError":
      return "idle";
    default:
      return "unknown";
  }
}
/** A spawned child's task name, from its agent path without "/root/",
 * ahead of the random nickname Codex also gives it. */
export function childName(thread: any) {
  const spawn = field(field(field(thread, "source"), "subAgent"), "thread_spawn");
  const task = str(spawn, "agent_path").replace(/^\/root\//, "");
  return str(thread, "name") || task || str(thread, "agentNickname");
}
async function pages(
  client: Pick<Client, "call">,
  method: string,
  params: any,
  visit: (entry: any) => boolean | void,
  errorName: string,
) {
  let cursor: string | null = null;
  const deadline = Date.now() + 1000;
  for (let i = 0; i < 32; i++) {
    if (Date.now() >= deadline) throw Error("Timeout");
    const page = await client.call(method, { ...params, cursor }),
      result = field(page, "result"),
      data = field(result, "data");
    if (!Array.isArray(data)) throw Error("BadResponse");
    for (const entry of data) if (visit(entry) === true) return true;
    const next = field(result, "nextCursor");
    if (next === null) return false;
    if (typeof next !== "string") throw Error("BadResponse");
    cursor = next;
  }
  throw Error(errorName);
}
export function isActiveWait(entry: any, turn: string, session: string) {
  const item = field(entry, "item");
  return (
    str(entry, "turnId") === turn &&
    str(item, "type") === "collabAgentToolCall" &&
    str(item, "tool") === "wait" &&
    str(item, "status") === "inProgress" &&
    str(item, "senderThreadId") === session
  );
}
/** The newest turn with location evidence: its newest edit, else the
 * newest directory a command chose, else the thread's own folder. */
export async function location(client: Pick<Client, "call">, session: string, cwd: string): Promise<Location | null> {
  let turn = "",
    edited: string[] = [],
    named = "";
  const ran = new Set<string>(),
    own = (directory: string) => !!cwd && path.resolve(directory) === path.resolve(cwd);
  await pages(
    client,
    "thread/items/list",
    { threadId: session, limit: 100, sortDirection: "desc" },
    entry => {
      const id = str(entry, "turnId"),
        item = field(entry, "item");
      if (!id) return;
      if (turn && id !== turn) return true;
      const written = writes([item], cwd);
      if (written.length) {
        [turn, edited] = [id, written];
        return true;
      }
      const directory = commandDirectory(item);
      if (!directory) return;
      turn = id;
      ran.add(directory);
      if (!named && !own(directory)) named = directory;
    },
    "TooManyItems",
  );
  return turn ? { cwd: named || cwd, writes: edited, ran: [...ran], basis: named ? "named" : "default" } : null;
}
export async function snapshot(client: Client, req: Request, session: string) {
  const meta = await client.call("thread/read", {
      threadId: session,
      includeTurns: false,
    }),
    thread = field(field(meta, "result"), "thread");
  if (str(thread, "id") !== session) throw Error("WrongThread");
  let state = threadState(field(thread, "status"));
  if (state === "unknown") state = "initializing";
  const out = new Snapshot(req, session, state);
  // Codex lists no turns or items of an ephemeral thread.
  out.ephemeral = field(thread, "ephemeral") === true;
  if (out.ephemeral) return out;
  if (path.isAbsolute(str(thread, "cwd"))) out.cwd = transcriptPath(str(thread, "cwd"));
  if (Number.isInteger(field(thread, "updatedAt")) && field(thread, "updatedAt") > 0)
    out.updated_at = field(thread, "updatedAt");
  out.name = new Name(str(thread, "name"));
  if (path.isAbsolute(str(thread, "path"))) out.transcript = transcriptPath(str(thread, "path"));
  const turns = await client.call("thread/turns/list", {
      threadId: session,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    }),
    data = field(field(turns, "result"), "data");
  if (Array.isArray(data) && data.length) {
    out.evidence = evidence(data[0]);
    const id = str(data[0], "id");
    if (id && Buffer.byteLength(id) <= 128) {
      out.turn = new Turn(id);
      const status = str(data[0], "status");
      if (status === "completed" || status === "interrupted" || status === "failed") out.outcome = status;
    }
  }
  try {
    out.location = await location(client, session, out.cwd.text());
  } catch {}
  try {
    const reply = await client.call("thread/backgroundTerminals/list", {
        threadId: session,
        limit: capacity,
      }),
      body = field(reply, "result"),
      data = field(body, "data");
    if (!Array.isArray(data)) throw Error("BadResponse");
    out.background_tasks.observed_at = out.observed_at;
    out.background_tasks.live = true;
    for (const item of data) out.background_tasks.append(str(item, "processId"), "", str(item, "command"));
    out.background_tasks.truncated ||= field(body, "nextCursor") !== null;
    if (out.background_tasks.len)
      out.evidence = new SummaryText(
        (
          "Currently running background tasks:\n" +
          out.background_tasks.items
            .slice(0, 4)
            .map(t => t.label.text() + "\n")
            .join("") +
          out.evidence.text()
        ).slice(0, 2048),
      );
  } catch {
    out.background_tasks = new Inventory();
  }
  let any = false;
  try {
    await pages(
      client,
      "thread/list",
      {
        parentThreadId: session,
        sourceKinds: ["subAgent"],
        useStateDbOnly: true,
        limit: 100,
      },
      thread => {
        if (str(thread, "parentThreadId") !== session) return;
        any = true;
        const id = str(thread, "id");
        if (out.children.some(c => c.session === id)) return;
        if (str(field(thread, "status"), "type") === "active") {
          if (needsInput(field(thread, "status"))) out.subagents.blocked++;
          else out.subagents.running++;
        }
        const prefix = titleSession(id);
        if (prefix?.len !== 36 || id === session) return;
        if (out.children.length >= 1024) throw Error("TooManyThreads");
        const child = new Child();
        child.session = id;
        child.state = threadState(field(thread, "status"));
        child.name = Name.ascii(childName(thread));
        child.role = Role.ascii(str(thread, "agentRole"));
        if (path.isAbsolute(str(thread, "path"))) child.transcript = transcriptPath(str(thread, "path"));
        if (Number.isInteger(field(thread, "updatedAt"))) child.updated_at = field(thread, "updatedAt");
        out.children.push(child);
      },
      "TooManyThreads",
    );
    out.children_complete = true;
  } catch {
    out.children = [];
    out.subagents = { running: 0, blocked: 0, waiting: false };
    return out;
  }
  if (any && state === "working" && out.turn.len && !out.outcome)
    try {
      out.subagents.waiting = await pages(
        client,
        "thread/items/list",
        {
          threadId: session,
          turnId: out.turn.text(),
          limit: 100,
          sortDirection: "desc",
        },
        e => isActiveWait(e, out.turn.text(), session),
        "TooManyItems",
      );
    } catch {}
  return out;
}
export class Worker implements Observer {
  stopping = false;
  requests: Request[] = [];
  cursor = 0;
  results: Snapshot[] = [];
  /** Pane requests whose thread the daemon doesn't have, or no daemon to ask. */
  missed: Request[] = [];
  socket: string;
  timer: ReturnType<typeof setInterval> | null = null;
  running = false;
  /** It watches the panes of `account`, through that account's daemon. */
  constructor(readonly account = "") {
    this.socket = path.join(account || configDir(), "app-server-control/app-server-control.sock");
  }
  static start(account = "") {
    const w = new Worker(account);
    w.timer = setInterval(() => void w.run(), 500);
    return w;
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.results = [];
    this.missed = [];
  }
  take() {
    const results = this.results;
    this.results = [];
    return results;
  }
  takeMissed() {
    const missed = this.missed;
    this.missed = [];
    return missed;
  }
  private miss(req: Request) {
    this.missed = this.missed.filter(old => old.pane !== req.pane);
    this.missed.push(req);
  }
  reconcile(runtime: Runtime) {
    this.requests = [];
    const panes = runtime.panes;
    for (const p of panes) {
      if (
        p.terminal.exited ||
        p.agent().provider !== "codex" ||
        p.account() !== this.account ||
        p.detection.pid <= 0 ||
        p.detection.missing
      )
        continue;
      const title = p.terminal.titleInfo();
      if (title.pid !== p.detection.pid) continue;
      const prefix = titleSession(title.text),
        actor = p.attachment.actor;
      if (!prefix) continue;
      // Behind a side conversation, follow the conversation it forked.
      if (p.attachment.side && actor)
        this.requests.push({
          pane: 0,
          pid: 0,
          prefix: new Text(actor.state.sessionId()),
          actor: actor.id,
          generation: 0n,
          title_revision: 0n,
        });
      else
        this.requests.push({
          pane: p.id,
          pid: p.detection.pid,
          prefix,
          actor: 0,
          generation: p.attachment.generation,
          title_revision: title.revision,
        });
      if (this.requests.length === 64) break;
    }
    const actors = runtime.conversations.items,
      shown = (actor: (typeof actors)[number]) => panes.find(p => !p.terminal.exited && p.attachment.actor === actor);
    /** The account of the nearest conversation up from `actor` that a pane shows; "" without one. */
    const account = (actor: (typeof actors)[number]) => {
      for (let at: typeof actor | null = actor, i = 0; at && i < 16; i++) {
        const pane = shown(at);
        if (pane) return pane.account();
        at = at.parent === null ? null : runtime.conversations.byId(at.parent);
      }
      return "";
    };
    for (let offset = 0; offset < actors.length && this.requests.length < 64; offset++) {
      const actor = actors[(this.cursor + offset) % actors.length];
      if (
        actor.state.provider !== "codex" ||
        actor.state.session.len !== 36 ||
        (!["working", "blocked"].includes(actor.state.state) && !actor.child_refresh)
      )
        continue;
      if (shown(actor) || account(actor) !== this.account) continue;
      this.requests.push({
        pane: 0,
        pid: 0,
        prefix: new Text(actor.state.sessionId()),
        actor: actor.id,
        generation: 0n,
        title_revision: 0n,
      });
    }
    if (actors.length) this.cursor = (this.cursor + 1) % actors.length;
  }
  async run() {
    if (this.running || this.stopping || !this.requests.length) return;
    this.running = true;
    let client: Client | null = null;
    try {
      try {
        client = await Client.open(this.socket);
      } catch (error) {
        if (errors.is(error, "ConnectFailed")) for (const req of this.requests) if (!req.actor) this.miss(req);
        throw error;
      }
      const ids: string[] = [];
      await pages(
        client,
        "thread/loaded/list",
        { limit: 100 },
        id => {
          if (typeof id === "string") ids.push(id);
        },
        "TooManyThreads",
      );
      for (const req of [...this.requests]) {
        if (this.stopping) return;
        const session = req.actor ? req.prefix.text() : unique(ids, req.prefix);
        if (!session) {
          this.miss(req);
          continue;
        }
        try {
          const s = await snapshot(client, req, session);
          this.results = this.results.filter(old => old.request.pane !== req.pane || old.request.actor !== req.actor);
          this.results.push(s);
        } catch {}
      }
    } catch {
    } finally {
      client?.close();
      this.running = false;
    }
  }
}
