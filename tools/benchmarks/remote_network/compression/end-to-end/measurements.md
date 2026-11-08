# Full end-to-end measurements

Values are trial medians with [minimum–maximum] over three independent repetitions. p95 screen age is computed over wall time, including freezes, then summarized across trials. Input counts are visible echoes / independent producer receipts; each stream case sends 15 inputs across three repetitions.

[Main machine-readable summary](evidence/main/summary.json) · [20 ms summary](evidence/fast/summary.json) · [per-trial main records](evidence/main/trials.json) · [20 ms trial records](evidence/fast/trials.json). Stock arms retain the installed SSH client’s compression.

## Throughput, freshness and catch-up

Catch-up is measured after lifting the cap/loss. The 300 ms and 20 ms profiles change an already established 120 ms path.

| Scenario | Arm | Updates/s | p95 screen age, s | Catch-up, s | Visible / received inputs |
| --- | --- | ---: | ---: | ---: | ---: |
| dense, 1mbit, 120 ms | Corgi identity | 19.93 [19.87–20.00] | 0.15 [0.13–0.16] | 0.09 [0.09–0.11] | 15 / 15 |
| dense, 1mbit, 120 ms | Herdr identity | 20.00 [20.00–20.00] | 0.11 [0.10–0.14] | 0.10 [0.10–0.10] | 15 / 15 |
| sparse, 1mbit, 120 ms | Corgi identity | 20.00 [19.43–20.00] | 0.11 [0.10–0.13] | 0.10 [0.09–0.11] | 15 / 15 |
| sparse, 1mbit, 120 ms | Herdr identity | 20.00 [20.00–20.00] | 0.09 [0.08–0.11] | 0.10 [0.09–0.10] | 15 / 15 |
| dense, 1mbit, 120 ms | Corgi + SSH -C | 20.00 [19.97–20.00] | 0.13 [0.13–0.15] | 0.09 [0.08–0.10] | 15 / 15 |
| dense, 1mbit, 120 ms | Corgi + zstd | 20.00 [19.93–20.00] | 0.12 [0.09–0.14] | 0.09 [0.06–0.09] | 15 / 15 |
| dense, 1mbit, 120 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.10 [0.10–0.12] | 0.07 [0.07–0.10] | 15 / 15 |
| dense, 1mbit, 120 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.11 [0.11–0.12] | 0.10 [0.09–0.10] | 15 / 15 |
| dense, 256kbit, 120 ms | Corgi + SSH -C | 7.83 [7.83–7.90] | 0.34 [0.33–0.36] | 0.12 [0.11–0.13] | 15 / 15 |
| dense, 256kbit, 120 ms | Corgi + zstd | 15.67 [15.63–15.70] | 0.18 [0.18–0.20] | 0.09 [0.07–0.09] | 15 / 15 |
| dense, 256kbit, 120 ms | Herdr + SSH -C | 6.27 [6.13–6.33] | 22.62 [21.45–23.20] | 1.08 [0.96–1.10] | 6 / 15 |
| dense, 256kbit, 120 ms | Herdr + zstd | 11.43 [11.43–11.50] | 14.44 [13.15–14.50] | 1.12 [1.09–1.21] | 9 / 15 |
| dense, 64kbit, 120 ms | Corgi + SSH -C | 1.90 [1.87–1.90] | 1.54 [1.53–1.54] | 0.15 [0.11–0.16] | 15 / 15 |
| dense, 64kbit, 120 ms | Corgi + zstd | 4.10 [4.10–4.13] | 0.68 [0.66–0.70] | 0.12 [0.11–0.12] | 15 / 15 |
| dense, 64kbit, 120 ms | Herdr + SSH -C | 1.13 [1.00–1.17] | 30.85 [30.62–30.94] | 0.88 [0.88–0.90] | 0 / 15 |
| dense, 64kbit, 120 ms | Herdr + zstd | 2.27 [2.20–2.27] | 28.67 [28.64–28.80] | 2.41 [2.35–2.68] | 0 / 15 |
| dense, uncapped, 120 ms | Corgi + SSH -C | 20.00 [20.00–20.00] | 0.11 [0.08–0.12] | 0.07 [0.07–0.12] | 15 / 15 |
| dense, uncapped, 120 ms | Corgi + zstd | 20.00 [19.90–20.00] | 0.11 [0.10–0.11] | 0.08 [0.07–0.08] | 15 / 15 |
| dense, uncapped, 120 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.11 [0.09–0.11] | 0.10 [0.10–0.11] | 15 / 15 |
| dense, uncapped, 120 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.10 [0.09–0.11] | 0.09 [0.08–0.09] | 15 / 15 |
| sparse, 1mbit, 120 ms | Corgi + SSH -C | 20.00 [20.00–20.00] | 0.12 [0.09–0.12] | 0.10 [0.06–0.10] | 15 / 15 |
| sparse, 1mbit, 120 ms | Corgi + zstd | 20.00 [20.00–20.00] | 0.13 [0.10–0.13] | 0.11 [0.09–0.11] | 15 / 15 |
| sparse, 1mbit, 120 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.10 [0.07–0.11] | 0.09 [0.07–0.11] | 15 / 15 |
| sparse, 1mbit, 120 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.08 [0.07–0.09] | 0.11 [0.07–0.11] | 15 / 15 |
| sparse, 64kbit, 120 ms | Corgi + SSH -C | 6.40 [6.40–6.40] | 0.62 [0.62–0.64] | 0.10 [0.09–0.12] | 15 / 15 |
| sparse, 64kbit, 120 ms | Corgi + zstd | 19.90 [19.90–20.00] | 0.11 [0.11–0.11] | 0.09 [0.08–0.11] | 15 / 15 |
| sparse, 64kbit, 120 ms | Herdr + SSH -C | 14.00 [13.87–14.00] | 7.25 [7.20–7.25] | 0.11 [0.11–0.16] | 13 / 15 |
| sparse, 64kbit, 120 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.09 [0.09–0.11] | 0.08 [0.06–0.09] | 15 / 15 |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Corgi + SSH -C | 17.67 [17.23–17.67] | 0.21 [0.19–0.22] | 0.08 [0.07–0.08] | 15 / 15 |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Corgi + zstd | 18.10 [17.83–18.27] | 0.19 [0.19–0.23] | 0.08 [0.07–0.19] | 15 / 15 |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Herdr + SSH -C | 19.57 [19.37–19.90] | 0.10 [0.10–0.16] | 0.10 [0.09–0.11] | 15 / 15 |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Herdr + zstd | 19.73 [19.27–19.83] | 0.11 [0.10–0.15] | 0.08 [0.07–0.10] | 15 / 15 |
| dense, 1mbit, 20 ms | Corgi + SSH -C | 20.00 [20.00–20.00] | 0.04 [0.04–0.07] | 0.03 [0.02–0.06] | 15 / 15 |
| dense, 1mbit, 20 ms | Corgi + zstd | 20.00 [20.00–20.00] | 0.03 [0.03–0.04] | 0.02 [0.02–0.02] | 15 / 15 |
| dense, 1mbit, 20 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.05 [0.05–0.07] | 0.02 [0.02–0.05] | 15 / 15 |
| dense, 1mbit, 20 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.05 [0.04–0.06] | 0.04 [0.02–0.06] | 15 / 15 |
| dense, uncapped, 20 ms | Corgi + SSH -C | 20.00 [19.97–20.03] | 0.02 [0.01–0.03] | 0.03 [0.02–0.04] | 15 / 15 |
| dense, uncapped, 20 ms | Corgi + zstd | 20.00 [20.00–20.00] | 0.05 [0.05–0.06] | 0.05 [0.05–0.05] | 15 / 15 |
| dense, uncapped, 20 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.05 [0.04–0.06] | 0.05 [0.02–0.05] | 15 / 15 |
| dense, uncapped, 20 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.05 [0.05–0.06] | 0.05 [0.03–0.06] | 15 / 15 |
| sparse, uncapped, 20 ms | Corgi + SSH -C | 20.00 [19.83–20.00] | 0.04 [0.03–0.05] | 0.05 [0.03–0.06] | 15 / 15 |
| sparse, uncapped, 20 ms | Corgi + zstd | 19.97 [19.97–20.00] | 0.03 [0.02–0.04] | 0.03 [0.02–0.05] | 15 / 15 |
| sparse, uncapped, 20 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.03 [0.02–0.06] | 0.04 [0.03–0.05] | 15 / 15 |
| sparse, uncapped, 20 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.01 [0.01–0.04] | 0.05 [0.04–0.05] | 15 / 15 |
| dense, 1mbit, 300 ms | Corgi + SSH -C | 6.20 [6.17–6.20] | 0.42 [0.38–0.44] | 0.29 [0.19–0.34] | 15 / 15 |
| dense, 1mbit, 300 ms | Corgi + zstd | 6.53 [6.53–6.53] | 0.35 [0.31–0.36] | 0.26 [0.20–0.32] | 15 / 15 |
| dense, 1mbit, 300 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.20 [0.19–0.23] | 0.16 [0.16–0.19] | 15 / 15 |
| dense, 1mbit, 300 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.20 [0.17–0.21] | 0.19 [0.17–0.19] | 15 / 15 |
| sparse, 1mbit, 300 ms | Corgi + SSH -C | 9.87 [9.77–9.90] | 0.33 [0.28–0.36] | 0.20 [0.18–0.20] | 15 / 15 |
| sparse, 1mbit, 300 ms | Corgi + zstd | 9.90 [9.73–9.90] | 0.35 [0.30–0.38] | 0.29 [0.23–0.34] | 15 / 15 |
| sparse, 1mbit, 300 ms | Herdr + SSH -C | 20.00 [20.00–20.00] | 0.17 [0.16–0.19] | 0.16 [0.16–0.19] | 15 / 15 |
| sparse, 1mbit, 300 ms | Herdr + zstd | 20.00 [20.00–20.00] | 0.19 [0.17–0.19] | 0.18 [0.16–0.19] | 15 / 15 |

## Traffic

Total is downstream plus upstream on the selected machine’s link, including SSH/TCP overhead and retransmissions. Bytes/update divides total link traffic by displayed updates; it is not serialized frame size. Directional medians need not sum to the total median.

| Scenario | Arm | Down kbit/s | Up kbit/s | Total kbit/s | Bytes/update |
| --- | --- | ---: | ---: | ---: | ---: |
| dense, 1mbit, 120 ms | Corgi identity | 655.9 [653.1–657.9] | 54.3 [53.3–54.5] | 710.2 [706.3–712.4] | 4452 [4444–4454] |
| dense, 1mbit, 120 ms | Herdr identity | 842.2 [839.4–842.9] | 29.5 [29.4–29.5] | 871.7 [868.8–872.4] | 5448 [5430–5453] |
| sparse, 1mbit, 120 ms | Corgi identity | 210.5 [207.2–211.7] | 45.0 [43.9–45.3] | 255.8 [251.1–256.7] | 1605 [1599–1615] |
| sparse, 1mbit, 120 ms | Herdr identity | 73.8 [73.7–73.8] | 11.1 [5.7–11.1] | 84.8 [79.5–84.9] | 530 [497–530] |
| dense, 1mbit, 120 ms | Corgi + SSH -C | 654.7 [654.5–656.3] | 53.5 [53.3–54.1] | 708.2 [707.8–710.4] | 4431 [4426–4440] |
| dense, 1mbit, 120 ms | Corgi + zstd | 321.3 [320.5–321.7] | 33.1 [33.0–33.1] | 354.4 [353.5–354.8] | 2218 [2210–2222] |
| dense, 1mbit, 120 ms | Herdr + SSH -C | 843.3 [841.6–845.1] | 29.5 [29.4–29.5] | 872.7 [871.0–874.5] | 5454 [5444–5466] |
| dense, 1mbit, 120 ms | Herdr + zstd | 429.1 [428.3–430.0] | 12.5 [12.1–12.6] | 441.7 [440.4–442.4] | 2761 [2753–2765] |
| dense, 256kbit, 120 ms | Corgi + SSH -C | 255.9 [255.4–256.1] | 19.9 [19.9–20.5] | 275.9 [275.8–276.0] | 4403 [4363–4404] |
| dense, 256kbit, 120 ms | Corgi + zstd | 243.5 [242.9–244.8] | 27.4 [27.1–27.9] | 270.9 [270.0–272.7] | 2166 [2154–2171] |
| dense, 256kbit, 120 ms | Herdr + SSH -C | 255.7 [255.4–256.4] | 14.6 [13.4–15.9] | 271.0 [269.0–271.3] | 5412 [5310–5522] |
| dense, 256kbit, 120 ms | Herdr + zstd | 255.9 [255.5–256.3] | 12.2 [11.9–12.9] | 268.1 [267.4–269.2] | 2926 [2923–2931] |
| dense, 64kbit, 120 ms | Corgi + SSH -C | 63.7 [63.7–64.0] | 8.0 [8.0–8.1] | 71.8 [71.6–72.0] | 4736 [4723–4798] |
| dense, 64kbit, 120 ms | Corgi + zstd | 64.2 [63.8–64.3] | 9.0 [8.9–9.1] | 73.1 [72.9–73.3] | 2228 [2203–2234] |
| dense, 64kbit, 120 ms | Herdr + SSH -C | 63.9 [63.7–64.3] | 3.9 [3.8–4.0] | 67.7 [67.6–68.3] | 7534 [7252–8449] |
| dense, 64kbit, 120 ms | Herdr + zstd | 63.9 [63.8–64.2] | 4.0 [3.8–4.0] | 67.9 [67.6–68.2] | 3763 [3728–3858] |
| dense, uncapped, 120 ms | Corgi + SSH -C | 663.8 [662.8–663.9] | 47.6 [47.5–47.8] | 711.5 [710.4–711.6] | 4447 [4440–4447] |
| dense, uncapped, 120 ms | Corgi + zstd | 323.0 [322.4–324.0] | 32.9 [32.6–33.0] | 356.1 [354.9–356.9] | 2229 [2225–2230] |
| dense, uncapped, 120 ms | Herdr + SSH -C | 843.7 [843.7–845.2] | 33.3 [32.2–34.1] | 877.0 [875.9–879.3] | 5481 [5475–5495] |
| dense, uncapped, 120 ms | Herdr + zstd | 430.1 [429.1–431.0] | 12.8 [12.5–12.8] | 442.9 [441.5–443.8] | 2768 [2759–2774] |
| sparse, 1mbit, 120 ms | Corgi + SSH -C | 211.1 [210.8–211.2] | 45.1 [45.1–45.2] | 256.3 [255.9–256.3] | 1602 [1599–1602] |
| sparse, 1mbit, 120 ms | Corgi + zstd | 47.1 [46.7–47.2] | 30.8 [30.7–30.8] | 77.8 [77.4–78.0] | 487 [484–487] |
| sparse, 1mbit, 120 ms | Herdr + SSH -C | 73.7 [73.5–73.7] | 5.7 [5.7–5.8] | 79.4 [79.2–79.5] | 497 [495–497] |
| sparse, 1mbit, 120 ms | Herdr + zstd | 27.4 [27.4–27.4] | 11.0 [5.7–11.2] | 38.4 [33.1–38.6] | 240 [207–241] |
| sparse, 64kbit, 120 ms | Corgi + SSH -C | 63.9 [63.8–64.1] | 13.6 [13.6–13.8] | 77.5 [77.4–78.0] | 1514 [1511–1523] |
| sparse, 64kbit, 120 ms | Corgi + zstd | 46.9 [46.8–47.1] | 30.7 [30.6–31.0] | 77.6 [77.4–78.1] | 488 [486–488] |
| sparse, 64kbit, 120 ms | Herdr + SSH -C | 64.0 [64.0–64.1] | 6.8 [6.5–7.4] | 70.7 [70.5–71.4] | 638 [630–638] |
| sparse, 64kbit, 120 ms | Herdr + zstd | 27.4 [26.7–27.7] | 5.9 [5.8–11.1] | 33.5 [33.3–37.8] | 209 [208–236] |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Corgi + SSH -C | 193.9 [192.1–195.6] | 42.8 [42.8–43.7] | 236.7 [234.9–239.4] | 1694 [1675–1704] |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Corgi + zstd | 43.2 [42.8–43.4] | 29.9 [29.9–30.7] | 73.1 [72.7–74.1] | 507 [505–510] |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Herdr + SSH -C | 73.9 [73.4–74.0] | 7.2 [6.6–7.3] | 81.0 [80.0–81.4] | 518 [502–525] |
| sparse, uncapped, 120 ms + 1% loss/10 ms jitter | Herdr + zstd | 27.6 [27.2–27.6] | 8.5 [7.4–8.8] | 35.7 [35.0–36.4] | 231 [221–232] |
| dense, 1mbit, 20 ms | Corgi + SSH -C | 664.9 [664.5–669.8] | 57.7 [57.6–57.8] | 722.7 [722.1–727.7] | 4517 [4513–4548] |
| dense, 1mbit, 20 ms | Corgi + zstd | 324.7 [324.7–326.6] | 33.7 [33.6–33.8] | 358.4 [358.4–360.4] | 2240 [2240–2253] |
| dense, 1mbit, 20 ms | Herdr + SSH -C | 843.1 [842.8–844.5] | 29.6 [29.5–29.6] | 872.6 [872.4–874.1] | 5454 [5453–5463] |
| dense, 1mbit, 20 ms | Herdr + zstd | 430.3 [429.3–436.2] | 12.9 [12.3–14.3] | 443.3 [441.6–450.5] | 2770 [2760–2816] |
| dense, uncapped, 20 ms | Corgi + SSH -C | 664.9 [663.7–668.4] | 48.3 [48.0–48.3] | 712.9 [712.0–716.6] | 4450 [4448–4487] |
| dense, uncapped, 20 ms | Corgi + zstd | 324.7 [324.1–325.2] | 33.3 [33.2–33.3] | 357.9 [357.5–358.4] | 2237 [2234–2240] |
| dense, uncapped, 20 ms | Herdr + SSH -C | 842.3 [839.7–843.7] | 33.3 [33.2–34.3] | 875.5 [874.0–876.9] | 5472 [5463–5480] |
| dense, uncapped, 20 ms | Herdr + zstd | 431.5 [428.4–435.6] | 12.8 [12.2–13.8] | 444.3 [440.6–449.4] | 2777 [2754–2809] |
| sparse, uncapped, 20 ms | Corgi + SSH -C | 212.5 [212.4–212.7] | 45.9 [45.7–45.9] | 258.4 [258.1–258.6] | 1616 [1615–1627] |
| sparse, uncapped, 20 ms | Corgi + zstd | 48.7 [48.7–48.7] | 31.3 [31.3–31.4] | 80.0 [80.0–80.1] | 501 [500–502] |
| sparse, uncapped, 20 ms | Herdr + SSH -C | 73.5 [73.4–73.6] | 5.7 [5.7–11.1] | 79.3 [79.2–84.6] | 496 [495–529] |
| sparse, uncapped, 20 ms | Herdr + zstd | 27.4 [27.2–27.5] | 11.1 [11.0–11.2] | 38.5 [38.2–38.5] | 241 [239–241] |
| dense, 1mbit, 300 ms | Corgi + SSH -C | 203.4 [203.2–205.4] | 17.6 [17.4–17.7] | 220.9 [220.8–223.0] | 4453 [4452–4521] |
| dense, 1mbit, 300 ms | Corgi + zstd | 101.3 [100.9–102.0] | 12.0 [12.0–12.0] | 113.4 [113.0–114.0] | 2169 [2162–2182] |
| dense, 1mbit, 300 ms | Herdr + SSH -C | 844.8 [843.6–845.6] | 29.5 [29.2–29.6] | 874.3 [872.9–875.1] | 5465 [5455–5469] |
| dense, 1mbit, 300 ms | Herdr + zstd | 430.0 [423.4–430.3] | 12.6 [12.3–12.7] | 442.3 [436.0–443.1] | 2765 [2725–2769] |
| sparse, 1mbit, 300 ms | Corgi + SSH -C | 97.0 [96.9–97.3] | 19.7 [19.7–19.9] | 116.7 [116.6–117.3] | 1481 [1477–1493] |
| sparse, 1mbit, 300 ms | Corgi + zstd | 15.9 [15.8–15.9] | 12.0 [12.0–12.2] | 27.9 [27.9–28.0] | 352 [352–359] |
| sparse, 1mbit, 300 ms | Herdr + SSH -C | 73.6 [73.5–74.1] | 11.0 [11.0–11.1] | 84.6 [84.6–85.2] | 529 [528–533] |
| sparse, 1mbit, 300 ms | Herdr + zstd | 27.5 [27.1–27.6] | 11.0 [5.7–11.3] | 38.0 [33.2–38.9] | 238 [208–243] |

## Connection startup

Each cell is fresh remote screen / usable input echo, seconds. These exclude installation/daemon startup and include the observer’s terminal-capability timeout.

| RTT / connection | Corgi + SSH -C | Corgi + zstd | Herdr + SSH -C | Herdr + zstd |
| --- | ---: | ---: | ---: | ---: |
| 20 ms / cold | 1.12 [1.01–1.14] / 1.17 [1.11–1.19] | 1.14 [1.13–1.15] / 1.22 [1.20–1.24] | 1.34 [1.33–1.35] / 1.53 [1.50–1.54] | 1.32 [1.31–1.32] / 1.50 [1.49–1.51] |
| 20 ms / warm | 0.61 [0.61–0.63] / 0.69 [0.68–0.72] | 0.68 [0.67–0.68] / 0.78 [0.77–0.79] | 0.82 [0.82–0.93] / 1.01 [0.98–1.02] | 0.92 [0.89–0.92] / 1.01 [0.99–1.01] |
| 120 ms / cold | 2.93 [2.92–2.94] / 3.11 [3.10–3.11] | 2.97 [2.96–2.98] / 3.18 [3.13–3.19] | 3.83 [3.81–3.89] / 4.33 [4.29–4.34] | 3.81 [3.81–3.81] / 4.20 [4.19–4.23] |
| 120 ms / warm | 1.51 [1.51–1.52] / 1.70 [1.68–1.70] | 1.57 [1.57–1.58] / 1.77 [1.75–1.78] | 2.37 [2.36–2.37] / 2.91 [2.77–3.03] | 2.37 [2.36–2.49] / 2.79 [2.75–2.87] |
| 300 ms / cold | 6.34 [6.34–6.39] / 6.73 [6.69–6.73] | 6.40 [6.39–6.40] / 6.78 [6.75–6.78] | 8.87 [8.53–8.88] / 9.57 [9.46–9.58] | 8.32 [8.32–8.34] / 9.28 [9.25–9.36] |
| 300 ms / warm | 3.13 [3.13–3.15] / 3.50 [3.49–3.51] | 3.19 [3.19–3.20] / 3.56 [3.56–3.56] | 5.07 [5.07–5.08] / 6.30 [6.03–6.30] | 5.19 [5.19–5.20] / 6.13 [6.11–6.25] |

## Outages and client freeze

Times start at restoration/wake, rather than at the start of the outage. Fresh recovery requires a new complete screen; usable recovery additionally requires a new input echo. During/late are independent producer receipt counts out of three sent tokens each; late input is sent eight seconds into long outages. A dash means no late token was scheduled. The sleep column uses the input queued just before client freeze.

| Scenario | Arm | Fresh, s | Usable, s | During / late receipts |
| --- | --- | ---: | ---: | ---: |
| faults-sparse / tcp_reset | Corgi + SSH -C | 2.21 [2.17–2.23] | 2.38 [2.36–2.40] | — / — |
| faults-sparse / blackhole3 | Corgi + SSH -C | 2.50 [2.49–2.50] | 2.70 [2.68–2.76] | 3 / — |
| faults-sparse / blackhole35 | Corgi + SSH -C | 2.76 [2.42–2.79] | 2.95 [2.61–2.97] | 3 / 0 |
| faults-sparse / downstream15 | Corgi + SSH -C | 2.63 [2.60–2.67] | 2.79 [2.77–2.87] | 3 / 0 |
| faults-sparse / isolated30 | Corgi + SSH -C | 3.86 [3.69–4.00] | 4.04 [3.98–4.31] | 1 / — |
| faults-sparse / tcp_reset | Corgi + zstd | 2.26 [2.25–2.27] | 2.43 [2.42–2.45] | — / — |
| faults-sparse / blackhole3 | Corgi + zstd | 2.48 [2.36–2.52] | 2.69 [2.63–2.77] | 3 / — |
| faults-sparse / blackhole35 | Corgi + zstd | 2.36 [2.29–2.46] | 2.51 [2.46–2.64] | 3 / 0 |
| faults-sparse / downstream15 | Corgi + zstd | 2.53 [2.43–2.57] | 2.70 [2.61–2.75] | 3 / 0 |
| faults-sparse / isolated30 | Corgi + zstd | 3.67 [3.61–3.73] | 3.90 [3.85–3.92] | 2 / — |
| faults-sparse / tcp_reset | Herdr + SSH -C | 4.18 [4.11–4.21] | 4.67 [4.50–4.74] | — / — |
| faults-sparse / blackhole3 | Herdr + SSH -C | 1.12 [0.75–1.12] | 1.26 [0.94–1.30] | 3 / — |
| faults-sparse / blackhole35 | Herdr + SSH -C | 14.14 [13.05–18.38] | 14.52 [13.57–19.02] | 3 / 2 |
| faults-sparse / downstream15 | Herdr + SSH -C | 11.56 [10.32–13.91] | 12.10 [10.98–14.46] | 3 / 1 |
| faults-sparse / isolated30 | Herdr + SSH -C | 24.03 [19.73–24.03] | 24.41 [20.26–24.55] | 3 / — |
| faults-sparse / tcp_reset | Herdr + zstd | 4.08 [4.03–4.12] | 4.55 [4.47–4.55] | — / — |
| faults-sparse / blackhole3 | Herdr + zstd | 0.40 [0.37–0.42] | 0.55 [0.52–0.55] | 3 / — |
| faults-sparse / blackhole35 | Herdr + zstd | 13.04 [12.98–16.04] | 13.49 [13.44–16.41] | 3 / 3 |
| faults-sparse / downstream15 | Herdr + zstd | 9.90 [9.43–12.75] | 10.30 [9.81–13.26] | 3 / 3 |
| faults-sparse / isolated30 | Herdr + zstd | 23.91 [19.62–23.92] | 24.42 [20.01–24.45] | 3 / — |
| faults-dense / blackhole3 | Corgi + SSH -C | 2.48 [2.35–2.51] | 2.65 [2.65–2.76] | 3 / — |
| faults-dense / blackhole35 | Corgi + SSH -C | 2.57 [2.45–2.65] | 2.76 [2.61–2.80] | 3 / 0 |
| faults-dense / blackhole3 | Corgi + zstd | 2.48 [2.44–2.57] | 2.77 [2.71–2.84] | 3 / — |
| faults-dense / blackhole35 | Corgi + zstd | 2.39 [2.33–2.54] | 2.55 [2.48–2.70] | 3 / 0 |
| faults-dense / blackhole3 | Herdr + SSH -C | 3.65 [0.73–3.75] | 3.91 [0.91–3.92] | 3 / — |
| faults-dense / blackhole35 | Herdr + SSH -C | 12.75 [12.70–13.10] | 13.40 [13.34–13.60] | 0 / 0 |
| faults-dense / blackhole3 | Herdr + zstd | 1.40 [1.01–1.45] | 1.66 [1.18–1.70] | 3 / — |
| faults-dense / blackhole35 | Herdr + zstd | 14.39 [14.20–14.45] | 14.79 [14.60–14.85] | 3 / 0 |
| sleep / sleep | Corgi + SSH -C | 2.41 [2.41–2.47] | 2.59 [2.58–2.63] | 3 / — |
| sleep / sleep | Corgi + zstd | 2.34 [2.34–2.36] | 2.53 [2.52–2.54] | 3 / — |
| sleep / sleep | Herdr + SSH -C | 43.97 [43.58–44.60] | 44.37 [43.97–44.99] | 3 / — |
| sleep / sleep | Herdr + zstd | 43.99 [43.29–63.97] | 44.38 [43.68–64.39] | 3 / — |

All sleep trials retained the same eight remote producer PIDs with advancing CPU counters; all queued pre-sleep tokens were received once. Outage producer continuity and per-probe receipts are retained in the trial JSON. Inputs typed while a product considers a remote disconnected are not durably queued by this experiment. Lower receipt counts above are retained outcomes, not excluded trials.

The sleep case combines a process freeze, dead server TCP connections and an unacknowledged pending write. It is not generic laptop wake. The [follow-up diagnostic audit](../../latency-and-freeze/report.md) isolates Herdr's stuck shared SSH master and a timeout waiting on pipes retained by that master. Without the pending write, the stock-Herdr control recovered in 4.77 s median. The original values above remain unchanged; diagnostic trials are not pooled into them.

## Other machines during a selected-machine outage

Unique input echo time from switching to the unaffected machine; medians [range], seconds.

| Arm | Local | Other remote |
| --- | ---: | ---: |
| Corgi + SSH -C | 0.08 [0.07–0.12] | 0.63 [0.61–0.69] |
| Corgi + zstd | 0.10 [0.08–0.10] | 0.60 [0.58–0.61] |
| Herdr + SSH -C | 0.17 [0.10–0.20] | 0.65 [0.65–0.68] |
| Herdr + zstd | 0.20 [0.17–0.21] | 0.68 [0.66–0.68] |

## Adapter controls and limits

Identity arms use the same external process/pipe arrangement with no codec and normal SSH compression. Their stream results appear above. They preserve approximately 20 updates/s; packetization and ACK timing can still change traffic and screen-age measurements. Use these as an adapter-overhead control, not as evidence that future in-process integration has zero overhead.

No source or binary was changed in either product. No trained dictionary or test-corpus training was used. The adapter flushes each naturally received chunk, so this includes real transport packetization rather than multiplying an offline compression ratio by old bandwidth. Three repetitions and synthetic workloads do not characterize all Internet outage timings. The 180-second freeze is a process/network simulation, not actual hardware suspend.

[Main audit](evidence/main/audit.json) · [20 ms audit](evidence/fast/audit.json) · [environment](evidence/environment.json) · [SSH negotiation](evidence/ssh-negotiation.txt) · [reproduce](README.md).
