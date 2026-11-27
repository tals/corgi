# Long-term plan view

An eval and Corgi integration for a durable account of an agent's work. Long-term
plans are the default activity summarizer. The replay and daemon share patch
validation, hierarchy and setback handling. The updater uses filesystem ownership
commands with the evaluated `direct` prompt; its semantic limitations and
measured costs are recorded below.

## Try the integration

From this checkout, rebuild and reload your normal Corgi:

```sh
./go.ts --reload --no-kill
```

For a first launch, omit `--reload`. No feature flags or separate environment are
needed. Existing panes and accepted plans survive reload. Older sessions that
used flat summaries start collecting plans after reload. Saved plans keep the
same schema; old mode flags no longer control collection.
The ownership updater retains the evaluated cache budget and one correction
attempt. The activity label follows foreground focus, so a late background
result can accrue usage without replacing the current activity.

Keep Activity summaries enabled in Clever Corgi. **Hover an agent in the
sidebar** to see its plan in the existing tooltip, replacing the flat recent
activity list. The tree follows the tail automatically, with episode context.
The original Total row, provider, context, subagents and TODOs stay in the card.
There is no selection or scrolling; moving the pointer away closes the tooltip.
Native OMP labels stay native; the plan uses their intent as evidence
without replacing them.

The worker samples commentary, recent/running tools, bounded result excerpts,
native intents, lifecycle and the provider's confirmed checklist. It updates
through the existing inference pool and cooldown, including a final observation
after work settles. Old-turn results may extend their own plan prefix, but never
replace a newer turn's live label. Agent lifecycle still comes from providers.
The bounded result history retains four individual tool outcomes, including
repeated commands, so a successful retry does not erase its preceding failure.

Live costs are observed intervals, not a reconstructed lifetime ledger. The
first usage sample establishes a baseline. Later usage rolls up once through
step → episode → goal; cached input is part of input. Unassigned intervals,
missing coverage and buffer overrun stay explicit. Child-agent costs and private
summarizer costs are excluded. Attribution
to a step is inferred, even when its observed token count is exact.
Tool calls follow the same observed-interval rollup, independently of whether
token usage has arrived. Missing usage fields stay blank, including tool counts
in older saved plans. The tooltip keeps its original session Total row.
Tokens shows uncached input plus output, and Cached shows cached input
separately, using the same columns for totals and plan rows. Plan rows cover
the intervals the updater observed; the session total may include earlier work.

Plans, pending observations and costs survive checkpoint/handoff. Cold recovery
establishes a fresh usage baseline. Queues retain 32 observations and 128 short
support excerpts; a request handles at most eight observations. At 256 nodes or 4096 visits the
plan reports its history limit and retains further cost as unassigned. These
bounds protect the daemon; they are not a complete transcript archive.

The snapshot/checkpoint/handoff additions are defaulted and do not change the
base branch’s wire or saved-format versions. Old data decodes to an empty plan; there is no migration.
Old handoffs' preview flag is ignored. Older viewers ignore the optional plan
field.

## Setbacks and new signal probes

A step may carry a classified setback: verification, conflict, environment,
permission, or approach. **!** marks a problem only on the affected step;
it never propagates to parents.
A setback adds one explanation line beneath its step. Resolved problems keep a
dimmed **!✓** and a struck-through explanation.
A green **▶** marks the focused episode while it is active. Its current active
step also gets a green **▶** and bold text; completed episodes and steps are dimmed
while older unfinished steps keep ordinary text. The trail follows foreground work in time order. Cost attribution is separate:
spans mark whether they describe foreground work or a background result/poll.
Late results update their original visit without moving attention. Deliberately
resuming a task appends a visit; **↩** appears once on a returned episode, not on
every repeated child. Earlier visits stay in place. Consecutive work and neutral
events do not create extra visits. Episode rows group consecutive
visits to that episode and show their combined cost. Within that block, every
step ID has one row, accumulating its visits’ tokens, calls and cached input.
Steps are ordered by their latest foreground visit: resuming work moves its row
to the bottom. Pausing or completing a turn preserves that order, as do late
results and usage receipts. Returning from a different episode starts a new block with separate costs;
totals still count the whole conversation once. Late receipts stay with their
generating visit. Problems appear on the visit where they arose, with recovery
updating that explanation. Sidebar branches connect steps and their explanations. Two or more hidden steps get a “… N more” row instead of a
continued suffix. Provider lifecycle gates play markers independently of inferred
plan states. While running without a known active step, a green **▶ …** stays at
the tail, under the active episode or on its own after a completed episode. It
does not reopen work or charge its usage to the preceding step. Old replay
artifacts obtain lifecycle from the frozen source without changing model evidence
or accounting. Available tool-call counts
and cached input remain visible. The optional `focus_step` defaults to null in old snapshots;
The additions do not change wire or saved-format versions. The optional `visits`
field persists chronology and cost. Older plans retain their step totals as
entries with zero event ranges; new work appends after them without merging.
An approach setback means rework caused by a disproved committed approach,
not every exploratory hypothesis. Expected red tests, no-match searches,
ordinary waits and error strings inside source code are negative controls.

The reducer keeps the original setback evidence even when a patch omits it.
Resolving a known open setback requires fresh evidence. Failed attempts cannot
be rewritten as successful retries. Done parents reopen around unfinished
children or open setbacks. These are application guarantees, not evidence that
the model always understood the task. New replay calls record `repairs` so a
normalization does not masquerade as flawless model output.

Codex `update_plan` and Claude `TodoWrite`/`TaskCreate`/`TaskUpdate` are folded
into the existing provider checklist boundary after tool confirmation. OMP
already supplies grouped TODOs. Unknown statuses and missing task history are
partial. TODO completion is intent evidence, never proof of passing tests.

```sh
bun test src/activity/roadmap.test.ts src/providers/claude/todos.test.ts src/providers/codex/todos.test.ts
bun run evals/long_plan/run.ts --manifest evals/long_plan/synthetic.json --model codex:gpt-6-luna
bun run evals/long_plan/run.ts --manifest evals/long_plan/holdout.json --model claude:claude-haiku-5-5
bun run evals/long_plan/run.ts --manifest evals/long_plan/todo_probe.json --ablation live-signals --model claude:claude-haiku-5-5
bun run evals/long_plan/run.ts --manifest PRIVATE_MANIFEST --ablation live-signals --model codex:gpt-6-luna
bun evals/long_plan/preview.ts RUN_DIRECTORY [RUN_DIRECTORY...]
bun evals/long_plan/artifact.ts [--examples FILE.json] [--out FILE.html] RUN_DIRECTORY...
bun evals/long_plan/check_visits.ts RUN_DIRECTORY [RUN_DIRECTORY...]
```

`check_visits.ts` checks chronological prefixes, unique steps within episode
blocks, stable closed blocks, step order by latest work, raw and displayed
token/cache/call conservation, and active work at the bottom at several heights, without
model calls.
Before the focus correction, the recorded development sessions and synthetic
probes passed the earlier accounting checks at 276 accepted checkpoints, despite 122 inferred
step returns. That result missed excessive returns: attribution changes were
incorrectly treated as changes in attention. Browser checks cover each at
18, 24 and 34 rows. These rendering/accounting checks do not replace the semantic
model checks or clear their existing findings.

`preview.ts` builds `.lavish/long-plan-integrated.html` using the actual
`src/plan_view.ts` renderer and Corgi palette. It includes recorded failures and
checkpoint controls. “Long example” selects the real rebase replay in an 18-row
terminal. The tail fits whole steps and their setback explanations, retaining
parent context; ordinary steps still occupy one line.
The height control demonstrates shorter and taller terminals. An earlier-item
count shows omitted history; the totals still include it. The older `view.ts` remains the original
design study.
`artifact.ts` writes the same replays as one self-contained page for a claude.ai
Artifact (default `.lavish/long-plan-artifact.html`): the tooltip first, beside the
selected example and the judge's verdict, then scrolling Good and Bad example
panes filtered by session and category, and folded update details (the model's
command program, rejected attempts, server repairs and the events it read,
clipped, reasoning omitted). Each replay's frames and evidence travel gzipped in
the page and open when it is shown. `examples.ts` writes `--examples` from judge
verdicts: `[{replay: "RUN/CASE", event?, node?, verdict: "good" | "bad", category?, title, tldr?, note}]`.
`event` selects the update covering it, the last one when omitted; `category` is the
judge's fault for bad rows, and for good rows whether the praised row flags a
problem, scopes an episode or reports a step's result.

```sh
bun evals/long_plan/examples.ts --out .lavish/long-plan-examples.json RUN_DIRECTORY...
bun evals/long_plan/artifact.ts --examples .lavish/long-plan-examples.json RUN_DIRECTORY...
```
`live-signals` runs production transcript readers and their bounded evidence at
the offline checkpoints. It is a conservative signal-loss probe: it does not
simulate the live eight-second scheduler, hooks or app-server observations.

## Full-session follow-up

The browser review's original historical set had only 213 events across three
failure-oriented excerpts. It now separates full captured development sessions,
earlier short replays and synthetic probes. Each option shows its event and user
turn counts. “Routine example” opens a routine case with the fewest recorded
setbacks; “Long example” opens the longest captured history.

The new private dataset freezes five complete local transcript files without
`through_line` cuts. The plan-project conversation was still active, so its 988
events are the full captured history at the freeze point, not a finished task.
All events are retained; the existing importer still bounds individual text
excerpts before inference.

| Captured session | Provider | Events | User turns | Coverage |
| --- | --- | ---: | ---: | --- |
| This long-term plan project | Codex | 988 | 22 | Eval design, implementation, integration and repeated UI feedback |
| Corgi in the browser | Claude | 831 | 15 | Extended research, approach changes, implementation and verification |
| Custom keybindings | Codex | 210 | 18 | Routine design iteration; zero setback markers |
| Linux ARM64 builds | Claude | 107 | 3 | Implementation and validation; one resolved test failure |
| Schema discussion | Claude | 89 | 6 | Routine research and follow-up questions; zero setback markers |

The three routine replays pass 15 reviewed checks with no invalid model patches.
One original annotation incorrectly required the initial schema explanation and
the user's later redesign request to share a goal; the reviewed anchor starts at
that explicit redesign request instead. The original report and the corrected
review manifest are both retained. The counts above describe this selected set,
not the distribution of everyday coding sessions.

Both long replays reached the end. The plan-project replay produced 14 episodes
and 60 steps over 74 checkpoints; the browser replay produced 15 episodes and 73
steps over 59 accepted checkpoints. After the accounting correction below, they
assign 97.7% and 98.7% of recorded tokens respectively. The review adds event anchors for episode continuity,
separate subproblems, recovery evidence and ordinary feedback without setbacks.
These are development checks added after inspecting the histories, not holdouts.

The expanded set passes 32/34 reviewed checks. Both remaining failures concern
the same rule: a failed check attempt should stay failed after a successful
retry. The model sometimes changes that step to done while retaining its
resolved bump. The browser run also retains three invalid attempts/errors:
two attempts to move existing history, followed later by an invalid title.
The first pair stopped that run; it resumed from the last accepted checkpoint
with a concrete correction. None of these failures are erased by completing the
replay. The candidate still does not meet the clean-eval acceptance gate.

Frozen inputs, manifests, complete model patches and reports stay ignored under
`evals/results/long-plan/expanded-dataset` and the `full-*-v1` run directories.
Manifests can set `label`, `origin` (`historical` or `synthetic`) and `cohort`
(`routine`, `long` or `probe`) to organize browser replays without changing the
model's evidence. Existing fixtures remain useful as targeted probes; they are
not presented as typical development sessions.

Long model replays can resume with `--resume --out EXISTING_RUN_DIRECTORY` and
the same model, manifest, batch, signal mode and prompt. The runner validates
source hashes, reuses only accepted checkpoints, retains rejected attempts and
archives the prior report. Repairs name any attempted identity/parent changes;
the reducer still rejects rewritten history. Resuming a completed replay makes
no additional model calls. Flat-baseline resume is not supported.

Stored focus follows the last foreground work span; passive spans retain attribution without moving focus. Null/unassigned events and
pauses retain focus; new work in another episode moves it. Returning to an older
step moves its combined row to the bottom of the current episode. Returning
after a different episode appends a block. Focus survives reload and cold recovery and
defaults to null in old snapshots. Play icons require active state: a completed
episode stays in the tail but loses its play icon and dims. In the rebase
regression, checkpoints 1, 2 and 3 retain the same episode position; the middle
checkpoint is a completed turn and correctly shows no play icons. The full plan
project's merge checkpoint (event 295) also has no play icon: the commit, final
reply and task completion have all occurred. Runtime/viewer protocol 3 and
saved-format 6 remain unchanged.

The full plan-project replay exposed a token-attribution error after the merge.
A new turn's compaction receipt at source line 902 inherited the old commit's
anchor, adding 247,689 tokens to a completed step. Codex turn boundaries now clear
that fallback anchor, response IDs preserve genuine late updates to their
original work, and identified compaction receipts stay unassigned. The commit
step remains at 972,580 tokens across checkpoints 295–297; the whole-session
total still includes the compaction. The browser uses the separate accounted
history after `report.ts --refresh-usage`. Original histories, model patches and
reports remain unchanged; all five full-session histories have identical model
evidence and identical input, output and cached totals after recalculation.

## 2026-11-08 refresh

Rebased on main `3076252e`. Four newer conversations are frozen under
`evals/results/long-plan/nov8-dataset`; the original candidate and revised model
runs are retained separately. The supplied zstd session is a fork: import only
records at or after the fork timestamp and response receipts owned by its session
ID. Its inherited cumulative counter is not charged to this experiment.
Forks without attributable direct receipts still require an ownership filter.

| Conversation | Events | User turns | Episode returns | Setbacks |
| --- | ---: | ---: | ---: | ---: |
| Codex zstd compression experiment | 56 | 2 | 0 | 2 |
| Claude website animation | 134 | 3 | 0 | 1 |
| Claude installer design discussion | 53 | 3 | 0 | 0 |
| Claude usage-handoff investigation | 434 | 8 | 1 | 4 |

The zstd capture ends while work is running; it is not a completed benchmark.
The two observed setbacks concern dictionary training/test overlap. The website
case retains its failed test attempt after recovery. The installer case exposed
a false verification bump in the first candidate: a factual correction during
research is not a problem that blocked work. The revised prompt removes that
marker. These are development examples, not a representative random sample.

Foreground spans are now separate from attribution. Result and lifecycle events
cannot move attention, even when the model groups them with a later command in
one span. Late usage updates the original visit. A return marker appears on an
episode, not every repeated step. No saved-format field changes are needed: focus
is an inference-span field, while the existing stored focus/visits retain their
shapes. Old inference artifacts without the field keep their original behavior.

The revised four-session run passes 30/31 reviewed assertions. A 20-event synthetic
probe passes 8/9: background polls and notifications do not steal focus, but the
model split the repair into a separate episode instead of keeping it with the
failed verification. The real-session failure is a final PR report interpreted
as resumed implementation. This still creates excessive internal visits in the
long example. The display now combines those visits by step ID within each
episode block, rather than showing repeated rows.
The candidate remains experimental; these failures are retained in `review.json`.
The original model responses are unchanged when the deterministic focus reducer
is re-evaluated. The semantic rubric was added after inspecting these histories.

All 61 accepted checkpoints pass visit ordering, usage conservation, tail and
lifecycle checks. Browser checks cover all five replays at three heights (183
states), plus mobile width and deep links. The browser gallery uses actual Ghostty
captures; the separate interactive replay remains a layout preview.

The repeated trace and implementation/PR rows exposed a display bug: every
attribution visit was shown as a new step. The panel now groups visits by stable
step ID within each consecutive episode block. At event 99 of the handoff replay,
the alternating usage/tracker traces each appear once, with their full costs;
at event 390, implementation and opening the PR each appear once in the returned
episode. Different IDs still preserve separate failed attempts and retries, even
with identical titles. Returning after a different episode retains a separate
block. All 337 recorded checkpoints (the newer set and previous corpus) pass the
expanded ordering, uniqueness and conservation checks. No new model calls were
needed for this deterministic display correction.

The handoff replay also exercises resumed work at event 51: the pending-usage
trace moves below the activity-tracker trace while keeping its accumulated cost.
The overhead episode's on/off/on at events 198, 201 and 204 reflects a real pause:
Claude finishes its report at 22:55:38 UTC, then the user's next question arrives
at 23:09:40. Provider completion clears the play markers; the classifier also
marks the measurement work done based on that report, then reopens the episode
for the follow-up check. Checkpoints have uneven time gaps, so adjacent slider
positions do not imply continuous activity.

### Haiku inference efficiency

The line updater returns a `BEGIN_PLAN` boundary followed by one command per line.
Fixed arguments use spaces; titles, subtitles and problem explanations occupy the
rest of their line. Quotes, brackets, pipes and backslashes are literal. There is
no JSON wrapper, escaping layer, closing marker or formatter tool. Accepted state and request metadata still use compact JSON. Transcript evidence
is sent literally beneath numbered headers, avoiding another layer of JSON
escaping around code and tool arguments. Every source line gets one leading space,
so even source text resembling a header remains quoted evidence. A round-trip
test verifies that this changes no event IDs, kinds, turns or text.

```text
BEGIN_PLAN
new s3 e1 done Fix import and rerun suite
sub s3 Replace removed installer import, then rerun the suite serially
resolve s1
work 19 s3
```

This creates a successful retry under `e1`, resolves the problem on the original
failed attempt `s1`, and attributes the new events through 19 to `s3`. The old
attempt stays failed. Every new node needs `new` and `sub`.

| Command | Meaning |
| --- | --- |
| `new id parent state title` | Create a node; parent `-` means goal |
| `sub id subtitle` | Set a subtitle |
| `title id title` | Set a title |
| `state id state` | Change state |
| `bump id kind detail` | Record a problem on its attempt |
| `resolve id` | Mark that problem recovered, preserving the failed attempt |
| `work end_id step_id` | Attribute foreground work through one inclusive endpoint |
| `note end_id step_id` | Attribute passive work without moving focus |
| `skip end_id` | Cover events with no grounded work |

States are `planned`, `active`, `done`, `failed`, `blocked`, and `abandoned`.
Unchanged activity usually needs only `work` or `note`. The model emits no
citations. The server attaches all observed event IDs from the current batch as
internal provenance and omits those lists from the state sent to the model.
Event IDs remain in source headers and attribution endpoints, where they are
needed for token ownership. Internal provenance is now the update's context,
not a claim that the model selected a minimal set of supporting events.

The shared reducer still validates identity, hierarchy, bounded provenance,
immutable failed attempts and complete event coverage before applying anything.
Recovery requires a fresh observation batch; whether that batch actually proves
recovery remains a classification judgment. Contradictory commands reject the
entire patch. The old `cite` command is not part of the new grammar.
A leading prose preamble before `BEGIN_PLAN` is tolerated. A lone trailing marker,
an exact adjacent duplicate attribution, redundant `through`, and an exact repeat
of an accepted creation are safe syntax normalizations; each is recorded in the
replay's repairs. Different titles, parents or states are not duplicate creations.

The cached conversation receives accepted changes, goals, episodes and open
problems on each update. It receives a complete seed on eviction, restart or state
divergence. The line configuration refreshes after 16 accepted updates or when
prior observed input plus output and a conservative bound on the new delta would
exceed 90k tokens. This leaves room below Haiku's 100k price boundary. The full
seed itself is not truncated. The eval can vary the turn limit with
`--cache-budget --cache-turns N`.

One correction is allowed after rejection. It includes the validation reason,
a specific repair hint and the unchanged accepted nodes; the transcript remains
cached. If that context was evicted or exceeds the budget, the correction has a
complete seed. A second invalid proposal leaves accepted state untouched. Both
attempts are charged and recorded. The daemon and replay runner use this same
correction policy.

The prompt includes examples and counterexamples for TODO-only intentions,
failed reproductions versus expected red tests, abandoned implementations versus
uncommitted hypotheses, successful retries, returning from a side investigation,
publication under the original episode, substantive final reports and ordinary
nonzero search/cleanup results. Low effort and brief deliberation are encouraged, with a soft 400-token target
for changed state and no analysis for routine continuation. This is a prompt
preference, not an enforced provider limit. An aggressive 200-token target and a
shorter policy were rejected after semantic regressions. Examples also cover two
distinct failures inside one batch and substantive explanations that announce
future work.

The no-citation line updater was the first default during the opt-in preview.
It remains available in the replay eval:

```sh
bun evals/long_plan/run.ts --manifest CASES.json --lines --cache-budget --out RUN_DIRECTORY
```

#### Filesystem command experiment

`--fs --cache-budget` selects the experimental path-based updater in both
`run.ts` and `efficiency.ts`. It is not the application's default. The model
receives accepted state plus new events and returns a small edit program:

```text
BEGIN_PLAN
cd /e2
set s11 done
error s12 verification Resume test expected offset 20 but got 0
mkdir retry active Repair resume offset
set retry subtitle Retain the saved byte offset before restarting the transfer
work retry
```

The current grammar has **eight operators**, down from the first trial's 12:

| Operator | Forms and purpose |
| --- | --- |
| `mkdir` | `mkdir path state title` creates a node; also set its subtitle |
| `set` | `set path done`, `set path title text`, `set path subtitle text` |
| `cd` | `cd /e2` sets the directory for relative paths |
| `mv` | `mv /s11 /e2/` changes the parent of a node created in this response |
| `error` | `error path verification detail` records a problem; `error path resolved explanation` records recovery |
| `work` | `work path [end_id]` assigns foreground events to a step |
| `note` | `note path [end_id]` assigns passive results without moving focus |
| `ignore` | `ignore [end_id]` leaves events unassigned |

`set path skipped` explicitly abandons a canceled task or episode. It is distinct
from ignoring events. The states are planned, active, done, failed, blocked, and
skipped. Titles, subtitles and explanations occupy the remainder of their line;
quotes, backslashes and shell-looking text are literal. These commands never run
in a shell. The parser rejects the older `skip`, `describe`, `title`, `error_set`
and `error_resolve` commands instead of maintaining a second vocabulary.

Paths use stable IDs: `/g1/e2/s11`, `/e2/s11`, and `/s11` identify the same node.
A supplied parent must actually match. Relative paths resolve beneath the current
directory; only absolute paths provide global ID shortcuts. The directory resets
to `/` on **every response**, including repairs and cache resets. The final trial
uses explicit targets instead of `_`: earlier runs repeatedly treated the alias
as persistent across updates. `mv` is restricted to unaccepted draft nodes because moving accepted
nodes would change how past tokens roll up to episodes. It cannot rename nodes.

Attribution endpoints are inclusive and increasing. Omit the endpoint to consume
all remaining events; an optional `through` before the number is accepted.
For a batch containing events 6–8, `ignore 6`, `note /s1 7`, and `work /s2`
cover those three events in order. Adding a planned node does not require an
extra attribution command. A trailing `ignore` with no events remaining is a
recorded no-op. Repeating the most recent attribution with the identical endpoint,
owner and foreground/passive mode is also a recorded no-op, even if node edits
intervene. Changed owners, changed focus modes and incomplete coverage still
reject atomically. An explicit two-number range is normalized only when its start
exactly matches the next unassigned event; gaps and overlaps remain errors.

An error belongs to its original attempt. Resolving it preserves its category,
original failure detail, and failed status; the recovery explanation becomes
that step's subtitle. A successful retry gets its own step. State rows sent to
the model contain full paths and readable kind/state words, with no citation
arrays. The same literal event encoding, canonical reducer, cache budget,
one-correction policy, and receipt accounting are used as for the line control.

`fs_probe.json` adds a synthetic cancellation and recovery case: a throughput
benchmark is deliberately stopped while a CSV quoting failure is repaired.
It checks canceled status, absence of an invented error on the intentional stop,
preservation of the failed test, successful recovery and episode continuity.
The existing real/synthetic corpora and their rubrics remain unchanged.

```sh
bun evals/long_plan/run.ts --manifest evals/long_plan/fs_probe.json --batch 4 \
  --fs --cache-budget --model claude:claude-haiku-5-5 --effort low --out NEW_RESULTS
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY --fs --cache-budget
```

#### Filesystem experiment results

The selected eight-operator trial is `fs-v7`. Two repetitions cover the same
198 checkpoints over four historical conversations and seventeen synthetic/focus
cases as the no-citation line control. Both use Haiku 5.5 at low effort, the same
90k/16-update cache policy, one correction, and the same audited 106 semantic plus
126 structural checks. Controls were not re-prompted or rescored with easier
criteria. Completed, equal-workload runs include every rejected attempt in cost.

| Two runs / 198 updates | Previous no-cite lines | Filesystem v7 |
| --- | ---: | ---: |
| Semantic checks | 102/106 | 99/106 |
| Structural checks | 126/126 | 126/126 |
| Rejected attempts, successfully corrected | 3 | 6 |
| Updates lost after correction | 0 | 0 |
| Uncached input, including writes | 642,375 | 623,848 |
| Cached input | 4,987,090 | 5,295,499 |
| Output, including thinking | 143,743 | 131,239 |
| Thinking subset | 124,892 | 109,872 |
| API-equivalent cost | $0.25018 | $0.24330 |

That is 2.7% less cost on the large replay batches, with three fewer semantic
checks passing. It is not evidence of a quality improvement. Both filesystem
runs missed the transient Pillow-to-ffmpeg recovery in the website conversation
and failed to separate an unrelated README request into a new goal. One also
lost a concrete animation component from its episode label. Three corrected
rejections involved relative paths, one malformed coverage, one trailing prose,
and one attribution to a planned step. Both runs retained token conservation.

The more representative production-window comparison is essentially flat:

| Mean per 52 matching production updates, two runs each | Previous no-cite lines | Filesystem v7 |
| --- | ---: | ---: |
| Uncached input | 53,687 | 52,485 |
| Cached input | 575,250 | 618,833 |
| Output, including thinking | 15,480 | 15,288 |
| Thinking subset | 12,677 | 11,905 |
| API-equivalent cost | $0.02422 | $0.02432 |

Production cost rose 0.4%; one correction was needed across each format's 104
updates. Thinking was 77.9% of filesystem output. The separate cancellation probe
passed 11/11 checks over six updates after one path correction. The four existing
holdout cases completed all fourteen updates with no rejected programs, but
passed 28/30 checks: one TODO-only request became active and its first intended
step was no longer planned. The prior no-cite holdouts passed 29/30. These misses
are semantic judgments, not parser failures. **Keep this format eval-only.**

The initial draft used twelve operators and `_`. Field setters merged into
`set`; `skip` became `set path skipped`; error recording and recovery merged into
`error`. `_` was removed after several runs incorrectly carried it across update
boundaries. An extra `ignore` after full coverage, an exact repeated assignment,
an omitted `through`, and a valid explicit start/end range now normalize without
changing event ownership. Invalid paths and conflicting coverage still fail
closed. This avoids retries for harmless redundancy without guessing a target.
The v4 and v6 trials each lost an update after both attempts were rejected;
their incomplete replays are retained and excluded from equal-workload cost
comparisons. The v4 failure reused an existing ID in another directory; the v6
failure used an explicit range after an invalid `cd` into a step. Corrections now
explain globally unique IDs and directory kinds, and range normalization verifies
the start against the actual coverage cursor.

Raw output from the cancellation probe, checkpoint 7:

```text
BEGIN_PLAN
cd /g1/e1
work s1 4
set s2 active
error s2 verification Quoted-comma name produced an extra CSV column
work s2 6
note s2 7
```

Its later recovery, checkpoint 17:

```text
BEGIN_PLAN
set /s4 done
set /s5 done
set /s5 subtitle Unicode, embedded quotes, and quoted commas pass
error /s2 resolved Retry passes after comma-quoting repair; original failure kept
set /e1 done
set /g1 done
work /s5
```

Artifacts under `evals/results/long-plan/line-format/` are
`fs-v7-{1,2}-{real,synthetic,focus}`, `live-fs-v7-{1,2}`, `fs-v7-probe`,
`fs-v7-holdout`, `fs-final-comparison.json`, and `fs-window-costs.json`.
Earlier trials and source snapshots are retained there. The raw command programs,
canonical snapshots, source hashes, accepted corrections and final usage receipts
are preserved. Pricing and thinking accounting follow the rules below.

#### Explicit ownership experiment

`--owner reviewed` tests filesystem commands with explicit event ownership. This
prompt remains the eval control; the later `direct` variant now powers the
application feature. The seven operators are `mkdir`, `set`, `cd`, `mv`, `error`,
`set_owner`, and `set_focus`.

```text
BEGIN_PLAN
set_owner 1..19 /s1
set_focus 2 /s1
set /s1 state done
```

This assigns transcript events 1 through 19, inclusive, to the existing step
`s1` for token and tool accounting. It does not move visible tree nodes. Event 2
must be actual foreground activity owned by `s1`; it selects that step as focus.
An older step receiving a delayed tool result can receive ownership without
stealing focus. Status and focus are separate: `active` means unfinished work,
not necessarily the current foreground activity. `set /s1 done` remains valid.

Ownership ranges must cover exactly the new batch, without gaps or conflicting
overlaps. A single event can be `set_owner 7 /s1`. `none` leaves no-work events
unassigned. Identical assignments are idempotent; other conflicting coverage is
rejected atomically. Commands can appear out of range order; the reducer sorts
them before validation. Focus references must belong to the selected owner.
Passive result/lifecycle focus requests are ignored and recorded as repairs.
The existing path, globally unique ID, failed-history and draft-only `mv` rules
remain in force. Neither protocol executes shell commands.

Three prompt variants share this parser and the same inputs:

- `syntax`: explicit ownership/focus with the full existing semantic policy.
- `reviewed`: also reviews failures, scope, TODO evidence and concrete labels,
  with complete worked examples and counterexamples.
- `lean`: short semantic policy with the same complete worked examples.

The complete recovery, goal-switch and planning examples are executable test
fixtures: tests run the exact strings embedded in the prompt. Their subjects
and IDs differ from the evaluated conversations. Uppercase arguments now
distinguish placeholders from lowercase keywords. The first trials exposed an
ambiguity in `set PATH state`: models wrote `set PATH state done`, while the
parser expected `set PATH done`. Explicit `state` is now the recommended field
spelling in this experiment; both forms are accepted. Those incomplete first
trials are retained under `owner-*` and excluded from equal-workload comparisons.
The frozen revised trials are `owner2-*`.

The previous filesystem regressions were specific:

- An unresolved retry defect followed by a README request stayed under the old
  goal. That particular request does not specify the README's topic, so its
  expected separation is debatable. Keep its existing check, and add a clearly
  unrelated footer-font request plus a related queue-workaround documentation
  counterexample. These are targeted development probes, not blind holdouts.
- An animation episode lost its concrete component names in a label like
  "extras". The reviewed prompt asks for component nouns to survive edits.
- A TODO-only holdout became active without execution. The worked planning
  example leaves every intended task and ancestor planned, with owner `none`.
- The website replay folds a failed Pillow conversion, successful ffmpeg fallback
  and later failing tests into one broad verification step. The transient
  environment error disappears. This also affected the previous no-cite lines;
  it is an existing weakness, not a new ownership-format regression. Two checks
  measure this one missed incident. The revised prompt handles the analogous
  SQL migration probe but still misses this longer historical batch.

First complete run, fixed 99 checkpoints / 53 semantic checks. All variants
also pass all 63 structural checks, including token conservation. No updates
were lost; rejected attempts shown here succeeded on the one permitted retry.

| Format/prompt | Semantic checks | Rejected attempts | Uncached input | Cached input | Output, including thinking | API-equivalent cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous no-cite lines, run 1 | 51/53 | 2 | 323,536 | 2,536,043 | 69,633 | $0.12486 |
| Previous filesystem v7, run 1 | 49/53 | 1 | 309,046 | 2,621,652 | 64,548 | $0.12028 |
| Explicit ownership, syntax | 49/53 | 2 | 327,426 | 2,000,212 | 72,683 | $0.12181 |
| Explicit ownership, reviewed | 51/53 | 0 | 347,140 | 2,103,511 | 81,376 | $0.13113 |
| Explicit ownership, lean | 45/53 | 4 | 328,926 | 2,426,987 | 59,180 | $0.11962 |

The short policy loses substantive report attribution, TODO states and episode
boundaries. Keep the detailed policy: lower output alone is not a quality win.
These checks are regression assertions, not a comprehensive judgment of prose
quality, and one run cannot establish a causal effect or stable success rate.

The repeated reviewed run passed 48/53 semantic checks. Both runs retained the
scope/animation-label checks that had regressed with filesystem v7, but the
repeat lost the zstd data-leakage constraint, folded the handoff rebase into the
diagnosis episode, and briefly switched focus to a background poll. The model
explicitly emitted `set_focus` for that poll despite the instruction to keep
focus unchanged; the parser cannot infer foreground intent from a generic tool
event. Do not interpret the first run's improvement as a reliable quality gain.

| Two complete runs / 198 updates | Previous no-cite lines | Filesystem v7 | Ownership, reviewed |
| --- | ---: | ---: | ---: |
| Semantic checks | 102/106 | 99/106 | 99/106 |
| Structural checks | 126/126 | 126/126 | 126/126 |
| Rejected attempts, successfully corrected | 3 | 6 | 1 |
| Updates lost after correction | 0 | 0 | 0 |
| Uncached input, including writes | 642,375 | 623,848 | 658,655 |
| Cached input | 4,987,090 | 5,295,499 | 4,300,075 |
| Output, including thinking | 143,743 | 131,239 | 149,353 |
| Thinking subset | 124,892 | 109,872 | 119,124 |
| API-equivalent cost | $0.25018 | $0.24330 | $0.24937 |

On the separate, matching production windows, the means of two runs are:

| Mean per 52 updates | Previous no-cite lines | Filesystem v7 | Ownership, reviewed |
| --- | ---: | ---: | ---: |
| Uncached input, including writes | 53,687 | 52,485 | 56,005 |
| Cached input | 575,250 | 618,833 | 675,381 |
| Output, including thinking | 15,480 | 15,288 | 18,365 |
| Thinking subset | 12,677 | 11,905 | 14,247 |
| API-equivalent cost | $0.02422 | $0.02432 | $0.02713 |

Ownership completed all 104 production updates with no rejected attempts.
Thinking is 77.6% of its output. Its cost is 11.5% above filesystem v7 and 12.0%
above no-cite lines. The syntax-only variant cost $0.02812 for one 52-window run,
including two rejected attempts. This is a clearer ownership interface with
fewer rejected programs, **not a demonstrated cost or semantic-quality win**.
It remains eval-only.

`owner_probe.json` adds paired related/unrelated outcomes and a transient
failure/recovery case. The last case contains both a successful tool-discovery
probe with a nonzero exit code and a genuine failed migration, followed by a
separate integrity failure. It checks that the discovery probe is not invented
as a third error, and that resolving the migration does not erase its failed
attempt or resolve the unrelated integrity error.

At batch size 24, reviewed examples passed 24/24 then 22/24 on these probes; the
repeat omitted the initial queue-test error, failing two checks for that one
incident. Syntax-only and lean each passed 21/24; filesystem v7 passed 23/24.
The pre-existing `line_holdout.json` passed 30/30 over fourteen updates after one
path correction, versus v7's 28/30. Cancellation/recovery passed 11/11 over six
updates with no correction. A separate smaller-batch stress run of the line
holdout also passed 30/30; its 35 updates are not used in the fourteen-update
comparison. These samples do not establish a general reliability rate.

Actual output from the reviewed migration probe, checkpoint 10, includes:

```text
set /g1/e1/s1 failed
set /g1/e1/s1 subtitle Python migration stopped: psycopg module missing before any SQL ran
error /g1/e1/s1 environment Python migration could not import psycopg; migration never started
mkdir /g1/e1/s2 active Apply migration with psql
set /g1/e1/s2 subtitle Retry through the installed psql client after the Python driver failed
set_owner 3 /g1/e1/s1
set_owner 4..7 /g1/e1/s2
set_focus 4 /g1/e1/s2
set /g1/e1/s2 done
set /g1/e1/s2 subtitle Applied migration.sql to staging through psql with exit code 0
error /g1/e1/s1 resolved psql applied migration.sql to staging successfully, bypassing the missing psycopg driver
```

This is a contiguous excerpt; the complete program also creates a separate
integrity-test step and records its verification error. The original failed
Python attempt stays failed even though its obstruction is resolved.

```sh
bun evals/long_plan/run.ts --manifest evals/long_plan/owner_probe.json \
  --owner reviewed --cache-budget --batch 24 --effort low --out NEW_RESULTS
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY \
  --owner reviewed --cache-budget
```

Use `--owner syntax` or `--owner lean` for the comparison prompts. Historical
replays use the same manifests, cache budget, low effort and receipt accounting
as the filesystem experiment above. `report.ts` with `efficiency_checks.json`
rescored the historical cases; synthetic/focus rubric meanings were unchanged.

Raw programs, accepted snapshots and receipts are under
`evals/results/long-plan/line-format/owner2-{syntax,reviewed,lean}-1-*`,
`owner2-reviewed-2-*`, `live-owner2-*`, `owner2-*-probe*`,
`owner2-reviewed-holdout24`, and `owner2-reviewed-cancel`. `owner-comparison.json`
checks matched source evidence/checkpoints and includes both broad repeats and
production-window repeats. `owner2-source/` preserves the evaluated source.

#### Repeated ownership optimization

The follow-up keeps the seven operators and tests independent repetitions per
conversation, separately from a rejected program's single correction attempt.
The frozen `reviewed` prompt remains the control. `direct` keeps its full semantic
policy but asks the model to process observations chronologically and emit local
changes, instead of first optimizing the complete command list. Redundant valid
commands are acceptable; missing failures and constraints are not.

The experiments also include:

- `guided`: complete background-poll, failed-check and branch-repair examples,
  plus explicit short-path and output-size guidance.
- `indexed`: the same prompt with literal, truncated result prefixes as a
  navigation aid. Every source event remains complete. The index does not
  classify results as failures.
- `balanced` / `compact`: a shorter policy retaining the distinctions the first
  lean prompt lost. `compact` additionally gives specific correction guidance
  when a second failure would overwrite an already resolved one.
- `direct-focus`: the full chronological policy with updates repeating only
  changed nodes, the focused step, open errors, and all their ancestors. The
  accepted tree remains complete on refresh. `focused` tests that same state
  selection with the shorter policy.
- `direct-bounded`: the full chronological policy and ordinary state updates,
  but source support on refresh retains the latest eight older observations,
  evidence for the focused step and its ancestors, and every open problem's
  evidence. Every new event and every accepted node remains present. Newly
  relevant old evidence is sent when the focus returns to another branch.

All variants use the same low effort, sixteen-update / 90k cache budget and
one-correction policy unless explicitly labeled as a 32-update cache trial.
That longer cache trial was more expensive. An initial short-policy trial lost
an update after both programs attempted to put two different failures on one
step; its incomplete cost is not compared as a complete replay.

Unit tests execute the exact complete prompt examples. They also check that
state filtering retains ancestor paths and current constraints, bounded support
preserves new events and open-error evidence, and evidence omitted from a fresh
seed is supplied when it becomes relevant again. The replay resumption check now
distinguishes a valid null text-only schema from a missing configuration value;
changed schemas, prompts and cache settings still reject resumption.

`replicate_report.py` requires at least three quality and three production-window
runs per finalist. It checks source evidence, checkpoint alignment and rubric
identity; an incomplete run cannot be compared as a cheaper full run. It reports
per-conversation failures, per-run scores, means, ranges and sample standard
deviations. All retry receipts are included; thinking remains a subset of output.
Initial cache reads/writes are reported because a warm initial prompt and a cold
one are not equivalent. No run is dropped merely for scoring poorly.

```sh
bun evals/long_plan/run.ts --manifest CASES.json --owner direct \
  --cache-budget --batch 24 --effort low --timeout-ms 240000 --out RUN_DIRECTORY
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY RUN_DIRECTORY \
  --owner direct --cache-budget
python3 evals/long_plan/replicate_report.py GROUPS.json COMPARISON.json
```

`GROUPS.json` is an array of `{label, quality: [PREFIX, ...], windows: [DIR, ...]}`.
Each quality prefix has `-real`, `-synthetic`, and `-focus` directories with
`review.json` produced by `report.ts`. Historical reviews use
`efficiency_checks.json`; synthetic and focus reviews retain their original
manifests. Three repeats estimate variation on these conversations, not a general
reliability rate. The fixed regex checks also have limits: for example, the
valid subtitle "Dictionaries exclude each evaluated recording; byte-exact round
trips verified" failed the existing constraint-label regex in a focused-state
run. It remains a failed check in the primary comparison; the rubric was not
changed to favor that variant.

The final comparison uses three independent runs of each conversation: 297 broad
updates and a separate 156 production-window updates per variant. Parser retries
are additional measured calls, not independent repetitions. Every finalist
completed every update; all 189 structural checks passed for each variant.

| Ownership variant | Semantic checks across three runs | Per-run scores / 53 | Corrected rejections / 297 updates | Mean cost / 52 production updates | Cost range |
| --- | ---: | --- | ---: | ---: | --- |
| Committed `reviewed` control | 150/159 | 51, 48, 51 | 3 | $0.02647 | $0.02550–$0.02769 |
| **Recommended `direct`** | **155/159** | **53, 53, 49** | 7 | **$0.02789** | $0.02639–$0.02917 |
| `direct-focus` | 154/159 | 51, 53, 50 | 5 | $0.02776 | $0.02691–$0.02885 |
| `direct-bounded` | 155/159 | 52, 51, 52 | 11 | $0.02901 | $0.02760–$0.02991 |

The corresponding mean production token counts include every retry:

| Per 52 updates | Reviewed control | Recommended direct | Direct + focused state | Direct + bounded support |
| --- | ---: | ---: | ---: | ---: |
| Uncached input, including writes | 53,923 | 58,170 | 58,226 | 58,136 |
| Cached input | 683,357 | 687,981 | 689,675 | 700,164 |
| Output, including thinking | 17,727 | 18,770 | 18,450 | 20,785 |
| Thinking subset | 13,808 | 14,343 | 13,906 | 16,142 |

The recommendation is a quality tradeoff, not a proven cost reduction: `direct`
costs 5.4% more on the measured mean, about $0.00142 per 52 updates. The ranges
overlap; three runs do not establish a statistically reliable cost difference.
One direct run initially paid for a cold prompt while the control's initial
prompt was cached. This cost is retained in the mean, and initial cache receipts
are exposed in the machine-readable report. `direct` is the recommended
ownership variant and the application's default activity updater.

Historical checks, aggregated across the three independent runs:

| Conversation | Reviewed control | Direct | Direct + focused state | Direct + bounded support |
| --- | ---: | ---: | ---: | ---: |
| Codex zstd | 11/12 | 11/12 | 11/12 | 11/12 |
| Claude website | 12/18 | 16/18 | 14/18 | 16/18 |
| Claude handoff | 29/30 | 29/30 | 30/30 | 29/30 |
| Claude installer | 3/3 | 3/3 | 3/3 | 3/3 |

The transient Pillow-to-ffmpeg recovery was retained in two of three direct runs,
versus none of three control runs. Direct's third run also failed a zstd title
check and merged a substantive rebase into diagnosis. The zstd step's generic
title missed the regex, but its subtitle retained independent training sessions;
that assertion does not establish that the fairness finding was lost. Two perfect
53/53 runs therefore did not establish reliability. All synthetic/focus checks passed in
all direct runs. Separate three-run targeted probes, prior holdouts and
cancellation cases passed 72/72, 90/90 and 33/33 respectively, with all attempts
retained. Bounded-support runs also passed those separate checks, but did not
improve broad quality and cost more.

The selected programs remain filesystem-like; no extra operators were added.
The cheaper short-policy candidates lost meaningful distinctions. Result indexing
and longer cache reuse did not earn their cost, and neither context-pruning
strategy is enabled by the recommendation.

Artifacts are under `evals/results/long-plan/line-format/`. The complete comparison
is `owner6-comparison.json`, generated from `owner6-replicates.json`.
It retains all three control runs, all three chronological full-policy runs,
all three focused-state runs, all three bounded-support
runs, production receipts and per-conversation outcomes. `owner3-*` and
`owner4-*` also retain exploratory and incomplete trials. The selected direct
probe/holdout/cancellation repetitions are `owner5-direct-{1,2,3}-{probe,holdout,cancel}`.
`owner6-source/` preserves the evaluated implementation; test snapshots use a
`.snapshot` suffix so Bun does not discover them as a second test suite.

#### Cost accounting

Use API-equivalent dollars, not the sum of input and output tokens. Rates checked
2026-11-08 against [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing):

| Haiku 5.5, standard/global | USD per million tokens, prompt ≤100k |
| --- | ---: |
| Regular input | $0.10 |
| 5-minute cache write | $0.125 |
| 1-hour cache write | $0.20 |
| Cache read | $0.01 |
| Output, including thinking | $0.50 |

All measured writes used the 1-hour rate. Above 100k input tokens **in one API
request**, including cache reads and writes, all these rates are 5×. The calculator
prices individual iterations when needed, not the sum of several requests as one
long prompt. A receipt with incomplete iteration details can be priced exactly if
its aggregate input is below 100k; otherwise the calculator refuses to guess.
Unsupported speed/service tiers and missing cache TTL breakdowns also fail closed.

Final provider receipts are authoritative. Partial assistant usage, cumulative
`modelUsage`, and the receipt's iteration details are not added again. Thinking
is a subset of output. Uncached input includes cache writes. Older audit files
called regular input alone “uncached”; `window_cost.py` derives all categories
from the underlying receipts consistently. Some JSON CLI receipts omit earlier
formatting iterations while retaining their token totals, so the observed number
of extra formatting calls is only a lower bound. These are API list-price
equivalents, not claims about Claude Code subscription billing.

#### Removing model-written citations

The current line format removes `cite` and omits provenance arrays from cached
model state and correction messages. The application attaches the observed batch
internally. No other classification policy or thinking target was changed.
The complete output example also no longer repeats a subtitle just to demonstrate
a change of citation scope.

Two matched runs of 52 production windows give:

| Format | Runs | Mean uncached input | Mean output incl. thinking | Mean API-equivalent USD |
| --- | ---: | ---: | ---: | ---: |
| Original line format, v6 | 1 completed reference | 57,500 | 9,159 | $0.02170 |
| Revised lines with citations, v20 | 2 | 54,330 | 16,320 | $0.02497 |
| Lines without citations | 2 | 53,687 | 15,480 | $0.02422 |

Removing citations saved 3.0% cost and 5.1% output in these windows, but remains
11.6% dearer than the original successful line run. Thinking still accounts for
81.9% of output. The new repeat of the original implementation, from exact commit
`38dca8f0`, stopped after 35 accepted updates when the next title was invalid.
Its 36 requests cost $0.01734 through failure; that incomplete workload is not
included in the full-window cost table or normalized into a cheaper estimate.

Across two broad replays (198 updates), the comparison is:

| Format | Uncached input | Cached input | Output incl. thinking | Thinking subset | API-equivalent USD | Semantic checks | Corrected rejections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| With citations, v20 | 609,559 | 4,923,530 | 159,279 | 138,128 | $0.25075 | 103/106 | 2 |
| Without citations | 642,375 | 4,987,090 | 143,743 | 124,892 | $0.25018 | 102/106 | 3 |

Both completed all 198 updates and passed all 126 structural checks. Output fell
9.8%, but uncached input rose 5.4%, leaving cost effectively flat (-0.2%). The
one-check quality difference does not establish a clear quality advantage for
either format. Removing citations simplifies the protocol; it is not a material
overall cost win. Batch provenance also gives up precise per-edit source links.
The no-citation failures concern a missed brief dependency failure, an extra
setback, and a rebase folded into the repair episode. Both additional runs of the fixed synthetic suite miss the Unicode constraint
in an episode subtitle (29/30 checks each); one run also needs a successful
assignment correction. The 742-event historical replay passes all seven checks
and accepts all 46 updates after two corrections. Across the broad suite, the
long replay and both additional synthetic runs, all 272 updates are accepted
after six corrections. These results retain every miss and rejected attempt.

Artifacts are `nocite-{1,2}-{real,synthetic,focus}`, `live-nocite-{1,2}`,
`nocite-holdout{,-repeat}`, `nocite-headless`, `nocite-repeated-comparison.json`, and
`nocite-window-costs.json` under `evals/results/long-plan/line-format/`.
The failed original control and its price through failure are retained in
`live-v6-control-repeat/`. All cost figures include rejected attempts and thinking.

#### Measured result: revised line updater

The previously selected v20 prompt keeps the fuller policy, adds concrete failure/attribution
examples, and uses the shared cache and correction implementation. Two matched
runs per format cover 198 updates over four real conversations and seventeen
synthetic/focus cases. The audited rubric is identical for every format.

| Format, two runs | Uncached input | Cached input | Output incl. thinking | Thinking subset | API-equivalent USD | Semantic checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Compact JSON, low effort | 641,153 | 5,379,470 | 172,918 | 134,137 | $0.28135 | 101/106 |
| Previous lines, v6 | 637,104 | 4,917,168 | 120,918 | 97,059 | $0.25034 | 96/106 |
| Revised lines, v20 | 609,559 | 4,923,530 | 159,279 | 138,128 | $0.25075 | 103/106 |

Against JSON, revised lines use 4.9% less uncached input and 7.9% less output,
and cost 10.9% less. Against the earlier line prototype, cost is effectively flat
(+0.2%) while semantic checks improve and rejected first attempts fall from seven
to two. All corrections succeeded. The revised format spends more thinking than
the fragile prototype; shrinking that number alone was not the objective.
Thinking accounts for 86.7% of revised output in these larger replay batches.
All 126 structural checks pass. The three semantic misses represent two issues:
a goal subtitle loses the durable objective, and one repeat omits a short-lived
missing dependency and its recovery. These remain visible failures, not waived
checks. The historical JSON and v6 line runs each incurred a long-context premium
request; the revised runs incurred none. Prices include those differences.

The separate production-window benchmark uses exactly 52 bounded windows:

| Updater | Runs | Mean uncached input | Mean cached input | Mean output incl. thinking | Mean API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main: flat activity label | 1 | 26,419 | 340,979 | 8,740 | $0.01305 |
| Compact JSON plan | 1 | 61,808 | 663,463 | 18,845 | $0.02841 |
| Previous line plan, v6 | 1 | 57,500 | 562,938 | 9,159 | $0.02170 |
| Revised line plan, v20 | 2 | 54,330 | 595,259 | 16,320 | $0.02497 |

The revised plan averages 12.1% less cost than JSON here, with 12.1% less uncached
input and 13.4% less output. It is 15.1% dearer than the earlier line prototype
on these smaller windows, where neither incurred the long-context premium.
The flat main updater does a smaller job and remains cheaper. Cache warmth and
model sampling vary; these are measured workloads, not a universal savings rate.

Additional validation passes all 30 checks on four fixed synthetic conversations
and all seven checks on the 742-event historical Codex conversation. The latter
needed three successful corrections (recovery evidence, immutable failure state,
and title length). Across these validations and the repeated broad suite, all
258 updates were accepted, with five corrections and no dropped update. The
production-window replays add 104 accepted updates without corrections.

Reproducible summaries are retained locally in
`line-format/final-repeated-comparison.json` and `line-format/v20-window-costs.json`.
Runs are `v20-{1,2}-{real,synthetic,focus}`, `v20-holdout`, `v20-headless`, and
`live-v20{,-repeat}` beneath `evals/results/long-plan/line-format/`. Failed earlier
trials remain there too. Parser/coverage guarantees are deterministic; semantic
classification is measured by the checks above and is not perfect.

#### Eval quality and reproducibility

The broad corpus has four historical conversations and seventeen synthetic/focus
cases, at 99 checkpoints. Production-window comparisons use a separate set of 52
smaller windows from four real conversations. Keep their absolute token totals
separate. Additional validation includes a 742-event historical Codex handoff
prototype and four new synthetic cases, including 102 events of ordinary CSV
implementation with no setbacks. Raw histories, outputs and receipts stay in
ignored `evals/results/long-plan/`.

The rubric was audited against actual source events. The website's missing-Pillow
failure (76–77), recovered by ffmpeg (80–81), is a real second setback. The handoff
implementation check now targets the write at 272 rather than the read at 237;
notification/report focus targets the actual PR operations at 379 and 387 rather
than the earlier remote check at 374. Animation scope can be present in the
episode title or subtitle: repeating “heart” in both is not a quality requirement.
The dictionary topic matcher accepts “held-out” as well as “holdout”. A goal can
mention worktree round-trips while correctly describing lost handoff state; that
word alone no longer fails the outcome check. The amended
rubric adds an explicit recovery check, for 116 assertions (53 semantic and 63
structural). Original reports are preserved; `report.ts` rescores every control
and candidate equally into `review.json`.

The original v6 line experiment reduced output but missed more semantic checks
and needed seven retries across two runs. Those results remain under
`line-format/v6-{1,2}-*`; they are not the revised protocol's results. Intermediate
prompt, cache and thinking trials are retained too, including incomplete runs.

```sh
# Broad replay; use --batch 4 for focus_probe.json.
bun evals/long_plan/run.ts --manifest CASES.json --lines --cache-budget \
  --effort low --timeout-ms 240000 --out LINE_PREFIX-real
# Rescore real runs with audited labels, preserving original reports.
bun evals/long_plan/report.ts evals/long_plan/efficiency_checks.json REAL_RUN_DIR
# Summarize matching -real/-synthetic/-focus prefixes; --review uses review.json.
python3 evals/long_plan/format_report.py JSON_PREFIX LINE_PREFIX comparison.json --review
# Price matching production windows, including rejected attempts.
python3 evals/long_plan/window_cost.py MAIN_DIR JSON_PLAN_DIR LINE_PLAN_DIR
python3 evals/long_plan/pricing_test.py
```

The matched benchmark replays 52 production-sized observation windows from four
real conversations: zstd, website, installer and handoff. It is a controlled
comparison, not a simulation of production hook timing. Main uses its production
flat summarizer and persistent conversation; the plan version uses the bounded
roadmap observations. Cache availability and model sampling vary between runs.

The earlier JSON optimization comparison (`compact-comparison.json`) was:

| Inference tokens | Main, rerun | Previous plan | Compact cached plan |
| --- | ---: | ---: | ---: |
| Input excluding cache reads | 26,419 | 128,284 | 61,808 |
| Cached input | 340,979 | 251,732 | 663,463 |
| Output, including thinking | 8,740 | 39,229 | 18,845 |
| Thinking, already in output | 4,648 | Not recorded separately | 12,421 |
| Total input plus output | 376,138 | 419,245 | 744,116 |

Against the previous plan updater, uncached input fell 51.8% and output fell
52.0%. That JSON version remains above main: 2.34 times its uncached input
and 2.16 times its output. Conversation reuse increases cached reads, so the raw
token total rises 77.5% versus the previous plan. This is a reduction in
uncached processing and generation, not in all tokens. No dollar or subscription
quota savings are inferred from unweighted totals.

A compact self-contained control on the same 52 windows consumed 121,661
uncached input and 46,662 output tokens, including 38,461 thinking tokens.
It repeatedly reconstructed the plan. The accepted-state conversation is doing
most of the useful work; shortening JSON alone was insufficient. The final
cached run required no extra provider formatting calls.

The earlier JSON prompt passed 115/115 reviewed checks: 32 across four real
conversations, 74 across sixteen synthetic cases, and nine on the six-prefix
background-focus holdout (`--batch 4`). No patches were rejected. All 99 saved
checkpoints were revalidated against the final decoder with identical states.
The real replay is `opt-v13-real` (review.json); synthetic and focus runs are
`opt-v13-synthetic` and `opt-v13-focus`. Final matched usage is `opt-v14-live`;
main's audited replay is `opt-v6-main-audited`. These are finite regression
checks, not a guarantee across every future conversation.

The usage audit records final Claude `result.usage` receipts and checks them
against Corgi's normalized totals. Input includes ordinary input, cache writes
and cache reads. Uncached input includes cache writes. Output **already includes
thinking**; `output_tokens_details.thinking_tokens` is a subtotal, never an extra
charge. Repeated partial assistant reports, cumulative `modelUsage`, and the
per-iteration breakdown are not added again. The audit fails if normalized
counts differ or a final receipt is missing; unavailable thinking counts remain
unknown. This is checked against both raw live receipts and the provider adapter
regression test. See [Claude's thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking).

The previous JSON updater's matched result is retained in
`optimization-comparison.json`. The compact trials, including rejected formats
and semantic failures, remain under `evals/results/long-plan/opt-v3-*` through
`opt-v14-*`. Private conversations are not committed.

The real-conversation rubric still checks foreground work, goals, constraints,
episode boundaries, subtitles and failed attempts. After inspecting event 52
in the zstd transcript, its topic matcher also accepts “record” as
a synonym of capturing independent training sessions. This matcher is applied
to both baseline and candidate; it does not remove any substantive expectation.
The negative grep check now looks for a setback whose failure evidence starts at the read command/result
(events 428-429), rather than rejecting a genuine earlier rebase conflict on
the same reused step (failure at 399, recovery at 410/412). A unit test verifies
that it still rejects an invented failure at the grep result. Original reports
remain intact; review.json records these explicitly reviewed scorer changes.

```sh
# Compare the compact JSON control with frozen production-sized windows.
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY
# Replay main's flat summarizer on its corresponding frozen observations.
bun evals/long_plan/main_efficiency.ts BASELINE_DIRECTORY MAIN_RESULTS_DIRECTORY
# Replay the previous line updater for comparison.
# Runners retain JSON as their default control; pass these flags explicitly.
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY --lines --cache-budget
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY --json-ops
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY --stateless
bun evals/long_plan/efficiency.ts BASELINE_DIRECTORY NEW_RESULTS_DIRECTORY --legacy
bun evals/long_plan/report.ts evals/long_plan/efficiency_checks.json RUN_DIRECTORY
```

`--cached` retains the rejected legacy delta-conversation experiment, and
`--plain` retains the earlier plain-JSON ablation; it is redundant with `--lines`. All output formats still use the same
hard title/subtitle limits and semantic validator.

### Thinking effort sweep

The production Claude summary process already passes `--effort low`. The eval
runner can override that launch flag with `--effort low|medium|high` without
changing the application default. It records the requested effort and the model
and effort actually passed to each process. `--brief-thinking` adds a separate
instruction to minimize deliberation while retaining all semantic rules. This is
a prompt experiment, not a lower named effort level or disabled thinking.

```sh
bun evals/long_plan/run.ts --manifest CASES.json --json-ops --effort medium \
  --timeout-ms 240000 --out RESULTS_DIRECTORY
bun evals/long_plan/run.ts --manifest CASES.json --json-ops --effort low \
  --brief-thinking --timeout-ms 240000 --out RESULTS_DIRECTORY
uv run --with matplotlib python evals/long_plan/thinking_plot.py SWEEP_DIRECTORY
```

The JSON-format sweep uses two independent repetitions of high, medium, low, and low with
brief-thinking guidance. Each repetition covers four frozen real conversations,
sixteen synthetic cases and the background-focus holdout: 99 checkpoints and
115 checks. It keeps the existing rubric fixed. The plot separates its 52
semantic checks from 63 structural checks, and breaks semantic results into
hierarchy/intent, foreground focus, setbacks/recovery and titles/constraints.
Quality is scored on the accepted state after validation; automatic corrections
such as suppressing passive focus or reopening a parent are counted separately.
Some are routine filtering of passive events in a grouped range, so this count
is not itself an error rate.
It counts every recorded attempt, including rejected patches and formatting
iterations. Thinking is a subset of output, and cache writes are uncached input.

These are the broader quality replay inputs, not the earlier 52 production-sized
windows; their absolute token totals should not be compared to that benchmark.
Up to four processes run concurrently, with submission order reversed for the
second repetition; the first high/low pair started earlier than medium/brief.
Latency is not compared. Whiskers show the two-run range, not a confidence interval. Each
condition starts new conversations; cache availability can still vary.
The interrupted 60-second-timeout pilot is retained separately under
`thinking-sweep/pilot-60s`; measured runs all allow 240 seconds per request.

Claude Code 2.1.319 does not turn off Haiku 5.5 thinking when given
`MAX_THINKING_TOKENS=0` or `alwaysThinkingEnabled: false`, even though the direct
Messages API supports disabled thinking at some effort levels. The eval uses
the same Claude Code path as production, so it does not label either setting as
"thinking off." See [Claude Code model configuration](https://code.claude.com/docs/en/model-config#extended-thinking)
and the [Haiku effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).


The completed sweep (2026-11-08) produced these per-replay means; quality counts
combine the two repetitions:

| Metric | High | Medium | Low (current) | Low + brief |
| --- | ---: | ---: | ---: | ---: |
| Uncached input | 420.2k | 342.4k | 320.6k | 321.4k |
| Cached input | 3,329.0k | 2,860.3k | 2,689.7k | 2,696.3k |
| Output, including thinking | 210.2k | 115.3k | 86.5k | 80.6k |
| Thinking, subset of output | 188.4k | 95.1k | 67.1k | 61.6k |
| Semantic checks | 98/104 | 102/104 | 102/104 | 104/104 |
| All checks | 224/230 | 228/230 | 228/230 | 230/230 |

All 792 checkpoint updates completed, with no rejected patches and no extra
provider formatting iterations. Low used 58.9% less output and 23.7% less
uncached input than high, with more semantic checks passing on this suite.
The brief prompt averaged 6.8% less output than ordinary low, while uncached
input and raw total tokens were essentially unchanged. Its output range
(79,475–81,695) overlaps ordinary low's (80,183–92,735), so two repetitions
do not establish a reliable small saving. Production remains at low; brief
guidance is an eval-only candidate.

The rubric was frozen for the sweep. Misses included resumed-episode grouping,
final-report focus, a stale TODO obscuring a failure, and naming/constraint
checks. Some naming checks use literal matchers, so small score differences
need interpretation. The full report, per-run CSV, failures and PNG/SVG/PDF
plots are under `evals/results/long-plan/thinking-sweep/`.

To capture a replay with terminal font shaping and box drawing:

```sh
bun tools/ghostty_screenshot.ts --size 116x24 -o /tmp/plan.png -- \
  bun evals/long_plan/capture.ts RUN_DIRECTORY CASE EVENT
bun evals/long_plan/run.ts --manifest evals/long_plan/focus_probe.json \
  --batch 4 --model claude:claude-haiku-5-5
```

## 2026-10-31 results

The new suite has 12 development conversations / 54 checks, plus three separate
Claude-format holdouts / 13 checks after the review addition below. They contain
no historical private text. A separate TODO-specificity probe adds seven checks.
Real replays cover three frozen Claude/Codex excerpts (213 normalized events),
including the previous rebase and stale-push cases and the review holdout.
Scanning 194 local Claude, 40 recent Codex and 28 Pi sessions found no TODO tool
calls. TODO coverage is therefore synthetic; no real TODO coverage is claimed.

| Run | Checks | Invalid/errors | Interpretation |
| --- | ---: | ---: | --- |
| Haiku development, v4 | 54/54 | 0 | All synthetic assertions passed |
| Haiku holdout, v4, reviewed rubric | 13/13 | 0 | Confirmed TODOs, recovered missing dependency, source error strings |
| Haiku TODO intent probe, full + production signals | 7/7 each | 0 | Specific future tasks survive both paths without invented work |
| Luna development, v3, reviewed rubric | 54/54 | 0 | Original report retains 53/54; corrected approach anchor below |
| Luna holdout, v4, reviewed rubric | 11/13 | 0 | Missed a dependency failure and recovery within one checkpoint |
| Luna real stale-push + review, v2 | 13/13 | 0 | Existing hierarchy/subtitle checks passed |
| Luna real rebase, v4 | 8/10 | 0 | Wrong episode continuity and a failed test labeled done |
| Luna production signals, stale-push, v4 | 4/7 | 0 | Coarse bounded snapshots lost context; 77.8% of tokens assigned |
| Haiku real conversations, v5 | 23/23 | 3 | Final hierarchy checks pass; three recovery patches needed validation retries |
| Haiku production signals, stale-push, v5 | 7/7 | 0 | Current bounded outcome history; different model/revision from Luna |
| Haiku production signals, holdout, v5, reviewed rubric | 12/13 | 0 | Retained the resolved bump but merged the failed attempt with the successful retry |

Development latencies were 3.03s mean / 3.84s p95 for Luna and 5.30s mean /
10.29s p95 for Haiku, each over 30 updates. These include harness overhead;
concurrent runs and different prompt revisions prevent a controlled ranking.
Luna consumed 227,065 input (137,600 cached) + 5,487 output inference tokens;
Haiku consumed 171,110 input (99,327 cached) + 22,903 output. These are summarizer
costs, separate from the historical agent's usage.

Haiku's real replays took 32 updates, 7.94s mean / 16.21s p95, and consumed
384,038 input (49,287 cached) + 42,119 output inference tokens. The bounded
stale-push replay took six updates, 5.03s mean / 7.13s p95, consuming 34,454 input
(4,043 cached) + 4,477 output. Neither is a controlled latency comparison.

Earlier v1/v2 failures are retained under ignored `evals/results/long-plan/`.
They exposed planned steps receiving work spans, an unrelated README edit
entering a failed-test episode, and forgotten recovery updates. The approach
probe was clarified to describe an actual discarded rewrite. Its first anchor
pointed to the successful trace command; it now points to the explicit course
correction. Luna's original failed report is unchanged; `review.json` records
the revised scorer. No historical expectations were loosened.

Manual review also found an omission in the holdout rubric: a resolved bump
could pass while its original failed build was labeled done. A thirteenth check
now requires the failed attempt to remain failed. The full-transcript Haiku run
passes it; the production-signal run fails it. Original 12-check reports remain
unchanged; reviewed scorecards and the browser show the stronger result.

Release blockers remain: preserve failed attempts when failure and recovery
arrive together, keep episode identity through follow-ups, and retain enough
live evidence to match full replay quality. That evaluation used the opt-in
preview; the integration is now the default activity updater.
The earlier pilot below remains historical context, not the current scorecard.

## Product contract

The tree displays two levels, one line per item except for setback explanations. The **goal**, the user's outcome
retained across turns and compactions, stays in the header as context.

- **Episode:** one coherent subproblem, such as repairing branch history or
  getting macOS CI to build. Reading, editing, testing, retries and committing
  can all belong to one episode.
- **Step:** a meaningful activity within that episode. Repeated commands and
  polling do not each need a row. Failed attempts remain visible.

The title names the work. The subtitle carries a defining constraint, finding,
approach or outcome. A commit should not replace a useful explanation of a shell
startup bug with commit-message bookkeeping. An agent's stated intent and visible
reasoning can inform that explanation; the UI does not reproduce raw reasoning
or claim access to unavailable reasoning.

An explicit rebase/squash sequence deserves a Git episode. A routine `git diff`
while implementing a feature belongs to that feature. “Again”, “fix it”, “commit”,
an interruption or a status question does not automatically create a goal.
Returning to an episode preserves its identity; a new attempt can add a step.
Only explicitly announced future work becomes a planned step, with no tokens yet.

Steps use one indentation level. Rows align tokens, tool calls and cached input
in columns; narrow terminals prioritize names and tokens. The view follows the
latest rows, retaining the parent episode when the tail cuts into its steps.
A setback and its explanation stay together when fitting the available lines.
There is no selection, scrolling or detail pane. The footer totals cover all
observed work, not just the visible tail. Replay controls belong to the eval,
not to the live product. The planner retains goal
identity internally so changing this presentation does not rewrite history.

## Signals and accounting

`history.ts` reads local Claude JSONL transcripts and Codex rollouts without
executing any recorded commands. It preserves source lines and ordered event IDs.
The model sees user steering, assistant updates, concrete tool arguments and
results, explicit plan tools, available plaintext reasoning, task notices and
lifecycle events. Opaque reasoning remains unavailable. Long records retain a
head and tail, marked as excerpts, up to roughly 1,800 characters per event.
Repository instructions inside transcripts are evidence, never eval instructions.

| Signal | Useful for | Limit |
| --- | --- | --- |
| User request and steering | Goal continuity and changes of scope | A request does not prove work started |
| Assistant updates | Immediate intent, findings and approach | Can become stale or overstate success |
| Tool arguments and results | Actual work, boundaries, failures, verification | Long output is excerpted; images are not interpreted |
| Explicit plans | Pending work and announced decomposition | Plans can become stale; this pilot has no real plan-tool examples |
| Plaintext reasoning | An intended approach before a tool makes it obvious | Provider-dependent, sensitive and sometimes absent |
| Task notices and lifecycle | Background work, interruption, compaction | A transport completion is not a successful goal |
| Usage receipts | Recorded consumption | Episode attribution is approximate, not per-token semantic ownership |

Usage is deterministic code, never generated by the summarizer:

- Codex response receipts are deduplicated by response ID. When those are present,
  the duplicate cumulative `token_count` transport is ignored. Legacy rollouts use
  cumulative deltas, exclude an opening historical baseline and flag counter resets.
- Claude receipts use message ID and component-wise high-water counts. A thinking
  block can report usage before its tool block. Those records are joined to the
  same response's first concrete action; before it is observed, usage is unassigned.
- Input includes cache reads and cache creation. Cached input is a subset of input,
  not a third additive charge. Output already includes reasoning output. All
  counters use bigint internally and decimal strings in eval files.
- Each receipt belongs to at most one step. Parent totals sum descendant usage.
  Unassigned usage stays visible and participates in the conservation check.
  A response that spans multiple steps cannot be divided exactly from these logs.
- Parent transcripts exclude child-agent usage. Forked Codex histories are rejected
  until an ownership filter is supplied; copied history must not be charged twice.
  Do not interpret these totals as team totals or dollar cost.

Hook timing, terminal-only approval state, a historical live Git snapshot and
external process state cannot be reconstructed reliably from these files. Tool
results provide some of that evidence, but the eval does not invent missing signals.

## Replay contract

`plan.ts` defines the experimental prompt, JSON schema and atomic reducer. Each
inference receives the previous tree, short excerpts supporting that tree, and
only the next prefix of events. There is no full-transcript hindsight and no
hidden model conversation carrying an unbounded history.

The model returns node upserts and an ordered partition of the new event range
into step assignments. IDs and parentage are stable; existing nodes cannot be
deleted or moved. New parents precede children. Evidence references must point
into the observed prefix. Coverage gaps, overlaps, future evidence, invalid
hierarchies and work assigned to a planned step reject the entire patch.
Sparse evidence may remain unassigned. A failed patch gets one explicit correction
attempt, but the invalid attempt still fails the run and its output is retained.

The cadence is deterministic: cut before a user message, after the first concrete
tool/plan of a turn, at turn completion, or after 24 events. The early checkpoint
tests recognition when an episode starts. This is an offline comparison cadence,
not the production worker's eight-second scheduler. Production would coalesce
tool noise and update at meaningful boundaries; measure that separately.

All nodes are retained in this prototype. Model input grows with tree size and
support excerpts; no memory or latency bound for day-long use is claimed. The
production design needs durable archived episodes and a bounded inference index
that can retrieve an old episode when work resumes. Do not silently drop old
nodes to meet a context limit.

## Dataset and rubric

Keep frozen source snapshots, manifests, transcripts and reports under ignored
`evals/results/` or outside the checkout. Do not check historical chats into public
fixtures. The renderer also writes only to ignored `.lavish/`.

The first pilot uses six development conversations, three from each provider:
rebase/conflict/test recovery, CI setup and branch repair, an interactive review
feature, stale push-retry repair, native cleanup and terminal-image debugging.
Four are development cases; the review and image cases were withheld from prompt
tuning. Some are deliberate prefix excerpts. A separate complete CI stress replay
spans more than six hours, including the repeated build/test repairs after the
Git episode. It shares a conversation with a development case and is **not an
independent holdout**.

Before calling a model, annotate event anchors and broad expectations. Use pairwise
relationships rather than one supposedly perfect tree: these actions must share
an episode, those actions must be separate, and a continuation must retain its
goal. Give recognition a prefix deadline. Topic expressions check broad naming
and subtitle facts, not exact prose. They can reject a reasonable synonym, so
review failures rather than loosening a regex until a model passes.

Every run checks complete replay, exact token conservation and consistency between
parent completion and child states. Case checks cover grouping, goal continuity,
topic/subtitle facts and states at selected prefixes. Reports also track row count,
title churn, rewrites of closed nodes, assigned usage, inference tokens and latency.
Invalid outputs, missing results and inference failures are failures.

Automated checks cannot prove that a hierarchy or subtitle is sensible. For each
frozen case, review the early, middle and final tree with source evidence:

| Dimension | Accept | Reject |
| --- | --- | --- |
| Grouping | Episodes explain subproblems and contain related attempts | One row per command; one giant episode hiding distinct subproblems |
| Titles | Concrete names that distinguish siblings | Generic “working” or obsolete diagnosis-only titles after a repair |
| Subtitles | Add a supported constraint, finding or outcome | Repeat the title, hallucinate intent, or lose the cause after a commit |
| Continuity | Stable IDs across follow-ups and compaction | Restart the goal on “again”; erase a failed attempt |
| Status | Success has evidence; unfinished children remain unfinished | Call failed tests done; mark a parent done with active children |
| Tokens | Conserved receipts, explicit cache and missing-data semantics | Double-count cache, cloned history or subagents; guess a precise split |

Require all hard checks and no unsupported completion/intent claim before enabling
the feature. For a broader quality decision, expand to at least 12 independent
conversations per provider, include explicit plan changes, compaction, sparse and
approval-only turns, canceled/abandoned work, delegation with owned usage, and
several episode revisits. Split by conversation family (including forks), not by
nearby excerpts. Run at least three repeats. Record human rubric decisions beside
the evidence; the current pilot is too small for a model ranking.

## Commands

A private manifest is an array of cases. `source` points to a frozen JSONL file;
`through_line` optionally selects a prefix before normalization. Example shape:

```json
[
  {
    "id": "branch-repair",
    "provider": "claude",
    "source": "/private/evals/branch-repair.jsonl",
    "split": "development",
    "checks": [
      {"name": "Rebase and squash stay together", "kind": "same_episode", "a": 12, "b": 30},
      {"name": "Recognize repair early", "kind": "topic", "event": 12, "at": 12,
       "level": "episode", "pattern": "branch|rebas|histor"}
    ]
  }
]
```

```sh
# Inspect normalized events and receipts before annotating anchors.
bun evals/long_plan/run.ts --manifest /private/cases.json --prepare --out evals/results/plan-data

# Calls the existing tool-free production inference harness and consumes model usage.
bun evals/long_plan/run.ts --manifest /private/cases.json --model codex:gpt-6-luna --out evals/results/plan-luna
bun evals/long_plan/run.ts --manifest /private/cases.json --model claude:claude-haiku-5-5 --out evals/results/plan-haiku

# Focused controls; --case and --batch are also available.
bun evals/long_plan/run.ts --manifest /private/cases.json --flat
bun evals/long_plan/run.ts --manifest /private/cases.json --ablation no-reasoning
# Other ablations: no-plans, tools-only. Removed signals stay removed in support excerpts.

bun evals/long_plan/report.ts /private/cases.json evals/results/plan-luna
bun evals/long_plan/view.ts evals/results/plan-luna
# Open .lavish/long-plan.html directly, or use Lavish for a design review.

bun test evals
```

`--flat` uses the production phase prompt, parser, turn reset and bounded phase
memory, with reconstructed evidence clipped to its 2048-byte bound. It is a prompt
baseline, not a reproduction of production hook timing or the capped 16-row UI.
Its synthetic root is not evidence of a successful goal summary.

The runner writes source hashes, exact inputs/outputs, per-attempt usage, elapsed
time, prefix trees and checks. `report.ts` creates a readable scorecard and a new
`review.json` with the current scorer hash, retaining the original report.
`--refresh-usage` recomputes receipts after an importer correction only if source
events exactly match the recorded evidence; it saves a separate accounted history
and records the accounting hash. It never reruns or edits the model's labels.
The UI uses accounted history when present and computes totals at each prefix.

## Findings from the first pilot

Both models completed the same six case excerpts and recognized the CI branch
repair at its first work checkpoint. In the initial full-signal run, Luna scored
39/44 assertions with one invalid attempt; Haiku scored 41/44 with no invalid
attempts. These counts include the added parent/child consistency check. Neither
run meets the acceptance gate. Private reports preserve all failures.

The CI case passed 9/9 with hierarchy on both models; an earlier turn-aware flat-prompt
control passed 6/9. A follow-up control, after also matching the bounded evidence
in phase memory, timed out before completion; that failure is retained. The
no-reasoning CI probe passed 7/9 with one invalid attempt,
but one run does not establish the value of reasoning: nondeterminism is a
confounder, and there are no real plan-tool examples in this pilot.

The runs exposed three substantive issues: parent completion can contradict
unfinished children, episode subtitles can lose the technical cause after a
commit, and generating a final report can be left unassigned. A prompt follow-up
retained the cause and assigned all usage in the rebase case, but still failed
parent/child consistency. The next implementation should make parent status a
checked aggregate and keep the episode's defining fact separate from transient
step updates. Do not ship the candidate by hiding these failures.

Across 79 updates per model, observed mean latency was 3.36 seconds for Luna and
7.75 seconds for Haiku, including harness overhead and retries. They ran
concurrently, so this is descriptive, not a controlled speed comparison.
Luna consumed about 0.99 million inference input-plus-output tokens and Haiku
about 1.12 million; these are the summarizer's costs, separate from the historical
work's consumption. Rebuilding full tree context each time is still expensive.

The complete CI stress case contains 579 events and 183 tool calls over six hours
and 37 minutes, with 30.30 million recorded input-plus-output tokens. The initial
candidate collapsed most repair work into one episode. Adding distinct-blocker
probes and tightening the episode rule produced seven episodes and 58 steps,
recognized the branch repair at its start, and assigned 99.74% of recorded usage.
It scored 12/13 hard checks; parent completion still contradicted unfinished
children at some intermediate checkpoints. The broad integration-failure episode
also needs human review for further useful subdivision. This is a development
stress result, not an additional independent holdout pass.

The design artifacts use Corgi's palette and termhtml rather than a separate UI
theme. Browser checks cover normal/narrow/mobile layouts, replay and row
interaction. They do not substitute for terminal integration tests once a live
viewer implementation exists. No saved-format or wire version changed: all new
data structures currently belong only to the eval.
