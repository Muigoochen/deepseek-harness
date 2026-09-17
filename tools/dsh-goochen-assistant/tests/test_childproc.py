# -*- coding: utf-8 -*-
"""子进程登记与清理的单元测试（真进程，但不联网、不碰用户目录）。

守的是这个承诺：**关窗时，本助手拉起来的子进程（含子孙）不会留下来继续跑。**
Windows 上父进程结束不会带走子进程，而安装/构建的工作线程是 daemon——没有
这层登记，界面一关就会留下看不见的孤儿在往安装目录写文件。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import childproc  # noqa: E402

NODE = shutil.which("node")

#: 让子进程每 200ms 写一次心跳：文件还在长 = 进程还活着，冻结 = 连同子孙都死了。
BEAT_JS = ("const fs=require('fs');const p=process.argv[2];let i=0;"
           "setInterval(()=>{fs.writeFileSync(p,String(++i))},200);")


class TrackTest(unittest.TestCase):
    """登记 / 注销。"""

    def test_run_returns_completed_process_and_untracks(self):
        proc = childproc.run([sys.executable, "-c", "print('hi')"])
        self.assertEqual(proc.returncode, 0)
        self.assertIn(b"hi", proc.stdout)
        self.assertEqual(childproc.running(), 0, "跑完了就该注销，别留着占登记表")

    def test_running_counts_while_a_command_is_in_flight(self):
        import threading
        holder = {}

        def slow():
            holder["proc"] = childproc.run(
                [sys.executable, "-c", "import time; time.sleep(3)"], timeout=20)

        thread = threading.Thread(target=slow, daemon=True)
        thread.start()
        try:
            for _ in range(40):                      # 等它真的跑起来
                if childproc.running() == 1:
                    break
                time.sleep(0.05)
            self.assertEqual(childproc.running(), 1)
        finally:
            childproc.kill_all()
            thread.join(timeout=10)
        self.assertEqual(childproc.running(), 0)

    def test_kill_tree_is_a_noop_on_a_finished_process(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait(timeout=20)
        childproc.kill_tree(proc)                    # 不该抛
        self.assertEqual(proc.returncode, 0)

    def test_timeout_raises_and_does_not_leave_the_child_running(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            childproc.run([sys.executable, "-c", "import time; time.sleep(30)"],
                          timeout=0.5)
        self.assertEqual(childproc.running(), 0, "超时的命令不能留在登记表里")


@unittest.skipIf(NODE is None, "需要 node 才能造「父进程 + 孙子进程」的真实进程树")
class KillTreeTest(unittest.TestCase):
    """`kill_all()` 必须连**子孙**一起结束（只杀 cmd 的话 node 会活下来占端口）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-child-"))
        self.beat = self.tmp / "beat.txt"
        self.js = self.tmp / "beat.js"
        self.js.write_text(BEAT_JS, encoding="utf-8")

    def tearDown(self):
        childproc.kill_all()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _beat(self) -> int:
        try:
            return int(self.beat.read_text().strip() or 0)
        except Exception:
            return -1

    def _start_tree(self) -> subprocess.Popen:
        # 与 dsh web / pnpm 同样的起法：cmd.exe 当父进程，node 是孙子进程
        return subprocess.Popen(
            f'call "{NODE}" "{self.js}" "{self.beat}"', shell=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def _wait_alive(self) -> int:
        for _ in range(60):
            value = self._beat()
            if value > 0:
                time.sleep(0.35)                     # 再等两拍，确认确实在长
                return self._beat()
            time.sleep(0.1)
        self.fail("测试用的进程树没能起来")

    def test_kill_all_stops_the_grandchild_too(self):
        proc = self._start_tree()
        childproc.track(proc)
        self._wait_alive()

        killed = childproc.kill_all()
        self.assertEqual(killed, 1)

        time.sleep(0.3)
        frozen = self._beat()
        time.sleep(0.9)
        self.assertEqual(self._beat(), frozen,
                         "心跳还在长 = 孙子进程没被杀掉（只结束了 cmd.exe）")
        self.assertIsNotNone(proc.poll())

    def test_kill_all_reports_nothing_when_idle(self):
        self.assertEqual(childproc.kill_all(), 0)


if __name__ == "__main__":
    unittest.main()
