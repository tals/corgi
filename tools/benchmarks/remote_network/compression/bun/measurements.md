# All Bun compression paths

Measured with Bun 1.4.4, AMD EPYC 7C13, CPU 48, three fresh processes per cell. All zstd modes use level 3; every dictionary mode uses the same frozen 8 KiB dictionary. Bytes include codec framing. Ratios are original/compressed. CPU is median process CPU per message; [raw values and ranges](evidence/summary.json), [trials](evidence/trials.jsonl.gz), [method](README.md).

## Sparse

| API mode | Bytes/message | Compression ratio | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: | ---: |
| bun-sync | 657.5 | 2.44:1 | 9.05 | 3.77 |
| node-sync | 657.5 | 2.44:1 | 14.98 | 8.80 |
| node-sync-dict | 286.5 | 5.61:1 | 27.97 | 14.75 |
| frame | 657.5 | 2.44:1 | 24.71 | 22.48 |
| frame-dict | 286.5 | 5.61:1 | 20.17 | 20.42 |
| ffi-dict | 286.3 | 5.61:1 | 3.71 | 1.55 |
| huffman | 1,014.2 | 1.58:1 | 30.74 | 26.78 |
| deflate | 73.1 | 21.97:1 | 23.22 | 21.36 |
| live | 63.0 | 25.48:1 | 18.37 | 18.67 |
| live-dict | 58.3 | 27.53:1 | 17.66 | 18.00 |

## Dense

| API mode | Bytes/message | Compression ratio | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: | ---: |
| bun-sync | 2,259.6 | 2.43:1 | 22.23 | 6.33 |
| node-sync | 2,259.6 | 2.43:1 | 25.16 | 12.35 |
| node-sync-dict | 1,902.7 | 2.88:1 | 52.14 | 18.03 |
| frame | 2,259.6 | 2.43:1 | 39.27 | 28.44 |
| frame-dict | 1,902.7 | 2.88:1 | 47.71 | 28.14 |
| ffi-dict | 1,902.2 | 2.88:1 | 25.95 | 5.50 |
| huffman | 3,636.6 | 1.51:1 | 49.58 | 39.99 |
| deflate | 1,709.2 | 3.21:1 | 70.73 | 34.28 |
| live | 1,670.9 | 3.28:1 | 44.68 | 26.94 |
| live-dict | 1,736.5 | 3.16:1 | 54.58 | 27.90 |

## Claude

| API mode | Bytes/message | Compression ratio | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: | ---: |
| bun-sync | 670.7 | 3.00:1 | 10.08 | 4.26 |
| node-sync | 670.7 | 3.00:1 | 15.39 | 11.80 |
| node-sync-dict | 262.9 | 7.66:1 | 29.25 | 17.00 |
| frame | 670.7 | 3.00:1 | 27.36 | 27.31 |
| frame-dict | 262.9 | 7.66:1 | 21.28 | 21.76 |
| ffi-dict | 263.1 | 7.66:1 | 3.49 | 1.44 |
| huffman | 1,223.6 | 1.65:1 | 36.52 | 30.35 |
| deflate | 113.2 | 17.81:1 | 27.69 | 21.25 |
| live | 108.9 | 18.49:1 | 21.45 | 24.68 |
| live-dict | 91.7 | 21.98:1 | 20.12 | 21.79 |

## Codex

| API mode | Bytes/message | Compression ratio | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: | ---: |
| bun-sync | 793.5 | 3.53:1 | 12.68 | 5.23 |
| node-sync | 793.5 | 3.53:1 | 16.34 | 11.54 |
| node-sync-dict | 314.4 | 8.90:1 | 30.06 | 16.19 |
| frame | 793.5 | 3.53:1 | 29.97 | 27.71 |
| frame-dict | 314.4 | 8.90:1 | 21.67 | 22.40 |
| ffi-dict | 313.7 | 8.92:1 | 4.69 | 1.85 |
| huffman | 1,627.2 | 1.72:1 | 35.51 | 30.76 |
| deflate | 110.7 | 25.29:1 | 29.06 | 24.53 |
| live | 94.9 | 29.48:1 | 19.92 | 22.19 |
| live-dict | 82.0 | 34.11:1 | 18.79 | 21.24 |

## Reused native codec allocations through Bun FFI

These are retained native allocations after timing, excluding Bun/GC, JS wrappers and returned Buffers. The scratch-buffer column is additional per-connection allocation. Compiled dictionaries can be shared. No equivalent allocation count is claimed for the built-in APIs.

| Workload | Encoder context KiB | Compiled encoder dict KiB | Decoder context KiB | Compiled decoder dict KiB | Scratch buffers KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| sparse | 55.0 | 214.6 | 93.7 | 34.7 | 3.2 |
| dense | 141.5 | 214.6 | 93.7 | 34.7 | 11.0 |
| claude | 250.6 | 214.6 | 93.7 | 34.7 | 18.0 |
| codex | 259.0 | 214.6 | 93.7 | 34.7 | 22.5 |

The FFI path uses system libzstd 1.5.5. Built-in Bun paths use Bun’s bundled revisions, recorded in every trial. Slight size differences between paths are actual measurements, not a change in input traffic or dictionary. The Deflate stream similarly reports actual Bun output, rather than reusing the earlier system-zlib numbers.
