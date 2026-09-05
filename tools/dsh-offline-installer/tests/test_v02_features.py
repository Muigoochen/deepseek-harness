# -*- coding: utf-8 -*-
"""v0.2 特性测试：外部行接管 / tar 离线包列表 / pack_plugins 打包自检。"""
from __future__ import annotations

import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import plugin_store as ps  # noqa: E402
import pack_plugins as pack  # noqa: E402


def make_home() -> Path:
    home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
    (home / "profiles" / "web").mkdir(parents=True)
    return home


def write_plugin(root: Path, slug: str, *, client: bool = False,
                 broken_name: bool = False, no_lib: bool = False) -> Path:
    d = root / slug
    (d / "lib").mkdir(parents=True)
    if not no_lib:
        (d / "lib" / "index.js").write_text("export const x = 1\n", encoding="utf-8")
    pkg = {"name": ("bad" if broken_name else f"@dsh-user/{slug}"),
           "main": "./lib/index.js"}
    if client:
        pkg["dsh"] = {"client": {"platform": "web"}}
        pkg["exports"] = {"./client": "./lib/client.js"}
        (d / "lib" / "client.js").write_text("export const c = 1\n", encoding="utf-8")
    (d / "package.json").write_text(json.dumps(pkg), encoding="utf-8")
    return d


FAKE_OK = ps.DumpResult(ok=True, exit_code=0)


class DumpGateProbe:
    def __call__(self, patch_path: Path) -> ps.DumpResult:
        self.seen = patch_path.read_text(encoding="utf-8")
        return FAKE_OK


EXTERNAL_PLAIN = (
    "- insert:\n"
    "    - id: hello\n"
    "      name: '@dsh-user/hello'\n"
    "- insert:\n"
    "    - id: other\n"
    "      name: '@dsh-user/other'\n"
)


class AdoptTest(unittest.TestCase):
    def _home_with(self, text: str) -> Path:
        home = make_home()
        ps.commit_patch(home, text)
        return home

    def test_adopt_plain_external(self) -> None:
        home = self._home_with(EXTERNAL_PLAIN)
        probe = DumpGateProbe()
        led = ps.adopt(home, "hello", run_dump=probe)
        self.assertIsNotNone(led.row("hello"))
        text = ps.web_patch(home).read_text(encoding="utf-8")
        head, _, tail = text.partition(ps.MANAGED_START)
        # hello 离开段外区域、只出现在管理段；其它外部行段外原样
        self.assertNotIn("hello", head)
        self.assertIn("- insert:\n    - id: hello", tail)
        self.assertIn("- insert:\n    - id: other\n", head)
        # 幂等：再次接管报错（已在台账）
        with self.assertRaises(ps.PluginError):
            ps.adopt(home, "hello", run_dump=probe)

    def test_adopt_keeps_disabled(self) -> None:
        text = ("- insert:\n    - id: sleepy\n"
                "      name: '@dsh-user/sleepy'\n      disabled: true\n")
        home = self._home_with(text)
        led = ps.adopt(home, "sleepy", run_dump=DumpGateProbe())
        self.assertTrue(led.row("sleepy").disabled)
        out = ps.web_patch(home).read_text(encoding="utf-8")
        self.assertIn("      disabled: true", out)

    def test_refuse_config_row(self) -> None:
        text = ("- insert:\n    - id: rich\n      name: '@dsh-user/rich'\n"
                "      config:\n        mode: hint\n")
        home = self._home_with(text)
        with self.assertRaises(ps.ProtectedShapeError):
            ps.adopt(home, "rich", run_dump=DumpGateProbe())

    def test_refuse_leading_comment(self) -> None:
        text = ("# 说明：该行由 install.ps1 写入\n"
                "- insert:\n    - id: noted\n      name: '@dsh-user/noted'\n")
        home = self._home_with(text)
        with self.assertRaises(ps.ProtectedShapeError):
            ps.adopt(home, "noted", run_dump=DumpGateProbe())

    def test_refuse_merged_entry(self) -> None:
        # toast 并进 lsp-echo 元素的现网形态：找不到独立元素
        text = ("- insert:\n    - id: lsp-echo\n      name: '@dsh-user/lsp-echo'\n"
                "      config:\n        autoBaseline: true\n"
                "    - id: toast\n      name: '@dsh-user/toast'\n")
        home = self._home_with(text)
        with self.assertRaises(ps.ProtectedShapeError):
            ps.adopt(home, "toast", run_dump=DumpGateProbe())

    def test_adopt_then_manage(self) -> None:
        home = self._home_with(EXTERNAL_PLAIN)
        probe = DumpGateProbe()
        ps.adopt(home, "hello", run_dump=probe)
        led = ps.set_enabled(home, "hello", False, run_dump=probe)
        self.assertTrue(led.row("hello").disabled)
        ps.uninstall(home, "hello", run_dump=probe)
        text = ps.web_patch(home).read_text(encoding="utf-8")
        self.assertNotIn("@dsh-user/hello", text)


class ArchiveListTest(unittest.TestCase):
    def _tar_with(self, path: Path, entries: list[tuple[str, dict, bool]]) -> None:
        with tarfile.open(path, "w:gz") as tf:
            for slug, pkg, has_lib in entries:
                info = tarfile.TarInfo(f"{slug}/package.json")
                raw = json.dumps(pkg).encode("utf-8")
                info.size = len(raw)
                tf.addfile(info, __import__("io").BytesIO(raw))
                if has_lib:
                    b = b"x"
                    info2 = tarfile.TarInfo(f"{slug}/lib/index.js")
                    info2.size = len(b)
                    tf.addfile(info2, __import__("io").BytesIO(b))

    def test_list_flags(self) -> None:
        out = Path(tempfile.mkdtemp()) / "p.tar.gz"
        self._tar_with(out, [
            ("good", {"name": "@dsh-user/good"}, True),
            ("badname", {"name": "@dsh-user/wrong"}, True),
            ("nolib", {"name": "@dsh-user/nolib"}, False),
        ])
        rows = ps.list_archive_plugins(out)
        by = dict(rows)
        self.assertTrue(by["good"].ok)
        self.assertFalse(by["badname"].ok)
        self.assertFalse(by["nolib"].ok)
        self.assertTrue(any("lib/index.js" in e for e in by["nolib"].errors))


class PackTest(unittest.TestCase):
    def test_build_archive_filters(self) -> None:
        root = Path(tempfile.mkdtemp()) / "plugins"
        root.mkdir(parents=True)
        write_plugin(root, "good-a")
        write_plugin(root, "broken-b", broken_name=True)
        write_plugin(root, "no-lib-c", no_lib=True)
        out = Path(tempfile.mkdtemp()) / "plugins.tar.gz"
        results = pack.build_archive(root, out)
        ok = {r.slug for r in results if r.ok}
        self.assertEqual(ok, {"good-a"})
        self.assertEqual({r.slug for r in results if not r.ok},
                         {"broken-b", "no-lib-c"})
        rows = ps.list_archive_plugins(out)
        self.assertEqual([s for s, v in rows if v.ok], ["good-a"])

    def test_cli_exit_code(self) -> None:
        root = Path(tempfile.mkdtemp()) / "plugins"
        root.mkdir(parents=True)
        write_plugin(root, "cli-ok")
        out = Path(tempfile.mkdtemp()) / "out.tar.gz"
        code = pack.main(["--plugins", str(root), "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertTrue(out.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
