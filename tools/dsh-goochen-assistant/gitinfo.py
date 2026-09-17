# -*- coding: utf-8 -*-
"""用**真实的 git 命令**去认识 / 校验 / 取版本 / 查更新一个 DSH 安装目录。

为什么不用「读 `.git/config` 猜远端」：链接会被 `insteadOf` 重写、被 `includeIf`
条件包含、被 worktree/submodule 的 `gitdir:` 指针改道，只有 git 自己解析才准。
这里的每条结论都来自 git 命令的退出码与输出，不解析仓库文件。

代价：一次 `repo_info` 要跑 5~6 条 git（每条约 30ms，合计约 0.2s），
所以只用在「用户选定的那一个目录」上，**不参与扫盘**（扫盘仍用廉价的文件判定）。

只依赖标准库；所有函数在 git 缺失或目录不是仓库时返回结构化失败，不抛异常。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

#: 官方仓库名。fork 的远端链接里同样带着它，所以 fork 也认。
REPO_SLUG = "deepseek-harness"
GIT_MISSING = 127
GIT_TIMEOUT = 124
DEFAULT_TIMEOUT = 20
FETCH_TIMEOUT = 120
_UNIT = "\x1f"          # git --format 的字段分隔符（正常文本里不会出现）


def git_exe() -> Optional[str]:
    """可用的 git 可执行文件；没有则 None。"""
    try:
        return shutil.which("git")
    except Exception:  # noqa: BLE001
        return None


def run_git(args: Sequence[str], cwd: Optional[Path] = None, *,
            timeout: int = DEFAULT_TIMEOUT) -> tuple[int, str, str]:
    """跑一条 git，返回 `(退出码, stdout, stderr)`；不抛异常。"""
    exe = git_exe()
    if exe is None:
        return GIT_MISSING, "", "未检测到 git（请先安装 Git for Windows）"
    argv = [exe] + (["-C", str(cwd)] if cwd is not None else []) + list(args)
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return GIT_TIMEOUT, "", f"git 超时（{timeout} 秒）：{' '.join(args[:2])}"
    except OSError as exc:
        return 126, "", f"无法运行 git：{exc}"


def _first_line(text: str) -> str:
    return text.strip().splitlines()[0].strip() if text.strip() else ""


def _same_path(a: Path, b: Path) -> bool:
    """Windows 下大小写与斜杠写法都可能不同，统一比较。"""
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return str(a).replace("\\", "/").lower() == str(b).replace("\\", "/").lower()


@dataclass(frozen=True)
class RepoInfo:
    """一次 git 探测的结果；ok=False 时 error 说明原因，其余字段无意义。"""
    ok: bool
    root: Optional[Path] = None
    branch: str = ""
    commit: str = ""
    short: str = ""
    subject: str = ""
    committed_at: str = ""
    upstream: str = ""
    ahead: int = 0
    behind: int = 0
    dirty: int = 0
    remotes: dict[str, str] = field(default_factory=dict)
    version: str = ""
    shallow: bool = False
    error: str = ""

    @property
    def is_repo_root(self) -> bool:
        """该目录本身就是仓库根（而不是别的仓库里的子目录）。"""
        return self.ok and self.root is not None


def repo_info(path: Path) -> RepoInfo:
    """用 git 读取该目录的仓库信息（根、分支、提交、脏改动、远端、版本）。"""
    if not path.is_dir():
        return RepoInfo(ok=False, error=f"目录不存在：{path}")

    code, out, err = run_git(["rev-parse", "--show-toplevel"], path)
    if code != 0:
        return RepoInfo(ok=False, error=_first_line(err) or "不是一个 git 仓库")
    root = Path(_first_line(out))

    code, out, err = run_git(["rev-parse", "--abbrev-ref", "HEAD"], path)
    branch = _first_line(out) if code == 0 else ""

    commit = short = subject = committed_at = ""
    code, out, _ = run_git(
        ["log", "-1", f"--format=%H{_UNIT}%h{_UNIT}%s{_UNIT}%cI"], path)
    if code == 0 and out.strip():
        parts = out.strip().split(_UNIT)
        commit = parts[0] if len(parts) > 0 else ""
        short = parts[1] if len(parts) > 1 else ""
        subject = parts[2] if len(parts) > 2 else ""
        committed_at = parts[3] if len(parts) > 3 else ""

    dirty = 0
    code, out, _ = run_git(["status", "--porcelain"], path)
    if code == 0:
        dirty = len([ln for ln in out.splitlines() if ln.strip()])

    remotes: dict[str, str] = {}
    code, out, _ = run_git(["remote", "-v"], path)
    if code == 0:
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] not in remotes:
                remotes[parts[0]] = parts[1]

    upstream, ahead, behind = "", 0, 0
    code, out, _ = run_git(["rev-parse", "--is-shallow-repository"], path)
    shallow = code == 0 and _first_line(out) == "true"
    code, out, _ = run_git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], path)
    if code == 0 and out.strip():
        upstream = _first_line(out)
        # 浅克隆（线上安装用的 git clone --depth 1）里祖先关系被截断，
        # 两个方向都会把边界提交各算一次 → 数字不可信，索性不报（置 0）。
        if not shallow:
            code, out, _ = run_git(
                ["rev-list", "--left-right", "--count", "@{u}...HEAD"], path)
            if code == 0 and out.strip():
                nums = out.split()
                if len(nums) == 2:
                    behind, ahead = int(nums[0]), int(nums[1])  # 左=上游独有，右=本地独有

    return RepoInfo(ok=True, root=root, branch=branch, commit=commit, short=short,
                    subject=subject, committed_at=committed_at, upstream=upstream,
                    ahead=ahead, behind=behind, dirty=dirty, remotes=remotes,
                    version=_package_version(root), shallow=shallow)


def _package_version(root: Path) -> str:
    """仓库根 package.json 的 version（DSH 版本号）。"""
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return ""
    return str(data.get("version", "")) if isinstance(data, dict) else ""


def match_dsh_remote(remotes: dict[str, str]) -> str:
    """远端里哪个是 DSH 仓库（按仓库名匹配）。返回命中的 URL，没有则 ''。

    `git@host:org/deepseek-harness.git`、`https://host/org/deepseek-harness`、
    本地路径 `/srv/deepseek-harness.git` 都能识别；fork 因为仓库名不变，同样命中。
    """
    for url in remotes.values():
        name = url.rstrip("/").rsplit("/", 1)[-1].rstrip("/")
        if name.lower().endswith(".git"):
            name = name[:-4]
        if name.lower() == REPO_SLUG.lower():
            return url
    return ""


def verify_dsh_repo(path: Path, info: Optional[RepoInfo] = None) -> tuple[bool, str]:
    """用 git **确认**「这个目录就是 DSH 仓库根」。返回 `(是否确认, 说明)`。

    三条都要过：① 是 git 仓库 ② 该目录本身是仓库根 ③ 远端里有一个是 DSH。
    比读文件的判定强得多：链接怎么重写、条件包含、worktree 改道，git 都会解析正确。
    已经跑过 `repo_info` 的调用方可以把它传进来，省一次 git（每轮约 0.2 秒）。
    """
    info = info if info is not None else repo_info(path)
    if not info.ok:
        return False, info.error
    if info.root is None or not _same_path(info.root, path):
        return False, f"该目录不是 git 仓库根（仓库根是 {info.root}）"
    hit = match_dsh_remote(info.remotes)
    if not hit:
        urls = "、".join(info.remotes.values()) or "（没有配置远端）"
        return False, f"是 git 仓库根，但远端不是 DSH：{urls}"
    return True, f"git 确认 → {hit}"


@dataclass(frozen=True)
class UpdateStatus:
    """与远端的比较结果；behind>0 表示有更新可拉。"""
    ok: bool
    behind: int = 0
    ahead: int = 0
    branch: str = ""
    remote: str = ""
    latest: str = ""
    latest_subject: str = ""
    error: str = ""


def check_update(path: Path, *, remote: str = "origin") -> UpdateStatus:
    """`git fetch` 后比较本地 HEAD 与远端：behind>0 = 有更新。

    需要联网（这也是唯一会联网的函数）；远端不可达时返回结构化失败，不抛异常。
    """
    info = repo_info(path)
    if not info.ok:
        return UpdateStatus(ok=False, error=info.error)
    branch = info.branch
    if not branch or branch == "HEAD":
        return UpdateStatus(ok=False, error="处于分离头（detached HEAD）状态，无法判断更新")
    if remote not in info.remotes:
        return UpdateStatus(ok=False, branch=branch, remote=remote,
                            error=f"没有名为 {remote} 的远端")

    # 不带 --depth：带它会给本地仓库凭空加一个浅边界，把本来完整的祖先关系弄断
    code, _out, err = run_git(["fetch", remote, branch], path, timeout=FETCH_TIMEOUT)
    if code != 0:
        return UpdateStatus(ok=False, branch=branch, remote=remote,
                            error=f"git fetch 失败：{_first_line(err)}")

    code, out, _ = run_git(["rev-parse", "--short", "FETCH_HEAD"], path)
    latest = _first_line(out) if code == 0 else ""
    code, out, _ = run_git(["log", "-1", "--format=%s", "FETCH_HEAD"], path)
    subject = _first_line(out) if code == 0 else ""

    # 落后数用 `HEAD..FETCH_HEAD`：浅克隆里也准（数的是远端独有的提交）。
    # 领先数在浅克隆里会被边界提交污染，所以只在完整克隆上才报。
    behind = ahead = 0
    code, out, _ = run_git(["rev-list", "--count", "HEAD..FETCH_HEAD"], path)
    if code == 0 and out.strip():
        behind = int(out.strip().split()[0])
    code, out, _ = run_git(["rev-parse", "--is-shallow-repository"], path)
    shallow = code == 0 and _first_line(out) == "true"
    if not shallow:
        code, out, _ = run_git(["rev-list", "--count", "FETCH_HEAD..HEAD"], path)
        if code == 0 and out.strip():
            ahead = int(out.strip().split()[0])

    return UpdateStatus(ok=True, behind=behind, ahead=ahead, branch=branch,
                        remote=remote, latest=latest, latest_subject=subject)


@dataclass(frozen=True)
class UpdateResult:
    """一次更新的结果；changed=False 表示本来就是最新（不是失败）。"""
    ok: bool
    changed: bool = False
    before: str = ""
    after: str = ""
    subject: str = ""
    behind: int = 0
    error: str = ""


def update_repo(path: Path, *, remote: str = "origin") -> UpdateResult:
    """把安装目录**快进**到远端最新。只走 fast-forward，绝不产生合并提交。

    三道前置检查，任一不过就拒绝并说明原因，绝不硬来：
    ① 工作区必须干净——否则可能覆盖用户自己的改动；
    ② 必须在分支上、远端可达；
    ③ 「能不能快进」**交给 git 自己判断**（`merge --ff-only`），不自己数提交数：
       线上安装用的是 `git clone --depth 1`（浅克隆），祖先关系被截断，
       `rev-list` 两个方向都会把边界提交各算一次，自己算会误判成「有本地独有提交」而瞎拒绝；
       而 git 的合并机制在浅克隆里判断是准的。
    于是「已是最新」返回 `changed=False` 的成功，而不是失败。
    """
    info = repo_info(path)
    if not info.ok:
        return UpdateResult(ok=False, error=info.error)
    if info.dirty:
        return UpdateResult(ok=False, error=(
            f"工作区有 {info.dirty} 处本地改动；为避免覆盖你的改动，"
            "请先提交或撤销这些改动，再更新"))
    if not info.branch or info.branch == "HEAD":
        return UpdateResult(ok=False, error="处于分离头（detached HEAD）状态，无法更新")
    if remote not in info.remotes:
        return UpdateResult(ok=False, error=f"没有名为 {remote} 的远端")

    code, _out, err = run_git(["fetch", remote, info.branch], path,
                              timeout=FETCH_TIMEOUT)
    if code != 0:
        return UpdateResult(ok=False, error=f"git fetch 失败：{_first_line(err)}")

    behind = 0
    code, out, _ = run_git(["rev-list", "--count", "HEAD..FETCH_HEAD"], path)
    if code == 0 and out.strip():
        behind = int(out.strip().split()[0])
    if behind == 0:
        return UpdateResult(ok=True, changed=False, before=info.short, after=info.short)

    code, _out, err = run_git(["merge", "--ff-only", "FETCH_HEAD"], path)
    if code != 0:
        return UpdateResult(ok=False, behind=behind, error=(
            "不是快进关系（你本地可能有自己的提交），已中止，你的文件没有被改动。"
            f"git 说：{_first_line(err) or '无法快进'}"))
    code, out, _ = run_git(["rev-parse", "--short", "HEAD"], path)
    after = _first_line(out) if code == 0 else ""
    code, out, _ = run_git(["log", "-1", "--format=%s"], path)
    subject = _first_line(out) if code == 0 else ""
    return UpdateResult(ok=True, changed=True, before=info.short, after=after,
                        subject=subject, behind=behind)
