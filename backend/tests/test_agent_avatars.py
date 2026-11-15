from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents_runtime import sanitize_agent_avatar, sanitize_agent_config


class AgentAvatarValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.avatar = {
            "title": "Public portrait",
            "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/test.jpg/256px-test.jpg",
            "source_url": "https://commons.wikimedia.org/wiki/File:Test.jpg",
            "license": "CC BY-SA 4.0",
            "author": "Test artist",
        }

    def test_sanitizes_and_persists_a_licensed_commons_avatar(self) -> None:
        config = sanitize_agent_config({"avatar": self.avatar, "root_nopasswd": True})

        self.assertEqual(config["avatar"], self.avatar)
        self.assertFalse(config["root_nopasswd"])

    def test_rejects_non_commons_hosts_and_non_permissive_licenses(self) -> None:
        with self.assertRaisesRegex(ValueError, "bezpiecznego URL Wikimedia"):
            sanitize_agent_avatar({**self.avatar, "image_url": "https://example.com/avatar.jpg"})
        with self.assertRaisesRegex(ValueError, "licencji"):
            sanitize_agent_avatar({**self.avatar, "license": "CC BY-NC 4.0"})


if __name__ == "__main__":
    unittest.main()
