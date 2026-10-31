# Viewer transport and serialization audit

Source-only investigation; no prototype, build, test or timing run. Bun source
is `/home/t/dev/vendor/bun-corgi-boundaries-20261026`, revision
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`, matching the installed Bun 1.4.4.
References below name that checkout's paths unless prefixed with `Corgi`.

The narrow experiment worth trying is a **viewer-client-only Bun.connect
transport with unchanged JSON messages**, with the Node transport retained as
the control. A binary protocol is not justified by the current evidence.
Neither proposal has a demonstrated speedup.

## What the profile actually attributes

The existing V12 diagnostic has 402 samples in the attached streaming viewer
phase (`dist/retained-v12-herdr-diagnostic/diagnostic-summary.json`). Node's
`data` / `readableAddChunkPushByteMode` stack contains 88 samples, the RPC data
callback contains 81, and `parse` contains 70 inclusive / 68 self. Most of the
22% inclusive stream stack is the JSON decoder it calls. It is not 22% removable
stream overhead. The difference of seven samples is a rough, noisy indication
of the outer wrapper's size, not a precise saving estimate.

Root's telemetry attributes about 0.106 elapsed-core percentage points to wire
decode. Removing that work alone would not explain the roughly 1.57-point
controlled V15 viewer gap against Herdr. Allocation reductions could also affect
GC/compiler threads, which these main-thread spans and samples do not measure;
that is a reason to measure process CPU, not to inflate the predicted saving.

## node:net versus Bun.connect

`Corgi/src/rpc.ts:1–67` uses a flowing Node Socket with `setEncoding("utf8")`.
Each chunk is decoded, appended to a string, checked with `Buffer.byteLength`,
scanned for newline, sliced into messages, and decoded by Corgi's bigint-aware
JSON reviver. Each request also creates a Promise and pending record. Changing
the socket API does not eliminate those request Promises or JSON work.

Both public socket APIs use the same native connection implementation:
`src/runtime/node/node_net_binding.rs:108–120` calls
`Listener::connect_inner`, and `src/runtime/socket/Listener.rs:1093–1105`
documents that shared entrypoint for Bun.connect and node:net. Both eventually
call `socket_body.rs:2317–2375`, which converts every native read into an owned
JS Buffer/ArrayBuffer before invoking the data callback.
`src/jsc/array_buffer.rs:1003–1037` explicitly implements that conversion by
copying bytes. Selecting `binaryType: "buffer"` therefore does **not** make the
read zero-copy.

The extra Node layer is concrete:

- `src/js/node/net.ts:799–836` updates stream bookkeeping and calls `push`.
- `src/js/internal/streams/readable.ts:399–447` checks stream flags and runs the
  StringDecoder installed by `setEncoding`.
- `readable.ts:484–510` either emits `data` immediately or queues the chunk,
  then considers further reads.

An always-flowing Corgi socket normally takes the immediate-emission branch;
claiming a fresh queued-stream buffer per packet would be wrong. Bun.connect
can remove this wrapper, timer/counter bookkeeping, EventEmitter dispatch and
stream-state machinery. It still creates the native callback Buffer and must
handle decoding/framing itself.

A first variant should keep a StringDecoder and the exact existing line parser,
so it isolates removal of the wrapper. A second, separately attributed variant
could scan LF in owned Buffer chunks, maintain a numeric pending-byte count and
decode each complete JSON line once. Complete lines in one chunk need no
concatenation; fragmented lines need retained chunks plus one join. This avoids
repeated whole-prefix byte-length scans and string concatenation, but offers
little extra copying benefit if every response already arrives in one chunk.
Splits inside UTF-8, several replies in one chunk, empty lines and the existing
64 MiB limit all need equivalent behavior.

The important cost transferred into Corgi is outgoing backpressure.
`packages/bun-types/bun.d.ts:6783–6809` documents unbuffered nonblocking writes,
partial byte counts and -1 for a closed socket. A correct adapter must retain
owned request bytes, send offsets on `drain`, preserve FIFO replies, queue
before connection opens, and reject pending requests on connection/error/close.
Using byte offsets directly avoids allocating a new subarray for every retry.
Calling `socket.write(string)` and ignoring a short result is not equivalent to
Node's buffered `socket.write`. Unix sockets and their connect Promise are public
APIs (`bun.d.ts:7470–7505`).

Only the viewer client needs this experiment. The daemon's FD-owning Client,
JSON management clients, and handoff descriptor/state format can remain as they
are. A live server handoff is transparent to an already-connected client socket.

## bun:jsc serialize/deserialize

The API is public (`packages/bun-types/jsc.d.ts:353–379`) and uses WebKit's
structured-clone format. It has useful mechanical properties:

- `BunJSCModule.h:842–918` serializes directly to a Buffer when requested and
  deserializes from a Buffer/ArrayBuffer view.
- `SerializedScriptValue.cpp:4882–4940` wraps retained serializer storage in an
  ArrayBuffer and deserializes from the supplied byte span. The public path
  does not first convert all bytes into a JS UTF-8 string.
- BigInts have explicit tags and signed magnitude encoding (`:953–1001,
  :1110–1114`), so no decimal spelling or per-property bigint reviver is needed.
- Strings use 8-bit or UTF-16 storage, with a per-message string pool
  (`:1645–1687`). ANSI ESC bytes need not become JSON `\\u001b` escapes. Repeated
  strings can share pool entries. Pooling/interning also has its own work; it
  must not be assumed to be free or universally faster.

It is **not a drop-in encoding of current Corgi View values**. Its object walker
gets own enumerable properties (`:2085–2136`); it does not invoke `toJSON`.
Concrete current differences include:

- `session.viewerSnapshot` returns `w.model` itself (`Corgi/src/session.ts:605`).
  `Model.toJSON` trims unused nodes/tabs and exposes only nodes/tabs/revision
  (`src/layout.ts:53–62`). Structured clone instead sees count, next_id and the
  untrimmed backing arrays.
- `BoundedText.toJSON` turns an object into text or invalid-UTF8 byte values;
  `RawText.toJSON` preserves invalid bytes. Structured clone instead sees an
  ordinary object's fields or the String object's text
  (`src/bounded_text.ts:1–8,91–93`).
- Other RPC payloads use projections such as `usage.Info.toJSON`, launch
  previews and resume hints. Replacing the generic Connection codec would
  silently change those shapes too.
- JSON omits undefined object fields and duplicates repeated object references;
  structured clone preserves undefined and object identity. It also preserves
  BigInt even when the value fits a JS number. Existing normalization may handle
  many such values, but equivalence must be checked, not inferred.

Frequent View replies with `session: null` and `resources: null` are plain data
and are good codec microbench fixtures. Full session/resource updates must be
included too. Timing `serialize(json.parse(json.stringify(view)))` and omitting
the normalization cost would hide the main compatibility problem. If a later
codec experiment proceeds, it should use deliberate canonical DTOs, preserving
current `toJSON` semantics and consumer behavior, rather than a generic new
recursive serializer.

The format also creates deployment and lifecycle work. Its pinned header is
version 14 (`SerializedScriptValue.cpp:399–421`); deserializers accept only
versions no newer than their own (`:2405`). It is little-endian (`:650–699`) and
has explicit integer widths, so simple values can cross these supported 64-bit
platforms, but the source offers no promise that a new Bun encoder works with an
older Bun decoder. Corgi currently negotiates viewer protocol version 3, not a
Bun serialization version. During a daemon update an older viewer can remain
connected. Binary negotiation/fallback would need to account for that.

Binary bytes also cannot use the existing newline framer. Length framing,
message limits, truncation/errors and preservation of an in-progress binary
frame across daemon handoff would need explicit design. `Client.savedInput`
currently reconstructs pending JSON lines and handoff saves its raw input/output
buffers; a connection codec would become handoff state. Those changes are much
larger than replacing an in-process serialization helper.

## Bounded experiment recommendation

Use a separate benchmark-only Unix client/server harness with real View
fixtures and identical message cadence/fragmentation for:

1. Current rpc.Connection with its existing JSON parser.
2. Bun.connect with the same StringDecoder/line parser/JSON parser.
3. Optionally Bun.connect with byte framing, measured separately.

Test connection failure, close-before-open, queued request order, UTF-8 splits,
coalesced responses, large responses, partial writes and pending-error rejection
before timing. Include a parse-disabled receive checksum control to distinguish
transport/framing cost from the shared JSON parser, and report both endpoints'
CPU, allocation/GC evidence and end-to-end latency. Preserve actual resource and
session update frequency rather than benchmarking only the smallest hot reply.

Only promote a candidate if the whole viewer process shows a reproducible gain
with the same rendering/input behavior. No new wire protocol is recommended
from the present attribution alone.
