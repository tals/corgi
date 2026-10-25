# Inference evals

These are deterministic assertions around **live model responses** for activity
summaries, task ownership and conversation names. They exercise the production
inference harness, prompt, strict JSON schema, parser and work hierarchy through
`evals/driver.ts`, without opening a Corgi runtime or modifying a running session.

```sh
bun test evals                         # scorer/runner tests; no model calls
bun run evals/run.ts                   # evaluate both defaults
bun run evals/run.ts --repeat 3        # exercise output variability
```

Defaults are Claude Haiku 5.5 (`claude-haiku-5-5`) and GPT-6 Luna (`gpt-6-luna`). Pi targets use provider-qualified model IDs and the default Pi account. Calls use the installed Claude/Codex/Pi CLI and its existing login, with the same tool restrictions as Corgi. They consume model usage. No extra SDK, API key, or evaluator model is required.

For a new model or a focused regression:

```sh
bun run evals/run.ts --model codex:MODEL_ID
bun run evals/run.ts --model pi:PROVIDER/MODEL_ID
bun run evals/run.ts --model claude:MODEL_ID --repeat 3
bun run evals/run.ts --case make-alone --case evidence-arrives
bun run evals/run.ts --list
```

`--model` and `--case` can be repeated. Supplying models replaces the defaults; supplying cases selects that subset. The driver runs the current sources directly; the report records their hashes and the driver's. `--out DIR` selects a report directory. `--driver PATH` and `CORGI_EVAL_HARNESS` support deterministic test doubles; their reports are explicitly marked as fixture runs.

## Assertions and scorecard

`cases.json` contains activity and task-ownership scenarios:

- Sparse requests, generic thinking, opaque tool names, and clarification requests should abstain (`action: "none"`, `label: null`). The application owns needs-input status.
- Concrete assistant updates, active tools, completed searches, and known background builds should produce a useful label. Positive controls prevent passing by always abstaining.
- Multi-step scenarios share a real inference conversation. They test evidence arriving after abstention and old context failing to override a sparse replacement snapshot, both within and across turns.
- Phase scenarios check that more of the same work keeps or amends the current phase, and that a new kind of work starts one.
- Supplied tasks are selected from evidence, not blindly from their active status; unrelated work remains unassigned.
- Inferred goals are reused across user follow-ups. Explicit completion evidence may settle them; switching goals must not.
- Instructions embedded in evidence must not override the summarizer's instructions.

Assertions check the response contract, abstention decision, the action where a step names it, permitted label length, generic/input-status wording, and broad topic patterns. They allow wording variations; no exact-match golden labels or subjective LLM grading. Topic patterns are deliberately conservative regression checks, not proof of semantic correctness. New useful wording may require a reviewed rubric adjustment. Never loosen an expectation just to make a model pass.

Every assertion must pass. Errors, invalid responses, and missing results fail the run; exit code is **0 on complete success, 1 on failures**. Results include per-case output and latency. Each case starts with fresh context; steps within a scenario share context. Repeats start fresh cases. Providers run sequentially and each inference has a 60-second deadline. This suite probes model behavior; deterministic runtime tests in `tests/activity_summary.test.ts` separately verify animation fallback, scheduling, and late-result guards.

Each run writes `evals/results/<timestamp>/report.json` and `scorecard.md`, plus `latest.json` and `latest.md`. Reports record requested model IDs, repeat count, selected cases, exact model input/output, source hashes, the driver hash, and errors. Latencies include harness setup where needed and are useful only for rough comparison. Generated runs are ignored by Git.

To add a probe, append a scenario with `id`, `category`, and `steps`. Each step includes the production evidence text, `expect: "abstain" | "label"`, an optional turn ID, and—for labels—an `all` array of case-insensitive topic regexes. A phase step may add `action`, the actions it accepts. A `keep` is scored as the label of the phase it kept. Evidence is limited to the production 2048-byte bound. Use synthetic evidence so scorecards are safe to share.

Activity decisions include `task: {id, label}` and `completed` IDs alongside
`action` and `label`. The driver evolves the production task registry between
steps; a step's optional `plan` replaces its supplied plan. Ownership assertions
check the selected goal's source and topic, and completion assertions check
which inferred goals settled. Agent-supplied statuses remain authoritative.

## Conversation names

`naming_cases.json` adds nine scenarios / eleven independent naming probes. They run the production
conversation-name prompt, schema, input bound and parser. They check sparse and
opaque requests, descriptive commands, goal rather than preparatory activity,
multiple product names, Unicode and instructions embedded in a request.

```sh
bun run evals/run.ts --case name-goal-not-phase --case name-injection
bun run evals/run.ts --cases /private/path/history-cases.json --out evals/results/history
```

A naming step has `task: "name"`, `evidence` containing the initial user request,
and the same `expect` and topic `all` assertions. It may include
`reference: { provider: "claude" | "codex", title, session }` to compare a stored
native title with Corgi's guess. `--cases` replaces the built-in scenarios; the
report records the manifest path and hash. Reference titles are reporting-only:
they are never sent to the model or used as exact-match goldens. Reports show
the initial input, stored title, and Corgi title under each inference model.
Stored titles can reflect later turns; comparisons are not quality rankings.
Exclude continued transcripts that no longer contain their original opening.

Historical manifests and reports contain private conversations. Keep them under
ignored `evals/results/` or outside the repository; do not add them to fixtures.
Synthetic naming probes are safe to share. Discarded initial experiments remain
in their timestamped directories, so a later successful rerun does not erase them.

## History

On 2026-10-23, conversation naming passed all nine synthetic probes on Haiku
5.5 and Luna, then all fourteen historical topic/format checks on each model
(seven Claude and seven Codex conversations). Initial experiments exposed
word-count violations and inconsistent naming of `$commit-all`; the prompt and
provider-supported schema constraints were tightened. The combined suite scored
33/33 on Haiku and 32/33 on Luna: its existing `background-build` check abstained
once, then passed three focused reruns. Private comparisons remain in local
`evals/results/history/`; no historical conversations were added to fixtures.

The task hierarchy update (2026-10-25) passed all eight new ownership and
completion checks on each model. The complete suite scored 43/43 on Haiku
5.5 and 42/43 on Luna; the existing `background-build` probe again returned
`keep` without a current phase, which normalizes to abstention. Expectations
were not relaxed. Live evaluation also caught an unsupported `uniqueItems`
schema keyword in Codex; duplicate completion IDs remain rejected by the parser.

The Pi picker follow-up passed all eleven naming probes on Haiku, Codex Luna
and Pi's Codex-backed Luna. Pi initially copied raw command tokens or abstained
on descriptive commands; explicit JSON examples fixed that behavior, and added
command probes not shown in the prompt also passed. Reports, including failed
experiments, remain under `evals/results/pi-models*/` and `pi-picker-final/`.

The first candidate abstention prompt scored 57/60 on Haiku 4.5 and 54/60 on
Luna. These assertions exposed generic tool-name labels and unnecessary
abstention on concrete work; clarifying the prompt brought both to 60/60
(2026-09-26). No expectations were relaxed. Haiku 5.5 at low effort later
replaced Haiku 4.5 and also scored 60/60.

On Bun (2026-10-08), Luna once abstained on `background-build` and then
labeled it in 25 of 25 reruns: about one miss in 30, an occasional missing
label rather than a pattern.

On 2026-10-10 the summarizer moved from one label per snapshot to phases
(`new`, `keep`, `amend`, `none`). Replaying 305 logged requests from six real
turns gave 78 hover-card rows instead of 265. Earlier prompts were either too
sticky, folding testing and fixing into one row, or flipped between two phases
on a stale assistant update. The final prompt flips far less in the replays,
but a synthetic probe, where only a test finishes under an unchanged "Now I'll
build the page" update, still restarted the page phase in 3 of 4 runs across
Haiku and Luna, so it is not in the suite.
