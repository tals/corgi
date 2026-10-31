# Native PTY ownership: production boundary audit

Source-only audit. No production changes, builds or tests were performed for
this document. The benchmark actor establishes component evidence, not a safe
production API by itself.

The smallest credible integration keeps policy in Bun, places synchronization
behind native entrypoints, and lets one native read owner feed the existing
Terminal. It does not require a second terminal representation, a command
framework, or cell hashing. Its remaining complexity is lifecycle coordination:
safe detach, input-interest refresh, stale events, and borrowed data.

## Exact sources

Ghostty is the worktree-local package
`native/zig-pkg/ghostty-1.3.2-dev-5UdBC38HeAVpINLn9qneWgPWYKcX8WZ_8w2DZosk5XcB`,
matching `native/build.zig.zon:7–9` and commit
`f523504ea5c9f41d150d1eb93cc7a748b90f9361`. Ghostty paths below are relative
to that package. The similarly named expanded global Zig cache is a different
package and is not the source of these conclusions.

Herdr references are relative to
`/home/t/dev/personal/herdr-cpu-benchmark/source`.

## Shared-state audit

| State | Source evidence | Required treatment |
| --- | --- | --- |
| PNG callback | Ghostty `src/terminal/sys.zig:18`; Corgi `native/zig/pane/terminal.zig:83` assigns it on every creation | Initialize once before any actor starts. Later terminal creation must not rewrite it while another terminal decodes an image. |
| Secure-random callback | Ghostty `src/terminal/sys.zig:65–75` has a global optional override | Corgi leaves it null and uses its IO implementation. Keep overrides immutable after startup. |
| Image generations | Ghostty `src/terminal/kitty/graphics_storage.zig:32–66` uses atomic u64 on this target, mutex fallback on smaller targets | Already synchronized; no Corgi-wide image lock needed for this counter. |
| Unsupported-input log dedupe | Ghostty `src/terminal/stream.zig:3097–3120` uses atomic loads/CAS | Already synchronized. Corgi's own `native/bridge.zig:11–22` log-enable boolean must be startup-only or atomic if runtime toggles remain possible. |
| PNG decoder buffers | Ghostty `pkg/wuffs/src/png.zig:13–130` allocates decoder, destination and work storage per call | No shared scratch in this wrapper. Still test simultaneous image decode/creation; this audit is not a complete proof of the vendored C decoder. |
| Terminal and parser allocation | `native/zig/os.zig:24` selects `std.heap.c_allocator`; the pinned Zig `std/heap.zig:139` delegates to libc allocation | Allocation/free can cross the two threads. Per-terminal arenas and containers still require the terminal lock; allocator safety does not protect their contents. |
| Process IO / randomness | `native/zig/os.zig:27–44`; pinned Zig `std/Io/Threaded.zig:1668–1691,16930–16964` | `init_single_threaded` disables IO concurrency creation; it does not remove internal mutexes. Foreign pthreads use the mutex-protected random fallback. Initialize/change the IO object only before actors start. |
| Links and search | `native/zig/pane/hyperlinks.zig:7–74` owns per-Terminal/per-call arenas; `terminal.zig:208` creates a search object over that terminal's pages | No shared compiled-regex cache in Corgi's link path. Hold the same terminal lock for link capture/search/page access. Ghostty's optional search thread is unavailable for the lib artifact (`src/terminal/search.zig:11–16`). |
| Rendering and surface row cache | `terminal.zig:429–449`, `surface_rows.zig`; `surface.captureView` temporarily changes/restores viewport | These are mutable derived state, not read-only getters. Protect the full capture/restore operation. |
| JSON response storage | `native/app_bridge.zig:30–45` uses a per-call arena and copies into the caller's output buffer; `src/native_bridge.ts:54–82` owns the Bun reply buffer | The native actor only feeds/flushes and must never use this JSON path. Bytes are independent after native copying; decoding can remain in Bun. |
| Viewer response storage | `native/viewer_bridge.zig:11–20` has process-global output | Keep these output operations on the Bun thread. The actor does not touch it; making it thread-local is unnecessary for this architecture. |

A source scan is not a blanket Ghostty thread-safety certification. The important
property is exclusive access to each Terminal, including its parser, render
state and owned snapshots. Shared immutable tables need no extra locks; mutable
global callbacks need one-time initialization. Graphics file loading is enabled
by Corgi. A small input read can trigger a larger decode or file read, so a
64 KiB input bound is not a bound on time spent inside feed or synchronous pause.
With one shared actor this can delay reads of other panes; do not claim the
isolation of Herdr's per-pane actors without measuring it.

## Native protection, with no lock choreography in Bun

Add the mutex/reader-registration state to the opaque native Terminal or its
native-owned wrapper. Actor callbacks acquire it and call internal **unlocked**
methods. FFI functions acquire it once at entry; internal `reply → send → flush`
must not recursively enter locked exports. Bun never holds a lock across await.

For mirrors without an attached reader, a main-thread-owned registration flag
can bypass the mutex. Attach/detach publication is synchronized before a worker
can use the object. This preserves the viewer's current single-thread ownership.
The immutable identity can remain an unlocked getter once lifetime is secured;
mutable revision and state getters cannot.

Concrete entrypoint coverage:

- `native/bridge.zig`: protect `terminal_resize`, `terminal_feed`,
  `terminal_send`, `terminal_pending`, `terminal_flush`, `terminal_tick`,
  `terminal_maintain`, `terminal_has_copied`, `terminal_surface_revision`,
  `terminal_title`, `terminal_surface_cache_stats`, `terminal_text`,
  `terminal_snapshot`, `terminal_recovery_snapshot`, and `terminal_live_text`.
  `terminal_bytes_free` operates on independent owned storage. `terminal_new`
  initializes privately before publication; `terminal_free` detaches first.
- `native/app_bridge.zig`: parse the request outside the lock if convenient,
  but protect `perform` through encoding/copying of any borrowed fields.
  `.info`, `.surface`, `.links`, `.image`, selection/search/history, paste,
  `.takeCopied`, `.takePending`, restore, redraw and maintenance all access
  protected state. `.stop` must detach before entering the ordinary lock.
  `app_terminal_fd` must reject or synchronously detach an active registration
  before replacing its descriptor; it is not a harmless scalar setter.
- `native/viewer_bridge.zig`: `viewer_receive`, `viewer_receive_frame`,
  `viewer_update_render`, `viewer_rows`, `viewer_cursor`, `viewer_mouse_event`,
  `viewer_mode`, `viewer_encode_key` when its handle is non-null, and
  `viewer_encode_mouse` inspect or mutate Terminal state. Their guard can be
  a no-op for mirror handles. Keep shared output assembly/copy on Bun.
  Handle-free paste helpers and `viewer_take` need no PTY-terminal lock.
- `native/frame_diff_bridge.zig:65–82`: `frame_diff_compose` borrows render
  state from several Terminal pointers for the whole synchronous composition.
  These are viewer mirrors today. Constrain actor attachment to daemon PTYs
  and explicitly reject actor-backed handles in this API if needed; do not
  add multi-terminal lock ordering to the viewer for a combination it never
  uses. Other host-differ operations are independently Bun-owned.

The PNG initialization and native entrypoint guards are not persisted fields
or policy. Reader registrations, mutexes and notification state must remain
derived runtime state, absent from saved/handoff schemas.

### Title result ownership

The current `terminal_title` returns a pointer into mutable VT title storage
(`native/bridge.zig:71–77`). Locking only the FFI call leaves a use-after-free
window during Bun's subsequent UTF-8 copy (`src/pane/terminal.ts:72–98`).

A small main-thread response buffer can preserve the current ABI: while holding
the terminal lock, copy title bytes and metadata into response-owned storage;
return that storage, valid until the next synchronous JS title call. The actor
never touches that response buffer. This is the same limited single-Bun-thread
contract as the existing viewer output buffer, without per-title allocations
after capacity growth. Allocation failure needs an explicit error convention;
it must not silently become a successful empty title.

Caller-owned scratch plus length/metadata is the other compact option and has
clearer ownership, but changes the signature and needs a grow/retry path. Either
is safer than asking every TypeScript getter to remember an external lock.

## Read ownership, input order and lifecycle

`src/pane/terminal.ts:198–219` currently reads the original PTY into Bun memory.
Once an actor is attached, that path must go away. Public `read()` and the
child-exit trailing-output read still need freshness: use a protected native
refresh/drain operation, serialized with the actor. Do not leave legacy
`terminal_tick` or JSON `.tick` as an uncoordinated second reader. A protected
manual drain and actor drain can share one logical owner because neither reads
outside the terminal lock and every consumed chunk is fed before releasing it.

`Terminal.feed` can generate replies (`terminal.zig:178–189`), and `send/flush`
share the pending-input array (`469–485`). Keep this one queue under the same
lock. Bun still decides what input to send and when to run sync expiry, prefill,
observations and checkpointing. Pending input requires native WRITE interest
refresh after both parser replies and Bun sends; stale callback interest must
not overwrite a newer request to watch WRITE. A control wake that re-reads
pending state under the terminal lock is simpler than racing two cached masks.

Attach, detach and free require a separate lifecycle barrier:

1. Disable the registration and remove readiness interest.
2. Wait synchronously for its in-flight read/feed callback to finish, without
   holding the terminal mutex that callback needs.
3. Reject any queued readiness receipt by an immutable registration token.
4. Only then close/replace the FD, destroy the Terminal, or capture the handoff.

Consumed bytes must always be fed even if stop races the read. No private unread
buffer survives the barrier. Pause leaves the original FD open; resume registers
the same FD with a new valid receipt. Handoff pauses every pane before manifest
capture (`src/persist/handoff.ts:164–177`). It must not require waiting for the
PTY to become quiet or introduce a new flood-related failure. The existing
pending-input drain/drop policy stays in Bun before the pause.

## Prefer extending the existing readiness owner

The benchmark's Linux epoll thread, ring queue, counters and injectors are not
the production implementation. `native/readiness.c` already has Linux epoll and
macOS kqueue branches and a notification transport. Prefer a small native-handler
registration on that owner, reusing its thread, kernel integration and batching:

- register a native drain callback and opaque Terminal context for a token;
- retain the existing JavaScript-readiness path for other descriptors;
- invoke native drain/feed without crossing Bun, then publish the same bounded
  notification records according to Bun-supplied wake interest;
- provide synchronous disable-and-wait detach plus a control wake for changed
  pending-write interest.

The callback registration needs an in-flight reference/acknowledgment. A mutex
around the registration table alone is insufficient: never hold that table
mutex while invoking a callback that needs the terminal mutex, and never wait
for detach while holding the terminal mutex. Queued kernel events must carry
tokens, not dereference freed context pointers. These are the essential new
mechanics to design and test, not incidental cleanup.

If this extension turns into a second generic event framework, stop and compare
a small POSIX `poll` owner: it is portable but scans descriptors and still needs
the same lifecycle barrier. A global stop/join works as a benchmark barrier;
using it for every pane operation would complicate and stall unrelated panes.
Do not adopt one thread per pane merely because Herdr uses it, or import the
prototype's verification queue into production for a modest gain.

## What Herdr actually protects

Herdr `src/pane/terminal.rs:188–221` keeps the VT, RenderState and trackers in
`Mutex<GhosttyPaneCore>`, plus separate key-encoder and response storage mutexes.
`process_pty_bytes` locks the core at `1353–1361`; render/observation operations
also lock it, and optional compression uses try-lock (`2192–2224`). The Rust
opaque Terminal is `Send` only under an explicit external-synchronization
assumption (`crates/ghostty-vt/src/lib.rs:2303–2304`); it is not intrinsically
concurrent. Parser callbacks copy replies into owned `Bytes` (`terminal.rs:1158–1166`).

The PTY actor has an explicit response-order lock around read/parse/reply
collection (`src/pty/actor/unix.rs:823–852`) and a control protocol for handoff
(`250–278,683–782`). Its handoff can wait for input drain and return errors.
Corgi should preserve its own existing synchronous pause and prior input-drain
policy rather than copy Herdr's entire actor/control abstraction.

## Integration gate

Before production adoption: require a worthwhile whole-app opportunity from
the component measurements; implement native guards and copied title ownership;
initialize globals once; cover callback-generated replies and pending WRITE;
make per-pane detach/free/FD reuse and all-pane handoff synchronous and race-safe;
retain Bun observation/UI deadlines and viewer ownership; add concurrent
creation/PNG/link/resize/restore tests, partial-notification and restart tests,
and lifecycle failures with queued output/input. Then run the repository's
native/unit/integration and visual checks, followed by isolated whole-app
measurements. The prototype's text fixtures alone do not discharge these gates.

## Selected production experiment

The measured actor moved native read/feed without reducing notifications in one
variant, then suppressed immediate hidden-pane notifications in another. Only
the second variant improved the staggered fixture. The production candidate
therefore keeps the policy input explicit and tests the complete path again.
Its poll backend is different from the prototype's epoll backend; prototype
percentages are not production performance claims.

The selected implementation is `native/pty_reader.c`, built into `corgi_term`.
It uses one POSIX `poll` thread on Linux and macOS, leaving the existing general
ReadyLoop unchanged. Dynamic registrations and poll snapshots have no 64-pane
limit. Scanning the poll array is O(registered readable panes) per wake; a ready
pane receives at most eight 64 KiB reads before the next pane is serviced.
Parser work triggered by those bytes still has no fixed time bound.

The public functions are `pty_reader_new`, `pty_reader_attach`,
`pty_reader_interest`, `pty_reader_take`, `pty_reader_detach`, `pty_reader_free`,
and `terminal_drain`. A take record contains three u32 values: token,
OUTPUT/HANGUP/ERROR flags, and errno. The socket contains coalesced one-byte
wakes, never per-output records. Hidden OUTPUT remains in the registration;
HANGUP/ERROR always wake Bun. Promotion to immediate interest wakes any pending
output. Bun takes hidden receipts at the beginning of its existing 50 ms loop,
before the quiet-work gate.

Poll snapshots retain entries until the worker releases them. Detach removes
an entry, wakes the poll, waits for its final snapshot reference, and returns
its final flags/errno without closing the original FD. An in-flight callback
publishes its result even when detach has already removed the registration.
Bun combines that final result with any record already copied into its current
batch. Free synchronously detaches remaining entries and discards their
receipts; terminal bytes remain retained. Normal shutdown closes watches first.

The lock order is per-terminal VT mutex followed by registry mutex. The worker
never holds the registry mutex while waiting for a VT mutex, polling, or feeding
bytes. Guard release publishes current WRITE interest before releasing the VT
mutex, eliminating an old-interest overwrite race. The registry owns a rotating
take cursor; Bun bounds each dispatch turn by its starting registration count,
so continuously refilled entries cannot starve later entries or keep one turn
running indefinitely.

The native title ABI uses a main-thread response buffer copied while guarded.
Its length is max-u64 on allocation failure, distinct from an empty title.
Runtime reader fields never enter checkpoint/handoff formats. Terminal FFI
entrypoints guard mutable state, and host composition rejects actor-backed
handles rather than introducing multi-terminal lock ordering into the viewer.

## Boundary and receipt review after parallel feeding

The first production native build passed 60 tests: 44 pane tests and 16 host
presentation tests. Seven reader tests cover hidden parsing/replies, wake
promotion/acknowledgement, 80 registrations with fair pagination, detach/restart
and original descriptor ownership, hidden hangup with trailing bytes, queued
writes without a later output event, and PNG decoding alongside new terminal
creation and synchronized-image capture. Evidence is
`dist/retained-v16-native-build-summary.log`. This is Linux validation; the
shared POSIX path is not a claim of an executed macOS test.

Two Bun boundary assumptions required adjustment:

- A generic native JSON response can grow between the first sizing result and
  its retry now that feeding runs concurrently. Growing only once to the exact
  original length could fail spuriously. Geometric bounded growth preserves
  the existing 64 MiB response limit, with each successful response still
  serialized from one guarded native state. Large clipboard/input responses
  commit their removal only after the buffer fits.
- Agent observation must acknowledge the surface revision read before observing
  title/screen, rather than a newer revision fetched afterward. Otherwise an
  intervening feed could be marked observed without its contents being judged.

The other examined receipts remain conservative. Native surface rows, image
metadata, modes and stamp are serialized under one guard. The viewer's separate
known-stamp probe can defer a newly arriving update to the next pending wake,
but never acknowledges a body it did not receive. Ghost preparation, ghost
refresh, post-resize ghost state, and the live-text cache read revision before
reading text; an intervening feed can cause extra work, not stale suppression.
Viewer mirrors have no reader and retain their existing single-thread ownership.

All response ownership stays within the existing boundary: JSON and viewer
output are copied before unlock, recovery/live-text results own their bytes,
and title metadata plus bytes use the main-thread response snapshot. Worker
feeds never invoke the process-global response writers. A failed generic JSON
retry may repeat a read-only capture, but no partially encoded surface escapes.
Live handoff capture runs after every reader has synchronously detached.

A pre-existing persistence follow-up is deliberately outside this candidate:
`Server.collect` assigns `savedDurable = runtime.durable` after awaiting
`recovery.save`, although that save captures state before its resolved promise
returns. Capturing the durable receipt before saving and acknowledging that
same value afterward would avoid acknowledging a change delivered across the
await. This is not attributed to the reader implementation and was not changed
as part of its production experiment.
