# Zstd versus SSH compression

**Yes: low-level zstd substantially beats the SSH compressor installed here,
and uses less encoding CPU on these inputs. A trained dictionary helps further.**
This measures unchanged Corgi render messages, not total network traffic or
recovery latency. Production code is unchanged.

Average compressed **bytes per message**, including codec framing; lower is better:

| Held-out workload | Installed SSH | Zstd level 3 | Level 3 + 8 KiB dictionary | Saving vs SSH |
| --- | ---: | ---: | ---: | ---: |
| Sparse network capture | 1,014 | 658 | **286** | **72%** |
| Dense network capture | 3,637 | 2,258 | **1,902** | **48%** |
| Claude replay | 1,224 | 671 | **263** | **79%** |
| Codex replay | 1,627 | 793 | **314** | **81%** |

These zstd rows use independent messages, with no compression history carried
from earlier messages. The dictionary reduces bytes by another **16–61%** over
plain level 3. [Exact measurements, CPU and memory](measurements.md).

**No training on the test traffic.** One dictionary serves all four tests.
It was trained on separate Claude/Codex recordings with a different SQL answer,
plus shell/editor recordings. Neither network workload was in training. Both
test agent recordings share a TypeScript answer, so **both were excluded**.
The audit reports zero identical training/test messages and different agent
scenario hashes. [Split and hashes](evidence/manifest.json),
[training prompt/answer](training-scenario.json), [method](method.md).

Higher levels have diminishing returns. With the same 8 KiB dictionary:

| Level | Sparse bytes/msg | Dense bytes/msg | Claude bytes/msg | Codex bytes/msg | Encode CPU, range across workloads |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 295 | 1,908 | 271 | 332 | 2.8–17.1 µs/msg |
| 3 | 286 | 1,902 | 263 | 314 | 3.0–26.1 µs/msg |
| 6 | 271 | 1,875 | 236 | 273 | 14.7–65.6 µs/msg |
| 9 | 269 | 1,862 | 235 | 266 | 20.0–127.7 µs/msg |
| 15 | 270 | 1,859 | 232 | 264 | 337.9–914.8 µs/msg |
| 19 | 270 | 1,859 | 232 | 264 | 339.4–924.5 µs/msg |

Level 3 + dictionary encoded **2.1–7.7× faster** than installed SSH in this C
benchmark. Encoder allocations, including one compiled dictionary, were
**270–474 KiB**, versus SSH's **262 KiB**; decoder allocations were **129 KiB**
versus **39 KiB**. The compiled dictionary can be shared across connections.
The larger dictionary candidate did worse on every held-out workload at level 3.
[All levels without dictionaries, size sensitivity and raw trials](measurements.md).

The large SSH gap needs context: this machine's security-patched SSH uses
**Huffman-only compression**, without repeated-string matching. The historical
dictionary-enabled SSH compressor is much stronger. Continuous zstd level 3
with our dictionary beats that historical control by only **1–18%**, and uses
about **3.14 MiB encoder / 2.50 MiB decoder** memory. Its shared-history behavior
also needs careful reconnect and trust-boundary design.
[SSH patch](https://github.com/openssh/openssh-portable/commit/1d5340fce24526719e32aebc4c721fc228182ace),
[matched history comparison](measurements.md#continuous-history-and-the-historical-ssh-control).

I would prototype **independent zstd at level 1 or 3 with a small preinstalled
dictionary**. Stacking SSH compression on top increased payload size by
**0.3–2.3%** here. Compression does not eliminate redundant protocol work;
metadata/delta cleanup can still reduce serialization and message overhead.
Shipping this would require a larger training corpus and a fresh live
throughput/recovery evaluation. [Reproduction playbook](README.md),
[raw artifact archive](../../../../dist/remote-zstd-20261108.tar.gz),
[artifact hashes](evidence/artifacts.json).
