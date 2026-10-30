# Resource worker state ownership audit

The worker is persistent, but its Tracker is reconstructed for each sample.
The daemon sends the previous readings, host counters, alarm state and complete
workspace history into it, then receives those categories back in the next
Batch. This repeats at 0.5 Hz normally and 1 Hz with resource detail open.
Keeping sampling state in that existing worker is a real data-movement
opportunity. Its current whole-application size and CPU cost have not been
measured by this audit.

Sources are `src/trackers/resources.ts` (`SampleRequest`, `restoreSnapshot`,
`restoreBatch`, `Tracker.tick`, `sample`, `stop`) and
`src/trackers/resources_worker.ts`. The worker's GPU Sampler already survives
requests; its driver, utilization timestamps and held-process cache do not get
recreated with the Tracker.

## What moves today

The request contains `roots`, workspace IDs, an origins Map, `batch`, `current`,
the interval and the sample time. Each root has eight fields: key, PID, start,
workspace, detected agent PID, provider, pane and headless session. Each origin
maps a root key to its PID and start time.

`batch` contains four categories:

- `view`: the published Snapshot, including all workspace process details and
  all history buckets, even when no viewer has the resource detail card open.
- `readings`: one record per successfully sampled owned process, including its
  PID/workspace/start/time and five native counters. This is not capped to the
  displayed process-leader list.
- `host`: five host counter/metadata fields for the next rate calculation.
- `health`: each workspace's CPU alarm and GPU visibility hold state.

The reply is `{pending: Batch, origins: Map}`. The main thread restores class
instances, then its next tick validates that the sampled roots still belong to
the same live panes/sessions/workspaces before publishing the result.

After a normal accepted result, `batch.view === current`. Structured clone
preserves aliases, so the request does **not** clone two independent copies of
the snapshot graph. The avoidable duplicate is in the receiving worker:
`restoreBatch(request.batch)` restores its view and then
`restoreSnapshot(request.current)` walks the same cloned snapshot again. A
third restoration happens when the main thread receives the result.

Each snapshot restoration constructs a new Snapshot, Work per workspace,
Process per current process and per history-process reference, and new history
point/array objects. Process constructors also allocate an empty GPU-device
array before Object.assign replaces it with the incoming array. Rehydration
does not preserve aliases between a current process and a history leader that
refers to the same process object. No JSON conversion is needed here: structured
clone already carries bigint and Map.

`Snapshot.forViewer(detail)` removes histories and process details for other
workspaces only at the viewer-response boundary. It does not reduce either
worker message. The current full detail list is capped at 64 processes per
workspace; history has 48 five-second buckets. Each bucket keeps up to five
leaders per CPU/memory/I/O/GPU/GPU-memory figure and two per device utilization
and memory figure, deduplicated by process. The general per-bucket bound is
25 + 4 × device count, often much smaller when leader sets overlap. Without
GPU metrics, only the CPU/memory/I/O figures can contribute leaders. Thus the
cost scales with mature workspace histories, not simply visible terminal count.

## Existing evidence and size proxies

The archived `observation_costs.ts` fixture already compares two structured
clones plus rehydration with retaining the old state and sending only roots and
options. It returns the same full output in both cases and checks equivalence.
It excludes OS sampling and real worker scheduling; it is not a worker
implementation or current V16 attribution.

| Archived synthetic shape | Process references per Snapshot | History points | Process constructions in three restorations/sample |
| --- | ---: | ---: | ---: |
| 1 workspace, 16 current processes, 48 buckets × 5 leaders | 256 | 48 | 768 |
| 8 workspaces, 8 current processes each, 48 buckets × 5 leaders | 1,984 | 384 | 5,952 |

The first shape also has sixteen roots, sixteen origins and sixteen readings;
the second has sixty-four of each. A Process has fourteen own fields. These
counts describe object/property traversal, not allocation bytes or structured
clone's internal byte encoding. The stored artifacts have no measured worker
message byte size; claiming a precise serialized size from them would be
unsupported. Real graph aliasing may also reduce cloned node counts without
reducing the restoration loops.

Archived CPU medians from `dist/observation-costs/micro-node{0,1}.json`:

| Shape | Existing roundtrip, node 0 / node 1 | Retained request state, node 0 / node 1 |
| --- | ---: | ---: |
| 1 workspace / 16 processes | 1.162 / 1.146 ms | 0.535 / 0.522 ms |
| 8 workspaces / 8 processes | 8.841 / 8.400 ms | 3.999 / 3.836 ms |

The average-node differences model approximately 0.031 and 0.235 percentage
points of one core at one sample every two seconds, respectively. They are
older synthetic transport estimates with fully mature history and five
historical leaders per bucket. They are not measurements of the current daemon,
and allocation lifetimes, GC and actual leader/history counts can change the
result. The old harness forced GC before each timing sample; that methodology
must remain explicit rather than treating these values as ordinary app GC.

## Smallest conservative ownership change

Keep one Tracker in `resources_worker.ts`. For a first step, keep returning the
same full Batch as a main-thread restart checkpoint; eliminate the recurring
request-side Batch/current/origins transfer and worker-side restoration. This
matches the archived experiment while leaving the public Snapshot and resource
viewer payload unchanged. The daemon still retains a published copy, so this
first step reduces copying rather than eliminating every duplicate retained
object.

Normal requests need roots, workspace IDs, interval, time, a monotonically
increasing request ID, and the previously accepted result ID. A first request or
worker restart may additionally seed the last accepted Batch and current
origins once. The daemon already allows only one outstanding sample, so there
is no need for a general queue or concurrent sampling engine.

The acceptance receipt is necessary. A successful worker computation is not
automatically accepted: the main thread may reject it after a pane closes,
moves workspace or changes owner. The worker must retain committed and pending
batches. On the next request, commit the matching accepted pending batch or
discard it; then sample from the committed baseline. Merely setting
`tracker.batch = tracker.pending` immediately after posting would change rates,
history and alarms after rejected samples.

Only a small part of the old baseline needs copying within the worker:
`sample()` mutates the Alarm and Hold objects taken from `batch.health`.
Copy those per-attempt states before sampling so a failed or rejected result
cannot mutate the committed alarms. Readings are read-only, and history recording
builds new arrays/points while reusing older completed points; those can remain
worker-owned without a full graph clone.

Origins have different acceptance semantics from Batch. Today the daemon
installs returned origins as soon as a successful worker reply arrives, even
if it later rejects the Batch's workspace ownership. A failed sample returns
no origins. Retaining origins must preserve this distinction: work on a small
Map copy per attempt, keep it on successful computation, discard it on failure.
The GPU Sampler's timestamps and held-client cache already survive failed or
rejected computations; do not silently roll those back with the Batch.

On failure, preserve the existing main-thread empty pending Snapshot, timestamp
and interval behavior. Mark the worker baseline unsynchronized and seed it once
on the next request from whatever Batch the main thread actually accepted.
On a worker crash, capture the specific worker generation in handlers so an old
error/reply cannot complete a new request. A request ID plus worker generation
is sufficient; no object hash or recurring serialization is needed.

`stop()` currently waits for any in-flight result, closes the GPU source, clears
the sampled Batch/Snapshot and cadence state, but retains origins. Its worker
message must also clear committed/pending sampling state while preserving that
origins behavior. `close()` terminates the worker and clears origins. Keep the
main thread's publication validation and `runtime.refreshed()` scheduling in
the current tick; receipt arrival should not publish by itself.

## Handoff and tests

Resource state is not in `persist/checkpoint.capture` or the handoff manifest.
A replacement Runtime constructs a new Tracker today, so a successful reload
already resets resource counters/history. A persistent worker does not require
a saved-format migration or a new resource-state export merely to preserve
current behavior. The old daemon's pause leaves its worker/pending result alive;
rollback resumes the existing Tracker, whereas successful shutdown terminates
it. Preserve those lifecycle boundaries.

Before adopting the change, test accepted samples, rejected ownership followed
by a later accepted sample, failed sampling after alarm mutation, origin/PID
reuse behavior, detailed-cadence changes, stop/restart, worker death and delayed
old-generation replies. Extend the existing worker test beyond checking that
the rejected sample is not displayed: assert that it never enters the next
accepted rate/history/alarm baseline. Compare a long deterministic sample
sequence against the current implementation, then measure real worker message
shapes and CPU with mature histories. No production change or new measurement
was made for this source audit.
