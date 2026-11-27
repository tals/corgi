"""Haiku 5.5 standard API list-price equivalent, checked 2026-11-08.

Source: https://platform.claude.com/docs/en/about-claude/pricing
These are API-equivalent costs, not Claude Code subscription charges.
"""

from decimal import Decimal

SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
CHECKED = "2026-11-08"
RATES = {
    "input": "0.10",
    "write_5m": "0.125",
    "write_1h": "0.20",
    "read": "0.01",
    "output": "0.50",
}
FIELDS = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
]


def count(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Invalid token count")
    return value


def price(receipts):
    costs = dict.fromkeys(RATES, Decimal(0))
    requests = premium = incomplete = 0
    for receipt in receipts:
        if receipt.get("service_tier", "standard") != "standard":
            raise ValueError("Unsupported service tier")
        if receipt.get("speed", "standard") != "standard":
            raise ValueError("Unsupported inference speed")
        geo = receipt.get("inference_geo", "global")
        if geo not in ["global", "us"]:
            raise ValueError("Unsupported inference geography")
        iterations = receipt.get("iterations") or [receipt]
        complete = all(
            sum(count(i.get(k, 0)) for i in iterations) == count(receipt.get(k, 0))
            for k in FIELDS
        )
        if not complete:
            # Some CLI results list only the final iteration. If the aggregate
            # input is below the threshold, every underlying call is below it.
            if sum(count(receipt.get(k, 0)) for k in FIELDS[:3]) > 100_000:
                raise ValueError("Unknown per-request context pricing")
            iterations = [receipt]
            incomplete += 1
        for iteration in iterations:
            regular, writes, reads, output = [
                count(iteration.get(k, 0)) for k in FIELDS
            ]
            ttl = iteration.get("cache_creation", {})
            short = count(ttl.get("ephemeral_5m_input_tokens", 0))
            long = count(ttl.get("ephemeral_1h_input_tokens", 0))
            if short + long != writes:
                raise ValueError("Missing or inconsistent cache TTL breakdown")
            high = regular + writes + reads > 100_000
            multiplier = Decimal(5 if high else 1) * (
                Decimal("1.1") if geo == "us" else 1
            )
            tokens = dict(zip(RATES, [regular, short, long, reads, output]))
            for key, n in tokens.items():
                costs[key] += Decimal(n) * Decimal(RATES[key]) * multiplier / 1_000_000
            requests += 1
            premium += high
    return {
        "usd": float(sum(costs.values())),
        "components_usd": {k: float(v) for k, v in costs.items()},
        "billing_groups": requests,
        "incomplete_iteration_receipts": incomplete,
        "premium_requests": premium,
    }
