//! Opt-in live Pi/Luna checks: bun tools/pi_live.ts /absolute/path/to/pi/cli.js
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, EXE } from "../tests/runtime";
import { quote } from "../tests/support";
import * as protocol from "../src/protocol";
const cli = process.argv[2];
if (!cli) throw Error("Pass Pi's cli.js path");
const auth = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".pi/agent"), "auth.json");
class Live extends Runtime {
  account = "";
  async configure() {
    const root = join(this.temp.name, ".pi/agent");
    mkdirSync(root, { recursive: true });
    copyFileSync(auth, join(root, "auth.json"));
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6-luna",
        defaultThinkingLevel: "low",
        compaction: { keepRecentTokens: 1 },
      }),
    );
    if (process.argv.includes("--account")) {
      this.account = join(this.temp.name, ".pi/work");
      mkdirSync(this.account, { recursive: true });
      this.account = realpathSync(this.account);
      copyFileSync(join(root, "auth.json"), join(this.account, "auth.json"));
      copyFileSync(join(root, "settings.json"), join(this.account, "settings.json"));
    }
    this.env.PI_CODING_AGENT_DIR = root;
    this.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
    const ext = join(this.temp.name, "dialogs.js");
    writeFileSync(
      ext,
      'export default pi => { pi.registerCommand("corgi-confirm", {description:"test",handler:async (_args,ctx)=>{await ctx.ui.confirm("Corgi test","Continue?");}}); }',
    );
    const wrapper = join(this.temp.name, "pi");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} --session-dir ${quote(join(this.temp.name, "custom sessions"))} --no-extensions -e ${quote(join(root, "extensions/corgi.js"))} -e ${quote(ext)} --no-context-files --no-skills --no-prompt-templates --no-approve "$@"\n`,
      { mode: 0o700 },
    );
    this.env.CORGI_PI_BIN = wrapper;
  }
}
const t = new Live();
try {
  await t.setUp();
  if (t.account) await t.run_cli("account", "add", "pi", "work", "--dir", t.account);
  const pane = (await t.command("agent.create", { workspace: 1, provider: "pi", account: t.account, cwd: t.temp.name }))
    .pane;
  const agent = async () => (await t.session()).panes.find((p: any) => p.id === pane)?.agent;
  await t.until(async () => (await agent())?.state === "idle", 30);
  console.log("PASS terminal identity/idle", (await agent()).session);
  await t.command("pane.input", {
    target: pane,
    data: "Use write to create live.txt containing LIVE_OK. Then reply DONE.\r",
  });
  await t.until(async () => (await agent())?.state === "working", 20);
  await t.until(
    async () => (await agent())?.state === "idle" && BigInt((await agent()).observation.completed) > 0n,
    90,
  );
  if (readFileSync(join(t.temp.name, "live.txt"), "utf8").trim() !== "LIVE_OK") throw Error("WriteMissing");
  console.log("PASS working/tools/completed", JSON.stringify((await agent()).observation));
  await t.command("agent.rename", { target: pane, name: "Pi live test" });
  await t.until(async () => (await agent())?.name === "Pi live test", 15);
  console.log("PASS rename");
  const historySession = (await agent()).session;
  await t.until(
    async () =>
      (await t.rpc({ op: "agent.history", protocol: protocol.version })).history.entries.some(
        (e: any) => e.provider === "pi" && e.session === historySession && e.account === t.account,
      ),
    15,
  );
  console.log("PASS history from custom --session-dir");
  await t.command("pane.input", { target: pane, data: "/corgi-confirm\r" });
  await t.until(async () => (await agent())?.state === "blocked", 10);
  await t.command("pane.input", { target: pane, data: "\x1b" });
  await t.until(async () => (await agent())?.state === "idle", 10);
  console.log("PASS blocked/cancelled dialog");
  await t.command("pane.input", { target: pane, data: "Run bash command sleep 30 and then reply FINISHED.\r" });
  await t.until(async () => (await agent())?.tool_active, 60);
  await t.command("pane.input", { target: pane, data: "\x1b" });
  await t.until(
    async () => (await agent())?.state === "idle" && (await agent()).observation.outcome === "interrupted",
    20,
  );
  console.log("PASS interrupted");
  const session = (await agent()).session;
  await t.rpc({ op: "server.reload", executable: EXE, protocol: 1 });
  await t.until(async () => (await agent())?.session === session, 15);
  await t.command("pane.input", { target: pane, data: "Reply AFTER_RELOAD without tools.\r" });
  await t.until(async () => (await agent())?.state === "working", 15);
  await t.until(
    async () => (await agent())?.state === "idle" && (await agent()).observation.outcome === "completed",
    60,
  );
  console.log("PASS live reload and next turn");
  const fork = await t.command("agent.fork", { target: pane, name: "Pi fork test" });
  console.log("FORK", JSON.stringify(fork));
  await t.until(
    async () =>
      (await t.session()).panes.some(
        (p: any) => p.agent?.provider === "pi" && p.agent.session !== session && p.agent.state === "idle",
      ),
    30,
  );
  console.log("PASS fork");
  const receipt = (await agent()).observation.completed;
  await t.command("pane.input", { target: pane, data: "/compact\r" });
  await t.until(async () => (await agent())?.compacting, 15);
  await t.until(async () => (await agent())?.state === "idle" && !(await agent()).compacting, 90);
  if ((await agent()).observation.completed !== receipt) throw Error("IdleCompactionReceipt");
  console.log("PASS idle compaction without a completion receipt");
  await t.command("pane.input", { target: pane, data: "/new\r" });
  await t.until(async () => (await agent())?.session !== session && (await agent()).state === "idle", 30);
  console.log("PASS session switch");
  await t.command("pane.close", { target: pane });
  const resumed = (
    await t.command("agent.resume", { workspace: 1, provider: "pi", account: t.account, session, cwd: t.temp.name })
  ).pane;
  await t.until(
    async () =>
      (await t.session()).panes.some(
        (p: any) => p.id === resumed && p.agent.session === session && p.agent.state === "idle",
      ),
    30,
  );
  console.log("PASS resume");
  const ephemeral = (
    await t.open_pane({
      command:
        (t.account ? "PI_CODING_AGENT_DIR=" + quote(t.account) + " " : "") +
        quote(t.env.CORGI_PI_BIN!) +
        " --no-session",
      cwd: t.temp.name,
    })
  ).pane;
  const ep = async () => (await t.session()).panes.find((p: any) => p.id === ephemeral)?.agent;
  await t.until(async () => (await ep())?.state === "idle", 30);
  await t.command("pane.input", { target: ephemeral, data: "Reply EPHEMERAL_OK without tools.\r" });
  await t.until(async () => BigInt((await ep())?.observation.completed ?? 0) > 0n && (await ep()).state === "idle", 60);
  console.log("PASS ephemeral completion");
  const h = await t.rpc({
    op: "headless.start",
    protocol: protocol.version,
    provider: "pi",
    cwd: t.temp.name,
    prompt: "Run bash command sleep 8, then reply HEADLESS_DONE.",
  });
  const hs = async () =>
    (await t.rpc({ op: "headless.list", protocol: protocol.version })).sessions.find(
      (s: any) => s.provider === "pi" && s.session === h.session,
    );
  await t.until(async () => (await hs())?.ready, 30);
  await t.until(async () => (await hs())?.active_tools > 0, 60);
  const pid = (await hs()).pid;
  await t.rpc({ op: "server.reload", executable: EXE, protocol: 1 });
  await t.until(async () => (await hs())?.state === "idle" && BigInt((await hs()).observation.completed) > 0n, 60);
  if ((await hs()).pid !== pid) throw Error("HeadlessProcessReplaced");
  console.log("PASS headless live handoff during tool execution");
  await t.rpc({
    op: "headless.send",
    protocol: protocol.version,
    provider: "pi",
    session: h.session,
    input: { kind: "prompt", text: "/corgi-confirm" },
  });
  await t.until(async () => (await hs())?.state === "blocked", 10);
  await t.rpc({
    op: "headless.send",
    protocol: protocol.version,
    provider: "pi",
    session: h.session,
    input: { kind: "interrupt" },
  });
  await t.until(async () => (await hs())?.pending_requests === 0 && (await hs()).state !== "blocked", 10);
  console.log("PASS headless dialog interrupt");
  await t.rpc({ op: "headless.stop", protocol: protocol.version, provider: "pi", session: h.session });
  console.log("LIVE TERMINAL PASS", cli);
} catch (e) {
  console.error(e);
  if (t.env) {
    const state = await t.session().catch(() => null);
    console.error("STATE", JSON.stringify(state));
    for (const p of state?.panes ?? [])
      console.error("SCREEN", p.id, await t.command("pane.read", { target: p.id, view: "screen" }).catch(() => ""));
  }
  throw e;
} finally {
  await t.tearDown();
}
