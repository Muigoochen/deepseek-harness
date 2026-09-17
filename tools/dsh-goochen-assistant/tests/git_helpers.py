# -*- coding: utf-8 -*-
"""测试用的真 git 小工具：本地临时仓库，**不联网**。

放在独立模块而不是某个 `test_*.py` 里，是为了让 test_gitinfo 与 test_catalog
共用同一份（unittest discover 只收 `test_*.py`，所以本文件不会被当成测试执行）。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

#: 可用的 git；没装时各测试自行 skip。
GIT = shutil.which("git")
IDENT = ["-c", "user.email=test@example.com", "-c", "user.name=Test",
         "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def git(*args: str, cwd: Path) -> str:
    """跑一条 git（测试专用）：失败就抛，避免测试静默通过。"""
    if GIT is None:
        raise AssertionError("未安装 git")
    proc = subprocess.run([GIT, *IDENT, *args], cwd=str(cwd), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} 失败：{proc.stderr.strip()}")
    return proc.stdout


def make_repo(root: Path, *, message: str = "init",
              root_name: str = "@deepseek-ai/dsh-root",
              workspace: bool = True) -> Path:
    """造一个带 DSH 味道的 git 仓库（可换根包名、可去掉 pnpm-workspace.yaml）。"""
    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", cwd=root)
    (root / "package.json").write_text(
        json.dumps({"name": root_name, "version": "1.2.3"}), encoding="utf-8")
    if workspace:
        (root / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
    git("add", "-A", cwd=root)
    git("commit", "-q", "-m", message, cwd=root)
    return root


def write_pkg(root: Path, rel: str, name: str) -> Path:
    """在 root/rel 写一个只有 package.json 的包（用来造 `packages/core/*` 官方子包）。"""
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(
        json.dumps({"name": name, "version": "0.0.1"}), encoding="utf-8")
    return d


def add_remote(repo: Path, name: str, url: str) -> None:
    git("remote", "add", name, url, cwd=repo)
