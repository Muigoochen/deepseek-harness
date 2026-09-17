# -*- coding: utf-8 -*-
"""子进程登记与清理的单元测试（真进程，但不联网、不碰用户目录）。

守的是这个承诺：**关窗时，本助手拉起来的子进程（含子孙）不会留下来继续跑。**
Windows 上父进程结束不会带走子进程，而安装/构建的工作线程是 daemon——没有
这层登记，界面一关就会留下看不见的孤儿在往安装目录写文件。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import os
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


def cleanup(path: Path) -> None:
    """删掉测试临时目录；Windows 上 `.git` 里的对象文件是只读的，得先改权限。

    直接 `rmtree(..., ignore_errors=True)` 会静静地删不掉，临时目录一代代堆积。
    """
    def on_error(func, target, _exc):
        try:
            os.chmod(target, 0o700)
            func(target)
        except Exception:  # noqa: BLE001  删不掉就算了，不能让清理把用例判失败
            pass

    shutil.rmtree(path, onerror=on_error)

#: 让子进程每 200ms 写一次心跳：文件还在长 = 进程还活着，冻结 = 连同子孙都死了。
BEAT_JS = ("const fs=require('fs');const p=process.argv[2];let i=0;"
           "setInterval(()=>{fs.writeFileSync(p,String(++i))},200);")


def wait_frozen(reader, *, deadline: float = 8.0) -> bool:
    """等心跳**稳定不再变化**再判定（`taskkill /T` 是逐进程异步的，sleep 一次不算数）。"""
    end = time.monotonic() + deadline
    stable = 0
    last = reader()
    while time.monotonic() < end:
        time.sleep(0.4)
        now = reader()
        if now == last:
            stable += 1
            if stable >= 2:                          # 连续两次没变才认定停了
                return True
        else:
            stable, last = 0, now
    return False


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

    def test_job_object_is_available_on_windows(self):
        """Job Object 是「父死子必死」的保险：Windows 上应当总能建出来。"""
        self.assertIsInstance(childproc.job_available(), bool)
        if os.name == "nt":
            self.assertTrue(childproc.job_available())

    def test_assign_succeeds_for_a_plain_child(self):
        """普通子进程必须真能进 Job——只断言「返回 bool」的话，永远 False 也能过。"""
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3)"])
        try:
            result = childproc.assign(proc)
            if os.name == "nt":
                self.assertTrue(result, "Windows 上普通进程应当能放进 Job")
            else:
                self.assertFalse(result)
        finally:
            childproc.kill_tree(proc)
            proc.wait(timeout=10)


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
        cleanup(self.tmp)

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
        """等心跳真的在长（读到两次不同的值），返回最后一次读数。"""
        last = -1
        for _ in range(80):
            value = self._beat()
            if value > 0 and value != last:
                if last > 0:
                    return value
                last = value
            time.sleep(0.1)
        self.fail("测试用的进程树没能起来")

    def test_kill_all_stops_the_grandchild_too(self):
        proc = self._start_tree()
        childproc.track(proc)
        self._wait_alive()

        killed = childproc.kill_all()
        # 不断言恰好 1：登记表是全局的，别的用例万一留下残留，报错不该算到这一条头上
        self.assertGreaterEqual(killed, 1)

        self.assertTrue(wait_frozen(self._beat),
                        "心跳还在长 = 孙子进程没被杀掉（只结束了 cmd.exe）")
        self.assertIsNotNone(proc.poll())

    def test_kill_all_reports_nothing_when_idle(self):
        self.assertEqual(childproc.kill_all(), 0)


BEAT_SCRIPT = """\
import sys, time
p = sys.argv[1]
i = 0
while True:
    i += 1
    with open(p, "w") as fh:
        fh.write(str(i))
    time.sleep(0.2)
"""

#: 帮凶脚本：自己起一个心跳子进程、把它放进 Job，然后挂在那儿等人强杀。
HELPER_SCRIPT = """\
import subprocess, sys, time
sys.path.insert(0, sys.argv[3])
import childproc
child = subprocess.Popen([sys.executable, sys.argv[2], sys.argv[1]])
childproc.assign(child)
print("READY", flush=True)
time.sleep(120)
"""


@unittest.skipUnless(os.name == "nt", "Job Object 是 Windows 专有机制")
class JobObjectKillTest(unittest.TestCase):
    """**父死子必死**：父进程被强杀（不走任何清理代码）时，Job 里的子进程也跟着死。

    这是 Job Object 唯一的真实验证方式。用不到 node：帮凶自己起一个纯 Python 心跳
    子进程并 assign 进 Job，然后测试用 `taskkill /F`（**不带 /T**）把它强杀——
    模拟任务管理器结束进程。心跳冻结才说明系统把 Job 成员一起收走了。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-job-"))
        self.beat = self.tmp / "beat.txt"
        self.beat_script = self.tmp / "beat.py"
        self.beat_script.write_text(BEAT_SCRIPT, encoding="utf-8")
        self.helper_script = self.tmp / "helper.py"
        self.helper_script.write_text(HELPER_SCRIPT, encoding="utf-8")
        self.helper: subprocess.Popen | None = None

    def tearDown(self):
        if self.helper is not None and self.helper.poll() is None:
            subprocess.run(["taskkill", "/PID", str(self.helper.pid), "/T", "/F"],
                           capture_output=True)
        cleanup(self.tmp)

    def _beat(self) -> int:
        try:
            return int(self.beat.read_text().strip() or 0)
        except Exception:
            return -1

    def _wait_alive(self) -> None:
        last = -1
        for _ in range(80):
            value = self._beat()
            if value > 0 and value > last:
                if last > 0:
                    return
                last = value
            time.sleep(0.1)
        self.fail("Job 里的子进程没起来")

    def test_child_dies_when_the_parent_is_hard_killed(self):
        tools = str(Path(__file__).resolve().parent.parent)
        self.helper = subprocess.Popen(
            [sys.executable, str(self.helper_script), str(self.beat),
             str(self.beat_script), tools],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self._wait_alive()

        # 强杀父进程：/F 而不带 /T，等于任务管理器「结束任务」，没有任何清理机会
        subprocess.run(["taskkill", "/PID", str(self.helper.pid), "/F"],
                       capture_output=True)
        self.helper.wait(timeout=15)

        frozen = wait_frozen(self._beat)
        self.assertTrue(frozen,
                        "父进程被强杀后心跳还在长：子进程没进 Job（KILL_ON_JOB_CLOSE 没生效）")


if __name__ == "__main__":
    unittest.main()
