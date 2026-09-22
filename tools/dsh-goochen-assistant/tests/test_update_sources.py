# -*- coding: utf-8 -*-
"""更新来源与更新动作（按远端拓扑给按钮 + 合并/备份/冲突安全中止）。

与用户对齐的三条规矩：
1. 只有官方远端 → 只给「从官方更新」；官方之外还有自己的远端 → 再多一条
   「从你的仓库更新（owner）」；两条都没有就说清楚为什么不能更新。
2. 分叉（不是快进关系）时**默认合并**，而且**动手前先打备份分支**。
3. 官方来源按"镜像优先 → 官方"取；镜像取不到才回落官方。

全部用**本地临时仓库**真跑 git，不联网；只有 `update_sources` 的远端探测用假 run_git
（真发 ls-remote 会连 github，测试不该依赖网络）。
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _tempguard  # noqa: F401,E402  临时目录统一收口

import gitinfo as gi  # noqa: E402
import installer  # noqa: E402
from git_helpers import GIT, add_remote, git, make_repo  # noqa: E402

OFFICIAL_URL = "git@github.com:deepseek-ai/deepseek-harness.git"
FORK_URL = "git@github.com:Muigoochen/deepseek-harness.git"
TAGS = "\n".join([
    "aaa\trefs/tags/dsh-v0.1.6-alpha.1",
    "eee\trefs/tags/dsh-v0.1.6-alpha.2",
    "eee\trefs/tags/dsh-v0.1.6-alpha.2^{}",
])


_REAL_RUN_GIT = gi.run_git


def _fake_ls_remote(args, cwd=None, *, timeout=None):
    """假的 ls-remote：--tags 给标签，--symref 给默认分支，refs/heads 给分支头。

    **只拦 ls-remote**，其余交回真实现——否则 `repo_info` 连远端都读不到了。
    """
    if not list(args) or list(args)[0] != "ls-remote":
        return _REAL_RUN_GIT(args, cwd, timeout=timeout)
    if "--tags" in args:
        return 0, TAGS, ""
    if "--symref" in args:
        return 0, "ref: refs/heads/master\tHEAD\nabc1234\tHEAD", ""
    if any("refs/heads/" in str(a) for a in args):
        return 0, "abc1234\trefs/heads/main", ""
    return 0, "", ""


@unittest.skipIf(GIT is None, "未安装 git，跳过 git 层测试")
class UpdateSourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-upd-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _repo(self, *remotes):
        repo = make_repo(self.tmp / "repo", message="base")
        for name, url in remotes:
            add_remote(repo, name, url)
        return repo

    def test_official_only_gives_one_source(self):
        repo = self._repo(("upstream", OFFICIAL_URL))
        with mock.patch.object(gi, "run_git", _fake_ls_remote):
            sources, error = gi.update_sources(repo)
        self.assertEqual(error, "")
        self.assertEqual(len(sources), 1, sources)
        self.assertEqual(sources[0].kind, "official")
        self.assertEqual(sources[0].label, "从官方更新")
        self.assertEqual(sources[0].version, "0.1.6-alpha.2")
        self.assertEqual(sources[0].branch, "master")
        self.assertTrue(sources[0].reachable)

    def test_official_plus_fork_gives_two_in_order(self):
        repo = self._repo(("origin", FORK_URL), ("upstream", OFFICIAL_URL))
        with mock.patch.object(gi, "run_git", _fake_ls_remote):
            sources, _ = gi.update_sources(repo)
        self.assertEqual([s.kind for s in sources], ["official", "mine"], sources)
        self.assertEqual(sources[1].label, "从你的仓库更新（Muigoochen）")
        self.assertEqual(sources[1].remote, "origin")
        self.assertEqual(sources[1].branch, "main")

    def test_fork_only_gives_one_source_and_no_official_claim(self):
        repo = self._repo(("origin", FORK_URL))
        with mock.patch.object(gi, "run_git", _fake_ls_remote):
            sources, error = gi.update_sources(repo)
        self.assertEqual(error, "")
        self.assertEqual([s.kind for s in sources], ["mine"], sources)

    def test_no_remote_explains_why_it_cannot_update(self):
        repo = make_repo(self.tmp / "plain", message="base")
        sources, error = gi.update_sources(repo)
        self.assertEqual(sources, [])
        self.assertIn("没有配置任何 DSH 远端", error)


@unittest.skipIf(GIT is None, "未安装 git，跳过 git 层测试")
class UpdateFromTest(unittest.TestCase):
    """真仓库：远端 = 裸库，本地 = 它的克隆。全程离线。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-upd2-"))
        self.mine = make_repo(self.tmp / "mine", message="base")
        self.bare = self.tmp / "mine.git"
        git("clone", "-q", "--bare", str(self.mine), str(self.bare), cwd=self.tmp)
        add_remote(self.mine, "origin", str(self.bare))
        self.local = self.tmp / "local"
        git("clone", "-q", str(self.bare), str(self.local), cwd=self.tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- 工具 ---------------------------------------------------------------
    def _source(self, remote="origin", kind="mine", branch="main"):
        return gi.UpdateSource(kind=kind, label="从你的仓库更新（test）",
                               remote=remote, url=str(self.bare), branch=branch)

    def _commit_in_mine(self, text, name="file.txt"):
        (self.mine / name).write_text(text, encoding="utf-8")
        git("add", "-A", cwd=self.mine)
        git("commit", "-q", "-m", f"远端：{text}", cwd=self.mine)
        git("push", "-q", "origin", "main", cwd=self.mine)

    def _commit_in_local(self, text, name="file.txt"):
        (self.local / name).write_text(text, encoding="utf-8")
        git("add", "-A", cwd=self.local)
        git("commit", "-q", "-m", f"本地：{text}", cwd=self.local)

    def _head(self, repo):
        return git("rev-parse", "--short", "HEAD", cwd=repo).strip()

    def _branches(self, repo):
        return git("branch", "--format=%(refname:short)", cwd=repo).split()

    # -- 用例 ---------------------------------------------------------------
    def test_fast_forward_when_local_has_nothing_of_its_own(self):
        self._commit_in_mine("v2")
        result = gi.update_from(self.local, self._source())
        self.assertTrue(result.ok, result.error)
        self.assertTrue(result.changed)
        self.assertEqual(result.strategy, "ff")
        self.assertEqual(result.backup, "", "快进不需要备份")
        self.assertEqual((self.local / "file.txt").read_text(encoding="utf-8"), "v2")

    def test_nothing_to_do_is_success_not_failure(self):
        result = gi.update_from(self.local, self._source())
        self.assertTrue(result.ok, result.error)
        self.assertFalse(result.changed)

    def test_diverged_merges_and_leaves_a_backup_branch(self):
        self._commit_in_local("local-change")
        self._commit_in_mine("remote-change", name="other.txt")
        result = gi.update_from(self.local, self._source(), strategy="merge")
        self.assertTrue(result.ok, result.error)
        self.assertTrue(result.changed)
        self.assertEqual(result.strategy, "merge")
        self.assertTrue(result.backup.startswith("backup/before-update-"), result.backup)
        self.assertIn(result.backup, self._branches(self.local), "备份分支必须真的建出来")
        self.assertTrue((self.local / "file.txt").exists(), "本地改动要还在")
        self.assertTrue((self.local / "other.txt").exists(), "远端改动要合进来")

    def test_conflict_aborts_completely_and_keeps_the_backup(self):
        self._commit_in_local("local-version")
        self._commit_in_mine("remote-version")
        before = self._head(self.local)
        result = gi.update_from(self.local, self._source(), strategy="merge")
        self.assertFalse(result.ok)
        self.assertTrue(result.conflict)
        self.assertIn("冲突", result.error)
        self.assertTrue(result.backup, "冲突前也要留好备份分支")
        self.assertIn(result.backup, self._branches(self.local))
        self.assertEqual(self._head(self.local), before, "命中冲突后必须整体撤销")
        self.assertEqual(git("status", "--porcelain", cwd=self.local).strip(), "",
                         "撤销后工作区必须是干净的")
        self.assertFalse((self.local / ".git" / "MERGE_HEAD").exists(), "不能留下半个合并")

    def test_fast_forward_only_strategy_refuses_but_changes_nothing(self):
        self._commit_in_local("local-change")
        self._commit_in_mine("remote-change", name="other.txt")
        before = self._head(self.local)
        result = gi.update_from(self.local, self._source(), strategy="ff")
        self.assertFalse(result.ok)
        self.assertIn("不是快进关系", result.error)
        self.assertEqual(self._head(self.local), before)
        self.assertEqual(result.backup, "", "只快进模式不该建备份")

    def test_dirty_tree_is_refused_before_touching_anything(self):
        self._commit_in_mine("v2")
        (self.local / "file.txt").write_text("未提交的改动", encoding="utf-8")
        result = gi.update_from(self.local, self._source())
        self.assertFalse(result.ok)
        self.assertIn("本地改动", result.error)
        self.assertEqual((self.local / "file.txt").read_text(encoding="utf-8"),
                         "未提交的改动")

    def test_official_source_prefers_the_mirror(self):
        """镜像优先：官方源和镜像各有一个新提交，应该合进**镜像**那个。"""
        mirror = self.tmp / "mirror.git"
        git("clone", "-q", "--bare", str(self.bare), str(mirror), cwd=self.tmp)
        self._commit_in_mine("from-official", name="official.txt")
        # 镜像那边再往后走一个提交（模拟镜像比官方"更新"或至少可区分）
        mirror_work = self.tmp / "mirror-work"
        git("clone", "-q", str(mirror), str(mirror_work), cwd=self.tmp)
        git("remote", "add", "up", str(mirror), cwd=mirror_work)
        (mirror_work / "from-mirror.txt").write_text("mirror", encoding="utf-8")
        git("add", "-A", cwd=mirror_work)
        git("commit", "-q", "-m", "镜像：多一个文件", cwd=mirror_work)
        git("push", "-q", "up", "HEAD:main", cwd=mirror_work)

        source = gi.UpdateSource(kind="official", label="从官方更新", owner="deepseek-ai",
                                 remote="origin", url=str(self.bare), branch="main")
        with mock.patch.object(gi, "FETCH_TIMEOUT", 60):
            result = gi.update_from(self.local, source, mirrors=[str(mirror)])
        self.assertTrue(result.ok, result.error)
        self.assertTrue((self.local / "from-mirror.txt").exists(),
                        "应当走镜像那份（镜像优先）")

    def test_mirror_failure_falls_back_to_the_official_remote(self):
        self._commit_in_mine("v2")
        source = gi.UpdateSource(kind="official", label="从官方更新", owner="deepseek-ai",
                                 remote="origin", url=str(self.bare), branch="main")
        result = gi.update_from(self.local, source,
                                mirrors=[str(self.tmp / "不存在.git")])
        self.assertTrue(result.ok, result.error)
        self.assertEqual((self.local / "file.txt").read_text(encoding="utf-8"), "v2")


@unittest.skipIf(GIT is None, "未安装 git，跳过")
class UpdateButtonsGuiTest(unittest.TestCase):
    """真构造窗口，验证按钮按远端拓扑显示（不是靠读代码猜）。"""

    def setUp(self) -> None:
        try:
            self.app = installer.App()
        except Exception as exc:                       # noqa: BLE001
            self.skipTest(f"无法构造界面：{exc}")
        self.app.update()

    def tearDown(self) -> None:
        try:
            self.app.destroy()
        except Exception:                              # noqa: BLE001
            pass

    def _shown(self):
        out = []
        for kind, btn in (("official", self.app.btn_update_official),
                          ("mine", self.app.btn_update_mine)):
            if btn.winfo_manager():                    # 被 pack 过才算真的显示
                out.append((kind, btn.cget("text")))
        return out

    def test_two_buttons_when_official_and_mine_exist(self):
        self.app._refresh_update_buttons([
            gi.UpdateSource(kind="official", label="从官方更新", reachable=True),
            gi.UpdateSource(kind="mine", label="从你的仓库更新（Muigoochen）",
                            reachable=True)])
        self.app.update()
        self.assertEqual(self._shown(), [("official", "从官方更新"),
                                         ("mine", "从你的仓库更新（Muigoochen）")])

    def test_only_official_button_when_cloned_from_official(self):
        self.app._refresh_update_buttons([
            gi.UpdateSource(kind="official", label="从官方更新", reachable=True)])
        self.app.update()
        self.assertEqual(self._shown(), [("official", "从官方更新")])

    def test_only_mine_button_without_official_remote(self):
        self.app._refresh_update_buttons([
            gi.UpdateSource(kind="mine", label="从你的仓库更新（Muigoochen）",
                            reachable=True)])
        self.app.update()
        self.assertEqual(self._shown(), [("mine", "从你的仓库更新（Muigoochen）")])

    def test_no_button_when_there_is_no_source(self):
        self.app._refresh_update_buttons([], "没有配置任何 DSH 远端")
        self.app.update()
        self.assertEqual(self._shown(), [])


class UpdateWorkerTest(unittest.TestCase):
    """更新工作线程的接线：来源怎么选、镜像怎么传、成功后才重装依赖+重建、失败不重建。

    直接以**未绑定**方式调用 `App._update_worker`，用一个只带它真正用到的那几个属性的
    替身——不用开窗口，也不需要网络。
    """

    class _Fake:
        def __init__(self, sources):
            self._update_sources = sources
            self.log: list[str] = []
            self.posted: list[tuple] = []

        def _append(self, msg):
            self.log.append(str(msg))

        def _update_done(self, ok, detail, was_running):
            """工作线程会把它当回调交给 _post；替身里只要存在即可（_post 只记录）。"""

        def _post(self, func, *args):
            self.posted.append((getattr(func, "__name__", str(func)), args))

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-updw-"))
        self.target = self.tmp / "repo"
        self.target.mkdir()
        self.source = gi.UpdateSource(kind="official", label="从官方更新",
                                      remote="upstream", url="git@example/x.git",
                                      branch="master")
        self.mine = gi.UpdateSource(kind="mine", label="从你的仓库更新（me）",
                                    remote="origin", url="git@example/y.git",
                                    branch="plugins")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_worker(self, result, *, kind="official", mirrors=("https://mirror/x.git",),
                    engine=None):
        fake = self._Fake([self.source, self.mine])
        calls: list[tuple] = []
        updated: list[tuple] = []

        def fake_update_from(path, source, *, mirrors=(), strategy=""):
            updated.append((source, tuple(mirrors), strategy))
            return result

        class FakeEngine:
            def __init__(self, *args, **kwargs):
                calls.append(("engine", kwargs.get("use_mirror")))

            def install_deps(self, path, *, force=False):
                calls.append(("deps", force))

            def build(self, path, *, force=False):
                calls.append(("build", force))

        with mock.patch.object(gi, "update_from", fake_update_from), \
                mock.patch.object(installer, "Engine", FakeEngine), \
                mock.patch.object(installer, "git_mirrors", lambda: list(mirrors)), \
                mock.patch.object(installer, "clear_interrupted", lambda _p: None):
            installer.App._update_worker(fake, self.target, False, True, kind)
        return fake, calls, updated

    def test_official_update_passes_mirrors_and_rebuilds_after_success(self):
        result = gi.UpdateResult(ok=True, changed=True, before="aaa", after="bbb",
                                 subject="官方新提交", strategy="merge",
                                 backup="backup/before-update-1")
        fake, calls, updated = self._run_worker(result)
        source, mirrors, strategy = updated[0]
        self.assertEqual(source.kind, "official")
        self.assertEqual(mirrors, ("https://mirror/x.git",), "官方来源必须带上镜像")
        self.assertEqual(strategy, "merge", "分叉时默认合并")
        self.assertIn(("deps", True), calls, "成功后要重装依赖")
        self.assertIn(("build", True), calls, "成功后要重新构建")
        self.assertEqual([p[0] for p in fake.posted], ["_update_done"])
        self.assertTrue(fake.posted[0][1][0], "应当报告成功")
        self.assertTrue(any("可以退回去" in line for line in fake.log),
                        "有备份分支就要告诉用户怎么退回去")

    def test_mine_update_never_uses_the_official_mirrors(self):
        result = gi.UpdateResult(ok=True, changed=True, before="a", after="b",
                                 strategy="ff")
        _, _, updated = self._run_worker(result, kind="mine")
        self.assertEqual(updated[0][1], (), "自己的仓库不该走官方镜像")

    def test_conflict_is_reported_and_nothing_is_rebuilt(self):
        result = gi.UpdateResult(ok=False, conflict=True, backup="backup/before-update-2",
                                 error="冲突没能完成：…已整体撤销。")
        fake, calls, _ = self._run_worker(result)
        self.assertNotIn(("deps", True), calls, "冲突后绝不能继续重装/重建")
        self.assertNotIn(("build", True), calls)
        name, args = fake.posted[0]
        self.assertEqual(name, "_update_done")
        self.assertFalse(args[0], "冲突要如实报失败")
        self.assertIn("冲突", args[1])

    def test_no_change_reports_success_without_rebuilding(self):
        result = gi.UpdateResult(ok=True, changed=False, before="a", after="a")
        fake, calls, _ = self._run_worker(result)
        self.assertNotIn(("deps", True), calls)
        self.assertEqual(fake.posted[0][1], (True, "已是最新", False))

    def test_missing_source_is_reported_instead_of_crashing(self):
        fake = self._Fake([])
        with mock.patch.object(gi, "update_from") as never:
            installer.App._update_worker(fake, self.target, False, True, "official")
        never.assert_not_called()
        self.assertEqual(fake.posted[0][1][0], False)
        self.assertIn("没有可用的更新来源", fake.posted[0][1][1])


if __name__ == "__main__":
    unittest.main()
