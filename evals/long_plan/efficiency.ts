#!/usr/bin/env bun
// Compare against recorded production-sized requests at exactly the same checkpoints.
import * as fs from "node:fs";
import * as path from "node:path";
import { Pool, type Request } from "../../src/inference/harness";
import { Tokens } from "../../src/usage/live";
import * as plan from "../../src/activity/plan";
import * as roadmap from "../../src/activity/roadmap";
import * as lines from "../../src/activity/plan_lines";
import * as filesystem from "../../src/activity/plan_fs";
import * as ownership from "../../src/activity/plan_owner";
import * as compact from "../../src/activity/plan_protocol";
import { Audit, combine } from "./usage_audit";
import { Context, priceBudget } from "../../src/activity/plan_context";
import { Conversation } from "./cached";

type Usage = { input: string; cached_input: string; output: string };
type Call = { through: number; input: roadmap.Input; raw: string; usage: Usage };
const args = process.argv.slice(2),
  cacheTurnsAt = args.indexOf("--cache-turns"),
  cacheTurns = cacheTurnsAt < 0 ? priceBudget.turns : Number(args[cacheTurnsAt + 1]),
  cached = args.includes("--cached"),
  ops = !args.includes("--legacy") && !cached,
  plain = args.includes("--plain"),
  ownerAt = args.indexOf("--owner"),
  ownerVariant = ownerAt < 0 ? null : args[ownerAt + 1],
  wire = ownerVariant
    ? ownership.variant(ownerVariant)
    : args.includes("--fs")
      ? filesystem
      : args.includes("--lines")
        ? lines
        : compact,
  textual = Boolean(ownerVariant) || wire === lines || wire === filesystem,
  reuse = ops && !args.includes("--stateless"),
  [directory, destination] = args.filter(
    (arg, i) =>
      i !== cacheTurnsAt &&
      i !== ownerAt &&
      (ownerAt < 0 || i !== ownerAt + 1) &&
      (cacheTurnsAt < 0 || i !== cacheTurnsAt + 1) &&
      !["--cached", "--legacy", "--plain", "--stateless", "--json-ops", "--lines", "--fs", "--cache-budget"].includes(
        arg,
      ),
  );
if (!Number.isInteger(cacheTurns) || cacheTurns < 1 || cacheTurns > 32) throw Error("InvalidCacheTurns");
if (!directory || !destination)
  throw Error(
    "Usage: efficiency.ts BASELINE_DIRECTORY OUTPUT_DIRECTORY [--legacy | --cached | --stateless] [--plain] [--owner VARIANT | --fs | --lines | --json-ops] [--cache-budget] [--cache-turns N]",
  );
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
fs.mkdirSync(destination, { recursive: true });
for (const file of fs
  .readdirSync(directory)
  .filter(f => f.endsWith(".plan.json"))
  .sort()) {
  const baseline: { complete: boolean; model: string; case: string; calls: Call[] } = JSON.parse(
    fs.readFileSync(path.join(directory, file), "utf8"),
  );
  if (!baseline.complete) throw Error(`IncompleteBaseline:${file}`);
  const output = path.join(destination, file);
  if (fs.existsSync(output)) throw Error(`OutputExists:${file}`);
  const pool = new Pool({
      config: { provider: "claude", model: baseline.model.replace(/^claude:/, ""), timeout_ms: 60000 },
    }),
    road = new roadmap.Roadmap(),
    session = new Conversation(),
    context = new Context(wire, args.includes("--cache-budget") ? { ...priceBudget, turns: cacheTurns } : null),
    calls: unknown[] = [],
    audit = new Audit();
  const save = (complete: boolean) =>
    fs.writeFileSync(
      output,
      json({
        complete,
        cache_budget: args.includes("--cache-budget"),
        cache_turns: cacheTurns,
        model: baseline.model,
        case: baseline.case,
        baseline: path.resolve(directory, file),
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
                : cached
                  ? "cached-deltas"
                  : "stateless",
        instructions: ops ? wire.instructions : plan.instructions,
        schema: ops ? (plain ? null : wire.schema) : plan.schema,
        calls,
      }) + "\n",
    );
  try {
    for (const previous of baseline.calls) {
      const input = structuredClone({
          state: road.state,
          events: previous.input.events,
          support: road.support,
          focus: road.focus_step,
        }),
        request = reuse
          ? context.prepare(input)
          : ops
            ? {
                instructions: wire.instructions,
                schema: plain ? null : wire.schema,
                content: wire.encode(compact.envelope(input)),
              }
            : cached
              ? session.prepare(input)
              : { instructions: plan.instructions, schema: plan.schema, content: roadmap.content(input) },
        started = Date.now();
      if (plain && ops) request.schema = null;
      let response = await pool.infer(request);
      const attempts = [
        {
          raw: response.text(),
          usage: response.usage,
          audit: audit.take(response.usage),
          request,
          fresh: response.fresh,
          correction: "",
        },
      ];
      const call = {
        through: previous.through,
        input,
        request,
        fresh: response.fresh,
        raw: response.text(),
        usage: response.usage,
        audit: combine(attempts.map(a => a.audit)),
        attempts,
        elapsed_ms: Date.now() - started,
      };
      calls.push(call);
      save(false);
      if (reuse && textual) {
        try {
          wire.apply(input, call.raw);
        } catch (error) {
          const correction = (error as Error).message,
            retry: Request = context.retry(input, call.raw, correction, response.usage);
          response = await pool.infer(retry);
          attempts.push({
            raw: response.text(),
            usage: response.usage,
            audit: audit.take(response.usage),
            request: retry,
            fresh: response.fresh,
            correction,
          });
          call.raw = response.text();
          call.usage = new Tokens();
          for (const attempt of attempts) call.usage.add(attempt.usage);
          call.audit = combine(attempts.map(a => a.audit));
          call.elapsed_ms = Date.now() - started;
          save(false);
        }
      }
      if (!road.apply(input, ops ? JSON.stringify(wire.apply(input, call.raw).patch) : call.raw))
        throw Error("PlanApplyFailed");
      if (cached) session.accept(input, road.state);
      if (reuse) context.accept(input, road.state, response.usage);
      console.log(`${baseline.case} ${calls.length}/${baseline.calls.length}`);
    }
    save(true);
  } finally {
    pool.close();
    audit.close();
  }
}
