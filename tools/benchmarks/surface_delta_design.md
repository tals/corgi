# Canonical row deltas: source audit, not an implementation

The current producer retains formatted rows but still duplicates all row bytes
into an owned `Surface`, serializes them into native JSON, decodes them in Bun,
then serializes the complete `View` for the viewer. The viewer compares those
row strings and feeds only changed rows into its native mirror. Relevant code:

- `native/zig/pane/surface_rows.zig`: one lazy row cache per terminal.
- `native/zig/pane/surface.zig:21`: owned full capture; `captureView` borrows and
  restores independent viewports.
- `native/zig/pane/terminal.zig:433`: completed render damage invalidates rows
  before clearing Ghostty's dirty flags.
- `src/viewer_protocol.ts:163`: known-receipt check followed by full capture.
- `src/mirror.ts:188`: full wire view becomes sparse native row installation.

The v9 diagnostic saw approximately 183 KB/s of viewer JSON at 20.5 replies/s,
including metadata. Native surface capture used 0.363% of elapsed daemon main
thread time, and viewer wire decode used 0.182%. These are older diagnostic
measurements, not the cost of v11 or an attainable saving. Fresh v11 attribution
should decide whether this protocol change is the next priority.

## Recommended native contract if pursued

Keep the existing full capture as a reference and public `pane.surface` result.
Add a synchronous operation equivalent to:

```ts
type Receipt = Stamp & { rows_revision: bigint | null };
type Update =
  | { kind: "full"; view: View & { stamp: Receipt } }
  | {
      kind: "rows";
      base: Receipt;
      stamp: Receipt;
      pane: number;
      cols: number;
      rows: number;
      changed: { row: number; text: string }[];
      cursor: Surface["cursor"];
      images: Surface["images"];
      bottom: number;
      offset: number;
      modes: Modes;
    };

surfaceDelta(pane: number, offset: number | null, since: Receipt | null): Update;
```

This is a proposed API shape, not code that currently exists. Keep first support
to the active, unselected viewport outside a pending synchronized redraw. Other
viewports and uncertain state use the existing full capture. Cursor, modes,
scrollback position and image placements remain complete metadata on every
returned update. A modes-only update can carry zero changed rows.

The cache owns a monotonically increasing generation, a `full_since` reset
generation, and one last-formatted generation per row: 376 additional row bytes
plus two scalar counters for 47 rows, independent of viewer count. When a
capture must format invalid rows, advance the generation
once and assign it to each successfully formatted row. Every capture path uses
this shared formatting operation, including legacy full captures. A request
with generation `g` returns current bytes of every row whose generation is
greater than `g`. Intermediate captures never consume another client's damage.
Conservative dirty rows may produce unchanged bytes; this first version need
not compare or hash the formatted strings.

Use a separate row-cache generation rather than pretending terminal revision is
the cache's revision. `surface_revision` advances on feed, resize, theme and
pixel size, while viewport borrowing, selection and cache pane-ID changes can
invalidate/reformat rows without advancing it. Reusing terminal revision is
possible with a retained reset revision and conservative full fallback at or
before every ambiguous reset, but that couples more invariants and can cause
extra full frames. A row-generation receipt makes the ownership explicit.

The generation must survive cache reallocation, key changes and capacity reuse.
Full invalidation records a pending reset; the next formatting generation sets
`full_since`. Return a full response when the client's generation predates that
boundary. This handles dimensions, pane-ID changes and borrowed viewport
restoration even if another client already formatted the new shape. Without
this boundary, a row generation alone cannot identify the client's dimensions.
New terminals already have a different `surface_identity`. Unknown, future or
invalid generation receipts force a full response. Generation wrap must reset
delta eligibility or rotate its identity; it cannot silently reuse an older
receipt value.

No new per-client native object or stored row copy is necessary. Each client
continues to supply the receipt it actually installed. Returning selected rows
as caller-owned bytes is the smallest lifetime-safe first implementation: it
copies only those rows, then the existing native JSON result encodes only those
rows. A synchronous writer could later serialize borrowed cache rows directly,
but must finish before viewport restoration or any other terminal operation;
borrowed slices must never escape into Bun or replace the full owned snapshot
contract. A custom wire encoder is unnecessary.

## Receiver and failure rules

The receiver applies a patch only when `base` exactly equals its installed
receipt and pane identity, dimensions and requested viewport agree. Validate
all row indices, duplicates and metadata before touching the native terminal.
It can reuse existing `viewer_receive_frame` with an explicit dirty-row array.
To preserve old captured objects, create a new row-reference array and replace
only changed strings; a 47-row array copies about 376 bytes of references, not
the unchanged UTF-8 payloads.

If the base or shape does not match, leave the old display intact, clear `known`
and request a full surface. Never acknowledge an unapplied response. Holding a
selection therefore needs no special server history: the old receipt remains
known and the next accepted patch includes every row changed since then.
If native installation fails after modifying state, clear the receipt and use
a full reset before any further patch.

Specific correctness cases:

- Two clients at different generations, several updates before presentation,
  and a dropped/unapplied response all receive the latest changed rows.
- Resize, replacement, terminal restore and daemon handoff force full frames.
  Row-cache metadata is derived and is not persisted.
- Borrowed scrollback capture and restoration invalidate the shared cache.
  Returning to the active viewport re-formats all affected rows; the first
  implementation falls back to full for the borrowed viewport itself.
- Theme, reverse colors, selection and alternate screens keep the existing
  conservative invalidation. Previous/current links still invalidate all rows:
  automatic link IDs depend on flattened UTF-8 offsets across earlier rows.
  Links therefore may erase the sparse-row saving, without breaking correctness.
- A pending synchronized redraw returns the existing completed full frame.
  Release/timeout increments terminal revision and publishes the held damage.
- Restored ghost screens still take input modes from the live terminal, as
  `viewer_protocol.sync` currently does.
- Format/allocation/serialization failure must not advance a client's receipt.
  Partially formatted cache rows keep their generations and invalid rows retry;
  a subsequent capture still includes everything newer than the old receipt.

## Protocol compatibility

The simplest deployment changes viewer protocol 3 to 4 because `surfaces` now
contains a new representation and receipt semantics. Both
`src/viewer_version.ts` and `protocol.viewer_version` must agree. Runtime and
management protocol versions, checkpoints and native terminal snapshots need
not change solely for this derived representation. Existing saved client
interests need a default `rows_revision: null`, and native restore invalidates
all delta receipts. Older viewers fail the existing explicit version check
instead of interpreting row patches as complete frames.

If maintaining old viewer attachment is required, a capability advertised by
`viewer.open` and explicitly requested by `viewer.sync` can preserve protocol 3:
old or non-opted-in clients receive only the old full shape. This adds a real
compatibility matrix and should be chosen deliberately, not implemented as an
implicit fallback. Full frames remain necessary for resynchronization in either
version scheme.

## Comparison with a Bun-only baseline

A smaller prototype keeps the last sent full `View` per client/pane, compares
47 strings, and sends different rows only when the request's known receipt
equals that retained baseline. A mismatch sends a full view. It needs no new
native generations and can suppress byte-identical rows even when native damage
is conservative. It is an attractive isolated test of wire/decode savings.

It does retain an encoded screen and row objects for each client/pane and still
pays the full native snapshot copies, native JSON serialization and Bun decode
on every update. Keeping only the last sent view also means an ignored response
forces the next response to be full. The native generation approach carries
accumulated changes for arbitrarily delayed clients with bounded per-terminal
metadata and removes both serialization boundaries' unchanged row payloads.

Neither approach helps full scrolling frames much, and row patches do not reach
Herdr's cell-span granularity for isolated edits within a long row. First compare
sparse, cursor-only, scrolling, styled/link, independent viewport and two-viewer
cases against the full-view reference. Report native result bytes, wire bytes,
formatted/sent rows, retained memory and whole-process CPU, not just encoding
microseconds. A 47-to-1 row count is a payload opportunity, not a 47-fold CPU
speedup.

## Isolated wire prototype

`tools/benchmarks/surface_delta_costs.ts` implements the Bun-only comparison in a
benchmark file. It does not change either protocol or the native capture API.
The sender keeps one last-sent full `View` per client; the receiver applies a
patch only against its installed receipt. A dropped or selection-held response
forces the next sender response to be full. Independent clients keep independent
baselines. This deliberately measures the simpler prototype before introducing
native row generations.

The corpus consists of actual 132-by-47 canonical captures: a styled Unicode
screen with sparse edits cycling over three rows, cursor-only changes, scrolling,
explicit and automatic links, and input-mode changes. A real 160-by-48 Controller
has sixteen idle pane entries, one visible pane, and disabled decoration
animation. Both methods use the production JSON codec and production
`Mirror.receive`, so the full-view baseline already installs only changed native
rows. There is no artificially expensive full native replay baseline.

Three separate measurements distinguish the removable work:

- `codec`: construct/compare the message, stringify, create a UTF-8 buffer,
  decode/revive, normalize and reconstruct the view.
- `viewer`: decode pre-encoded UTF-8 messages, reconstruct, install with the real
  mirror, then run Controller composition and the native differ.
- `combined`: sender construction/encoding followed by the complete viewer path.

Native feed/capture, socket syscalls, asynchronous image transfers, metadata RPCs,
provider work and real timer wakeups are excluded. Capture is completed before
all timed loops and is common to both methods. The native generation proposal
could also remove capture copies/serialization, but this benchmark cannot claim
that saving. The separate `surface_capture_costs.ts` harness measures capture.

Untimed verification compares reconstructed Views, styled native rows, cursor,
links, input modes, image metadata, differential ANSI output and the final host
surface. Separate checks cover delayed independent viewers with accumulated
three-row changes, dropped responses, multiple updates before presentation,
selection holds, malformed row indices/duplicates without partial mutation,
independent scrollback viewports, dimensions, replacement identity, shortened
wide text, selected captures, synchronized output, alternate screens, and actual
Kitty pixel upload/placement/removal commands. The image transfer path remains
unchanged and its identical bytes are checked separately from timed text cases.

Each trial creates a fresh viewer fixture and warms it. Full/delta order
alternates across trials, with `--reverse` inverting the first order. The bounded
64-frame corpus restarts with a full response when its revision sequence wraps;
this adds one full frame per 64 updates to the delta result. The same boundary is
used for pre-encoded messages. Report this amortization rather than presenting
the row-patch-only best case.

The output records user/system CPU and wall microseconds per frame, wire bytes,
decoded row-string counts/UTF-8 bytes, reconstructed row-reference counts, and
the sender's maximum retained row UTF-8 payload. Those last quantities are
workload and retention proxies, not allocation counters or RSS. Ordinary runtime
GC remains enabled; CPU includes any GC during the measurement, but this is not
a causal estimate of GC cost and collection can cross trial boundaries. No
forced collection is used. Keep external process/SMT/NUMA guards and raw trial
order when measuring; do not convert a byte reduction directly into CPU saved.

Run only in the exclusive benchmark slot, against a frozen source/native pair:

```sh
bun tools/benchmarks/surface_delta_costs.ts --verify-only
SURFACE_DELTA_ITERATIONS=512 SURFACE_DELTA_TRIALS=4 \
  bun tools/benchmarks/surface_delta_costs.ts
```

The tool acquires the shared CPU lock, records its sources and native-library
hash, and refuses enabled application telemetry. External scheduling supplies
fixed CPU placement, memory policy and interference measurements. The first
frozen V16 correctness and timing run is documented in
`surface_delta_findings.md`; its archived design copy preserves the original
prospective plan.
