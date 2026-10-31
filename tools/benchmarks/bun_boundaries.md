# Keeping Corgi policy in Bun with cheaper native boundaries

Source investigation, 2026-10-26. Bun was cloned read-only into
`/home/t/dev/vendor/bun-corgi-boundaries-20261026`, at tag `bun-v1.4.4`, commit
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`, matching the benchmark runtime.
No production implementation or new performance measurements accompany this note.
The subsequent implementation is tracked in [retained validation](retained_validation.md).

The useful direction is to retain screen data and expose narrow operations on
it while keeping layout, animation, overlays and provider interpretation in
TypeScript. A JS/native crossing does not require JSON. Corgi already uses
opaque handles and direct FFI for terminal input and the host differ; its generic
terminal request/reply path adds serialization by design.

## Patterns found in Bun

- [SQLite's Statement wrapper](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/js/bun/sqlite.ts#L198)
  stores a native object in `#raw`, forwards methods, and exposes different
  result shapes through `get`, `values`, `raw` and iteration. Native state is
  retained across calls. Corgi can use ordinary TS classes over opaque C-ABI
  handles without exposing the terminal's internal structs.
- [FFI buffer ownership](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/ffi/FFIObject.rs#L608)
  supports ArrayBuffer views over native addresses and optional deallocators.
  [The JS module](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/js/bun/ffi.ts)
  exposes buffer and buffer-length argument types;
  [the engine bridge](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/JSCFFIBridge.cpp)
  constructs typed native call signatures. None of this requires a JSON tree.
  Corgi should start with reusable JS-owned buffers and synchronous borrowed
  pointers. Long-lived views into mutable Ghostty allocations require explicit
  ownership/release rules and resize/destruction handling.
- [HTMLRewriter](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/api/html_rewriter.rs#L356)
  parses selectors when registered and retains them with handlers. Native
  traversal finds matches; registered JS callbacks interpret or modify them.
  The design is useful for screen-query registration, although its private JSC
  wrappers and borrowed-object lifetime machinery are not a public addon ABI.

A small correctness probe in `dist/bun-boundaries/probe.ts` used the installed
Bun 1.4.4 and libc `memset`: native code changed the original JS-owned Buffer;
a `toArrayBuffer` view saw the same bytes; `CString` retained its copied string.
[Probe result](../../dist/bun-boundaries/probe.json). This proves sharing/copy
semantics for that case, not a throughput improvement or general lifetime safety.
Official API references: [FFI](https://bun.com/docs/runtime/ffi),
[SQLite](https://bun.com/docs/runtime/sqlite),
[HTMLRewriter](https://bun.com/docs/runtime/html-rewriter).

## What the Corgi boundary could look like

A conceptual interface, not an existing API:

```ts
frame.blit(pane.surface, destination, { clip, dim });
frame.text(sidebarLabel, position, style);
frame.present();
```

TypeScript decides which surface, rectangle, label, color and animation state to
use. A small backend copies/clips cells or rows, tracks damage, and emits precise
terminal spans. Work crosses in batches per surface/region, not callbacks or
FFI calls per character. Opaque data need not become JS objects just to be sent
back into native code. Existing image, wide-character, cursor, selection and
hyperlink behavior still needs equivalent primitives or an explicit fallback.

That backend is a proposed mechanical extension to the terminal/rendering code;
it is not a proposal to move the controller, layout decisions, sidebar policy
or provider state machines into Zig. Another viable first step is retaining and
composing rows in TypeScript with packed buffers. Benchmark both before choosing
how much generic composition belongs in native code.

There are two different boundaries:

1. **Inside a process:** opaque handles, direct scalar calls and caller-owned
   buffers can remove JSON and repeated object materialization.
2. **Daemon to viewer:** separate address spaces still require data transfer.
   A pointer is not a portable surface identifier. Send versioned changed rows
   or cell spans, decode once into a retained viewer surface, and let TS refer
   to its local handle. Shared memory adds lifetime/concurrency complexity and
   is not required to try this design.

Replacing JSON alone leaves ANSI replay and full-frame reconstruction intact.
The previous experiments already show that representation changes must preserve
damage/identity through composition to reach the larger opportunity. A row-only
differ sent 10.9 times more terminal bytes in the scrolling fixture, so keep
precise cell-span emission rather than treating faster local loops as sufficient.

## Screen scraping can remain in TypeScript

The daemon already owns the authoritative Ghostty terminal. Scrapers read that
state, while a viewer composes a separate presentation. They do not need the
viewer to replay a complete composed UI into another terminal.

Start with a small screen-reading abstraction that provides identity/revision,
requested text regions, title and modes. Cache extracted text per relevant
revision and reuse the string across consumers. Let provider-specific literal
and regex rules run in JavaScript. Current `PaneView.text()` already defers
extraction and `detectPane` shares it within one pass; the next step is reuse
across passes and bounded extraction where semantics permit.

Codex mainly reads the screen tail; Claude's composer detection can scan the
whole screen. Tail extraction must preserve the existing trimming/blank-row
semantics, not silently substitute the bottom eight physical viewport rows.
Changes in title, geometry or terminal identity also invalidate relevant reads.

If profiling later warrants it, register generic queries such as a literal
match over a region and return a batch of changed results. Keep the provider's
interpretation in TS. Avoid a new native regex engine or provider-specific
matching code initially: JS regex execution already uses the runtime engine,
and differing Unicode/regex semantics would add complexity.

Cache pure extraction/matching, not the whole watcher state machine. Corgi's
watchers deliberately confirm states over multiple reads and use elapsed-time
rules for interrupted turns. Those transitions must still advance on deadlines
when text has not changed. Observation freshness is also separate from a fact
changing. The existing native text-extraction span was about 0.23% elapsed in
the streaming diagnostic, so scraper acceleration is not a prerequisite for
addressing the larger viewer cost.

## A bounded next experiment

Keep one existing pane's ordinary presentation in a retained surface, expose a
small TS wrapper, and preserve a fallback for transformations not yet supported.
Compare it with the current pipeline using the established terminal corpus,
output-byte counts, allocation/materialization counters and whole-process CPU.
Separately try a revision-cached screen reader with unchanged provider rules.
This tests the boundary design without committing to a broad native rewrite.

## Owned native bytes in the implemented path

The v7/v9 recovery and screen readers retain one synchronous boundary: native
returns an owned allocation and its length, TypeScript materializes an owned
Buffer or string, and a `finally` block frees the allocation. Provider matching
still runs in TypeScript. This removes JSON string escaping and decoding without
introducing asynchronous borrowed-buffer lifetimes.

The pinned Bun 1.4.4 source also supplies a smaller wrapper for this operation.
`src/js/bun/ffi.ts` exports `toBuffer`; its implementation in
`src/runtime/ffi/FFIObject.rs:669` creates a Buffer over the supplied bytes with
a no-op deallocator when no finalizer is given. V10 uses this directly instead
of `toArrayBuffer` followed by `Buffer.from`. The private synchronous callback
must still copy any returned byte buffer or produce an owned string before
the explicit native free. The wrapper is never returned or saved. This is an
API simplification; no standalone CPU or allocation-rate saving is claimed.


## Source audit: threadsafe Bun JSCallback as a future boundary

This is a source-only feasibility audit, not a measured replacement. It uses
Bun 1.4.4 commit 38afee6c84fcf48c0edb2466aa4b27d287a59c30 and the WebKit dependency
pinned by `scripts/build/deps/webkit.ts` at
d6375c72affe0f70222cdcb45012b10f0bf3a9d5.

A threadsafe callback copies its arguments and posts asynchronous work to the
owning ScriptExecutionContext. A two-u32 signature has no borrowed payload
buffer lifetime: its scalar slots live in the invocation's inline vector. The
native call returns immediately; a void return is appropriate for readiness.
It remains a queue boundary. At least three native heap objects are created
per event: ThreadsafeInvocation, EventLoopTask and ConcurrentTask. The latter
carrier is 32 bytes on 64-bit targets; this does not count allocator rounding,
closure storage or the invocation object. Removing Node buffers therefore does
not by itself establish less allocation. See pinned
[WebKit invocation storage](https://github.com/oven-sh/WebKit/blob/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/ffi/FFIContext.h#L49),
[Bun context posting](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/ScriptExecutionContext.cpp#L286),
and [ConcurrentTask allocation](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/event_loop/ConcurrentTask.rs#L338).

Keepalive is distinct from rooting the callback for GC. Callback creation adds
it to a live GC root list; dispatch pushes and wakes the event loop, while
`add_keep_alive` is a separate path that dispatch does not call. Bun's alive
check includes active handles, pending tasks, queued concurrent work and pending
refs, but not arbitrary foreign pthreads. JSCallback exposes close but no
ref/unref. The source therefore indicates that an otherwise idle ReadyLoop
must retain an explicit keepalive if its notification Socket is removed. A
callback already posted keeps pending work visible; it does not cover the
period before the next foreign-thread notification. This needs a subprocess
runtime test with a delayed native callback and no timers or other handles.
See [JS callback rooting](https://github.com/oven-sh/WebKit/blob/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/ffi/JSFFICallback.cpp#L98),
[post versus keepalive](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/VmHandle.rs#L173),
and [event-loop liveness](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/VirtualMachine.rs#L1815).

Closing the JSCallback does not cancel enqueued invocations. The pinned test
explicitly closes after enqueueing 50 calls and expects all 50 to execute. The
JSC close implementation defers unrooting until pending calls retire. A safe
application shutdown would mark the ReadyLoop closed and clear its token map,
stop and join the native reporter while the callback pointer is still valid,
then close the JSCallback and release the keepalive. Any already queued JS
invocation must see the closed/empty state and return before accessing freed
native memory. Worker termination dropping pending tasks is a different
lifetime and is not a substitute for this ordering. See
[close-while-enqueued test](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/test/js/bun/ffi/cc.test.ts#L517)
and [pending-call retirement](https://github.com/oven-sh/WebKit/blob/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/ffi/FFICallbackThunk.cpp#L413).

The MPSC queue preserves a single producer's enqueue order; other task producers
may interleave. The path has no bounded socket-buffer backpressure: it allocates
and posts to an unbounded concurrent queue. One-shot registrations normally
limit outstanding readiness per descriptor until JS rearms them, but this is
not a global capacity guarantee under changed-interest rearming or registration
churn. Tests must include queued old tokens, close/reuse, read+write readiness,
callbacks that rearm immediately and shutdown with queued callbacks. The
aligned micro's 1344 records arrived in 84 Node data callbacks; per-event
JSCallback would instead schedule 1344 invocations, making an aligned-versus-
staggered comparison necessary. Sources:
[queue insertion](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/threading/unbounded_queue.rs#L202)
and [native callback dispatch](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings/JSCFFIBridge.cpp#L66).

A benchmark-only prototype is reasonable once the keepalive and shutdown cases
pass. Retaining an idle referenced handle initially could preserve liveness
while isolating hot-path transport removal; that would not yet remove all setup
FDs. No production callback path, extra runtime test or timing was run during
this audit, and no callback performance claim is made.

The later benchmark-only [callback experiment](readiness_findings.md#callback-component-result-2026-10-26)
passed delayed-callback liveness with the original idle Socket retained, FIFO
delivery, token invalidation, interest changes and queued-close retirement.
It measured modest component savings with incomplete staggered replication;
it did not test a Socket-free lifetime design or make a production change.
