# -*- coding: utf-8 -*-
"""dsh-offline-installer 离线插件包自检打包（v0.2）。

从插件源目录收集符合规范（package.json name == `@dsh-user/<目录名>`、
lib/index.js 存在、声明 dsh.client 时必须含 lib/client.js）的插件，打成
`assets/plugins.tar.gz`（gz 内为 `<目录名>/...`），随离线资产分发。

source.tar.gz 不可作为插件分发源（plugins/*/lib 为 git 忽略产物）。

用法：
  python pack_plugins.py --plugins <项目或插件根> --out assets/plugins.tar.gz
  python pack_plugins.py --plugins <根> --out assets/plugins.tar.gz --slug a --slug b

测试入口：select_plugins / build_archive / main 返回码。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path

import plugin_store as pstore

EXCLUDE_DIRS = {".git", "node_modules", "dist", "__pycache__", "tmp", ".dsh"}
EXCLUDE_SUFFIX = {".pyc", ".log", ".tsbuildinfo"}


@dataclass(frozen=True)
class PackResult:
    slug: str
    ok: bool
    errors: tuple[str, ...] = ()
    files: int = 0
    bytes: int = 0


def select_plugins(plugins_root: Path, slugs: tuple[str, ...] = ()) -> tuple[
        list[Path], list[tuple[str, str]]]:
    """返回 (合格插件目录, [(slug, 不合格原因), ...])；slugs 为空 = 全部。"""
    wanted = set(slugs)
    ok_dirs: list[Path] = []
    bad: list[tuple[str, str]] = []
    if not plugins_root.is_dir():
        return ok_dirs, [(s, "插件根目录不存在") for s in wanted] if wanted else \
            [(plugins_root.name, "插件根目录不存在")]
    for dir_ in sorted(plugins_root.iterdir()):
        if not dir_.is_dir() or not pstore.is_valid_slug(dir_.name):
            continue
        if not (dir_ / "package.json").exists():
            # 非插件目录（如 time-context 示例）；仅显式点名时报错
            if dir_.name in wanted:
                bad.append((dir_.name, "缺 package.json（非可打包插件）"))
            continue
        if wanted and dir_.name not in wanted:
            continue
        v = pstore.validate_package(dir_)
        if v.ok:
            ok_dirs.append(dir_)
        else:
            bad.append((dir_.name, "; ".join(v.errors)))
    for s in sorted(wanted - {d.name for d in ok_dirs} - {b[0] for b in bad}):
        bad.append((s, "未找到该目录"))
    return ok_dirs, bad


def _iter_pack_files(dir_: Path):
    for root, dirs, files in os.walk(dir_, followlinks=False):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            if f.endswith(tuple(EXCLUDE_SUFFIX)):
                continue
            yield Path(root) / f


def build_archive(plugins_root: Path, out: Path,
                  slugs: tuple[str, ...] = ()) -> list[PackResult]:
    """打包选定插件目录；不合格/缺失的记为 error（不中断其余）。返回逐插件结果。"""
    ok_dirs, bad = select_plugins(plugins_root, slugs)
    results = [PackResult(slug=s, ok=False, errors=(reason,)) for s, reason in bad]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    with tarfile.open(tmp, "w:gz") as tf:
        for dir_ in ok_dirs:
            files = list(_iter_pack_files(dir_))
            for f in files:
                tf.add(f, arcname=f"{dir_.name}/{f.relative_to(dir_).as_posix()}")
            size = sum(f.stat().st_size for f in files)
            results.append(PackResult(slug=dir_.name, ok=True,
                                      files=len(files), bytes=size))
    shutil.move(str(tmp), out)
    results.sort(key=lambda r: (not r.ok, r.slug))
    return results


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="打包插件离线资产（自检）")
    ap.add_argument("--plugins", required=True, help="插件源根目录（含各 <slug>/）")
    ap.add_argument("--out", required=True, help="输出 tar.gz 路径")
    ap.add_argument("--slug", action="append", default=None,
                    help="只打包指定 slug（可多次）；缺省=全部")
    args = ap.parse_args(argv)
    slugs = tuple(args.slug or ())
    results = build_archive(Path(args.plugins), Path(args.out), slugs)
    fail = 0
    for r in results:
        if r.ok:
            print(f"  ok   {r.slug:<28} {r.files:>3} 文件  {r.bytes / 1024:7.1f} KB")
        else:
            fail += 1
            print(f"  FAIL {r.slug:<28} {'; '.join(r.errors)}")
    print(f"打包结果：共 {len(results)} 项，{len(results) - fail} 合格，{fail} 不合格")
    print(f"输出：{args.out}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
