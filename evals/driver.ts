#!/usr/bin/env bun
/** JSONL bridge to the production inference layer. Invoked by run.ts:
 * `driver.ts PROVIDER MODEL plan.json`. */
import { readFileSync } from "node:fs";
import { Pool, type Provider } from "../src/inference";
import * as contract from "../src/activity/prompt";

type Step = { id: string; evidence: string; turn: string };
/** Instructions and schema default to production; playback backfills override them. */
type Scenario = { id: string; steps: Step[]; instructions?: string | null; schema?: string | null };

const stopping = { value: false };
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw Error("Usage");
  const [provider, model, planPath] = args;
  if (provider !== "codex" && provider !== "claude") throw Error("InvalidProvider");
  const pool = new Pool({
    config: { provider: provider as Provider, model, timeout_ms: 60000, executable: process.env.CORGI_EVAL_HARNESS || null },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping.value = true));
  try {
    const plan: Scenario[] = JSON.parse(readFileSync(planPath, "utf8"));
    for (const scenario of plan) {
      const context = new contract.Context();
      for (const step of scenario.steps) {
        if (stopping.value) throw Error("Cancelled");
        // Match the production evidence bound; never silently evaluate more context.
        if (Buffer.byteLength(step.evidence) > 2048) throw Error("EvidenceTooLong");
        // As in production, history accompanies only a newly created conversation.
        const history = context.recent.slice(0, context.len).map((entry) => entry.text());
        const live: contract.Input = { provider, turn: contract.turnTag(step.turn), evidence: step.evidence };
        const fresh: contract.Input = { ...live, history };
        const json = contract.content(live);
        const fresh_json = context.len > 0 ? contract.content(fresh) : null;
        const started = Date.now();
        let response;
        try {
          response = await pool.infer(
            {
              instructions: scenario.instructions ?? contract.instructions,
              schema: scenario.schema ?? contract.schema,
              content: json,
              fresh_content: fresh_json,
              conversation: scenario.id,
            },
            stopping,
          );
        } catch (error) {
          emit({ id: step.id, status: "error", err: (error as Error).message, raw: null, label: null, elapsed_ms: Date.now() - started, input: live });
          continue;
        }
        const input = response.fresh && fresh_json !== null ? fresh : live;
        let decision;
        try {
          decision = contract.parse(response.text());
        } catch (error) {
          emit({ id: step.id, status: "invalid", err: (error as Error).message, raw: response.text(), label: null, elapsed_ms: Date.now() - started, input });
          continue;
        }
        const label = decision.label;
        emit({ id: step.id, status: label === null ? "abstained" : "label", err: null, raw: response.text(), label: label?.text() ?? null, elapsed_ms: Date.now() - started, input });
        if (label !== null) context.remember(step.turn, step.evidence, label);
      }
    }
  } finally {
    pool.deinit();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`corgi-eval: ${(error as Error).message}`);
    process.exit(1);
  },
);
