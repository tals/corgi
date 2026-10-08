#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { grade, scorecard, validateCases, type Result, type Observation } from "./score";

const root = resolve(import.meta.dir, "..");
const defaults = ["claude:claude-haiku-5-5", "codex:gpt-6-luna"];
/** Runs the production prompt, parser and inference harness. */
const productionDriver = join(root, "evals/driver.ts");
const usage = `Activity abstention evals (live model calls using existing CLI logins)
  bun run evals/run.ts [--model PROVIDER:MODEL] [--repeat N] [--case ID]
                      [--out DIR] [--driver PATH] [--list]
Defaults: ${defaults.join(", ")}; one repeat; all cases.
Repeat --model or --case to select several. Any failed assertion or harness error exits 1.
  bun test evals                  # deterministic scorer checks, no model calls
`;

async function main() {
  const models: string[] = [], selected: string[] = [];
  let repeats = 1, out = join(root, "evals/results"), driver = productionDriver, list = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--help", "-h"].includes(flag)) { console.log(usage); return; }
    if (flag === "--list") { list = true; continue; }
    if (!["--model", "--repeat", "--case", "--out", "--driver"].includes(flag) || !args[i + 1]) throw new Error(`invalid argument: ${flag}\n${usage}`);
    const value = args[++i];
    if (flag === "--model") models.push(value);
    if (flag === "--case") selected.push(value);
    if (flag === "--repeat") { repeats = Number(value); if (!Number.isInteger(repeats) || repeats < 1 || repeats > 50) throw new Error("repeat must be 1..50"); }
    if (flag === "--out") out = resolve(value);
    if (flag === "--driver") driver = resolve(value);
  }
  const allCases = validateCases(JSON.parse(await readFile(join(root, "evals/cases.json"), "utf8")));
  if (list) { console.log(allCases.map(c => `${c.id}\t${c.category}\t${c.steps.length} step(s)`).join("\n")); return; }
  for (const id of selected) if (!allCases.some(c => c.id === id)) throw new Error(`unknown case: ${id}`);
  const cases = allCases.filter(c => !selected.length || selected.includes(c.id));
  const targets = [...new Set(models.length ? models : defaults)].map(spec => {
    const separator = spec.indexOf(":");
    const provider = spec.slice(0, separator), model = spec.slice(separator + 1);
    if (separator < 0 || !["codex", "claude"].includes(provider) || !model || /[\s\x00-\x1f]/.test(model)) throw new Error(`invalid model: ${spec}`);
    return { spec, provider, model };
  });
  const started = new Date().toISOString();
  const runID = started.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(out, runID);
  await mkdir(runDir, { recursive: true });
  const expected: Omit<Result, "model" | "provider" | "observation" | "failures">[] = [];
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const scenario of cases) {
    const id = `${scenario.id}#${repeat}`;
    plan.push({ id, steps: scenario.steps.map((step, index) => {
      const stepID = `${id}/${index + 1}`;
      expected.push({ id: stepID, scenario: scenario.id, category: scenario.category, repeat, expected: step });
      return { id: stepID, evidence: step.evidence, turn: step.turn ?? `turn-${index + 1}` };
    }) });
  }
  const planPath = join(runDir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const tracked = ["evals/cases.json", "evals/driver.ts", "evals/score.ts", "evals/run.ts", "src/activity/prompt.ts", "src/activity/summary.ts", "src/summary_backend.ts", "src/inference/harness.ts"];
  const hashes = Object.fromEntries(await Promise.all(tracked.map(async file => [file, createHash("sha256").update(await readFile(join(root, file))).digest("hex")])));
  const binaryHash = createHash("sha256").update(await readFile(driver)).digest("hex");
  const git = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const commit = (await new Response(git.stdout).text()).trim();
  await git.exited;
  const results: Result[] = [], infrastructure: string[] = [];
  let interrupted = false;
  // One driver at a time keeps resource use bounded and makes Ctrl-C cleanup simple.
  for (const target of targets) {
    if (interrupted) {
      for (const assertion of expected) results.push({ ...assertion, model: target.spec, provider: target.provider, observation: null, failures: ["run interrupted"] });
      continue;
    }
    console.log(`\n${target.spec}: ${expected.length} assertions`);
    const observations = new Map<string, Observation>();
    const known = new Set(expected.map(e => e.id));
    const child = Bun.spawn([...(driver.endsWith(".ts") ? [process.execPath] : []), driver, target.provider, target.model, planPath], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const interrupt = () => { interrupted = true; child.kill("SIGTERM"); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    // Drain both pipes concurrently. Model/request timeouts live in the driver.
    const stderr = new Response(child.stderr).text();
    let pending = "";
    const decoder = new TextDecoder();
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const row = JSON.parse(line) as Observation;
        if (!known.has(row.id) || observations.has(row.id) || !Number.isFinite(row.elapsed_ms)) throw new Error("unexpected/duplicate result or invalid timing");
        observations.set(row.id, row);
        const assertion = expected.find(e => e.id === row.id)!;
        const failures = grade(assertion.expected, row);
        console.log(`  ${failures.length ? "FAIL" : "PASS"} ${row.id}: ${row.label ?? row.err ?? "(abstain)"}${failures.length ? ` — ${failures.join("; ")}` : ""}`);
      } catch (error) { infrastructure.push(`${target.spec}: invalid driver output: ${String(error)}`); }
    };
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
    const code = await child.exited;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await writeFile(join(runDir, `${targets.indexOf(target)}.stderr.log`), await stderr);
    if (code !== 0) infrastructure.push(`${target.spec}: driver exited ${code}`);
    for (const assertion of expected) {
      const observation = observations.get(assertion.id) ?? null;
      results.push({ ...assertion, model: target.spec, provider: target.provider, observation, failures: grade(assertion.expected, observation) });
    }
  }
  const fixture = Boolean(process.env.CORGI_EVAL_HARNESS) || driver !== productionDriver;
  const metadata = { started, finished: new Date().toISOString(), commit, hashes, binaryHash, driver, fixture, repeats, cases: cases.map(c => c.id), models: targets, infrastructure };
  const report = { metadata, results };
  const failures = results.filter(r => r.failures.length);
  const markdown = [`# Activity summary eval scorecard`, "", `Run: ${started}. ${fixture ? "**Fixture run — not live model evidence.**" : "Live model calls using the production inference harness."}`, `Repeats: ${repeats}. Cases: ${cases.length}. Assertions per model: ${expected.length}.`, `Commit: \`${commit}\`. Source and driver hashes are recorded in the JSON report.`, "", scorecard(results), "", "Every assertion must pass. Errors and missing responses count as failures. Sequence scores count individual steps, including later steps after an abstention.", "", failures.length ? "## Failures\n\n" + failures.map(r => `- ${r.model} / ${r.id}: ${r.failures.join("; ")} (output: ${JSON.stringify(r.observation?.label ?? r.observation?.err ?? null)})`).join("\n") : "All assertions passed.", ...infrastructure.map(e => `\nInfrastructure failure: ${e}`), "", "Topic assertions allow wording variations and are deliberately conservative; they are deterministic regression checks, not a proof of semantic correctness."].join("\n");
  await Promise.all([writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n"), writeFile(join(runDir, "scorecard.md"), markdown + "\n"), writeFile(join(out, "latest.json"), JSON.stringify(report, null, 2) + "\n"), writeFile(join(out, "latest.md"), markdown + "\n")]);
  console.log(`\n${scorecard(results)}\n\nReport: ${join(runDir, "scorecard.md")}`);
  if (failures.length || infrastructure.length) process.exitCode = 1;
}

main().catch(error => { console.error(String(error)); process.exitCode = 1; });
