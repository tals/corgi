# Native WebSocket feasibility

Checked on installed **Bun 1.4.4**. A native WebSocket can carry our existing continuous zstd stream as binary application data. Bun does **not** provide a zstd WebSocket extension. This is a transport prototype; production transport is unchanged.

| Capability | Verified result |
|---|---|
| Native compression extension | `permessage-deflate`; no zstd extension in the IANA registry or Bun's supported negotiation |
| Deflate history | `perMessageDeflate: true` selected both `server_no_context_takeover` and `client_no_context_takeover`; dedicated compressor/decompressor selected `permessage-deflate` with history retained |
| Existing zstd codec | Exact round trips over native TCP and Unix WebSockets, extension disabled, application subprotocol selected |
| Unix sockets | `Bun.serve({unix: path})` and `new WebSocket("ws+unix://…:/rpc")` both worked |
| Read backpressure | Native client and server expose working `pause()` / `resume()`; both adapter directions pass paused-reader tests |
| Write backpressure | Native server has `drain` and `getBufferedAmount()`; native client adapter polls `bufferedAmount` only while blocked |
| Final bytes | The adapters preserve a 1 MiB response before EOF; both directions transfer 8 MiB exactly through a paused reader |

The [retained probe output](capabilities.json) records actual offered/selected headers and runtime methods. The zstd history check uses the production `Channel`: its two synthetic messages produced 78 and 15 compressed bytes. That checks history reuse, **not** a representative compression ratio. The probe's `1006` close codes come from its deliberate cleanup with `terminate()`.

Attempts to inject `permessage-zstd` through client or server header options did not negotiate an extension. Bun's [pinned response parser](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/http_jsc/websocket_client/WebSocketUpgradeClient.rs#L1842) accepts `permessage-deflate`, and the [IANA extension registry](https://www.iana.org/assignments/websocket/websocket.xhtml) contains no zstd entry. A private zstd extension would need runtime support; simply adding its name to a header does not implement it.

The supported route is the application subprotocol `corgi-stream-v1`: binary messages carry the existing hello and compressed bytes, with native deflate disabled on both ends. [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html#section-1.9) separates application subprotocols from frame-level extensions. It still runs over ordered TCP and adds a frame header: 2/4/10 bytes server-to-client and another four masking bytes client-to-server. It does not replace our frame acknowledgements, coalescing, reconnect policy, or codec-drain ordering. Our prototype also adds an HTTP upgrade round trip before the existing application hello.

For a fair native-deflate comparison, use a dedicated context and `serverSocket.send(data, true)`. [Bun's compression documentation](https://bun.com/docs/runtime/http/websockets#compression) distinguishes shared/reset contexts from dedicated contexts. [RFC 7692](https://www.rfc-editor.org/rfc/rfc7692.html#section-7.1.1) defines context takeover and its negotiation. Bun's [pinned native client](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/http_jsc/websocket_client.rs#L53) ordinarily leaves messages smaller than 860 bytes uncompressed.

The adapter uses Bun's framing, masking, handshake and close implementation. It adds two in-process Unix-socket hops; the raw control adds the same hops. Its 4 MiB application bounds remain necessary: our paused-reader probe reached native backpressure, observed accepted queued writes (`-1`), then an explicitly dropped write (`0`). Dropping one encoded chunk would invalidate the zstd history, so the adapter closes on a rejected send. Native-client polling and adapter copies are included in prototype costs.

Limits: this adapter does not preserve TCP half-close semantics or transfer WebSocket descriptors during daemon handoff. It forwards already-received bytes before exposing EOF, but transport errors become closure rather than preserving their original OS error code. Bun's own APIs provide graceful `close()` and immediate `terminate()`; the adapter uses termination for cancellation. See [Bun lifecycle documentation](https://bun.com/docs/runtime/http/websockets#closing-connections). This prototype should not be used to claim handoff or half-close correctness.

Reproduce from the repository root:

```sh
bun tools/benchmarks/remote_network/websocket_app/capabilities_probe.ts
bun test tools/benchmarks/remote_network/websocket_app/adapter.test.ts
```

The [focused adapter tests](adapter.test.ts) cover final bytes/EOF, paused downloads, paused uploads, and abrupt upstream closure for both WebSocket and raw control: **8 passed, 0 failed**. The application comparison is built by [prepare.py](prepare.py), using the unchanged adapter interface in [adapter.ts](adapter.ts).
