#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { Pool } from "../../src/inference/harness";
import * as flat from "../../src/activity/prompt";
import { Audit } from "./usage_audit";

const [directory, destination] = process.argv.slice(2);
if (!directory || !destination) throw Error("Usage: main_efficiency.ts BASELINE_DIRECTORY OUTPUT_DIRECTORY");
const json = (v: unknown) => JSON.stringify(v, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
fs.mkdirSync(destination, { recursive: true });
for (const filename of fs
  .readdirSync(directory)
  .filter(f => f.endsWith(".plan.json"))
  .sort()) {
  const stem = filename.slice(0, -10),
    matched = path.join(directory, stem + ".matched.json"),
    source = fs.existsSync(matched) ? matched : path.join(directory, stem + ".json");
  const baseline: { complete: boolean; model: string; case: string; calls: { through: number; input: flat.Input }[] } =
    JSON.parse(fs.readFileSync(source, "utf8"));
  if (!baseline.complete) throw Error("IncompleteBaseline");
  const output = path.join(destination, stem + ".json");
  if (fs.existsSync(output)) throw Error("OutputExists");
  const pool = new Pool({
      config: { provider: "claude", model: baseline.model.replace(/^claude:/, ""), timeout_ms: 60000 },
    }),
    context = new flat.Context(),
    audit = new Audit(),
    calls: unknown[] = [];
  const save = (complete: boolean) =>
    fs.writeFileSync(
      output,
      json({
        complete,
        model: baseline.model,
        case: baseline.case,
        baseline: source,
        instructions: flat.instructions,
        schema: flat.schema,
        calls,
      }),
    );
  try {
    for (const previous of baseline.calls) {
      const { provider, turn, evidence } = previous.input;
      const input = {
        provider,
        turn,
        evidence,
        phase: context.phase(turn),
        earlier: context.earlier(turn),
        history: context.recent.slice(0, context.len).map(t => t.text()),
      };
      const started = Date.now(),
        response = await pool.infer({
          instructions: flat.instructions,
          schema: flat.schema,
          content: flat.content({ ...input, history: null }),
          fresh_content: flat.content(input),
          conversation: context.key(1),
        });
      calls.push({
        through: previous.through,
        input,
        raw: response.text(),
        usage: response.usage,
        audit: audit.take(response.usage),
        fresh: response.fresh,
        elapsed_ms: Date.now() - started,
      });
      save(false);
      const decision = flat.parse(response.text(), input.phase);
      if (decision.label) context.remember(turn, evidence, decision.label, decision.action);
      console.log(`${baseline.case} ${calls.length}/${baseline.calls.length}`);
    }
    save(true);
  } finally {
    pool.close();
    audit.close();
  }
}
