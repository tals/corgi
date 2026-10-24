//! Opt-in omp RPC queue, write, stop and recovery checks: bun tools/omp_rpc_live.ts [omp]
import { Omp } from "../src/providers/omp/headless";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
const dir = mkdtempSync("/tmp/corgi-omp-rpc-");
const executable = process.argv[2] ?? Bun.which("omp");
if (!executable) throw Error("Pass omp's path");
// A disposable agent folder with a copy of the sign-ins, so omp's own state stays untouched.
const home = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".omp/agent"),
  agent = join(dir, "agent");
mkdirSync(agent);
const db = new Database(join(home, "agent.db"), { readonly: true });
db.run(`VACUUM INTO '${join(agent, "agent.db").replaceAll("'", "''")}'`);
db.close();
if (existsSync(join(home, "config.yml"))) copyFileSync(join(home, "config.yml"), join(agent, "config.yml"));
const c = Omp.start({ cwd: dir, account: agent, executable }, [
  "--session-dir",
  dir + "/sessions",
  "--thinking",
  "low",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-lsp",
  "--no-title",
  "--auto-approve",
]);
async function until(fn: (ev: any[]) => boolean, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const events = c.take();
    for (const e of events) console.log(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (fn(events)) return;
    await c.wait(Date.now() + 10);
  }
  throw Error("timeout");
}
try {
  await until(() => c.ready, 30000);
  c.send({
    kind: "prompt",
    text: "Use the write tool to create result.txt containing exactly OMP_OK. Then reply with OMP_DONE.",
  });
  await until(es => es.some(e => e.kind === "turn" && e.phase === "ended"));
  if ((await Bun.file(dir + "/result.txt").text()).trim() !== "OMP_OK") throw Error("missing write");
  c.send({ kind: "prompt", text: "Run bash command sleep 20. Then say SLEEP_DONE." });
  await until(es => es.some(e => e.kind === "tool" && !e.done));
  c.send({ kind: "prompt", text: "Create must-not-exist.txt containing QUEUED." });
  c.send({ kind: "interrupt" });
  await until(es => es.some(e => e.kind === "turn" && e.phase === "ended" && e.outcome === "interrupted"));
  if (await Bun.file(dir + "/must-not-exist.txt").exists()) throw Error("queue continued");
  c.send({ kind: "prompt", text: "Reply with RECOVERED, without tools." });
  await until(es => es.some(e => e.kind === "turn" && e.phase === "ended" && e.outcome === "completed"));
  if (await Bun.file(dir + "/must-not-exist.txt").exists()) throw Error("queue survived stop into next run");
  c.send({ kind: "prompt", text: "/session" });
  await until(es => es.some(e => e.kind === "turn" && e.phase === "ended"), 20000);
  console.log("LIVE PASS", executable);
} finally {
  c.close();
  rmSync(dir, { recursive: true, force: true });
}
