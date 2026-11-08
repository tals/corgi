# Compression measurements

All bytes are compressed Corgi render payload, including codec framing. CPU is median average microseconds per message across three fresh processes. [Raw summaries and ranges](evidence/summary.json), [individual trials](evidence/trials.jsonl.gz), [split audit and hashes](evidence/manifest.json), [method and limitations](method.md).

## Independent frames: all levels

Each entry is **bytes/message without dictionary → with the 8 KiB dictionary**. CPU columns use the dictionary.

### Sparse

| Level | Bytes/message, no dictionary → 8 KiB | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: |
| 1 | 649.0 → 295.1 | 2.84 | 1.16 |
| 3 | 657.5 → 286.3 | 3.04 | 0.98 |
| 6 | 638.0 → 270.6 | 14.66 | 1.13 |
| 9 | 638.0 → 268.7 | 20.02 | 1.10 |
| 15 | 635.8 → 269.8 | 337.93 | 1.00 |
| 19 | 636.9 → 269.8 | 339.36 | 1.10 |

### Dense

| Level | Bytes/message, no dictionary → 8 KiB | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: |
| 1 | 2,262.3 → 1,908.2 | 17.13 | 4.90 |
| 3 | 2,257.9 → 1,902.2 | 26.11 | 4.60 |
| 6 | 2,250.0 → 1,874.6 | 65.60 | 5.81 |
| 9 | 2,243.5 → 1,862.1 | 127.74 | 5.93 |
| 15 | 2,222.9 → 1,859.0 | 914.84 | 5.87 |
| 19 | 2,215.5 → 1,859.0 | 924.49 | 5.90 |

### Claude

| Level | Bytes/message, no dictionary → 8 KiB | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: |
| 1 | 674.2 → 270.7 | 3.95 | 1.14 |
| 3 | 670.8 → 263.1 | 3.31 | 1.07 |
| 6 | 644.2 → 236.1 | 18.09 | 1.09 |
| 9 | 644.0 → 234.8 | 29.07 | 1.02 |
| 15 | 640.8 → 231.7 | 468.77 | 1.04 |
| 19 | 639.5 → 231.7 | 493.61 | 1.10 |

### Codex

| Level | Bytes/message, no dictionary → 8 KiB | Encode µs/message | Decode µs/message |
| --- | ---: | ---: | ---: |
| 1 | 804.4 → 332.4 | 5.65 | 1.37 |
| 3 | 793.4 → 313.7 | 4.07 | 1.19 |
| 6 | 745.3 → 273.4 | 19.36 | 1.15 |
| 9 | 743.8 → 266.4 | 34.35 | 1.05 |
| 15 | 738.0 → 264.4 | 781.45 | 1.04 |
| 19 | 737.0 → 264.4 | 821.25 | 1.10 |

## Level 3 against SSH

| Workload | SSH encode / decode µs | zstd, no dict encode / decode µs | zstd + 8 KiB encode / decode µs | Payload saving vs SSH |
| --- | ---: | ---: | ---: | ---: |
| sparse | 19.46 / 7.71 | 7.53 / 3.77 | 3.04 / 0.98 | 71.8% |
| dense | 55.41 / 20.70 | 22.05 / 6.09 | 26.11 / 4.60 | 47.7% |
| claude | 24.02 / 9.90 | 9.31 / 4.23 | 3.31 / 1.07 | 78.5% |
| codex | 31.37 / 13.12 | 11.34 / 4.75 | 4.07 / 1.19 | 80.7% |

## Dictionary capacity and stacking

Both dictionary candidates use exactly the same 159 training messages (411,668 bytes), shuffled with seed 20261108. The requested 32 KiB cap produced 16,249 bytes. It did **worse** on all four held-out workloads at level 3; larger was not automatically better. Training took 22.7 / 22.8 ms of CPU for the 8 KiB / larger candidate. These are tiny synthetic training sets, not a production dictionary.

| Workload | 8,192-byte dictionary: bytes/message | 16,249-byte dictionary: bytes/message | SSH on top of 8 KiB zstd: size change |
| --- | ---: | ---: | ---: |
| sparse | 286.3 | 323.2 | +2.10% |
| dense | 1,902.2 | 1,934.3 | +0.32% |
| claude | 263.1 | 289.5 | +2.30% |
| codex | 313.7 | 382.2 | +1.92% |

## Continuous history and the historical SSH control

Streaming zstd level 3 keeps earlier messages as compression history. The historical zlib control also has cross-message dictionary history. Values are bytes/message, with an immediate flush after every message. These modes should not be conflated with independent frames.

| Workload | Installed SSH | Historical SSH codec | zstd stream, no dict | zstd stream + 8 KiB | Independent zstd + 8 KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| sparse | 1,014.2 | 71.1 | 63.6 | 58.4 | 286.3 |
| dense | 3,636.6 | 1,755.7 | 1,671.5 | 1,735.1 | 1,902.2 |
| claude | 1,223.6 | 109.6 | 109.2 | 91.9 | 263.1 |
| codex | 1,627.2 | 94.4 | 93.7 | 82.0 | 313.7 |

At level 3, streaming with the 8 KiB dictionary saves about 1–18% against the historical SSH compressor on these corpora, rather than the 52–95% savings against the installed Huffman-only compressor. A dictionary actually makes dense streaming larger than dictionary-free streaming here. More history or a dictionary is not an unconditional improvement.

## Codec allocations and first use

KiB below are maximum observed retained codec allocations across three trials, not whole-process RSS. The encoder/decoder dictionary columns are shareable compiled dictionaries; context columns are per connection. Raw ranges are retained in the JSON.

| Level 3 + 8 KiB | Encoder context KiB | Shared encoder dict KiB | Decoder context KiB | Shared decoder dict KiB | Setup / first encode µs |
| --- | ---: | ---: | ---: | ---: | ---: |
| sparse | 55.0 | 214.6 | 93.7 | 34.7 | 191.2 / 35.8 |
| dense | 141.5 | 214.6 | 93.7 | 34.7 | 163.9 / 91.6 |
| claude | 250.6 | 214.6 | 93.7 | 34.7 | 161.7 / 64.7 |
| codex | 259.0 | 214.6 | 93.7 | 34.7 | 193.3 / 76.4 |

The installed SSH codec used 261.9 KiB encoder and 39.1 KiB decoder allocations. Streaming zstd level 3 with the dictionary used 3.14 MiB encoder and 2.50 MiB decoder allocations, including the compiled dictionary. The 8 KiB file is not the same thing as its compiled in-memory representation.

Setup constructs both encoder and decoder contexts/dictionaries; it excludes the first-call deferred allocations. The first message differs across corpora, so these figures do not measure SSH or Corgi connection initialization.
