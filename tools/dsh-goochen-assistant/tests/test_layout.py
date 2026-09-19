# -*- coding: utf-8 -*-
"""两栏布局的回归测试：**真的建一个窗口**来量左栏与日志栏的宽度。

守的是这个坑：夹取要靠 `winfo_width()` 算「滚动条占位」，而窗口**没上屏**时它一律
返回 1——照那个值算出来的占位是「整栏宽 - 1」，于是把竖线写到离谱的位置：刚打开
时左栏 807px、日志栏只剩 131px（实测），用户看到的就是「日志只有一点点」。

窗口建在屏幕外，消息框全部打桩，插件扫描等自动排期一概取消，所以不打扰用户、
不联网、不跑真实命令。没有图形环境（Tk 建不出来）时整个类跳过。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import sys
import tempfile
import time
import tkinter as tk
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import installer  # noqa: E402


def _tk_usable() -> bool:
    """能不能建出窗口（无图形环境时 Tk 会抛 TclError）。"""
    try:
        root = tk.Tk()
        root.destroy()
        return True
    except Exception:  # noqa: BLE001  没有显示环境就整类跳过
        return False


TK_OK = _tk_usable()


@unittest.skipUnless(TK_OK, "没有可用的 Tk（无图形环境）")
class ColumnLayoutTest(unittest.TestCase):
    """两栏宽度：日志栏任何时候都不该被左栏挤成一条缝。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-layout-"))
        self._old = (installer.CONFIG_DIR, installer.CONFIG_PATH)
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        for name in ("showinfo", "showwarning", "showerror", "askyesno"):
            patcher = mock.patch.object(installer.messagebox, name, lambda *a, **k: True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = installer.App()
        # 取消自动排期：插件刷新会真去调 dsh，测试里既慢又不需要
        for handle in self.app.tk.call("after", "info"):
            try:
                self.app.after_cancel(handle)
            except Exception:  # noqa: BLE001  已经跑掉的排期不用管
                pass
        self.app.withdraw()
        self._place(1000, 720)
        self.app.deiconify()

    def tearDown(self):
        try:
            self.app.destroy()
        except Exception:  # noqa: BLE001  销毁途中出错不影响断言结果
            pass
        installer.CONFIG_DIR, installer.CONFIG_PATH = self._old

    def _place(self, width: int, height: int) -> None:
        """放到屏幕外：几何照样计算（withdraw 过的窗口量不到宽度）。"""
        x = self.app.winfo_screenwidth() + 300
        self.app.geometry(f"{width}x{height}+{x}+300")

    def _pump(self, ms: int = 400) -> None:
        end = time.monotonic() + ms / 1000.0
        while time.monotonic() < end:
            self.app.update()
            time.sleep(0.02)

    def _panels(self):
        def find(widget):
            for child in widget.winfo_children():
                yield child
                yield from find(child)
        paned = next(w for w in find(self.app) if isinstance(w, installer.ttk.Panedwindow))
        panes = paned.panes()
        canvas = next(w for w in find(self.app.nametowidget(panes[0]))
                      if isinstance(w, tk.Canvas))
        log_frame = self.app.nametowidget(panes[1])
        bars = [w for w in find(self.app.nametowidget(panes[0]))
                if isinstance(w, installer.ttk.Scrollbar)]
        return paned, canvas, log_frame, bars[0]

    def test_log_column_is_wide_enough_right_after_opening(self):
        """**刚打开**就得达标：以前这里是左栏 807px / 日志 131px。"""
        self._pump(600)
        _, canvas, log_frame, _ = self._panels()
        self.assertGreaterEqual(log_frame.winfo_width(), installer.LOG_COL_MIN - 2,
                                "刚打开时日志栏被挤窄了（未上屏就夹取的老毛病）")
        self.assertLessEqual(canvas.winfo_width(), installer.LEFT_COL_MAX)

    def test_log_column_is_wide_enough_when_the_window_shrinks(self):
        """把窗口缩到最小：左栏要让位，日志栏仍不低于下限。"""
        self._pump(400)
        self._place(760, 600)
        self._pump(400)
        _, canvas, log_frame, _ = self._panels()
        self.assertGreaterEqual(log_frame.winfo_width(), installer.LOG_COL_MIN - 2)
        self.assertGreaterEqual(canvas.winfo_width(), installer.LEFT_COL_MIN - 2)

    def test_drag_limits_and_double_click_reset(self):
        """拖到极窄/极宽都被夹回区间；双击竖线回到默认值并记住。"""
        self._pump(400)
        paned, canvas, _, bar = self._panels()
        self.app._apply_left_width(paned, canvas, bar, want=10, save=False)
        self._pump(200)
        self.assertGreaterEqual(canvas.winfo_width(), installer.LEFT_COL_MIN - 2)
        self.app._apply_left_width(paned, canvas, bar, want=9999, save=False)
        self._pump(200)
        self.assertLessEqual(canvas.winfo_width(), installer.LEFT_COL_MAX + 2)
        self.app._reset_left_col(paned, canvas, bar)
        self._pump(250)
        self.assertAlmostEqual(canvas.winfo_width(), installer.LEFT_COL_WIDTH, delta=2)
        self.assertEqual(installer.saved_left_col_width(), installer.LEFT_COL_WIDTH)


if __name__ == "__main__":
    unittest.main()
