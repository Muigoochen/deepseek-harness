# -*- coding: utf-8 -*-
"""离线安装到 ⑥ 构建这一步的环境补齐（真机踩过的坑）。

离线源码包是 tar 解出来的，**没有 .git**，而 `pnpm run build` 会执行
`git rev-parse HEAD`（`scripts/client-build-environment.ts` 的 `repositoryCommitHash`），
于是整个离线安装卡在最后一步、退出码 1。修好它之后又露出第二个：`scripts/build.ts`
把 `pnpmInvocation()` 的结果交给 `spawnSync`，而 `pnpmInvocation()` 要求环境里有
`npm_execpath`——它**只有 pnpm 自己跑脚本时才注入**，干净机器上没有，同样致命。
两个值都由小助手补齐（不改仓库任何代码），且只补缺的、用完还原。

注：测试都把"当前环境"显式传进去。Windows 上 `mock.patch.dict(os.environ, …)` 改出来的值
`dict(os.environ)` 看不见（实测），用传参才不会测出假结果。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import installer  # noqa: E402

HEX = r"^[0-9a-fA-F]{7,40}$"


class BuildVariablesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.marker = self.root / "source-commit.txt"
        self.logs: list[str] = []
        # 一个真实存在的入口文件：build_variables 只补"缺失或已失效"的值
        self.given = self.root / "pnpm.mjs"
        self.given.write_text("// pnpm\n", encoding="utf-8")
        # 默认当作"查不到 pnpm 入口"，个别用例再覆盖
        self._resolve = mock.patch.object(installer, "pnpm_execpath", lambda: "")
        self._resolve.start()
        self.addCleanup(self._resolve.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _extras(self, base):
        return installer.build_variables(self.root, log=self.logs.append,
                                         commit_marker=self.marker, base=base)

    def test_git_checkout_with_execpath_needs_nothing(self):
        (self.root / ".git").mkdir()
        self.assertEqual(self._extras({"npm_execpath": str(self.given), "PATH": r"C:\bin"}), {},
                         "该有的都有时别插手")

    def test_offline_source_gets_a_usable_commit_hash(self):
        extras = self._extras({"npm_execpath": str(self.given)})
        self.assertRegex(extras["DSH_CLIENT_COMMIT_HASH"], HEX)
        self.assertTrue(any("没有 .git" in line for line in self.logs), self.logs)
        self.assertTrue(any("占位值" in line for line in self.logs),
                        "用了占位值就必须说清楚，别让人以为是真实提交号")

    def test_packed_commit_is_used_when_recorded(self):
        self.marker.write_text("A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2\n", encoding="utf-8")
        extras = self._extras({"npm_execpath": str(self.given)})
        self.assertEqual(extras["DSH_CLIENT_COMMIT_HASH"],
                         "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2")
        self.assertTrue(any("source-commit.txt" in line for line in self.logs), self.logs)

    def test_garbage_marker_falls_back_to_placeholder(self):
        self.marker.write_text("not-a-hash\n", encoding="utf-8")
        extras = self._extras({"npm_execpath": str(self.given)})
        self.assertRegex(extras["DSH_CLIENT_COMMIT_HASH"], HEX)
        self.assertTrue(any("占位值" in line for line in self.logs), self.logs)

    def test_missing_npm_execpath_is_supplied(self):
        entry = r"C:\fake\node_modules\pnpm\bin\pnpm.mjs"
        with mock.patch.object(installer, "pnpm_execpath", lambda: entry):
            extras = self._extras({})
        self.assertEqual(extras["npm_execpath"], entry)
        self.assertTrue(any("npm_execpath" in line for line in self.logs), self.logs)

    def test_existing_npm_execpath_is_left_alone(self):
        given = self.root / "pnpm.mjs"
        given.write_text("// pnpm\n", encoding="utf-8")
        with mock.patch.object(installer, "pnpm_execpath", lambda: r"C:\other\pnpm.mjs"):
            extras = self._extras({"npm_execpath": str(given)})
        self.assertNotIn("npm_execpath", extras, "可用就不要覆盖")

    def test_stale_npm_execpath_is_replaced(self):
        entry = r"C:\fake\node_modules\pnpm\bin\pnpm.mjs"
        with mock.patch.object(installer, "pnpm_execpath", lambda: entry):
            extras = self._extras({"npm_execpath": r"E:\.pnpm-store\gone\pnpm.mjs"})
        self.assertEqual(extras["npm_execpath"], entry,
                         "指向已经不存在的文件时，要换成这台机器上真实的入口")
        self.assertTrue(any("原值不可用" in line for line in self.logs), self.logs)

    def test_unresolvable_npm_execpath_does_not_invent_one(self):
        (self.root / ".git").mkdir()
        self.assertEqual(self._extras({}), {}, "查不到入口就什么都别加，让构建自己如实报错")


class TemporaryEnvironmentTest(unittest.TestCase):
    """只临时加要补的项：加进去、子进程继承得到、退出后逐项还原。"""

    def test_adds_and_restores(self):
        name = "DSH_ASSISTANT_TEST_VAR"
        os.environ.pop(name, None)
        try:
            with installer.temporary_environment({name: "1", "PATH": r"C:\patched"}):
                self.assertEqual(os.environ[name], "1")
                self.assertEqual(os.environ["PATH"], r"C:\patched")
            self.assertNotIn(name, os.environ, "用过的临时变量必须清掉")
            self.assertNotEqual(os.environ["PATH"], r"C:\patched", "原有变量必须还原")
        finally:
            os.environ.pop(name, None)

    def test_restores_even_on_failure(self):
        name = "DSH_ASSISTANT_TEST_VAR2"
        os.environ.pop(name, None)
        try:
            with self.assertRaises(RuntimeError):
                with installer.temporary_environment({name: "1"}):
                    raise RuntimeError("boom")
            self.assertNotIn(name, os.environ)
        finally:
            os.environ.pop(name, None)


if __name__ == "__main__":
    unittest.main()
