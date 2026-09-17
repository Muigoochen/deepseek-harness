# -*- coding: utf-8 -*-
"""插件独立仓库清单 + 安装位置（可配置）单元测试。

标准库 unittest，不联网、不碰真实用户目录：
  - fetch_plugin / update_plugin 一律注入假的 run_git；
  - 安装位置配置写入临时 CONFIG_PATH（不写真实 %USERPROFILE%\\.dsh-assistant）。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import installer  # noqa: E402
import plugin_store as ps  # noqa: E402


def make_cache() -> Path:
    return Path(tempfile.mkdtemp(prefix="dsh-cache-"))


def write_plugin(root: Path, slug: str) -> Path:
    """在 root/<slug> 造一个合法的 @dsh-user 插件包（仓库根即插件根）。"""
    d = root / slug
    (d / "lib").mkdir(parents=True, exist_ok=True)
    (d / "lib" / "index.js").write_text("export const x = 1\n", encoding="utf-8")
    (d / "package.json").write_text(json.dumps({
        "name": f"@dsh-user/{slug}", "version": "0.0.1", "main": "./lib/index.js",
    }), encoding="utf-8")
    return d


def write_plugin_like(root: Path, rel: str, name: str) -> Path:
    """在 root/<rel> 写一个只有包名有意义的 package.json（用于身份判定用例）。"""
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(json.dumps({"name": name}), encoding="utf-8")
    return d


class DumpGateProbe:
    """结构门探针：放行并记下收到的补丁文本（不跑真的 dsh）。"""

    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, patch_path: Path) -> ps.DumpResult:
        self.seen.append(patch_path.read_text(encoding="utf-8"))
        return ps.DumpResult(ok=True, exit_code=0)


class FakeGit:
    """记录调用的假 git：clone 时在目标目录生成插件包（或按需失败/不生成）。"""

    def __init__(self, *, code: int = 0, create: bool = True):
        self.code = code
        self.create = create
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]):
        self.calls.append(list(args))
        if self.code == 0 and "clone" in args:
            target = Path(args[-1])
            if self.create:
                write_plugin(target.parent, target.name)
            else:
                target.mkdir(parents=True, exist_ok=True)
        return self.code, "", ("boom" if self.code else "")

    def subcommands(self) -> list[str]:
        return [a for a in (c[0] if c[0] != "-C" else c[2] for c in self.calls)]


class CatalogTest(unittest.TestCase):
    def test_catalog_shape_is_sane(self):
        """内置清单：slug 合法、仓库 URL 为 https、slug 不重复。"""
        slugs = [item["slug"] for item in ps.PLUGIN_REPOS]
        self.assertEqual(len(slugs), len(set(slugs)), "slug 重复")
        for item in ps.PLUGIN_REPOS:
            self.assertTrue(ps.is_valid_slug(item["slug"]), item["slug"])
            self.assertTrue(item["repo"].startswith("https://"), item["repo"])

    def test_catalog_entries_report_clone_state(self):
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        entries = ps.catalog_entries(home)
        self.assertEqual(len(entries), len(ps.PLUGIN_REPOS))
        self.assertTrue(all(not e["cloned"] for e in entries))
        self.assertEqual(entries[0]["local"],
                         ps.plugin_cache_dir(home) / entries[0]["slug"])
        # 已克隆 → cloned=True
        write_plugin(ps.plugin_cache_dir(home), entries[0]["slug"])
        again = {e["slug"]: e for e in ps.catalog_entries(home)}
        self.assertTrue(again[entries[0]["slug"]]["cloned"])
        # 查找
        self.assertIsNotNone(ps.catalog_entry(home, entries[0]["slug"]))
        self.assertIsNone(ps.catalog_entry(home, "no-such-plugin"))

    def test_fetch_clones_into_slug_named_dir(self):
        cache = make_cache()
        git = FakeGit()
        target = ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=git)
        # 目录名必须等于 slug（安装校验要求 name == @dsh-user/<目录名>）
        self.assertEqual(target, cache / ps.PLUGIN_REPOS[0]["slug"])
        self.assertTrue((target / "package.json").is_file())
        self.assertEqual(git.calls[0][:3], ["clone", "--depth", "1"])

    def test_fetch_honors_ref(self):
        cache = make_cache()
        git = FakeGit()
        ps.fetch_plugin(dict(ps.PLUGIN_REPOS[1], ref="v1.2.0"), cache, run_git=git)
        self.assertIn("--branch", git.calls[0])
        self.assertIn("v1.2.0", git.calls[0])

    def test_fetch_reuses_existing_clone_without_git(self):
        cache = make_cache()
        slug = ps.PLUGIN_REPOS[0]["slug"]
        write_plugin(cache, slug)
        git = FakeGit()
        target = ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=git)
        self.assertEqual(target, cache / slug)
        self.assertEqual(git.calls, [], "已克隆时不应再调用 git")

    def test_fetch_rejects_repo_without_root_package_json(self):
        """仓库根不是插件包根 → 明确报错（否则装不上）。"""
        cache = make_cache()
        with self.assertRaises(ps.PluginError) as ctx:
            ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache,
                            run_git=FakeGit(create=False))
        self.assertIn("package.json", str(ctx.exception))

    def test_fetch_reports_git_failure(self):
        cache = make_cache()
        with self.assertRaises(ps.PluginError) as ctx:
            ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=FakeGit(code=128))
        self.assertIn("克隆", str(ctx.exception))

    def test_fetch_rejects_invalid_slug(self):
        cache = make_cache()
        with self.assertRaises(ps.PluginError):
            ps.fetch_plugin({"slug": "Bad Slug", "repo": "https://x/y.git"},
                            cache, run_git=FakeGit())

    def test_update_falls_back_to_fetch_when_not_cloned(self):
        cache = make_cache()
        git = FakeGit()
        target = ps.update_plugin(ps.PLUGIN_REPOS[0], cache, run_git=git)
        self.assertTrue((target / "package.json").is_file())
        self.assertIn("clone", git.calls[0])

    def test_update_refreshes_existing_clone(self):
        cache = make_cache()
        slug = ps.PLUGIN_REPOS[0]["slug"]
        write_plugin(cache, slug)
        (cache / slug / ".git").mkdir()
        git = FakeGit()
        ps.update_plugin(ps.PLUGIN_REPOS[0], cache, run_git=git)
        subs = [c[2] for c in git.calls if c[:1] == ["-C"]]
        self.assertIn("fetch", subs)
        self.assertIn("reset", subs)

    def test_discover_sources_includes_cloned_catalog(self):
        """克隆后的插件成为「来源」，目录名即 slug，origin=catalog。"""
        cache = make_cache()
        ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=FakeGit())
        found = ps.discover_sources(None, None, cache)
        slugs = [s.slug for s in found]
        self.assertIn(ps.PLUGIN_REPOS[0]["slug"], slugs)
        self.assertEqual(next(s for s in found
                              if s.slug == ps.PLUGIN_REPOS[0]["slug"]).origin, "catalog")

    def test_discover_sources_without_cache_ignores_project(self):
        """不传 project_root 时不再扫描所在仓库的 plugins/（独立化）。"""
        project = Path(tempfile.mkdtemp(prefix="dsh-proj-"))
        write_plugin(project / "plugins", "sneaky")
        self.assertEqual(ps.discover_sources(None, None, None), [])
        # 反过来：显式传入时必须能发现（证明上一条不是因为函数永远是空的）
        found = [s.slug for s in ps.discover_sources(project, None, None)]
        self.assertEqual(found, ["sneaky"])

    def test_fetch_moves_broken_residue_aside(self):
        """上次中断的 clone 残留（无 package.json）不能让它永远下载不了。"""
        cache = make_cache()
        slug = ps.PLUGIN_REPOS[0]["slug"]
        (cache / slug).mkdir(parents=True)
        (cache / slug / "README.md").write_text("half clone", encoding="utf-8")

        target = ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=FakeGit())

        self.assertTrue((target / "package.json").is_file())
        residue = [p for p in cache.iterdir() if p.name.startswith(f".broken-{slug}")]
        self.assertEqual(len(residue), 1, "残留目录应被移到 .broken-* 而不是被覆盖")
        self.assertTrue((residue[0] / "README.md").is_file())

    def test_cloned_catalog_plugin_installs_end_to_end(self):
        """端到端：清单克隆 → 被当作来源发现 → 装进共享锚（独立仓库即可用）。"""
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        (home / "profiles" / "web").mkdir(parents=True)
        slug = ps.PLUGIN_REPOS[0]["slug"]
        cache = ps.plugin_cache_dir(home)
        ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=FakeGit())

        src = {s.slug: s for s in ps.discover_sources(None, None, cache)}[slug]
        ps.install(home, src, run_dump=DumpGateProbe())

        anchor = ps.anchor_dir(home, slug)
        self.assertTrue((anchor / "package.json").is_file())
        self.assertTrue((anchor / "lib" / "index.js").is_file())
        self.assertIsNotNone(ps.ledger_load(home).row(slug))
        self.assertIn(f"id: {slug}", ps.web_patch(home).read_text(encoding="utf-8"))


class InstallDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-cfg-"))
        self._old_dir, self._old_path = installer.CONFIG_DIR, installer.CONFIG_PATH
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        installer.set_active_dir(None)      # 清掉上一个用例留下的界面选择
        installer._DETECT_CACHE.clear()     # 清掉自动检测缓存

    def tearDown(self):
        installer.set_active_dir(None)
        installer._DETECT_CACHE.clear()
        installer.CONFIG_DIR, installer.CONFIG_PATH = self._old_dir, self._old_path
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_is_plan_a(self):
        """默认安装位 = <用户目录>\\deepseek-harness（方案 A），按字面量断言。"""
        self.assertEqual(installer.DEFAULT_PROJECT_DIR,
                         Path.home() / "deepseek-harness")
        # 系统盘空间充足时应原样返回方案 A
        if installer.free_gb(installer.INSTALL_BASE) >= installer.MIN_FREE_GB:
            self.assertEqual(installer.default_project_dir(),
                             Path.home() / "deepseek-harness")

    def _make_checkout(self, root: Path, name: str = "@deepseek-ai/dsh-root") -> Path:
        """造一个「假检出」：有结构标记，且带官方根包名（否则不算 DSH）。"""
        root.mkdir(parents=True, exist_ok=True)
        (root / "package.json").write_text(json.dumps({"name": name}),
                                           encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        return root

    def test_identity_rejects_a_plain_pnpm_repo(self):
        """结构像（有 package.json + pnpm-workspace.yaml）但不是 DSH → 不认。"""
        other = self.tmp / "some-monorepo"
        other.mkdir()
        (other / "package.json").write_text('{"name": "my-app"}', encoding="utf-8")
        (other / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        self.assertEqual(installer.checkout_identity(other), "")
        self.assertFalse(installer.is_checkout(other))

    def test_identity_requires_both_markers(self):
        """只有 package.json、没有 pnpm-workspace.yaml → 不认。"""
        root = self.tmp / "half"
        root.mkdir()
        (root / "package.json").write_text('{"name": "@deepseek-ai/dsh-root"}',
                                           encoding="utf-8")
        self.assertEqual(installer.checkout_identity(root), "")

    def test_identity_accepts_official_root_name(self):
        root = self._make_checkout(self.tmp / "anywhere")
        self.assertIn("@deepseek-ai/dsh-root", installer.checkout_identity(root))
        self.assertTrue(installer.is_checkout(root))

    def test_identity_accepts_dsh_package_prefix(self):
        """根包名换了但仍是 @deepseek-ai/dsh* → 认。"""
        root = self._make_checkout(self.tmp / "renamed", name="@deepseek-ai/dsh-app")
        self.assertTrue(installer.is_checkout(root))

    def test_identity_accepts_official_subpackage_without_root_name(self):
        """根包名认不出时，靠 packages/core 下的官方子包名也能认。"""
        root = self.tmp / "layout-only"
        self._make_checkout(root, name="whatever")
        write_plugin_like(root, "packages/core/session", "@deepseek-ai/dsh-session")
        self.assertIn("@deepseek-ai/dsh-session", installer.checkout_identity(root))
        self.assertTrue(installer.is_checkout(root))

    def test_identity_rejects_common_monorepo_layout(self):
        """packages/core + packages/api 是很常见的命名——普通单仓不能被误认。

        （评审实测过这条假阳性：会把用户自己的项目当成 DSH 去跑 pnpm install/build。）
        """
        root = self.tmp / "my-monorepo"
        self._make_checkout(root, name="my-app")
        for group in ("core", "api"):
            (root / "packages" / group).mkdir(parents=True)
        write_plugin_like(root, "packages/core/utils", "@my-app/utils")
        self.assertEqual(installer.checkout_identity(root), "")
        self.assertFalse(installer.is_checkout(root))

    def test_identity_rejects_lookalike_scope(self):
        """@deepseek-ai/dshmarket 这类「前缀相同但没有分隔符」的包名不能被认。"""
        root = self._make_checkout(self.tmp / "lookalike",
                                   name="@deepseek-ai/dshmarket")
        self.assertEqual(installer.checkout_identity(root), "")
        self.assertFalse(installer.is_checkout(root))

    def test_identity_survives_broken_package_json(self):
        """根 package.json 坏了不能崩，仍能按子包名认出来。"""
        root = self.tmp / "broken"
        (root / "packages" / "core").mkdir(parents=True)
        (root / "package.json").write_text("{ not json", encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        write_plugin_like(root, "packages/core/agent", "@deepseek-ai/dsh-agent")
        self.assertTrue(installer.is_checkout(root))

    # ---- 安装标记（离线装的目录没有 .git，靠它当身份证）----

    def test_marker_identifies_renamed_fork_without_dsh_names(self):
        """包名全被改过的目录也能靠本助手的标记认出来。"""
        root = self._make_checkout(self.tmp / "renamed", name="my-dsh-fork")
        installer.write_install_marker(root, "offline")
        self.assertEqual(installer.checkout_identity(root),
                         "本助手安装标记（offline）")
        self.assertTrue(installer.is_checkout(root))

    def test_marker_rejects_a_foreign_file(self):
        """别人写的同名文件不算数。"""
        root = self._make_checkout(self.tmp / "foreign", name="my-app")
        (root / installer.INSTALL_MARKER).write_text(
            json.dumps({"tool": "别的工具", "mode": "offline"}), encoding="utf-8")
        self.assertEqual(installer.checkout_identity(root), "")

    def test_marker_survives_broken_json(self):
        root = self._make_checkout(self.tmp / "badmarker", name="my-app")
        (root / installer.INSTALL_MARKER).write_text("{ 坏文件", encoding="utf-8")
        self.assertEqual(installer.checkout_identity(root), "")

    # ---- git 远端（直接读 .git/config，不启动 git 进程）----

    @staticmethod
    def _write_git_config(root: Path, url: str) -> None:
        (root / ".git").mkdir(parents=True, exist_ok=True)
        (root / ".git" / "config").write_text(
            '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n'
            f"\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
            encoding="utf-8")

    def test_identity_from_git_remote_official(self):
        root = self._make_checkout(self.tmp / "gitd", name="renamed-root")
        self._write_git_config(
            root, "https://github.com/deepseek-ai/deepseek-harness.git")
        self.assertIn("git 远端", installer.checkout_identity(root))
        self.assertTrue(installer.is_checkout(root))

    def test_identity_from_git_remote_fork(self):
        """fork 的远端链接里同样带着仓库名，所以也认。"""
        root = self._make_checkout(self.tmp / "gitfork", name="renamed-root")
        self._write_git_config(root, "git@github.com:Muigoochen/deepseek-harness.git")
        self.assertIn("git 远端", installer.checkout_identity(root))

    def test_identity_rejects_unrelated_git_remote(self):
        root = self._make_checkout(self.tmp / "gitother", name="my-app")
        self._write_git_config(root, "git@github.com:someone/my-app.git")
        self.assertEqual(installer.checkout_identity(root), "")

    def test_identity_follows_gitdir_pointer(self):
        """`.git` 是文件（worktree/submodule）时顺着指针读。"""
        root = self._make_checkout(self.tmp / "worktree", name="renamed-root")
        real = self.tmp / "real-gitdir"
        real.mkdir(parents=True)
        (real / "config").write_text(
            '[remote "origin"]\n\turl = git@github.com:deepseek-ai/deepseek-harness.git\n',
            encoding="utf-8")
        (root / ".git").write_text(f"gitdir: {real}\n", encoding="utf-8")
        self.assertIn("git 远端", installer.checkout_identity(root))

    def test_plan_a_default_when_nothing_saved_or_installed(self):
        with mock.patch.object(installer, "detect_installed_dir", return_value=None):
            self.assertEqual(installer.project_dir(), installer.default_project_dir())

    def test_saved_config_is_honored_when_it_holds_a_real_install(self):
        custom = self._make_checkout(self.tmp / "my" / "deepseek_harness")
        installer.set_project_dir(custom)
        installer._DETECT_CACHE.clear()
        with mock.patch.object(installer, "detect_installed_dir", return_value=None):
            self.assertEqual(installer.project_dir(), custom)
        saved = json.loads(installer.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(saved["installDir"], str(custom))

    def test_saved_empty_dir_does_not_hide_a_real_install(self):
        """配置指向空目录时，不能让机器上已装好的那份被「尚未安装」掩盖。"""
        installer.set_project_dir(self.tmp / "empty" / "deepseek-harness")
        installed = self._make_checkout(self.tmp / "deepseek_harness")
        with mock.patch.object(installer, "detect_installed_dir",
                               return_value=installed):
            self.assertEqual(installer.project_dir(), installed)

    def test_saved_empty_dir_is_used_when_nothing_is_installed(self):
        """哪儿都没装 → 用户存的位置就是「将要安装到哪」。"""
        target = self.tmp / "fresh" / "deepseek-harness"
        installer.set_project_dir(target)
        with mock.patch.object(installer, "detect_installed_dir", return_value=None):
            self.assertEqual(installer.project_dir(), target)

    def test_detects_install_that_contains_the_tool(self):
        """小助手就在安装目录里 → 直接认出那份安装（正是实测遇到的情况）。"""
        root = self._make_checkout(self.tmp / "deepseek_harness")
        tool = root / "tools" / "dsh-goochen-assistant"
        tool.mkdir(parents=True)
        with mock.patch.object(installer, "HERE", tool):
            self.assertEqual(installer.detect_installed_dir(refresh=True),
                             root.resolve())
            self.assertEqual(installer.project_dir(), root.resolve())

    def test_detected_install_beats_plan_a_default(self):
        """已装好的位置优先于方案 A 默认——否则会指着不存在的 C 盘目录说「尚未安装」。"""
        other = self.tmp / "elsewhere"
        with mock.patch.object(installer, "detect_installed_dir", return_value=other):
            self.assertEqual(installer.project_dir(), other)

    def test_active_dir_wins_over_config_and_detection(self):
        """界面里选的目录立即生效（不必先点安装），压过配置与自动检测。"""
        installer.set_project_dir(self._make_checkout(self.tmp / "saved"))
        picked = self.tmp / "picked"
        installer.set_active_dir(picked)
        self.assertEqual(installer.project_dir(), picked)
        installer.set_active_dir(None)
        self.assertEqual(installer.project_dir(), self.tmp / "saved")

    def test_normalize_picked_never_renames_an_installed_dir(self):
        """选到已装好的目录（含下划线命名）→ 原样采用；选到父目录才下钻。"""
        root = self._make_checkout(self.tmp / "deepseek_harness")
        self.assertEqual(installer.App._normalize_picked(root), root)
        self.assertEqual(installer.App._normalize_picked(self.tmp), root)
        plain = self.tmp / "plain"
        plain.mkdir()
        self.assertEqual(installer.App._normalize_picked(plain), plain)

    def test_drive_root_pick_appends_default_name(self):
        """选到盘根才补默认名（只在 Windows 盘符语义下成立）。"""
        if os.name != "nt":
            self.skipTest("盘根语义仅 Windows")
        root = Path("E:\\")
        self.assertEqual(installer.App._normalize_picked(root),
                         root / installer.SOURCE_DIR_NAME)

    def test_check_install_dir_errors(self):
        errs, _ = installer.check_install_dir(Path("deepseek-harness"))
        self.assertTrue(errs, "相对路径应报错")
        errs, _ = installer.check_install_dir(Path("C:/Program Files/deepseek-harness"))
        self.assertTrue(any("Program Files" in e for e in errs))
        errs, _ = installer.check_install_dir(Path("C:/Windows/deepseek-harness"))
        self.assertTrue(any("Windows" in e for e in errs))

    def test_check_install_dir_warns_but_allows(self):
        for raw, needle in (("C:/my dir/deepseek-harness", "空格"),
                            ("C:/用户目录/deepseek-harness", "非 ASCII"),
                            ("C:/Users/x/OneDrive/deepseek-harness", "OneDrive")):
            errs, warns = installer.check_install_dir(Path(raw))
            self.assertEqual(errs, [], raw)
            self.assertTrue(any(needle in w for w in warns), f"{raw} → {warns}")

    def test_check_install_dir_accepts_temp_dir(self):
        errs, warns = installer.check_install_dir(self.tmp / "deepseek-harness")
        self.assertEqual(errs, [])
        self.assertEqual(warns, [])


class PrepareSourceTest(unittest.TestCase):
    """安装前的最后一道闸：绝不在「无关项目」里跑 pnpm install/build。

    评审复现过：只凭「有 package.json」就复用目录，会在用户自己的项目里执行
    pnpm 安装与构建。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-prep-"))
        self._old = (installer.CONFIG_DIR, installer.CONFIG_PATH)
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        installer.set_active_dir(None)
        installer._DETECT_CACHE.clear()
        self.logs: list[str] = []

    def tearDown(self):
        installer.set_active_dir(None)
        installer._DETECT_CACHE.clear()
        installer.CONFIG_DIR, installer.CONFIG_PATH = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _engine(self, mode: str = "auto") -> installer.Engine:
        return installer.Engine(mode=mode, use_mirror=False, log=self.logs.append)

    def test_refuses_foreign_project_with_package_json(self):
        foreign = self.tmp / "my-app"
        foreign.mkdir()
        (foreign / "package.json").write_text('{"name": "my-app"}', encoding="utf-8")
        installer.set_active_dir(foreign)
        with self.assertRaises(installer.InstallError) as ctx:
            self._engine().prepare_source()
        self.assertIn("不是一个 DSH 检出", str(ctx.exception))
        # 不得留下任何痕迹（没跑过 pnpm/tar/clone）
        self.assertEqual(sorted(p.name for p in foreign.iterdir()), ["package.json"])

    def test_reuses_existing_checkout(self):
        root = self._make_checkout(self.tmp / "deepseek_harness")
        installer.set_active_dir(root)
        self.assertEqual(self._engine().prepare_source(), root)
        self.assertTrue(any("已检测到现有 DSH" in m for m in self.logs), self.logs)

    def test_offline_install_writes_marker(self):
        """离线解压出来的目录没有 .git → 装完必须写下安装标记（绑定官方链接）。"""
        archive = self.tmp / "source.tar.gz"
        self._make_tiny_archive(archive)
        project = self.tmp / "deepseek-harness"
        installer.set_active_dir(project)
        with mock.patch.object(installer, "SOURCE_ARCHIVE", archive):
            self.assertEqual(self._engine("offline").prepare_source(), project)

        self.assertFalse((project / ".git").exists(), "离线包本身不含 .git")
        marker = installer.read_install_marker(project)
        self.assertEqual(marker["mode"], "offline")
        self.assertEqual(marker["source"], installer.HARNESS_GIT_URL)
        self.assertEqual(installer.checkout_identity(project),
                         "本助手安装标记（offline）")

    @staticmethod
    def _make_tiny_archive(path: Path) -> None:
        """造一个只含最小 DSH 结构的源码包（模拟 assets/source.tar.gz）。"""
        import io
        import tarfile
        files = {
            "package.json": json.dumps({"name": "@deepseek-ai/dsh-root"}),
            "pnpm-workspace.yaml": "packages: []\n",
        }
        with tarfile.open(path, "w:gz") as tf:
            for name, text in files.items():
                data = text.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))

    def _make_checkout(self, root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        (root / "package.json").write_text('{"name": "@deepseek-ai/dsh-root"}',
                                           encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        return root


class PluginSourcesTest(unittest.TestCase):
    """刷新与保存必须看到同一份来源，否则列表里的插件保存时会说「不在来源目录中」。"""

    @staticmethod
    def _slugs(home: Path, project: Path) -> list[str]:
        return [s.slug for s in installer.App._plugin_sources(object(), home, project)]

    def test_dev_mode_includes_project_plugins(self):
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        project = Path(tempfile.mkdtemp(prefix="dsh-proj-"))
        write_plugin(project / "plugins", "devplug")

        with mock.patch.dict(os.environ, {"DSH_ASSISTANT_DEV": "1"}):
            self.assertIn("devplug", self._slugs(home, project))
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("devplug", self._slugs(home, project))

    def test_cloned_cache_is_always_a_source(self):
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        project = Path(tempfile.mkdtemp(prefix="dsh-proj-"))
        cache = ps.plugin_cache_dir(home)
        ps.fetch_plugin(ps.PLUGIN_REPOS[0], cache, run_git=FakeGit())
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIn(ps.PLUGIN_REPOS[0]["slug"], self._slugs(home, project))


class MergeTest(unittest.TestCase):
    """GUI 行合并：清单里未下载的插件要出现在列表里（kind=catalog，动作=下载）。"""

    class _Stub:
        _plugin_rank = staticmethod(installer.App._plugin_rank)
        STATE_CN = installer.App.STATE_CN
        STATE_COLOR = installer.App.STATE_COLOR

    def test_uncloned_catalog_rows_appear_as_nodl(self):
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        catalog = ps.catalog_entries(home)
        items = installer.App._merge_plugins(self._Stub(), [], [], catalog)
        self.assertEqual(len(items), len(ps.PLUGIN_REPOS))
        self.assertTrue(all(i["kind"] == "catalog" for i in items))
        self.assertTrue(all(i["state"] == "nodl" for i in items))
        # 行上给出的是「下载」，且携带该插件自己的仓库地址
        repos = {c["slug"]: c["repo"] for c in catalog}
        for it in items:
            self.assertEqual(installer.App._actions_for(self._Stub(), it),
                             [("下载", "fetch", it["name"])])
            self.assertEqual(it["spec"], repos[it["name"]])
            self.assertEqual(installer.App._state_display(self._Stub(), it)[0], "未下载")

    def test_cloned_catalog_entry_is_not_duplicated(self):
        """已克隆（已被 managed 卡片表示）时不再重复出现 catalog 行。"""
        home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
        catalog = ps.catalog_entries(home)
        slug = catalog[0]["slug"]
        card = SimpleNamespace(slug=slug, state="downloaded",
                               description="d", validation_errors=())
        items = installer.App._merge_plugins(self._Stub(), [card], [], catalog)
        names = [i["name"] for i in items]
        self.assertEqual(len(items), len(ps.PLUGIN_REPOS))
        self.assertEqual(names.count(slug), 1)
        self.assertEqual(next(i for i in items if i["name"] == slug)["kind"], "managed")


if __name__ == "__main__":
    unittest.main()
