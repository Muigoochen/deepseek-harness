# -*- coding: utf-8 -*-
"""「还要不要装」的判据测试：界面按钮的灰/亮必须与安装流程会不会真干活一致。

守的是这个坑：一切都装好、服务也在跑时，【一键完整安装】仍然可点——点下去会重装依赖、
重新构建、还会先停掉正在跑的服务（实测踩过：装完又自动起第二个服务，报 EADDRINUSE）。
现在装好即变灰，重装挪到【修复安装】（有二次确认）。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import installer  # noqa: E402


class InstallStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _state(self, *, checkout: bool) -> tuple[str, str]:
        with mock.patch.object(installer, "is_checkout", lambda _p: checkout):
            return installer.install_state(self.dir)

    def test_not_a_checkout_needs_a_fresh_install(self):
        state, reason = self._state(checkout=False)
        self.assertEqual(state, "missing")
        self.assertIn("全新安装", reason)

    def test_checkout_without_deps_is_incomplete(self):
        state, reason = self._state(checkout=True)
        self.assertEqual(state, "incomplete")
        self.assertIn("node_modules", reason)
        self.assertIn("构建产物", reason)

    def test_missing_build_mark_still_needs_install(self):
        (self.dir / "node_modules").mkdir()
        state, reason = self._state(checkout=True)
        self.assertEqual(state, "incomplete")
        self.assertNotIn("node_modules", reason)      # 只报缺的那一样
        self.assertIn("构建产物", reason)

    def test_deps_and_build_present_is_ready(self):
        (self.dir / "node_modules").mkdir()
        mark = self.dir / installer.BUILD_MARK
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.write_text("{}", encoding="utf-8")
        state, reason = self._state(checkout=True)
        self.assertEqual(state, "ready")
        self.assertIn("无需重复安装", reason)

    def test_judgement_matches_the_install_flow(self):
        """判据必须与 `install_deps` / `build` 的跳过条件同源，否则会出现
        "界面说装好了、点安装却又重装一遍"。"""
        (self.dir / "node_modules").mkdir()
        mark = self.dir / installer.BUILD_MARK
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.write_text("{}", encoding="utf-8")
        log: list[str] = []
        engine = installer.Engine("offline", use_mirror=False, log=log.append)
        with mock.patch.object(installer, "is_checkout", lambda _p: True):
            self.assertEqual(installer.install_state(self.dir)[0], "ready")
        engine.install_deps(self.dir, force=False)      # 应当跳过，不跑 pnpm
        engine.build(self.dir, force=False)             # 应当跳过，不跑构建
        self.assertTrue(any("跳过依赖安装" in line for line in log), log)
        self.assertTrue(any("跳过" in line and "build" in line for line in log), log)


if __name__ == "__main__":
    unittest.main()
