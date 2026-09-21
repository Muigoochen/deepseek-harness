# -*- coding: utf-8 -*-
"""插件「禁用/启用」的单元测试：文件级开关、bundle 开关、dsh 起不来时的兜底。

守的场景：某个插件与别的插件冲突、导致 dsh 根本启动不起来。这时结构门
（`dsh --profile web --dump-config`）也跑不了，用户仍然要能：
  ① 在插件页看到自己的插件行；
  ② 把其中一行禁用掉、再启用回来；
  ③ 对 bundle 做同样的开关（只改 dsh.profile.bundles，包文件保留）。
全部是纯文件操作，不联网、不跑 dsh、不碰真实用户目录。

运行（在 tools/dsh-goochen-assistant 下）：
  python -m unittest discover -s tests -p "test_*.py"
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import plugin_store as ps  # noqa: E402

#: 与真实机器上的形状一致：有注释、有 config 元素、有无 config 元素、有 @deepseek-ai 行
PATCH = """\
# Persistent enable: per-step clock context for this profile.
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
      config:
        timeZone: Asia/Shanghai
- insert:
    - id: toast
      name: '@dsh-user/toast'
- insert:
    - id: conversation-summary
      name: '@dsh-user/conversation-summary'
      config:
        absoluteBudgetTokens: 200000
        retainTokens: 30000
- insert:
    - id: already-off
      name: '@dsh-user/already-off'
      disabled: true
"""


class PatchRowParseTest(unittest.TestCase):
    def test_parses_ids_names_and_disabled_state(self):
        rows = ps.parse_patch_rows(PATCH)
        got = [(r.id, r.name, r.disabled) for r in rows]
        self.assertEqual(got, [
            ("time-context", "@deepseek-ai/dsh-time-context", False),
            ("toast", "@dsh-user/toast", False),
            ("conversation-summary", "@dsh-user/conversation-summary", False),
            ("already-off", "@dsh-user/already-off", True),
        ])

    def test_garbage_never_raises(self):
        """宽容解析：认不出的行跳过就好，不能因此让插件页打不开。"""
        self.assertEqual(ps.parse_patch_rows(""), [])
        self.assertEqual(ps.parse_patch_rows("::: not yaml :::\n  - id: x\n"), [])
        rows = ps.parse_patch_rows("- insert:\n    - id: ok\n      name: '@dsh-user/ok'\n")
        self.assertEqual([r.id for r in rows], ["ok"])


class ExternalRowSwitchTest(unittest.TestCase):
    """外部行（用户自己写的补丁行）：加/删 `disabled: true`，别的一律不碰。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-switch-"))
        self.home = self.tmp / "home"
        (self.home / "profiles" / "web").mkdir(parents=True)
        ps.web_patch(self.home).write_text(PATCH, encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _text(self) -> str:
        return ps.web_patch(self.home).read_text(encoding="utf-8")

    def test_disable_then_enable_restores_the_file_byte_for_byte(self):
        ps.set_row_enabled(self.home, "conversation-summary", enabled=False)
        text = self._text()
        self.assertIn(ps.SWITCH_START, text)
        self.assertIn("- id: conversation-summary\n  disabled: true\n", text,
                      "停用写成官方支持的顶层 id 覆盖行")
        self.assertIn("absoluteBudgetTokens: 200000", text, "用户原有的 config 原样保留")
        self.assertTrue(next(r for r in ps.parse_patch_rows(text)
                             if r.id == "conversation-summary").disabled)
        bak = ps.web_patch(self.home).with_name(ps.web_patch(self.home).name + ".bak")
        self.assertTrue(bak.exists(), "落盘前要留 .bak 备份")
        self.assertEqual(bak.read_text(encoding="utf-8"), PATCH, "备份 = 改动前的原文")

        ps.set_row_enabled(self.home, "conversation-summary", enabled=True)
        self.assertEqual(self._text(), PATCH, "启用回来应当与原文逐字节一致")

    def test_several_rows_can_be_disabled_at_once(self):
        ps.set_row_enabled(self.home, "toast", enabled=False)
        ps.set_row_enabled(self.home, "conversation-summary", enabled=False)
        state = ps.switch_state(self.home)
        self.assertEqual(state, {"toast": True, "conversation-summary": True})
        rows = {r.id: r for r in ps.parse_patch_rows(self._text())}
        self.assertTrue(rows["toast"].disabled and rows["conversation-summary"].disabled)
        self.assertFalse(rows["time-context"].disabled)

    def test_disable_is_idempotent(self):
        ps.set_row_enabled(self.home, "toast", enabled=False)
        once = self._text()
        ps.set_row_enabled(self.home, "toast", enabled=False)
        self.assertEqual(self._text(), once)

    def test_enable_a_row_that_is_disabled_in_its_own_element(self):
        """行自己写了 `disabled: true` 时，启用要写 `disabled: false` 把它压过去。"""
        ps.set_row_enabled(self.home, "already-off", enabled=True)
        rows = {r.id: r for r in ps.parse_patch_rows(self._text())}
        self.assertFalse(rows["already-off"].disabled)
        self.assertEqual(ps.switch_state(self.home), {"already-off": False})
        self.assertIn("      disabled: true", self._text(), "用户原来那行没被动过")

    def test_switch_block_stays_before_the_managed_segment(self):
        """管理段被要求位于文件末尾，开关段必须落在它前面，否则会被判为「段后有内容」。"""
        managed = ps.apply_managed(PATCH, (ps.ManagedRow(id="mine"),))
        ps.ledger_save(self.home, ps.Ledger(rows=(ps.ManagedRow(id="mine"),)))
        ps.web_patch(self.home).write_text(managed, encoding="utf-8")
        ps.set_row_enabled(self.home, "toast", enabled=False)
        text = self._text()
        self.assertLess(text.index(ps.SWITCH_START), text.index(ps.MANAGED_START))
        self.assertIsNotNone(ps.find_managed_span(text), "管理段仍须可解析")
        # 台账操作与开关段互不干扰
        ps.set_enabled(self.home, "mine", enabled=False, gate=False)
        after = self._text()
        self.assertIn(ps.SWITCH_START, after)
        self.assertEqual(ps.switch_state(self.home), {"toast": True})

    def test_unknown_id_and_managed_rows_are_refused(self):
        with self.assertRaises(ps.PluginError):
            ps.set_row_enabled(self.home, "nope", enabled=False)
        managed = ps.apply_managed(PATCH, (ps.ManagedRow(id="mine"),))
        ps.web_patch(self.home).write_text(managed, encoding="utf-8")
        self.assertTrue(any(r.managed for r in ps.parse_patch_rows(managed)))
        with self.assertRaises(ps.PluginError):
            ps.set_row_enabled(self.home, "mine", enabled=False)
        self.assertEqual(self._text(), managed, "拒改时文件必须一个字节都没动")

    def test_no_gate_is_run_by_default(self):
        """默认不跑结构门：dsh 起不来时正是靠这一点救急。"""
        with mock.patch.object(ps, "structure_gate",
                               side_effect=AssertionError("不该跑结构门")):
            ps.set_row_enabled(self.home, "toast", enabled=False)
        self.assertTrue(next(r for r in ps.parse_patch_rows(self._text())
                             if r.id == "toast").disabled)


class ManagedRowNoGateTest(unittest.TestCase):
    """台账行：`gate=False` 时不跑 dsh，但仍做本地形状自检。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-switch-"))
        self.home = self.tmp / "home"
        (self.home / "profiles" / "web").mkdir(parents=True)
        rows = (ps.ManagedRow(id="alpha"), ps.ManagedRow(id="beta"))
        ps.ledger_save(self.home, ps.Ledger(rows=rows))
        ps.web_patch(self.home).write_text(ps.apply_managed("", rows), encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_disable_without_dsh_and_without_gate(self):
        with mock.patch.object(ps, "structure_gate",
                               side_effect=AssertionError("应急路径不该跑结构门")), \
                mock.patch.object(ps, "_real_dump",
                                  side_effect=AssertionError("应急路径不该跑 dsh")):
            ps.set_enabled(self.home, "alpha", enabled=False, gate=False)
        row = ps.ledger_load(self.home).row("alpha")
        self.assertIsNotNone(row)
        self.assertTrue(row.disabled)
        self.assertIn("      disabled: true",
                      ps.web_patch(self.home).read_text(encoding="utf-8"))
        self.assertFalse(ps.ledger_load(self.home).row("beta").disabled)

    def test_gated_path_still_runs_the_gate(self):
        with mock.patch.object(ps, "structure_gate") as gate:
            ps.set_enabled(self.home, "alpha", enabled=False, gate=True,
                           run_dump=lambda _p: ps.DumpResult(ok=True, exit_code=0))
        self.assertTrue(gate.called, "默认路径仍要过结构门")

    def test_local_shape_check_rejects_a_broken_managed_segment(self):
        broken = ps.MANAGED_START + "\n- insert:\n    - id: alpha\n      name: 'wrong'\n" \
            + ps.MANAGED_END + "\n"
        with self.assertRaises(ps.ProtectedShapeError):
            ps.local_shape_check(broken)


class BundleSwitchTest(unittest.TestCase):
    """bundle 禁用/启用：只改 dsh.profile.bundles，依赖与包文件都留着。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-switch-"))
        self.home = self.tmp / "home"
        web = self.home / "profiles" / "web"
        web.mkdir(parents=True)
        self.manifest = {
            "name": "dsh-profile-web", "private": True,
            "dependencies": {"dshmarket": "^1.43.0", "dsh-lsp-actions": "^0.4.4"},
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base",
                                            "@deepseek-ai/dsh-web-app",
                                            "dshmarket", "dsh-lsp-actions"],
                                "patchReload": "live"}},
        }
        (web / "package.json").write_text(
            json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _bundles(self) -> list[str]:
        return ps.profile_manifest(self.home)["dsh"]["profile"]["bundles"]

    def test_disable_then_enable_puts_it_back_in_place(self):
        ps.bundle_set_enabled(self.home, "dshmarket", enabled=False)
        self.assertEqual(self._bundles(),
                         ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                          "dsh-lsp-actions"])
        self.assertEqual(ps.bundle_disabled(self.home), {"dshmarket": 2})
        self.assertIn("dshmarket", ps.profile_manifest(self.home)["dependencies"],
                      "依赖声明要保留，重新启用才不会去重装")

        ps.bundle_set_enabled(self.home, "dshmarket", enabled=True)
        self.assertEqual(self._bundles(), self.manifest["dsh"]["profile"]["bundles"],
                         "重新启用要插回原位置（组合顺序不能变）")
        self.assertEqual(ps.bundle_disabled(self.home), {})

    def test_builtin_and_unknown_are_refused(self):
        with self.assertRaises(ps.PluginError):
            ps.bundle_set_enabled(self.home, "@deepseek-ai/dsh-base", enabled=False)
        with self.assertRaises(ps.PluginError):
            ps.bundle_set_enabled(self.home, "ghost", enabled=True)

    def test_disabling_twice_and_enabling_twice_are_idempotent(self):
        for _ in range(2):
            ps.bundle_set_enabled(self.home, "dsh-lsp-actions", enabled=False)
        self.assertEqual(len(self._bundles()), 3)
        for _ in range(2):
            ps.bundle_set_enabled(self.home, "dsh-lsp-actions", enabled=True)
        self.assertEqual(self._bundles(), self.manifest["dsh"]["profile"]["bundles"])

    def test_broken_manifest_is_not_overwritten(self):
        ps._web_pkg_json(self.home).write_text("{ not json", encoding="utf-8")
        with self.assertRaises(ps.PluginError):
            ps.bundle_set_enabled(self.home, "dshmarket", enabled=False)
        self.assertEqual(ps._web_pkg_json(self.home).read_text(encoding="utf-8"),
                         "{ not json")


class OfflineListingTest(unittest.TestCase):
    """dsh 起不来（dump 为空）时，插件页仍要列出用户的插件行。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-switch-"))
        self.home = self.tmp / "home"
        (self.home / "profiles" / "web").mkdir(parents=True)
        ps.web_patch(self.home).write_text(PATCH, encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_local_rows_fill_in_when_the_dump_is_empty(self):
        cards = ps.status_view(self.home, [], ps.parse_dump(""),
                               local_rows=ps.patch_rows(self.home))
        by_slug = {c.slug: c for c in cards}
        self.assertIn("toast", by_slug)
        self.assertEqual(by_slug["toast"].state, "external")
        self.assertEqual(by_slug["already-off"].state, "external-disabled")
        self.assertEqual(by_slug["conversation-summary"].name,
                         "@dsh-user/conversation-summary")

    def test_without_local_rows_the_list_is_empty(self):
        self.assertEqual(ps.status_view(self.home, [], ps.parse_dump("")), [])


class PluginRowActionsTest(unittest.TestCase):
    """插件页动作表：外部行与 bundle 都要有「禁用/启用」，别只剩「卸载」。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-switch-"))
        self.home = self.tmp / "home"
        (self.home / "profiles" / "web").mkdir(parents=True)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _app():
        """只要动作表与合成逻辑：用桩对象调 App 的实现，不建窗口。"""
        import installer
        app = SimpleNamespace(market_updates={})
        for name in ("_merge_plugins", "_actions_for", "_managed_actions",
                     "_bundle_actions", "_state_display"):
            setattr(app, name, getattr(installer.App, name).__get__(app))
        app._plugin_rank = installer.App._plugin_rank
        app.STATE_CN = installer.App.STATE_CN
        app.STATE_COLOR = installer.App.STATE_COLOR
        return app

    @staticmethod
    def _card(slug: str, name: str, state: str):
        return ps.PluginCard(slug=slug, name=name, state=state, description="",
                             origin="external", installed_dir=None, source=None)

    def test_external_row_offers_disable_without_adopting_first(self):
        app = self._app()
        for state, want in (("external", "禁用"), ("external-disabled", "启用")):
            items = app._merge_plugins([self._card("toast", "@dsh-user/toast", state)], [])
            labels = [a[0] for a in app._actions_for(items[0])]
            self.assertEqual(labels, [want, "校验", "接管"], state)

    def test_first_party_external_row_has_no_adopt_button(self):
        """`@deepseek-ai/*` 的行谈不上接管，但照样能禁停（它也在用户补丁里）。"""
        app = self._app()
        card = self._card("time-context", "@deepseek-ai/dsh-time-context", "external")
        items = app._merge_plugins([card], [])
        self.assertEqual([a[0] for a in app._actions_for(items[0])], ["禁用", "校验"])

    def test_bundle_gets_disable_and_enable(self):
        app = self._app()
        entry = ps.MarketEntry(name="dshmarket", version="1.43.0", downloaded=True,
                               installed=True, builtin=False, spec="dshmarket",
                               local=None, description="")
        items = app._merge_plugins([], [entry], [], self.home)
        labels = [a[0] for a in app._actions_for(items[0])]
        self.assertIn("禁用", labels)
        self.assertIn("卸载", labels)
        self.assertNotIn("启用", labels)

        # 禁用后的样子：状态文件记着它，dsh.profile.bundles 里已经没有它了
        (self.home / "profiles" / "web" / ps.BUNDLE_STATE_FILE).write_text(
            json.dumps({"disabled": {"dshmarket": 2}}), encoding="utf-8")
        entry_off = ps.MarketEntry(name="dshmarket", version="1.43.0", downloaded=True,
                                   installed=False, builtin=False, spec="dshmarket",
                                   local=None, description="")
        items = app._merge_plugins([], [entry_off], [], self.home)
        self.assertEqual(items[0]["state"], "bundle-off")
        labels = [a[0] for a in app._actions_for(items[0])]
        self.assertEqual(labels, ["启用", "卸载"])

    def test_state_labels_are_readable(self):
        """状态词全页一套：本地插件与在线包都说「已启用／已停用」。"""
        app = self._app()
        entry = ps.MarketEntry(name="dshmarket", version="1", downloaded=True,
                               installed=False, builtin=False, spec="dshmarket",
                               local=None, description="")
        (self.home / "profiles" / "web" / ps.BUNDLE_STATE_FILE).write_text(
            json.dumps({"disabled": {"dshmarket": 0}}), encoding="utf-8")
        items = app._merge_plugins([], [entry], [], self.home)
        self.assertEqual(app._state_display(items[0])[0], "已停用")

        on = ps.MarketEntry(name="dshmarket", version="1", downloaded=True,
                            installed=True, builtin=False, spec="dshmarket",
                            local=None, description="")
        items = app._merge_plugins([], [on], [], self.home)
        self.assertEqual(app._state_display(items[0])[0], "已启用")
        ext = app._merge_plugins([self._card("toast", "@dsh-user/toast", "external")], [])
        self.assertEqual(app._state_display(ext[0])[0], "已启用")

    def test_source_label_separates_the_two_forms(self):
        """状态词一样，靠「来源」区分本地插件 / 在线包 / 内置清单。"""
        app = self._app()
        managed = app._merge_plugins([self._card("toast", "@dsh-user/toast", "enabled")], [])
        external = app._merge_plugins(
            [self._card("lsp-echo", "@dsh-user/lsp-echo", "external")], [])
        bundle = app._merge_plugins([], [ps.MarketEntry(
            name="dshmarket", version="1", downloaded=True, installed=True,
            builtin=False, spec="dshmarket", local=None, description="")], [], self.home)
        catalog = app._merge_plugins([], [], [{"slug": "toast", "description": "",
                                               "repo": "https://x/y"}])
        self.assertEqual(managed[0]["src_label"], "本地补丁·助手管理")
        self.assertEqual(external[0]["src_label"], "本地补丁·你写的")
        self.assertEqual(bundle[0]["src_label"], "在线包")
        self.assertEqual(catalog[0]["src_label"], "内置清单")

    def test_local_version_read_from_the_plugin_itself(self):
        """本地插件也显示版本号（以前永远是「—」），取自它自己的 package.json。"""
        src = self.tmp / "plugins" / "toast"
        src.mkdir(parents=True)
        (src / "package.json").write_text(
            json.dumps({"name": "@dsh-user/toast", "version": "0.7.3"}), encoding="utf-8")
        self.assertEqual(ps.local_plugin_version(self.home, "toast", src), "0.7.3")
        self.assertEqual(ps.local_plugin_version(self.home, "nope"), "")

    def test_package_sanity_does_not_demand_dsh_user_naming(self):
        """官方插件不叫 `@dsh-user/*`，用那条命名规则查它会得到假的「不通过」。"""
        pkg = self.tmp / "dsh-time-context"
        (pkg / "lib").mkdir(parents=True)
        (pkg / "lib" / "index.js").write_text("", encoding="utf-8")
        (pkg / "package.json").write_text(
            json.dumps({"name": "@deepseek-ai/dsh-time-context",
                        "main": "./lib/index.js"}), encoding="utf-8")
        self.assertTrue(ps.package_sanity(pkg).ok)
        self.assertFalse(ps.validate_package(pkg).ok)      # 老规则误报的正是这一条
        self.assertEqual(ps.package_name(pkg), "@deepseek-ai/dsh-time-context")
        (pkg / "lib" / "index.js").unlink()
        self.assertFalse(ps.package_sanity(pkg).ok)

    def test_first_party_row_can_be_disabled_too(self):
        """官方插件（如 time-context）也在用户补丁里，一样要给禁用按钮。"""
        app = self._app()
        card = self._card("time-context", "@deepseek-ai/dsh-time-context", "first_party")
        items = app._merge_plugins([card], [])
        self.assertEqual(items[0]["src_label"], "内置插件·你加的")
        self.assertEqual([a[0] for a in app._actions_for(items[0])], ["禁用", "校验"])
        card_off = self._card("time-context", "@deepseek-ai/dsh-time-context",
                              "first_party-disabled")
        items = app._merge_plugins([card_off], [])
        self.assertEqual([a[0] for a in app._actions_for(items[0])], ["启用", "校验"])


class AdoptReportTest(unittest.TestCase):
    """能不能接管要**事先**算清楚：带 config 的行接不了，按钮就不该给。

    用户实测过：点了【接管】像"什么都没发生"——一半原因是按钮先给了、点下去才报错，
    另一半原因是待办只写日志、界面上没有任何提示。
    """

    PATCH = (
        "- insert:\n"
        "    - id: toast\n"
        "      name: '@dsh-user/toast'\n"
        "- insert:\n"
        "    - id: lsp-echo\n"
        "      name: '@dsh-user/lsp-echo'\n"
        "      config:\n"
        "        projects:\n"
        "          - path: 'E:\\GodotProject\\xu_world'\n"
    )

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-adopt-"))
        self.home = self.tmp / "home"
        ps.web_patch(self.home).parent.mkdir(parents=True)
        ps.web_patch(self.home).write_text(self.PATCH, encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_clean_row_can_be_adopted_but_config_row_cannot(self):
        report = ps.adopt_report(self.home)
        self.assertEqual(report.get("toast"), "")
        self.assertIn("config", report.get("lsp-echo", ""))    # 原因要点明是 config
        self.assertTrue(report.get("lsp-echo"))

    def test_actions_hide_adopt_when_it_would_fail(self):
        app = PluginRowActionsTest._app()
        app.plugin_adoptable = {"lsp-echo": "元素含未知内容：'      config:'"}
        card = PluginRowActionsTest._card("lsp-echo", "@dsh-user/lsp-echo", "external")
        items = app._merge_plugins([card], [])
        self.assertEqual([a[0] for a in app._actions_for(items[0])], ["禁用", "校验"])

    def test_actions_keep_adopt_for_a_clean_row(self):
        app = PluginRowActionsTest._app()
        app.plugin_adoptable = {"toast": ""}
        card = PluginRowActionsTest._card("toast", "@dsh-user/toast", "external")
        items = app._merge_plugins([card], [])
        self.assertIn("接管", [a[0] for a in app._actions_for(items[0])])

    def test_missing_patch_reports_nothing_instead_of_raising(self):
        self.assertEqual(ps.adopt_report(self.tmp / "nohome"), {})


if __name__ == "__main__":
    unittest.main()
