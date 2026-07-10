from __future__ import annotations

import unittest

from codex_usage.cdp_monitor import _interesting_response


class CdpMonitorTests(unittest.TestCase):
    def test_filters_usage_responses_without_matching_static_assets(self):
        self.assertTrue(_interesting_response("https://chatgpt.com/backend-api/wham/usage"))
        self.assertTrue(_interesting_response("https://chatgpt.com/backend-api/codex/analytics"))
        self.assertFalse(_interesting_response("https://chatgpt.com/cdn/assets/codex-analytics-tabs.css"))
        self.assertFalse(_interesting_response("https://chatgpt.com/backend-api/conversations"))


if __name__ == "__main__":
    unittest.main()
