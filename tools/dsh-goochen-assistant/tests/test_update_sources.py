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

import os
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

    def test_asks_to_push_back_only_when_mine_exists(self):
        """合完官方之后，只有"用户还有自己的仓库"时才问要不要推回去。"""
        calls: list = []
        self.app._update_sources = [gi.UpdateSource(kind="mine", label="从你的仓库更新（me）",
                                                    remote="origin", branch="plugins")]
        with mock.patch.object(type(self.app), "_maybe_push_to_mine",
                               lambda _self, mine, was_running:
                               calls.append(mine) or False):
            self.app._update_done(True, "a → b", False)
        self.assertEqual(len(calls), 1, "有自己仓库就该问一句")
        calls.clear()
        self.app._update_sources = []
        with mock.patch.object(type(self.app), "_maybe_push_to_mine",
                               lambda _self, mine, was_running:
                               calls.append(mine) or False):
            self.app._update_done(True, "a → b", False)
        self.assertEqual(calls, [], "没有自己仓库就别问")

    def test_mine_button_is_not_width_capped(self):
        """「从你的仓库更新（owner）」带 owner 名字，宽度写死会把名字截断。

        真机上用户看到的就是"从你的仓库更新(Muig"——所以这个按钮的宽度必须是自适应（0）。
        """
        self.app._refresh_update_buttons([
            gi.UpdateSource(kind="mine", label="从你的仓库更新（Muigoochen）",
                            reachable=True)])
        self.app.update()
        self.assertIn(self.app.btn_update_mine.cget("width"), ("", 0, "0"),
                      "宽度不能写死，否则长名字被截断")
        self.assertEqual(self.app.btn_update_mine.cget("text"),
                         "从你的仓库更新（Muigoochen）")

    def test_port_dialog_does_not_contradict_itself(self):
        """端口弹窗里「谁占着」和「是不是本窗口启动的」必须一致。

        真机踩过：上一句说"正被本窗口启动的服务占用"，下一句却说"这个服务不是本窗口
        启动的"——用户一眼就看出来了。
        """
        seen: list = []
        fake_proc = mock.Mock()
        fake_proc.poll.return_value = None          # 本窗口启动的服务还活着
        self.app.web_proc = fake_proc
        with mock.patch.object(installer, "port_in_use", lambda: True), \
                mock.patch.object(installer.childproc, "port_owner_pids",
                                  lambda _port: [1234]), \
                mock.patch.object(installer.messagebox, "askyesno",
                                  lambda *a, **k: seen.append(a[1]) or False):
            self.assertFalse(self.app.ensure_port_free("测试用途：启动点什么"))
        self.assertTrue(seen, "端口被占就该弹窗")
        self.assertIn("本窗口启动的服务", seen[0])
        self.assertNotIn("不是本窗口启动的", seen[0], "不能自相矛盾")

        seen.clear()
        self.app.web_proc = None                    # 换成别人的进程占着
        with mock.patch.object(installer, "port_in_use", lambda: True), \
                mock.patch.object(installer.childproc, "port_owner_pids",
                                  lambda _port: [1234]), \
                mock.patch.object(installer.messagebox, "askyesno",
                                  lambda *a, **k: seen.append(a[1]) or False):
            self.assertFalse(self.app.ensure_port_free("测试用途：启动点什么"))
        self.assertIn("PID 1234", seen[0])
        self.assertIn("不是本窗口启动的", seen[0])

    def test_official_half_survives_a_failed_tracked_check(self):
        """跟踪远端查失败时，官方那一半（单独问到的）必须照样显示。

        真机踩过：这条路径一失败就只剩"检查失败"，用户以为什么都没查到。
        """
        official = gi.OfficialStatus(
            ok=True, remote="upstream",
            url="git@github.com:deepseek-ai/deepseek-harness.git",
            version="0.1.6-alpha.2", tag="dsh-v0.1.6-alpha.2",
            branch="master", head="ddefc45", behind=3482)
        self.app._show_update_status(gi.UpdateStatus(
            ok=False, error="git fetch 失败：连不上", version="0.1.2-alpha.3",
            official_status=official))
        text = self.app.git_note.cget("text")
        self.assertIn("官方已到 0.1.6-alpha.2", text, "官方那一半不能丢")
        self.assertIn("你那边没查成", text)
        self.assertNotIn("检查失败", text)
        self.app._show_update_status(gi.UpdateStatus(ok=False, error="没有名为 x 的远端"))
        self.assertIn("检查失败", self.app.git_note.cget("text"))

    def test_update_is_cancelled_when_the_service_cannot_be_stopped(self):
        """服务停不掉（不是本窗口启动的、用户不肯结束）时，绝不该开始更新。

        否则源码被换掉、旧进程还在跑，紧跟着的重装依赖和重建会跟它抢文件。
        """
        source = gi.UpdateSource(kind="official", label="从官方更新", remote="upstream",
                                 url="git@github.com:deepseek-ai/deepseek-harness.git",
                                 branch="master", reachable=True)
        self.app._update_sources = [source]
        clean = gi.RepoInfo(ok=True, root=Path("E:/x"), branch="plugins", dirty=0)
        asked = []
        with mock.patch.object(type(self.app), "_effective_dir", lambda _s: Path("E:/x")), \
                mock.patch.object(installer.ginfo, "repo_info", return_value=clean), \
                mock.patch.object(installer, "verify_install_dir",
                                  return_value=mock.Mock(ok=True, evidence="测试")), \
                mock.patch.object(type(self.app), "ensure_port_free",
                                  lambda *a, **k: False), \
                mock.patch.object(installer.messagebox, "askyesno",
                                  lambda *a, **k: asked.append(a) or True):
            self.app.on_update_from("official")
        self.assertEqual(asked, [], "端口没空出来就不该走到确认框")
        self.assertFalse(self.app.git_busy, "也不该留下「正在忙」的状态")

    def test_deepen_button_only_when_shallow(self):
        """浅克隆要能看到「补齐历史」；历史完整时不该出现（免得误导）。"""
        self.app._refresh_update_buttons([], "", True)
        self.app.update()
        self.assertTrue(self.app.btn_deepen.winfo_manager(), "浅克隆时应当出现补齐历史")
        self.app._refresh_update_buttons([], "", False)
        self.app.update()
        self.assertFalse(self.app.btn_deepen.winfo_manager(), "历史完整时不该出现")

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

    def _run_worker(self, result, *, kind="official",
                    mirrors=(("国内镜像1", "https://mirror/x.git"),), source=None):
        """真跑一遍更新工作线程。

        `mirrors` 用**真实形状** `(名字, 地址)` 二元组——`installer.git_mirrors()` 就是这个形状，
        子代理审查时正因为我用字符串列表打桩，漏掉了"传元组给 git 直接抛 TypeError"这个必炸 bug。
        """
        fake = self._Fake([self.source, self.mine])
        calls: list[tuple] = []
        updated: list[tuple] = []
        chosen = source if source is not None else (
            self.source if kind == "official" else self.mine)

        def fake_update_from(path, src, *, mirrors=(), strategy=""):
            updated.append((src, tuple(mirrors), strategy))
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
            installer.App._update_worker(fake, self.target, False, True, chosen)
        return fake, calls, updated

    def test_official_update_passes_mirrors_and_rebuilds_after_success(self):
        result = gi.UpdateResult(ok=True, changed=True, before="aaa", after="bbb",
                                 subject="官方新提交", strategy="merge",
                                 backup="backup/before-update-1")
        fake, calls, updated = self._run_worker(result)
        source, mirrors, strategy = updated[0]
        self.assertEqual(source.kind, "official")
        self.assertEqual(mirrors, ("https://mirror/x.git",),
                         "配置里的 (名字,地址) 必须拆成地址再交给 git")
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
            installer.App._update_worker(fake, self.target, False, True, None)
        never.assert_not_called()
        self.assertEqual(fake.posted[0][1][0], False)
        self.assertIn("没有可用的更新来源", fake.posted[0][1][1])


class ShallowOfficialFetchTest(unittest.TestCase):
    """官方那条路的真机约束（都是副本测试抓出来的）：

    · 受限网络里全量 fetch 十分钟不返回，`--depth 1` 163 秒能取回同一个提交 → 必须能浅取；
    · 浅克隆里两边可能**没有共同祖先** → 不能硬合，要如实说清楚；
    · 冲突提示必须点出是哪些文件（不然就是"冲突没能完成：。"这种空话）。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-shallow-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _remote_and_shallow_clone(self):
        remote = make_repo(self.tmp / "origin", message="第一版")
        work = self.tmp / "work"
        # 必须用 file:// —— 本地路径克隆时 git 会忽略 --depth，那就不是浅克隆了
        git("clone", "-q", "--depth", "1", remote.as_uri(), str(work), cwd=self.tmp)
        self.assertEqual(git("rev-parse", "--is-shallow-repository", cwd=work).strip(),
                         "true", "前置条件：work 必须是浅克隆")
        (remote / "RE_官方新增.txt").write_text("官方新增\n", encoding="utf-8")
        git("add", "-A", cwd=remote)
        git("commit", "-q", "-m", "官方：新增文件", cwd=remote)
        return remote, work

    def _official(self, remote: Path, branch: str = "main") -> gi.UpdateSource:
        return gi.UpdateSource(kind="official", label="从官方更新",
                               url=str(remote), branch=branch)

    def test_shallow_repo_without_common_ancestor_says_so_clearly(self):
        remote, work = self._remote_and_shallow_clone()
        # 给远端造一条孤儿分支：和 work 这边**没有任何共同祖先**
        git("checkout", "-q", "--orphan", "other", cwd=remote)
        git("add", "-A", cwd=remote)
        git("commit", "-q", "-m", "另一棵树", cwd=remote)
        git("checkout", "-q", "main", cwd=remote)
        head_before = git("rev-parse", "HEAD", cwd=work)
        res = gi.update_from(work, self._official(remote, "other"))
        self.assertFalse(res.ok)
        self.assertIn("浅克隆", res.error)
        self.assertIn("共同祖先", res.error)
        self.assertIn("你的文件没有被改动", res.error)
        self.assertEqual(git("rev-parse", "HEAD", cwd=work), head_before, "拒绝后不能动 HEAD")

    def test_conflict_message_names_the_conflicting_files(self):
        remote = make_repo(self.tmp / "origin", message="第一版")
        work = self.tmp / "work"
        git("clone", "-q", str(remote), str(work), cwd=self.tmp)
        # 故意用中文文件名：git 默认会把非 ASCII 路径转义成 "RE_\346\274\224..."，
        # 直接甩给用户就是乱码，所以这里把它钉住
        name = "RE_中文文件.md"
        (remote / name).write_text("官方改的\n", encoding="utf-8")
        git("add", "-A", cwd=remote)
        git("commit", "-q", "-m", "官方改中文文件", cwd=remote)
        (work / name).write_text("我改的\n", encoding="utf-8")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "我也改中文文件", cwd=work)
        res = gi.update_from(work, self._official(remote))
        self.assertTrue(res.conflict, res.error)
        self.assertIn(name, res.error, "冲突提示必须点出是哪些文件")
        self.assertNotIn("\\346", res.error, "中文文件名不能被 git 转义成乱码")
        self.assertIn("已整体撤销", res.error)


class OfficialStatusCwdTest(unittest.TestCase):
    """官方核对必须**站在目标目录里**问远端。

    子代理审查抓出来的严重 bug：`ls-remote --tags upstream` 少了 cwd 时，git 会拿
    "进程当前目录"那个仓库去解析 `upstream` 这个名字——打包运行时当前目录根本不是仓库，
    直接失败（界面于是变成绿色"✓ 已是最新"）；当前目录恰好是**另一个也有 upstream** 的
    仓库时更糟：会拿别人的 tag 当官方版本。开发机上它"碰巧对"，把这个 bug 藏住了。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-cwd-"))
        self.old_cwd = os.getcwd()

    def tearDown(self) -> None:
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _repo_with_upstream(self, root: Path, tag: str) -> Path:
        bare = root.parent / f"{root.name}-official.git"
        root.parent.mkdir(parents=True, exist_ok=True)
        git("init", "-q", "--bare", str(bare), cwd=root.parent)
        work = make_repo(root, message="init")
        # 远端地址写成**真官方地址**：official_remote_name 是按 URL 判断的，写本地路径就认不出来。
        # （这也说明为什么不能用 url.<x>.insteadOf 把地址改写到本地——`git remote -v`
        #  会自己套用 insteadOf，远端读出来就不再是官方地址了。）
        git("remote", "add", "upstream", OFFICIAL_URL, cwd=work)
        git("tag", f"dsh-v{tag}", cwd=work)
        git("push", "-q", str(bare), "main", "--tags", cwd=work)
        return work

    def test_ls_remote_runs_inside_the_target_repo(self):
        target = self._repo_with_upstream(self.tmp / "a", "0.1.6-alpha.2")
        other = self._repo_with_upstream(self.tmp / "b", "9.9.9-alpha.1")
        os.chdir(other)          # 当前目录是**另一个**也有 upstream 的仓库
        seen: list = []

        def spy(args, path=None, timeout=None):
            if args and args[0] == "ls-remote":
                seen.append(None if path is None else str(path))
                return 0, "d0a458a9\trefs/tags/dsh-v0.1.6-alpha.2\n", ""
            return _REAL_RUN_GIT(args, path, timeout=timeout)

        with mock.patch.object(gi, "run_git", spy):
            status = gi.official_status(gi.repo_info(target))
        self.assertTrue(status.ok, status.error)
        self.assertEqual(status.version, "0.1.6-alpha.2")
        self.assertTrue(seen, "应当真的问过远端")
        self.assertEqual(set(seen), {str(target)},
                         f"ls-remote 必须站在目标目录里跑，否则会问到别的仓库；实际：{seen}")


class DepsChangeTest(unittest.TestCase):
    """依赖清单变了才重装依赖；只改源码就别再花几分钟装一遍。

    实测依据（本地 0.1.2 → 官方 0.1.6）：3482 个提交、10459 个改动路径里有 332 个依赖清单，
    pnpm-lock.yaml 变了 8071 行——那一次重装是必需的，不是因为"更新了就该装"。
    """

    def test_manifest_changes_need_reinstall(self):
        self.assertTrue(gi.deps_touched(["pnpm-lock.yaml"]))
        self.assertTrue(gi.deps_touched(["pnpm-workspace.yaml"]))
        self.assertTrue(gi.deps_touched(["packages/core/agent/package.json"]))
        self.assertTrue(gi.deps_touched(["patches/some.patch"]))

    def test_source_only_changes_skip_reinstall(self):
        self.assertFalse(gi.deps_touched(["packages/core/agent/src/loop.ts", "README.md",
                                          "docs/architecture.md"]))

    def test_changed_paths_reads_the_real_diff(self):
        tmp = Path(tempfile.mkdtemp(prefix="dsh-changed-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        repo = make_repo(tmp / "repo", message="第一版")
        before = git("rev-parse", "HEAD", cwd=repo).strip()   # 助手带换行，拼范围前必须去掉
        (repo / "package.json").write_text('{"name":"x"}\n', encoding="utf-8")
        git("add", "-A", cwd=repo)
        git("commit", "-q", "-m", "改清单", cwd=repo)
        after = git("rev-parse", "HEAD", cwd=repo).strip()
        paths = gi.changed_paths(repo, before, after)
        self.assertEqual(paths, ["package.json"])
        self.assertTrue(gi.deps_touched(paths))
        self.assertIsNone(gi.changed_paths(repo, "", ""),
                          "取不到就返回 None，别让调用方当成「没变」")


class NoNeedlessBackupTest(unittest.TestCase):
    """远端那个头已经在本地里时：不动、**也不打备份分支**。

    实测暴露的脏点：副本上多跑一次更新就多一条 backup/before-update-…，什么都没改。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-nobackup-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_no_backup_branch_when_remote_head_is_already_local(self):
        bare = self.tmp / "mine.git"
        git("init", "-q", "--bare", str(bare), cwd=self.tmp)
        work = make_repo(self.tmp / "work", message="第一版")
        git("remote", "add", "origin", str(bare), cwd=work)
        git("push", "-q", "-u", "origin", "main", cwd=work)
        (work / "RE_本地又写了一点.md").write_text("本地\n", encoding="utf-8")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "本地又在前面走了一步", cwd=work)   # 本地比远端新
        before = git("rev-parse", "HEAD", cwd=work)
        source = gi.UpdateSource(kind="mine", label="从你的仓库更新（me）", remote="origin",
                                 branch="main", reachable=True)
        result = gi.update_from(work, source)
        self.assertTrue(result.ok, result.error)
        self.assertFalse(result.changed, "远端没有新东西，就不该改本地")
        self.assertEqual(git("rev-parse", "HEAD", cwd=work), before)
        branches = git("branch", "--list", "backup/*", cwd=work).strip()
        self.assertEqual(branches, "", "什么都没改就不该留下备份分支")


class StatusUnknownGateTest(unittest.TestCase):
    """git status 跑不出来时**绝不能**当成"工作区干净"继续更新。

    查不出来 ≠ 没事：索引被锁、超时都会走到这里，继续下去就可能覆盖别人的改动。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-status-"))
        self.repo = make_repo(self.tmp / "repo", message="第一版")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_update_refuses_when_status_could_not_be_read(self):
        source = gi.UpdateSource(kind="mine", label="从你的仓库更新（me）", remote="origin",
                                 branch="main", reachable=True)
        blind = gi.RepoInfo(ok=True, root=self.repo, branch="main", commit="0" * 40,
                            short="0000000", dirty=0, status_ok=False)
        with mock.patch.object(gi, "repo_info", return_value=blind):
            result = gi.update_from(self.repo, source)
        self.assertFalse(result.ok, "查不出工作区状态就不该动手")
        self.assertIn("查不出工作区状态", result.error)


class PushToOwnRepoTest(unittest.TestCase):
    """把你自己的仓库也更新到同一个状态：本地合完官方之后推回自己的远端。

    没有这一步，"有自己仓库"的用户永远是"本地新、仓库旧"，别的机器从仓库更新拿不到官方。
    只做普通推送，绝不强推；远端比本地新时必须拒绝并说清楚。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-push-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _pair(self):
        bare = self.tmp / "mine.git"
        git("init", "-q", "--bare", str(bare), cwd=self.tmp)
        work = make_repo(self.tmp / "work", message="第一版")
        git("remote", "add", "origin", str(bare), cwd=work)
        git("push", "-q", "-u", "origin", "main", cwd=work)
        return bare, work

    def test_pushes_the_new_commit_to_my_repo(self):
        bare, work = self._pair()
        (work / "RE_新东西.md").write_text("新\n", encoding="utf-8")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "本地新提交", cwd=work)
        ok, error = gi.push_branch(work, "origin", "main")
        self.assertTrue(ok, error)
        self.assertEqual(git("rev-parse", "main", cwd=bare),
                         git("rev-parse", "HEAD", cwd=work),
                         "你自己仓库的分支应当和本地一致了")

    def test_refuses_when_my_repo_is_ahead_instead_of_force_pushing(self):
        bare, work = self._pair()
        other = self.tmp / "other"
        git("clone", "-q", str(bare), str(other), cwd=self.tmp)
        (other / "RE_别处.md").write_text("别处\n", encoding="utf-8")
        git("add", "-A", cwd=other)
        git("commit", "-q", "-m", "别处提交", cwd=other)
        git("push", "-q", "origin", "main", cwd=other)     # 远端先往前走了一步
        (work / "RE_我这边.md").write_text("我这边\n", encoding="utf-8")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "本地新提交", cwd=work)
        before = git("rev-parse", "main", cwd=bare)
        ok, error = gi.push_branch(work, "origin", "main")
        self.assertFalse(ok)
        self.assertIn("远端比本地新", error)
        self.assertEqual(git("rev-parse", "main", cwd=bare), before,
                         "被拒绝时远端一个字节都不能动（绝不强推）")

    def test_missing_remote_is_reported(self):
        _, work = self._pair()
        ok, error = gi.push_branch(work, "", "main")
        self.assertFalse(ok)
        self.assertIn("远端", error)


if __name__ == "__main__":
    unittest.main()
