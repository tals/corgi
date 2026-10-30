# Agent-count CPU matrix: Corgi V18 and Herdr v0.9.5

For the newer Corgi-only results after rebasing on main, including 64 agents, see [the strict post-rebase matrix](main_rebase_matrix.md).

All 12 requested scenarios are measured. Corgi retains a substantial viewer cost: about 0.52–0.57% of one core while idle and 1.53–1.70% while busy, versus Herdr’s 0.12–0.23%. At 32 busy agents, the detached daemon readings are close, but both are flagged for host interference. These are observations of this synthetic workload, not precise parity or optimization claims.

CPU below is percent of **one core**. D = daemon process, including its threads; V = one viewer. Total = D + V. Detached viewers exited and are shown as absent. † marks an observation whose trial failed the original 2% sibling-load guard; ratios involving these values are approximate.

| Agents | State | Viewer | Corgi D / V | Corgi total | Herdr D / V | Herdr total | Observed C/H |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | idle | attached | 1.53 / 0.57 | 2.10 | 0.23 / 0.13 | 0.37 | 5.73× |
| 4 | idle | detached | 1.18 / — | 1.18 | 0.20 / — | 0.20 | 5.92× |
| 4 | busy | attached | 3.57 / 1.68 | 5.25 | 1.35 / 0.23 | 1.58 | 3.32× |
| 4 | busy | detached | 2.33 / — | 2.33 | 1.15 / — | 1.15 | 2.03× |
| 8 | idle | attached | 1.58 / 0.55 | 2.13 | 0.37 / 0.12 | 0.48 | 4.41× |
| 8 | idle | detached | 1.47 / — | 1.47 | 0.30 / — | 0.30 | 4.89× |
| 8 | busy | attached | 4.05 / 1.53 | 5.58 | 2.00 / 0.22† | 2.22† | 2.52×† |
| 8 | busy | detached | 3.22 / — | 3.22 | 1.87 / —† | 1.87† | 1.72×† |
| 32 | idle | attached | 2.60 / 0.52† | 3.12† | 1.13 / 0.13† | 1.27† | 2.46×† |
| 32 | idle | detached | 2.27 / —† | 2.27† | 1.08 / —† | 1.08† | 2.09×† |
| 32 | busy | attached | 6.65 / 1.70† | 8.35† | 5.85 / 0.20† | 6.05† | 1.38×† |
| 32 | busy | detached | 5.37 / —† | 5.37† | 5.57 / —† | 5.57† | 0.96×† |

Each fresh runtime contains N mixed Claude/Codex fixture providers plus one quiet shell. One attached viewer focuses agent 0. Every provider PTY is 132×47; outer terminals are Corgi 160×48 and Herdr 159×48. Idle providers remain at stable prompts with zero writes. Busy providers each write a sparse row at 20 Hz using a shared monotonic epoch and staggered lane phases. Default Corgi animation and resource features remain enabled; provider transcript fixtures are minimal, not real model workloads.

Each phase uses **30 seconds warmup + 60 seconds measurement**, attached then detached. Both products use the same placement within each pair and identical per-task utilization clamps. The 4-idle pair uses node 0 CPUs 40–47; all other cells use CPUs 32–39 after a fresh host-only pilot excluded the noisy first group. This placement change and one observation per cell limit causal scaling claims. Do not pool these readings with earlier 120-second-warmup results.

CPU counts only the daemon/viewer processes. Live provider CPU is excluded. **Corgi 32-busy attached also records 0.700 percentage points of waited-child CPU** (0.583 user, 0.117 system), excluded from the table; every other cell is ≤0.0167 points. Naively adding it changes that total from 8.35% to 9.05%, versus Herdr 6.05% (about 1.50×). This is accounting sensitivity, not an exact contemporaneous subtree total: `cutime/cstime` charges at wait and can include earlier work. Retained samples do not identify the child; see the [read-only audit](../../dist/agent-scale-v18/c32-waited-child-audit.json).

**Noise treatment:** 4-idle, 4-busy, 8-idle, and Corgi 8-busy passed the original strict guards. Herdr 8-busy uses its **first** functionally valid attempt retrospectively, not the lowest-CPU attempt; original `accepted=false` remains unchanged. Across all three valid Herdr trials, attached daemon CPU was 1.917–2.100%, viewer 0.200–0.217%, and detached daemon 1.800–1.950%. Before running the 32-agent pairs, noise was prospectively made diagnostic; the first quality-valid trial was retained. All four 32-agent trials failed the original noise guard and are flagged. No workload, native/executable identity, geometry, byte/cadence, animation, cleanup, affinity, or clamp check was waived.

Frozen Corgi binary SHA256: `f792622d85f00f2b5b0f6ee8b9b3c921bcd14b81d5ac450e3006c70fb72c9163`; native aggregate `f47eecce50af1f1f0130dbf484165706639f8c04cc74532859555b00acf48cac`. Herdr binary SHA256: `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.

[Exact values and flags](../../dist/agent-scale-v18/summary.json), [readable summary](../../dist/agent-scale-v18/summary.md), [artifact manifest](../../dist/agent-scale-v18/artifact-manifest.json). Prospective plans: [initial](../../dist/agent-scale-v18-plan.json), [replacement placement](../../dist/agent-scale-v18b-plan.json), [final noise policy](../../dist/agent-scale-v18c-plan.json). Frozen observer receipts: [10](../../dist/agent-scale-v18-observer10-receipt.json), [11](../../dist/agent-scale-v18-observer11-receipt.json). All failed attempts and correctness-only preflights are preserved; preflight CPU is excluded.
