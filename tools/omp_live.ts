//! Opt-in live omp checks against the signed-in default model: bun tools/omp_live.ts [omp]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Runtime, EXE } from "../tests/runtime";
import { quote } from "../tests/support";
import * as protocol from "../src/protocol";
const omp = process.argv[2] ?? Bun.which("omp");
if (!omp) throw Error("Pass omp's path");
const home = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".omp/agent");
class Live extends Runtime {
  async configure() {
    const root = join(this.temp.name, ".omp/agent");
    mkdirSync(root, { recursive: true });
    // A consistent copy of the sign-ins, without omp's other state.
    const db = new Database(join(home, "agent.db"), { readonly: true });
    db.run(`VACUUM INTO '${join(root, "agent.db").replaceAll("'", "''")}'`);
    db.close();
    if (existsSync(join(home, "config.yml"))) copyFileSync(join(home, "config.yml"), join(root, "config.yml"));
    // The runtime's HOME makes this omp's default folder.
    delete this.env.PI_CODING_AGENT_DIR;
    const ext = join(this.temp.name, "dialogs.js");
    writeFileSync(
      ext,
      'export default pi => { pi.registerCommand("corgi-confirm", {description:"test",handler:async (_args,ctx)=>{await ctx.ui.confirm("Corgi test","Continue?");}}); }',
    );
    const wrapper = join(this.temp.name, "omp");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${quote(omp!)} --session-dir ${quote(join(this.temp.name, "custom sessions"))} --no-extensions -e ${quote(join(root, "extensions/corgi.js"))} -e ${quote(ext)} --no-rules --no-skills --no-lsp --thinking low "$@"\n`,
      { mode: 0o700 },
    );
    this.env.CORGI_OMP_BIN = wrapper;
    mkdirSync(project());
  }
}
const t = new Live();
// omp leaves HOME for a temporary folder, and HOME is the runtime's folder.
const project = () => join(t.temp.name, "project");
try {
  await t.setUp();
  const pane = (await t.command("agent.create", { workspace: 1, provider: "omp", cwd: project() })).pane;
  const agent = async () => (await t.session()).panes.find((p: any) => p.id === pane)?.agent;
  // omp takes text and Enter in one read as a paste, so Enter comes on its own.
  const submit = async (text: string) => {
    await t.command("pane.input", { target: pane, data: text });
    await Bun.sleep(500);
    await t.command("pane.input", { target: pane, data: "\r" });
  };
  await t.until(async () => (await agent())?.state === "idle", 60);
  console.log("PASS terminal identity/idle", (await agent()).session);
  await submit("Use write to create live.txt containing LIVE_OK. Then reply DONE.");
  await t.until(async () => (await agent())?.state === "working", 20);
  await t.until(
    async () => (await agent())?.state === "idle" && BigInt((await agent()).observation.completed) > 0n,
    120,
  );
  if (readFileSync(join(project(), "live.txt"), "utf8").trim() !== "LIVE_OK") throw Error("WriteMissing");
  console.log("PASS working/tools/completed", JSON.stringify((await agent()).observation));
  await t.command("agent.rename", { target: pane, name: "omp live test" });
  await t.until(async () => (await agent())?.name === "omp live test", 15);
  console.log("PASS rename");
  const session = (await agent()).session;
  await t.until(
    async () =>
      (await t.rpc({ op: "agent.history", protocol: protocol.version })).history.entries.some(
        (e: any) => e.provider === "omp" && e.session === session,
      ),
    15,
  );
  console.log("PASS history from custom --session-dir");
  // omp tells extensions about its own prompts, not another extension's dialogs.
  await submit("/corgi-confirm");
  await Bun.sleep(2000);
  if ((await agent())?.state !== "idle") throw Error("DialogChangedState");
  await t.command("pane.input", { target: pane, data: "\x1b" });
  await Bun.sleep(1000);
  console.log("PASS extension dialogs leave it idle");
  await submit("Run bash command sleep 30 and then reply FINISHED.");
  await t.until(async () => (await agent())?.tool_active, 60);
  await t.command("pane.input", { target: pane, data: "\x1b" });
  await t.until(
    async () => (await agent())?.state === "idle" && (await agent()).observation.outcome === "interrupted",
    20,
  );
  console.log("PASS interrupted");
  await t.rpc({ op: "server.reload", executable: EXE, protocol: 1 });
  await t.until(async () => (await agent())?.session === session, 15);
  await submit("Reply AFTER_RELOAD without tools.");
  await t.until(async () => (await agent())?.state === "working", 15);
  await t.until(
    async () => (await agent())?.state === "idle" && (await agent()).observation.outcome === "completed",
    90,
  );
  console.log("PASS live reload and next turn");
  const fork = await t.command("agent.fork", { target: pane, name: "omp fork test" });
  console.log("FORK", JSON.stringify(fork));
  await t.until(
    async () =>
      (await t.session()).panes.some(
        (p: any) => p.agent?.provider === "omp" && p.agent.session !== session && p.agent.state === "idle",
      ),
    45,
  );
  console.log("PASS fork");
  const receipt = (await agent()).observation.completed;
  await submit("/compact");
  await Bun.sleep(5000);
  await t.until(async () => (await agent())?.state === "idle" && !(await agent()).compacting, 120);
  if ((await agent()).observation.completed !== receipt) throw Error("IdleCompactionReceipt");
  console.log("PASS idle compaction without a completion receipt");
  await submit("/new");
  await t.until(async () => (await agent())?.session !== session && (await agent()).state === "idle", 30);
  console.log("PASS session switch");
  await t.command("pane.close", { target: pane });
  const resumed = (await t.command("agent.resume", { workspace: 1, provider: "omp", session, cwd: project() })).pane;
  await t.until(
    async () =>
      (await t.session()).panes.some(
        (p: any) => p.id === resumed && p.agent.session === session && p.agent.state === "idle",
      ),
    45,
  );
  console.log("PASS resume");
  const h = await t.rpc({
    op: "headless.start",
    protocol: protocol.version,
    provider: "omp",
    cwd: project(),
    prompt: "Run bash command sleep 8, then reply HEADLESS_DONE.",
  });
  const hs = async () =>
    (await t.rpc({ op: "headless.list", protocol: protocol.version })).sessions.find(
      (s: any) => s.provider === "omp" && s.session === h.session,
    );
  await t.until(async () => (await hs())?.ready, 45);
  await t.until(async () => (await hs())?.active_tools > 0, 60);
  const pid = (await hs()).pid;
  await t.rpc({ op: "server.reload", executable: EXE, protocol: 1 });
  await t.until(async () => (await hs())?.state === "idle" && BigInt((await hs()).observation.completed) > 0n, 90);
  if ((await hs()).pid !== pid) throw Error("HeadlessProcessReplaced");
  console.log("PASS headless live handoff during tool execution");
  await t.rpc({
    op: "headless.send",
    protocol: protocol.version,
    provider: "omp",
    session: h.session,
    input: { kind: "prompt", text: "/corgi-confirm" },
  });
  await t.until(async () => (await hs())?.state === "blocked", 10);
  await t.rpc({
    op: "headless.send",
    protocol: protocol.version,
    provider: "omp",
    session: h.session,
    input: { kind: "interrupt" },
  });
  await t.until(async () => (await hs())?.pending_requests === 0 && (await hs()).state !== "blocked", 10);
  console.log("PASS headless dialog interrupt");
  await t.rpc({ op: "headless.stop", protocol: protocol.version, provider: "omp", session: h.session });
  console.log("LIVE TERMINAL PASS", omp);
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
  // omp's worker broker exits a few seconds after its last omp does.
  if (t.env) {
    for (const p of (await t.session().catch(() => null))?.panes ?? [])
      await t.command("pane.close", { target: p.id }).catch(() => {});
    await Bun.sleep(6000);
  }
  await t.tearDown();
}
