# -*- coding: utf-8 -*-
"""端口冲突防护的测试：启动 dsh web 前必须按**端口事实**判断，而不是内部记账。

守的是这个坑：`_job()` 里安装跑完会再启动一次服务，而启动只看 `self.web_proc`——原来
那个还在跑时就会起第二个，报 EADDRINUSE；更糟的是它把 `web_proc` 覆盖成一个已经死掉的
进程，界面从此以为"没在跑"，连『停止服务』都点不动。
"""
from __future__ import annotations

import socket
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import childproc  # noqa: E402
import installer  # noqa: E402

#: 取自本机的真实 `netstat -ano -p TCP` 片段：既有监听行，也有浏览器连上来的连接行。
NETSTAT_SAMPLE = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       14340
  TCP    127.0.0.1:3080         127.0.0.1:55717        ESTABLISHED     14340
  TCP    127.0.0.1:55717        127.0.0.1:3080         ESTABLISHED     27540
  TCP    [::]:3080              [::]:0                 LISTENING       14340
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1660
  TCP    127.0.0.1:30801        0.0.0.0:0              LISTENING       999
"""

NETSTAT_SAMPLE_CN = """
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       14340
"""


class ParseNetstatTest(unittest.TestCase):
    def test_only_listening_on_that_port(self):
        self.assertEqual(childproc._parse_netstat_pids(NETSTAT_SAMPLE, 3080), [14340])

    def test_established_peer_is_not_the_owner(self):
        """浏览器那一端（27540）不算占用者——否则"结束占用进程"会去杀浏览器。"""
        self.assertNotIn(27540, childproc._parse_netstat_pids(NETSTAT_SAMPLE, 3080))

    def test_port_is_not_matched_by_prefix(self):
        self.assertEqual(childproc._parse_netstat_pids(NETSTAT_SAMPLE, 30801), [999])

    def test_localized_header_is_ignored(self):
        self.assertEqual(childproc._parse_netstat_pids(NETSTAT_SAMPLE_CN, 3080), [14340])


class PortInUseTest(unittest.TestCase):
    def test_reports_a_real_listener_then_its_release(self):
        # backlog 给大一点：探测本身会留下一条没被 accept 的连接，队列满了会让
        # connect_ex 超时——那正是 `_CONNECT_TIMEOUT_CODES` 要处理的情况，不该由
        # 这条测试来触发（真服务不会卡成这样）。
        with socket.socket() as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(64)
            port = srv.getsockname()[1]
            self.assertTrue(installer.port_in_use(port), "有人在监听就该是 True")
            self.assertFalse(installer.wait_port_free(port, timeout=0.4),
                             "还占着的时候不该等到空")
        self.assertTrue(installer.wait_port_free(port, timeout=5), "关掉后应当空出来")

    def test_reports_a_closed_port(self):
        with socket.socket() as srv:
            srv.bind(("127.0.0.1", 0))
            port = srv.getsockname()[1]
        self.assertFalse(installer.port_in_use(port))

    def test_default_port_matches_the_web_url(self):
        self.assertEqual(installer.WEB_PORT, 3080)
        self.assertIn(f":{installer.WEB_PORT}", installer.WEB_URL)


class KillPidTreeTest(unittest.TestCase):
    def test_refuses_nonsense_pids(self):
        self.assertFalse(childproc.kill_pid_tree(0))
        self.assertFalse(childproc.kill_pid_tree(-1))


if __name__ == "__main__":
    unittest.main()
