# -*- coding: utf-8 -*-
"""plugin_store 单元测试（Python 标准库 unittest；无需网络/dsh）。

运行：
  python -m unittest discover -s tests -p "test_*.py"   （在 tools/dsh-offline-installer 下）
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import plugin_store as ps  # noqa: E402


def make_home() -> Path:
    home = Path(tempfile.mkdtemp(prefix="dsh-home-"))
    (home / "profiles" / "web").mkdir(parents=True)
    return home


def make_plugin(root: Path, slug: str, *, client: bool = False,
                bad_name: bool = False) -> Path:
    d = root / slug
    (d / "lib").mkdir(parents=True)
    (d / "lib" / "index.js").write_text("export const x = 1\n", encoding="utf-8")
    pkg = {
        "name": ("oops" if bad_name else f"@dsh-user/{slug}"),
        "version": "0.0.1",
        "main": "./lib/index.js",
    }
    if client:
        pkg["dsh"] = {"client": {"platform": "web"}}
        pkg["exports"] = {"./client": "./lib/client.js", ".": "./lib/index.js"}
        (d / "lib" / "client.js").write_text("export const c = 1\n", encoding="utf-8")
    (d / "package.json").write_text(json.dumps(pkg), encoding="utf-8")
    return d


FAKE_OK = ps.DumpResult(ok=True, exit_code=0)


class DumpGateProbe:
    """记录结构门收到的克隆补丁文本并放行。"""

    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, patch_path: Path) -> ps.DumpResult:
        self.seen.append(patch_path.read_text(encoding="utf-8"))
        return FAKE_OK


class SegmentTest(unittest.TestCase):
    def test_append_when_no_segment(self) -> None:
        text = "- insert:\n    - id: other\n      name: '@dsh-user/other'\n"
        out = ps.apply_managed(text, [ps.ManagedRow(id="newone")])
        self.assertIn(ps.MANAGED_START, out)
        self.assertIn("- insert:\n    - id: newone\n", out)
        self.assertTrue(out.endswith(ps.MANAGED_END + "\n"))
        # 原内容原样保留
        self.assertIn("- insert:\n    - id: other\n", out)
        # 幂等：再次应用同一台账不重复
        out2 = ps.apply_managed(out, [ps.ManagedRow(id="newone")])
        self.assertEqual(out, out2)

    def test_replace_and_disable(self) -> None:
        rows = [ps.ManagedRow(id="a"), ps.ManagedRow(id="b", disabled=True)]
        text = "head\n"
        text = ps.apply_managed(text, rows)
        text = ps.apply_managed(text, [ps.ManagedRow(id="a", disabled=True),
                                       ps.ManagedRow(id="b")])
        self.assertIn("      disabled: true\n", text)
        self.assertLess(text.index("disabled: true"), text.index("- insert:\n    - id: b"))

    def test_guard_config_inside_segment(self) -> None:
        text = (ps.MANAGED_START + "\n"
                "- insert:\n    - id: a\n      name: '@dsh-user/a'\n"
                "      config:\n        x: 1\n" + ps.MANAGED_END + "\n")
        with self.assertRaises(ps.ProtectedShapeError):
            ps.apply_managed(text, [ps.ManagedRow(id="a")])

    def test_guard_content_after_end(self) -> None:
        text = (ps.MANAGED_START + "\n- insert:\n    - id: a\n"
                "      name: '@dsh-user/a'\n" + ps.MANAGED_END +
                "\n- insert:\n    - id: stray\n      name: '@dsh-user/stray'\n")
        with self.assertRaises(ps.ProtectedShapeError):
            ps.find_managed_span(text)

    def test_guard_ids_mismatch_ledger(self) -> None:
        rows = [ps.ManagedRow(id="a")]
        text = ps.apply_managed("", rows)
        # 段内被手工改成 b
        text = text.replace("- insert:\n    - id: a", "- insert:\n    - id: b")
        text = text.replace("name: '@dsh-user/a'", "name: '@dsh-user/b'")
        with self.assertRaises(ps.ProtectedShapeError):
            ps.apply_managed(text, [ps.ManagedRow(id="a")], expect=rows)

    def test_no_glue_when_file_has_no_trailing_newline(self) -> None:
        out = ps.apply_managed("no newline at end", [ps.ManagedRow(id="a")])
        self.assertIn(ps.MANAGED_START, out)
        self.assertTrue(out.startswith("no newline at end\n" + ps.MANAGED_START))

    def test_duplicate_id_rejected(self) -> None:
        with self.assertRaises(ps.ProtectedShapeError):
            ps.apply_managed("", [ps.ManagedRow(id="a"), ps.ManagedRow(id="a")])


class LedgerTest(unittest.TestCase):
    def test_roundtrip(self) -> None:
        home = make_home()
        ps.ledger_save(home, ps.Ledger(rows=(ps.ManagedRow(id="a", disabled=True),)))
        led = ps.ledger_load(home)
        self.assertEqual(led.row("a"), ps.ManagedRow(id="a", disabled=True))
        self.assertIsNone(led.row("nope"))

    def test_corrupt_fails_loud(self) -> None:
        home = make_home()
        p = ps.ledger_path(home)
        p.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ps.PluginError):
            ps.ledger_load(home)


class ValidateDiscoverTest(unittest.TestCase):
    def test_validate_rules(self) -> None:
        root = Path(tempfile.mkdtemp())
        ok = make_plugin(root, "demo-one")
        self.assertTrue(ps.validate_package(ok).ok)
        no_lib = make_plugin(root, "demo-two")
        (no_lib / "lib" / "index.js").unlink()
        v = ps.validate_package(no_lib)
        self.assertFalse(v.ok)
        self.assertTrue(any("lib/index.js" in e for e in v.errors))
        bad = make_plugin(root, "demo-three", bad_name=True)
        self.assertFalse(ps.validate_package(bad).ok)
        need_client = make_plugin(root, "demo-four", client=True)
        self.assertTrue(ps.validate_package(need_client).ok)
        (need_client / "lib" / "client.js").unlink()
        self.assertFalse(ps.validate_package(need_client).ok)

    def test_discover_skips_non_plugins(self) -> None:
        project = Path(tempfile.mkdtemp())
        plugins = project / "plugins"
        plugins.mkdir(parents=True)
        make_plugin(plugins, "real-one")
        # 非插件目录（无 package.json，如 time-context 示例）
        (plugins / "time-context").mkdir()
        # name 不匹配
        make_plugin(plugins, "mismatch", bad_name=True)
        srcs = ps.discover_sources(project)
        slugs = [s.slug for s in srcs]
        self.assertEqual(slugs, ["real-one"])


class DumpParseTest(unittest.TestCase):
    SAMPLE = (
        "# == @deepseek-ai/dsh-base\n"
        "- id: timer\n  name: '@deepseek-ai/cordis-plugin-timer'\n"
        "- id: hmr\n  name: '@deepseek-ai/cordis-plugin-hmr'\n  disabled: true\n"
        "  config:\n    root:\n      - .\n"
        "# == E:\\home\\profiles\\web\\cordis.patch.yml\n"
        "- id: conversation-summary\n  name: '@dsh-user/conversation-summary'\n"
        "  config:\n    absoluteBudgetTokens: 200000\n    mode: hint\n"
        "- id: toast\n  name: '@dsh-user/toast'\n  disabled: true\n"
    )

    def test_entries_and_layers(self) -> None:
        r = ps.parse_dump(self.SAMPLE)
        self.assertEqual(len(r.entries), 4)
        hmr = r.find("@deepseek-ai/cordis-plugin-hmr")
        assert hmr is not None and hmr.disabled
        self.assertEqual(hmr.layer, "bundle")
        cs = r.find("@dsh-user/conversation-summary")
        assert cs is not None and not cs.disabled
        self.assertEqual(cs.layer, "profile")


class GateFlowTest(unittest.TestCase):
    def test_structure_gate_writes_clone_only(self) -> None:
        home = make_home()
        probe = DumpGateProbe()
        text = ps.apply_managed("", [ps.ManagedRow(id="a")])
        r = ps.structure_gate(home, text, run_dump=probe)
        self.assertTrue(r.ok)
        self.assertEqual(len(probe.seen), 1)
        self.assertIn("id: a", probe.seen[0])
        # 真实 home 补丁未被触碰（未 commit）
        self.assertFalse(ps.web_patch(home).exists())

    def test_gate_failure_does_not_write(self) -> None:
        home = make_home()
        def failing(_p: Path) -> ps.DumpResult:
            return ps.DumpResult(ok=False, exit_code=1, warnings=("boom",))
        with self.assertRaises(ps.GateError):
            ps.structure_gate(home, ps.apply_managed("", [ps.ManagedRow(id="a")]),
                              run_dump=failing)
        self.assertFalse(ps.web_patch(home).exists())

    def test_commit_then_rollback(self) -> None:
        home = make_home()
        ps.commit_patch(home, "v1\n")
        self.assertEqual(ps.web_patch(home).read_text(encoding="utf-8"), "v1\n")
        # 第二次 commit 才产生含 v1 的 .bak
        ps.commit_patch(home, "v2\n")
        bak = ps.web_patch(home).with_name("cordis.patch.yml.bak")
        self.assertTrue(bak.exists())
        self.assertEqual(bak.read_text(encoding="utf-8"), "v1\n")
        self.assertTrue(ps.rollback_patch(home))
        self.assertEqual(ps.web_patch(home).read_text(encoding="utf-8"), "v1\n")


class OperationTest(unittest.TestCase):
    def _home_and_source(self, slug: str = "demo-app") -> tuple[Path, Path]:
        home = make_home()
        root = Path(tempfile.mkdtemp(prefix="src-"))
        make_plugin(root / "plugins", slug)
        return home, root

    def test_install_enable_disable(self) -> None:
        home, root = self._home_and_source()
        source = ps.discover_sources(root)[0]
        self.assertEqual(source.slug, "demo-app")
        probe = DumpGateProbe()
        led = ps.install(home, source, run_dump=probe)
        self.assertIsNotNone(led.row("demo-app"))
        self.assertTrue((ps.anchor_dir(home, "demo-app") / "lib" / "index.js").is_file())
        patch = ps.web_patch(home).read_text(encoding="utf-8")
        self.assertIn("- insert:\n    - id: demo-app", patch)
        # 重复安装拒绝
        with self.assertRaises(ps.PluginError):
            ps.install(home, source, run_dump=probe)
        # 停用/启用
        led = ps.set_enabled(home, "demo-app", False, run_dump=probe)
        self.assertTrue(led.row("demo-app").disabled)
        self.assertIn("      disabled: true\n",
                      ps.web_patch(home).read_text(encoding="utf-8"))
        led = ps.set_enabled(home, "demo-app", True, run_dump=probe)
        self.assertFalse(led.row("demo-app").disabled)
        self.assertNotIn("disabled: true",
                         ps.web_patch(home).read_text(encoding="utf-8"))

    def test_uninstall_removes_anchor_when_no_refs(self) -> None:
        home, root = self._home_and_source()
        source = ps.discover_sources(root)[0]
        probe = DumpGateProbe()
        ps.install(home, source, run_dump=probe)
        self.assertTrue(ps.anchor_dir(home, "demo-app").exists())
        led = ps.uninstall(home, "demo-app", run_dump=probe)
        self.assertIsNone(led.row("demo-app"))
        self.assertFalse(ps.anchor_dir(home, "demo-app").exists())
        # 管理段清空但标记保留（幂等无害）
        text = ps.web_patch(home).read_text(encoding="utf-8")
        self.assertNotIn("@dsh-user/demo-app", text)
        with self.assertRaises(ps.PluginError):
            ps.uninstall(home, "demo-app", run_dump=probe)  # 已不在台账

    def test_uninstall_keeps_anchor_on_external_reference(self) -> None:
        home = make_home()
        # 先造一个带管理段行 a 的补丁，同时段外也存在同名外部行
        text = ps.apply_managed(
            "- insert:\n    - id: a\n      name: '@dsh-user/a'\n",
            [ps.ManagedRow(id="a")])
        ps.commit_patch(home, text)
        ps.ledger_save(home, ps.Ledger(rows=(ps.ManagedRow(id="a"),)))
        anchor = ps.anchor_dir(home, "a")
        anchor.mkdir(parents=True)
        (anchor / "package.json").write_text("{}", encoding="utf-8")
        probe = DumpGateProbe()
        with self.assertRaises(ps.PluginError) as ctx:
            ps.uninstall(home, "a", run_dump=probe)
        self.assertIn("仍被引用", str(ctx.exception))
        self.assertTrue(anchor.exists())          # 保守保留

    def test_external_row_read_only_status(self) -> None:
        home = make_home()
        ps.commit_patch(home, (
            "- insert:\n    - id: lsp-echo\n      name: '@dsh-user/lsp-echo'\n"
            "- insert:\n    - id: time-context\n"
            "      name: '@deepseek-ai/dsh-time-context'\n"))
        dump = ps.parse_dump(
            "# == web\\cordis.patch.yml\n"
            "- id: lsp-echo\n  name: '@dsh-user/lsp-echo'\n"
            "- id: time-context\n  name: '@deepseek-ai/dsh-time-context'\n")
        cards = ps.status_view(home, [], dump)
        states = {c.name: c.state for c in cards}
        self.assertEqual(states["@dsh-user/lsp-echo"], "external")
        self.assertEqual(states["@deepseek-ai/dsh-time-context"], "first_party")

    def test_downloaded_source_status(self) -> None:
        home = make_home()
        root = Path(tempfile.mkdtemp())
        make_plugin(root / "plugins", "freshly-downloaded")
        sources = ps.discover_sources(root)
        cards = ps.status_view(home, sources, ps.parse_dump(""))
        self.assertEqual(cards[0].state, "downloaded")


class ReferenceScanTest(unittest.TestCase):
    def test_own_segment_not_self_reference(self) -> None:
        home = make_home()
        text = ps.apply_managed("", [ps.ManagedRow(id="zzz")])
        ps.commit_patch(home, text)
        hits = ps.reference_scan(home, "zzz")
        self.assertEqual(hits, [])

    def test_other_profile_reference_keeps(self) -> None:
        home = make_home()
        ps.commit_patch(home, ps.apply_managed("", [ps.ManagedRow(id="zzz")]))
        other = home / "profiles" / "headless" / "cordis.patch.yml"
        other.parent.mkdir(parents=True)
        other.write_text("name: '@dsh-user/zzz'\n", encoding="utf-8")
        hits = ps.reference_scan(home, "zzz")
        self.assertTrue(any(f.resolve() == other.resolve() for f in hits))


class HealthTest(unittest.TestCase):
    def test_health_markers(self) -> None:
        self.assertTrue(ps.health_ok("all good, http://127.0.0.1:3080"))
        self.assertFalse(ps.health_ok("boom: 3 entries did not activate"))
        self.assertFalse(ps.health_ok("fatal load failure"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
