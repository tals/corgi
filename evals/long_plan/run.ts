#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { Pool } from "../../src/inference";
import * as flat from "../../src/activity/prompt";
import * as history from "./history";
import * as plan from "./plan";
import * as scoring from "./score";
import { Signals } from "./signals";
import type { Requests } from "./signals";
import * as lines from "../../src/activity/plan_lines";
import * as filesystem from "../../src/activity/plan_fs";
import * as ownership from "../../src/activity/plan_owner";
import * as compact from "../../src/activity/plan_protocol";
import { Audit } from "./usage_audit";
import { Context, priceBudget } from "../../src/activity/plan_context";
import { Conversation } from "./cached";
import { Thinking, brief } from "./thinking";
import * as efforts from "../../src/providers/effort";
import type { Provider } from "./history";
import type { Check } from "./score";

export type Case = {
  id: string;
  label?: string;
  origin?: "historical" | "synthetic";
  cohort?: "routine" | "long" | "probe";
  provider: Provider;
  source: string;
  split: "development" | "holdout";
  through_line?: number;
  checks: Check[];
};
const json = (v: unknown) => JSON.stringify(v, (_, value) => (typeof value === "bigint" ? String(value) : value), 2);
const write = (file: string, value: unknown) => fs.writeFileSync(file, json(value) + "\n");
export function validateResume(
  prior: Record<string, unknown>,
  current: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
) {
  for (const key of [
    "model",
    "effort",
    "brief_thinking",
    "cache_budget",
    "cache_turns",
    "timeout_ms",
    "baseline",
    "transport",
    "ablation",
    "batch",
    "manifest_hash",
    "instructions",
    "schema",
  ]) {
    const value = prior[key] === undefined ? defaults[key] : prior[key];
    if (value !== current[key]) throw Error(`ResumeConfigurationChanged:${key}`);
  }
}
function correction(state: plan.State, raw: string, invalid: string) {
  let identities = "";
  try {
    identities = history
      .array(history.object(JSON.parse(raw)).nodes)
      .map(item => {
        const next = history.object(item),
          old = state.nodes.find(n => n.id === next.id);
        return old && (old.parent !== next.parent || old.kind !== next.kind)
          ? `Keep existing ${old.id} as ${old.kind} under ${old.parent}. Use a NEW ID for work in another episode.`
          : "";
      })
      .filter(Boolean)
      .join(" ");
  } catch {}
  return `Previous patch was rejected: ${invalid}. Return a corrected patch. ${identities}`;
}

async function main() {
  const args = process.argv.slice(2),
    option = (name: string, fallback = "") => {
      const i = args.indexOf(name);
      return i < 0 ? fallback : args[i + 1];
    };
  const manifest = option("--manifest"),
    ops = !args.includes("--flat") && !args.includes("--legacy") && !args.includes("--cached"),
    plain = args.includes("--plain"),
    ownerVariant = option("--owner"),
    // Experiments: [[find, replace], ...] applied to the owner prompt.
    patches: [string, string][] = option("--patch") ? JSON.parse(fs.readFileSync(option("--patch"), "utf8")) : [],
    patched = (text: string) =>
      patches.reduce((out, [find, replace]) => {
        if (!out.includes(find)) throw Error(`PatchNotFound:${find.slice(0, 60)}`);
        return out.replace(find, replace);
      }, text),
    owner = ownerVariant ? ownership.variant(ownerVariant) : null,
    wire = owner
      ? { ...owner, instructions: patched(owner.instructions) }
      : args.includes("--fs")
        ? filesystem
        : args.includes("--lines")
          ? lines
          : compact,
    textual = Boolean(ownerVariant) || wire === lines || wire === filesystem,
    reuse = ops && !args.includes("--stateless");
  if (!manifest)
    throw Error(
      "Usage: bun evals/long_plan/run.ts --manifest PATH [--prepare | --model claude:MODEL] [--case ID] [--batch 24] [--ablation no-reasoning] [--flat | --legacy | --cached | --stateless] [--plain] [--owner VARIANT | --fs | --lines | --json-ops] [--cache-budget] [--cache-turns N] [--effort low|medium|high] [--brief-thinking] [--timeout-ms N] [--patch FILE.json] [--requests latest|queued|list] [--out DIR] [--resume]",
    );
  const cacheTurns = Number(option("--cache-turns", String(priceBudget.turns)));
  if (!Number.isInteger(cacheTurns) || cacheTurns < 1 || cacheTurns > 32) throw Error("InvalidCacheTurns");
  const selection = option("--case"),
    model = option("--model", "claude:claude-haiku-5-5"),
    [provider, ...parts] = model.split(":"),
    modelId = parts.join(":");
  if (provider !== "claude" && provider !== "codex") throw Error("InvalidProvider");
  const effort = efforts.parse(option("--effort", "low")),
    briefThinking = args.includes("--brief-thinking"),
    timeout = Number(option("--timeout-ms", "60000"));
  if (!effort || !["low", "medium", "high"].includes(effort)) throw Error("InvalidEffort");
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw Error("InvalidTimeout");
  if (provider !== "claude" && (args.includes("--effort") || briefThinking)) throw Error("ClaudeThinkingOnly");
  const batchSize = Number(option("--batch", "24")),
    ablation = option("--ablation", "all"),
    baseline = args.includes("--flat"),
    cachedConversation = args.includes("--cached");
  if (!["all", "no-reasoning", "no-plans", "tools-only", "live-signals"].includes(ablation))
    throw Error("InvalidAblation");
  const dir = option("--out", `evals/results/long-plan/${new Date().toISOString().replaceAll(":", "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(manifest, "utf8"),
    cases: Case[] = JSON.parse(raw);
  const selected = cases.filter(c => !selection || c.id === selection);
  if (!selected.length) throw Error("NoCases");
  const pool = new Pool({ config: { provider, model: modelId, timeout_ms: timeout } });
  const audit = provider === "claude" ? new Audit() : null;
  const thinking = provider === "claude" ? new Thinking(effort) : null;
  const stopping = { value: false };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping.value = true));
  const sourceHashes = Object.fromEntries(
    [
      "history.ts",
      "signals.ts",
      "../../src/activity/tools.ts",
      "../../src/providers/claude/usage.ts",
      "../../src/providers/codex/usage.ts",
      "../../src/providers/claude/todos.ts",
      "../../src/providers/codex/todos.ts",
      "../../src/activity/checklist.ts",
      "plan.ts",
      "score.ts",
      "run.ts",
      "../../src/inference/harness.ts",
      "../../src/activity/prompt.ts",
      "../../src/activity/plan.ts",
      "../../src/activity/roadmap.ts",
      "cached.ts",
      "../../src/activity/plan_protocol.ts",
      "../../src/activity/plan_lines.ts",
      "../../src/activity/plan_fs.ts",
      "../../src/activity/plan_owner.ts",
      "../../src/activity/plan_input.ts",
      "../../src/activity/plan_context.ts",
      "usage_audit.ts",
      "thinking.ts",
    ].map(file => [file, history.hash(fs.readFileSync(path.join(import.meta.dir, file), "utf8"))]),
  );
  const report: {
    model: string;
    effort: efforts.Effort;
    brief_thinking: boolean;
    cache_budget: boolean;
    cache_turns: number;
    timeout_ms: number;
    launches: Thinking["launches"];
    baseline: boolean;
    transport:
      | "lines"
      | "filesystem"
      | "filesystem-deltas"
      | "ownership"
      | "ownership-deltas"
      | "line-deltas"
      | "stateless"
      | "cached-deltas"
      | "compact"
      | "compact-text"
      | "compact-deltas"
      | "compact-text-deltas";
    ablation: string;
    batch: number;
    manifest_hash: string;
    instructions: string;
    schema: string | null;
    source_hashes: typeof sourceHashes;
    resume_source_hashes?: typeof sourceHashes;
    cases: unknown[];
    failures: number;
  } = {
    model,
    effort,
    brief_thinking: briefThinking,
    cache_budget: args.includes("--cache-budget"),
    cache_turns: cacheTurns,
    timeout_ms: timeout,
    launches: thinking?.launches ?? [],
    baseline,
    transport:
      ops && textual
        ? reuse
          ? ownerVariant
            ? "ownership-deltas"
            : wire === filesystem
              ? "filesystem-deltas"
              : "line-deltas"
          : ownerVariant
            ? "ownership"
            : wire === filesystem
              ? "filesystem"
              : "lines"
        : reuse
          ? plain
            ? "compact-text-deltas"
            : "compact-deltas"
          : ops
            ? plain
              ? "compact-text"
              : "compact"
            : baseline || !cachedConversation
              ? "stateless"
              : "cached-deltas",
    ablation,
    batch: batchSize,
    manifest_hash: history.hash(raw),
    instructions: baseline ? flat.instructions : ops ? wire.instructions : plan.instructions,
    schema: baseline ? flat.schema : ops ? (plain ? null : wire.schema) : plan.schema,
    source_hashes: sourceHashes,
    cases: [],
    failures: 0,
  };
  if (briefThinking) report.instructions += "\n" + brief;
  const resume = args.includes("--resume"),
    prior = resume ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : null;
  if (prior) {
    const defaults: Partial<typeof report> = {
      transport: "stateless",
      effort: "low",
      brief_thinking: false,
      cache_budget: false,
      cache_turns: 32,
      timeout_ms: 60000,
    };
    validateResume(prior, report, defaults);
    if (baseline) throw Error("FlatResumeUnsupported");
    write(path.join(dir, `before-resume-${Date.now()}.report.json`), prior);
    report.source_hashes = prior.source_hashes;
    report.resume_source_hashes = sourceHashes;
    report.cases = prior.cases.filter((c: { id: string }) => !selected.some(s => s.id === c.id));
    report.failures = prior.cases
      .filter((c: { id: string }) => !selected.some(s => s.id === c.id))
      .reduce(
        (sum: number, c: { errors: string[]; checks: { pass: boolean }[] }) =>
          sum + c.errors.length + c.checks.filter(check => !check.pass).length,
        0,
      );
  }
  if (!args.includes("--prepare") && !prior) write(path.join(dir, "report.json"), report);
  try {
    for (const c of selected) {
      if (!/^[a-z0-9_-]+$/.test(c.id)) throw Error("InvalidCaseId");
      const data = history.read(c.source, c.provider);
      if (c.through_line !== undefined) {
        data.events = data.events.filter(e => e.line <= c.through_line!);
        data.receipts = data.receipts.filter(r => r.line <= c.through_line!);
        data.warnings.push(`Prefix excerpt ending at source line ${c.through_line}.`);
      }
      if (data.warnings.some(w => w.startsWith("Fork/child"))) throw Error("ForkRequiresOwnershipFilter");
      const historyPath = path.join(dir, `${c.id}.history.json`),
        callsPath = path.join(dir, `${c.id}.calls.json`);
      if (
        resume &&
        fs.existsSync(historyPath) &&
        JSON.parse(fs.readFileSync(historyPath, "utf8")).sha256 !== data.sha256
      )
        throw Error("ResumeSourceChanged");
      write(historyPath, data);
      if (args.includes("--prepare")) {
        console.log(
          `${c.id}: ${data.events.length} events, ${data.receipts.length} receipts, ${history.total(data.receipts.reduce((t, r) => history.add(t, r.tokens), history.zero()))} tokens`,
        );
        continue;
      }
      const signals =
        ablation === "live-signals"
          ? new Signals(c.source, c.provider, option("--requests", "latest") as Requests)
          : null;
      let state = plan.empty(),
        phase: string | null = null,
        phaseId = "",
        phaseIndex = 0;
      const flatContext = new flat.Context();
      const context = new Context(wire, args.includes("--cache-budget") ? { ...priceBudget, turns: cacheTurns } : null),
        conversation = new Conversation();
      const cached: { state?: plan.State; through: number; raw?: string; error?: string }[] =
        resume && fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, "utf8")) : [];
      const snapshots: plan.State[] = cached.flatMap(call => (call.state ? [call.state] : [])),
        calls: unknown[] = [...cached],
        errors: string[] = prior?.cases.find((saved: { id: string }) => saved.id === c.id)?.errors.slice() ?? [];
      state = snapshots.at(-1) ?? state;
      if (state.through > data.events.length) throw Error("ResumePrefixChanged");
      if (state.through) console.log(`${c.id}: resume at ${state.through}/${data.events.length}`);
      for (const batch of plan.batches(data.events, batchSize)) {
        if (batch.at(-1)!.id <= state.through) continue;
        if (stopping.value) throw Error("Cancelled");
        const withhold = (e: history.Event) => ({
          ...e,
          text:
            (ablation === "no-reasoning" && e.kind === "reasoning") ||
            (ablation === "no-plans" && e.kind === "plan") ||
            (ablation === "tools-only" && !["tool", "result", "lifecycle"].includes(e.kind))
              ? "[signal withheld]"
              : e.text,
        });
        const events = signals ? signals.batch(batch) : batch.map(withhold);
        const support = signals
          ? []
          : [...new Set(state.nodes.flatMap(n => [...n.evidence, ...(n.bump?.evidence ?? [])]))]
              .map(id => data.events[id - 1])
              .filter(Boolean)
              .map(withhold)
              .map(e => ({ ...e, text: e.text.slice(0, 350) }));
        const evidence = events.map(e => `${e.id} ${e.kind}: ${e.text}`).join("\n");
        const flatEvidence = Buffer.from(evidence).subarray(-2048).toString("utf8").replaceAll("\ufffd", "");
        const turn = String(batch.at(-1)!.turn);
        if (baseline) phase = flatContext.phase(turn);
        const input = baseline
          ? {
              provider: c.provider,
              turn: flat.turnTag(turn),
              phase,
              earlier: flatContext.earlier(turn),
              history: flatContext.recent.slice(0, flatContext.len).map(entry => entry.text()),
              evidence: flatEvidence,
            }
          : {
              provider: c.provider,
              assign_from: events[0].id,
              assign_through: events.at(-1)!.id,
              tree: state.nodes,
              support,
              events,
            };
        const road = { state, events, support };
        const started = Date.now();
        let rawResponse: string | null = null;
        const attempts: unknown[] = [];
        let repairs: string[] = [];
        const rejected = cached.findLast(call => call.error && call.through === batch.at(-1)!.id),
          content = rejected?.raw
            ? { ...input, correction: correction(state, rejected.raw, rejected.error!), rejected: rejected.raw }
            : input;
        try {
          const request = baseline
            ? { instructions: flat.instructions, schema: flat.schema, content: JSON.stringify(content) }
            : reuse
              ? context.prepare(road)
              : ops
                ? {
                    instructions: wire.instructions,
                    schema: plain ? null : wire.schema,
                    content: wire.encode(compact.envelope(road)),
                  }
                : !cachedConversation
                  ? { instructions: plan.instructions, schema: plan.schema, content: JSON.stringify(content) }
                  : conversation.prepare(road);
          if (briefThinking) request.instructions = report.instructions;
          if (plain && ops) request.schema = null;
          if ("correction" in content)
            request.content = request.fresh_content = ops
              ? wire.encode({ ...compact.envelope(road), correction: content.correction, rejected: content.rejected })
              : JSON.stringify(content);
          let response = await pool.infer(request, stopping);
          rawResponse = response.text();
          attempts.push({
            raw: rawResponse,
            usage: response.usage,
            audit: audit?.take(response.usage),
            request,
            fresh: response.fresh,
          });
          if (!baseline) {
            try {
              ops ? wire.apply(road, rawResponse) : plan.apply(state, rawResponse, batch);
            } catch (error) {
              const invalid = error instanceof Error ? error.message : String(error);
              errors.push(`Invalid first attempt: ${invalid}`);
              conversation.invalidate();
              const retry = reuse && textual ? context.retry(road, rawResponse, invalid, response.usage) : null;
              if (!retry) context.invalidate();
              const feedback = {
                correction: `${correction(state, rawResponse, invalid)} Assign ONLY events ${events[0].id} through ${events.at(-1)!.id}.`,
                rejected: rawResponse,
              };
              const corrected = ops
                ? wire.encode({ ...compact.envelope(road), ...feedback })
                : JSON.stringify({ ...input, ...feedback });
              response = await pool.infer(
                {
                  ...(retry ??
                    (reuse ? context.prepare(road) : cachedConversation ? conversation.prepare(road) : request)),
                  ...(plain && ops ? { schema: null } : {}),
                  instructions: report.instructions,
                  content: retry?.content ?? corrected,
                  fresh_content: retry?.fresh_content ?? corrected,
                },
                stopping,
              );
              rawResponse = response.text();
              attempts.push({
                raw: rawResponse,
                usage: response.usage,
                audit: audit?.take(response.usage),
                correction: invalid,
              });
            }
          }
          if (baseline) {
            const decision = flat.parse(rawResponse, phase);
            if (decision.label) {
              const title = decision.label.text();
              if (!phaseId || decision.action === "new") {
                phaseId = `phase_${++phaseIndex}`;
                state.nodes.push(
                  {
                    id: phaseId,
                    parent: null,
                    kind: "episode",
                    title,
                    subtitle: title,
                    state: "active",
                    evidence: [events.at(-1)!.id],
                  },
                  {
                    id: `${phaseId}_step`,
                    parent: phaseId,
                    kind: "step",
                    title,
                    subtitle: title,
                    state: "active",
                    evidence: [events.at(-1)!.id],
                  },
                );
              } else
                for (const n of state.nodes.filter(n => n.id === phaseId || n.id === `${phaseId}_step`))
                  n.title = title;
              phase = title;
              flatContext.remember(turn, flatEvidence, decision.label, decision.action);
            }
            state.spans.push({
              from: events[0].id,
              to: events.at(-1)!.id,
              node: decision.label ? `${phaseId}_step` : null,
            });
            state.through = events.at(-1)!.id;
          } else {
            const applied = ops ? wire.apply(road, rawResponse) : plan.apply(state, rawResponse, batch);
            state = applied.state;
            if (cachedConversation) conversation.accept(road, applied.state);
            if (reuse) context.accept(road, applied.state, response.usage);
            repairs = applied.repairs;
          }
          const snapshot = structuredClone(state),
            elapsed = Date.now() - started;
          snapshots.push(snapshot);
          const tokens = plan.ledger(state, data, batch.at(-1)!.line);
          calls.push({
            through: state.through,
            input: content,
            raw: rawResponse,
            elapsed_ms: elapsed,
            attempts,
            state: snapshot,
            repairs,
            ledger: tokens,
          });
          console.log(`${c.id} ${state.through}/${data.events.length}: ${state.nodes.length} nodes, ${elapsed}ms`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          calls.push({
            through: batch.at(-1)!.id,
            input: content,
            raw: rawResponse,
            error: message,
            attempts,
            elapsed_ms: Date.now() - started,
          });
          console.error(`${c.id}: ${message}`);
          break;
        } finally {
          write(path.join(dir, `${c.id}.calls.json`), calls);
        }
      }
      const checks = scoring.score(data, snapshots, c.checks),
        result = {
          id: c.id,
          label: c.label,
          origin: c.origin,
          cohort: c.cohort,
          split: c.split,
          source_hash: data.sha256,
          warnings: data.warnings,
          errors,
          checks,
          metrics: scoring.metrics(data, snapshots),
          ledger: plan.ledger(state, data),
          state,
        };
      report.failures += errors.length + checks.filter(r => !r.pass).length;
      report.cases.push(result);
      write(path.join(dir, "report.json"), report);
    }
  } finally {
    pool.close();
    audit?.close();
    thinking?.close();
  }
  if (!args.includes("--prepare")) {
    console.log(`${report.failures} failures; ${dir}/report.json`);
    process.exitCode = report.failures ? 1 : 0;
  }
}
if (import.meta.main)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
