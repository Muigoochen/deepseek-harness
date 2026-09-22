# -*- coding: utf-8 -*-
"""浏览器启动的回归测试：**不许把用户的浏览器卷进 Job**。

守的是这个坑：`dsh web` 默认自己会开浏览器（web-app 的 openBrowser 默认 true），而它跑在
我们登记进 Job 的进程树里；Windows 的 Job 会遗传，于是那个浏览器进程也进了 Job——用户关掉
小助手时，连整台浏览器（含他别的标签页）一起被杀。

两处约束：① 启动 `dsh web` 必须带 `--no-open`（自动开页改由小助手自己做）；
② 小助手自己开浏览器时必须显式脱离 Job（`detached_creation_flags`），且失败要能退回。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import childproc  # noqa: E402
import installer  # noqa: E402


class WebCommandTest(unittest.TestCase):
    def test_always_disables_dsh_web_own_browser_open(self):
        with mock.patch.object(installer, "web_clock_overlay", lambda _p: None):
            cmdline = installer.web_command(r"C:\...\pnpm.CMD", Path(r"D:\dsh"))
        self.assertIn("--no-open", cmdline, "dsh web 自己开浏览器就会把用户浏览器卷进 Job")
        self.assertIn("dsh web", cmdline)

    def test_keeps_the_clock_overlay_patch(self):
        overlay = Path(r"E:\proj\plugins\time-context\cordis.patch.yml")
        with mock.patch.object(installer, "web_clock_overlay", lambda _p: overlay):
            cmdline = installer.web_command("pnpm.cmd", Path(r"D:\dsh"))
        self.assertIn(f'--patch "{overlay}"', cmdline)

    def test_prefers_the_built_entrypoint(self):
        """有构建产物时**必须**用它启动 —— 源码启动会让同一个包被求值两次。

        真机实证（0.1.6-alpha.2）：源码启动（`node --import tsx/esm apps/cli/src/bin.ts`）下，
        工具服务 ToolRuntime 来自 `lib`，而 agent-loop 的 `TOOL_RUNTIME_SCHEDULER` 来自 `src`
        （tsx 按 tsconfig `paths` 改写），两个 Symbol 身份不同 ⇒ 每次工具调用都报
        `Cannot read properties of undefined (reading 'prepare')`；改用产物入口
        `apps/cli/lib/bin.js` 后工具正常执行并返回结果。
        """
        tmp = Path(tempfile.mkdtemp(prefix="dsh-webcmd-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        built = tmp / "apps" / "cli" / "lib" / "bin.js"
        built.parent.mkdir(parents=True)
        built.write_text("// built entry\n", encoding="utf-8")
        with mock.patch.object(installer, "web_clock_overlay", lambda _p: None):
            cmdline = installer.web_command("pnpm.cmd", tmp, log=lambda _m: None)
        self.assertIn(str(built), cmdline, "有构建产物就该走产物入口")
        self.assertNotIn("pnpm.cmd", cmdline, "走产物入口时不该再经 pnpm")
        self.assertIn("--no-open", cmdline, "--no-open 这条不变量任何时候都不能丢")

    def test_falls_back_to_source_launch_and_says_why(self):
        tmp = Path(tempfile.mkdtemp(prefix="dsh-webcmd-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        logs: list[str] = []
        with mock.patch.object(installer, "web_clock_overlay", lambda _p: None):
            cmdline = installer.web_command("pnpm.cmd", tmp, log=logs.append)
        self.assertIn("pnpm.cmd", cmdline, "没有产物时退回源码启动")
        self.assertIn("--no-open", cmdline)
        self.assertTrue(any("没找到" in line for line in logs), f"降级必须写清原因：{logs}")


class SpawnBrowserTest(unittest.TestCase):
    def test_breaks_away_from_the_job_first(self):
        calls: list[int] = []

        def fake_popen(argv, **kwargs):
            calls.append(kwargs.get("creationflags", 0))
            return mock.Mock()

        with mock.patch.object(installer.subprocess, "Popen", fake_popen):
            message = installer._spawn_browser(r"C:\b\chrome.exe", "http://x/")
        self.assertTrue(message.startswith("已用"), message)
        self.assertEqual(calls, [childproc.detached_creation_flags()])

    def test_falls_back_when_breakaway_is_refused(self):
        """进程不在任何 Job 里时带 BREAKAWAY 会被系统拒绝：必须退回普通启动。"""
        calls: list[int] = []

        def fake_popen(argv, **kwargs):
            flags = kwargs.get("creationflags", 0)
            calls.append(flags)
            if flags:
                raise OSError("breakaway not allowed")
            return mock.Mock()

        with mock.patch.object(installer.subprocess, "Popen", fake_popen):
            message = installer._spawn_browser(r"C:\b\chrome.exe", "http://x/")
        self.assertEqual(calls, [childproc.detached_creation_flags(), 0])
        self.assertTrue(message.startswith("已用"), message)

    def test_reports_a_real_failure(self):
        def fake_popen(argv, **kwargs):
            raise OSError("no such file")

        with mock.patch.object(installer.subprocess, "Popen", fake_popen):
            message = installer._spawn_browser("nope.exe", "http://x/")
        self.assertTrue(message.startswith("失败"), message)


class JobLimitFlagsTest(unittest.TestCase):
    def test_job_allows_members_to_break_away(self):
        """Job 必须同时带上 BREAKAWAY_OK，否则上面的逃离标志会被系统拒绝。"""
        self.assertTrue(childproc.JOB_LIMIT_FLAGS & 0x2000, "仍要 KILL_ON_JOB_CLOSE")
        self.assertTrue(childproc.JOB_LIMIT_FLAGS & 0x0800, "要允许 BREAKAWAY_OK")

    @unittest.skipUnless(os.name == "nt", "Job Object 是 Windows 的机制")
    def test_a_job_child_can_actually_leave_the_job(self):
        """实证：Job 内的子进程再拉起孙子——带逃离标志的孙子不在**本助手的** Job 里。

        判定必须针对本助手这个 Job（而不是"是否在任何 Job 内"）：测试进程自己可能还在
        外层 Job（终端/CI）里，那种情况下孙子逃出我们的 Job 后仍留在外层 Job 中。
        不带逃离标志的那一组是对照，说明这确实是 Job 继承造成的。
        """
        import ctypes
        import subprocess
        import textwrap
        from ctypes import wintypes

        handle = childproc._win_job()
        self.assertIsNotNone(handle, "本机拿不到 Job Object")

        child_code = textwrap.dedent(
            """
            import subprocess, sys, time
            flags = int(sys.argv[1])
            p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"],
                                 creationflags=flags)
            print(p.pid, flush=True)
            time.sleep(20)
            """)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE,
                                            ctypes.POINTER(wintypes.BOOL)]
        query_limited = 0x1000
        results: list[bool] = []
        for flags in (childproc.detached_creation_flags(), 0):
            proc = subprocess.Popen([sys.executable, "-c", child_code, str(flags)],
                                    stdout=subprocess.PIPE, text=True)
            childproc.track(proc)          # 放进 Job：模拟 dsh web 的 node
            grandchild = None
            try:
                pid = int((proc.stdout.readline() or "0").strip() or 0)
                self.assertTrue(pid, "子进程没有报出孙子 pid")
                grandchild = kernel32.OpenProcess(query_limited, False, pid)
                self.assertTrue(grandchild, "打不开孙子进程")
                in_job = wintypes.BOOL()
                self.assertTrue(
                    kernel32.IsProcessInJob(grandchild, handle, ctypes.byref(in_job)))
                results.append(bool(in_job.value))
            finally:
                if grandchild:
                    kernel32.CloseHandle(grandchild)
                childproc.kill_tree(proc)
                childproc.untrack(proc)
                if proc.stdout is not None:
                    proc.stdout.close()
                proc.wait(timeout=10)
        if results[1] is False:
            self.skipTest("本机不允许嵌套 Job（子进程没被放进本助手的 Job），跳过实证")
        self.assertFalse(results[0], "带逃离标志的孙子仍在 Job 里——用户浏览器会被误杀")
        self.assertTrue(results[1], "对照组没进 Job，说明本机行为与预期不同")


if __name__ == "__main__":
    unittest.main()
