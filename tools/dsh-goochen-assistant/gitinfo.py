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
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

import childproc

#: 官方仓库：**owner 与仓库名都对得上**才算官方（已用 `git ls-remote` 确认该仓库存在）。
OFFICIAL_OWNER = "deepseek-ai"
REPO_SLUG = "deepseek-harness"
OFFICIAL_REPO = f"{OFFICIAL_OWNER}/{REPO_SLUG}"
GIT_MISSING = 127
GIT_TIMEOUT = 124
DEFAULT_TIMEOUT = 20
FETCH_TIMEOUT = 120
#: `ls-remote` 只取引用、不拉历史，几秒就能回来（实测官方 5.8 秒）。给足余量，但不让它拖住界面。
LS_REMOTE_TIMEOUT = 45
# 官方那条路要先花几秒 `ls-remote` 探活：真机实测连不上 github 时，全量 fetch 会一直挂到
# 超时（十分钟都不返回），用户看到的就是"更新卡死"。探不到就直接说清楚，不耗着。
GIT_FETCH_TIMEOUT = 600
# 撤销（merge --abort / rebase --abort）是本地操作，但目录可能有 node_modules，给宽一点
GIT_UNDO_TIMEOUT = 120
#: 官方发布 tag 的前缀：`dsh-v0.1.6-alpha.2` → 版本号 `0.1.6-alpha.2`。
OFFICIAL_TAG_PREFIX = "dsh-v"
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
        # 经 childproc 跑：句柄登记在册，关窗时能连同子孙一起结束（fetch 可能跑很久）
        proc = childproc.run(argv, text=True, encoding="utf-8", timeout=timeout)
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
    status_ok: bool = True     # git status 本身跑成功了没；查不出来 ≠ 干净，不能当没事
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
    status_ok = True
    code, out, _ = run_git(["status", "--porcelain"], path)
    if code == 0:
        dirty = len([ln for ln in out.splitlines() if ln.strip()])
    else:
        # 查不出来**不等于干净**。以前这里静默当成 0，结果是 git status 一失败
        # （超时、索引被锁）后面的更新就以为工作区是干净的，可能直接覆盖别人的改动。
        status_ok = False

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
                    ahead=ahead, behind=behind, dirty=dirty, status_ok=status_ok,
                    remotes=remotes, version=_package_version(root), shallow=shallow)


def _package_version(root: Path) -> str:
    """仓库根 package.json 的 version（DSH 版本号）。"""
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return ""
    return str(data.get("version", "")) if isinstance(data, dict) else ""


def split_remote(url: str) -> tuple[str, str]:
    """把远端 URL 拆成 `(owner, 仓库名)`；拆不出 owner（本地路径）时给空串。

    `git@github.com:org/repo.git`、`https://github.com/org/repo`、
    `ssh://git@host/org/repo` 都能拆对；`E:/x/repo` 这类本地路径只给仓库名。
    只认 git 报出来的 URL，所以 `insteadOf` 重写与 `includeIf` 都已经生效过了。
    """
    text = url.strip().rstrip("/")
    if text.lower().endswith(".git"):
        text = text[:-4]
    if "://" in text:
        parts = [p for p in text.split("://", 1)[1].split("/") if p]
        return (parts[-2] if len(parts) >= 3 else ""), (parts[-1] if parts else "")
    if re.match(r"^[^/\\]+@[^/\\]+:", text):          # scp 风格 git@host:org/repo
        parts = [p for p in text.split(":", 1)[1].split("/") if p]
        return (parts[-2] if len(parts) >= 2 else ""), (parts[-1] if parts else "")
    parts = [p for p in text.replace("\\", "/").split("/") if p]
    return "", (parts[-1] if parts else "")


def official_remote(remotes: dict[str, str]) -> str:
    """远端里指向**官方仓库**的那个（owner 与仓库名都要对得上）。没有则 ''。"""
    for url in remotes.values():
        owner, repo = split_remote(url)
        if owner.lower() == OFFICIAL_OWNER and repo.lower() == REPO_SLUG.lower():
            return url
    return ""


def unofficial_remote(remotes: dict[str, str]) -> str:
    """仓库名对得上、但 owner 不是官方的远端（自己的 fork、镜像、本地克隆）。没有则 ''。"""
    for url in remotes.values():
        owner, repo = split_remote(url)
        if repo.lower() == REPO_SLUG.lower() and owner.lower() != OFFICIAL_OWNER:
            return url
    return ""


@dataclass(frozen=True)
class DshIdentity:
    """一次身份判定的结论。tier 表示依据的强弱，界面据此显示不同颜色。

    official   远端就是**官方仓库**（最强依据）
    unofficial 仓库名对得上，但不是官方（自己账户下的 fork / 镜像 / 本地克隆）
    file       没有 `.git` 或 git 认不出来，靠文件判定（离线安装）
    none       认不出来
    """
    ok: bool
    tier: str = "none"
    evidence: str = ""


def verify_dsh_repo(path: Path, info: Optional[RepoInfo] = None) -> DshIdentity:
    """用 git **确认**「这个目录就是 DSH 仓库根」。

    三条都要过：① 是 git 仓库 ② 该目录本身是仓库根 ③ 远端里有 DSH。
    远端分两档：**官方仓库**最强；仓库名对得上的非官方远端（你自己账户下的 fork、
    镜像、本地克隆）也算 DSH，但会**明确说出它不在官方名下**，绝不冒名顶替。
    已经跑过 `repo_info` 的调用方可以把它传进来，省一次 git（每轮约 0.2 秒）。
    """
    info = info if info is not None else repo_info(path)
    if not info.ok:
        return DshIdentity(False, "none", info.error)
    if info.root is None or not _same_path(info.root, path):
        return DshIdentity(False, "none", f"该目录不是 git 仓库根（仓库根是 {info.root}）")
    official = official_remote(info.remotes)
    if official:
        return DshIdentity(True, "official", f"官方仓库 {official}")
    same_name = unofficial_remote(info.remotes)
    if same_name:
        return DshIdentity(True, "unofficial",
                           f"非官方远端 {same_name}"
                           f"（仓库名对得上，但官方是 {OFFICIAL_REPO}）")
    urls = "、".join(info.remotes.values()) or "（没有配置远端）"
    return DshIdentity(False, "none", f"是 git 仓库根，但远端不是 DSH：{urls}")


def official_remote_name(remotes: dict[str, str]) -> str:
    """远端**名**里指向官方仓库的那个（没有则 ''）；判断标准与 `official_remote` 一致。

    有多个官方远端时优先取字面叫 `upstream` 的那个——它是 git 自己的习惯叫法，最稳。
    """
    found = ""
    for name, url in remotes.items():
        owner, repo = split_remote(url)
        if owner.lower() == OFFICIAL_OWNER and repo.lower() == REPO_SLUG.lower():
            if name == "upstream":
                return name
            found = found or name
    return found


def _digits(text: str) -> int:
    """只把**ASCII 十进制**当数字。

    `'²'.isdigit()` 是真，但 `int('²')` 会抛 ValueError——官方 tag 里真出现这种字符时，
    整个"检查更新"就会以 Python 内部错误收场（审查时实测过）。
    """
    return int(text) if text.isascii() and text.isdigit() else 0


def version_key(text: str) -> tuple:
    """把版本号排成可比较的键（越大越新）。

    `0.1.6` > `0.1.6-rc.2` > `0.1.6-beta.1` > `0.1.6-alpha.10` > `0.1.6-alpha.2`：
    正式版最大，预发布里 rc > beta > alpha，同档比序号（所以 alpha.10 > alpha.2，不是按字符串比）。
    `+build` 元数据不参与比较；**不认识的**预发布名（dev/preview/nightly…）排在 alpha 之下——
    官方真发什么名字我们不知道，但把它当成比 rc 还新，会让"官方已到 X"这种结论报出错的版本。
    """
    raw = text.strip().split("+", 1)[0]
    core, _, pre = raw.partition("-")
    nums = tuple(_digits(part) for part in core.split("."))
    if not pre:
        return (nums, 1, (0, 0))
    rank = {"alpha": 0, "beta": 1, "rc": 2}
    name, _, number = pre.partition(".")
    return (nums, 0, (rank.get(name, -1), _digits(number)))


@dataclass(frozen=True)
class OfficialStatus:
    """官方仓库现在是什么版本——**只取引用，不拉历史**。

    真机实测：直连官方 `git fetch` 十分钟都没返回（网络环境所致），而 `ls-remote`
    5.8 秒就回来。检查更新不能让用户干等，更不能卡住界面，所以官方这一路只走 ls-remote：
    标签告诉我们最新版本号，分支头告诉我们官方到哪个提交。
    """
    ok: bool = False
    remote: str = ""
    url: str = ""
    version: str = ""          # 最新官方标签的版本号，如 0.1.6-alpha.2
    tag: str = ""              # 原始标签名，如 dsh-v0.1.6-alpha.2
    branch: str = ""           # 官方默认分支
    head: str = ""             # 该分支头（短 hash）
    behind: int = 0            # 本地离官方那个分支还差几个提交（本地有该引用时才数得出来）
    error: str = ""


def official_status(info: RepoInfo, *,
                    timeout: int = LS_REMOTE_TIMEOUT) -> OfficialStatus:
    """问官方远端"最新是什么版本"（`ls-remote`，廉价的只读探测）。"""
    name = official_remote_name(info.remotes)
    if not name:
        return OfficialStatus(error="没有配置官方远端，无法核对官方版本")
    url = info.remotes[name]
    # cwd 必须给：这里传的是**远端名**（upstream），git 要站在目标目录里才解析得对。
    # 少了这个 cwd，打包运行时（当前目录不是仓库）会直接失败、界面就变成"已是最新"；
    # 当前目录恰好是另一个也有 upstream 的仓库时，更会拿**别人的 tag** 当官方版本。
    code, out, err = run_git(["ls-remote", "--tags", name], info.root, timeout=timeout)
    if code != 0:
        return OfficialStatus(remote=name, url=url,
                              error=f"ls-remote 失败：{_first_line(err) or code}")
    best_tag = best_version = ""
    for line in out.splitlines():
        if "refs/tags/" not in line:
            continue
        tag = line.split("refs/tags/", 1)[1].strip()
        if tag.endswith("^{}") or not tag.startswith(OFFICIAL_TAG_PREFIX):
            continue
        version = tag[len(OFFICIAL_TAG_PREFIX):]
        if not best_version or version_key(version) > version_key(best_version):
            best_tag, best_version = tag, version
    branch = head = ""
    for candidate in ("master", "main"):
        code, out, _ = run_git(["ls-remote", name, f"refs/heads/{candidate}"],
                               info.root, timeout=timeout)
        if code == 0 and out.strip():
            branch, head = candidate, out.split()[0][:7]
            break
    # 本地已经有官方那个分支的引用（之前取过）时，顺手数一下差多少提交——用户最想看到的
    # 就是这个数。浅克隆里数出来是骗人的，所以浅克隆不数。
    behind = 0
    if branch and not info.shallow:
        code, out, _ = run_git(["rev-list", "--count", f"HEAD..{name}/{branch}"],
                               info.root, timeout=timeout)
        if code == 0 and out.strip():
            behind = int(out.strip().split()[0])
    return OfficialStatus(ok=True, remote=name, url=url, version=best_version,
                          tag=best_tag, branch=branch, head=head, behind=behind)


def tracking_remote(info: RepoInfo) -> str:
    """分支跟踪的远端名（`@{u}` 的第一段）；没有跟踪就回退 origin。

    检查更新/更新默认跟着它走：小白装的 origin 通常就是官方；开发机上分支可能
    跟踪自己的 fork，那就该跟自己的 fork 比——**不硬编码 origin**。
    """
    if info.upstream and "/" in info.upstream:
        return info.upstream.split("/", 1)[0]
    return "origin"


@dataclass(frozen=True)
class UpdateStatus:
    """与远端的比较结果；behind>0 表示有更新可拉。

    `behind` 是相对**本分支跟踪的那个远端**的：开发机上它常常是你自己的 fork，
    所以 `behind=0` 只说明"你的 fork 没有新东西"，**不等于官方没出新版本**。
    官方那一侧由 `official_status` 独立核对，两者必须一起看——只看 behind 就会把
    "fork 同步"误报成"产品已是最新"（真机就是这么错报的）。
    """
    ok: bool
    behind: int = 0
    ahead: int = 0
    branch: str = ""
    remote: str = ""
    upstream: str = ""
    remote_url: str = ""
    official: bool = False
    latest: str = ""
    latest_subject: str = ""
    version: str = ""
    official_status: Optional[OfficialStatus] = None
    error: str = ""


def check_update(path: Path, *, remote: str = "", official: bool = True) -> UpdateStatus:
    """先跟**本分支跟踪的远端**比，再**独立核对官方**——两件事都得做。

    只跟 `@{u}` 比是不够的：开发机上分支常常跟踪自己的 fork，于是 `behind=0` 只说明
    "你的 fork 没有新东西"，很容易被读成"产品已是最新"（真机实测：本地 0.1.2-alpha.3、
    官方已到 0.1.6-alpha.2，界面却显示"✓ 已是最新"）。所以这里再问一次官方——
    用 `ls-remote`（只取引用）而不是 fetch：直连官方全量 fetch 在这类网络环境下十分钟
    都不返回，`ls-remote` 却只要几秒。
    需要联网；失败返回结构化结果，不抛异常。
    """
    info = repo_info(path)
    if not info.ok:
        return UpdateStatus(ok=False, error=info.error)
    branch = info.branch
    if not branch or branch == "HEAD":
        return UpdateStatus(ok=False, version=info.version,
                            error="处于分离头（detached HEAD）状态，无法判断更新")
    remote = remote or tracking_remote(info)
    if remote not in info.remotes:
        return UpdateStatus(ok=False, branch=branch, remote=remote, version=info.version,
                            error=f"没有名为 {remote} 的远端")
    url = info.remotes[remote]
    is_official = official_remote({remote: url}) == url

    # 官方那一半**先做、而且独立做**：它只花几秒（ls-remote 取引用），而且就算下面跟踪
    # 远端的 fetch 失败（断网、超时、权限），用户至少还能看到"官方到哪一版了"。
    # 真机踩过：这里一失败就整个 return，界面上只剩一句"检查失败"，官方信息全丢了。
    officials = None
    if official and official_remote_name(info.remotes):
        officials = official_status(info)

    # 不带 --depth：带它会给本地仓库凭空加一个浅边界，把本来完整的祖先关系弄断
    code, _out, err = run_git(["fetch", remote, branch], path, timeout=FETCH_TIMEOUT)
    if code != 0:
        return UpdateStatus(ok=False, branch=branch, remote=remote, official=is_official,
                            upstream=info.upstream, remote_url=url, version=info.version,
                            official_status=officials,
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
    if not info.shallow:
        code, out, _ = run_git(["rev-list", "--count", "FETCH_HEAD..HEAD"], path)
        if code == 0 and out.strip():
            ahead = int(out.strip().split()[0])

    officials = None
    if official and official_remote_name(info.remotes):
        officials = official_status(info)

    return UpdateStatus(ok=True, behind=behind, ahead=ahead, branch=branch,
                        remote=remote, upstream=info.upstream, remote_url=url,
                        official=is_official, latest=latest, latest_subject=subject,
                        version=info.version, official_status=officials)


@dataclass(frozen=True)
class UpdateResult:
    """一次更新的结果；changed=False 表示本来就是最新（不是失败）。"""
    ok: bool
    changed: bool = False
    before: str = ""
    after: str = ""
    subject: str = ""
    behind: int = 0
    strategy: str = ""
    backup: str = ""
    conflict: bool = False
    error: str = ""


def unofficial_remote_name(remotes: dict[str, str]) -> str:
    """远端**名**里仓库名对得上、owner 不是官方的那个（自己的仓库）。没有则 ''。"""
    for name, url in remotes.items():
        owner, repo = split_remote(url)
        if repo.lower() == REPO_SLUG.lower() and owner.lower() != OFFICIAL_OWNER:
            return name
    return ""


@dataclass(frozen=True)
class UpdateSource:
    """一个"可以从哪里更新"的来源——界面据此决定显示一个按钮还是两个。

    kind=official：官方仓库（`deepseek-ai/deepseek-harness`）
    kind=mine    ：你自己的仓库（fork / 团队镜像 / 私有化克隆，owner 不是官方）
    """
    kind: str
    label: str = ""
    owner: str = ""
    remote: str = ""
    url: str = ""
    branch: str = ""
    version: str = ""          # 官方才有：最新发布版本（标签）
    head: str = ""             # 该分支的远端头（短 hash，探测到时）
    reachable: bool = False
    error: str = ""


def _remote_default_branch(name_or_url: str, cwd: Optional[Path],
                           timeout: int) -> str:
    """远端默认分支：`ls-remote --symref ... HEAD` 的 `ref:` 行（只取引用，很便宜）。"""
    code, out, _ = run_git(["ls-remote", "--symref", name_or_url, "HEAD"],
                           cwd, timeout=timeout)
    if code == 0:
        for line in out.splitlines():
            if line.startswith("ref:") and "refs/heads/" in line:
                return line.split("refs/heads/", 1)[1].split()[0]
    for candidate in ("master", "main"):
        code, out, _ = run_git(["ls-remote", name_or_url, f"refs/heads/{candidate}"],
                               cwd, timeout=timeout)
        if code == 0 and out.strip():
            return candidate
    return ""


def _remote_branch_head(name_or_url: str, branch: str, cwd: Optional[Path],
                        timeout: int) -> str:
    """远端某个分支的头（短 hash）；取不到返回空串。"""
    code, out, _ = run_git(["ls-remote", name_or_url, f"refs/heads/{branch}"],
                           cwd, timeout=timeout)
    if code != 0 or not out.strip():
        return ""
    return out.split()[0][:7]


def update_sources(path: Path, *, mirrors: Sequence[str] = (),
                   timeout: int = LS_REMOTE_TIMEOUT) -> tuple[list[UpdateSource], str]:
    """这台机器上"能从哪里更新"。

    规则（与用户对齐过的）：**只有官方远端 → 只给官方一条；官方之外还有自己的远端 →
    再多给一条"你自己的仓库"**；两者都没有就返回空并说明原因。
    自己的那条跟**当前分支的同名分支**（开发机上通常就是它），没有同名才退回远端默认分支。
    全程只 `ls-remote`（取引用，几秒），不 fetch 历史。
    """
    info = repo_info(path)
    if not info.ok:
        return [], info.error
    remotes = dict(info.remotes)
    sources: list[UpdateSource] = []

    official_name = official_remote_name(remotes)
    if official_name:
        name = official_name
        url = remotes[name]
        official = official_status(info, timeout=timeout)
        branch = official.branch or _remote_default_branch(name, path, timeout)
        sources.append(UpdateSource(
            kind="official", label="从官方更新", owner=OFFICIAL_OWNER,
            remote=name, url=url, branch=branch, version=official.version,
            head=official.head, reachable=official.ok,
            error=official.error))

    mine_name = unofficial_remote_name(remotes)
    if mine_name:
        url = remotes[mine_name]
        branch = info.branch
        head = _remote_branch_head(mine_name, branch, path, timeout) if branch else ""
        if not head:
            # 别急着去猜默认分支：每次 ls-remote 都要等满 timeout，连不上时真机实测
            # 能把界面锁住好几分钟（按钮全灰）。先花一次 --heads 探活，连不上就如实说。
            code, _out, err = run_git(["ls-remote", "--heads", mine_name], path,
                                      timeout=timeout)
            if code != 0:
                return sources, (f"{mine_name} 连不上（{_first_line(err) or '超时'}）；"
                                 "先恢复网络再点【检查更新】")
            branch = _remote_default_branch(mine_name, path, timeout)
            head = _remote_branch_head(mine_name, branch, path, timeout) if branch else ""
        owner, _repo = split_remote(url)
        label = f"从你的仓库更新（{owner or mine_name}）"
        sources.append(UpdateSource(
            kind="mine", label=label, owner=owner, remote=mine_name, url=url,
            branch=branch, head=head, reachable=bool(head),
            error="" if head else "远端上没有可用的分支"))

    if not sources:
        return [], ("这个目录没有配置任何 DSH 远端，无法更新"
                    "（用『一键完整安装』装出来的离线目录就是这种）")
    by_kind = {s.kind: s for s in sources}
    ordered = [by_kind[k] for k in ("official", "mine") if k in by_kind]
    return ordered, ""


def _existing_backup_name(path: Path) -> str:
    """给"更新前"打个备份分支，名字带时间戳（同一秒里加序号，避免撞名）。"""
    base = f"backup/before-update-{time.strftime('%Y%m%d-%H%M%S')}"
    name, index = base, 0
    while True:
        code, out, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{name}"],
                               path)
        if code != 0 or not out.strip():
            return name
        index += 1
        name = f"{base}-{index}"


def _unrelated_hint(shallow: bool) -> str:
    """两边没有共同祖先时的可操作说明：浅克隆被截断、或历史对不上，都会走到这里。

    git 自己只会说 `refusing to merge unrelated histories`——对用户等于没说。
    """
    why = ("本地是浅克隆（历史不完全）" if shallow
           else "本地和远端的历史对不上")
    return (f"{why}，两边找不到共同祖先，没法安全合并。\n"
            "两条路：① 能连上你自己的仓库时先补齐历史：git fetch --unshallow；\n"
            "② 把取多深调大（配置项 gitDepth / 环境变量 DSH_GIT_DEPTH），或配官方镜像。\n"
            "你的文件没有被改动。")


def update_from(path: Path, source: UpdateSource, *, mirrors: Sequence[str] = (),
                strategy: str = "merge", backup: bool = True,
                timeout: int = FETCH_TIMEOUT) -> UpdateResult:
    """从指定来源更新这个目录。

    · **能快进就快进**（`merge --ff-only`），不动你的提交；
    · 分叉（不是快进关系）时按 `strategy` 处理：`merge` 合并（默认）、`rebase` 变基、
      `ff` 只允许快进（做不到就如实拒绝）；
    · 合并/变基之前**先打备份分支**（`backup/before-update-<时间戳>`），出问题一条命令退回去；
    · 冲突时**整体撤销**（`merge --abort` / `rebase --abort`）并如实报告，绝不自动解冲突；
    · 官方来源按"镜像优先 → 官方"的顺序取（镜像由调用方从配置/环境传进来）；
    · 取之前先对官方做一次便宜的 `ls-remote` 探活——连不上就别让用户干等 fetch 超时。
    所有结论都来自 git 的退出码，不猜。
    """
    info = repo_info(path)
    if not info.ok:
        return UpdateResult(ok=False, error=info.error)
    if not info.status_ok:
        return UpdateResult(ok=False, error=(
            "查不出工作区状态（git status 没跑成，多半是超时或索引被占用）。\n"
            "为安全起见先不更新——工作区到底干不干净还不知道，"
            "不能拿「没查到」当「没事」。稍后重试，或先手动确认工作区干净。"))
    if info.dirty:
        return UpdateResult(ok=False, error=(
            f"工作区有 {info.dirty} 处本地改动；为避免覆盖你的改动，"
            "请先提交或撤销这些改动，再更新"))
    if not info.branch or info.branch == "HEAD":
        return UpdateResult(ok=False, error="处于分离头（detached HEAD）状态，无法更新")
    if not source.branch:
        return UpdateResult(ok=False, error=f"{source.label}：不知道要取哪个分支")

    targets: list[str] = []
    if source.kind == "official":
        targets += [m for m in mirrors if m]
    targets.append(source.remote or source.url)

    problems: list[str] = []
    fetched = False
    for target in targets:
        is_official = target not in mirrors and source.kind == "official"
        label = ("国内镜像" if target in mirrors
                 else ("官方源" if source.kind == "official" else "你的仓库"))
        if is_official:
            # 先花几秒探一下可达性：真机实测连不上 github 时，全量 fetch 会一直挂到超时
            # （十分钟都不返回），用户看到的是"更新卡死"。探不到就直接说清楚，别耗着。
            code_probe, _out_probe, err_probe = run_git(
                ["ls-remote", "--heads", target, source.branch], path)
            if code_probe != 0:
                problems.append(f"{label}（{target}）：现在连不上"
                                f"（{_first_line(err_probe) or code_probe}）")
                continue
        code, _out, err = run_git(["fetch", target, source.branch], path,
                                  timeout=GIT_FETCH_TIMEOUT if is_official else timeout)
        if code == 0:
            fetched = True
            break
        problems.append(f"{label}（{target}）：{_first_line(err) or code}")
    if not fetched:
        return UpdateResult(ok=False, error="取不到远端更新：\n  " + "\n  ".join(problems))

    # 浅克隆里祖先关系可能被截断；先确认两边**有共同祖先**，没有就别谈合并
    if info.shallow:
        code, _out, _err = run_git(["merge-base", "HEAD", "FETCH_HEAD"], path)
        if code != 0:
            return UpdateResult(ok=False, strategy=strategy,
                                error=_unrelated_hint(True))

    # 用 git 自己的祖先判断决定"能不能快进"，不数提交数：浅克隆里数出来会骗人
    code, _out, _err = run_git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], path)
    fast_forward = code == 0
    # "是不是同一个提交"一律用两个 SHA 直接比，**不能**看 rev-list 数出来的 0：
    # rev-list 超时/失败时也会退化成 0，那就把"数不出来"当成了"没有差异"（fail-open）。
    code_h, out_h, _e = run_git(["rev-parse", "HEAD"], path)
    code_f, out_f, _e = run_git(["rev-parse", "FETCH_HEAD"], path)
    same_commit = (code_h == 0 and code_f == 0
                   and out_h.strip() == out_f.strip() and out_h.strip() != "")

    behind = 0
    code, out, _err = run_git(["rev-list", "--count", "HEAD..FETCH_HEAD"], path,
                              timeout=GIT_FETCH_TIMEOUT)
    if code == 0 and out.strip():
        behind = int(out.strip().split()[0])

    if fast_forward and same_commit:
        return UpdateResult(ok=True, changed=False, before=info.short,
                            after=info.short, strategy="ff")

    # 远端这个头**已经在你本地里了**（你比它新，或上次已经合过它）——同样是"没有新东西"，
    # 说清楚就走，别再去打一条 backup/… 分支。实测暴露的脏点：副本上多合一次就多一条
    # backup/before-update-…，什么都没改却留下一堆分支。
    code, _out, _err = run_git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], path)
    if code == 0:
        return UpdateResult(ok=True, changed=False, before=info.short,
                            after=info.short, strategy="ff")

    if not fast_forward and strategy == "ff":
        return UpdateResult(ok=False, behind=behind, strategy="ff", error=(
            "不是快进关系（你本地有自己的提交），已中止，你的文件没有被改动。"))

    backup_branch = ""
    if not fast_forward and backup:
        backup_branch = _existing_backup_name(path)
        code, _out, err = run_git(["branch", backup_branch, "HEAD"], path)
        if code != 0:
            return UpdateResult(ok=False, behind=behind, error=(
                f"打备份分支失败，已中止（你的文件没有被改动）：{_first_line(err)}"))

    if fast_forward:
        code, _out, err = run_git(["merge", "--ff-only", "FETCH_HEAD"], path)
        used = "ff"
    elif strategy == "rebase":
        code, _out, err = run_git(["rebase", "FETCH_HEAD"], path)
        used = "rebase"
    else:
        code, _out, err = run_git(["merge", "--no-edit", "FETCH_HEAD"], path)
        used = "merge"

    if code != 0:
        # git 说 "refusing to merge unrelated histories" 时，用户需要的是"为什么 + 怎么办"
        if "unrelated histories" in err:
            run_git(["merge", "--abort"], path)   # 没开始合并时这是空操作
            return UpdateResult(ok=False, behind=behind, strategy=used,
                                backup=backup_branch,
                                error=_unrelated_hint(info.shallow))
        # 冲突/失败一律整体撤销：让目录回到更新前的样子，绝不留下半个合并
        # 冲突文件名单要在 abort **之前**取，abort 之后索引就干净了、什么都问不出来。
        # 用 -z 取：默认的引号会把中文路径转义成 "RE_\346\274\224..."，用户看到的全是乱码。
        _code_u, out_u, _err_u = run_git(["diff", "--name-only", "-z", "--diff-filter=U"],
                                        path)
        files = [f for f in out_u.split("\0") if f.strip()]
        undo = ["rebase", "--abort"] if used == "rebase" else ["merge", "--abort"]
        # 撤销**自己也会失败**（merge 被超时杀掉、文件被占用、磁盘满…）。这时绝不能嘴上
        # 还说"你的文件没有被改动"——退出码和 MERGE_HEAD 说了算。
        undo_code, _undo_out, _undo_err = run_git(undo, path, timeout=GIT_UNDO_TIMEOUT)
        still_merging = (path / ".git" / "MERGE_HEAD").exists()
        if files:
            shown = "、".join(files[:5]) + ("…" if len(files) > 5 else "")
            detail = f"{shown}（共 {len(files)} 个文件）"
        else:
            detail = _first_line(err) or f"git 退出码 {code}"
        if undo_code != 0 or still_merging:
            hint = ("**撤销没能做完**，请手动收拾：" + (
                f"git reset --hard {backup_branch}" if backup_branch
                else "git merge --abort"))
        elif backup_branch:
            hint = (f"已整体撤销，你的文件没有被改动。备份分支 {backup_branch} 仍在，"
                    "随时可以退回去。")
        else:
            hint = "已整体撤销，你的文件没有被改动。"
        return UpdateResult(ok=False, behind=behind, strategy=used, conflict=True,
                            backup=backup_branch,
                            error=f"{'冲突' if used != 'ff' else '快进'}没能完成：{detail}。{hint}")

    code, out, _ = run_git(["rev-parse", "--short", "HEAD"], path)
    after = _first_line(out) if code == 0 else ""
    code, out, _ = run_git(["log", "-1", "--format=%s"], path)
    subject = _first_line(out) if code == 0 else ""
    return UpdateResult(ok=True, changed=after != info.short, before=info.short,
                        after=after, subject=subject, behind=behind, strategy=used,
                        backup=backup_branch)


def push_branch(path: Path, remote: str, branch: str = "",
                timeout: int = GIT_FETCH_TIMEOUT) -> tuple[bool, str]:
    """把当前分支推到指定远端，返回 `(成功, 错误说明)`。**永不 force**。

    什么时候用：本地已经合进官方之后，把你自己的仓库也更新到同一个状态。否则别的机器
    从你的仓库更新时永远看不到官方那部分（你的仓库还停在旧版本）。
    远端比本地新时 git 会拒绝——那就如实报，绝不硬推。
    """
    if not remote:
        return False, "不知道往哪个远端推"
    code, _out, err = run_git(["push", remote, branch or "HEAD"], path, timeout=timeout)
    if code == 0:
        return True, ""
    if "rejected" in err or "non-fast-forward" in err or "fetch first" in err:
        return False, ("远端比本地新，推送被拒绝（不是本地的问题）——先去你的仓库那边把它"
                       "多出来的提交拉下来处理，别硬推。")
    return False, _first_line(err) or f"git 退出码 {code}"


def update_repo(path: Path, *, remote: str = "") -> UpdateResult:
    """把安装目录**快进**到远端最新。只走 fast-forward，绝不产生合并提交。

    remote 留空就跟分支跟踪的远端走（同 `check_update`）。
    三道前置检查，任一不过就拒绝并说明原因，绝不硬来：
    ① 工作区必须干净——否则可能覆盖用户自己的改动；
    ② 必须在分支上、远端可达；
    ③ 「能不能快进」**交给 git 自己判断**（`merge --ff-only`），不自己数提交数：
       线上安装用的是 `git clone --depth 1`（浅克隆），祖先关系被截断，
       `rev-list` 两个方向都会把边界提交各算一次，自己算会误判成「有本地独有提交」而瞎拒绝；
       而 git 的合并机制在浅克隆里判断是准的。
    于是「已是最新」返回 `changed=False` 的成功，而不是失败。

    `update_from` 是新的通用入口（可选合并/变基 + 备份）；这个函数保留为"只快进"的
    老行为，供不区分来源的调用方继续使用。
    """
    info = repo_info(path)
    if not info.ok:
        return UpdateResult(ok=False, error=info.error)
    remote = remote or tracking_remote(info)
    if remote not in info.remotes:
        return UpdateResult(ok=False, error=f"没有名为 {remote} 的远端")
    source = UpdateSource(kind="mine", label=f"从你的仓库更新（{remote}）",
                          remote=remote, url=info.remotes[remote], branch=info.branch)
    return update_from(path, source, strategy="ff", backup=False)
