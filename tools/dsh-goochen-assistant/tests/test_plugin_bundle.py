# -*- coding: utf-8 -*-
"""「打包成 bundle（发行）」的回归测试：纯文件变换，不联网、不跑 pnpm。

守的是发行时最容易漏的几件小事——它们每一条都让包"装上了却什么都不发生"：
① manifest 没有 `dsh.bundle.patch` → `dsh plugin add` 只当普通依赖，不激活任何层；
② `files` 里没带 `cordis.patch.yml` → 发出去的包里压根没有层；
③ 留着 `private: true` → npm 直接拒绝发布；
④ 包名没换 → 发不进 registry（`@dsh-user` 不是谁都能发的 scope）。

pnpm 那一步在 `pack_bundle` 里，需要真实 pnpm，所以只做端到端验证（见提交说明），
这里不跑。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import _tempguard  # noqa: F401,E402  临时目录统一收口，进程结束整体清理

import plugin_store as ps  # noqa: E402


def write_pkg(dir_: Path, pkg: dict) -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / "package.json").write_text(json.dumps(pkg, ensure_ascii=False),
                                       encoding="utf-8")


class BundleManifestTest(unittest.TestCase):
    """manifest 改造：该加的都加上，不该动的一律不动。"""

    def base(self) -> dict:
        return {
            "name": "@dsh-user/toast", "version": "0.1.0", "private": True,
            "type": "module", "main": "./lib/index.js",
            "exports": {".": "./lib/index.js", "./client": "./lib/client.js"},
            "dsh": {"client": {"platform": "web"}},
            "files": ["lib", "README.md"],
            "dependencies": {"zod": "^4.0.0", "@deepseek-ai/dsh-llm": "0.1.2-alpha.3"},
        }

    def test_declares_bundle_patch_and_keeps_client(self):
        out, notes = ps.bundle_manifest(self.base(), "@me/toast")
        self.assertEqual(out["dsh"]["bundle"], {"patch": "./cordis.patch.yml"})
        self.assertEqual(out["dsh"]["client"], {"platform": "web"})   # 浏览器半不能丢
        self.assertIn("cordis.patch.yml", out["files"])
        self.assertNotIn("private", out)
        self.assertEqual(out["name"], "@me/toast")
        self.assertEqual(out["publishConfig"], {"access": "public"})
        self.assertTrue(notes)

    def test_official_deps_move_to_peer_dependencies(self):
        out, _ = ps.bundle_manifest(self.base(), "@me/toast")
        self.assertEqual(out["dependencies"], {"zod": "^4.0.0"})
        self.assertEqual(out["peerDependencies"], {"@deepseek-ai/dsh-llm": "0.1.2-alpha.3"})

    def test_missing_files_gets_defaults(self):
        pkg = self.base()
        pkg.pop("files")
        out, _ = ps.bundle_manifest(pkg, "@me/toast")
        self.assertIn("cordis.patch.yml", out["files"])

    def test_license_is_never_invented(self):
        out, notes = ps.bundle_manifest(self.base(), "@me/toast")
        self.assertNotIn("license", out)                # 授权是作者的决定
        self.assertTrue(any("license" in n for n in notes))

    def test_manifest_of_the_caller_is_not_mutated(self):
        pkg = self.base()
        ps.bundle_manifest(pkg, "@me/toast")
        self.assertNotIn("bundle", pkg["dsh"])
        self.assertTrue(pkg["private"])

    def test_package_name_without_scope_keeps_dsh_user(self):
        self.assertEqual(ps.bundle_package_name("toast"), "@dsh-user/toast")
        self.assertEqual(ps.bundle_package_name("toast", "@me/"), "@me/toast")


class BundlePatchTest(unittest.TestCase):
    """包内 cordis.patch.yml：沿用现网那几行，只换包名。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-bundle-"))
        self.src = self.tmp / "toast"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reuses_install_example_and_rewrites_the_name(self):
        (self.src / "install").mkdir(parents=True)
        (self.src / "install" / "patch.example.yml").write_text(
            "# 装它时用的那几行\n"
            "- insert:\n"
            "    - id: toast\n"
            "      name: '@dsh-user/toast'\n", encoding="utf-8")
        text = ps.bundle_patch_text("toast", "@me/toast", self.src)
        self.assertIn("name: '@me/toast'", text)
        self.assertNotIn("@dsh-user/toast", text)
        self.assertIn("id: toast", text)
        self.assertIn("# 装它时用的那几行", text)        # 注释也照搬

    def test_generates_minimal_row_without_an_example(self):
        self.src.mkdir(parents=True)
        text = ps.bundle_patch_text("toast", "@me/toast", self.src)
        self.assertEqual(text, "- insert:\n    - id: toast\n      name: '@me/toast'\n")

    def test_broken_example_falls_back_to_generated_row(self):
        (self.src / "install").mkdir(parents=True)
        (self.src / "install" / "patch.example.yml").write_text(
            "# 只有注释，没有行\n", encoding="utf-8")
        text = ps.bundle_patch_text("toast", "@me/toast", self.src)
        self.assertIn("name: '@me/toast'", text)
        self.assertIn("id: toast", text)


class StageBundleTest(unittest.TestCase):
    """暂存目录：幂等、源目录一个字节都不动。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-stage-"))
        self.src = self.tmp / "plugins" / "toast"
        (self.src / "lib").mkdir(parents=True)
        (self.src / "lib" / "index.js").write_text("export const name='toast'\n",
                                                   encoding="utf-8")
        (self.src / "lib" / "client.js").write_text("// client\n", encoding="utf-8")
        (self.src / "node_modules" / "junk").mkdir(parents=True)
        (self.src / "node_modules" / "junk" / "x.js").write_text("", encoding="utf-8")
        write_pkg(self.src, {
            "name": "@dsh-user/toast", "version": "0.2.3", "private": True,
            "main": "./lib/index.js", "dsh": {"client": {"platform": "web"}},
            "files": ["lib"],
        })
        self.before = (self.src / "package.json").read_text(encoding="utf-8")
        self.out = self.tmp / "dist"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_stage_produces_a_publishable_bundle_dir(self):
        plan = ps.stage_bundle(self.src, self.out, scope="@me", slug="toast")
        self.assertEqual(plan.out_dir, self.out / "toast-0.2.3")
        self.assertTrue((plan.out_dir / "cordis.patch.yml").is_file())
        self.assertTrue((plan.out_dir / "lib" / "index.js").is_file())
        self.assertFalse((plan.out_dir / "node_modules").exists())   # 依赖不进包
        manifest = json.loads((plan.out_dir / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "@me/toast")
        self.assertEqual(manifest["dsh"]["bundle"]["patch"], "./cordis.patch.yml")
        self.assertNotIn("private", manifest)

    def test_source_dir_is_untouched(self):
        ps.stage_bundle(self.src, self.out, scope="@me", slug="toast")
        self.assertEqual((self.src / "package.json").read_text(encoding="utf-8"),
                         self.before)
        self.assertFalse((self.src / "cordis.patch.yml").exists())

    def test_stage_is_idempotent(self):
        first = ps.stage_bundle(self.src, self.out, scope="@me", slug="toast")
        (first.out_dir / "stale.txt").write_text("x", encoding="utf-8")
        second = ps.stage_bundle(self.src, self.out, scope="@me", slug="toast")
        self.assertEqual(first.out_dir, second.out_dir)
        self.assertFalse((second.out_dir / "stale.txt").exists())

    def test_bad_slug_or_missing_manifest_is_refused(self):
        with self.assertRaises(ps.PluginError):
            ps.stage_bundle(self.src, self.out, slug="Bad_Name")
        empty = self.tmp / "empty"
        empty.mkdir()
        with self.assertRaises(ps.PluginError):
            ps.stage_bundle(empty, self.out)


class FindSourceTest(unittest.TestCase):
    """找源码目录：开发机的正本在 dsh 检出的 plugins/<slug>。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-src-"))
        self.home = self.tmp / "home"
        self.project = self.tmp / "checkout"
        (self.home / "profiles" / "node_modules" / "@dsh-user" / "toast").mkdir(
            parents=True)
        write_pkg(self.home / "profiles" / "node_modules" / "@dsh-user" / "toast",
                  {"name": "@dsh-user/toast", "main": "./lib/index.js"})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_prefers_the_checkout_copy_but_falls_back_to_the_anchor(self):
        write_pkg(self.project / "plugins" / "toast", {"name": "@dsh-user/toast"})
        self.assertEqual(ps.find_plugin_source(self.home, "toast", project=self.project),
                         self.project / "plugins" / "toast")
        self.assertEqual(ps.find_plugin_source(self.home, "nope"), None)
        # 检出里没有时，退回装好的共享锚目录（也能打包，只是少了 README/install）
        self.assertEqual(ps.find_plugin_source(self.home, "toast"),
                         self.home / "profiles" / "node_modules" / "@dsh-user" / "toast")


if __name__ == "__main__":
    unittest.main()
