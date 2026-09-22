# -*- coding: utf-8 -*-
"""`childproc.run` 的环境传递（真机踩过的坑，比看上去重要）。

它以前把 `env=None` 改写成 `dict(os.environ)` 再交给 `Popen`，理由是"实测这份拷贝会漏掉
`npm_execpath`"。**那个理由经复核是错的**：Windows 上 Python 会把环境变量名大写化
（`npm_execpath` 存成 `NPM_EXECPATH`），所以 `dict(os.environ).get("npm_execpath")` 查不到，
但值一直都在——`Popen(env=…)` 传过去后 Node 仍读得到（`process.env` 在 Windows 上不区分
大小写）。真正会出问题的是**按前缀枚举**（`npm_config_*` → `NPM_CONFIG_*`）。
`None` 仍然是对的选择——那才是"继承"，是操作系统眼里的真相，也省掉一整套大小写陷阱——
但别再拿"拷贝会丢变量"当理由。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import childproc  # noqa: E402


class _FakeProc:
    pid = 4242
    returncode = 0

    def communicate(self, timeout=None):        # noqa: ARG002  （签名对齐 Popen）
        return b"", b""


class RunEnvironmentTest(unittest.TestCase):
    def _capture(self, **kwargs):
        recorded: dict = {}

        def fake_popen(argv, **options):
            recorded.update(options)
            return _FakeProc()

        with mock.patch.object(childproc.subprocess, "Popen", fake_popen):
            childproc.run(["cmd", "/c", "echo", "hi"], **kwargs)
        return recorded

    def test_none_env_is_handed_to_popen_untouched(self):
        self.assertIsNone(self._capture()["env"],
                          "env=None 就是继承；换成 dict(os.environ) 会漏变量")

    def test_explicit_env_is_passed_through(self):
        self.assertEqual(self._capture(env={"A": "1"})["env"], {"A": "1"})

    def test_runtime_variable_reaches_the_child(self):
        name = "DSH_ASSISTANT_CHILDPROC_PROBE"
        os.environ[name] = "42"
        try:
            proc = childproc.run([sys.executable, "-c",
                                  f"import os; print(os.environ.get('{name}', '<missing>'))"],
                                 text=True)
        finally:
            os.environ.pop(name, None)
        self.assertIn("42", proc.stdout or "", "运行时设的变量，子进程必须看得到")


if __name__ == "__main__":
    unittest.main()
