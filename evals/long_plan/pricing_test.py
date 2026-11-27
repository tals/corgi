import unittest

from pricing import price


def usage(regular=0, writes=0, reads=0, output=0, short=0):
    return {
        "input_tokens": regular,
        "cache_creation_input_tokens": writes,
        "cache_read_input_tokens": reads,
        "output_tokens": output,
        "cache_creation": {
            "ephemeral_5m_input_tokens": short,
            "ephemeral_1h_input_tokens": writes - short,
        },
        "output_tokens_details": {"thinking_tokens": output // 2},
    }


class Pricing(unittest.TestCase):
    def test_cache_writes_are_separate_and_thinking_is_not_added_twice(self):
        result = price([usage(100, 1000, 5000, 200, 400)])
        self.assertAlmostEqual(
            result["usd"], 0.00001 + 0.00005 + 0.00012 + 0.00005 + 0.0001
        )
        self.assertEqual(result["premium_requests"], 0)

    def test_context_threshold_includes_cache_and_is_per_request(self):
        low, high = (
            usage(1, reads=99999, output=1000),
            usage(1, reads=100000, output=1000),
        )
        self.assertEqual(price([low])["premium_requests"], 0)
        self.assertEqual(price([high])["premium_requests"], 1)
        self.assertAlmostEqual(price([high])["components_usd"]["output"], 0.0025)
        aggregate = usage(2, reads=199998, output=2000)
        aggregate["iterations"] = [low, low]
        self.assertEqual(price([aggregate])["premium_requests"], 0)
        self.assertAlmostEqual(price([aggregate])["usd"], 2 * price([low])["usd"])

    def test_incomplete_receipts_are_not_guessed(self):
        missing = usage(writes=100)
        del missing["cache_creation"]
        with self.assertRaises(ValueError):
            price([missing])
        broken = usage(output=200)
        broken["iterations"] = [usage(output=100)]
        # Final receipts remain authoritative even when an iteration is omitted.
        self.assertEqual(price([broken])["incomplete_iteration_receipts"], 1)
        self.assertAlmostEqual(price([broken])["usd"], 0.0001)
        broken["cache_read_input_tokens"] = 100001
        with self.assertRaises(ValueError):
            price([broken])


if __name__ == "__main__":
    unittest.main()
