#!/usr/bin/env bun
/** Launcher metadata only: any model prompt fails this fixture. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const root = process.env.CLAUDE_CONFIG_DIR!;
const config = () => JSON.parse(readFileSync(join(root, "metadata.json"), "utf8"));
const log = (kind: string) => appendFileSync(join(root, "metadata-requests.jsonl"), JSON.stringify({ kind, pid: process.pid }) + "\n");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  log("auth");
  const data = config();
  if (data.authMalformed) { console.log("invalid"); process.exit(0); }
  console.log(JSON.stringify({ loggedIn: data.loggedIn !== false, authMethod: "claude.ai", email: data.email ?? "claude@example.com", orgId: "fixture-org", subscriptionType: "max" }));
  process.exit(data.loggedIn === false ? 1 : 0);
}
if (!args.includes("--input-format")) {
  if (process.env.CORGI_CLAUDE_TEST_LAUNCHES) appendFileSync(process.env.CORGI_CLAUDE_TEST_LAUNCHES, JSON.stringify({ cwd: process.cwd(), args }) + "\n");
  if (args.at(-1) === "refused") { console.log("That session is running in the background."); process.exit(1); }
  if (args.at(-1) === "quits") process.exit(0);
  console.log("LAUNCH FIXTURE READY"); await Bun.stdin.text(); process.exit(0);
}
log("start");
for (const flag of ["--no-session-persistence", "--strict-mcp-config", "--tools", "--setting-sources"])
  if (!args.includes(flag)) throw new Error("missing isolation flag: " + flag);
if (args[args.indexOf("--tools") + 1] !== "") throw new Error("tools enabled");
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
if (!settings.disableAllHooks || settings.remoteControlAtStartup !== false) throw new Error("hooks or remote control enabled");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type !== "control_request") throw new Error("model prompt sent");
  const method = request.request.subtype;
  log(method);
  const data = config();
  if (method === "get_usage" && request.request.skip_behaviors !== true) throw new Error("transcript scan enabled");
  if (method === "get_usage" && data.mode === "exit") process.exit(1);
  if (method === "get_usage" && data.mode === "hang") continue;
  const body = method === "initialize" ? {} : data.mode === "malformed" ? {} : {
    subscription_type: "max", rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: "2099-01-01T12:00:00.000000+00:00" }, seven_day: { utilization: 48, resets_at: "2099-01-04T12:00:00Z" } },
  };
  console.log(JSON.stringify({ type: "control_response", response: { request_id: request.request_id,
    subtype: method === "get_usage" && data.mode === "unsupported" ? "error" : "success", response: body } }));
}
