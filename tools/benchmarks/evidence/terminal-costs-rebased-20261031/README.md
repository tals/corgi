# Rebased terminal performance evidence

The [CPU summary](summary.md) ([JSON](summary.json)) compares main
`e83e7090f241927960bf65c294ac7abaebb69dc2` with candidate
`6dd1078`, the branch rebased onto that main. Both are frozen production
builds. The [plan](plan.json) records binaries, harness hashes and settings;
the [placement receipt](placement.json) records the quiet-CPU check.

This run is shorter than the earlier matrix: 8 and 64 agents only, with
15-second warmups and 30-second samples instead of 30 and 60. Shorter samples
are noisier. Every leg was accepted on its first attempt.

The host was busy with unrelated work. For the run, the user's other
processes were restricted to CPUs outside the measured L3 group (NUMA 1,
CPUs 120–127 and SMT siblings 248–255), and restored afterwards. The usual 2%
sibling-load gate applied unchanged.

Paths embedded in the JSON refer to local raw artifacts, which are not
included here.
