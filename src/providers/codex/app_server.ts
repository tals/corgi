//! What Corgi asks a Codex app server besides sessions: the model it would
//! run, the account it signs in as, its threads and its config.
import { field, str, Text } from "../common";
import { cancelled, type Stopping } from "../../stopping";
import * as errors from "../../errors";
import { Rpc } from "./rpc";
import { account as readAccount, limits, monthlySpend } from "./account";
// Without tools, memories, hooks, plugins, agents, project docs or web search.
export const toolless = [
  "-c",
  "features.shell_tool=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.memories=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.code_mode=false",
  "-c",
  "features.skip_host_skill_discovery=true",
  "-c",
  "agents.enabled=false",
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'web_search="disabled"',
];
/** A tool-less app server, opened on the first request and kept until
 * closed. `account` picks its CODEX_HOME, "" the default. */
export class AppServer {
  private opening: Promise<Rpc> | null = null;
  constructor(
    readonly timeout_ms: number,
    readonly executable: string | null = null,
    readonly account = "",
  ) {}
  private async open() {
    // Imported late: discovery reaches back into the provider registry.
    const discovery = await import("../../discovery"),
      env = this.account ? { ...process.env, CODEX_HOME: this.account } : undefined,
      rpc = Rpc.spawn(this.executable ?? discovery.override("codex") ?? "codex", toolless, "/tmp", env);
    try {
      await rpc.request(
        "initialize",
        { clientInfo: { name: "corgi", version: "1" }, capabilities: { experimentalApi: true } },
        undefined,
        Date.now() + this.timeout_ms,
      );
      rpc.notify("initialized");
      return rpc;
    } catch (error) {
      rpc.io.close();
      throw error;
    }
  }
  async request(method: string, params: unknown, stopping?: Stopping) {
    if (cancelled(stopping)) throw Error("Cancelled");
    const opening = (this.opening ??= this.open());
    let rpc: Rpc;
    try {
      rpc = await opening;
    } catch (error) {
      if (this.opening === opening) this.opening = null;
      throw error;
    }
    // Closed while it opened: the request goes with it, though the server came up.
    if (this.opening !== opening) throw Error("Cancelled");
    try {
      return await rpc.request(method, params, stopping, Date.now() + this.timeout_ms);
    } catch (error) {
      if (!errors.is(error, "Cancelled")) this.close();
      throw error;
    }
  }
  /** Closes the server; the next request opens a fresh one. */
  close() {
    void this.opening?.then(
      rpc => rpc.io.close(),
      () => {},
    );
    this.opening = null;
  }
}
/** The model Codex runs in `cwd`: its configured one, else its default. */
export async function model(server: AppServer, cwd: string, stopping?: Stopping) {
  const settings = await server.request("config/read", { includeLayers: false, cwd }, stopping);
  const configured = str(field(field(settings, "result"), "config"), "model");
  if (configured) return new Text(configured);
  const models = await server.request("model/list", {}, stopping);
  const data = field(field(models, "result"), "data");
  if (Array.isArray(data))
    for (const entry of data)
      if (field(entry, "isDefault") === true && str(entry, "model")) return new Text(str(entry, "model"));
  throw Error("NoDefaultModel");
}
export async function account(server: AppServer, stopping?: Stopping) {
  const reply = await server.request("account/read", { refreshToken: false }, stopping),
    value = field(field(reply, "result"), "account");
  const response = readAccount(value);
  if (str(value, "type") !== "chatgpt") return response;
  try {
    const reply = await server.request("account/rateLimits/read", {}, stopping),
      result = field(reply, "result"),
      snapshot = field(field(result, "rateLimitsByLimitId"), "codex") ?? field(result, "rateLimits");
    response.limits = limits(snapshot);
    response.spend = monthlySpend(field(snapshot, "individualLimit"));
    // Business workspaces on credits report a monthly limit without quota windows.
    if (response.limits === "none" && response.spend !== null) response.limits = "metered";
    if (response.limits === "none") response.usage_error = new Text("no usage returned");
  } catch (error) {
    response.usage_error = new Text(errors.is(error, "Timeout") ? "request timed out" : "usage request failed");
  }
  return response;
}
export async function threads(server: AppServer, cursor: string | null, stopping?: Stopping) {
  return server.request("thread/list", { cursor, limit: 100, sortKey: "updated_at", useStateDbOnly: true }, stopping);
}
