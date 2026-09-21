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


class InstallButtonRefreshTest(unittest.TestCase):
    """界面级：逐字输入**不该**去判定目录（那要读盘），只有显式刷新才做。

    `checkout_identity` 在"这个目录是别的 pnpm 单仓"这条路上会 scandir 40 个子包并逐个读
    `package.json`；挂在输入框的逐字回调上就是每敲一下读几十个文件，网络盘上会明显卡。
    工具的规矩是"位置只在回车/失焦后才生效"，按钮状态跟着生效位置走即可。
    """

    def setUp(self) -> None:
        try:
            self.app = installer.App()
        except Exception as exc:  # noqa: BLE001  无显示环境（CI）下跳过
            self.skipTest(f"无法构造界面：{exc}")
        self.app.update()

    def tearDown(self) -> None:
        try:
            self.app.destroy()
        except Exception:  # noqa: BLE001  已在销毁中
            pass

    def test_typing_does_not_probe_the_filesystem(self):
        calls: list[str] = []
        real = installer.install_state

        def spy(path):
            calls.append(str(path))
            return real(path)

        with mock.patch.object(installer, "install_state", spy):
            self.app.dir_var.set(r"E:\placeholder\typing")   # = 逐字输入
            self.app.update()
            self.assertEqual(calls, [], "逐字输入不该触发目录判定（要读盘）")
            self.app._refresh_install_buttons()               # = 提交位置/显式刷新
            self.assertTrue(calls, "显式刷新时应当重新判定")

    def test_ready_directory_greys_out_the_main_button(self):
        with mock.patch.object(installer, "install_state",
                               lambda _p: ("ready", "依赖与构建产物都在")):
            self.app._refresh_install_buttons()
        self.assertEqual(str(self.app.btn_full["state"]), "disabled")
        self.assertIn("已装好", self.app.btn_full["text"])
        self.assertEqual(str(self.app.btn_repair["state"]), "normal")

    def test_uninstalled_directory_enables_the_main_button(self):
        with mock.patch.object(installer, "install_state",
                               lambda _p: ("incomplete", "缺少 node_modules")):
            self.app._refresh_install_buttons()
        self.assertEqual(str(self.app.btn_full["state"]), "normal")
        self.assertEqual(str(self.app.btn_repair["state"]), "disabled")
        self.assertIn("node_modules", self.app.install_hint["text"])


if __name__ == "__main__":
    unittest.main()
