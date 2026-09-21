# -*- coding: utf-8 -*-
"""检查更新：**必须同时对照官方**，不能只跟自己的 fork 比。

真机实测的坑（用户报的）：本地 checkout 是 0.1.2-alpha.3、官方已经到 0.1.6-alpha.2，
小助手却显示"✓ 已是最新（非官方远端）"——因为它只 fetch 了当前分支跟踪的 `origin`
（用户自己的 fork），`behind=0` 就被当成"最新"。修法：跟跟踪远端比之外，
再用 `ls-remote` 独立核对官方版本（不 fetch 历史：直连官方全量 fetch 实测十分钟不返回，
`ls-remote` 只要几秒）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _tempguard  # noqa: F401,E402  临时目录统一收口

import gitinfo as gi  # noqa: E402
import installer  # noqa: E402

FORK = "git@github.com:Muigoochen/deepseek-harness.git"
OFFICIAL = "git@github.com:deepseek-ai/deepseek-harness.git"
TAGS = "\n".join([
    "aaa\trefs/tags/dsh-v0.1.2-alpha.5",
    "bbb\trefs/tags/dsh-v0.1.3-alpha.1",
    "ccc\trefs/tags/dsh-v0.1.5-rc.2",
    "ddd\trefs/tags/dsh-v0.1.6-alpha.1",
    "eee\trefs/tags/dsh-v0.1.6-alpha.2",
    "eee\trefs/tags/dsh-v0.1.6-alpha.2^{}",     # peeled 行要忽略
    "fff\trefs/tags/some-other-tag",            # 非 dsh-v 前缀要忽略
    "ggg\trefs/heads/master",                   # 非 tag 行要忽略
])
HEADS = "ddefc45fbc7f8e46dd73185e68295696d1297887\trefs/heads/master"


class VersionKeyTest(unittest.TestCase):
    def test_orders_prereleases_below_releases(self):
        self.assertGreater(gi.version_key("0.1.6"), gi.version_key("0.1.6-rc.2"))
        self.assertGreater(gi.version_key("0.1.6-rc.2"), gi.version_key("0.1.6-beta.1"))
        self.assertGreater(gi.version_key("0.1.6-beta.1"), gi.version_key("0.1.6-alpha.9"))

    def test_compares_numbers_not_strings(self):
        self.assertGreater(gi.version_key("0.1.6-alpha.10"), gi.version_key("0.1.6-alpha.2"))
        self.assertGreater(gi.version_key("0.1.6-alpha.2"), gi.version_key("0.1.5-rc.2"))

    def test_the_reported_gap_is_recognised(self):
        self.assertGreater(gi.version_key("0.1.6-alpha.2"), gi.version_key("0.1.2-alpha.3"))


class OfficialRemoteNameTest(unittest.TestCase):
    def test_finds_official_and_prefers_upstream(self):
        self.assertEqual(gi.official_remote_name({"upstream": OFFICIAL}), "upstream")
        self.assertEqual(gi.official_remote_name({"origin": FORK, "ali": OFFICIAL}), "ali")

    def test_fork_is_not_official(self):
        self.assertEqual(gi.official_remote_name({"origin": FORK}), "")


class OfficialStatusTest(unittest.TestCase):
    def _info(self):
        return mock.Mock(remotes={"origin": FORK, "upstream": OFFICIAL})

    def test_picks_the_newest_official_tag_and_head(self):
        def fake_run_git(args, cwd=None, *, timeout=None):
            if "--tags" in args:
                return 0, TAGS, ""
            return 0, HEADS, ""

        with mock.patch.object(gi, "run_git", fake_run_git):
            status = gi.official_status(self._info())
        self.assertTrue(status.ok, status.error)
        self.assertEqual(status.version, "0.1.6-alpha.2")
        self.assertEqual(status.tag, "dsh-v0.1.6-alpha.2")
        self.assertEqual(status.branch, "master")
        self.assertEqual(status.head, "ddefc45")
        self.assertEqual(status.remote, "upstream")

    def test_no_official_remote_is_reported_not_guessed(self):
        status = gi.official_status(mock.Mock(remotes={"origin": FORK}))
        self.assertFalse(status.ok)
        self.assertIn("没有配置官方远端", status.error)

    def test_ls_remote_failure_is_reported(self):
        with mock.patch.object(gi, "run_git", lambda *a, **k: (124, "", "git 超时")):
            status = gi.official_status(self._info())
        self.assertFalse(status.ok)
        self.assertIn("ls-remote", status.error)


class UpdateSummaryTest(unittest.TestCase):
    """界面那行字——**官方更新时必须压过"分支没落后"的错觉**。"""

    def _status(self, *, behind=0, ahead=0, official=None, version="0.1.2-alpha.3"):
        return gi.UpdateStatus(ok=True, behind=behind, ahead=ahead, branch="plugins",
                               remote="origin", upstream="origin/plugins", official=False,
                               latest="beb3fd9", latest_subject="feat(lsp-echo): …",
                               version=version, official_status=official)

    def _official(self, version="0.1.6-alpha.2"):
        return gi.OfficialStatus(ok=True, remote="upstream", url=OFFICIAL,
                                 version=version, tag=f"dsh-v{version}",
                                 branch="master", head="ddefc45")

    def test_fork_even_but_official_ahead_never_says_up_to_date(self):
        text, color = installer.update_summary(self._status(official=self._official()))
        self.assertIn("官方已到 0.1.6-alpha.2", text)
        self.assertIn("0.1.2-alpha.3", text)
        self.assertNotIn("已是最新", text, "官方更新时绝不能显示『已是最新』")
        self.assertIn("非官方远端", text)
        self.assertEqual(color, "#a05a00")

    def test_truly_up_to_date_still_says_so(self):
        text, color = installer.update_summary(
            self._status(official=self._official("0.1.2-alpha.3")))
        self.assertIn("已是最新", text)
        self.assertEqual(color, "#1a6b1a")

    def test_no_official_info_keeps_the_old_wording(self):
        text, _ = installer.update_summary(self._status())
        self.assertIn("已是最新", text)

    def test_behind_the_tracked_remote_wins_the_headline(self):
        text, _ = installer.update_summary(
            self._status(behind=3, official=self._official()))
        self.assertIn("落后 3 个提交", text)
        self.assertIn("feat(lsp-echo)", text)

    def test_official_remote_tracking_reports_official(self):
        status = gi.UpdateStatus(ok=True, behind=0, branch="master", remote="upstream",
                                 upstream="upstream/master", official=True,
                                 version="0.1.6-alpha.2",
                                 official_status=self._official())
        text, color = installer.update_summary(status)
        self.assertIn("已是最新", text)
        self.assertNotIn("非官方远端", text)
        self.assertEqual(color, "#1a6b1a")


if __name__ == "__main__":
    unittest.main()
