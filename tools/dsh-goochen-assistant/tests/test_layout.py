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

import json
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


@unittest.skipUnless(TK_OK, "没有可用的 Tk（无图形环境）")
class InstallDirBoxTest(unittest.TestCase):
    """安装位置输入框：误碰不许生效，【回到上次位置】要回到用户自己的那份安装。

    守两个坑：
    ① 以前 `StringVar` 的 write 回调里直接 `set_active_dir`，敲错一个字符，
       「运行 / 自检 / 插件」当场就换目录了（实测过：改一下就启动不起来）；
    ② 以前【恢复默认】永远跳 C 盘（`%USERPROFILE%\\deepseek-harness`），
       把用户装在别的盘上的位置丢了——那既不是「默认」也不是「上次」。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-dirbox-"))
        self._old = (installer.CONFIG_DIR, installer.CONFIG_PATH, installer._ACTIVE_DIR)
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        self.answers: list[bool] = []
        for name in ("showinfo", "showwarning", "showerror"):
            patcher = mock.patch.object(installer.messagebox, name, lambda *a, **k: True)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(
            installer.messagebox, "askyesno",
            lambda *a, **k: self.answers.pop(0) if self.answers else False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = installer.App()
        for handle in self.app.tk.call("after", "info"):
            try:
                self.app.after_cancel(handle)
            except Exception:  # noqa: BLE001  已经跑掉的排期不用管
                pass
        self.app.withdraw()

    def tearDown(self):
        try:
            self.app.destroy()
        except Exception:  # noqa: BLE001  销毁途中出错不影响断言结果
            pass
        installer.CONFIG_DIR, installer.CONFIG_PATH, installer._ACTIVE_DIR = self._old

    def _checkout(self, name: str) -> Path:
        """造一个「凭内容认得出是 DSH 检出」的目录（标记文件 + 官方根包名）。"""
        path = self.tmp / name
        path.mkdir(parents=True, exist_ok=True)
        (path / "package.json").write_text(
            json.dumps({"name": installer.DSH_ROOT_PACKAGE}), encoding="utf-8")
        for marker in installer.CHECKOUT_MARKERS:
            if marker != "package.json":
                (path / marker).write_text("", encoding="utf-8")
        return path

    def test_typing_alone_never_changes_where_we_install(self):
        real = self._checkout("real")
        installer.set_active_dir(real)
        self.app.dir_var.set(r"E:\typo\deepseek-harnesss")
        self.app._dir_hint()
        self.assertEqual(installer.project_dir(), real, "敲键盘就换了安装位")
        self.assertIn("尚未生效", self.app.dir_hint.cget("text"))

    def test_committing_a_typo_asks_and_reverts(self):
        real = self._checkout("real")
        installer.set_active_dir(real)
        self.answers.append(False)                    # 弹窗里选「否」
        self.app.dir_var.set(str(self.tmp / "typo"))
        self.app._on_dir_committed()
        self.assertEqual(str(self.app.dir_var.get()), str(real))
        self.assertEqual(installer.project_dir(), real)
        self.assertNotEqual(installer.load_config().get("installDir"),
                            str(self.tmp / "typo"))

    def test_committing_a_new_location_after_yes_applies_it(self):
        real = self._checkout("real")
        fresh = self.tmp / "fresh"
        installer.set_active_dir(real)
        self.answers.append(True)                     # 弹窗里选「是」
        self.app.dir_var.set(str(fresh))
        self.app._on_dir_committed()
        self.assertEqual(installer.project_dir(), fresh)
        self.assertEqual(installer.load_config().get("installDir"), str(fresh))

    def test_reset_goes_back_to_the_last_used_dir(self):
        real = self._checkout("real")
        installer.CONFIG_PATH.write_text(json.dumps({"installDir": str(real)}),
                                         encoding="utf-8")
        self.app.dir_var.set(str(self.tmp / "elsewhere"))
        self.app._on_reset_dir()
        self.assertEqual(str(self.app.dir_var.get()), str(real))
        self.assertNotEqual(str(self.app.dir_var.get()),
                            str(installer.default_project_dir()),
                            "又跳回 C 盘默认值了")


@unittest.skipUnless(TK_OK, "没有可用的 Tk（无图形环境）")
class PluginUndoTest(unittest.TestCase):
    """插件页的"反悔"两个按钮：撤销待办只清草稿；回滚才动文件（补丁+台账一起退）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-undo-"))
        self._old = (installer.CONFIG_DIR, installer.CONFIG_PATH, installer._ACTIVE_DIR)
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        self.answers: list[bool] = []
        for name in ("showinfo", "showwarning", "showerror"):
            patcher = mock.patch.object(installer.messagebox, name, lambda *a, **k: True)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(
            installer.messagebox, "askyesno",
            lambda *a, **k: self.answers.pop(0) if self.answers else False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = installer.App()
        for handle in self.app.tk.call("after", "info"):
            try:
                self.app.after_cancel(handle)
            except Exception:  # noqa: BLE001  已经跑掉的排期不用管
                pass
        self.app.withdraw()

    def tearDown(self):
        try:
            self.app.destroy()
        except Exception:  # noqa: BLE001  销毁途中出错不影响断言结果
            pass
        installer.CONFIG_DIR, installer.CONFIG_PATH, installer._ACTIVE_DIR = self._old

    def _home_with_backup(self) -> Path:
        home = self.tmp / "home"
        patch = installer.pstore.web_patch(home)
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text("v1\n", encoding="utf-8")
        installer.pstore.commit_patch(home, "v2\n")          # 写盘 → 留下 v1 的 .bak
        return home

    def test_undo_clears_queued_drafts_without_touching_files(self):
        self.app.plugin_pending["toast"] = "set_off"
        self.app._render_pending_only("toast")
        self.assertIn("1 项待保存", str(self.app.btn_save.cget("text")))
        self.assertEqual(str(self.app.btn_undo.cget("state")), "normal")
        self.app._clear_pending()
        self.assertEqual(self.app.plugin_pending, {})
        self.assertNotIn("待保存", str(self.app.btn_save.cget("text")))
        self.assertEqual(str(self.app.btn_undo.cget("state")), "disabled")

    def test_rollback_restores_the_patch_and_clears_drafts(self):
        home = self._home_with_backup()
        self.app.plugin_home_dir = home
        self.app.plugin_pending["toast"] = "set_off"
        self.answers.append(True)                             # 确认回滚
        with mock.patch.object(self.app, "_refresh_plugins"):
            self.app._on_rollback()
        self.assertEqual(
            installer.pstore.web_patch(home).read_text(encoding="utf-8"), "v1\n")
        self.assertEqual(self.app.plugin_pending, {})

    def test_rollback_refuses_when_there_is_no_backup(self):
        home = self.tmp / "fresh-home"
        self.app.plugin_home_dir = home
        self.answers.append(True)
        with mock.patch.object(self.app, "_refresh_plugins") as refresh:
            self.app._on_rollback()
        refresh.assert_not_called()                           # 没备份就不该有任何动作


if __name__ == "__main__":
    unittest.main()
