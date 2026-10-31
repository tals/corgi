#!/usr/bin/env python3
"""Same-binary optional-feature attribution; not a Herdr parity comparison."""
import argparse
from pathlib import Path
import corgi_costs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    corgi_costs.arguments(parser)
    args = parser.parse_args()
    corgi_costs.run(args, corgi_costs.Plan(
        variants=(corgi_costs.Variant("default", args.binary),
                  corgi_costs.Variant("quiet", args.binary, intensity=0, resources=False)),
        protocol="feature-attribution-v2",
        purpose="Extra-feature attribution; intensity0/resources-off retains informative spinners",
        limits="Shared host; CPU is percent of one core. Quiet is not animation-free and cannot establish default product parity. Frequency is diagnostic only.",
        harness="feature_cpu.ts", entrypoint="feature_costs.py", extra_harnesses=("feature_progress.ts",),
    ))


if __name__ == "__main__":
    main()
