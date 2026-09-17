# -*- coding: utf-8 -*-
"""gitinfo 单元测试：用**本地临时仓库**真跑 git，不联网。

- 每个用例在临时目录里 `git init` / commit / 加远端，用完即删；
- 「检查更新」用**本地裸仓库**当 origin，所以不需要网络也能验证落后计数；
- 提交一律用 `-c user.email/-c user.name` 传入，不读写用户的全局 git 配置；
- 没装 git 时整个模块跳过（离线机器上不该因此变红）。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gitinfo as gi  # noqa: E402

GIT = gi.git_exe()
IDENT = ["-c", "user.email=test@example.com", "-c", "user.name=Test",
         "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def git(*args: str, cwd: Path) -> str:
    """跑一条 git（测试专用）：失败就抛，避免测试静默通过。"""
    proc = subprocess.run([GIT, *IDENT, *args], cwd=str(cwd), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} 失败：{proc.stderr.strip()}")
    return proc.stdout


def make_repo(root: Path, *, message: str = "init") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", cwd=root)
    (root / "package.json").write_text('{"name": "@deepseek-ai/dsh-root", '
                                       '"version": "1.2.3"}', encoding="utf-8")
    (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
    git("add", "-A", cwd=root)
    git("commit", "-q", "-m", message, cwd=root)
    return root


@unittest.skipIf(GIT is None, "未安装 git，跳过 git 层测试")
class RepoInfoTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-git-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reads_branch_commit_and_version(self) -> None:
        repo = make_repo(self.tmp / "repo", message="第一条提交")
        info = gi.repo_info(repo)
        self.assertTrue(info.ok, info.error)
        self.assertEqual(info.root, repo)
        self.assertEqual(info.branch, "main")
        self.assertEqual(len(info.commit), 40)
        self.assertEqual(info.short, info.commit[:7])
        self.assertEqual(info.subject, "第一条提交")
        self.assertEqual(info.version, "1.2.3")
        self.assertEqual(info.dirty, 0)
        self.assertTrue(info.committed_at)

    def test_counts_local_modifications(self) -> None:
        repo = make_repo(self.tmp / "repo")
        (repo / "package.json").write_text("{}", encoding="utf-8")
        (repo / "新文件.txt").write_text("x", encoding="utf-8")
        self.assertEqual(gi.repo_info(repo).dirty, 2)

    def test_plain_directory_is_not_a_repo(self) -> None:
        plain = self.tmp / "plain"
        plain.mkdir()
        info = gi.repo_info(plain)
        self.assertFalse(info.ok)
        self.assertTrue(info.error)

    def test_missing_directory_reports_cleanly(self) -> None:
        info = gi.repo_info(self.tmp / "nope")
        self.assertFalse(info.ok)
        self.assertIn("不存在", info.error)

    def test_missing_git_is_reported_not_raised(self) -> None:
        with mock.patch.object(gi, "git_exe", return_value=None):
            code, _out, err = gi.run_git(["status"])
            self.assertEqual(code, gi.GIT_MISSING)
            self.assertIn("git", err)
            self.assertFalse(gi.repo_info(self.tmp).ok)


@unittest.skipIf(GIT is None, "未安装 git，跳过 git 层测试")
class IdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-git-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_match_dsh_remote_accepts_common_forms(self) -> None:
        for url in ("git@github.com:deepseek-ai/deepseek-harness.git",
                    "https://github.com/deepseek-ai/deepseek-harness",
                    "https://github.com/Muigoochen/deepseek-harness.git",   # fork
                    "ssh://git@host/org/deepseek-harness.git"):
            self.assertEqual(gi.match_dsh_remote({"origin": url}), url)

    def test_match_dsh_remote_rejects_others(self) -> None:
        for url in ("git@github.com:me/my-app.git",
                    "https://github.com/me/deepseek-harness-fork.git",      # 名字不同就认
                    "https://github.com/me/deepseek_harness.git"):          # 下划线变体
            self.assertEqual(gi.match_dsh_remote({"origin": url}), "", url)

    def test_verify_confirms_dsh_remote(self) -> None:
        repo = make_repo(self.tmp / "repo")
        git("remote", "add", "origin",
            "git@github.com:Muigoochen/deepseek-harness.git", cwd=repo)
        confirmed, evidence = gi.verify_dsh_repo(repo)
        self.assertTrue(confirmed, evidence)
        self.assertIn("deepseek-harness", evidence)

    def test_verify_rejects_other_remote(self) -> None:
        repo = make_repo(self.tmp / "repo")
        git("remote", "add", "origin", "git@github.com:me/my-app.git", cwd=repo)
        confirmed, evidence = gi.verify_dsh_repo(repo)
        self.assertFalse(confirmed)
        self.assertIn("my-app", evidence)

    def test_verify_rejects_subdirectory_of_a_repo(self) -> None:
        """目录只是某个仓库里的子目录 → 不是仓库根，不确认。"""
        repo = make_repo(self.tmp / "repo")
        git("remote", "add", "origin",
            "git@github.com:deepseek-ai/deepseek-harness.git", cwd=repo)
        sub = repo / "packages"
        sub.mkdir()
        confirmed, evidence = gi.verify_dsh_repo(sub)
        self.assertFalse(confirmed)
        self.assertIn("仓库根", evidence)

    def test_verify_accepts_precomputed_info(self) -> None:
        """传进已算好的 info 时不再跑一次 git（省 0.2 秒）。"""
        repo = make_repo(self.tmp / "repo")
        git("remote", "add", "origin",
            "git@github.com:deepseek-ai/deepseek-harness.git", cwd=repo)
        info = gi.repo_info(repo)
        with mock.patch.object(gi, "repo_info") as spy:
            confirmed, _ = gi.verify_dsh_repo(repo, info)
            spy.assert_not_called()
        self.assertTrue(confirmed)


@unittest.skipIf(GIT is None, "未安装 git，跳过 git 层测试")
class CheckUpdateTest(unittest.TestCase):
    """用本地裸仓库当 origin：不需要网络也能验证落后计数。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-git-"))
        self.origin = self.tmp / "origin.git"
        self.origin.mkdir()
        git("init", "-q", "--bare", cwd=self.origin)
        self.seed = make_repo(self.tmp / "seed")
        git("remote", "add", "origin", str(self.origin), cwd=self.seed)
        git("push", "-q", "-u", "origin", "main", cwd=self.seed)
        self.work = self.tmp / "work"
        git("clone", "-q", str(self.origin), str(self.work), cwd=self.tmp)
        # 让本地 HEAD 跟踪 origin/main，供 repo_info 读 ahead/behind
        git("branch", "-q", "--set-upstream-to=origin/main", "main", cwd=self.work)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reports_up_to_date(self) -> None:
        status = gi.check_update(self.work)
        self.assertTrue(status.ok, status.error)
        self.assertEqual((status.behind, status.ahead), (0, 0))
        self.assertEqual(status.branch, "main")

    def test_detects_new_commits_on_remote(self) -> None:
        (self.seed / "CHANGELOG.md").write_text("new\n", encoding="utf-8")
        git("add", "-A", cwd=self.seed)
        git("commit", "-q", "-m", "远端新提交", cwd=self.seed)
        git("push", "-q", "origin", "main", cwd=self.seed)

        status = gi.check_update(self.work)
        self.assertTrue(status.ok, status.error)
        self.assertEqual(status.behind, 1)
        self.assertEqual(status.latest_subject, "远端新提交")

    def test_reports_missing_remote(self) -> None:
        status = gi.check_update(self.work, remote="upstream")
        self.assertFalse(status.ok)
        self.assertIn("远端", status.error)

    def test_reports_unreachable_remote(self) -> None:
        git("remote", "add", "broken", str(self.tmp / "no-such-remote.git"),
            cwd=self.work)
        status = gi.check_update(self.work, remote="broken")
        self.assertFalse(status.ok)
        self.assertIn("fetch 失败", status.error)


if __name__ == "__main__":
    unittest.main()
