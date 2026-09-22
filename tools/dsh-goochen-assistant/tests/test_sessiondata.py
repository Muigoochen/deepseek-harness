# -*- coding: utf-8 -*-
"""会话数据的冷备份：唯一一个 git 救不回来的东西。

真机体量：150 个文件 / 237.6 MB（最大单个 32.9 MB）。这里用小目录跑同一条代码路径，
重点验四条：整份复制、拒绝把备份放进数据目录、保留份数、还原。
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

import sessiondata as sd  # noqa: E402


def make_home(root: Path) -> Path:
    """造一个像 `~/.dsh` 的数据目录：会话 + 凭据 + 设置 + 一点点缓存。"""
    home = root / ".dsh"
    (home / "sessions" / "--E-proj--" / "session-aaa").mkdir(parents=True)
    (home / "sessions" / "--E-proj--" / "session-aaa" / "session.jsonl.zstd").write_bytes(b"x" * 2048)
    (home / "sessions" / "--E-proj--" / "session-bbb").mkdir(parents=True)
    (home / "sessions" / "--E-proj--" / "session-bbb" / "session.jsonl.zstd").write_bytes(b"y" * 512)
    (home / ".credentials.yaml").write_text("token: secret\n", encoding="utf-8")
    (home / "settings.yaml").write_text("a: 1\n", encoding="utf-8")
    (home / "storages" / "session_projcache").mkdir(parents=True)
    (home / "storages" / "session_projcache" / "s.json").write_text("{}", encoding="utf-8")
    return home


class SnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-sess-"))
        self.home = make_home(self.tmp)
        self.dest = self.tmp / "backups"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_copies_sessions_credentials_and_settings(self):
        res = sd.snapshot(self.home, self.dest, keep=3, label="更新到 0.1.6 之前",
                          app_version="0.1.2-alpha.3", app_commit="abc1234")
        self.assertTrue(res.ok, res.error)
        snap = res.snapshot
        self.assertIsNotNone(snap)
        # 会话日志一个不少（含子目录结构）
        copied = snap.path / "sessions" / "--E-proj--" / "session-aaa" / "session.jsonl.zstd"
        self.assertEqual(copied.read_bytes(), b"x" * 2048)
        # 凭据和设置也在：它们同样"丢了找不回来"
        self.assertTrue((snap.path / ".credentials.yaml").is_file())
        self.assertTrue((snap.path / "settings.yaml").is_file())
        self.assertTrue((snap.path / "storages").is_dir())
        self.assertGreaterEqual(snap.bytes, 2560)
        # 清单可读，且记下了"这是更新到哪一版之前备份的"
        man = json.loads((snap.path / sd.MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(man["label"], "更新到 0.1.6 之前")
        self.assertEqual(man["appVersion"], "0.1.2-alpha.3")
        self.assertIn("sessions", man["parts"])

    def test_refuses_to_put_the_backup_inside_the_data_dir(self):
        """备份放进数据目录里 → 下次会把上次的备份也备进来，越备越大。必须拒绝。"""
        res = sd.snapshot(self.home, self.home / "sessions" / "backups")
        self.assertFalse(res.ok)
        self.assertIn("不能放在数据目录里面", res.error)

    def test_refuses_when_sessions_are_missing(self):
        empty = self.tmp / "empty-home"
        empty.mkdir()
        res = sd.snapshot(empty, self.dest)
        self.assertFalse(res.ok, "没有会话目录就说清楚，不要假装备份成功")
        self.assertIn("找不到会话目录", res.error)

    def test_keeps_only_the_newest_n(self):
        for _ in range(3):
            res = sd.snapshot(self.home, self.dest, keep=2)
            self.assertTrue(res.ok, res.error)
        left = sd.list_snapshots(self.dest)
        self.assertEqual(len(left), 2, f"只该留 2 份，实际 {[s.path.name for s in left]}")
        for snap in left:                      # 留下的必须是完整的，不是空壳
            self.assertTrue((snap.path / "sessions").is_dir())
            self.assertTrue((snap.path / sd.MANIFEST).is_file())

    def test_list_is_newest_first(self):
        sd.snapshot(self.home, self.dest, keep=9)
        sd.snapshot(self.home, self.dest, keep=9)
        snaps = sd.list_snapshots(self.dest)
        self.assertEqual(len(snaps), 2)
        self.assertGreaterEqual(snaps[0].path.name, snaps[1].path.name)

    def test_restore_brings_the_files_back(self):
        res = sd.snapshot(self.home, self.dest)
        self.assertTrue(res.ok, res.error)
        victim = self.home / "sessions" / "--E-proj--" / "session-aaa" / "session.jsonl.zstd"
        victim.unlink()                        # 模拟"迁移把会话弄坏了"
        (self.home / ".credentials.yaml").unlink()
        ok, detail = sd.restore(res.snapshot.path, self.home)
        self.assertTrue(ok, detail)
        self.assertEqual(victim.read_bytes(), b"x" * 2048)
        self.assertTrue((self.home / ".credentials.yaml").is_file())

    def test_restore_rejects_a_snapshot_without_content(self):
        empty = self.dest / "dsh-sessions-empty"
        empty.mkdir(parents=True)
        ok, detail = sd.restore(empty, self.home)
        self.assertFalse(ok)
        self.assertIn("没有可还原的内容", detail)


class DefaultRootTest(unittest.TestCase):
    """默认备份位置：与 DSH **安装目录同级**，不是用户目录，也不是仓库里面。

    用户提的：默认放在 C 盘用户目录下不合适——那是系统盘，重装系统时备份会一起没。
    仍然可以用 `DSH_SESSION_BACKUP_DIR` 指定到别的盘或网盘目录。
    """

    def setUp(self) -> None:
        self._old = os.environ.pop(sd.BACKUP_ENV, None)

    def tearDown(self) -> None:
        os.environ.pop(sd.BACKUP_ENV, None)
        if self._old is not None:
            os.environ[sd.BACKUP_ENV] = self._old

    def test_default_is_next_to_the_install_dir(self):
        repo = Path(r"E:\Deepseek\deepseek_harness")
        root = sd.default_backup_root(repo)
        self.assertEqual(root, Path(r"E:\Deepseek\dsh-backups"))
        self.assertFalse(sd._inside(root, repo), "备份不能落在仓库里面")

    def test_env_var_still_wins(self):
        os.environ[sd.BACKUP_ENV] = r"D:\我的备份"
        self.assertEqual(sd.default_backup_root(Path(r"E:\Deepseek\deepseek_harness")),
                         Path(r"D:\我的备份"))

    def test_refuses_a_backup_root_inside_the_repo(self):
        tmp = Path(tempfile.mkdtemp(prefix="dsh-inside-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        home = make_home(tmp)
        repo = tmp / "harness"
        repo.mkdir()
        res = sd.snapshot(home, repo / "dsh-backups", install_dir=repo)
        self.assertFalse(res.ok, "放进仓库会把仓库塞满未跟踪文件，必须拒绝")
        self.assertIn("不能放在仓库里面", res.error)

    def test_notes_when_the_backup_lands_on_the_system_drive(self):
        tmp = Path(tempfile.mkdtemp(prefix="dsh-sysdrive-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        home = make_home(tmp)
        res = sd.snapshot(home, tmp / "backups")
        self.assertTrue(res.ok, res.error)
        if str(res.snapshot.path)[:2].lower() == sd.system_drive():
            self.assertIn("系统盘", res.note, "落在系统盘要如实提示")
        else:
            self.assertEqual(res.note, "", "不在系统盘就别多嘴")


if __name__ == "__main__":
    unittest.main()
