# -*- coding: utf-8 -*-
"""离线安装到 ⑥ 构建这一步的环境补齐（真机踩过的坑）。

离线源码包是 tar 解出来的，**没有 .git**，而 `pnpm run build` 会执行
`git rev-parse HEAD`（`scripts/client-build-environment.ts` 的 `repositoryCommitHash`），
于是整个离线安装卡在最后一步、退出码 1。现在补的是 `DSH_CLIENT_COMMIT_HASH`，用完还原
（不改仓库任何代码）。

**`npm_execpath` 千万不要补**——这里记着这笔学费：它看起来"缺失就该补"（`scripts/build.ts`
的 `pnpmInvocation()` 只在它空/没有时抛错），早先真补了，结果它正是构建失败的病根。
逐条对拍（同一台机器、同一工作树、都走小助手自己的 `run_cli`）：
  不补 → 构建正常；补成全局 pnpm 的入口（`…\\pnpm\\bin\\pnpm.mjs`）→ 2 秒抛
  "pnpm invocation: npm_execpath is unavailable" 退出 1；改用 `node <入口>` 但照样补 → 一样抛。
pnpm 被启动后会按自己的规则给脚本注入它认的值，外面塞一个它反而认不出。

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

    def test_npm_execpath_is_never_supplied(self):
        """**这是那次构建失败的病根**：不管环境里有没有、可不可用，都不许补它。

        逐条对拍（同一台机器、同一工作树、都走 run_cli）：不补 → 构建正常；
        补成全局 pnpm 的入口 → 2 秒抛 "npm invocation: npm_execpath is unavailable"。
        """
        entry = r"C:\fake\node_modules\pnpm\bin\pnpm.mjs"
        with mock.patch.object(installer, "pnpm_execpath", lambda: entry):
            for base in ({}, {"npm_execpath": ""},
                         {"npm_execpath": str(self.given)},
                         {"npm_execpath": r"E:\.pnpm-store\gone\pnpm.mjs"}):
                extras = self._extras(base)
                self.assertNotIn("npm_execpath", extras,
                                 f"补它正是构建失败的原因（环境={base!r}）")

    def test_offline_source_gets_only_the_commit_hash(self):
        extras = self._extras({})
        self.assertEqual(list(extras), ["DSH_CLIENT_COMMIT_HASH"],
                         "离线源码该补的只有提交号这一项")


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
