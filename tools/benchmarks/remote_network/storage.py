"""Local benchmark paths; no storage requests run inside a measurement window."""
import datetime
import os
from pathlib import Path
import uuid

REPOSITORY = Path(__file__).resolve().parents[3]


def external(value):
    directory = Path(value).expanduser().resolve()
    if directory.is_relative_to(REPOSITORY):
        raise ValueError("Benchmark data must be outside the checkout; use the benchmark cache")
    return directory


def cache():
    return external(os.environ.get("CORGI_BENCHMARK_CACHE", str(
        Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "corgi/benchmarks"
    )))


def run(label):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    return cache() / f"{stamp}-{label}-{uuid.uuid4().hex[:8]}"
