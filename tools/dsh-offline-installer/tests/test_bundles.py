# -*- coding: utf-8 -*-
"""v0.3 bundle 插件（dsh plugin 安装）后端测试：候选/清单/打包/安装/移除/抓取。"""
from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import plugin_store as ps  # noqa: E402


def make_home() -> Path:
    home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
    (home / "profiles" / "web").mkdir(parents=True)
    return home


def make_bundle(root: Path, slug: str, *, built=True,
                patch=False, deps=True, name=None) -> Path:
    d = root / slug
    (d / "lib").mkdir(parents=True)
    if built:
        (d / "lib" / "index.js").write_text("export const b = 1\n", encoding="utf-8")
    pkg = {"name": name or slug, "version": "1.0.0", "main": "./lib/index.js"}
    if patch:
        pkg["dsh"] = {"bundle": {"patch": "./cordis.patch.yml"}}
    pkg["files"] = ["lib", "cordis.patch.yml"]
    (d / "package.json").write_text(json.dumps(pkg), encoding="utf-8")
    if patch:
        (d / "cordis.patch.yml").write_text(
            "- insert:\n    - id: x\n      name: '%s'\n" % (name or slug),
            encoding="utf-8")
    return d


class FakeDsh:
    """注入 run_dsh：模拟 pnpm/add-remove 对 profile manifest 的 reconcile。"""

    def __init__(self, home: Path, fail_code: int = 0, noop: bool = False):
        self.home = home
        self.fail_code = fail_code
        self.noop = noop
        self.calls: list[list[str]] = []

    def _manifest(self) -> dict:
        return ps.profile_manifest(self.home)

    def __call__(self, args: list[str]) -> tuple[int, str, str]:
        self.calls.append(list(args))
        if self.fail_code:
            return self.fail_code, "", "pnpm failed"
        verb = args[0]
        if verb == "add":
            p = Path(args[1])
            if p.exists() and (p / "package.json").exists():
                name = ps._bundle_name(p)
            elif p.exists() and p.suffix == ".tgz":
                name = ps._bundle_name(p)
            else:
                name = args[1]           # 远程规格：包名
        else:
            name = args[1]
        data = self._manifest()
        bundles = data.setdefault("dsh", {}).setdefault("profile", {}) \
            .setdefault("bundles", [])
        if verb == "add" and not self.noop:
            if name not in bundles:
                bundles.append(name)
            ps.profile_manifest_write(self.home, data)
        elif verb == "remove" and not self.noop and name in bundles:
            bundles.remove(name)
            ps.profile_manifest_write(self.home, data)
        return 0, "", ""


class BundleCandidatesTest(unittest.TestCase):
    def test_candidates(self) -> None:
        root = Path(tempfile.mkdtemp()) / "proj"
        root.mkdir(parents=True)
        a = make_bundle(root / "plugins", "plug-a", built=True, patch=True)
        b = make_bundle(root / "plugins", "plug-b", built=False, patch=True)
        make_bundle(root / "plugins", "plain", built=True, patch=False)  # 无 bundle 声明
        cands = ps.bundle_candidates(root)
        by = {c.name: c for c in cands}
        self.assertEqual(set(by), {"plug-a", "plug-b"})
        self.assertTrue(by["plug-a"].built)
        self.assertFalse(by["plug-b"].built)


class InstalledTest(unittest.TestCase):
    def test_installed_marks_builtin(self) -> None:
        home = make_home()
        ps.profile_manifest_write(home, {"dsh": {"profile": {"bundles": [
            "@deepseek-ai/dsh-base", "dshmarket", "@deepseek-ai/dsh-web-app"]}}})
        got = dict(ps.bundle_installed(home))
        self.assertTrue(got["@deepseek-ai/dsh-base"])
        self.assertFalse(got["dshmarket"])
        self.assertTrue(got["@deepseek-ai/dsh-web-app"])


class PackTest(unittest.TestCase):
    def _tgz(self, d: Path) -> Path:
        out = Path(tempfile.mkdtemp()) / "b.tgz"
        ps.bundle_pack(d, out, name="plug-a", version="1.0.0")
        return out

    def test_pack_and_name(self) -> None:
        d = make_bundle(Path(tempfile.mkdtemp()) / "p" / "plugins", "plug-a",
                        built=True, patch=True)
        tgz = self._tgz(d)
        self.assertEqual(ps._bundle_name(tgz), "plug-a")
        with tarfile.open(tgz, "r:gz") as tf:
            names = {m.name for m in tf.getmembers()}
        self.assertIn("package/package.json", names)
        self.assertIn("package/lib/index.js", names)
        self.assertIn("package/cordis.patch.yml", names)

    def test_pack_refuses_unbuilt(self) -> None:
        d = make_bundle(Path(tempfile.mkdtemp()) / "p" / "plugins", "plug-b",
                        built=False, patch=True)
        with self.assertRaises(ps.PluginError):
            ps.bundle_pack(d, Path(tempfile.mkdtemp()) / "x.tgz",
                           name="plug-b", version="1.0.0")


class InstallRemoveTest(unittest.TestCase):
    def _source(self, name: str, built=True) -> Path:
        root = Path(tempfile.mkdtemp()) / "src"
        return make_bundle(root, name, built=built, patch=True)

    def test_install_success(self) -> None:
        home = make_home()
        fake = FakeDsh(home)
        src = self._source("dshmarket")
        name = ps.bundle_install(home, src, run_dsh=fake)
        self.assertEqual(name, "dshmarket")
        self.assertIn("dshmarket", dict(ps.bundle_installed(home)))
        self.assertEqual(fake.calls[0][:2], ["add", str(src.resolve())])

    def test_install_remote_spec(self) -> None:
        home = make_home()
        fake = FakeDsh(home)
        name = ps.bundle_install(home, "dshmarket", project=Path.home(),
                                 run_dsh=fake)
        self.assertEqual(name, "dshmarket")
        self.assertEqual(fake.calls[0][:2], ["add", "dshmarket"])

    def test_install_absent_rolls_back(self) -> None:
        home = make_home()
        fake = FakeDsh(home, noop=True)   # 假装成功但没写 bundles
        src = self._source("dshmarket")
        with self.assertRaises(ps.PluginError):
            ps.bundle_install(home, src, run_dsh=fake)
        self.assertEqual(ps.bundle_installed(home), [])

    def test_install_fail_rolls_back(self) -> None:
        home = make_home()
        fake = FakeDsh(home, fail_code=1)
        src = self._source("dshmarket")
        with self.assertRaises(ps.PluginError) as ctx:
            ps.bundle_install(home, src, run_dsh=fake)
        self.assertIn("pnpm failed", str(ctx.exception))
        self.assertEqual(ps.bundle_installed(home), [])

    def test_install_refuses_builtin(self) -> None:
        home = make_home()
        fake = FakeDsh(home)
        src = self._source("@deepseek-ai/dsh-base")
        with self.assertRaises(ps.PluginError):
            ps.bundle_install(home, src, run_dsh=fake)
        self.assertEqual(fake.calls, [])

    def test_remove(self) -> None:
        home = make_home()
        ps.profile_manifest_write(home, {"dsh": {"profile": {
            "bundles": ["@deepseek-ai/dsh-base", "dshmarket"]}}})
        fake = FakeDsh(home)
        ps.bundle_remove(home, "dshmarket", run_dsh=fake)
        self.assertEqual(dict(ps.bundle_installed(home)), {"@deepseek-ai/dsh-base": True})
        self.assertEqual(fake.calls[0][:2], ["remove", "dshmarket"])

    def test_remove_guards(self) -> None:
        home = make_home()
        with self.assertRaises(ps.PluginError):
            ps.bundle_remove(home, "@deepseek-ai/dsh-base")
        with self.assertRaises(ps.PluginError):
            ps.bundle_remove(home, "not-there")


class FetchSpecTest(unittest.TestCase):
    def test_spec_name_and_url(self) -> None:
        self.assertEqual(ps._spec_name("dsh-market"), "dsh-market")
        self.assertEqual(ps._spec_url("dshmarket"),
                         "https://github.com/dsh-market/dsh-market.git")
        self.assertEqual(ps._spec_url("github:foo/bar"),
                         "https://github.com/foo/bar.git")
        self.assertEqual(ps._spec_name("github:foo/bar"), "bar")
        self.assertEqual(ps._spec_name("https://github.com/x/y.git"), "y")

    def test_fetch_reuses_existing(self) -> None:
        dest = Path(tempfile.mkdtemp()) / "plugins"
        make_bundle(dest, "dsh-market", patch=True)
        out = ps.bundle_fetch("dshmarket", dest)
        self.assertEqual(out.name, "dsh-market")


class MarketTest(unittest.TestCase):
    def test_market_entry_states(self) -> None:
        home = make_home()
        project = Path(tempfile.mkdtemp())
        make_bundle(project / "plugins", "dsh-market", built=True, patch=True,
                    name="dshmarket")
        ps.profile_manifest_write(home, {"dsh": {"profile": {
            "bundles": ["@deepseek-ai/dsh-base", "dshmarket"]}}})
        entries = ps.market_entries(home, project)
        by = {e.spec: e for e in entries}
        e = by["dshmarket"]
        self.assertTrue(e.downloaded)
        self.assertTrue(e.installed)
        self.assertIn("dsh-lsp-actions", by)           # 收录未下载
        self.assertFalse(by["dsh-lsp-actions"].downloaded)
        self.assertNotIn("@deepseek-ai/dsh-base", by)  # 内置不列

    def test_bundle_check(self) -> None:
        good = make_bundle(Path(tempfile.mkdtemp()), "ok", built=True, patch=True)
        name, errs = ps.bundle_check(good)
        self.assertEqual(name, "ok")
        self.assertEqual(errs, [])
        # 未构建不算错误（安装前置合格），只在 notes 提示
        broken = make_bundle(Path(tempfile.mkdtemp()), "broken", built=False, patch=True)
        _, errs = ps.bundle_check(broken)
        self.assertEqual(errs, [])
        _n, notes = ps.bundle_notes(broken)
        self.assertTrue(any("未构建" in x for x in notes))
        tgz = Path(tempfile.mkdtemp()) / "x.tgz"
        ps.bundle_pack(good, tgz, name="ok", version="1")
        _, errs = ps.bundle_check(tgz)
        self.assertEqual(errs, [])

    def test_bundle_check_client_in_exports(self) -> None:
        # dsh-market 形态：客户端在 client/client.js，exports["./client"] 指向它
        d = Path(tempfile.mkdtemp()) / "dsh-market"
        (d / "lib").mkdir(parents=True)
        (d / "lib" / "index.js").write_text("export const x = 1\n", encoding="utf-8")
        (d / "client").mkdir(parents=True)
        (d / "client" / "client.js").write_text("export const c = 1\n", encoding="utf-8")
        pkg = {"name": "dshmarket", "version": "1", "main": "./lib/index.js",
               "dsh": {"bundle": {"patch": "./cordis.patch.yml"},
                       "client": {"platform": "web"}},
               "exports": {"./client": "./client/client.js"}}
        (d / "package.json").write_text(json.dumps(pkg), encoding="utf-8")
        (d / "cordis.patch.yml").write_text("- insert: []\n", encoding="utf-8")
        name, errs = ps.bundle_check(d)
        self.assertEqual(name, "dshmarket")
        self.assertEqual(errs, [])

    def test_latest_version(self) -> None:
        def fake(_a: list[str]) -> tuple[int, str, str]:
            return 0, "1.44.1\n", ""
        self.assertEqual(ps.bundle_latest_version("dshmarket", run_npm=fake), "1.44.1")

        def fake_err(_a: list[str]) -> tuple[int, str, str]:
            return 1, "", "err"
        self.assertIsNone(ps.bundle_latest_version("dshmarket", run_npm=fake_err))

    def test_update(self) -> None:
        home = make_home()
        ps.profile_manifest_write(home, {"dsh": {"profile": {
            "bundles": ["dshmarket"]}}})
        fake = FakeDsh(home)
        name = ps.bundle_update(home, "dshmarket", project=Path.home(), run_dsh=fake)
        self.assertEqual(name, "dshmarket")
        self.assertEqual(fake.calls[0][:2], ["add", "dshmarket@latest"])

    def test_bundle_check_patch_file_missing(self) -> None:
        d = make_bundle(Path(tempfile.mkdtemp()), "odd", built=True, patch=True)
        # 让 patch 指向不存在的文件
        pkg = (json.loads((d / "package.json").read_text(encoding="utf-8")) or {})
        pkg["dsh"]["bundle"]["patch"] = "./patch/other.yml"
        (d / "package.json").write_text(json.dumps(pkg), encoding="utf-8")
        _, errs = ps.bundle_check(d)
        self.assertTrue(any("patch/other.yml" in x for x in errs))

    def test_install_reinstall_same_name_succeeds(self) -> None:
        home = make_home()
        ps.profile_manifest_write(home, {"dsh": {"profile": {
            "bundles": ["dshmarket"]}}})
        fake = FakeDsh(home)
        src = make_bundle(Path(tempfile.mkdtemp()), "dshmarket", built=True, patch=True)
        name = ps.bundle_install(home, src, run_dsh=fake)
        self.assertEqual(name, "dshmarket")       # 同名重装不误判失败
        self.assertIn("dshmarket", dict(ps.bundle_installed(home)))

    def test_installed_version(self) -> None:
        home = make_home()
        ps.profile_manifest_write(home, {"dependencies": {"dshmarket": "1.44.0"}})
        self.assertEqual(ps.bundle_installed_version(home, "dshmarket"), "1.44.0")
        self.assertEqual(ps.bundle_installed_version(home, "nope"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
