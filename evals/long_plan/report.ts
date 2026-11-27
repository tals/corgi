#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as history from "./history";
import * as scoring from "./score";
import type { Case } from "./run";
import type { State } from "./plan";

const refresh = process.argv.includes("--refresh-usage");
const [manifest, ...directories] = process.argv.slice(2).filter(arg => arg !== "--refresh-usage");
if (!manifest || !directories.length) throw Error("Usage: bun evals/long_plan/report.ts MANIFEST RUN_DIR [RUN_DIR...]");
const cases: (Pick<Case, "id" | "checks"> & Partial<Pick<Case, "label">>)[] = JSON.parse(
  fs.readFileSync(manifest, "utf8"),
);
for (const directory of directories) {
  const original = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
  const rows: string[] = [],
    results = [];
  let elapsed = 0,
    updates = 0,
    invalid = 0,
    input = 0n,
    output = 0n,
    cached = 0n;
  const latencies: number[] = [];
  for (const result of original.cases) {
    const accounted = path.join(directory, `${result.id}.accounted.history.json`);
    let data: history.History = JSON.parse(
      fs.readFileSync(fs.existsSync(accounted) ? accounted : path.join(directory, `${result.id}.history.json`), "utf8"),
    );
    if (refresh) {
      data = history.reaccount(data);
      fs.writeFileSync(accounted, JSON.stringify(data, null, 2) + "\n");
    }
    const calls: {
      state?: State;
      elapsed_ms: number;
      usage?: { input: string; output: string; cached_input: string };
      attempts?: { usage: { input: string; output: string; cached_input: string } }[];
    }[] = JSON.parse(fs.readFileSync(path.join(directory, `${result.id}.calls.json`), "utf8"));
    const snapshots = calls.flatMap(c => (c.state ? [c.state] : []));
    const rubric = cases.find(c => c.id === result.id);
    if (!rubric) throw Error(`MissingRubric:${result.id}`);
    const checks = scoring.score(data, snapshots, rubric.checks),
      metrics = scoring.metrics(data, snapshots);
    for (const call of calls) {
      elapsed += call.elapsed_ms;
      updates++;
      latencies.push(call.elapsed_ms);
      for (const attempt of call.attempts ?? (call.usage ? [{ usage: call.usage }] : [])) {
        input += BigInt(attempt.usage.input);
        output += BigInt(attempt.usage.output);
        cached += BigInt(attempt.usage.cached_input);
      }
    }
    invalid += result.errors.length;
    rows.push(
      `| ${result.id} | ${checks.filter(c => c.pass).length}/${checks.length} | ${result.errors.length} | ${metrics.goals} / ${metrics.episodes} / ${metrics.steps} | ${metrics.attributed_token_fraction === null ? "unknown" : (100 * metrics.attributed_token_fraction).toFixed(1) + "%"} |`,
    );
    results.push({
      id: result.id,
      label: rubric.label ?? result.label,
      source_hash: data.sha256,
      accounting_hash: data.accounting_hash ?? (fs.existsSync(accounted) ? null : original.source_hashes["history.ts"]),
      checks,
      metrics,
      errors: result.errors,
    });
  }
  latencies.sort((a, b) => a - b);
  const quantile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  const summary = {
    model: original.model,
    baseline: original.baseline,
    ablation: original.ablation,
    updates,
    invalid,
    elapsed_ms: elapsed,
    mean_ms: updates ? elapsed / updates : 0,
    p50_ms: quantile(0.5),
    p95_ms: quantile(0.95),
    inference_tokens: { input: String(input), cached: String(cached), output: String(output) },
    scorer_hash: history.hash(fs.readFileSync(path.join(import.meta.dir, "score.ts"), "utf8")),
    manifest_hash: history.hash(fs.readFileSync(manifest, "utf8")),
    cases: results,
  };
  fs.writeFileSync(path.join(directory, "review.json"), JSON.stringify(summary, null, 2) + "\n");
  const failures = results.flatMap(r => r.checks.filter(c => !c.pass).map(c => `- ${r.id}: ${c.name} — ${c.detail}`));
  const markdown = `# Long-term plan replay\n\nModel: ${original.model}. Signals: ${original.ablation}. ${original.baseline ? "Flat production-prompt baseline." : "Hierarchical candidate."}\n\n| Case | Checks | Invalid/errors | Goals / episodes / steps | Tokens assigned |\n| --- | ---: | ---: | --- | ---: |\n${rows.join("\n")}\n\n${updates} updates; mean ${(summary.mean_ms / 1000).toFixed(2)}s, median ${(summary.p50_ms / 1000).toFixed(2)}s, p95 ${(summary.p95_ms / 1000).toFixed(2)}s. Includes harness overhead and validation retries; concurrent runs can affect latency.\n\nInference consumed ${input} input (${cached} cached) and ${output} output tokens, separately from the historical agent's tokens. Failed requests without usage reports remain unmeasured.\n\n## Failures\n\n${failures.length ? failures.join("\n") : "No scored assertion failures."}\n\nInvalid attempts and transport errors remain failures even if a retry completed the replay. Topic regexes are regression checks; this is not a human judgment of subtitle quality. Inspect the evidence and the UI. Original reports are unchanged; review.json records the current scorer's hash.\n`;
  fs.writeFileSync(path.join(directory, "scorecard.md"), markdown);
  console.log(
    `${directory}: ${results.reduce((n, r) => n + r.checks.filter(c => c.pass).length, 0)}/${results.reduce((n, r) => n + r.checks.length, 0)} checks, ${invalid} invalid/errors`,
  );
}
