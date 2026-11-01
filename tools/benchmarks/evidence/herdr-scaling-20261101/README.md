# Herdr scaling evidence

See [the findings](../../herdr_scaling_findings.md) for the interpretation,
measurement contract and remaining performance gap.

`summary.json` contains 36 daemon/viewer process observations, all 18 trial
acceptance/noise receipts, four telemetry runs and excerpts from eight
Bun profiles. CPU comparisons exclude profiling overhead. Telemetry wall spans
overlap and must not be added as CPU attribution. Child CPU and memory remain
separate from process CPU totals.

`validation.json` retains successful checks, failures, the unchanged-main
reproduction of the away-usage timeout, visual equivalence and build hashes.
It does not claim an entirely green integration run. The validation wrapper
and compiler use different path ordering for their source digests; the receipt
identifies both. Measured and rebuilt compiler source/native hashes match.

Raw data, scripts, binaries, profiles, screenshots and logs were kept on the
benchmark machine and are not in the repository. The files here retain their
source paths and hashes.
