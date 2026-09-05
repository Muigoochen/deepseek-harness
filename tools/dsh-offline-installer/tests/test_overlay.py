# -*- coding: utf-8 -*-
"""web_clock_overlay 去双挂逻辑测试（需导入 installer，headless 安全）。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import installer  # noqa: E402


class OverlayTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = os.environ.get("DSH_HOME")
        self.home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        (self.home / "profiles" / "web").mkdir(parents=True)
        self.project = Path(tempfile.mkdtemp(prefix="prj-"))
        self.overlay = self.project / "plugins" / "time-context" / "cordis.patch.yml"
        self.overlay.parent.mkdir(parents=True)
        self.overlay.write_text("- insert: []\n", encoding="utf-8")
        os.environ["DSH_HOME"] = str(self.home)

    def tearDown(self) -> None:
        if self._saved is None:
            os.environ.pop("DSH_HOME", None)
        else:
            os.environ["DSH_HOME"] = self._saved

    def _patch(self, body: str) -> None:
        (self.home / "profiles" / "web" / "cordis.patch.yml").write_text(
            body, encoding="utf-8")

    def test_no_patch_row_returns_overlay(self) -> None:
        self._patch("- insert:\n    - id: lsp-echo\n      name: '@dsh-user/lsp-echo'\n")
        self.assertEqual(installer.web_clock_overlay(self.project), self.overlay)

    def test_row_present_returns_none(self) -> None:
        self._patch("- insert:\n    - id: time-context\n"
                    "      name: '@deepseek-ai/dsh-time-context'\n")
        self.assertIsNone(installer.web_clock_overlay(self.project))

    def test_no_overlay_file_returns_none(self) -> None:
        self.overlay.unlink()
        self._patch("")
        self.assertIsNone(installer.web_clock_overlay(self.project))

    def test_missing_patch_file_returns_overlay(self) -> None:
        patch = self.home / "profiles" / "web" / "cordis.patch.yml"
        if patch.exists():
            patch.unlink()
        self.assertEqual(installer.web_clock_overlay(self.project), self.overlay)


if __name__ == "__main__":
    unittest.main(verbosity=2)
