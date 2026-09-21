# -*- coding: utf-8 -*-
"""插件独立仓库清单 + 安装位置（可配置）单元测试。

标准库 unittest，不联网、不碰真实用户目录：
  - fetch_plugin / update_plugin 一律注入假的 run_git；
  - 安装位置配置写入临时 CONFIG_PATH（不写真实 %USERPROFILE%\\.dsh-assistant）。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _tempguard  # noqa: F401,E402  临时目录统一收口，进程结束整体清理

import installer  # noqa: E402
import plugin_store as ps  # noqa: E402
from git_helpers import GIT, add_remote, git, make_repo, write_pkg  # noqa: E402


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

    # ---- 远端不再靠读文本判：交给真 git（见下面的 VerifyInstallDirTest）----

    def test_identity_ignores_git_remote_text(self):
        """手写一份 `.git/config`（连 git 仓库都不是）不能当身份依据。"""
        root = self._make_checkout(self.tmp / "fakegit", name="renamed-root")
        (root / ".git").mkdir(parents=True, exist_ok=True)
        (root / ".git" / "config").write_text(
            '[remote "origin"]\n'
            "\turl = git@github.com:deepseek-ai/deepseek-harness.git\n",
            encoding="utf-8")
        self.assertEqual(installer.checkout_identity(root), "")
        self.assertFalse(installer.is_checkout(root))

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


@unittest.skipIf(GIT is None, "未安装 git，跳过真 git 身份测试")
class VerifyInstallDirTest(unittest.TestCase):
    """`verify_install_dir`：**内容 + git 两条都要过**，各种 fork 布局都要判对。

    用真 git 临时仓库（不联网）。要覆盖的用户情形：
      · 装的就是官方仓库（origin = 官方）
      · 自己 fork 了、origin 指向自己的 fork（**没有**官方远端）
      · 自己 fork 了、同时把 upstream 指向官方（本机就是这种）
      · 碰巧同名的别的仓库 / 自己的项目里只是加了官方远端 → **必须拒绝**
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-ident-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _dsh_repo(self, name: str, *, root_name: str = "@deepseek-ai/dsh-root",
                  with_subpackage: bool = False,
                  remotes: tuple[tuple[str, str], ...] = ()) -> Path:
        """造一个「内容像 DSH」的真 git 仓库。"""
        repo = make_repo(self.tmp / name, root_name=root_name)
        if with_subpackage:
            write_pkg(repo, "packages/core/session", "@deepseek-ai/dsh-session")
            git("add", "-A", cwd=repo)
            git("commit", "-q", "-m", "add subpackage", cwd=repo)
        for remote_name, url in remotes:
            add_remote(repo, remote_name, url)
        return repo

    def test_official_remote_is_official(self):
        repo = self._dsh_repo("official", remotes=(
            ("origin", "https://github.com/deepseek-ai/deepseek-harness.git"),))
        ident = installer.verify_install_dir(repo)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "official")

    def test_fork_only_is_accepted_but_flagged_unofficial(self):
        """只指向自己的 fork：认它是 DSH，但必须明说不是官方。"""
        repo = self._dsh_repo("forkonly", remotes=(
            ("origin", "git@github.com:Muigoochen/deepseek-harness.git"),))
        ident = installer.verify_install_dir(repo)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "unofficial")
        self.assertIn("非官方", ident.evidence)
        self.assertIn("deepseek-ai/deepseek-harness", ident.evidence)

    def test_fork_with_official_upstream_is_official(self):
        """本机真实布局：origin 是自己的 fork，upstream 是官方 → 官方。"""
        repo = self._dsh_repo("forkup", remotes=(
            ("origin", "git@github.com:Muigoochen/deepseek-harness.git"),
            ("upstream", "git@github.com:deepseek-ai/deepseek-harness.git")))
        ident = installer.verify_install_dir(repo)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "official")
        self.assertIn("deepseek-ai/deepseek-harness", ident.evidence)

    def test_renamed_root_but_official_subpackage_is_accepted(self):
        """根包名被改过，靠 packages/core 的官方子包名 + 官方远端认出来。"""
        repo = self._dsh_repo("renamed", root_name="my-dsh-fork",
                              with_subpackage=True, remotes=(
                                  ("origin",
                                   "git@github.com:alice/deepseek-harness.git"),))
        ident = installer.verify_install_dir(repo)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "unofficial")

    def test_same_name_repo_without_dsh_content_is_only_suspect(self):
        """碰巧也叫 deepseek-harness 的仓库：不确认，但也不硬拒——留一句「可以试跑」。"""
        repo = self.tmp / "lookalike"
        repo.mkdir()
        (repo / "README.md").write_text("不是 DSH\n", encoding="utf-8")
        git("init", "-q", cwd=repo)
        git("add", "-A", cwd=repo)
        git("commit", "-q", "-m", "init", cwd=repo)
        add_remote(repo, "origin", "git@github.com:bob/deepseek-harness.git")
        ident = installer.verify_install_dir(repo)
        self.assertFalse(ident.ok)
        self.assertEqual(ident.tier, "suspect")
        self.assertIn("内容不像 DSH", ident.evidence)
        self.assertIn("试跑", ident.evidence)

    def test_own_project_with_official_remote_is_not_confirmed(self):
        """**关键安全用例**：自己的单仓里只是加了官方远端 → 绝不能当 DSH 跑 pnpm。"""
        repo = make_repo(self.tmp / "myapp", root_name="my-app")
        add_remote(repo, "upstream",
                   "https://github.com/deepseek-ai/deepseek-harness.git")
        ident = installer.verify_install_dir(repo)
        self.assertFalse(ident.ok)
        self.assertEqual(ident.tier, "suspect")
        self.assertIn("内容不像 DSH", ident.evidence)
        self.assertFalse(installer.is_checkout(repo))

    def test_plain_pnpm_repo_without_remote_is_not_confirmed(self):
        repo = make_repo(self.tmp / "plain", root_name="my-app")
        ident = installer.verify_install_dir(repo)
        self.assertFalse(ident.ok)
        self.assertEqual(ident.tier, "suspect")

    # ---- 运行验证：两条证据都不成立时，用「能不能真的跑起来」定案 ----

    def test_verified_run_turns_suspect_into_confirmed(self):
        """认不出的目录跑成功一次 → 记进安装标记 → 从此按已安装处理。"""
        repo = make_repo(self.tmp / "renamed", root_name="totally-renamed")
        self.assertEqual(installer.verify_install_dir(repo).tier, "suspect")

        self.assertTrue(installer.mark_run_verified(repo))
        ident = installer.verify_install_dir(repo)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "file")
        self.assertIn("运行验证通过", ident.evidence)
        self.assertTrue(installer.is_checkout(repo))

    def test_verified_run_keeps_the_original_install_mode(self):
        """离线安装写的标记只补一个字段，不覆盖原有安装方式。"""
        root = self.tmp / "offline"
        root.mkdir()
        installer.write_install_marker(root, "offline")
        self.assertTrue(installer.mark_run_verified(root))
        marker = installer.read_install_marker(root)
        self.assertEqual(marker["mode"], "offline")
        self.assertTrue(marker[installer.RUN_VERIFIED_KEY])

    def test_verified_run_is_idempotent(self):
        root = self.tmp / "twice"
        root.mkdir()
        self.assertTrue(installer.mark_run_verified(root))
        first = installer.read_install_marker(root)["installedAt"]
        self.assertTrue(installer.mark_run_verified(root))
        marker = installer.read_install_marker(root)
        self.assertEqual(marker["installedAt"], first)      # 首装时间不被刷掉
        self.assertEqual(len(list(root.glob(".dsh-assistant.json"))), 1)

    def test_verified_run_on_unwritable_dir_reports_failure(self):
        """写不进去就如实返回失败（界面据此提示「下次仍需人工确认」）。"""
        root = self.tmp / "nope"
        self.assertFalse(installer.mark_run_verified(root))

    def test_offline_dir_without_git_uses_marker(self):
        """离线装出来的目录没有 `.git`：靠安装标记判为 tier=file。"""
        root = self.tmp / "offline"
        (root).mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps({"name": "rebranded-dsh"}), encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        installer.write_install_marker(root, "offline")
        ident = installer.verify_install_dir(root)
        self.assertTrue(ident.ok, ident.evidence)
        self.assertEqual(ident.tier, "file")
        self.assertIn("安装标记", ident.evidence)

    def test_missing_dir_is_rejected(self):
        ident = installer.verify_install_dir(self.tmp / "nope")
        self.assertFalse(ident.ok)


def _tree_state(root: Path) -> dict[str, str]:
    """目录的完整快照（相对路径 → 内容 hash），用来证明「零改动」。"""
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        out[rel] = ("<dir>" if p.is_dir()
                    else hashlib.sha256(p.read_bytes()).hexdigest())
    return out


class _FakeTar:
    """模拟「Windows 上建不了符号链接」的 tar：解压除符号链接外的成员，返回码 1。

    `-tzf`（列内容）仍走真 tar，其余调用按 `extract` 决定是否真的落地文件。
    """

    def __init__(self, *, extract: bool = True) -> None:
        self.extract = extract
        self.calls: list[list[str]] = []

    def __call__(self, argv, cwd=None, env=None):
        self.calls.append(list(argv))
        if not self.extract:
            return subprocess.CompletedProcess(argv, 1, b"",
                                               b"tar: boom: write error")
        dest = Path(argv[argv.index("-C") + 1])
        with tarfile.open(argv[2], "r:gz") as tf:
            keep = [m for m in tf.getmembers() if not m.issym()]
            try:
                tf.extractall(dest, members=keep, filter="data")
            except TypeError:               # Python < 3.12 没有 filter 参数
                tf.extractall(dest, members=keep)
        return subprocess.CompletedProcess(
            argv, 1, b"",
            b"tar: vendor/CLAUDE.md: Can't create 'x': Invalid argument\n")


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
        # 日志要带上「凭什么确认」的依据（不是只说一句复用）
        self.assertTrue(any("已确认现有 DSH" in m and "dsh-root" in m
                            for m in self.logs), self.logs)

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

    def test_offline_refuses_nonempty_dir_without_identity(self):
        """离线分支同样要拦：解压会覆盖同名文件（实测过 README.md 被改成官方 README）。"""
        archive = self.tmp / "source.tar.gz"
        self._make_tiny_archive(archive)
        target = self.tmp / "我的文件夹"
        target.mkdir()
        (target / "我的资料.txt").write_text("别动我\n", encoding="utf-8")
        (target / "README.md").write_text("用户自己的说明\n", encoding="utf-8")
        before = _tree_state(target)
        installer.set_active_dir(target)
        with mock.patch.object(installer, "SOURCE_ARCHIVE", archive):
            with self.assertRaises(installer.InstallError) as ctx:
                self._engine("offline").prepare_source()
        text = str(ctx.exception)
        self.assertIn("这个目录不是空的", text)
        self.assertIn("我的资料.txt", text, "提示里要写出目录现有内容")
        self.assertNotIn("试跑", text, "外部目录不该引导用户去【运行】试跑")
        self.assertEqual(_tree_state(target), before, "必须零改动")

    def test_offline_tolerates_symlink_failure_when_content_is_complete(self):
        """Windows 建不了符号链接时 tar 返回 1：内容完整就继续，镜像用复制补上。"""
        archive = self.tmp / "source.tar.gz"
        self._make_archive_with_link(archive)
        project = self.tmp / "out"
        installer.set_active_dir(project)
        with mock.patch.object(installer, "SOURCE_ARCHIVE", archive), \
                mock.patch.object(installer, "run", _FakeTar()):
            self.assertEqual(self._engine("offline").prepare_source(), project)
        self.assertTrue(any("符号链接" in m for m in self.logs), self.logs)
        link = project / "CLAUDE.md"
        self.assertTrue(link.exists(), "镜像链接要用复制补上")
        self.assertEqual(link.read_text(encoding="utf-8"),
                         (project / "AGENTS.md").read_text(encoding="utf-8"))

    def test_offline_aborts_when_extraction_is_incomplete(self):
        """内容不完整时不能放过：tar 的返回码仍以「顶层内容是否齐」为准。"""
        archive = self.tmp / "source.tar.gz"
        self._make_tiny_archive(archive)
        project = self.tmp / "out2"
        installer.set_active_dir(project)
        with mock.patch.object(installer, "SOURCE_ARCHIVE", archive), \
                mock.patch.object(installer, "run", _FakeTar(extract=False)):
            with self.assertRaises(installer.InstallError) as ctx:
                self._engine("offline").prepare_source()
        self.assertIn("源码解压失败", str(ctx.exception))
        self.assertIn("缺少顶层内容", str(ctx.exception))
        self.assertFalse((project / installer.INSTALL_MARKER).exists(),
                         "没装成功就不能留下安装标记")

    @staticmethod
    def _make_archive_with_link(path: Path) -> None:
        """源码包 + 一个仓库内镜像链接（模拟真包里的 CLAUDE.md → AGENTS.md）。"""
        import io
        import tarfile
        files = {
            "package.json": json.dumps({"name": "@deepseek-ai/dsh-root"}),
            "pnpm-workspace.yaml": "packages: []\n",
            "AGENTS.md": "# 说明\n",
        }
        with tarfile.open(path, "w:gz") as tf:
            for name, text in files.items():
                data = text.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo("CLAUDE.md")
            link.type = tarfile.SYMTYPE
            link.linkname = "AGENTS.md"
            tf.addfile(link)

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


class ArchiveTopNamesTest(unittest.TestCase):
    """列归档顶层名字：点开头的条目不能被剥掉点（`lstrip("./")` 会，实测踩过）。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-tops-"))
        self.archive = self.tmp / "a.tar.gz"
        import io
        with tarfile.open(self.archive, "w:gz") as tf:
            for name, text in ((".agents/notes/AGENTS.md", "x\n"),
                               (".gitignore", "node_modules\n"),
                               ("package.json", "{}\n")):
                data = text.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo("CLAUDE.md")     # 符号链接不算「应有内容」
            link.type = tarfile.SYMTYPE
            link.linkname = ".agents/notes/AGENTS.md"
            tf.addfile(link)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dot_entries_keep_their_dots_and_links_are_skipped(self):
        self.assertEqual(installer._archive_top_names(self.archive),
                         {".agents", ".gitignore", "package.json"})

    def test_unreadable_archive_reports_nothing(self):
        broken = self.tmp / "broken.tar.gz"
        broken.write_bytes(b"not a tar")
        self.assertEqual(installer._archive_top_names(broken), set())


class FillMissingLinksTest(unittest.TestCase):
    """符号链接补齐：文件镜像复制内容、目录镜像复制整棵树、越界链接不做。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-links-"))
        self.archive = self.tmp / "source.tar.gz"
        self._make_archive(self.archive)
        (self.tmp / "outside.txt").write_text("外面的文件\n", encoding="utf-8")
        self.project = self.tmp / "out"
        (self.project / "skills").mkdir(parents=True)
        (self.project / "a.md").write_text("内容 A\n", encoding="utf-8")
        (self.project / "skills" / "x.md").write_text("技能\n", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fills_file_and_dir_links_and_skips_outside(self):
        done = installer.fill_missing_links(self.project, self.archive)
        self.assertEqual(sorted(done), [".claude/skills", "CLAUDE.md"])
        self.assertEqual((self.project / "CLAUDE.md").read_text(encoding="utf-8"),
                         "内容 A\n")
        self.assertEqual(
            (self.project / ".claude" / "skills" / "x.md").read_text(encoding="utf-8"),
            "技能\n")
        self.assertFalse((self.project / "evil.txt").exists(),
                         "指向解压目录之外的链接不做")

    def test_second_call_is_a_no_op(self):
        installer.fill_missing_links(self.project, self.archive)
        self.assertEqual(installer.fill_missing_links(self.project, self.archive), [])

    @staticmethod
    def _make_archive(path: Path) -> None:
        import io
        import tarfile
        with tarfile.open(path, "w:gz") as tf:
            for name, text in (("a.md", "内容 A\n"), ("skills/x.md", "技能\n")):
                data = text.encode("utf-8")
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            for name, target in (("CLAUDE.md", "a.md"),
                                 (".claude/skills", "../skills"),
                                 ("evil.txt", "../../outside.txt")):
                link = tarfile.TarInfo(name)
                link.type = tarfile.SYMTYPE
                link.linkname = target
                tf.addfile(link)


class InterruptedInstallTest(unittest.TestCase):
    """关窗打断安装要留下痕迹，下次必须重做依赖与构建。

    否则会掉进这个坑：`install_deps` 看到 `node_modules` 存在就跳过，`build` 看到
    构建标记就跳过——被打断的半成品会被当成装好了，用户点【一键完整安装】什么也没发生。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-intr-"))
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

    def _checkout(self, name: str = "deepseek-harness") -> Path:
        root = self.tmp / name
        root.mkdir(parents=True, exist_ok=True)
        (root / "package.json").write_text('{"name": "@deepseek-ai/dsh-root"}',
                                           encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        return root

    def test_flag_matches_the_same_directory_written_differently(self):
        project = self._checkout()
        self.assertFalse(installer.install_was_interrupted(project), "默认不该有标记")
        installer.set_interrupted_target(str(project).upper().replace("\\", "/"))
        self.assertTrue(installer.install_was_interrupted(project),
                        "大小写与斜杠写法不同也要认得出是同一个目录")
        self.assertFalse(installer.install_was_interrupted(self.tmp / "other"))
        installer.clear_interrupted(project)
        self.assertFalse(installer.install_was_interrupted(project))

    def test_clear_leaves_another_directory_alone(self):
        project = self._checkout()
        installer.set_interrupted_target(str(self.tmp / "another"))
        installer.clear_interrupted(project)      # 不匹配就不该清掉
        self.assertEqual(installer.interrupted_targets(), [str(self.tmp / "another")])

    def test_two_interrupted_directories_are_both_remembered(self):
        """单槽会互相抹掉：先打断 A、再打断 B，A 的坑不能丢（否则 A 下次白跳过依赖与构建）。"""
        first = self._checkout("deepseek-harness")
        second = self._checkout("my-dsh")
        installer.set_interrupted_target(str(first))
        installer.set_interrupted_target(str(second))
        installer.set_interrupted_target(str(first))      # 同一目录重复记不该出现两条
        self.assertTrue(installer.install_was_interrupted(first))
        self.assertTrue(installer.install_was_interrupted(second))
        self.assertEqual(len(installer.interrupted_targets()), 2)
        installer.clear_interrupted(second)               # 只清掉跑完的那个
        self.assertTrue(installer.install_was_interrupted(first))
        self.assertFalse(installer.install_was_interrupted(second))

    def test_force_redoes_deps_and_build_after_an_interrupt(self):
        project = self._checkout()
        (project / "node_modules").mkdir()
        mark = project / installer.BUILD_MARK
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.write_text("{}", encoding="utf-8")
        installer.set_active_dir(project)
        calls: list[list[str]] = []

        def fake_run_cli(argv, cwd=None, env=None):
            calls.append(list(argv))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        def full_install(force: bool) -> None:
            with mock.patch.object(installer, "run_cli", fake_run_cli), \
                    mock.patch.object(installer.Engine, "check_env", lambda self: {}), \
                    mock.patch.object(installer.Engine, "install_node",
                                      lambda self, env: None), \
                    mock.patch.object(installer.Engine, "install_pnpm", lambda self: None):
                installer.Engine(mode="auto", use_mirror=False, log=self.logs.append,
                                 force=force).run_full(headless=False, start=False)

        full_install(force=False)
        self.assertEqual(calls, [], "都装好了、也没被打断过，就该跳过")

        installer.set_interrupted_target(str(project))
        full_install(force=installer.install_was_interrupted(project))
        self.assertEqual(len(calls), 2, f"被打断过就必须重做依赖与构建：{calls}")
        self.assertTrue(any("install" in c for c in calls[0]), calls)

    def test_successful_full_install_clears_the_flag(self):
        project = self._checkout()
        installer.set_active_dir(project)
        installer.set_interrupted_target(str(project))

        def fake_run_cli(argv, cwd=None, env=None):
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with mock.patch.object(installer, "run_cli", fake_run_cli), \
                mock.patch.object(installer.Engine, "check_env", lambda self: {}), \
                mock.patch.object(installer.Engine, "install_node", lambda self, env: None), \
                mock.patch.object(installer.Engine, "install_pnpm", lambda self: None):
            eng = installer.Engine(mode="auto", use_mirror=False, log=self.logs.append,
                                   force=True)
            eng.run_full(headless=False, start=False)
        self.assertFalse(installer.install_was_interrupted(project),
                         "装完了就该取消标记，别让以后每次安装都白重做一遍")


class CloseMarksOpTargetTest(unittest.TestCase):
    """关窗这条接线：记的是**正在安装的那个目录**，不是关窗那一刻路径框里的值。

    否则装 A 时随手把路径改成 B 再关窗，标记会写到 B 上：A 的半成品被当成装好了
    （下次 force 落空），B 反而被无谓地整体重装一遍。同理，只是读一下 git 信息
    （打开界面、改路径后的自动刷新）不该弹窗、更不该写标记。

    不建真窗口：`_on_close` 只碰 `self` 上的几个属性和模块级函数，用桩对象就能验接线。
    """

    @staticmethod
    def _stub(**kw):
        app = SimpleNamespace(
            busy=False, git_busy=False, plugin_busy=False, mig_busy=False,
            _op_target=None, _closing=False,
            _stop_web_internal=lambda quiet=True: None,
            _drain_ui_queue=lambda: None,
            destroy=lambda: None)
        app.__dict__.update(kw)
        app._long_task_running = installer.App._long_task_running.__get__(app)
        app._on_close = installer.App._on_close.__get__(app)
        return app

    @staticmethod
    def _close(app, confirm: bool):
        marked: list[str] = []
        asked: list[int] = []
        with mock.patch.object(installer.messagebox, "askyesno",
                               lambda *a, **k: (asked.append(1), confirm)[1]), \
                mock.patch.object(installer, "set_interrupted_target", marked.append), \
                mock.patch.object(installer.childproc, "kill_all", lambda **k: 0):
            app._on_close()
        return marked, asked

    def test_marks_the_directory_being_installed(self):
        marked, asked = self._close(self._stub(_op_target=r"C:\installing\A"), True)
        self.assertEqual(asked, [1])
        self.assertEqual(marked, [r"C:\installing\A"])

    def test_cancel_keeps_the_window_and_writes_nothing(self):
        app = self._stub(_op_target=r"C:\installing\A")
        marked, _ = self._close(app, False)
        self.assertEqual(marked, [])
        self.assertFalse(app._closing, "用户选了「否」就不该进入关闭流程")

    def test_reading_git_is_not_a_long_task(self):
        app = self._stub(git_busy=True)
        self.assertFalse(app._long_task_running())
        marked, asked = self._close(app, True)
        self.assertEqual(asked, [], "只是读 git 信息，不该弹「任务还在进行」")
        self.assertEqual(marked, [], "更不该把好端端的目录记成「被打断」")

    def test_plugins_and_migration_ask_but_do_not_mark_installs(self):
        for flag in ("plugin_busy", "mig_busy"):
            app = self._stub(**{flag: True})
            self.assertTrue(app._long_task_running(), flag)
            marked, asked = self._close(app, True)
            self.assertEqual(asked, [1], flag)
            self.assertEqual(marked, [], f"{flag} 不是安装，不该写安装标记")


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


class InstallPnpmTest(unittest.TestCase):
    """pnpm 缺失时才走到的那条路：npm/corepack 必须用 which 解析出的全路径。

    实测：Windows 上裸名字 `"npm"` 交给 CreateProcess 会 FileNotFoundError（只给名字补
    `.exe`，而 npm 是 `.CMD`）。这条恰恰**只为新机器存在**（老机器上 pnpm 已就绪会直接
    跳过），所以一直没被现网发现——修好之前，一台干净机器点「一键完整安装」必炸在这里。
    """

    def _engine(self) -> installer.Engine:
        return installer.Engine(mode="online", use_mirror=False, log=lambda _s: None)

    def test_uses_resolved_paths_instead_of_bare_names(self):
        calls: list[list[str]] = []

        def fake_run(argv, cwd=None, env=None):
            calls.append(list(argv))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with mock.patch.object(installer, "find_pnpm", lambda: None), \
                mock.patch.object(installer, "find_npm",
                                  lambda: r"C:\Program Files\nodejs\npm.CMD"), \
                mock.patch.object(installer.shutil, "which",
                                  lambda n: rf"C:\Program Files\nodejs\{n}.CMD"), \
                mock.patch.object(installer, "run", fake_run):
            self._engine().install_pnpm()
        self.assertTrue(calls, "pnpm 缺失时必须真的去装")
        for argv in calls:
            self.assertNotIn(argv[0], ("npm", "corepack"), f"不能用裸名字：{argv}")
            self.assertTrue(argv[0].upper().endswith(".CMD") or os.path.isabs(argv[0]),
                            f"必须是解析出来的全路径：{argv}")

    def test_missing_npm_explains_instead_of_crashing(self):
        with mock.patch.object(installer, "find_pnpm", lambda: None), \
                mock.patch.object(installer, "find_npm", lambda: None):
            with self.assertRaises(installer.InstallError) as ctx:
                self._engine().install_pnpm()
        self.assertIn("找不到 npm", str(ctx.exception))


class SaveConfigAtomicTest(unittest.TestCase):
    """配置写盘要原子：中途失败不能把已有的配置毁掉（写的中间断电=空文件）。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-cfg-"))
        self._old = (installer.CONFIG_DIR, installer.CONFIG_PATH)
        installer.CONFIG_DIR = self.tmp
        installer.CONFIG_PATH = self.tmp / "config.json"
        installer.CONFIG_PATH.write_text('{"installDir": "D:\\\\keep"}',
                                         encoding="utf-8")

    def tearDown(self) -> None:
        installer.CONFIG_DIR, installer.CONFIG_PATH = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_failed_replace_keeps_the_old_config(self):
        with mock.patch.object(installer.os, "replace",
                               side_effect=OSError("disk full")):
            installer.save_config({"publishScope": "@me"})
        self.assertEqual(
            json.loads(installer.CONFIG_PATH.read_text(encoding="utf-8")),
            {"installDir": "D:\\keep"})

    def test_successful_save_replaces_and_leaves_no_tmp(self):
        installer.save_config({"publishScope": "@me"})
        self.assertEqual(
            json.loads(installer.CONFIG_PATH.read_text(encoding="utf-8")),
            {"installDir": "D:\\keep", "publishScope": "@me"})
        self.assertEqual(list(self.tmp.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
