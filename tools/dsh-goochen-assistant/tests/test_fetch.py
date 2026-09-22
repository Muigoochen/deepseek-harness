# -*- coding: utf-8 -*-
"""取件层（fetch.py）与安装链来源顺序的测试。

守的规矩：**离线包 → 国内镜像 → 官方源**，全失败才报错；进度只刷一行；失败不留半个文件。
真机踩过的坑：随包离线缓存缺包时，旧的 `install_deps` 直接判死（`--offline` 一把梭），
干净机器上必然装不完——现在必须降级去联网补包，并把缺的包补进随包缓存。
"""
from __future__ import annotations

import http.server
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import fetch as fetcher  # noqa: E402
import installer  # noqa: E402

#: 1 MB 的测试数据（够触发多次进度刷新）
PAYLOAD = bytes(range(256)) * 4096


class _Handler(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []
    mode = "ok"

    def log_message(self, *_args) -> None:      # 测试里不要 HTTP 日志
        pass

    def do_GET(self) -> None:                   # noqa: N802   （http.server 的接口）
        type(self).hits.append(self.path)
        if self.path == "/missing":
            self.send_error(404)
            return
        body = PAYLOAD
        if self.path == "/short":
            self.send_response(200)
            self.send_header("Content-Length", str(len(body) + 999))   # 故意谎报
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/slow":
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[: 1024])
            self.wfile.flush()
            import time
            time.sleep(5)                        # 卡住：模拟超时
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FetchTestBase(unittest.TestCase):
    def setUp(self) -> None:
        _Handler.hits = []
        _Handler.mode = "ok"
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def _report(self):
        lines: list[str] = []
        progress: list[str] = []
        return (fetcher.Reporter(lines.append, progress.append), lines, progress)


class OfflineFirstTest(FetchTestBase):
    def test_offline_asset_is_used_without_any_request(self):
        asset = self.dir / "node.msi"
        asset.write_bytes(b"offline")
        report, lines, _ = self._report()
        got = fetcher.fetch(self.dir / "out.msi",
                            [fetcher.Source("随包离线数据", path=asset),
                             fetcher.Source("国内镜像", f"{self.base}/ok")],
                            report=report)
        self.assertEqual(got, asset)
        self.assertEqual(_Handler.hits, [], "有离线包时绝不该发请求")
        self.assertTrue(any("随包离线数据" in line for line in lines), lines)

    def test_missing_offline_asset_falls_through_to_mirror(self):
        report, lines, _ = self._report()
        got = fetcher.fetch(self.dir / "out.msi",
                            [fetcher.Source("随包离线数据", path=self.dir / "nope.msi"),
                             fetcher.Source("国内镜像", f"{self.base}/ok")],
                            report=report)
        self.assertEqual(got.read_bytes(), PAYLOAD)
        self.assertTrue(any("不存在" in line for line in lines), lines)


class FallbackTest(FetchTestBase):
    def test_mirror_then_official(self):
        report, lines, _ = self._report()
        got = fetcher.fetch(self.dir / "out.tgz",
                            [fetcher.Source("国内镜像", f"{self.base}/missing"),
                             fetcher.Source("官方源", f"{self.base}/ok")],
                            report=report)
        self.assertEqual(got.read_bytes(), PAYLOAD)
        self.assertEqual(_Handler.hits, ["/missing", "/ok"], "应当先镜像、失败后换官方")
        joined = "\n".join(lines)
        self.assertIn("尝试国内镜像", joined)
        self.assertIn("✗ 国内镜像失败", joined)
        self.assertIn("换下一个来源", joined)
        self.assertIn("✓ 官方源下载完成", joined)

    def test_timeout_falls_back(self):
        report, lines, _ = self._report()
        got = fetcher.fetch(self.dir / "out.tgz",
                            [fetcher.Source("国内镜像", f"{self.base}/slow"),
                             fetcher.Source("官方源", f"{self.base}/ok")],
                            report=report, timeout=1.0)
        self.assertEqual(got.read_bytes(), PAYLOAD)
        self.assertIn("✗ 国内镜像失败", "\n".join(lines))

    def test_all_sources_fail_reports_every_reason(self):
        report, _, _ = self._report()
        with self.assertRaises(fetcher.FetchError) as ctx:
            fetcher.fetch(self.dir / "out.tgz",
                          [fetcher.Source("国内镜像", f"{self.base}/missing"),
                           fetcher.Source("官方源", f"{self.base}/short")],
                          report=report)
        message = str(ctx.exception)
        self.assertIn("国内镜像", message)
        self.assertIn("官方源", message)
        self.assertIn("大小不符", message)

    def test_failure_leaves_no_half_file(self):
        report, _, _ = self._report()
        with self.assertRaises(fetcher.FetchError):
            fetcher.fetch(self.dir / "out.tgz",
                          [fetcher.Source("官方源", f"{self.base}/short")],
                          report=report)
        leftovers = sorted(p.name for p in self.dir.iterdir())
        self.assertEqual(leftovers, [], f"失败后不该留下任何文件：{leftovers}")


class ProgressTest(FetchTestBase):
    def test_progress_is_refreshed_in_place_not_appended(self):
        report, lines, progress = self._report()
        fetcher.fetch(self.dir / "out.tgz",
                      [fetcher.Source("官方源", f"{self.base}/ok")], report=report)
        self.assertGreaterEqual(len(progress), 2, "1MB 应当刷新多次进度")
        self.assertTrue(all("下载中" in item for item in progress), progress[:3])
        # 关键：进度**不进日志**（否则会刷屏），日志里只有真正的行
        self.assertFalse(any("下载中" in line for line in lines), lines)
        self.assertTrue(any("下载完成" in line for line in lines), lines)

    def test_reporter_clears_the_progress_line_before_a_real_line(self):
        printed: list[str] = []
        with mock.patch("builtins.print",
                        lambda *a, **k: printed.append(str(a[0]) if a else "")):
            report = fetcher.Reporter(lambda _m: None)      # 无 GUI：走 \r 分支
            report.progress("  下载中 50%")
            report.line("正常日志")
        self.assertTrue(any("\r" in item for item in printed), printed)


class InstallDepsSourceOrderTest(unittest.TestCase):
    """⑤ 依赖安装：离线缓存不够时必须降级补包，而不是直接判死。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.project = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, *, mode: str, results: list[int]):
        logs: list[str] = []
        calls: list[list[str]] = []

        def fake_run_cli(argv, cwd=None, **kwargs):
            calls.append(list(argv))
            code = results[min(len(calls) - 1, len(results) - 1)]
            tail = b"A package is missing from the store" if code else b""
            return mock.Mock(returncode=code, stdout=tail, stderr=b"")

        engine = installer.Engine(mode, use_mirror=True, log=logs.append)
        with mock.patch.object(installer, "run_cli", fake_run_cli):
            if any(code == 0 for code in results):
                engine.install_deps(self.project)
            else:
                with self.assertRaises(installer.InstallError) as ctx:
                    engine.install_deps(self.project)
                return calls, logs, str(ctx.exception)
        return calls, logs, ""

    def test_cache_first_then_mirror_and_keeps_the_same_store(self):
        """"自动选择"下第一次是**缓存优先**（--prefer-offline），不是硬离线。

        真机实测：跨版本更新（0.1.2→0.1.6）时随包缓存必然缺新包（实测缺
        @yao-pkg/pkg-6.21.0），--offline 会直接以 ERR_PNPM_NO_OFFLINE_TARBALL 硬失败，
        三次尝试可能全废、用户白等一轮。缺的包本来就该联网补。
        """
        calls, logs, _ = self._run(mode="auto", results=[1, 0])
        self.assertEqual(len(calls), 2, calls)
        self.assertIn("--prefer-offline", calls[0])
        self.assertNotIn("--offline", calls[0], "不能硬离线：跨版本更新必然缺包")
        self.assertNotIn("--offline", calls[1])
        self.assertIn("--registry", calls[1])
        self.assertIn(installer.REGISTRY_MIRROR, calls[1])
        offline_store = calls[0][calls[0].index("--store-dir") + 1]
        mirror_store = calls[1][calls[1].index("--store-dir") + 1]
        self.assertEqual(offline_store, mirror_store,
                         "补包这次要用同一个 store，缺的包才会回填随包缓存")
        self.assertIn("换下一个来源", "\n".join(logs))

    def test_falls_back_to_official_registry_after_mirror(self):
        calls, logs, _ = self._run(mode="auto", results=[1, 1, 0])
        self.assertEqual(len(calls), 3, calls)
        self.assertIn(installer.REGISTRY_MIRROR, calls[1])
        self.assertIn(installer.REGISTRY_OFFICIAL, calls[2])

    def test_strict_offline_mode_never_goes_online(self):
        calls, _, message = self._run(mode="offline", results=[1])
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("--offline", calls[0])
        self.assertIn("所有来源都试过了", message)

    def test_reports_every_source_on_total_failure(self):
        calls, _, message = self._run(mode="auto", results=[1, 1, 1])
        self.assertEqual(len(calls), 3, calls)
        for name in ("随包缓存优先", "国内镜像", "官方源"):
            self.assertIn(name, message)


class PurgePermissionTest(unittest.TestCase):
    """真机那个 ABORTED_REMOVE_MODULES_DIR_NO_TTY：必须授权 pnpm 直接重建目录。

    pnpm 要把旧的 node_modules 清掉重建，而我们用管道捕获输出、stdin 接空设备（没有 TTY），
    它不敢自己动手就中止——三条来源全废在同一句话上。
    实测确认：`--confirm-modules-purge=false` 会报 Unknown option，
    正确写法是 `--config.confirmModulesPurge=false`（pnpm 11.7.0 与 11.25 都接受）。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.project = Path(self._tmp.name)
        self.store = self.project / "store"
        self.store.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _calls(self, modules_store: str = "") -> list[list[str]]:
        if modules_store:
            (self.project / "node_modules").mkdir(exist_ok=True)
            (self.project / "node_modules" / ".modules.yaml").write_text(
                '{"storeDir": "%s"}' % modules_store, encoding="utf-8")
        calls: list[list[str]] = []

        def fake(argv, cwd=None, **kwargs):
            calls.append(list(argv))
            return mock.Mock(returncode=0, stdout=b"", stderr=b"")

        engine = installer.Engine("auto", use_mirror=True, log=lambda _m: None)
        with mock.patch.object(installer, "run_cli", fake), \
                mock.patch.object(installer, "STORE_DIR", self.store):
            engine.install_deps(self.project, force=True)
        return calls

    def test_every_attempt_authorizes_the_purge(self):
        for call in self._calls():
            self.assertIn("--config.confirmModulesPurge=false", call,
                          "每条路都要带这个授权，否则无 TTY 时会中止")

    def test_store_dir_is_used_when_the_existing_tree_matches(self):
        calls = self._calls(modules_store=str(self.store))
        self.assertIn("--store-dir", calls[0], "同一份 store，照用")

    def test_store_dir_is_kept_when_the_existing_tree_differs(self):
        """现有 node_modules 来自别的 store 时**照样**指定随包 store。

        原来这里写的是"不一致就不指定 --store-dir"，代价是把『离线安装』整条路删空
        （不留任何来源），还报一句"随包缓存不存在"的**假消息**——缓存其实就在 assets/ 里。
        现在交给 pnpm 按需重建，无 TTY 那关由 --config.confirmModulesPurge=false 放行。
        """
        calls = self._calls(modules_store="E:\\.pnpm-store\\v11")
        self.assertIn("--store-dir", calls[0], "随包 store 照用，别把离线来源删掉")
        self.assertIn("--config.confirmModulesPurge=false", calls[0])


if __name__ == "__main__":
    unittest.main()
