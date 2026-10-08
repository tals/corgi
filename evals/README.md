# Activity summary evals

These are small, deterministic assertions around **live model responses**. They probe when an activity summarizer should abstain, and whether it can still name useful work. They run the production inference harness, prompt, JSON schema, parser, and bounded conversation-history implementation, through `evals/driver.ts`. They do not open a Corgi runtime or modify a running session.

```sh
bun test evals                         # scorer/runner tests; no model calls
bun run evals/run.ts                   # evaluate both defaults
bun run evals/run.ts --repeat 3        # exercise output variability
```

Defaults are Claude Haiku 5.5 (`claude-haiku-5-5`) and GPT-6 Luna (`gpt-6-luna`). Calls use the installed Claude/Codex CLI and its existing login, with the same tool restrictions as Corgi. They consume model usage. No extra SDK, API key, or evaluator model is required.

For a new model or a focused regression:

```sh
bun run evals/run.ts --model codex:MODEL_ID
bun run evals/run.ts --model claude:MODEL_ID --repeat 3
bun run evals/run.ts --case make-alone --case evidence-arrives
bun run evals/run.ts --list
```

`--model` and `--case` can be repeated. Supplying models replaces the defaults; supplying cases selects that subset. The driver runs the current sources directly; the report records their hashes and the driver's. `--out DIR` selects a report directory. `--driver PATH` and `CORGI_EVAL_HARNESS` support deterministic test doubles; their reports are explicitly marked as fixture runs.

## Assertions and scorecard

`cases.json` contains 17 scenarios / 20 assertions per repeat:

- Sparse requests, generic thinking, opaque tool names, and clarification requests should produce `{"label":null}`. The application owns needs-input status.
- Concrete assistant updates, active tools, completed searches, and known background builds should produce a useful label. Positive controls prevent passing by always abstaining.
- Multi-step scenarios share a real inference conversation. They test evidence arriving after abstention and old context failing to override a sparse replacement snapshot, both within and across turns.
- Instructions embedded in evidence must not override the summarizer's instructions.

Assertions check the response contract, abstention decision, permitted label length, generic/input-status wording, and broad topic patterns. They allow wording variations; no exact-match golden labels or subjective LLM grading. Topic patterns are deliberately conservative regression checks, not proof of semantic correctness. New useful wording may require a reviewed rubric adjustment. Never loosen an expectation just to make a model pass.

Every assertion must pass. Errors, invalid responses, and missing results fail the run; exit code is **0 on complete success, 1 on failures**. Results include per-case output and latency. Each case starts with fresh context; steps within a scenario share context. Repeats start fresh cases. Providers run sequentially and each inference has a 60-second deadline. This suite probes model behavior; deterministic runtime tests in `tests/activity_summary.test.ts` separately verify animation fallback, scheduling, and late-result guards.

Each run writes `evals/results/<timestamp>/report.json` and `scorecard.md`, plus `latest.json` and `latest.md`. Reports record requested model IDs, repeat count, selected cases, exact model input/output, source hashes, the driver hash, and errors. Latencies include harness setup where needed and are useful only for rough comparison. Generated runs are ignored by Git.

To add a probe, append a scenario with `id`, `category`, and `steps`. Each step includes the production evidence text, `expect: "abstain" | "label"`, an optional turn ID, and—for labels—an `all` array of case-insensitive topic regexes. Evidence is limited to the production 2048-byte bound. Use synthetic evidence so scorecards are safe to share.
