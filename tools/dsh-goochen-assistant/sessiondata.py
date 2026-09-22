# -*- coding: utf-8 -*-
"""会话数据的冷备份：**唯一**一个 git 救不回来的东西。

为什么单独做：代码坏了 `git reset --hard` 就回来了，依赖坏了重装就回来了；但
`~/.dsh/sessions` 里的会话日志只有一份——而 0.1.2 → 0.1.6 会把会话格式从 **v0 升到 v3**
（官方有迁移链，但迁移是**单向**的）。迁移失败、或者迁移完用了一阵才发现不对，
代码回滚救不了它。真机实测的体量：150 个文件 / 237.6 MB，最大单个文件 32.9 MB。

三条硬规矩：
  · 备份根**不能**放在被备份的目录里面（否则越备越大）——这种情况直接拒绝，不客气；
  · 目标盘剩余空间不够就拒绝：绝不允许"备份没成功还继续更新"；
  · 快照是**整份目录复制**（不做硬链接增量）：这个体量下，简单比聪明可靠。
"""
from __future__ import annotations

import json
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

HOME_ENV = "DSH_HOME"
BACKUP_ENV = "DSH_SESSION_BACKUP_DIR"
DEFAULT_KEEP = 3
KEEP_ENV = "DSH_SESSION_BACKUP_KEEP"
MANIFEST = "manifest.json"
# 会话之外，同样"丢了找不回来"的东西：凭据和设置。投影缓存($home/storages)只是缓存，
# 但很小(2.3 MB)且恢复后能省一次重建，一起带上。
EXTRA_FILES = (".credentials.yaml", "settings.yaml")
EXTRA_DIRS = ("storages",)


@dataclass
class Snapshot:
    """一份快照：目录、时间、体量。用于列表和"该删哪一份"。"""
    path: Path
    created_at: str = ""
    files: int = 0
    bytes: int = 0
    seconds: float = 0.0
    label: str = ""
    app_version: str = ""
    app_commit: str = ""
    parts: list[str] = field(default_factory=list)

    @property
    def size_text(self) -> str:
        return f"{self.bytes / 1024 / 1024:.1f} MB"


@dataclass
class BackupResult:
    ok: bool
    snapshot: Optional[Snapshot] = None
    error: str = ""
    pruned: list[str] = field(default_factory=list)
    note: str = ""


def default_home() -> Path:
    """DSH 的数据目录：`$DSH_HOME`，没设就是 `~/.dsh`。"""
    raw = os.environ.get(HOME_ENV, "").strip()
    return Path(raw) if raw else Path.home() / ".dsh"


def system_drive() -> str:
    """系统盘盘符（Windows 上是 `C:`）。只用来**提示**"放在系统盘上不太理想"。"""
    return (os.environ.get("SystemDrive") or "C:").lower()


def default_backup_root(install_dir: Optional[Path] = None) -> Path:
    """默认备份根：**和 DSH 安装目录同级**，也就是 `E:\\Deepseek\\dsh-backups` 这种位置。

    为什么不用 `~/.dsh` 同级：那是用户目录，通常就在系统盘上（C:）。备份是"数据没了才想起它"
    的东西，放在系统盘上，重装系统时正好一起没。装在哪里、备份就在哪块盘的旁边，更符合直觉。
    仍然可以用 `DSH_SESSION_BACKUP_DIR` 指定到别的盘或网盘目录。
    """
    raw = os.environ.get(BACKUP_ENV, "").strip()
    if raw:
        return Path(raw)
    if install_dir is not None:
        return Path(install_dir).parent / "dsh-backups"
    return default_home().parent / "dsh-backups"


def keep_count() -> int:
    """保留几份。默认 3 份：足够覆盖"上一次更新之前"这个场景，又不至于把盘塞满。"""
    raw = os.environ.get(KEEP_ENV, "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_KEEP
    except ValueError:
        return DEFAULT_KEEP


def dir_stats(path: Path) -> tuple[int, int]:
    """(文件数, 总字节)。取不到就算 0——调用方另有"源不存在"的判断，不靠这里说话。"""
    files = 0
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                files += 1
                total += p.stat().st_size
        except OSError:
            continue
    return files, total


def _inside(child: Path, parent: Path) -> bool:
    """child 是否在 parent 里面（含相等）。用绝对路径比，避免相对路径骗人。"""
    try:
        child_abs = child.resolve()
        parent_abs = parent.resolve()
    except OSError:
        child_abs, parent_abs = child.absolute(), parent.absolute()
    return child_abs == parent_abs or parent_abs in child_abs.parents


def _free_bytes(path: Path) -> int:
    """目标盘剩余空间。路径还不存在时往上看最近存在的父目录。"""
    probe = path
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return -1                      # 问不出来就别拦人，后面真失败会如实报


def snapshot(home: Optional[Path] = None, dest_root: Optional[Path] = None, *,
             keep: Optional[int] = None, label: str = "", app_version: str = "",
             app_commit: str = "", install_dir: Optional[Path] = None,
             log: Callable[[str], None] = lambda _m: None) -> BackupResult:
    """把 `home` 下的会话数据整体复制成一份带时间戳的快照，并清理旧快照。

    参数：
        home: DSH 数据目录，默认 `default_home()`。
        dest_root: 备份根，默认 `default_backup_root(install_dir)`（与安装目录同级）。
        keep: 保留份数，默认 `keep_count()`。
        label: 写到清单里的说明，例如"更新到 0.1.6 之前"。
        install_dir: DSH 安装目录；只用于算默认备份根，以及"别备进仓库里"这条检查。
    返回 BackupResult；失败时 error 说清原因，**绝不静默降级**。
    """
    home = Path(home) if home else default_home()
    install_dir = Path(install_dir) if install_dir else None
    dest_root = Path(dest_root) if dest_root else default_backup_root(install_dir)
    keep = keep_count() if keep is None else max(1, int(keep))
    sessions = home / "sessions"
    if not sessions.is_dir():
        return BackupResult(ok=False, error=f"找不到会话目录：{sessions}")
    # 备份根落在数据目录里 → 会把备份自己也备进去，越备越大，必须拦下
    if _inside(dest_root, home) or _inside(dest_root, sessions):
        return BackupResult(
            ok=False,
            error=(f"备份位置不能放在数据目录里面：{dest_root}\n"
                   f"（放在里面会把上次的备份也一起备进来，越备越大）\n"
                   f"换个地方，或用环境变量 {BACKUP_ENV} 指定。"))
    # 同理不能放进被更新的仓库里：那会让仓库凭空多出几百 MB 未跟踪文件，还可能被误提交
    if install_dir is not None and _inside(dest_root, install_dir):
        return BackupResult(
            ok=False,
            error=(f"备份位置不能放在仓库里面：{dest_root}\n"
                   f"（会把仓库塞满未跟踪文件，还容易被误提交）\n"
                   f"放在它**同级**的位置，或用环境变量 {BACKUP_ENV} 指定。"))

    parts = (["sessions"]
             + [n for n in EXTRA_FILES if (home / n).is_file()]
             + [d for d in EXTRA_DIRS if (home / d).is_dir()])
    files, total = dir_stats(sessions)
    for name in EXTRA_FILES:
        if (home / name).is_file():
            files += 1
            total += (home / name).stat().st_size
    for d in EXTRA_DIRS:
        if (home / d).is_dir():
            f, b = dir_stats(home / d)
            files += f
            total += b
    free = _free_bytes(dest_root)
    if free >= 0 and free < total * 1.1 + 32 * 1024 * 1024:
        return BackupResult(
            ok=False,
            error=(f"目标盘空间不够：需要约 {total / 1024 / 1024:.0f} MB，"
                   f"只剩 {free / 1024 / 1024:.0f} MB（{dest_root}）\n"
                   f"换个盘，或用环境变量 {BACKUP_ENV} 指定。"))

    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = dest_root / f"dsh-sessions-{stamp}"
    index = 0
    while target.exists():              # 同一秒里连点两次也不撞名
        index += 1
        target = dest_root / f"dsh-sessions-{stamp}-{index}"
    note = ""
    if str(dest_root)[:2].lower() == system_drive():
        # 只提示，不拦：系统盘的用户目录是绝大多数人的默认，硬拒绝会让功能不可用。
        note = (f"备份放在系统盘（{dest_root}）上，重装系统时可能一起丢；"
                f"想更稳就用环境变量 {BACKUP_ENV} 指到别的盘或网盘目录。")
        log(f"[会话备份] {note}")
    try:
        dest_root.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        log(f"[会话备份] 正在备份到 {target}（{files} 个文件 / {total / 1024 / 1024:.1f} MB）…")
        target.mkdir(parents=True)
        for part in parts:
            src = home / part
            dst = target / part
            if src.is_dir():
                shutil.copytree(src, dst)
            elif src.is_file():
                shutil.copy2(src, dst)
        seconds = time.monotonic() - started
        manifest = {
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": str(home),
            "parts": parts,
            "files": files,
            "bytes": total,
            "seconds": round(seconds, 1),
            "label": label,
            "appVersion": app_version,
            "appCommit": app_commit,
        }
        (target / MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        shutil.rmtree(target, ignore_errors=True)   # 半份快照比没有更坏：清掉
        return BackupResult(ok=False, error=f"备份没做成：{exc}")

    snap = Snapshot(path=target, created_at=manifest["createdAt"], files=files,
                    bytes=total, seconds=seconds, label=label,
                    app_version=app_version, app_commit=app_commit, parts=parts)
    log(f"[会话备份] ✓ 完成：{target}（{snap.size_text}，{seconds:.1f} 秒）")
    pruned = prune(dest_root, keep, log=log)
    return BackupResult(ok=True, snapshot=snap, pruned=pruned, note=note)


def list_snapshots(dest_root: Optional[Path] = None, *,
                   install_dir: Optional[Path] = None) -> list[Snapshot]:
    """列出已有快照，**新的在前**。读不出清单的目录也列出来（宁可让用户看见）。"""
    dest_root = Path(dest_root) if dest_root else default_backup_root(install_dir)
    if not dest_root.is_dir():
        return []
    out: list[Snapshot] = []
    for child in sorted(dest_root.glob("dsh-sessions-*")):
        if not child.is_dir():
            continue
        data: dict = {}
        man = child / MANIFEST
        if man.is_file():
            try:
                data = json.loads(man.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
        files = int(data.get("files") or 0)
        size = int(data.get("bytes") or 0)
        if not files and not size:
            files, size = dir_stats(child)
        out.append(Snapshot(path=child, created_at=str(data.get("createdAt") or ""),
                            files=files, bytes=size,
                            seconds=float(data.get("seconds") or 0.0),
                            label=str(data.get("label") or ""),
                            app_version=str(data.get("appVersion") or ""),
                            app_commit=str(data.get("appCommit") or ""),
                            parts=list(data.get("parts") or [])))
    out.sort(key=lambda s: (s.created_at, s.path.name), reverse=True)
    return out


def prune(dest_root: Optional[Path] = None, keep: Optional[int] = None, *,
          log: Callable[[str], None] = lambda _m: None) -> list[str]:
    """只留最近 `keep` 份，删掉更旧的。返回被删的目录名。"""
    dest_root = Path(dest_root) if dest_root else default_backup_root()
    keep = keep_count() if keep is None else max(1, int(keep))
    snaps = list_snapshots(dest_root)
    removed: list[str] = []
    for old in snaps[keep:]:
        try:
            shutil.rmtree(old.path)
            removed.append(old.path.name)
            log(f"[会话备份] 清理旧快照：{old.path.name}")
        except OSError as exc:
            log(f"[会话备份] 旧快照删不掉（不影响使用）：{old.path.name}（{exc}）")
    return removed


def restore(snapshot_dir: Path, home: Optional[Path] = None, *,
            log: Callable[[str], None] = lambda _m: None) -> tuple[bool, str]:
    """把一份快照复制回数据目录（覆盖同名文件）。返回 (成功, 说明)。

    **必须先把服务停掉再还原**：服务正在写会话日志时覆盖，只会得到半截数据。
    所以这里只负责复制，停服务的判断留给调用方（界面会挡一道）。
    """
    snapshot_dir = Path(snapshot_dir)
    home = Path(home) if home else default_home()
    if not snapshot_dir.is_dir():
        return False, f"找不到这份快照：{snapshot_dir}"
    parts = [p.name for p in snapshot_dir.iterdir() if p.name != MANIFEST]
    if not parts:
        return False, f"这份快照里没有可还原的内容：{snapshot_dir}"
    restored: list[str] = []
    for name in parts:
        src = snapshot_dir / name
        dst = home / name
        try:
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                home.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            restored.append(name)
        except OSError as exc:
            return False, f"还原 {name} 时出错：{exc}"
    log(f"[会话备份] ✓ 已还原：{'、'.join(restored)} → {home}")
    return True, f"已还原 {'、'.join(restored)} 到 {home}（重启服务后生效）"
