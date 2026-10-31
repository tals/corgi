#!/usr/bin/env python3
"""Strict baseline-versus-candidate Corgi ABBA, with default features on both."""
import argparse
from pathlib import Path
import corgi_costs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output", type=Path)
    corgi_costs.arguments(parser)
    args = parser.parse_args()
    corgi_costs.run(args, corgi_costs.Plan(
        variants=(corgi_costs.Variant("baseline", args.baseline),
                  corgi_costs.Variant("candidate", args.candidate)),
        protocol="corgi-default-balanced-v1",
        purpose="Immutable Corgi baseline/candidate with default intensity50 and resource sampling on",
        limits="Shared host; CPU is percent of one core. One block is one contrast; report ranges. This does not compare products. Frequency is diagnostic only.",
        harness="cpu.ts", entrypoint="corgi_compare.py",
    ))


if __name__ == "__main__":
    main()
