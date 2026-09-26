# Activity summary eval scorecard

Run: 2026-09-26T22:10:51.372Z. Live model calls using the production native harness.
Repeats: 3. Cases: 17. Assertions per model: 60.
Commit: `04e89f170425a9eaa39e67791374f3e52c3496ea`. Source and driver hashes are recorded in the JSON report.

| Model | Pass | Abstention | Activity | Sequences | Injection | Errors | p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude:claude-haiku-4-5-20251001 | 60/60 | 21/21 | 15/15 | 18/18 | 6/6 | 0 | 6.1s / 11.0s |
| codex:gpt-6-luna | 60/60 | 21/21 | 15/15 | 18/18 | 6/6 | 0 | 2.5s / 4.1s |

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

The first candidate abstention prompt scored 57/60 on Haiku and 54/60 on Luna. These same assertions exposed generic tool-name labels and unnecessary abstention on concrete work; clarifying the prompt produced the results above. No expectations were relaxed.

Prompt SHA-256: `dbfb01b2814b8c8f5f876b3c9d762fc30590c3792aff6b127f187fbf6cb7bdb7`.

[Full local run report](results/2026-09-26T22-10-51-372Z/report.json) (generated results are Git-ignored). See [README](README.md) for scope, limitations, and model selection.
