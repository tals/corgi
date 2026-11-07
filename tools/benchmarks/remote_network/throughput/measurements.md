# Throughput and backpressure measurements

Median [min–max] across three independent trials unless stated otherwise. Each producer emits 20 updates/s; delivered updates cannot exceed that ceiling. Before and after use the same native library; Herdr is the unchanged v0.9.5 release.

## 20 ms RTT

[Individual trials](stream-20/evidence/trials.csv) · [Full distributions](stream-20/evidence/summary.json) · [Audit](stream-20/evidence/audit.json)

### Delivered updates/s

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 20.000 [20.000–20.000] | 20.000 [20.000–20.000] | 20.000 [20.000–20.000] |
| dense / 1mbit | 20.000 [20.000–20.000] | 20.000 [19.967–20.000] | 20.000 [20.000–20.000] |

### Displayed-screen age, wall-time p95 (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 0.024 [0.017–0.036] | 0.047 [0.016–0.062] | 0.046 [0.040–0.058] |
| dense / 1mbit | 0.041 [0.041–0.082] | 0.044 [0.035–0.080] | 0.061 [0.056–0.087] |

### Catch-up after cap removal (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 0.019 [0.013–0.037] | 0.036 [0.020–0.036] | 0.035 [0.013–0.055] |
| dense / 1mbit | 0.039 [0.026–0.045] | 0.018 [0.016–0.045] | 0.040 [0.038–0.058] |

### Downstream traffic (kbit/s)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 664.271 [664.059–665.384] | 664.476 [664.058–664.679] | 843.700 [843.494–843.749] |
| dense / 1mbit | 664.492 [663.538–664.679] | 663.990 [663.450–664.875] | 843.555 [843.554–844.262] |

### Input echoes visible within the measurement window

Visible / independently received. Each cell has 15 sent probes. Missing visible echoes remain missing; they are not treated as fast inputs.

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 15 / 15 | 15 / 15 | 15 / 15 |
| dense / 1mbit | 15 / 15 | 15 / 15 | 15 / 15 |

## 120 ms RTT

[Individual trials](stream-120/evidence/trials.csv) · [Full distributions](stream-120/evidence/summary.json) · [Audit](stream-120/evidence/audit.json)

### Delivered updates/s

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 16.133 [16.100–16.200] | 20.000 [19.767–20.000] | 20.000 [20.000–20.000] |
| dense / 1mbit | 13.967 [13.900–14.033] | 19.967 [19.967–20.000] | 20.000 [20.000–20.000] |
| dense / 256kbit | 7.867 [7.867–7.867] | 7.867 [7.867–7.900] | 5.867 [5.300–6.133] |
| dense / 64kbit | 1.900 [1.900–1.900] | 1.900 [1.900–1.900] | 1.067 [1.000–1.533] |
| sparse / 64kbit | 6.400 [6.400–6.400] | 6.433 [6.400–6.433] | 14.100 [14.067–14.367] |
| sparse / unlimited / 1% loss + 10 ms jitter | 18.067 [17.467–18.300] | 17.633 [17.633–18.100] | 19.600 [19.433–19.700] |

### Displayed-screen age, wall-time p95 (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 0.145 [0.141–0.162] | 0.099 [0.097–0.132] | 0.109 [0.106–0.113] |
| dense / 1mbit | 0.190 [0.187–0.208] | 0.154 [0.138–0.161] | 0.107 [0.103–0.122] |
| dense / 256kbit | 0.330 [0.318–0.361] | 0.345 [0.320–0.353] | 21.648 [21.141–21.864] |
| dense / 64kbit | 1.525 [1.502–1.528] | 1.537 [1.532–1.542] | 30.864 [30.135–31.009] |
| sparse / 64kbit | 0.604 [0.604–0.620] | 0.603 [0.576–0.610] | 7.148 [7.098–7.223] |
| sparse / unlimited / 1% loss + 10 ms jitter | 0.217 [0.184–0.265] | 0.239 [0.207–0.251] | 0.103 [0.094–0.114] |

### Catch-up after cap removal (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 0.103 [0.086–0.130] | 0.078 [0.070–0.095] | 0.086 [0.065–0.108] |
| dense / 1mbit | 0.123 [0.103–0.152] | 0.093 [0.076–0.104] | 0.067 [0.063–0.107] |
| dense / 256kbit | 0.094 [0.094–0.109] | 0.122 [0.121–0.127] | 0.855 [0.742–0.975] |
| dense / 64kbit | 0.125 [0.106–0.174] | 0.206 [0.199–0.225] | 0.883 [0.873–1.081] |
| sparse / 64kbit | 0.118 [0.109–0.172] | 0.130 [0.098–0.139] | 0.120 [0.119–0.157] |
| sparse / unlimited / 1% loss + 10 ms jitter | 0.177 [0.100–0.212] | 0.101 [0.077–0.153] | 0.080 [0.075–0.100] |

### Downstream traffic (kbit/s)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 522.818 [519.774–523.061] | 662.409 [656.941–662.574] | 844.943 [843.547–845.115] |
| dense / 1mbit | 452.418 [450.921–453.101] | 655.204 [654.142–655.389] | 843.675 [843.177–843.828] |
| dense / 256kbit | 256.055 [255.439–256.879] | 256.116 [255.534–256.302] | 255.890 [255.714–256.835] |
| dense / 64kbit | 64.090 [64.058–64.098] | 63.835 [63.717–63.941] | 63.831 [63.610–63.944] |
| sparse / 64kbit | 64.063 [64.032–64.082] | 64.044 [63.722–64.102] | 63.964 [63.740–63.996] |
| sparse / unlimited / 1% loss + 10 ms jitter | 197.555 [192.725–199.626] | 194.418 [192.401–198.995] | 73.653 [73.536–73.714] |

### Input echoes visible within the measurement window

Visible / independently received. Each cell has 15 sent probes. Missing visible echoes remain missing; they are not treated as fast inputs.

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / unlimited | 15 / 15 | 15 / 15 | 15 / 15 |
| dense / 1mbit | 15 / 15 | 15 / 15 | 15 / 15 |
| dense / 256kbit | 15 / 15 | 15 / 15 | 7 / 15 |
| dense / 64kbit | 15 / 15 | 15 / 15 | 0 / 15 |
| sparse / 64kbit | 15 / 15 | 15 / 15 | 12 / 15 |
| sparse / unlimited / loss | 15 / 15 | 15 / 15 | 15 / 15 |

## 300 ms RTT

[Individual trials](stream-300/evidence/trials.csv) · [Full distributions](stream-300/evidence/summary.json) · [Audit](stream-300/evidence/audit.json)

### Delivered updates/s

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / 1mbit | 6.100 [6.033–6.167] | 6.200 [6.167–6.200] | 20.000 [20.000–20.000] |

### Displayed-screen age, wall-time p95 (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / 1mbit | 0.465 [0.382–0.480] | 0.442 [0.415–0.450] | 0.209 [0.208–0.209] |

### Catch-up after cap removal (seconds)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / 1mbit | 0.321 [0.247–0.329] | 0.202 [0.189–0.291] | 0.177 [0.163–0.177] |

### Downstream traffic (kbit/s)

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / 1mbit | 201.190 [199.788–201.437] | 203.258 [201.755–203.869] | 843.685 [843.123–845.931] |

### Input echoes visible within the measurement window

Visible / independently received. Each cell has 15 sent probes. Missing visible echoes remain missing; they are not treated as fast inputs.

| Output / cap | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| dense / 1mbit | 15 / 15 | 15 / 15 | 15 / 15 |

## Outage recovery

Time from restoration to unique remote input echo, with 120 ms RTT. Actual loss duration, fresh-screen timing, independent input receipts and producer continuity are retained per trial.

[Sparse output: all six outage lengths and ranges](faults-sparse/measurements.md) · [Dense output: all six outage lengths and ranges](faults-dense/measurements.md)

## Interpretation limits

The cap-transition maximum over the first four seconds is also retained in each trial CSV. Steady-state lag uses the following 30 seconds. Cap removal keeps the configured RTT. An unlimited profile still has that RTT; it is not a zero-latency control. Streams are established at 120 ms before changing to the requested RTT. Thus the 300 ms result is a 120→300 ms path change: the candidate retains the faster learned baseline and falls back to 16 KiB. It is not a cold stream established at 300 ms.

Input latency distributions exclude unobserved echoes and therefore must be read alongside the visibility counts. Herdr can display more sparse updates while showing substantially older content. Higher update count alone does not imply a more responsive screen.

The same host runs isolated labs on disjoint CPUs. Repeats rotate CPUs within each suite. Three trials characterize these fixed scenarios; they are not a statistical equivalence test or a distribution of Internet conditions. See the [playbook](README.md) for exact scheduling and [raw archives](evidence/artifacts.json) for all observations.
