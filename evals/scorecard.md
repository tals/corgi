# Activity summary eval scorecard

Run: 2026-10-07T23:48:35.954Z. Live model calls using the production native harness.
Repeats: 3. Cases: 17. Assertions per model: 60.
Commit: `ddfefdd401a0f2b92fdb31470d0d5d77bd31f79f` with the switch to Haiku 5.5 applied. Both models run at low reasoning effort. Source and driver hashes are recorded in the JSON report.

| Model | Pass | Abstention | Activity | Sequences | Injection | Errors | p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude:claude-haiku-5-5 | 60/60 | 21/21 | 15/15 | 18/18 | 6/6 | 0 | 1.3s / 2.1s |
| codex:gpt-6-luna | 60/60 | 21/21 | 15/15 | 18/18 | 6/6 | 0 | 2.2s / 3.1s |

Every assertion must pass. Errors and missing responses count as failures. Sequence scores count individual steps, including later steps after an abstention.

All assertions passed.

Topic assertions allow wording variations and are deliberately conservative; they are deterministic regression checks, not a proof of semantic correctness.

## Run again

```sh
bun run evals/run.ts --repeat 3
bun run evals/run.ts --model codex:MODEL_ID
bun run evals/run.ts --model claude:MODEL_ID
bun test evals
```

The first candidate abstention prompt scored 57/60 on Haiku 4.5 and 54/60 on Luna. These same assertions exposed generic tool-name labels and unnecessary abstention on concrete work; clarifying the prompt brought both to 60/60 (2026-09-26; Haiku 4.5 at 6.1s / 11.0s). No expectations were relaxed.

Prompt SHA-256: `f6ab38b15e779d8691766e64939b3b2e6b8b162f90ea5803d9fd47021df32eba`.

[Full local run report](results/2026-10-07T23-48-35-954Z/report.json) (generated results are Git-ignored). See [README](README.md) for scope, limitations, and model selection.
