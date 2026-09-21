# -*- coding: utf-8 -*-
"""【一键完整安装】的亮灭规则：跟着**服务在不在跑**，不是跟着"装没装好"。

它承担的是"检查 → 安装 → 装完自动启动"这一整套：服务一旦跑起来就不该再点（再点只会重装
一遍、还会先停掉正在跑的服务，实测踩过 EADDRINUSE）；点了『停止服务』就该立刻亮回来，
可以再用它做一次检查/安装/启动。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import installer  # noqa: E402


class InstallButtonTest(unittest.TestCase):
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

    # -- 小工具 ---------------------------------------------------------
    def _service(self, running: bool) -> None:
        """把"服务在不在跑"摆成指定状态（`poll()` 返回 None = 还活着）。"""
        self.app.web_proc = mock.Mock(poll=lambda: None) if running else None

    def _state(self) -> str:
        self.app._refresh_install_button()
        return str(self.app.btn_full["state"])

    # -- 规则本身 -------------------------------------------------------
    def test_disabled_while_the_service_is_running(self):
        self._service(True)
        self.assertEqual(self._state(), "disabled")

    def test_lights_up_again_after_stopping(self):
        self._service(True)
        self.assertEqual(self._state(), "disabled")
        self._service(False)                  # = 点了『停止服务』
        self.assertEqual(self._state(), "normal")

    def test_normal_when_nothing_is_running(self):
        self._service(False)
        self.assertEqual(self._state(), "normal")

    def test_busy_task_disables_it_too(self):
        self._service(False)
        self.app.busy = True
        self.assertEqual(self._state(), "disabled")

    def test_button_text_never_changes(self):
        """按钮文案保持原样（布局与以前一致，只有亮灭在变）。"""
        for running in (False, True):
            self._service(running)
            self.app._refresh_install_button()
            self.assertEqual(self.app.btn_full["text"], "一键完整安装")

    # -- 真实入口（停止服务那条路必须真的刷新）--------------------------
    def test_stopping_the_service_refreshes_the_button(self):
        self._service(True)
        self.assertEqual(self._state(), "disabled")
        with mock.patch.object(installer.childproc, "kill_tree"):
            self.app._stop_web_internal(quiet=True)     # 真正的停止路径
        self.assertIsNone(self.app.web_proc)
        self.assertEqual(str(self.app.btn_full["state"]), "normal",
                         "停止服务后按钮应当自己亮回来")


if __name__ == "__main__":
    unittest.main()
