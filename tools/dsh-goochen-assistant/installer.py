# -*- coding: utf-8 -*-
"""DSH-孤辰小助手（图形版 · 双模：离线/在线/自动）

面向小白：双击 run.bat 或 installer.py 后按按钮即可。同一程序在
assets/ 齐全时走『全离线零网络』，assets 缺失时自动走官方源 / 镜像
在线安装；『自动选择』为默认，按步骤独立取源。

依赖：仅 Python 3.11+ 标准库（tkinter/subprocess/threading）。打包成
exe 用 PyInstaller（未来阶段）。当前直接用解释器运行。

用法：
  installer.py            启动图形界面
  installer.py --selfcheck  只打印本机环境检测结果（不弹窗口）
  installer.py --headless   无界面跑安装流程（刷日志到控制台）
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

import childproc               # 子进程登记（关窗时连子孙一起结束）
import plugin_store as pstore  # 插件管理原语（同目录模块）
import gitinfo as ginfo        # 真 git 命令层（识别/校验/版本/更新）

__version__ = "0.1.0"

APP_TITLE = "DSH-孤辰小助手 v0.1"
REGISTRY_MIRROR = "https://registry.npmmirror.com"
REGISTRY_OFFICIAL = "https://registry.npmjs.org"
NODE_MSI_URL = "https://nodejs.org/dist/v24.20.0/node-v24.20.0-x64.msi"
HARNESS_GIT_URL = "https://github.com/deepseek-ai/deepseek-harness.git"
SOURCE_DIR_NAME = "deepseek-harness"
BUILD_MARK = ".dsh-build/client-build-environment.json"
WEB_URL = "http://127.0.0.1:3080"

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
NODE_MSI_ASSET = ASSETS / "node-v24.20.0-x64.msi"
PNPM_TGZ_ASSET = ASSETS / "pnpm.tgz"
SOURCE_ARCHIVE = ASSETS / "source.tar.gz"          # 可选：离线源码包
STORE_DIR = ASSETS / "pnpm-store"                  # 可选：离线依赖缓存
INSTALL_BASE = Path(os.environ.get("USERPROFILE", str(Path.home())))
DEFAULT_PROJECT_DIR = INSTALL_BASE / SOURCE_DIR_NAME     # 方案 A：默认安装位
MIN_FREE_GB = 8.0                                        # 安装所需最小可用空间
CONFIG_DIR = INSTALL_BASE / ".dsh-assistant"             # 用户选择持久化
CONFIG_PATH = CONFIG_DIR / "config.json"

#: 「安装与启动」页左栏（操作区）宽度，以及左栏里长文字的换行宽度（左栏减去内边距）。
#: 中间的竖线可以拖着调，拖完记住；这几个是默认值与上下限。
LEFT_COL_WIDTH = 430
LEFT_COL_MIN = 340
LEFT_COL_MAX = 900
LOG_COL_MIN = 320
WRAP_LEFT = 396
#: 分隔条本体的宽度（ttk 的 sash）：算「日志栏还剩多少」时要减掉它。
SASH_PX = 6
#: 日志区最多保留多少行（长时间跑安装/服务时不让 Text 无上限增长）。
LOG_MAX_LINES = 5000

#: 安装方式的短名——折叠起来之后，标题上仍要看得出现在选的是哪个。
MODE_CN = {
    "auto": "自动选择（推荐）",
    "offline": "离线安装",
    "online": "在线安装",
}
LOG_PATH = HERE / "installer.log"

ALL_STEPS = ("detect", "node", "pnpm", "source", "deps", "build", "start")


# ---------------------------------------------------------------- helpers
def log_line(msg: str) -> None:
    line = str(msg)
    print(line, flush=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def version_ok(version: str) -> bool:
    """True 当版本满足 ^22.19 || >=24。"""
    m = re.match(r"^v?(\d+)\.(\d+)(?:\.\d+)?", version)
    if not m:
        return False
    major, minor = int(m.group(1)), int(m.group(2))
    return (major == 22 and minor >= 19) or major >= 24


def run(argv: list[str], cwd: Path | None = None,
        env: dict | None = None) -> subprocess.CompletedProcess:
    """跑一条命令（阻塞到结束）；句柄登记在册，关窗时会被一起结束。"""
    return childproc.run(argv, cwd=cwd, env=env)


def run_cli(argv: list[str], cwd: Path | None = None,
            env: dict | None = None) -> subprocess.CompletedProcess:
    """Windows 下经 cmd shell 执行（能解析 pnpm.cmd 等批处理），
    其他平台退化到原生 run()。GUI 进程/线程都可用。"""
    if os.name == "nt":
        cmdline = " ".join(f'"{a}"' if (" " in a or a.endswith((".cmd", ".exe"))) and not a.startswith('"') else a
                           for a in argv)
        return childproc.run(cmdline, cwd=cwd, env=env, shell=True)
    return run(argv, cwd=cwd, env=env)


def run_text(argv: list[str], cwd: Path | None = None,
             env: dict | None = None) -> str:
    proc = run(argv, cwd=cwd, env=env)
    raw = (proc.stdout or b"") + (proc.stderr or b"")
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def decode_proc(proc: subprocess.CompletedProcess) -> str:
    raw = (proc.stdout or b"") + (proc.stderr or b"")
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def find_node() -> str | None:
    try:
        hit = shutil.which("node")
        if hit:
            ver = run_text([hit, "--version"]).strip()
            if version_ok(ver):
                return hit
    except Exception:  # noqa: BLE001
        pass
    return None


def find_npm() -> str | None:
    """npm 的**全路径**（Windows 上是 `npm.CMD`）。

    不能裸写 `"npm"`：Windows 的 CreateProcess 只给名字补 `.exe`，而 npm/corepack/pnpm
    都是 `.cmd` 批处理，裸名字一律 `FileNotFoundError`。`shutil.which` 认 PATHEXT，
    拿到的全路径可以直接调用（实测 `C:\\Program Files\\nodejs\\npm.CMD` rc=0）。
    """
    try:
        return shutil.which("npm")
    except Exception:  # noqa: BLE001
        return None


def find_pnpm() -> str | None:
    try:
        return shutil.which("pnpm")
    except Exception:  # noqa: BLE001
        return None


def is_admin() -> bool:
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------- 安装位置（可配置 + 持久化）
# 结构必要条件：一个目录同时有这两样，才有可能是 DSH 检出。
CHECKOUT_MARKERS = ("package.json", "pnpm-workspace.yaml")
# 身份条件（任意一条成立才算 DSH）：官方根包名 / 官方包名前缀 / 官方子包名。
# 只看结构会把**任意 pnpm 单仓**误判成 DSH，所以必须再认身份。
DSH_ROOT_PACKAGE = "@deepseek-ai/dsh-root"
DSH_PACKAGE_PREFIX = "@deepseek-ai/dsh"
# 自动检测的扫描预算：单次探测的总时间上限、每个盘根最多看多少个子目录。
# 预算用完就停（宁可漏认也不能卡住界面）；结果整体缓存，正常只跑一次。
DETECT_BUDGET_S = 3.0
SHALLOW_LIMIT = 400
DRIVE_FIXED = 3          # GetDriveTypeW 的 DRIVE_FIXED
# 常见安装目录名（含下划线写法，用户的安装常叫 deepseek_harness）。
INSTALL_DIR_NAMES = ("deepseek-harness", "deepseek_harness", "dsh-harness",
                     "dsh_harness", "DeepseekHarness")
# 界面当前选定的安装位：置顶于配置与自动检测之上（见 project_dir）。
_ACTIVE_DIR: Path | None = None
# 自动检测结果缓存（单元素）：探测只做一次，避免每次按键都扫盘。
_DETECT_CACHE: list[Path | None] = []


def load_config() -> dict:
    """读取小助手配置；文件缺失或损坏时返回空配置。"""
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_config(updates: dict) -> None:
    """合并写入配置（只覆盖传入的键）。"""
    cfg = load_config()
    cfg.update(updates)
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)     # 原子替换：写到一半断电也不会留下坏配置
    except OSError as exc:
        log_line(f"[配置] 保存失败（本次运行仍生效）：{exc}")


def saved_left_col_width() -> int:
    """左栏宽度：用户拖动过中间的竖线就用他定下的，越界或文件损坏则回落默认值。"""
    value = load_config().get("leftColWidth")
    if isinstance(value, int) and not isinstance(value, bool) and LEFT_COL_MIN <= value <= LEFT_COL_MAX:
        return value
    return LEFT_COL_WIDTH


#: 记着哪些目录的安装/更新被「关窗」打断了——下次要重新装依赖并重新构建。
#: 因为 `node_modules` 存在就跳过安装，被打断的半成品否则会被当成装好了。
#: 存的是**列表**：先中断 A、后来又中断 B 时，A 的坑不能被抹掉。
INTERRUPTED_KEY = "interruptedInstall"


def _norm_path(text: str) -> str:
    return os.path.normcase(os.path.normpath(text))


def interrupted_targets() -> list[str]:
    """所有被打断过的安装目录（兼容旧版只存一个字符串的格式）。"""
    value = load_config().get(INTERRUPTED_KEY)
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str) and v]
    return []


def set_interrupted_target(path: str) -> None:
    """记下被打断的安装目录（关窗时调用）；已经记过的不重复记。"""
    saved = interrupted_targets()
    if any(_norm_path(p) == _norm_path(path) for p in saved):
        return
    save_config({INTERRUPTED_KEY: saved + [path]})


def install_was_interrupted(path: Path) -> bool:
    """这个目录上次的安装/更新是不是被中途关窗打断了。"""
    return any(_norm_path(p) == _norm_path(str(path)) for p in interrupted_targets())


def clear_interrupted(path: Path) -> None:
    """这个目录的安装/更新顺利跑完了，把它从名单里去掉（别的目录不受影响）。"""
    saved = interrupted_targets()
    keep = [p for p in saved if _norm_path(p) != _norm_path(str(path))]
    if keep != saved:
        save_config({INTERRUPTED_KEY: keep})


def free_gb(path: Path) -> float:
    """所在磁盘可用 GB；查询失败返回 -1。"""
    try:
        return shutil.disk_usage(path).free / (1024 ** 3)
    except OSError:
        return -1.0


def _roomy_other_drives(min_free_gb: float = 20.0) -> list[Path]:
    """非系统盘中可用空间充足者的候选安装位（用于系统盘吃紧时回退）。"""
    system = Path(os.environ.get("SystemDrive", "C:") + "\\")
    out: list[Path] = []
    for root in _drive_roots():
        if root == system:
            continue
        if free_gb(root) >= min_free_gb:
            out.append(root / "DSH" / SOURCE_DIR_NAME)
    return out


def default_project_dir() -> Path:
    """默认安装位（方案 A：%USERPROFILE%\\deepseek-harness）。

    系统盘可用空间低于 MIN_FREE_GB 且存在其它空间充足的盘时，回退到
    <盘>:\\DSH\\deepseek-harness；否则始终用方案 A。
    """
    home_free = free_gb(INSTALL_BASE)
    if home_free < 0 or home_free >= MIN_FREE_GB:
        return DEFAULT_PROJECT_DIR
    others = _roomy_other_drives()
    return others[0] if others else DEFAULT_PROJECT_DIR


def _pkg_name(pkg_json: Path) -> str:
    """读 package.json 的 name；缺失/损坏/非对象一律返回空串。"""
    try:
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return ""
    return str(data.get("name", "")) if isinstance(data, dict) else ""


def checkout_identity(path: Path) -> str:
    """这个目录**凭内容**凭什么被认成 DSH 检出；返回判定依据，'' 表示不是。

    结构（`package.json` + `pnpm-workspace.yaml`）只是必要条件——任意 pnpm 单仓都满足，
    所以还要认身份，任意一条成立即可（都不会被用来**否决**别的依据）：
      ⓪ 有本助手写的安装标记（离线装的目录只有这一条）
      ① 根包名 = `@deepseek-ai/dsh-root`（官方根包名，最硬）
      ② 根包名 = `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头（官方改名后仍认）
      ③ `packages/core/` 下存在 `@deepseek-ai/dsh-*` 子包（不依赖**根**包名）

    这里**不看 git 远端**：远端交给真 git 去判（见 `verify_install_dir`）。读 `.git/config`
    文本既读不准（`insteadOf` 重写、`includeIf` 条件包含、worktree 改道都会绕开它），
    又会把「碰巧同名的别的仓库」误认成 DSH。**内容是门槛，远端是加固，两条都要过。**
    """
    try:
        if not all((path / m).is_file() for m in CHECKOUT_MARKERS):
            return ""
    except OSError:
        return ""
    marker = read_install_marker(path)
    if marker:
        tag = "，运行验证通过" if marker.get(RUN_VERIFIED_KEY) else ""
        return f"本助手安装标记（{marker.get('mode', '未知')}{tag}）"
    name = _pkg_name(path / "package.json")
    if name == DSH_ROOT_PACKAGE:
        return f"根包名 {name}"
    if name == DSH_PACKAGE_PREFIX or name.startswith(DSH_PACKAGE_PREFIX + "-"):
        return f"根包名 {name}"
    sub = _dsh_subpackage(path)
    if sub:
        return f"子包 {sub}"
    return ""


def _dsh_subpackage(path: Path, group: str = "core", limit: int = 40) -> str:
    """在 `packages/<group>/` 下找一个 `@deepseek-ai/dsh-*` 子包，返回其包名。

    不依赖根包名，但也不是「看目录名」——`packages/core` 是极常见命名，普通单仓
    也有，所以必须真的读到官方包名才算数。
    """
    try:
        with os.scandir(path / "packages" / group) as entries:
            for index, entry in enumerate(entries):
                if index >= limit:
                    break
                try:
                    if not entry.is_dir():
                        continue
                except OSError:
                    continue
                sub = _pkg_name(Path(entry.path) / "package.json")
                if sub.startswith(DSH_PACKAGE_PREFIX + "-"):
                    return sub
    except OSError:
        return ""
    return ""


def is_checkout(path: Path) -> bool:
    """该目录是否是一个 DSH 检出（= 已装好，可直接运行、无需重装）。"""
    return bool(checkout_identity(path))


def verify_install_dir(path: Path, info=None) -> ginfo.DshIdentity:
    """确认「这个目录就是装好的 DSH」，返回判定结果（含依据强弱）。

    两条**互相独立**的证据都要过，缺一不可——这是故意的深度防御：
    ① **内容**（`checkout_identity`）：结构 + 官方包名/本助手安装标记。这是底线，挡住
       「碰巧也叫 deepseek-harness 的别的仓库」和「自己的项目里只是加了官方远端」；
    ② **git**（能跑就跑）：该目录是仓库根，且远端是 DSH。**官方仓库**（owner 与仓库名
       都对上）最强；仓库名对得上但不在官方名下的（你自己账户下的 fork、镜像、本地克隆）
       也认，但结论里**明说它不是官方**。
    git 认不出来时用文件判定收尾（tier="file"）：离线解压出来的目录没有 `.git`，
    机器没装 git 时也是这样。
    注意：一次要跑若干条 git（约 0.2 秒），所以只用在「用户选定的那一个目录」上，
    不要放进扫盘或每次按键的路径里。
    """
    if info is None:
        info = ginfo.repo_info(path)
    why = checkout_identity(path)
    ident = (ginfo.verify_dsh_repo(path, info) if info.ok
             else ginfo.DshIdentity(False, "none", info.error))
    if ident.ok:
        if why:
            return ident
        return ginfo.DshIdentity(False, "suspect", (
            f"{ident.evidence}；但目录内容不像 DSH"
            "（既没有官方包名，也没有本助手的安装标记）"
            "——可以先点【运行】试跑一次，跑起来了就说明是"))
    if why:
        return ginfo.DshIdentity(True, "file", why)
    if _nonempty_dir(path):
        return ginfo.DshIdentity(False, "suspect", (
            "目录里已有内容，但认不出这是 DSH"
            "（没有官方包名/安装标记，远端也不像）"
            "——可以先点【运行】试跑一次，跑起来了就说明是"))
    return ginfo.DshIdentity(False, "none", ident.evidence)


# ------------------------------------------------- 安装标记（离线装的身份证）
INSTALL_MARKER = ".dsh-assistant.json"


def write_install_marker(project: Path, mode: str) -> None:
    """在安装目录写一份「本助手安装」标记，把官方仓库链接一并绑定下来。

    离线解压出来的目录没有 `.git`，这份标记就是它唯一的身份凭据；在线克隆的目录
    本身有 `.git/config`，标记则额外记下安装方式与时间。
    """
    data = {
        "tool": APP_TITLE,
        "app": SOURCE_DIR_NAME,
        "source": HARNESS_GIT_URL,
        "mode": mode,
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    try:
        (project / INSTALL_MARKER).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        log_line(f"[标记] 写入失败（不影响安装）：{exc}")


#: 安装标记里记「真的把 dsh web 跑起来过」的字段。
RUN_VERIFIED_KEY = "verifiedByRun"


def mark_run_verified(project: Path) -> bool:
    """记下「这个目录真的把 dsh web 跑起来过」；返回是否写入成功。

    **运行验证是最硬的一份证据**：`pnpm dsh web` 只有在目录里确实有 DSH 时才打得开网页。
    内容认不出、远端也认不出时，就靠它定案——跑成功了从此按「本助手安装标记」认这个目录。
    已有标记（例如离线安装写的）只补一个字段，不覆盖原有安装方式。
    """
    data = read_install_marker(project)
    if not data:
        data = {
            "tool": APP_TITLE,
            "app": SOURCE_DIR_NAME,
            "source": HARNESS_GIT_URL,
            "mode": "run-verified",
            "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
    data[RUN_VERIFIED_KEY] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        (project / INSTALL_MARKER).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return True
    except OSError as exc:
        log_line(f"[标记] 写入运行验证失败：{exc}")
        return False


def read_install_marker(path: Path) -> dict:
    """读安装标记；不存在/损坏/不是本助手写的 → 返回 {}。"""
    try:
        data = json.loads((path / INSTALL_MARKER).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data if str(data.get("tool", "")).startswith("DSH-孤辰小助手") else {}


def _drive_roots(*, fixed_only: bool = True) -> list[Path]:
    """有盘符的根目录；默认只要**固定盘**（跳过可移动/网络/CD，避免扫盘卡死）。"""
    out: list[Path] = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        root = Path(f"{letter}:\\")
        try:
            if not root.exists():
                continue
            if fixed_only and _drive_type(root) not in (0, DRIVE_FIXED):
                continue
            out.append(root)
        except OSError:
            continue
    return out


def _drive_type(root: Path) -> int:
    """盘类型（GetDriveTypeW）；取不到时返回 0 = 未知（按固定盘处理）。"""
    try:
        import ctypes
        return int(ctypes.windll.kernel32.GetDriveTypeW(str(root)))
    except Exception:  # noqa: BLE001
        return 0


def _nonempty_dir(path: Path) -> bool:
    """目录存在且非空；读不了也算非空（避免把读不到的目录当成空的去覆盖）。"""
    try:
        if not path.is_dir():
            return False
        with os.scandir(path) as entries:
            return next(entries, None) is not None
    except OSError:
        return True


def _peek_names(path: Path, limit: int = 3) -> str:
    """列几个目录里的条目名，用于提示「这个目录里现在有什么」。"""
    try:
        with os.scandir(path) as entries:
            return "、".join(e.name for _, e in zip(range(limit), entries))
    except OSError:
        return ""


def _nonempty_target_error(project: Path, *, offline: bool) -> InstallError:
    """目标目录非空、又没有 DSH 身份时的统一提示。

    离线解压会把源码铺进去并**覆盖同名文件**，git clone 则根本写不进非空目录；
    两者的正确做法一样：换空目录，或指向已经装好的 DSH。
    """
    what = ("离线解压会把源码铺进这个目录、并覆盖同名文件" if offline
            else "git clone 无法写入非空目录")
    lines = [
        f"{project}",
        "这个目录不是空的，里面也没有 DSH 的安装身份（没有本助手的安装标记、"
        f"也没有官方包名）——{what}，安装已中止。",
    ]
    peek = _peek_names(project)
    if peek:
        lines.append(f"（目录里现在有：{peek} …）")
    lines.append("请把「安装位置」换成一个空目录，或指向已经装好的 DeepSeek Harness 目录。")
    return InstallError("\n".join(lines))


def _archive_top_names(archive: Path) -> set[str]:
    """归档里的顶层名字，**跳过符号链接条目**；读不出来时返回空集。

    跳过 symlink 是必须的：真包的顶层就有 `CLAUDE.md → AGENTS.md`，它在 Windows 上
    建不出来也不影响使用；把它算进"应有内容"会让完整解压被误判成缺东西。
    用 Python 的 `tarfile` 而不是 `tar -tzvf`：类型判断不依赖 tar 的输出格式与本地化。
    """
    names: set[str] = set()
    try:
        with tarfile.open(archive, "r:gz") as tf:
            for m in tf.getmembers():
                if m.issym():
                    continue
                name = m.name
                while name.startswith("./"):     # 只去掉 "./" 前缀：lstrip("./") 会连
                    name = name[2:]              # 开头的点一起吃掉（.agents → agents）
                first = name.split("/")[0]
                if first:
                    names.add(first)
    except (OSError, tarfile.TarError):
        return set()
    return names


def fill_missing_links(project: Path, archive: Path) -> list[str]:
    """把没落地的符号链接按「复制内容」补齐，返回补齐的相对路径列表。

    Windows 上非管理员且未开开发者模式时建不了符号链接，而 `source.tar.gz` 里有 11 个
    仓库内镜像（`CLAUDE.md → AGENTS.md`、`.claude/skills`、`snapshots/*`）。复制一份内容
    效果相同且不需要任何权限；指向解压目录之外的链接不做。
    """
    done: list[str] = []
    try:
        with tarfile.open(archive, "r:gz") as tf:
            members = list(tf.getmembers())
    except (OSError, tarfile.TarError):
        return done
    root = project.resolve()
    for m in members:
        if not m.issym():
            continue
        dst = project / m.name
        if dst.exists():
            continue
        src = (dst.parent / m.linkname).resolve()
        if not src.exists() or (src != root and root not in src.parents):
            continue
        try:
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        except OSError:
            continue
        done.append(m.name)
    return done


def extract_source_archive(project: Path, archive: Path, log) -> list[str]:
    """解压离线源码包；返回用复制补齐的镜像链接列表。

    tar 的返回码不能直接当结论：`source.tar.gz` 里有 11 个仓库内镜像链接，非管理员且未开
    开发者模式的 Windows 上 bsdtar 一律建不了它们（`Can't create …: Invalid argument`），
    但源码内容本身是完整的——只看返回码会让「一键完整安装」的默认路径（自动→离线）整条走
    不通。所以按**内容是否完整**判断，再把这些链接复制一份补上。
    """
    project.mkdir(parents=True, exist_ok=True)
    log("  解压随包源码 …")
    proc = run(["tar", "-xzf", str(archive), "-C", str(project)])
    if proc.returncode == 0:
        return []
    detail = decode_proc(proc).strip()
    tops = _archive_top_names(archive)
    missing = sorted(n for n in tops if not (project / n).exists())
    if not tops or missing:
        why = ("源码包列不出内容（包可能损坏或不完整）" if not tops
               else "缺少顶层内容：" + "、".join(missing[:6]))
        raise InstallError(f"源码解压失败（{why}）：\n{detail}")
    log("  ⚠ 解压报了错（Windows 建不了符号链接），源码内容完整，继续")
    fixed = fill_missing_links(project, archive)
    if fixed:
        log(f"  已用复制补齐 {len(fixed)} 个镜像链接："
            + "、".join(fixed[:3]) + ("…" if len(fixed) > 3 else ""))
    if detail:
        log("  tar 原话：" + detail.splitlines()[0])
    return fixed


def _shallow_dirs(root: Path, limit: int = SHALLOW_LIMIT) -> list[Path]:
    """一层子目录（跳系统目录、限量）——只用于有限探测，不遍历整盘。"""
    skip = {"$recycle.bin", "system volume information", "windows", "program files",
            "program files (x86)", "programdata", "recovery", "node_modules", ".git"}
    out: list[Path] = []
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if len(out) >= limit:
                    break
                try:
                    if entry.is_dir() and entry.name.lower() not in skip:
                        out.append(Path(entry.path))
                except OSError:
                    continue
    except OSError:
        return []
    return out


def detect_installed_dir(*, refresh: bool = False) -> Path | None:
    """自动找出机器上**已经装好**的 DSH 检出。

    顺序：小助手自身所在检出（小助手常被直接放进那份安装里）→ 用户目录下常见命名 →
    各盘根下的常见命名及其**再一层**（覆盖 E:\\Deepseek\\deepseek_harness 这类）。
    结果按进程缓存：探测只需做一次，之后每次调用都是读缓存。
    """
    if _DETECT_CACHE and not refresh:
        return _DETECT_CACHE[0]
    found = _detect_uncached()
    _DETECT_CACHE[:] = [found]
    return found


def _detect_uncached() -> Path | None:
    """便宜且高命中的候选先查，费时的逐盘浅扫放最后（受 DETECT_BUDGET_S 限制）。"""
    deadline = time.monotonic() + DETECT_BUDGET_S
    here = HERE.resolve()
    for up in (here.parent, here.parent.parent, here.parent.parent.parent):
        if is_checkout(up):
            return up
    for name in INSTALL_DIR_NAMES:
        if is_checkout(INSTALL_BASE / name):
            return INSTALL_BASE / name
    for drive in _drive_roots():
        if time.monotonic() > deadline:
            break
        for name in INSTALL_DIR_NAMES:
            if is_checkout(drive / name):
                return drive / name
        if is_checkout(drive / "DSH" / SOURCE_DIR_NAME):
            return drive / "DSH" / SOURCE_DIR_NAME
        for sub in _shallow_dirs(drive):
            if time.monotonic() > deadline:
                break
            if is_checkout(sub):        # 目录名任意（如 E:\Deepseek\deepseek_harness）
                return sub
            for name in INSTALL_DIR_NAMES:
                if is_checkout(sub / name):
                    return sub / name
    return None


def project_dir() -> Path:
    """实际安装位，优先级：

    界面当前选择 → 配置里的**真实**安装（是 DSH 检出）→ 机器上自动检测到的已安装
    → 配置里的空位（将要安装到哪）→ 方案 A 默认。

    配置若指向一个空目录，不让它掩盖机器上已经装好的那份——否则用户会看到
    「尚未安装」而以为自己得重装。
    """
    if _ACTIVE_DIR is not None:
        return _ACTIVE_DIR
    raw = str(load_config().get("installDir", "")).strip()
    saved = Path(os.path.expandvars(raw)).expanduser() if raw else None
    if saved is not None and is_checkout(saved):
        return saved
    found = detect_installed_dir()
    if found is not None:
        return found
    if saved is not None:
        return saved
    return default_project_dir()


def last_used_dir() -> tuple[Path, str]:
    """「上次使用的位置」及其来源说明。

    顺序：配置里记住的安装位 → 机器上自动检测到的已安装 → 方案 A 默认。
    用途是那个【回到上次位置】按钮——以前不管什么情况都跳回 C 盘默认值
    （`%USERPROFILE%\\deepseek-harness`），把装在别的盘上的那份位置丢了：
    那既不是「默认」也不是「上次」。
    """
    raw = str(load_config().get("installDir", "")).strip()
    if raw:
        saved = Path(os.path.expandvars(raw)).expanduser()
        if is_checkout(saved) or _nonempty_dir(saved):
            return saved, "配置里记住的位置"
    found = detect_installed_dir()
    if found is not None:
        return found, "自动识别到的已安装目录"
    return default_project_dir(), "方案 A 默认位置"


def set_active_dir(path: Path | None) -> None:
    """记录界面**当前**选定的安装位；立即对自检/运行/插件生效，不必先点安装。"""
    global _ACTIVE_DIR
    if path is None:
        _ACTIVE_DIR = None
        return
    _ACTIVE_DIR = Path(os.path.expandvars(str(path))).expanduser()


def set_project_dir(path: Path) -> None:
    """记住用户选定的安装位（写入小助手自己的配置，不动 DSH 配置）。"""
    save_config({"installDir": str(path)})


def check_install_dir(path: Path) -> tuple[list[str], list[str]]:
    """校验安装位，返回 (errors, warnings)：errors 阻断，warnings 提示但可继续。"""
    errors: list[str] = []
    warns: list[str] = []
    if not path.is_absolute():
        return ["必须是绝对路径（如 D:\\DSH\\deepseek-harness）"], warns
    text = str(path)
    low = text.lower().rstrip("\\")
    if low.endswith(":\\windows") or "\\windows\\" in low:
        errors.append("不能装在 Windows 系统目录内")
    if "program files" in low:
        errors.append("不能装在 Program Files（需要管理员权限，且构建会失败）")
    if path.exists() and not path.is_dir():
        errors.append("该路径已被同名文件占用")
    probe = path if path.exists() else (path.parent if path.parent.exists() else None)
    if probe is not None:
        if not os.access(probe, os.W_OK):
            errors.append(f"没有写入权限：{probe}")
        free = free_gb(probe)
        if 0 <= free < MIN_FREE_GB:
            warns.append(f"所在磁盘仅剩 {free:.1f} GB（建议 ≥ {MIN_FREE_GB:.0f} GB）")
    if len(text) > 120:
        warns.append(f"路径偏长（{len(text)} 字符），node_modules 深层可能触及 Windows 260 上限")
    if " " in text:
        warns.append("路径含空格，个别工具链可能出问题")
    if any(ord(ch) > 127 for ch in text):
        warns.append("路径含中文等非 ASCII 字符，个别工具链可能出问题")
    if "onedrive" in low:
        warns.append("路径在 OneDrive 同步目录内，构建会产生大量同步流量")
    return errors, warns


def find_git() -> str | None:
    """git 可执行文件；clone 插件/源码都依赖它。"""
    try:
        return shutil.which("git")
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- engine
BROWSER_CHOICES = ("默认浏览器", "Microsoft Edge", "Google Chrome",
                   "QQ 浏览器", "Mozilla Firefox", "自定义…")


def plugin_home() -> Path:
    """DSH 家目录：优先 $env:DSH_HOME，其次 ~/.dsh（产品默认位）。"""
    return Path(os.environ["DSH_HOME"]) if os.environ.get("DSH_HOME") \
        else Path.home() / ".dsh"


def web_clock_overlay(project: Path) -> Path | None:
    """plugins/time-context 时钟 overlay；profile 层已挂 time-context 或文件缺失时不附加。

    time-context 以持久行进入 web 补丁（任何来源）即视为已挂载 → 返回 None，
    避免 `--patch` 双挂（去双挂）。未挂载且示例 overlay 存在时保持向后兼容。
    """
    overlay = project / "plugins" / "time-context" / "cordis.patch.yml"
    if not overlay.exists():
        return None
    try:
        home_patch = pstore.web_patch(plugin_home())
        if home_patch.exists() and "dsh-time-context" in \
                home_patch.read_text(encoding="utf-8"):
            return None
    except OSError:
        pass
    return overlay


def browser_exe(choice: str) -> str | None:
    """把下拉选项解析成常见安装位置的浏览器 exe；找不到返回 None。"""
    pf = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    pf86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    local = Path(os.environ.get("LocalAppData",
                                str(Path.home() / "AppData" / "Local")))
    table = {
        "Microsoft Edge": [pf86 / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                           pf / "Microsoft" / "Edge" / "Application" / "msedge.exe"],
        "Google Chrome": [pf / "Google" / "Chrome" / "Application" / "chrome.exe",
                          pf86 / "Google" / "Chrome" / "Application" / "chrome.exe",
                          local / "Google" / "Chrome" / "Application" / "chrome.exe"],
        "QQ 浏览器": [pf86 / "Tencent" / "QQBrowser" / "QQBrowser.exe",
                     pf / "Tencent" / "QQBrowser" / "QQBrowser.exe",
                     local / "Tencent" / "QQBrowser" / "QQBrowser.exe"],
        "Mozilla Firefox": [pf / "Mozilla Firefox" / "firefox.exe",
                            pf86 / "Mozilla Firefox" / "firefox.exe"],
    }
    for candidate in table.get(choice, []):
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def open_in_browser(choice: str, custom_exe: str | None, url: str) -> str:
    """用所选浏览器打开 url；返回给人看的结果文本。"""
    if choice == "自定义…":
        if not custom_exe or not os.path.isfile(custom_exe):
            return "失败：尚未选择自定义浏览器 exe"
        return _spawn_browser(custom_exe, url)
    exe = browser_exe(choice)
    if exe:
        return _spawn_browser(exe, url)
    if os.name == "nt":
        try:
            os.startfile(url)
            return "已用系统默认浏览器打开"
        except Exception as exc:  # noqa: BLE001
            return f"失败：默认浏览器打开出错：{exc}"
    import webbrowser
    webbrowser.open(url)
    return "已调用默认浏览器打开"


def _spawn_browser(exe: str, url: str) -> str:
    """用指定浏览器打开 url——**不进 Job、不被关窗带走**。

    先带 `CREATE_BREAKAWAY_FROM_JOB` 起：本进程若在 Job 里（例如被别的 Job 包着），
    不带它的话浏览器会继承那个 Job，关窗时连人家别的标签页一起被杀。带 BREAKAWAY
    在"根本不在任何 Job 里"的环境会直接失败，所以失败后退回普通启动——退不回才是真的
    打不开页面。
    """
    for flags in (childproc.detached_creation_flags(), 0):
        try:
            subprocess.Popen([exe, url], close_fds=True, creationflags=flags)
            return f"已用 {Path(exe).name} 打开"
        except OSError as exc:
            if flags == 0:
                return f"失败：{exc}"
        except Exception as exc:  # noqa: BLE001
            return f"失败：{exc}"
    return "失败：未知错误"


def web_command(pnpm: str, project: Path) -> str:
    """`dsh web` 的启动命令（`.CMD` 必须经 cmd 用 call 执行）。

    **必带 `--no-open`**：`dsh web` 默认自己会去开浏览器（web-app 的 `openBrowser`
    默认 true），而它跑在我们**登记进 Job 的进程树**里——那个浏览器会继承 Job，于是
    用户关掉小助手时，连整台浏览器（含他所有标签页）一起被杀。关掉它的自动开页，
    改由小助手自己开（`_spawn_browser`，会显式 breakaway），行为一样但不牵连用户的浏览器。
    """
    cmdline = f'call "{pnpm}" dsh web --no-open'
    overlay = web_clock_overlay(project)
    if overlay is not None:
        cmdline += f' --patch "{overlay}"'
    return cmdline


class InstallError(RuntimeError):
    pass


class Engine:
    """核心安装流程：由 worker 线程执行，log 回调发回 UI。"""

    def __init__(self, mode: str, use_mirror: bool, log=log_line,
                 force: bool = False):
        self.mode = mode                # "auto" | "offline" | "online"
        self.use_mirror = use_mirror
        self.log = log
        self.force = force              # 上次被打断过：不再看「已存在就跳过」，重做依赖与构建
        self.registry = REGISTRY_MIRROR if use_mirror else REGISTRY_OFFICIAL

    @staticmethod
    def describe_assets() -> list[tuple[str, Path, bool]]:
        return [
            ("Node 安装包", NODE_MSI_ASSET, NODE_MSI_ASSET.exists()),
            ("pnpm 离线包", PNPM_TGZ_ASSET, PNPM_TGZ_ASSET.exists()),
            ("离线源码包", SOURCE_ARCHIVE, SOURCE_ARCHIVE.exists()),
            ("依赖缓存", STORE_DIR, STORE_DIR.exists()),
        ]

    def use_offline(self, has_asset: bool, what: str) -> bool:
        """按模式决定这一步用离线还是网络；缺离线数据时给清晰信息。"""
        if self.mode == "offline":
            if not has_asset:
                raise InstallError(f"离线模式缺少「{what}」，无法继续。请把完整离线数据放入 assets/，或改用自动/在线。")
            self.log(f"[离线] {what}：使用随包离线数据")
            return True
        if self.mode == "auto":
            if has_asset:
                self.log(f"[自动] {what}：有离线数据，走离线")
                return True
            self.log(f"[自动] {what}：无离线数据，走网络")
            return False
        self.log(f"[在线] {what}：走网络")
        return False

    def check_env(self) -> dict[str, object]:
        self.log("① 检查系统…")
        arch = os.environ.get("PROCESSOR_ARCHITECTURE", "")
        osname = os.environ.get("OS", "Windows")
        if "64" not in arch:
            raise InstallError(f"仅支持 64 位 Windows（当前：{osname} / {arch}）")
        self.log(f"  系统：{osname} {arch}   管理员权限：{'是' if is_admin() else '否'}")

        node = find_node()
        pnpm = find_pnpm()
        self.log(f"  Node：{node or '未检测到'}")
        self.log(f"  pnpm：{pnpm or '未检测到'}")
        return {"node": node, "pnpm": pnpm, "arch": arch, "os": osname}

    def install_node(self, env: dict[str, object]) -> str | None:
        node = env.get("node") or find_node()
        if node:
            ver = run_text([node, "--version"]).strip()
            self.log(f"② Node.js 已就绪：{node} ({ver})，跳过安装")
            return None
        self.log("② 安装 Node.js …")
        offline = self.use_offline(NODE_MSI_ASSET.exists(), "Node 安装包")
        msi: Path
        if offline:
            msi = NODE_MSI_ASSET
        else:
            self.log("  下载官方 Node.js（约 35MB）…")
            import urllib.request
            dload = HERE / "downloads"
            dload.mkdir(exist_ok=True)
            msi = dload / "node-v24-x64.msi"
            try:
                urllib.request.urlretrieve(NODE_MSI_URL, str(msi))
            except Exception as exc:  # noqa: BLE001
                raise InstallError(f"Node 下载失败：{exc}") from exc
        self.log("  静默安装（如弹出系统权限确认，请点【是】）…")
        # 故意**不**走 childproc：MSI 的真正安装动作由 Windows Installer 服务完成
        # （那不是我们的子进程），客户端被中途杀掉只会让它回滚或留下半装的 Node；
        # 它还可能弹 UAC，提权后的进程也不在我们的 Job 里。所以这条既不进 Job、
        # 也不进关窗清理——让它自己跑完或自己回滚，比打断它安全。装完若界面已关，
        # 下次「一键完整安装」会重新检测到 Node 并接着往下走。
        proc = subprocess.run(["msiexec", "/i", str(msi), "/qn", "/norestart"],
                              capture_output=True)
        if proc.returncode not in (0, 3010):
            raise InstallError(f"msiexec 安装 Node 失败（退出码 {proc.returncode}）：\n{decode_proc(proc)}")
        npx = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe"
        if not npx.exists():
            npx = Path(r"C:\Program Files\nodejs\node.exe")
        if not npx.exists():
            raise InstallError("Node 装完但找不到 node.exe，请手动确认安装路径")
        # 让后续子进程看得到新装的 node / npm
        os.environ["PATH"] = str(npx.parent) + os.pathsep + os.environ.get("PATH", "")
        self.log(f"  Node.js 安装完成：{npx.parent}")
        return str(npx.parent)

    def install_pnpm(self) -> str | None:
        if find_pnpm():
            self.log("③ pnpm 已就绪，跳过安装")
            return None
        self.log("③ 安装 pnpm …")
        # 这一步只在"机器上还没有 pnpm"时才走到——也就是真正需要它的新机器上。
        # npm / corepack 在 Windows 上是 .cmd 批处理，裸名字交给 CreateProcess 会
        # FileNotFoundError（实测），必须先解析出全路径再调用。
        npm = find_npm()
        if npm is None:
            raise InstallError(
                "找不到 npm，无法安装 pnpm。\n"
                "请先安装 Node.js（本流程的第 ② 步会自动装），再重试。")
        offline = self.use_offline(PNPM_TGZ_ASSET.exists(), "pnpm 离线包")
        spec = str(PNPM_TGZ_ASSET) if offline else "pnpm@11.7.0"
        proc = run([npm, "install", "-g", spec])
        if proc.returncode != 0:
            raise InstallError(f"pnpm 安装失败：\n{decode_proc(proc)}")
        corepack = shutil.which("corepack")
        if corepack:
            done = run([corepack, "enable"])
            if done.returncode != 0:
                self.log("  （corepack enable 未生效，不影响：已有 pnpm 可用）")
        self.log("  pnpm 安装完成")
        return find_pnpm()

    def prepare_source(self) -> Path:
        project = project_dir()
        # 先让真 git 复核一次（官方链接是最强辨识），再退回文件判定
        ident = verify_install_dir(project)
        if ident.ok:
            self.log(f"④ 已确认现有 DSH：{project}（{ident.evidence}）")
            return project
        # 有 package.json 却不是 DSH 检出 = 用户自己的项目。绝不能在这里跑
        # pnpm install/build（会改动/污染无关项目），必须让用户换目录。
        if (project / "package.json").exists():
            raise InstallError(
                f"{project}\n"
                "这个目录里有 package.json，但它不是一个 DSH 检出。\n"
                "为避免在无关项目里执行 pnpm 安装/构建，安装已中止。\n"
                "请把「安装位置」换成空目录，或指向已装好的 DeepSeek Harness 目录。\n"
                "如果它其实是你自己改过的 DSH（例如包名全改了），可以先点【运行】试跑一次：\n"
                "能打开网页就说明确实是，我会把它记下来，之后就能直接复用。")
        self.log(f"④ 准备项目源码 → {project}")
        offline = self.use_offline(
            SOURCE_ARCHIVE.exists() or STORE_DIR.exists(),
            "源码包/依赖缓存")
        if offline and SOURCE_ARCHIVE.exists():
            # 与在线分支同等的前置检查：非空、又没有 DSH 身份的目录一律不碰。
            # 以前这里没有检查，解压会直接铺进用户选中的目录并覆盖同名文件
            # （实测：用户自己的 README.md 被改成官方 README，随后该目录还会通过
            # `is_checkout`，于是 pnpm install/build 就在用户目录里跑起来）。
            if _nonempty_dir(project):
                raise _nonempty_target_error(project, offline=True)
            extract_source_archive(project, SOURCE_ARCHIVE, self.log)
            mode = "offline"
        else:
            if _nonempty_dir(project):
                raise _nonempty_target_error(project, offline=False)
            git = find_git()
            if git is None:
                raise InstallError(
                    "未检测到 git，无法克隆官方源码。\n"
                    "请先安装 Git for Windows（https://git-scm.com/download/win），"
                    "或改用『离线安装』（需随包 source.tar.gz）。")
            self.log(f"  git clone 官方源码（取决于网络）…（git: {git}）")
            project.parent.mkdir(parents=True, exist_ok=True)
            proc = run([git, "clone", "--depth", "1", HARNESS_GIT_URL, str(project)])
            if proc.returncode != 0:
                raise InstallError(f"git clone 失败：\n{decode_proc(proc)}")
            mode = "online"
        if not is_checkout(project):
            raise InstallError("源码就绪但不是 DSH 检出（缺 package.json/"
                               "pnpm-workspace.yaml），安装中止")
        # 写下标记：离线解压的目录没有 .git，靠它才能被认出来；同时绑定官方链接
        write_install_marker(project, mode)
        self.log(f"  源码就绪：{project}（已写入安装标记 {INSTALL_MARKER}）")
        return project

    def install_deps(self, project: Path, *, force: bool = False) -> None:
        if not force and (project / "node_modules").exists():
            self.log("⑤ node_modules 已存在，跳过依赖安装")
            return
        self.log("⑤ 安装项目依赖 …")
        offline = self.use_offline(STORE_DIR.exists(), "依赖缓存")
        argv: list[str] = ["pnpm", "install", "--frozen-lockfile"]
        if offline:
            argv += ["--offline", "--store-dir", str(STORE_DIR)]
        else:
            argv += ["--registry", self.registry]
        self.log("  执行：" + " ".join(argv))
        proc = run_cli(argv, cwd=project)
        if proc.returncode != 0:
            raise InstallError(f"依赖安装失败：\n{decode_proc(proc)}")
        self.log("  依赖安装完成（离线模式几十秒，在线模式视网速）")

    def build(self, project: Path, *, force: bool = False) -> None:
        if not force and (project / BUILD_MARK).exists():
            self.log("⑥ 构建产物已存在，跳过 pnpm run build")
            return
        self.log("⑥ 编译项目（本地编译、不联网；首次约 5–15 分钟）…")
        proc = run_cli(["pnpm", "run", "build"], cwd=project)
        if proc.returncode != 0:
            raise InstallError(f"构建失败：\n{decode_proc(proc)}")
        self.log("  构建完成 ✓")

    def start(self, project: Path) -> None:
        self.log(f"⑦ 启动 Web UI（{WEB_URL}）…")
        argv: list[str] = ["pnpm", "dsh", "web"]
        overlay = web_clock_overlay(project)
        if overlay is not None:
            argv += ["--patch", str(overlay)]
        proc = run_cli(argv, cwd=project)
        if proc.returncode != 0:
            raise InstallError(f"启动失败：\n{decode_proc(proc)}")

    def run_full(self, headless: bool = False, start: bool = True) -> None:
        """执行完整安装流程。headless=True 时日志打 console；start 控制是否自动启动服务。"""
        env = self.check_env()
        self.install_node(env)
        self.install_pnpm()
        project = self.prepare_source()
        self.install_deps(project, force=self.force)
        self.build(project, force=self.force)
        clear_interrupted(project)      # 依赖与构建都过了，恢复常态
        if start:
            self.start(project)
        else:
            self.log("…安装/构建完成（未自动启动）；可点『运行』开始使用")


# ---------------------------------------------------------------- GUI
def bind_wheel_tree(root: tk.Misc, handler) -> None:
    """给 root 及其所有子控件挂滚轮（每个控件只挂一次）。

    不用 `bind_all`：那是整个解释器共用的**一个槽**，本程序的插件列表也在用，
    一方 `unbind_all` 会把另一方的滚轮一起摘掉（评审实测过）。
    """
    stack = [root]
    while stack:
        widget = stack.pop()
        if not getattr(widget, "_wheel_bound", False):
            widget._wheel_bound = True
            widget.bind("<MouseWheel>", handler, add="+")
        stack.extend(widget.winfo_children())


def plugin_source_dir(card, home: Path | None, project: Path | None) -> Path | None:
    """插件行的源码目录（打包发行与校验都用它）。

    官方插件行（`@deepseek-ai/*`）不给：那不是你的代码，谈不上重新发行。
    """
    if home is None or getattr(card, "first_party", False):
        return None
    return pstore.find_plugin_source(home, card.slug, project=project,
                                     extra=getattr(card, "source", None))


def plugin_src_label(kind: str, state: str) -> str:
    """插件行的「来源」短标签。

    状态词全页统一（已启用／已停用／已下载／未下载）之后，靠这一列区分它是
    本地补丁行、在线包（bundle）还是还没下载的内置清单项——以前是拿状态词兼职
    说明来源（「已启用·外部(只读)」这种），同一件事三种说法。
    """
    if kind == "catalog":
        return "内置清单"
    if kind == "bundle":
        return "在线包"
    if state == "downloaded":
        return "已下载"
    if state in ("first_party", "first_party-disabled"):
        return "内置插件·你加的"
    if state in ("external", "external-disabled"):
        return "本地补丁·你写的"
    return "本地补丁·助手管理"


class App(tk.Tk):
    #: 默认窗口大小；大屏上按屏幕再放大一点（日志栏宽一点更好看），并居中显示。
    WIDTH, HEIGHT = 1000, 720

    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        width = min(1180, max(self.WIDTH, self.winfo_screenwidth() - 640))
        height = min(860, max(self.HEIGHT, self.winfo_screenheight() - 360))
        x = max(0, (self.winfo_screenwidth() - width) // 2)
        y = max(0, (self.winfo_screenheight() - height) // 3)
        self.geometry(f"{width}x{height}+{x}+{y}")
        self.minsize(760, 600)
        self.mode = tk.StringVar(value="auto")
        self.mirror = tk.BooleanVar(value=True)
        self.busy = False
        self.web_proc: subprocess.Popen | None = None
        self.web_dir: Path | None = None
        self.web_auth_url: str | None = None
        self.custom_browser: str | None = None
        self._open_pending = False
        self._auto_opened = False
        self._open_deadline = 0.0
        # --- 插件区（v0.1）状态 ---
        self.plugin_home_dir: Path | None = None
        self.plugin_project: Path | None = None
        self.plugin_cards: list[pstore.PluginCard] = []
        self.plugin_pending: dict[str, str] = {}
        self.plugin_busy = False
        self.web_tail: deque[str] = deque(maxlen=500)
        self.rollback_armed = False
        self._activation_checks = 0
        # --- 会话迁移（v0.1）状态 ---
        self.mig_busy = False
        self.mig_rows: list[dict[str, str]] = []
        # --- 版本与更新（真 git 命令）状态 ---
        self.git_busy = False
        #: 正在安装/更新的目标目录。关窗时用它写「被打断」标记——现场算
        #: `project_dir()` 会被「用户随手改了路径框」带偏，把标记写到别的目录上。
        self._op_target: str | None = None
        self._git_after: str | None = None
        self._closing = False
        # 还没被确认身份、正在靠「试跑」定案的目录（跑成功就记进安装标记）
        self._unconfirmed_dir: Path | None = None
        # 工作线程 → 界面线程的唯一安全通道（见 _post）
        self._ui_queue: queue.Queue = queue.Queue()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(400, self._refresh_plugins)
        self.after(60, self._drain_ui_queue)
        self._schedule_git_refresh(600)

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)

        ttk.Label(root, text=APP_TITLE,
                  font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
        ttk.Label(root, text="自动：检测环境 → Node → pnpm → 源码 → 依赖 → 构建 → 打开网页版",
                  foreground="#555").pack(anchor="w", pady=(0, 6))

        # 分页：安装与启动 / 插件 / 会话迁移
        nb = ttk.Notebook(root)
        nb.pack(fill="both", expand=True, pady=(2, 0))
        tab_run = ttk.Frame(nb, padding=8)
        nb.add(tab_run, text="安装与启动")
        tab_plug = ttk.Frame(nb, padding=8)
        nb.add(tab_plug, text="插件")
        tab_mig = ttk.Frame(nb, padding=8)
        nb.add(tab_mig, text="会话迁移")

        # ---------------- Tab 1：安装与启动 ----------------
        # 两栏：左边操作区（窄、可滚轮），右边日志（宽、占满高度）。
        # 之前全竖着堆，固定块吃掉 546px，日志被挤到 3px——终端输出等于看不见。
        # 用 Panedwindow 装两栏，中间那条竖线可以拖着调宽窄，拖完记住（双击回到默认）。
        self._wrap_labels = []
        cols = ttk.Panedwindow(tab_run, orient="horizontal")
        cols.pack(fill="both", expand=True)
        left_outer, left, canvas, left_bar = self._scrollable(cols, width=saved_left_col_width())
        cols.add(left_outer, weight=0)

        # 安装位置（可配置；默认方案 A：%USERPROFILE%\deepseek-harness）
        loc = ttk.LabelFrame(left, text="安装位置（产品会独立克隆到这里）", padding=8)
        loc.pack(fill="x")
        lrow = ttk.Frame(loc)
        lrow.pack(fill="x")
        self.dir_var = tk.StringVar(value=str(project_dir()))
        dir_ent = ttk.Entry(lrow, textvariable=self.dir_var)
        dir_ent.pack(side="left", fill="x", expand=True)
        # 位置只在回车/失焦时才切换（敲键盘只更新下面的提示），避免误碰一下就跑偏
        dir_ent.bind("<FocusOut>", self._on_dir_committed)
        dir_ent.bind("<Return>", self._on_dir_committed)
        ttk.Button(lrow, text="浏览…", command=self._on_pick_dir).pack(side="left", padx=(6, 0))
        ttk.Button(lrow, text="回到上次位置",
                   command=self._on_reset_dir).pack(side="left", padx=(6, 0))
        self.dir_hint = ttk.Label(loc, text="", foreground="#666", justify="left",
                                  wraplength=WRAP_LEFT)
        self.dir_hint.pack(anchor="w", pady=(4, 0))
        self._wrap_labels.append(self.dir_hint)
        self.dir_var.trace_add("write", self._on_dir_changed)
        self._on_dir_changed()

        # 大按钮（最常用；终端输出在右侧日志区）
        btns = ttk.Frame(left)
        btns.pack(fill="x", pady=(6, 0))
        self.btn_full = ttk.Button(btns, text="一键完整安装", command=self.on_full)
        self.btn_full.pack(fill="x", ipady=3)
        brow = ttk.Frame(left)
        brow.pack(fill="x", pady=(4, 0))
        self.btn_term = ttk.Button(brow, text="运行", command=self.on_terminal)
        self.btn_term.pack(side="left", fill="x", expand=True, ipady=3)
        self.btn_stop = ttk.Button(brow, text="⏹ 停止服务", command=self.on_stop_terminal,
                                   state="disabled")
        self.btn_stop.pack(side="left", fill="x", expand=True, padx=(6, 0), ipady=3)

        # 版本与更新（结论全部来自真实 git 命令，不解析 .git 里的文本）
        gbox = ttk.LabelFrame(left, text="版本与更新（由 git 校验）", padding=8)
        gbox.pack(fill="x", pady=(6, 0))
        self.git_info_lbl = ttk.Label(gbox, text="（正在读取 git 信息…）",
                                      foreground="#666", justify="left",
                                      wraplength=WRAP_LEFT)
        self.git_info_lbl.pack(anchor="w")
        self._wrap_labels.append(self.git_info_lbl)
        grow = ttk.Frame(gbox)
        grow.pack(fill="x", pady=(4, 0))
        self.btn_git_refresh = ttk.Button(grow, text="刷新信息", width=10,
                                          command=self.on_git_refresh)
        self.btn_git_refresh.pack(side="left")
        self.btn_git_update = ttk.Button(grow, text="检查更新", width=10,
                                         command=self.on_check_update)
        self.btn_git_update.pack(side="left", padx=(6, 0))
        self.btn_git_apply = ttk.Button(grow, text="更新到最新", width=11,
                                        command=self.on_update_now)
        self.btn_git_apply.pack(side="left", padx=(6, 0))
        self.git_note = ttk.Label(gbox, text="检查更新需要联网", foreground="#888",
                                  font=("Microsoft YaHei UI", 8), justify="left",
                                  wraplength=WRAP_LEFT)
        self.git_note.pack(anchor="w", pady=(4, 0))
        self._wrap_labels.append(self.git_note)

        # 安装方式（可折叠：装好之后基本不用动；标题上始终显示当前选择）
        # 只有「本助手装过的目录」才默认收起——不然在本仓库里跑（工具就在检出内）
        # 会判定成「已装好」而对所有人默认收起，小白第一眼看不到安装方式。
        self.mode_title = tk.StringVar()
        installed_by_us = bool(read_install_marker(project_dir()))
        mbody = self._collapsible(left, self.mode_title, expanded=not installed_by_us)
        # 离线数据的有无放在折叠块**外面**：小白必须看得见「没检测到离线数据、会联网」
        hints = Engine.describe_assets()
        hint_txt = "已检测到离线数据：" if any(f for _, _, f in hints) else "未检测到离线数据（将走网络）："
        marks = "  ".join(f"{'✓' if ok else '—'}{name}" for name, _path, ok in hints)
        asset_lbl = ttk.Label(left, text=f"{hint_txt}\n{marks}", foreground="#666",
                              justify="left", wraplength=WRAP_LEFT)
        asset_lbl.pack(anchor="w", pady=(6, 0))
        self._wrap_labels.append(asset_lbl)
        for value, text in (
                ("auto", "自动选择（推荐）"),
                ("offline", "离线安装——完全不依赖网络"),
                ("online", "在线安装——从网络源下载")):
            ttk.Radiobutton(mbody, text=text, variable=self.mode, value=value,
                            command=self._refresh_mode_title).pack(anchor="w")
        ttk.Checkbutton(mbody, text="在线安装时使用国内镜像 npmmirror 加速",
                        variable=self.mirror).pack(anchor="w")
        # 说明放在可换行的灰字里：ttk 的单选/复选文字不支持换行，长了会被裁掉
        mode_hint = ttk.Label(mbody, text="自动选择＝有离线数据就走离线，缺的自动联网补。",
                              foreground="#666", justify="left", wraplength=WRAP_LEFT)
        mode_hint.pack(anchor="w", pady=(4, 0))
        self._wrap_labels.append(mode_hint)
        self._refresh_mode_title()

        # 打开与复制（可折叠：日常偶尔用，收起来给日志让位）
        obody = self._collapsible(left, "打开与复制（选浏览器 → 打开登录页 / 复制）",
                                  expanded=True)
        brow2 = ttk.Frame(obody)
        brow2.pack(fill="x")
        ttk.Label(brow2, text="浏览器：").pack(side="left")
        self.browser_var = tk.StringVar(value="默认浏览器")
        self.browser_box = ttk.Combobox(brow2, textvariable=self.browser_var,
                                        values=BROWSER_CHOICES, state="readonly", width=18)
        self.browser_box.pack(side="left", padx=(0, 4))
        self.browser_box.bind("<<ComboboxSelected>>", self._on_browser_pick)
        self.custom_hint = ttk.Label(brow2, text="", foreground="#666")
        self.custom_hint.pack(side="left")
        orow = ttk.Frame(obody)
        orow.pack(fill="x", pady=(4, 0))
        self.btn_open_page = ttk.Button(orow, text="打开登录页", command=self.on_open_page)
        self.btn_open_page.pack(side="left", fill="x", expand=True, ipady=2)
        self.btn_copy_url = ttk.Button(orow, text="复制登录地址", command=self.on_copy_url,
                                       state="disabled")
        self.btn_copy_url.pack(side="left", fill="x", expand=True, padx=(6, 0), ipady=2)
        self.btn_copy_path = ttk.Button(orow, text="复制项目路径", command=self.on_copy_path)
        self.btn_copy_path.pack(side="left", fill="x", expand=True, padx=(6, 0), ipady=2)

        # 日志（终端）——右栏，负责吃掉所有剩余空间。
        # width=LOG_COL_MIN 是**硬下限**：ttk 8.6 的 pane 不支持 minsize，所以让日志框
        # 自己请求这个宽度，初始布局就不会把它压成一条缝（剩下的余量按 weight 全给它）。
        lf = ttk.LabelFrame(cols, text="日志（终端输出实时显示在此）", width=LOG_COL_MIN)
        cols.add(lf, weight=1)

        # 中间的竖线：拖动即调宽窄；拖完夹回合理区间并记住，双击回到默认。
        # 记的是「左栏内容宽度」（不含滚动条占位），下次启动直接用它建画布，
        # 位置能原样还原，不会每开一次就涨一点。
        # 窗口**每次改变大小**都要重夹一遍：限位是按窗口宽度算的，只夹拖动那一刻的话，
        # 把窗口缩小会让左栏不让位、把日志栏压到几十像素。
        # `<Map>` 也要接：上屏那一刻的 `<Configure>` 才算数（之前的 winfo_width() 全是 1）。
        self._skip_sash_save = False
        clamp = lambda: self._apply_left_width(cols, canvas, left_bar)      # noqa: E731
        cols.bind("<Configure>", lambda _e: clamp())
        cols.bind("<Map>", lambda _e: clamp())
        cols.bind("<ButtonRelease-1>", lambda _e: self._release_sash(cols, canvas, left_bar))
        cols.bind("<Double-Button-1>",
                  lambda _e: self._reset_left_col(cols, canvas, left_bar))
        # height/width 只是「至少这么大」；width 用小值，别让文本宽度反过来撑大窗口
        self.txt = tk.Text(lf, height=20, width=20, wrap="word",
                           font=("Microsoft YaHei UI", 9), state="disabled")
        sb = ttk.Scrollbar(lf, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.txt.pack(fill="both", expand=True)
        # 只读用 state 锁：拦按键的写法挡不住 Tk 自带的 Ctrl+H/D/K/O/T/I（实测能删字、
        # 插换行与制表符，且没有 undo）。锁上之后鼠标选择与复制/全选照常可用。
        self.txt.bind("<Button-3>", self._log_popup)
        # 右键菜单只建一次：每次右键新建 tk.Menu 会一直挂在 self.children 上泄漏
        self._log_menu = tk.Menu(self, tearoff=0)
        self._log_menu.add_command(label="复制选中", command=self._log_copy_sel)
        self._log_menu.add_command(label="复制全部", command=self._log_copy_all)

        # ---------------- Tab 2：插件 ----------------
        self._build_plugin_ui(tab_plug)

        # ---------------- Tab 3：会话迁移 ----------------
        self._build_migrate_ui(tab_mig)

        self.status = ttk.Label(root, text="就绪", foreground="#1a6b1a")
        self.status.pack(anchor="w", pady=(6, 0))

        self._append("欢迎！安装/启动/服务日志在「安装与启动」页；插件管理在「插件」页；"
                     "会话迁移（换 preset）在「会话迁移」页。")
        self.log = self._append

    def _post(self, fn, *args) -> None:
        """把回调交给**界面线程**执行——工作线程更新界面必须走这里。

        tkinter 的 `after()` 不是线程安全的：在子线程里调用会抛
        「main thread is not in main loop」，并发时还可能破坏 Tcl 解释器；
        而过去的写法把它包在 `except` 里，于是日志/状态更新被**静默丢掉**。
        `queue.Queue` 是线程安全的，取出与执行都发生在界面线程。
        """
        self._ui_queue.put((fn, args))

    def _drain_ui_queue(self) -> None:
        """界面线程侧：取出并执行工作线程投递的回调（每轮限量，避免饿死界面）。"""
        for _ in range(50):
            try:
                fn, args = self._ui_queue.get_nowait()
            except queue.Empty:
                break
            try:
                fn(*args)
            except Exception as exc:  # noqa: BLE001  单个回调出错不该拖垮整个队列
                log_line(f"[界面] 回调失败：{exc}")
        if not self._closing:
            self.after(60, self._drain_ui_queue)

    def _append(self, msg: str) -> None:
        """追加一行日志（界面线程里执行；工作线程经 _post 调用）。

        两个细节：① 只读 Text 靠 `state` 锁，插入时才临时解锁；② 用户往上翻看历史
        时不要把他拽回底部，只有本来就在底部才自动跟随。行数也有上限，长时间跑
        `pnpm install` / `dsh web` 不会把控件撑爆。
        """
        def write() -> None:
            at_bottom = self.txt.yview()[1] > 0.999
            self.txt.configure(state="normal")
            self.txt.insert("end", str(msg) + "\n")
            if int(self.txt.index("end-1c").split(".")[0]) > LOG_MAX_LINES:
                self.txt.delete("1.0", f"end-{LOG_MAX_LINES}lines")
            self.txt.configure(state="disabled")
            if at_bottom:
                self.txt.see("end")
        self._post(write)

    def _log_popup(self, e) -> None:
        try:
            self._log_menu.tk_popup(e.x_root, e.y_root)
        finally:
            self._log_menu.grab_release()

    def _log_copy_sel(self) -> None:
        try:
            txt = self.txt.get("sel.first", "sel.last")
        except Exception:  # noqa: BLE001
            txt = ""
        if not txt:
            self._log_copy_all()
            return
        self.clipboard_clear()
        self.clipboard_append(txt)
        self._status("已复制选中内容")

    def _log_copy_all(self) -> None:
        try:
            txt = self.txt.get("1.0", "end-1c")
        except Exception:  # noqa: BLE001
            txt = ""
        self.clipboard_clear()
        self.clipboard_append(txt or "（空）")
        self._status("已复制全部日志")

    def _plog(self, msg: str) -> None:
        """插件操作消息：UI 日志区 + installer.log 双写。"""
        log_line(msg)
        self._append(msg)

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.btn_full.configure(state=state)
        for b in getattr(self, "_plugin_btns", ()):
            try:
                b.configure(state="disabled" if busy or self.plugin_busy else "normal")
            except Exception:  # noqa: BLE001
                pass
        self._set_git_buttons(not busy)        # 安装期间不许碰 git（同一目录会打架）
        self.btn_open_page.configure(state=state)
        self._update_run_buttons()

    def _update_run_buttons(self) -> None:
        """「运行」与「停止服务」互斥：运行中=运行灰、停止可用；否则反之。

        长任务（安装/更新/插件/迁移）进行中不许点【运行】：那时 `node_modules` 正
        在被写，起来也会撞上文件锁。
        """
        def apply() -> None:
            try:
                running = self.web_proc is not None and self.web_proc.poll() is None
                self.btn_term.configure(
                    state="disabled" if (running or self._long_task_running()) else "normal")
                self.btn_stop.configure(
                    state="normal" if (running and not self.busy) else "disabled")
            except Exception:  # noqa: BLE001
                pass
        try:
            running = self.web_proc is not None and self.web_proc.poll() is None
            self.btn_term.configure(
                state="disabled" if (running or self._long_task_running()) else "normal")
            self.btn_stop.configure(
                state="normal" if (running and not self.busy) else "disabled")
        except Exception:  # noqa: BLE001  窗口销毁后控件不可用，忽略即可
            pass
        self._post(apply)

    def _status(self, text: str, color: str = "#1a6b1a") -> None:
        def setit() -> None:
            self.status.configure(text=text, foreground=color)
        self._post(setit)

    def on_full(self) -> None:
        if self.busy or self.git_busy or self.plugin_busy or self.mig_busy:
            # 安装和更新会往同一个 node_modules 里写：必须互斥，否则两个 pnpm 打架
            messagebox.showinfo("有任务在进行",
                                "正在进行的任务结束之后再开始安装。", parent=self)
            return
        target = self._current_dir()
        errors, warns = check_install_dir(target)
        if errors:
            messagebox.showerror(
                "安装位置不可用",
                "当前安装位置有问题，请先修改：\n\n" +
                "\n".join(f"· {e}" for e in errors), parent=self)
            return
        if warns and not messagebox.askyesno(
                "安装位置提醒",
                f"安装位置：{target}\n\n" +
                "\n".join(f"· {w}" for w in warns) +
                "\n\n仍要继续吗？", parent=self):
            return
        set_project_dir(target)
        self._append(f"[安装位置] {target}")
        # 点安装时用真 git 复核一次（约 0.2 秒），确认到底是复用还是全新装
        ident = verify_install_dir(target)
        self._append(f"[安装位置] {'✓ ' + ident.evidence if ident.ok else '尚未安装，将全新装到这里'}")
        self._set_busy(True)
        # 记下本次装到哪：关窗时用它写「被打断」标记，不用现场算 project_dir()
        self._op_target = str(target)
        retry = install_was_interrupted(target)
        if retry:
            self._append("[安装位置] 上次安装被中途关窗打断过，这次重新装依赖并重新构建")
        eng = Engine(mode=self.mode.get(), use_mirror=self.mirror.get(),
                     log=self._append, force=retry)
        threading.Thread(target=self._job, args=(eng,), daemon=True).start()

    def _current_dir(self) -> Path:
        raw = self.dir_var.get().strip()
        return Path(os.path.expandvars(raw)).expanduser() if raw else default_project_dir()

    def _effective_dir(self) -> Path:
        """生效的安装位：输入框有值就用它，空则交回正常优先级（配置/检测/默认）。"""
        raw = self.dir_var.get().strip()
        return Path(os.path.expandvars(raw)).expanduser() if raw else project_dir()

    def _on_dir_changed(self, *_args) -> None:
        """输入框内容一变：**只更新提示**，不改变实际使用的位置。

        位置只在回车/失焦（`_on_dir_committed`）时才生效——否则误碰一下键盘，
        后面的「运行 / 自检 / 插件」就全指向另一个目录了（实测过：改一下就启动不起来）。
        """
        self._dir_hint()

    def _on_dir_committed(self, _event=None) -> None:
        """回车或点别处 = 位置定下来（生效 + 记住）。

        从「已经能用的 DSH」改到「认不出是 DSH 的目录」时先问一句（默认退回原位置）：
        这类改动多半是误碰，改完就启动不起来了。
        """
        raw = self.dir_var.get().strip()
        if not raw:                       # 清空 = 交回自动识别（保持原语义）
            set_active_dir(None)
            self._dir_hint()
            self._schedule_git_refresh()
            return
        target = self._current_dir()
        previous = project_dir()          # 提交前「实际生效」的那个目录
        if self._looks_like_accident(previous, target) and not messagebox.askyesno(
                "确认修改安装位置？",
                f"原来的位置：{previous}\n（已装好，能直接用）\n\n"
                f"新位置：{target}\n（这里还认不出 DSH 安装）\n\n"
                "改完之后【运行】【自检】【插件】都会换成新位置。\n"
                "如果只是想换个地方重新装一份，选「是」；如果是误碰，选「否」退回原位置。",
                parent=self, default="no"):
            self.dir_var.set(str(previous))          # 撤回
            self._dir_hint()
            return
        set_active_dir(target)
        set_project_dir(target)
        self._dir_hint()
        self._schedule_git_refresh(400)

    @staticmethod
    def _looks_like_accident(previous: Path, target: Path) -> bool:
        """是不是「从一个能用的安装改到一个认不出的目录」。"""
        if previous == target:
            return False
        if not is_checkout(previous):
            return False                 # 原来也不像 DSH：属于正常的新装/换位置
        return not is_checkout(target)

    @staticmethod
    def _normalize_picked(chosen: Path) -> Path:
        """选中的目录**直接采用**；只有选到盘根时才补默认名，绝不擅自改名。"""
        if is_checkout(chosen):
            return chosen
        for name in INSTALL_DIR_NAMES:
            if is_checkout(chosen / name):
                return chosen / name
        if chosen.parent == chosen:                 # 盘根，如 E:\
            return chosen / SOURCE_DIR_NAME
        return chosen

    def _on_pick_dir(self) -> None:
        base = self._effective_dir()
        picked = filedialog.askdirectory(
            title="选择 DSH 安装位置（已装好的目录会被自动识别）", parent=self,
            initialdir=str(base if base.exists() else base.parent))
        if not picked:
            return
        chosen = self._normalize_picked(Path(picked))
        self.dir_var.set(str(chosen))               # 只更新提示，不动生效目录
        self._on_dir_committed()                    # 选目录就是明确确认

    def _on_reset_dir(self) -> None:
        """回到**上次使用的位置**（配置记住的 → 自动识别到的 → 方案 A 默认）。

        以前不管什么情况都跳回 C 盘默认值，用户装在别的盘上的那份位置就被丢了。
        """
        target, why = last_used_dir()
        self.dir_var.set(str(target))
        set_active_dir(target)
        set_project_dir(target)
        self._dir_hint()
        self._schedule_git_refresh(400)
        self._status(f"已回到上次使用的位置（{why}）：{target}")

    def _dir_hint(self, _event=None) -> None:
        """即时反馈：红=不能装，橙=可装有风险，绿=已装好/可用（最多 2 条提示）。"""
        target = self._current_dir()
        errors, warns = check_install_dir(target)
        why = checkout_identity(target)
        if errors:
            text, color = "✗ " + errors[0], "#b00000"
        elif why:
            text, color = f"✓ 已检测到已安装的 DSH（{why}），将直接使用", "#1a6b1a"
        elif _nonempty_dir(target):
            text = "？这里有内容，但认不出是 DSH —— 可以先点【运行】试跑确认"
            color = "#a05a00"
        elif warns:
            shown = "；".join(warns[:2]) + ("…" if len(warns) > 2 else "")
            text, color = "⚠ " + shown, "#a05a00"
        else:
            probe = target if target.exists() else (
                target.parent if target.parent.exists() else INSTALL_BASE)
            free = free_gb(probe)
            text = (f"✓ 可用（所在磁盘剩余 {free:.0f} GB）→ 将安装到这里"
                    if free >= 0 else "✓ 可用 → 将安装到这里")
            color = "#1a6b1a"
        # 改了但还没确认：明确说一句此刻尚未生效（位置只在回车/失焦时才切换）
        if self.dir_var.get().strip() and target != project_dir():
            text += "　（改动尚未生效：按回车或点别处才切换）"
            if color != "#b00000":
                color = "#a05a00"
        self.dir_hint.configure(text=text, foreground=color)

    # ---------------- 版本与更新（结论全部来自真实 git 命令）----------------

    def _schedule_git_refresh(self, delay: int = 400) -> None:
        """输入变化后延迟跑一次 git 探测（一次约 0.2 秒，不能每敲一键就跑）。

        可能被工作线程调用（登录地址是在读日志的线程里捕获的），所以排期统一
        交给界面线程做——tkinter 的 after 只允许主线程调用。
        """
        self._post(self._arm_git_refresh, delay)

    def _arm_git_refresh(self, delay: int) -> None:
        """界面线程侧：取消上一次待跑的，重排一次。"""
        if self._closing:
            return
        if self._git_after is not None:
            try:
                self.after_cancel(self._git_after)
            except Exception:  # noqa: BLE001  窗口已销毁时 after_cancel 会报错
                pass
        self._git_after = self.after(delay, self.on_git_refresh)

    def on_git_refresh(self) -> None:
        self._git_after = None
        if self.git_busy or self.busy or self._closing:
            return
        target = self._effective_dir()
        self.git_busy = True
        self._set_git_buttons(False)
        threading.Thread(target=self._git_info_worker, args=(target,),
                         daemon=True).start()

    def _git_info_worker(self, target: Path) -> None:
        try:
            info = ginfo.repo_info(target)
            ident = verify_install_dir(target, info)
        except Exception as exc:  # noqa: BLE001  git 层的任何意外都不该卡住界面
            self._post(self._git_error, str(exc))
            return
        self._post(self._show_git_info, info, ident)

    def _git_error(self, message: str) -> None:
        self.git_busy = False
        self._set_git_buttons(True)
        self._set_label(self.git_info_lbl, f"读取失败：{message}", "#b00000")

    def _show_git_info(self, info, ident: ginfo.DshIdentity) -> None:
        self.git_busy = False
        self._set_git_buttons(True)
        if not ident.ok:
            suspect = ident.tier == "suspect"
            head = "？无法确认是不是 DSH" if suspect else "✗ 未确认是 DSH 安装"
            self._set_label(self.git_info_lbl, f"{head}：{ident.evidence}",
                            "#a05a00" if suspect else "#b00000")
            return
        bits: list[str] = []
        if info.version:
            bits.append(f"版本 v{info.version}")
        if info.short:
            day = info.committed_at[:10]
            bits.append(f"提交 {info.short}" + (f"（{day}）" if day else ""))
        if info.branch:
            bits.append(f"分支 {info.branch}")
        bits.append("工作区干净" if info.dirty == 0 else f"工作区有 {info.dirty} 处本地改动")
        if info.upstream and not info.shallow:
            bits.append(f"相对 {info.upstream}：领先 {info.ahead} / 落后 {info.behind}")
        lines = [" · ".join(bits)]

        # 分支跟踪的远端若不是官方，就说清「更新从哪来」，别让人以为在跟官方同步
        if info.upstream:
            tracked = ginfo.tracking_remote(info)
            url = info.remotes.get(tracked, "")
            if url and not ginfo.official_remote({tracked: url}):
                lines.append(f"更新来源：{info.upstream}（{url}，非官方 —— 官方更新需自行合并）")
        lines.append(f"依据：{ident.evidence}")
        color = {"official": "#1a6b1a", "unofficial": "#a05a00"}.get(ident.tier, "#666")
        self._set_label(self.git_info_lbl, "\n".join(lines), color)

    def _set_label(self, widget, text: str, color: str) -> None:
        try:
            widget.configure(text=text, foreground=color)
        except Exception:  # noqa: BLE001  结果回来时窗口可能已被关闭
            pass

    def _set_git_buttons(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for btn in (self.btn_git_refresh, self.btn_git_update, self.btn_git_apply):
            try:
                btn.configure(state=state)
            except Exception:  # noqa: BLE001  同上：窗口可能已销毁
                pass

    def on_check_update(self) -> None:
        """联网 `git fetch` 后与远端比较——落后多少个提交是 git 算出来的。"""
        if self.git_busy or self.busy or self._closing:
            return
        target = self._effective_dir()
        self.git_busy = True
        self._set_git_buttons(False)
        self._set_label(self.git_note, "正在联网检查更新…", "#a05a00")
        threading.Thread(target=self._check_update_worker, args=(target,),
                         daemon=True).start()

    def _check_update_worker(self, target: Path) -> None:
        try:
            status = ginfo.check_update(target)
        except Exception as exc:  # noqa: BLE001  git 层意外 → 如实显示失败原因
            status = ginfo.UpdateStatus(ok=False, error=str(exc))
        self._post(self._show_update_status, status)

    def _show_update_status(self, status) -> None:
        self.git_busy = False
        self._set_git_buttons(True)
        if not status.ok:
            self._set_label(self.git_note, f"检查失败：{status.error}", "#b00000")
            return
        if status.behind == 0:
            text, color = "✓ 已是最新", "#1a6b1a"
        else:
            extra = (f"（最新 {status.latest} {status.latest_subject}）"
                     if status.latest else "")
            text, color = f"⚠ 落后 {status.behind} 个提交{extra}", "#a05a00"
        if status.ahead:
            text += f"；本地领先 {status.ahead} 个提交"
        where = status.upstream or status.remote
        if where:
            text += f"　·　{where}"
            if not status.official:
                text += "（非官方远端）"
        self._set_label(self.git_note, text, color)

    def on_update_now(self) -> None:
        """把安装目录**快进**到远端最新，再重装依赖、重新构建。"""
        if self.git_busy or self.busy:
            return
        target = self._effective_dir()
        info = ginfo.repo_info(target)
        ident = verify_install_dir(target, info)
        if not ident.ok:
            messagebox.showerror("无法更新", f"{target}\n\n{ident.evidence}", parent=self)
            return
        if info.dirty:
            messagebox.showwarning(
                "无法更新",
                f"工作区有 {info.dirty} 处本地改动。\n\n"
                "为避免覆盖你自己的改动，请先提交或撤销这些改动，再更新。",
                parent=self)
            return
        if not messagebox.askyesno(
                "更新到最新",
                f"目录：{target}\n"
                f"当前：{info.short}（分支 {info.branch}）\n"
                f"写法：git fetch → 只做快进（不产生合并提交，也不动你已提交的内容）\n"
                f"之后：重装依赖 → 重新构建（首次较慢）\n\n继续吗？",
                parent=self):
            return
        # 服务在跑就先停：Windows 上 node_modules 里的文件被占用时无法被替换
        was_running = self.web_proc is not None and self.web_proc.poll() is None
        if was_running:
            self._stop_web_internal(quiet=False)
        self.git_busy = True
        self._op_target = str(target)      # 更新也是长任务：关窗要认得出目标目录
        self._set_git_buttons(False)
        self._set_label(self.git_note, "正在更新…（进度见下方日志）", "#a05a00")
        mirror = bool(self.mirror.get())           # Tk 变量只在界面线程读
        threading.Thread(target=self._update_worker,
                         args=(target, was_running, mirror), daemon=True).start()

    def _update_worker(self, target: Path, was_running: bool, mirror: bool) -> None:
        eng = Engine(mode="auto", use_mirror=mirror, log=self._append)
        try:
            self._append(f"[更新] 正在比对 {target} 与远端 …")
            res = ginfo.update_repo(target)
            if not res.ok:
                self._post(self._update_done, False, res.error, was_running)
                return
            if not res.changed:
                self._append("[更新] 已是最新，无需更新。")
                self._post(self._update_done, True, "已是最新", was_running)
                return
            self._append(f"[更新] 已快进 {res.before} → {res.after}：{res.subject}")
            self._append("[更新] 源码有变化，重新装依赖并重新构建 …")
            eng.install_deps(target, force=True)
            eng.build(target, force=True)
            clear_interrupted(target)   # 更新跑完了，取消「上次被打断」的标记
        except Exception as exc:  # noqa: BLE001  依赖/构建失败原因要如实报给用户
            self._post(self._update_done, False, str(exc), was_running)
            return
        self._post(self._update_done, True, f"{res.before} → {res.after}", was_running)

    def _update_done(self, ok: bool, detail: str, was_running: bool) -> None:
        self.git_busy = False
        self._op_target = None
        self._set_git_buttons(True)
        if not ok:
            self._append(f"[更新] ✗ 更新失败：{detail}")
            if was_running:
                self._append("[更新] 服务已停止（更新前在运行）；"
                             "处理完上面的问题后点【运行】重新启动。")
            self._set_label(self.git_note, f"更新失败：{detail}", "#b00000")
            return
        self._append(f"[更新] ✓ 更新完成：{detail}")
        self._set_label(self.git_note, f"✓ 更新完成（{detail}）", "#1a6b1a")
        self._schedule_git_refresh(200)
        if was_running:
            self._append("[更新] 服务原本在运行，正在重新启动 …")
            self.on_terminal()

    def _job(self, eng: Engine) -> None:
        """安装/构建的工作线程：碰界面一律经 _post（tkinter 不是线程安全的）。"""
        try:
            self._status("安装进行中…", "#b36b00")
            # start=False：服务改由界面线程用 _launch_web 启动。Engine.start 是阻塞的
            # （pnpm dsh web 会一直跑到服务结束），在这里调它会让 busy 一直为真——
            # 停止按钮全程不可用，而且成功的安装还会被关窗逻辑记成「被打断」。
            eng.run_full(headless=False, start=False)
            self._status("完成 ✓ 正在启动网页版…", "#1a6b1a")
            self._post(self._launch_web)          # 输出照样实时进日志区
            self._post(messagebox.showinfo, "完成",
                       "安装完成！\n网页服务正在启动，点【打开登录页】即可进入。")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            self._append(f"\n✗ 失败：{msg}")
            self._status("失败 ✗（详情见日志，可复制反馈）", "#b00000")
            self._post(messagebox.showerror, "操作失败", msg)
        finally:
            self._op_target = None                # 长任务结束，关窗不再算它
            self.busy = False                     # 立刻生效，按钮不用多禁用一会儿
            self._post(self._set_busy, False)     # 界面线程侧刷新按钮

    def _resolve_web_project(self) -> Path | None:
        """可运行的项目目录：界面当前选择/配置/自动检测到的已安装位。

        只认「DSH 检出」；仓库根兜底仅在显式开发态开启（本机开发用）。
        """
        cands = [project_dir(), default_project_dir()]
        if os.environ.get("DSH_ASSISTANT_DEV") == "1":
            cands.append(HERE.parent.parent)
        seen: set[Path] = set()
        for cand in cands:
            if cand in seen:
                continue
            seen.add(cand)
            if is_checkout(cand):
                return cand
        return None

    def on_terminal(self) -> None:
        """在 GUI 内嵌运行 dsh web：输出实时进入日志区，可点停止。"""
        if self.web_proc is not None and self.web_proc.poll() is None:
            messagebox.showinfo("已在运行",
                                "dsh web 已在本窗口运行；可用「打开登录页」再次打开。")
            return
        self._launch_web()

    def _launch_web(self) -> bool:
        """启动内嵌 dsh web（stdout 流式进日志）。返回是否成功启动。"""
        project = self._resolve_web_project()
        if project is None:
            project = self._offer_unconfirmed_run()
            if project is None:
                return False
        if shutil.which("pnpm") is None:
            # 还没真跑就退出：清掉「等运行验证」的标记，否则下次在**别的**目录跑成功
            # 会把刚记下的这个旧目录写成 verifiedByRun
            self._unconfirmed_dir = None
            messagebox.showerror("缺少 pnpm",
                                 "未检测到 pnpm。请先执行「一键完整安装」。")
            return False
        self._append(f"[终端] 工作目录：{project}")
        self._append("[终端] 启动 dsh web；输出会实时显示在这里…")
        self.web_dir = project
        self.web_auth_url = None
        self._update_web_buttons()
        pnpm = find_pnpm() or shutil.which("pnpm.cmd") or "pnpm"
        self._auto_opened = False         # 本次启动是否已自动开过页面（见 _on_auth_url）
        cmdline = web_command(pnpm, project)
        try:
            proc = subprocess.Popen(
                cmdline,
                cwd=str(project),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                shell=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as exc:  # noqa: BLE001
            self._unconfirmed_dir = None      # 同样：没跑起来就不该留下验证标记
            messagebox.showerror("启动失败", str(exc))
            self._append(f"[终端] ✗ 启动失败：{exc}")
            return False
        self.web_proc = proc
        childproc.track(proc)           # 登记进 Job：就算本进程被强杀，它也会跟着结束
        self._update_run_buttons()
        self._status("dsh web 运行中（输出见日志区）", "#1a6b1a")
        threading.Thread(target=self._pump_web, args=(proc,), daemon=True).start()
        return True

    def on_open_page(self) -> None:
        """打开登录页：未运行时先启动内嵌 dsh web，登录地址就绪后弹所选浏览器。"""
        if self.busy:
            return
        running = self.web_proc is not None and self.web_proc.poll() is None
        if not running and not self._launch_web():
            return
        self._open_pending = True
        self._open_deadline = time.monotonic() + 120.0
        self._poll_pending_open()

    def _poll_pending_open(self) -> None:
        """等待登录地址出现后用所选浏览器打开；失败/超时则取消并提示。"""
        if not self._open_pending:
            return
        if self.web_auth_url:
            self._open_pending = False
            self._open_selected_browser(self.web_auth_url)
            return
        alive = self.web_proc is not None and self.web_proc.poll() is None
        if not alive or time.monotonic() > self._open_deadline:
            self._open_pending = False
            self._append("[浏览器] 未能捕获登录地址（服务未运行或超时）。"
                         "请点『运行』后重试。")
            self._status("未捕获登录地址", "#b00000")
            return
        self.after(400, self._poll_pending_open)

    def _offer_unconfirmed_run(self) -> Path | None:
        """两条身份证据都不成立时：**先提醒，再由用户决定要不要试跑**。

        「能不能真的跑起来」比读包名更硬：`pnpm dsh web` 只有在目录里确实是 DSH 时
        才打得开网页。跑成功 → 记进安装标记（运行验证通过），以后直接认；跑失败 →
        说明它不是，原因就摆在日志里。
        """
        target = project_dir()
        ident = verify_install_dir(target)
        if ident.tier != "suspect":
            messagebox.showerror(
                "未找到项目",
                f"找不到已安装的 deepseek-harness。请先执行「一键完整安装」。\n"
                f"已检查：{target}")
            return None
        if not messagebox.askyesno(
                "不确定这是不是 DSH",
                f"目录：{target}\n\n{ident.evidence}\n\n"
                "要试着运行一次吗？能打开网页就说明它确实是 DSH，我会记下来，"
                "以后这个目录就直接按已安装处理；跑不起来就说明不是——"
                "失败原因会显示在日志里。", parent=self):
            return None
        self._unconfirmed_dir = target
        return target

    def _on_auth_url(self, url: str) -> None:
        """记录从 dsh web 输出里捕获的登录地址并刷新按钮状态。"""
        self.web_auth_url = url
        self._append("[浏览器] 已捕获登录地址，可『复制登录地址』或『打开登录页』。")
        # `dsh web` 现在带 --no-open 启动（见 web_command），所以自动开页由我们自己来：
        # 走 _post 到界面线程（这里本来就在工作线程里），并且用户按过【打开登录页】时跳过，
        # 免得开两个标签。
        if not self._open_pending and not self._auto_opened:
            self._auto_opened = True
            self._append("[浏览器] 自动打开登录页（你也可以关掉这个标签，"
                         "或改用界面上的按钮）。")
            self._post(lambda: self._open_selected_browser(url))
        # 网页真的起来了 = 运行验证通过（未确认过的目录在这一刻被定性）
        if self._unconfirmed_dir is not None:
            project, self._unconfirmed_dir = self._unconfirmed_dir, None
            if mark_run_verified(project):
                self._append(f"[运行验证] ✓ dsh web 真的跑起来了：{project}")
                self._append("[运行验证] 已记入安装标记 —— 以后这个目录会被直接认定为 DSH。")
                self._schedule_git_refresh(200)
            else:
                self._append("[运行验证] 服务跑起来了，但安装标记写不进去（目录不可写？），"
                             "下次仍需人工确认。")
        # 本方法由读日志的工作线程调用：界面更新一律走 _post
        self._post(self._update_web_buttons)
        self._post(self._poll_pending_open)

    def _open_selected_browser(self, url: str) -> None:
        message = open_in_browser(self.browser_var.get(), self.custom_browser, url)
        self._append(f"[浏览器] {message}")
        if message.startswith("失败"):
            self._status(message, "#b00000")
            messagebox.showerror("打开失败", message)
        else:
            self._status(message, "#1a6b1a")

    def on_copy_url(self) -> None:
        if not self.web_auth_url:
            messagebox.showinfo("暂无登录地址",
                                "请先启动内嵌 dsh web 并等待日志出现「dsh web: …」登录地址。")
            return
        self.clipboard_clear()
        self.clipboard_append(self.web_auth_url)
        self._append("[复制] 已复制登录地址。")
        self._status("已复制登录地址（可粘贴到任意浏览器）", "#1a6b1a")

    def on_copy_path(self) -> None:
        project = self._resolve_web_project()
        if project is None:
            messagebox.showerror("未找到项目",
                                 f"找不到已安装的 DSH；当前安装位置：{project_dir()}")
            return
        self.clipboard_clear()
        self.clipboard_append(str(project))
        self._append(f"[复制] 已复制项目路径：{project}")
        self._status("已复制项目路径", "#1a6b1a")

    def _on_browser_pick(self, _event=None) -> None:
        if self.browser_var.get() != "自定义…":
            self.custom_hint.configure(text="")
            return
        picked = filedialog.askopenfilename(title="选择浏览器程序（.exe）",
                                            filetypes=[("程序", "*.exe"), ("所有文件", "*.*")])
        if picked:
            self.custom_browser = picked
            self.browser_var.set("自定义…")
            self.custom_hint.configure(text=Path(picked).name)
            self._append(f"[浏览器] 已选：{picked}")
        else:
            self.browser_var.set("默认浏览器")
            self.custom_hint.configure(text="")

    def _update_web_buttons(self) -> None:
        def apply() -> None:
            try:
                self.btn_copy_url.configure(
                    state="normal" if self.web_auth_url else "disabled")
            except Exception:  # noqa: BLE001  窗口销毁后控件不可用，忽略即可
                pass
        self._post(apply)

    def _pump_web(self, proc: subprocess.Popen) -> None:
        """后台读子进程 stdout，转 UI 日志；顺带捕获登录地址；退出后复位状态。"""
        try:
            assert proc.stdout is not None
            for raw in iter(proc.stdout.readline, b""):
                if not raw:
                    break
                text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if text:
                    self.web_tail.append(text)
                    self._append("[终端] " + text)
                    m = re.search(r"dsh web: (\S+)", text)
                    if m is not None and self.web_auth_url is None:
                        self._on_auth_url(m.group(1))
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
            self._append("[终端] dsh web 已退出（详情看上面日志）。")
            if self._unconfirmed_dir is not None:
                self._unconfirmed_dir = None
                self._append("[运行验证] ✗ 没能跑起来 —— 这个目录不是能用的 DSH 安装"
                             "（原因见上面的日志）。")
            if self.web_proc is proc:
                self.web_proc = None
            self.web_auth_url = None
            childproc.untrack(proc)
            # 这里是**工作线程**（读子进程输出那个）：碰界面一律走 _post 队列。
            # 直接用 after()/控件方法在别的线程里不是线程安全的。
            self._post(self._update_web_buttons)
            self._post(self._poll_pending_open)
            self._post(self._update_run_buttons)
            self._post(self._status, "就绪")

    def on_stop_terminal(self) -> None:
        """终止窗口内运行的 dsh web（连同其子进程树）。"""
        self._stop_web_internal(quiet=False)

    def _stop_web_internal(self, quiet: bool = True) -> None:
        """停掉内嵌 dsh web；quiet=False 时写日志/改状态。"""
        proc = self.web_proc
        if proc is None or proc.poll() is not None:
            if not quiet:
                self._append("[终端] 当前没有运行中的服务。")
                self._update_run_buttons()
            return
        if not quiet:
            self._append("[终端] 正在停止 dsh web …")
        childproc.kill_tree(proc)       # 连子孙一起：只杀 cmd 的话 node 会留下来占端口
        self.web_proc = None
        self.web_auth_url = None
        self._update_web_buttons()
        if not quiet:
            self._append("[终端] 已停止。")
            self._update_run_buttons()
            self._status("已停止")

    # ------------------------------------------------------------------ 插件区

    # 状态词全页统一：本地插件与在线包用同一套说法（来源另用一列标明），
    # 以前本地行说「已启用·外部(只读)」、在线包说「已安装」，同一件事三种说法。
    STATE_CN = {
        "enabled": "已启用",
        "disabled": "已停用",
        "external": "已启用",
        "external-disabled": "已停用",
        "installed": "已启用",
        "bundle-off": "已停用",
        "first_party": "内置",
        "first_party-disabled": "内置·停用",
        "downloaded": "已下载",
        "nodl": "未下载",
    }
    STATE_COLOR = {
        "enabled": "#1a6b1a", "external": "#1a6b1a", "installed": "#1a6b1a",
        "first_party": "#666", "downloaded": "#a06700", "nodl": "#999",
        "disabled": "#888", "external-disabled": "#888", "bundle-off": "#a05a00",
        "first_party-disabled": "#888",
    }

    def _scrollable(self, parent, *,
                    width: int) -> tuple[ttk.Frame, ttk.Frame, tk.Canvas, ttk.Scrollbar]:
        """把一块区域做成**可滚轮滚动**的，返回 `(外层, 装内容的框, 画布, 滚动条)`。

        ttk 没有现成的滚动容器，标准做法是 Canvas 里嵌一个 Frame。滚轮逐个控件绑定
        （不用全局 `bind_all`，那是整个解释器共用的一个槽，插件列表也在用）。
        """
        outer = ttk.Frame(parent)
        bg = ttk.Style().lookup("TFrame", "background") or "#f0f0f0"
        canvas = tk.Canvas(outer, width=width, highlightthickness=0, borderwidth=0, bg=bg)
        bar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        inner = ttk.Frame(canvas)
        window = canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.configure(yscrollcommand=bar.set)
        # 滚动条先占位（pack 按顺序分配空间）：栏被拖窄时也不会把它挤没
        bar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)

        inner.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))

        def wheel(event) -> None:
            canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
            return "break"

        def refit(event) -> None:
            canvas.itemconfigure(window, width=event.width)
            self._fit_wraps(event.width)          # 栏宽变了，长文字的换行宽度跟着变
            bind_wheel_tree(inner, wheel)         # 新出现的子控件也挂上滚轮

        canvas.bind("<Configure>", refit)
        return outer, inner, canvas, bar

    def _fit_wraps(self, width: int) -> None:
        """左栏里的长文字按当前栏宽换行（拖动中间的竖线时也要跟着变）。"""
        wrap = max(200, width - 34)
        for label in getattr(self, "_wrap_labels", ()):
            if label.winfo_exists():
                label.configure(wraplength=wrap)

    def _sash_gap(self, bar: ttk.Scrollbar) -> int:
        """第一栏里滚动条占掉的宽度（`sashpos(0)` 比画布多出来的那点）。

        **不能**用「sashpos 减画布宽度」去算：窗口还没上屏时任何 `winfo_width()`
        都是 1，那样算出来的占位是「整栏宽 - 1」，夹取会把竖线写到离谱的位置。
        滚动条自己的宽度与上屏无关，问它最稳。
        """
        try:
            width = bar.winfo_width()
            return width if width > 1 else max(1, bar.winfo_reqwidth())
        except tk.TclError:          # 正在销毁
            return 17

    def _max_content_width(self, cols: ttk.Panedwindow, gap: int) -> int:
        """当前窗口宽度下左栏内容最多能有多宽（日志栏要留得住）。"""
        room = cols.winfo_width() - gap - SASH_PX - LOG_COL_MIN
        return min(LEFT_COL_MAX, max(LEFT_COL_MIN, room))

    def _apply_left_width(self, cols: ttk.Panedwindow, canvas: tk.Canvas,
                          bar: ttk.Scrollbar, *,
                          want: int | None = None, save: bool = False) -> None:
        """把左栏宽度夹回合理区间（给了 want 就先设成它），必要时记进配置。

        夹的是「内容宽度」：`sashpos(0)` 是第一栏宽度（含滚动条占位），换算时补上
        `gap` 才对得上配置里的值。

        **没上屏就什么都不做**：那一刻所有 `winfo_width()` 都是 1，`sashpos` 也是
        布局前的初值，怎么写都是垃圾——必须等 `<Map>` 之后的那次 `<Configure>`。
        """
        try:
            if not cols.winfo_ismapped() or cols.winfo_width() <= 1 or canvas.winfo_width() <= 1:
                return
            gap = self._sash_gap(bar)
            content = (cols.sashpos(0) - gap) if want is None else want
            content = min(max(content, LEFT_COL_MIN), self._max_content_width(cols, gap))
            if cols.sashpos(0) != content + gap:
                cols.sashpos(0, content + gap)
            if save:
                save_config({"leftColWidth": content})
        except tk.TclError:          # 布局还没完成 / 窗口正在销毁
            return

    def _release_sash(self, cols: ttk.Panedwindow, canvas: tk.Canvas,
                      bar: ttk.Scrollbar) -> None:
        """拖动结束：夹回区间并记住（刚复位过则跳过，别覆盖复位写的值）。"""
        if self._skip_sash_save:
            self._skip_sash_save = False
            return
        self._apply_left_width(cols, canvas, bar, save=True)

    def _reset_left_col(self, cols: ttk.Panedwindow, canvas: tk.Canvas,
                        bar: ttk.Scrollbar) -> None:
        """双击中间的竖线：左栏宽度回到默认值，并记住这个默认值。

        双击在 Tk 里是 press/release/press/double-release——复位之后还会再来一个
        `<ButtonRelease-1>`，所以置个短标志，让那次收尾别把刚写下的默认值覆盖掉。
        存的是**默认值本身**（而不是夹后的值），这样窗口放大后还是回到 430。
        """
        self._skip_sash_save = True
        self._apply_left_width(cols, canvas, bar, want=LEFT_COL_WIDTH, save=False)
        save_config({"leftColWidth": LEFT_COL_WIDTH})

    def _collapsible(self, parent, title, *, expanded: bool = True) -> ttk.Frame:
        """可折叠区块：一行可点的标题 + 内容框；返回**内容框**。

        `title` 可以是字符串，也可以是 `tk.StringVar`（标题随状态变化时用，例如当前安装方式）。
        """
        state = {"open": expanded}
        head = ttk.Frame(parent)
        head.pack(fill="x", pady=(6, 0))
        arrow = ttk.Label(head, text="▾" if expanded else "▸", foreground="#1a4a8a",
                          cursor="hand2")
        arrow.pack(side="left")
        if isinstance(title, tk.StringVar):
            name = ttk.Label(head, textvariable=title, foreground="#1a4a8a", cursor="hand2")
        else:
            name = ttk.Label(head, text=title, foreground="#1a4a8a", cursor="hand2")
        name.pack(side="left", padx=(2, 0))
        body = ttk.Frame(parent)

        def toggle(_event=None) -> None:
            state["open"] = not state["open"]
            arrow.configure(text="▾" if state["open"] else "▸")
            if state["open"]:
                # 必须指定 after=head：pack 不带它的话是「追加到父控件末尾」，
                # 收起再展开会把这块内容搬到左栏最下面（实测过）。
                body.pack(fill="x", pady=(4, 0), after=head)
            else:
                body.pack_forget()

        for widget in (arrow, name):
            widget.bind("<Button-1>", toggle)
        if expanded:
            body.pack(fill="x", pady=(4, 0))
        return body

    def _refresh_mode_title(self) -> None:
        """折叠标题上始终显示当前安装方式，收起后也知道选的是哪个。"""
        self.mode_title.set(f"安装方式：{MODE_CN.get(self.mode.get(), self.mode.get())}")

    def _build_plugin_ui(self, root: ttk.Frame) -> None:
        box = ttk.LabelFrame(root, text="插件", padding=8)
        box.pack(fill="both", expand=True)
        bar = ttk.Frame(box)
        bar.pack(fill="x")
        ttk.Button(bar, text="重新扫描", command=self._refresh_plugins,
                   width=10).pack(side="left")
        ttk.Button(bar, text="从文件夹导入…", command=self._plugin_import,
                   width=14).pack(side="left", padx=6)
        ttk.Button(bar, text="复制清单", command=self._plugin_copy_list,
                   width=9).pack(side="left", padx=4)
        self.plugin_hint_lbl = ttk.Label(bar, text="扫描中…", foreground="#666")
        self.plugin_hint_lbl.pack(side="left", padx=6)
        # dsh 起不来（结构门跑不了）时亮起来：这时列表来自直接读补丁，禁用照样可用
        self.plugin_offline_lbl = ttk.Label(
            bar, text="", foreground="#a05a00", font=("Microsoft YaHei UI", 8))
        self.plugin_offline_lbl.pack(side="left")
        # 远程下载一行
        dl = ttk.Frame(box)
        dl.pack(fill="x", pady=(4, 0))
        ttk.Label(dl, text="链接下载：").pack(side="left")
        self.market_placeholder = "如 dshmarket / git 仓库 URL / npm 包名"
        self.market_spec = tk.StringVar()
        self.market_entry = ttk.Entry(dl, textvariable=self.market_spec, width=32)
        self.market_entry.pack(side="left", padx=2)
        self._placeholder(self.market_entry, self.market_placeholder)
        ttk.Button(dl, text="下载", width=6,
                   command=lambda: self._market_act("download")).pack(side="left", padx=4)
        # 滚动列表
        wrap = ttk.Frame(box)
        wrap.pack(fill="both", expand=True, pady=(6, 0))
        self.plugin_cv = tk.Canvas(wrap, highlightthickness=0)
        self.plugin_sb = ttk.Scrollbar(wrap, orient="vertical",
                                       command=self.plugin_cv.yview)
        self.plugin_cv.configure(yscrollcommand=self.plugin_sb.set)
        self.plugin_sb.pack(side="right", fill="y")
        self.plugin_cv.pack(side="left", fill="both", expand=True)
        self.plugin_rows = ttk.Frame(self.plugin_cv)
        self._plugin_cw = self.plugin_cv.create_window((0, 0), window=self.plugin_rows,
                                                       anchor="nw")
        self.plugin_rows.bind("<Configure>", self._plugin_scroll_update)
        self.plugin_cv.bind("<Configure>", self._plugin_canvas_width)
        self.plugin_cv.bind("<Enter>",
                            lambda e: self.plugin_cv.bind_all("<MouseWheel>",
                                                              self._on_plugin_wheel))
        self.plugin_cv.bind("<Leave>",
                            lambda e: self.plugin_cv.unbind_all("<MouseWheel>"))
        self.plugin_btns: list[ttk.Button] = []
        self.market_updates: dict[str, str] = {}
        self.plugin_note = ttk.Label(
            box,
            text="一行一个插件，状态词统一（已启用／已停用／已下载／未下载），"
                 "「来源」说明它是哪种插件：\n"
                 "　本地补丁·你写的／助手管理＝写 cordis.patch.yml 的本地插件；"
                 "在线包＝bundle；内置清单＝还没下载。\n"
                 "本地插件的安装/禁用/启用/卸载是草稿，点「全部保存并重启网页版」落盘；"
                 "在线插件即时生效，需重启网页版。两边都能【校验】。\n"
                 "排查启动冲突：【禁用】只把那一行停掉（写成官方 disabled: true）"
                 "或把 bundle 从 dsh.profile.bundles 摘掉，文件与依赖都留着，"
                 "【启用】立刻还原；你手写的「外部」行也能直接禁用，不必先接管。\n"
                 "【打包发行】把本地插件做成可发布的 bundle（改 manifest、生成包内配置层、"
                 "pnpm pack 出 tgz），只产出发行物，不发布、不动你的 profile。",
            foreground="#888", font=("Microsoft YaHei UI", 8), justify="left")
        self.plugin_note.pack(anchor="w", pady=(4, 0))
        # 反悔的两条路：撤销待办＝清内存草稿（不碰文件）；回滚＝把已落盘的改动退回 .bak
        save_row = ttk.Frame(box)
        save_row.pack(fill="x", pady=(2, 0))
        self.btn_rollback = ttk.Button(save_row, text="回滚到上次保存…",
                                       command=self._on_rollback, state="disabled")
        self.btn_rollback.pack(side="right")
        self.btn_undo = ttk.Button(save_row, text="撤销待办", command=self._clear_pending,
                                   state="disabled")
        self.btn_undo.pack(side="right", padx=(0, 6))
        self.btn_save = ttk.Button(save_row, text="全部保存并重启网页版",
                                   command=self.on_plugin_save, state="disabled")
        self.btn_save.pack(side="right", padx=(0, 6))
        self._plugin_btns = self.plugin_btns

    def _set_plugin_busy(self, busy: bool) -> None:
        self.plugin_busy = busy
        for b in self.plugin_btns:
            try:
                b.configure(state="disabled" if busy or self.busy else "normal")
            except Exception:  # noqa: BLE001
                pass
        for b, ok in ((self.btn_save, bool(self.plugin_pending)), (self.btn_undo, False)):
            try:
                b.configure(state="normal" if ok and not busy and not self.busy
                            else "disabled")
            except Exception:  # noqa: BLE001
                pass
        try:                              # 回滚按钮：有备份且不忙时可用（刷新时也会重设）
            has_bak = pstore.patch_backup_path(
                self.plugin_home_dir or plugin_home()).exists()
            self.btn_rollback.configure(state="normal" if has_bak and not busy
                                        and not self.busy else "disabled")
        except Exception:  # noqa: BLE001
            pass

    def _plugin_env(self) -> tuple[Path, Path] | None:
        home = plugin_home()
        project = self._resolve_web_project()
        if not home.exists() or not (home / "profiles" / "web").is_dir():
            self._append("[插件] DSH 环境未就绪：" + str(home))
            return None
        if project is None:
            self._append("[插件] 未找到项目目录，无法运行结构门 dump。")
            return None
        self.plugin_home_dir, self.plugin_project = home, project
        return home, project

    def _refresh_plugins(self) -> None:
        if self.plugin_busy:
            return
        threading.Thread(target=self._refresh_worker, daemon=True).start()

    def _plugin_sources(self, home: Path, project: Path | None):
        """插件来源集合：刷新与保存**必须共用同一份**，否则列表里有的插件保存时说找不到。

        开发态（DSH_ASSISTANT_DEV=1）额外把项目 plugins/ 算作来源。
        """
        dev = os.environ.get("DSH_ASSISTANT_DEV") == "1"
        return pstore.discover_sources(project if dev else None, ASSETS,
                                       pstore.plugin_cache_dir(home))

    def _refresh_worker(self) -> None:
        try:
            env = self._plugin_env()
            if env is None:
                self._post(lambda: self.plugin_hint_lbl.configure(text="环境未就绪"))
                return
            home, project = env
            sources = self._plugin_sources(home, project)
            patch_text = ""
            patch = pstore.web_patch(home)
            if patch.exists():
                patch_text = patch.read_text(encoding="utf-8")
            local_rows = None
            try:
                dump = pstore.structure_gate(home, patch_text, project=project)
            except Exception as exc:  # noqa: BLE001  GateError / 找不到 dsh / dump 超时
                # **降级**：结构门跑不了（多半是某个插件把 dsh 搞得起不来）时，
                # 改为直接读补丁把行列出来——否则插件页一片空白，用户就没有
                # 「禁用它试试」的入口了。禁用/启用本来就不需要 dsh 能跑。
                self._append(f"[插件] 结构门未过（{exc}）")
                self._append("[插件] 已改为直接读补丁列出插件行；禁用/启用仍可用（免校验）")
                dump = pstore.parse_dump("")
                local_rows = pstore.patch_rows(home)
            cards = pstore.status_view(home, sources, dump, local_rows=local_rows)
            entries = pstore.market_entries(home, project, ASSETS)
            catalog = pstore.catalog_entries(home)
            self._post(self._apply_plugins, cards, entries, home, project, catalog,
                       local_rows is not None)
        except Exception as exc:  # noqa: BLE001
            self._append(f"[插件] 刷新失败：{exc}")

    def _apply_plugins(self, cards, entries, home: Path, project: Path,
                       catalog=(), offline: bool = False) -> None:
        self.plugin_cards = cards
        self.plugin_home_dir, self.plugin_project = home, project
        self.plugin_catalog = {c["slug"]: c for c in catalog}
        # 哪些外部行真的能接管（带 config 的接不了）——决定要不要给【接管】按钮
        self.plugin_adoptable = pstore.adopt_report(home)
        try:
            self.plugin_offline_lbl.configure(
                text="⚠ dsh 当前起不来（结构门未过）：列表直接读自补丁，"
                     "禁用/启用免校验、立即写盘" if offline else "")
        except Exception:  # noqa: BLE001  窗口销毁后忽略
            pass
        items = self._merge_plugins(cards, entries, catalog, home, self.plugin_project)
        self.plugin_items = items
        for child in self.plugin_rows.winfo_children():
            child.destroy()
        self.plugin_btns.clear()
        if not items:
            ttk.Label(self.plugin_rows,
                      text="（没有插件：可点未下载插件的「下载」，"
                           "或用「从文件夹导入」「链接下载」添加）",
                      foreground="#888").pack(anchor="w")
            self.plugin_hint_lbl.configure(text="无插件")
        else:
            for it in items:
                row = ttk.Frame(self.plugin_rows)
                row.pack(fill="x", pady=1)
                self._render_plugin_row(row, it)
            self.plugin_hint_lbl.configure(text=f"{len(items)} 个插件")
        self._plugin_scroll_update()
        try:
            self.plugin_cv.yview_moveto(0)
        except Exception:  # noqa: BLE001
            pass
        self._set_plugin_busy(self.plugin_busy)

    def _plugin_canvas_width(self, _e=None) -> None:
        try:
            self.plugin_cv.itemconfigure(self._plugin_cw,
                                         width=self.plugin_cv.winfo_width())
        except Exception:  # noqa: BLE001
            pass

    def _plugin_scroll_update(self, _e=None) -> None:
        try:
            self.plugin_cv.configure(scrollregion=self.plugin_cv.bbox("all"))
        except Exception:  # noqa: BLE001
            pass

    def _on_plugin_wheel(self, e) -> None:
        try:
            self.plugin_cv.yview_scroll(int(-e.delta / 120), "units")
        except Exception:  # noqa: BLE001
            pass

    def _plugin_copy_list(self) -> None:
        items = getattr(self, "plugin_items", None) or []
        lines = [f"{it['name']}\t{self._state_display(it)[0]}" for it in items]
        self.clipboard_clear()
        self.clipboard_append("\n".join(lines) or "（空）")
        self._status(f"已复制 {len(lines)} 行插件清单")

    # ---------- 插件市场（bundle，走 dsh plugin） ----------

    def _placeholder(self, entry: ttk.Entry, text: str) -> None:
        """让 Entry 显示灰色占位提示；聚焦/点击后清空，失焦为空时恢复。"""
        def _clear(_e=None) -> None:
            if entry.get() == text:
                entry.delete(0, "end")
                entry.configure(foreground="#000")
        def _refill(_e=None) -> None:
            if not entry.get():
                entry.insert(0, text)
                entry.configure(foreground="#888")
        entry.configure(foreground="#888")
        entry.insert(0, text)
        entry.bind("<FocusIn>", _clear)
        entry.bind("<Button-1>", _clear)
        entry.bind("<FocusOut>", _refill)

    def _market_act(self, action: str) -> None:
        spec = self.market_spec.get().strip()
        if not spec or spec == getattr(self, "market_placeholder", None):
            self._append("[市场] 请先填 URL / npm 包名 / git 源")
            return
        self._market_run(spec, action)

    def _market_run(self, value: str, action: str) -> None:
        if self.plugin_busy:
            return
        self._set_plugin_busy(True)
        self._append(f"[市场] 待办：{action} {value}")
        threading.Thread(target=self._market_worker, args=(action, value),
                         daemon=True).start()

    def _market_worker(self, action: str, value: str) -> None:
        try:
            env = self._plugin_env()
            if env is None:
                return
            home, project = env
            if action == "download":
                pstore.bundle_fetch(value, project / "plugins")
                self._plog(f"[市场] ✓ 已下载 {value} 到 plugins/")
                self._status(f"已下载 {value}（可安装）")
            elif action == "install":
                source = self._resolve_bundle_source(value, project)
                name = pstore.bundle_install(home, source, project=project,
                                             env=self._bundle_env())
                self._plog(f"[市场] ✓ 已安装 {name}（重启生效）")
                self._status(f"已安装 {name}（需重启网页版生效）")
            elif action == "uninstall":
                name = pstore._spec_pkg_name(value)
                if name in pstore.bundle_disabled(home):
                    # 被禁用时它不在 bundles 里，dsh plugin remove 会认为「未安装」
                    pstore.bundle_set_enabled(home, name, enabled=True)
                pstore.bundle_remove(home, name, project=project,
                                     env=self._bundle_env())
                self._plog(f"[市场] ✓ 已卸载 {name}（重启生效）")
                self._status(f"已卸载 {name}")
            elif action in ("bundle_off", "bundle_on"):
                name = pstore._spec_pkg_name(value)
                on = action == "bundle_on"
                pstore.bundle_set_enabled(home, name, enabled=on)
                self._plog(f"[市场] ✓ 已{'启用' if on else '禁用'} {name}："
                           f"{'放回' if on else '摘出'} dsh.profile.bundles"
                           f"（包文件与依赖都留着，重启网页版生效）")
                self._status(f"已{'启用' if on else '禁用'} {name}（需重启网页版生效）")
            elif action == "check":
                local = self._market_local(value, project)
                if local is None:
                    raise pstore.PluginError(f"{value} 未下载，无法校验")
                name, errs = pstore.bundle_check(local)
                if errs:
                    raise pstore.PluginError(
                        f"{name or value} 校验未通过：\n" + "\n".join(errs))
                _n, notes = pstore.bundle_notes(local)
                note = f"；{ '；'.join(notes) }" if notes else ""
                self._plog(f"[市场] ✓ 校验通过：{name}{note}")
                self._status(f"校验通过：{name}")
            elif action == "check_update":
                spec = pstore._spec_pkg_name(value)
                ver = pstore.bundle_latest_version(spec)
                cur = (self._local_version(spec, project)
                       or pstore.bundle_installed_version(home, spec))
                self.market_updates[value] = \
                    "outdated" if (ver and cur and ver != cur) else "current"
                self._plog(f"[市场] 更新检查 {spec}：latest={ver or '?'} 本地={cur or '?'}")
            elif action == "update":
                spec = pstore._spec_pkg_name(value)
                pstore.bundle_update(home, spec, project=project,
                                     env=self._bundle_env())
                self._plog(f"[市场] ✓ 已更新 {spec}（重启生效）")
                self._status(f"已更新 {spec}")
        except (pstore.PluginError, pstore.GateError) as exc:
            self._plog(f"[市场] ✗ {value}：{exc}")
            self._status("市场操作失败：%s" % exc, "#b00000")
            # 弹窗必须在界面线程（工作是子线程），参数先取值再投递
            self._post(messagebox.showerror, "市场操作失败", str(exc))
        finally:
            self._post(self._refresh_plugins)
            self._post(self._set_plugin_busy, False)

    def _market_local(self, value: str, project: Path):
        p = Path(value)
        if p.exists() and (p / "package.json").exists():
            return p
        name = pstore._spec_pkg_name(value)
        for c in pstore.bundle_candidates(project, ASSETS):
            if c.name == name:
                return c.path
        cand = Path(project) / "plugins" / pstore._spec_name(value)
        if (cand / "package.json").exists():
            return cand
        return None

    def _local_version(self, spec: str, project: Path) -> str:
        for c in pstore.bundle_candidates(project, ASSETS):
            if c.name == pstore._spec_pkg_name(spec):
                return c.version
        return ""

    def _resolve_bundle_source(self, spec: str, project: Path) -> "Path | str":
        cand = Path(spec)
        # 本地目录（含 package.json）：缺 lib 先构建，再打包成 tgz
        if cand.exists() and (cand / "package.json").exists():
            if not pstore._pkg_main_present(cand):
                self._plog(f"[包] {cand.name} 未构建，用 pnpm 构建（需要 devDeps）…")
                pstore.bundle_build(cand)
            if not pstore._pkg_main_present(cand):
                raise pstore.PluginError(f"{cand.name} 构建后仍缺入口 {pkg.get('main') or 'lib/index.js'}")
            pkg = pstore._pkg_json(cand) or {}
            name = pstore._bundle_name(cand)
            tgz_out = ASSETS / ".cache" / f"{name}-{pkg.get('version', '')}.tgz"
            pstore.bundle_pack(cand, tgz_out, name=name,
                               version=pkg.get("version", ""))
            return tgz_out
        if cand.exists() and cand.suffix == ".tgz":
            return cand
        tgz = ASSETS / f"{spec}.tgz"
        if tgz.exists():
            return tgz
        # 收录名/URL/npm 包名 → 交给 dsh plugin add 走 registry（预构建产物，不克隆不构建）
        return spec

    def _bundle_env(self) -> dict:
        env = dict(os.environ)
        pnpm = find_pnpm()
        if pnpm:
            env["PATH"] = str(Path(pnpm).parent) + os.pathsep + env.get("PATH", "")
        return env

    def _merge_plugins(self, cards, entries, catalog=(), home: Path | None = None,
                       project: Path | None = None) -> list[dict]:
        items: list[dict] = []
        known: set[str] = set()
        for card in cards:
            known.add(card.slug)
            items.append({
                "kind": "managed", "name": card.slug,
                "version": getattr(card, "version", "") or "",
                "state": card.state, "desc": (card.description or "")[:40],
                "warning": card.validation_errors[0][:24] if card.validation_errors else "",
                "value": card.slug, "spec": card.slug,
                "full_name": getattr(card, "name", card.slug),
                "src_label": plugin_src_label("managed", card.state),
                # 源码目录：打包发行/校验要用；开发机的正本是 dsh 检出里的 plugins/<slug>
                "source_dir": str(plugin_source_dir(card, home, project) or ""),
            })
        # 内置清单里尚未下载（未克隆）的插件
        for c in catalog:
            if c["slug"] in known:
                continue
            items.append({
                "kind": "catalog", "name": c["slug"], "version": "",
                "state": "nodl", "desc": (c["description"] or "")[:24],
                "warning": "", "value": c["slug"], "spec": c["repo"],
                "full_name": c["slug"], "src_label": "内置清单",
            })
        # bundle：禁用的判据是「名字不在 dsh.profile.bundles 里但包还在」——
        # 这正是禁用后的样子，不能混成「已下载」（那样用户看不出自己关过什么）
        off = pstore.bundle_disabled(home) if home is not None else {}
        for e in entries:
            st = "installed" if e.installed else ("downloaded" if e.downloaded else "nodl")
            if e.name in off and not e.installed:
                st = "bundle-off"
            items.append({
                "kind": "bundle", "name": e.name, "version": e.version, "state": st,
                "desc": (e.description or "")[:22], "warning": "",
                "value": str(e.local) if e.local else e.spec, "spec": e.spec,
                "full_name": e.name, "src_label": "在线包",
            })
        items.sort(key=lambda it: (self._plugin_rank(it), it["name"]))
        return items

    @staticmethod
    def _plugin_rank(it: dict) -> int:
        return {"enabled": 0, "installed": 0, "disabled": 1, "downloaded": 1,
                "bundle-off": 1, "external": 2, "external-disabled": 2, "nodl": 3,
                "first_party": 4, "first_party-disabled": 4}.get(it["state"], 5)

    def _render_plugin_row(self, row, it) -> None:
        ttk.Label(row, text=it["name"], width=20,
                  font=("Microsoft YaHei UI", 9, "bold")).pack(side="left")
        ttk.Label(row, text=it["version"] or "—", width=9,
                  foreground="#888").pack(side="left")
        st, color = self._state_display(it)
        ttk.Label(row, text=st, width=10, foreground=color).pack(side="left")
        src = it.get("src_label", "")
        desc = it["desc"]
        ttk.Label(row, text=(f"{src}｜{desc}" if desc else src),
                  foreground="#666").pack(side="left", fill="x", expand=True)
        if it["warning"]:
            ttk.Label(row, text="⚠ " + it["warning"], foreground="#b00000",
                      font=("Microsoft YaHei UI", 8)).pack(side="left")
        for text, act, val in self._actions_for(it):
            btn = ttk.Button(row, text=text, width=8,
                             command=lambda k=it["kind"], v=val, a=act:
                                 self._act(k, v, a))
            btn.pack(side="left", padx=2)
            self.plugin_btns.append(btn)

    def _state_display(self, it) -> tuple[str, str]:
        s = it["state"]
        return self.STATE_CN.get(s, s), self.STATE_COLOR.get(s, "#000")

    def _actions_for(self, it) -> list[tuple[str, str, str]]:
        if it["kind"] == "managed":
            return self._managed_actions(it)
        if it["kind"] == "catalog":
            return [("下载", "fetch", it["value"])]
        return self._bundle_actions(it)

    def _managed_actions(self, it) -> list[tuple[str, str, str]]:
        st, warn, slug = it["state"], it["warning"], it["value"]
        # 有源码目录就多一个「打包发行」：把本地插件做成可发布的 bundle（见 _bundleize_worker）
        release = [("打包发行", "bundleize", slug)] if it.get("source_dir") else []
        if st == "downloaded":
            return ([("看原因", "none", slug)] if warn else [("安装", "install", slug)]) + release
        if st == "enabled":
            return [("禁用", "set_off", slug), ("卸载", "uninstall", slug),
                    ("校验", "check_local", slug)] + release
        if st == "disabled":
            return [("启用", "set_on", slug), ("卸载", "uninstall", slug),
                    ("校验", "check_local", slug)] + release
        if st in ("external", "external-disabled"):
            # 外部行照样能禁停（排查启动冲突时最需要）：写成官方 disabled，不碰原文
            acts = [("禁用", "row_off", slug)] if st == "external" \
                else [("启用", "row_on", slug)]
            acts.append(("校验", "check_local", slug))
            # 【接管】只在**真的能接管**时才给：带 config / 多条目 / 上方有注释的行
            # 接不了，点了才报错最烦人（实测 7 行里 4 行属于这种）
            if str(it.get("full_name", "")).startswith("@dsh-user/") \
                    and not getattr(self, "plugin_adoptable", {}).get(slug):
                acts.append(("接管", "adopt", slug))
            return acts + release
        if st in ("first_party", "first_party-disabled"):
            # 官方插件（如 time-context）也在用户补丁里，一样能禁停——排查冲突时要的正是它
            acts = [("禁用", "row_off", slug)] if st == "first_party" \
                else [("启用", "row_on", slug)]
            acts.append(("校验", "check_local", slug))
            return acts
        return []

    def _bundle_actions(self, it) -> list[tuple[str, str, str]]:
        s, spec, local = it["state"], it["spec"], it["value"]
        acts: list[tuple[str, str, str]] = []
        if s == "nodl":
            acts.append(("下载", "download", spec))
        if s == "downloaded":
            acts.append(("安装", "install", local))
        if s in ("nodl", "downloaded"):
            acts.append(("校验", "check", local))
        if s == "installed":
            acts.append(("禁用", "bundle_off", spec))
            acts.append(("卸载", "uninstall", spec))
            acts.append(("校验", "check", local))
            upd = self.market_updates.get(spec, "unknown")
            label = {"unknown": "查看更新", "outdated": "可更新",
                     "current": "已最新"}.get(upd, "查看更新")
            act = {"unknown": "check_update", "outdated": "update",
                   "current": "check_update"}.get(upd, "check_update")
            acts.append((label, act, spec))
        elif s == "bundle-off":
            acts.append(("启用", "bundle_on", spec))
            acts.append(("卸载", "uninstall", spec))
        return acts

    def _act(self, kind: str, value: str, action: str) -> None:
        if kind == "managed":
            self._plugin_act(value, action)
        elif kind == "catalog":
            self._catalog_run(value, action)
        else:
            self._market_run(value, action)

    def _catalog_run(self, slug: str, action: str) -> None:
        """内置清单插件动作：下载 = 从该插件自己的独立仓库克隆到缓存。"""
        if self.plugin_busy:
            return
        self._set_plugin_busy(True)
        threading.Thread(target=self._catalog_worker, args=(slug, action),
                         daemon=True).start()

    def _catalog_worker(self, slug: str, action: str) -> None:
        try:
            env = self._plugin_env()
            if env is None:
                return
            home, _project = env
            entry = pstore.catalog_entry(home, slug)
            if entry is None:
                raise pstore.PluginError(f"{slug} 不在内置插件清单里")
            if find_git() is None:
                raise pstore.PluginError(
                    "未检测到 git，无法从独立仓库下载插件。\n"
                    "请先安装 Git for Windows（https://git-scm.com/download/win）。")
            target = pstore.fetch_plugin(entry, pstore.plugin_cache_dir(home))
            self._plog(f"[插件] ✓ 已下载 {slug}：{target}")
            self._status(f"已下载 {slug}（可点「安装」）")
        except Exception as exc:  # noqa: BLE001
            self._plog(f"[插件] ✗ 下载 {slug} 失败：{exc}")
            self._status("下载失败 ✗（详情见日志）", "#b00000")
        finally:
            self._post(self._set_plugin_busy, False)
            self._post(self._refresh_plugins)

    def _ask_publish_scope(self) -> str | None:
        """问一次发行用的 npm scope，记住答案；返回 None = 用户取消。

        只需要问一次：之后每次点【打包发行】都是真正的一键（离线、确定性、同输入同输出）。
        """
        saved = str(load_config().get("publishScope", "")).strip()
        if saved:
            return saved
        scope = simpledialog.askstring(
            "打包成 bundle：发布用包名前缀",
            "要发到 npm 的话，填你自己的 npm scope（形如 @yourname）。\n\n"
            "· 留空 = 沿用 @dsh-user/<插件名>：能给自己或别人手动装 tgz，但发不进 registry\n"
            "· 只想先打一个 tgz 试装，留空即可\n\n"
            "包名前缀：", initialvalue="", parent=self)
        if scope is None:
            return None
        scope = scope.strip()
        if scope and not scope.startswith("@"):
            messagebox.showwarning("前缀要以 @ 开头",
                                   "npm scope 形如 @yourname；这次没有打包，改好再点一次。")
            return None
        save_config({"publishScope": scope})
        self._plog(f"[发行] 已记住发布用包名前缀：{scope or '（空，沿用 @dsh-user/<插件名>）'}")
        return scope

    def _bundleize_worker(self, slug: str, scope: str) -> None:
        """把本地插件打包成可发布的 bundle：改造 manifest + 生成包内层 + `pnpm pack`。

        这套流程（加 `dsh.bundle.patch`、把 patch 放进 `files`、去掉 private、
        官方依赖转 peer、生成包内 `cordis.patch.yml`）全是确定性文件变换，
        以前每次都要在对话里手工做一遍；做成按钮后离线可用、可回归测试。
        **只产出发行物**：不改源目录、不装进你的 profile、不发布。
        """
        try:
            env = self._plugin_env()
            if env is None:
                return
            home, project = env
            extra = next((s.path for s in self._plugin_sources(home, project)
                          if s.slug == slug), None)
            src = pstore.find_plugin_source(home, slug, project=project, extra=extra)
            if src is None:
                raise pstore.PluginError(
                    f"找不到 {slug} 的源码目录（plugins/、下载缓存、共享锚都没有）")
            self._plog(f"[发行] 源目录：{src}")
            plan = pstore.stage_bundle(src, home / pstore.BUNDLE_STAGE_DIR,
                                       scope=scope, slug=slug)
            for note in plan.notes:
                self._plog(f"[发行] · {note}")
            for line in plan.patch_text.splitlines():
                self._plog(f"[发行]   层内容 | {line}")
            pnpm = find_pnpm()
            if pnpm is None:
                raise pstore.PluginError("未检测到 pnpm，打不出 tgz（先装 Node/pnpm）")
            tgz = pstore.pack_bundle(plan, pnpm=pnpm)
            checks = pstore.bundle_tgz_report(tgz)
            for line in checks:
                self._plog(f"[发行] {line}")
            self._plog(f"[发行] ✓ 已打出 {tgz}")
            self._plog(f"[发行]   本机试装：dsh plugin --profile web add \"{tgz}\"")
            self._plog(f"[发行]   发布到 npm：在 {plan.out_dir} 里跑 pnpm publish")
            self._plog(f"[发行]   （发布不可撤销，且需要 npm 登录，所以留给你手动决定）")
            body = (f"{plan.package_name} {plan.version}\n\n"
                    f"暂存目录：{plan.out_dir}\n"
                    f"tgz：{tgz}\n\n" + "\n".join(checks)
                    + "\n\n下一步（手动）：\n"
                      f"· 本机试装：dsh plugin --profile web add \"{tgz}\"\n"
                      f"· 发布：cd \"{plan.out_dir}\" && pnpm publish")
            self._post(lambda: messagebox.showinfo("打包成 bundle 完成", body, parent=self))
            self._post(self._status, f"{slug} 已打包：{tgz.name}")
        except Exception as exc:  # noqa: BLE001
            self._plog(f"[发行] ✗ 打包 {slug} 失败：{exc}")
            self._post(self._status, f"{slug} 打包失败 ✗（详情见日志）", "#b00000")

    def _local_check_worker(self, slug: str) -> None:
        """本地插件的【校验】：查共享锚目录/来源目录里的包是否自洽。

        在线包的【校验】一直有，本地插件却没有，同一个页面两种规格；这里补上，
        两边都回答同一个问题——「这个包能不能装、能不能跑」。
        """
        try:
            env = self._plugin_env()
            if env is None:
                return
            home, project = env
            targets: list[Path] = []
            anchor = pstore.anchor_dir(home, slug)
            if anchor.exists():
                targets.append(anchor)
            # 源码目录（含 dsh 检出里的 plugins/<slug>）也要查：那才是你正在改的那份
            found = pstore.find_plugin_source(
                home, slug, project=project,
                extra=next((s.path for s in self._plugin_sources(home, project)
                            if s.slug == slug), None))
            if found is not None and found not in targets:
                targets.append(found)
            # 官方/在线插件没有来源目录，包就在 profile 的 node_modules 里
            # （本地与官方在 profiles/node_modules，bundle 在 profiles/web/node_modules）
            full = next((str(it.get("full_name", "")) for it in
                         getattr(self, "plugin_items", []) if it.get("value") == slug), "")
            for rel in (full, f"@dsh-user/{slug}"):
                if not rel:
                    continue
                for root in (home / "profiles" / "node_modules",
                             home / "profiles" / "web" / "node_modules"):
                    cand = root / rel
                    if cand.exists() and cand not in targets:
                        targets.append(cand)
            if not targets:
                raise pstore.PluginError(
                    f"找不到 {slug} 的包目录（共享锚与来源目录都没有）")
            lines: list[str] = []
            ok = True
            for path in targets:
                # 只有 @dsh-user 的包才套那条命名约定；官方/在线包用通用自洽检查
                pkg_name = pstore.package_name(path)
                res = (pstore.validate_package(path) if pkg_name.startswith("@dsh-user/")
                       else pstore.package_sanity(path))
                ok = ok and res.ok
                lines.append(f"{path}\n    " + ("✓ 通过" if res.ok
                                                else "✗ " + "；".join(res.errors)))
            self._plog(f"[插件] 校验 {slug}：{'✓ 通过' if ok else '✗ 有问题'}")
            for line in lines:
                self._plog("        " + line.replace("\n", "\n        "))
            self._post(lambda: messagebox.showinfo(
                "校验结果", f"{slug}：{'通过' if ok else '有问题'}\n\n" + "\n".join(lines),
                parent=self))
            self._post(self._status, f"{slug} 校验：{'✓ 通过' if ok else '✗ 有问题'}",
                       "#2a6b2a" if ok else "#b00000")
        except Exception as exc:  # noqa: BLE001
            self._plog(f"[插件] ✗ 校验 {slug} 失败：{exc}")
            self._post(self._status, f"{slug} 校验失败 ✗", "#b00000")

    def _plugin_act(self, slug: str, action: str) -> None:
        if action == "bundleize":                # 打包成 bundle：先问一次包名前缀（记住）
            scope = self._ask_publish_scope()
            if scope is None:
                return
            threading.Thread(target=self._bundleize_worker, args=(slug, scope),
                             daemon=True).start()
            return
        if action == "check_local":              # 只读校验：立即跑，不进待办
            threading.Thread(target=self._local_check_worker, args=(slug,),
                             daemon=True).start()
            return
        if action == "adopt":
            reason = getattr(self, "plugin_adoptable", {}).get(slug)
            if reason:
                messagebox.showinfo(
                    "这一行不能接管",
                    f"{slug} 不能接管：\n\n{reason}\n\n"
                    "只有「单个独立的 - insert: 元素、单条子记录、没有 config、"
                    "没有注释」的行才接管得了——带 config 的行助手不碰你的配置。\n"
                    "（只是要禁停它的话，直接点【禁用】就行，不需要接管。）",
                    parent=self)
                self._plog(f"[插件] 接管 {slug} 被拒：{reason}")
                return
        if self.plugin_busy or action == "none":
            if action == "none":
                card = next((c for c in getattr(self, "plugin_cards", [])
                             if c.slug == slug), None)
                errs = list(card.validation_errors) if card and card.validation_errors \
                    else ["未通过安装前置校验（name/lib/client 等）。"]
                messagebox.showinfo(
                    "未通过校验",
                    f"{slug} 未通过安装前置校验：\n\n" + "\n".join(errs)
                    + "\n\n修正后点「重新扫描」再试。")
                self._plog(f"[插件] '看原因'：{slug} → {'；'.join(errs)}")
            return
        if action == "uninstall":
            if not messagebox.askyesno("卸载确认",
                                       f"卸载 {slug}？将移除其组合行并删除共享目录\n"
                                       f"（源码仍留在项目 plugins/ 中，可重新安装）。"):
                return
        self.plugin_pending[slug] = action
        self._set_plugin_busy(self.plugin_busy)
        self._render_pending_only(slug)
        self._append(f"[插件] 已加入待办：{slug} → {action}（点『全部保存并重启网页版』生效）")
        self._status(f"已加入待办 {len(self.plugin_pending)} 项 —— "
                     "点【全部保存并重启网页版】才落盘", "#a05a00")

    def _render_pending_only(self, _slug: str) -> None:
        # 只刷新保存按钮（行内容在保存/刷新后重建）。按钮上带**待办条数**：
        # 以前待办只写一行日志，点完按钮看着"什么都没发生"就是这么来的（用户实测）。
        n = len(self.plugin_pending)
        try:
            self.btn_save.configure(
                state="normal",
                text=f"全部保存并重启网页版（{n} 项待保存）" if n
                else "全部保存并重启网页版")
            self.btn_undo.configure(state="normal" if n else "disabled")
        except Exception:  # noqa: BLE001  窗口销毁后忽略
            pass

    def _clear_pending(self) -> None:
        """撤销还没保存的改动——纯内存操作，**一个字节都不写盘**。

        与【回滚到上次保存】分工：这个只清草稿（点错了、改主意了），那个才动文件。
        """
        n = len(self.plugin_pending)
        self.plugin_pending.clear()
        self._render_pending_only("")
        if n:
            self._plog(f"[插件] 已撤销 {n} 项未保存的改动（文件没被动过）")
            self._status(f"已撤销 {n} 项待办（没写盘）")
        else:
            self._status("当前没有待保存的改动")

    def _on_rollback(self) -> None:
        """用 `.bak` 把补丁与台账退回到「上一次保存之前」。

        【撤销待办】只清内存草稿；这个是真的把**已经落盘**的改动退回去，是"手滑了想反悔"
        的兜底。补丁与台账必须一起退，否则自有段与台账不一致，下次写盘会被一致性检查拒掉。
        """
        home = self.plugin_home_dir or plugin_home()
        bak = pstore.patch_backup_path(home)
        try:
            exists = bak.exists()
        except OSError:
            exists = False
        if not exists:
            messagebox.showinfo(
                "没有可回滚的备份",
                f"还没找到备份：\n{bak}\n\n"
                "备份是每次写盘（保存 / 禁用 / 启用 / 接管 / 安装 / 卸载）之前自动留的，"
                "所以要先有过一次成功的写盘。", parent=self)
            return
        try:
            when = time.strftime("%Y-%m-%d %H:%M:%S",
                                 time.localtime(bak.stat().st_mtime))
        except OSError:
            when = "时间未知"
        if not messagebox.askyesno(
                "回滚到上次保存之前？",
                f"把补丁退回到这份备份：\n{bak}\n（{when}）\n\n"
                "· 台账备份会一起退回，保持一致\n"
                "· 备份本身保留，可以再点一次\n"
                "· 正在跑的网页版要重启才看得到结果", parent=self):
            return
        try:
            if not pstore.rollback_patch(home):
                raise pstore.PluginError("回滚失败：备份不存在")
        except Exception as exc:  # noqa: BLE001
            self._plog(f"[插件] ✗ 回滚失败：{exc}")
            messagebox.showerror("回滚失败", str(exc), parent=self)
            return
        self._clear_pending()
        self._plog(f"[插件] ✓ 已回滚到 {bak}（{when}）")
        self._status("已回滚补丁与台账到上次保存之前", "#a05a00")
        self._refresh_plugins()
        if self.web_proc is not None and self.web_proc.poll() is None and \
                messagebox.askyesno("重启网页版？",
                                    "回滚要重启网页版才生效，现在重启？", parent=self):
            self._stop_web_internal(quiet=True)
            self._launch_web()

    def on_plugin_save(self) -> None:
        if self.plugin_busy or not self.plugin_pending:
            return
        self._set_plugin_busy(True)
        threading.Thread(target=self._plugin_save_worker, daemon=True).start()

    def _plugin_save_worker(self) -> None:
        home, project = self.plugin_home_dir, self.plugin_project
        ok_all = True
        fail_msgs: list[str] = []
        gate_failed: list[tuple[str, str, str]] = []
        was_running = self.web_proc is not None and self.web_proc.poll() is None
        try:
            if home is None or project is None:
                raise pstore.PluginError("插件环境未就绪（先点「重新扫描」）。")
            pending = list(self.plugin_pending.items())
            # 卸载/启停前先停 web：避免删除运行中的共享目录/热态竞争
            had_uninstall = any(a == "uninstall" for _, a in pending)
            if had_uninstall and was_running:
                self._stop_web_internal(quiet=True)
            sources = {s.slug: s for s in self._plugin_sources(home, project)}
            for slug, act in pending:
                try:
                    if act == "install":
                        src = sources.get(slug)
                        if src is None:
                            raise pstore.PluginError(f"{slug} 不在来源目录中")
                        pstore.install(home, src, project=project)
                        self._plog(f"[插件] ✓ 已安装 {slug}")
                    elif act == "uninstall":
                        pstore.uninstall(home, slug, project=project)
                        self._plog(f"[插件] ✓ 已卸载 {slug}")
                    elif act in ("set_on", "set_off"):
                        pstore.set_enabled(home, slug, enabled=(act == "set_on"),
                                           project=project)
                        self._plog(f"[插件] ✓ {'启用' if act == 'set_on' else '停用'} {slug}")
                    elif act in ("row_off", "row_on"):
                        # 外部行：只写官方的顶层 disabled 覆盖行，一个字都不改用户原文
                        pstore.set_row_enabled(home, slug, enabled=(act == "row_on"))
                        self._plog(f"[插件] ✓ {'启用' if act == 'row_on' else '禁用'} {slug}"
                                   f"（免结构门，只改补丁里那一行）")
                    elif act == "adopt":
                        pstore.adopt(home, slug, project=project)
                        self._plog(f"[插件] ✓ 已接管 {slug}（转为助手管理）")
                except pstore.GateError as exc:
                    # 结构门没过：多半是某个插件把 dsh 搞得起不来。先留着，等界面问
                    # 用户要不要「免校验直接写」——不然 dsh 起不来时一个都禁不掉。
                    gate_failed.append((slug, act, str(exc)))
                    self._plog(f"[插件] ⚠ {slug}：结构门未过（{exc}）")
                except (pstore.PluginError, pstore.ProtectedShapeError) as exc:
                    ok_all = False
                    fail_msgs.append(f"{slug}：{exc}")
                    self._plog(f"[插件] ✗ {slug}：{exc}")
                    break
            self.rollback_armed = ok_all and any(
                a in ("install", "set_on") for _, a in pending)
        except Exception as exc:  # noqa: BLE001
            ok_all = False
            fail_msgs.append(str(exc))
            self._plog(f"[插件] ✗ 保存失败：{exc}")
        finally:
            self._post(self._plugin_save_done, ok_all, was_running, fail_msgs, gate_failed)

    def _plugin_save_done(self, ok_all: bool, was_running: bool,
                          fail_msgs: list[str],
                          gate_failed: list[tuple[str, str, str]] = ()) -> None:
        self.plugin_pending.clear()
        self._set_plugin_busy(False)
        try:                              # 待办清空 → 按钮文字还原
            self.btn_save.configure(text="全部保存并重启网页版")
        except Exception:  # noqa: BLE001  窗口销毁后忽略
            pass
        if gate_failed and self._offer_emergency(gate_failed):
            return                        # 交给应急流程，别再报一遍失败
        if not ok_all:
            self._status("插件保存失败", "#b00000")
            messagebox.showerror(
                "插件保存失败",
                "\n".join(fail_msgs) + "\n\n详情见 installer.log 与「安装与启动」页日志区。")
            self._refresh_plugins()
            return
        if gate_failed:
            self._status("结构门未过，改动未落盘", "#b00000")
            self._refresh_plugins()
            return
        if was_running or self.rollback_armed:
            # 确定性验证：重启 + 健康检查（失败自动回滚）
            self._plog("[插件] 正在重启网页版以确认生效…")
            self._stop_web_internal(quiet=True)
            if self._launch_web():
                self._activation_checks = 0
                self.after(600, self._activation_poll)
            else:
                self._status("补丁已保存，但网页版启动失败（见弹窗/日志）", "#b00000")
        else:
            self._status("已保存（补丁已热应用；未运行服务，下次启动生效）")
            self._plog("[插件] 已保存：改动已热应用；下次启动生效。")
        self._refresh_plugins()

    def _offer_emergency(self, gate_failed: list[tuple[str, str, str]]) -> bool:
        """结构门没过（多半是插件冲突把 dsh 搞得起不来）：问一句要不要免校验直接写。

        这是「从外部禁用/启用」这条能力的关键一步：dsh 起不来时结构门
        （`dsh --profile web --dump-config`）也跑不了，没有这条路就一个也禁不掉。
        """
        names = "、".join(f"{slug}（{'启用' if act == 'set_on' else '停用'}）"
                          for slug, act, _ in gate_failed)
        if not messagebox.askyesno(
                "结构门未通过：要免校验直接写吗？",
                f"dsh 现在跑不起来，无法用结构门校验补丁。\n\n"
                f"受影响：{names}\n\n"
                f"原因：{gate_failed[0][2][:400]}\n\n"
                "要以**应急方式**直接写盘吗？写前会备份补丁 `.bak`，随时可回滚；"
                "改的是「停用/启用」，写完请重启 dsh 验证。", parent=self):
            return False
        self._set_plugin_busy(True)
        threading.Thread(target=self._emergency_worker, args=(gate_failed,),
                         daemon=True).start()
        return True

    def _emergency_worker(self, ops: list[tuple[str, str, str]]) -> None:
        home = self.plugin_home_dir
        try:
            if home is None:
                raise pstore.PluginError("插件环境未就绪（先点「重新扫描」）。")
            for slug, act, _ in ops:
                pstore.set_enabled(home, slug, enabled=(act == "set_on"), gate=False)
                self._plog(f"[插件] ✓ 应急{'启用' if act == 'set_on' else '停用'} {slug}"
                           f"（未做结构校验）")
            self._post(self._status, "已按应急方式写盘（未校验），请重启 dsh 验证", "#a05a00")
        except Exception as exc:  # noqa: BLE001
            self._plog(f"[插件] ✗ 应急写盘失败：{exc}")
            self._post(messagebox.showerror, "应急写盘失败", str(exc))
        finally:
            self._post(self._set_plugin_busy, False)
            self._post(self._refresh_plugins)

    def _activation_poll(self) -> None:
        """激活门健康检查：启动日志无 loader 失败即视为生效；失败回滚 .bak 重启一次。"""
        self._activation_checks += 1
        text = "\n".join(self.web_tail)
        running = self.web_proc is not None and self.web_proc.poll() is None
        if running and pstore.health_ok(text):
            if "dsh web:" in text:
                self.rollback_armed = False
                self._status("插件改动已生效（网页版运行中）")
                return
            if self._activation_checks > 60:
                self._status("网页版启动中…")
                return
            self.after(400, self._activation_poll)
            return
        # 启动失败或健康检查失败
        if not running:
            self._append("[插件] 网页版未能保持运行（见日志）。")
        else:
            self._append("[插件] 启动日志出现 loader 错误，判定未生效。")
        if self.rollback_armed:
            self.rollback_armed = False
            try:
                if pstore.rollback_patch(self.plugin_home_dir or plugin_home()):
                    self._append("[插件] 已自动回滚补丁（.bak），正在重启…")
                    self._stop_web_internal(quiet=True)
                    if self._launch_web():
                        self.after(1500, self._activation_poll)
                    return
            except Exception as exc:  # noqa: BLE001
                self._append(f"[插件] 回滚失败：{exc}")
        self._status("插件保存未生效，见日志", "#b00000")

    def _plugin_import(self) -> None:
        if self.plugin_busy:
            return
        home = plugin_home()
        picked = filedialog.askdirectory(title="选择插件目录（含 package.json）")
        if not picked:
            return
        src = Path(picked)
        slug = src.name
        if not pstore.is_valid_slug(slug):
            messagebox.showerror("非法目录名", "插件目录名须为小写字母/数字/连字符。")
            return
        v = pstore.validate_package(src)
        if not v.ok:
            messagebox.showerror("校验失败", "\n".join(v.errors))
            return
        # 导入到小助手自己的插件来源目录（目录名 = slug），不写进 dsh 检出
        dst = pstore.plugin_cache_dir(home) / slug
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            messagebox.showerror("已存在", f"{dst} 已存在，请先处理。")
            return
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
            "__pycache__", "*.pyc", ".git", "tmp"))
        self._append(f"[插件] 已导入到 {dst}（重新扫描后即可安装）")
        self._refresh_plugins()

    # ---------------- Tab 3：会话迁移 ----------------

    def _build_migrate_ui(self, root: ttk.Frame) -> None:
        ttk.Label(root,
                  text="把「已开始的会话」迁到别的 preset（例：cordis-director 可给旧会话启用引擎热切）。"
                       "只改两个文件的单个字段并自动备份这两个文件本身，绝不整目录备份。",
                  foreground="#555", wraplength=790).pack(anchor="w")

        bar = ttk.Frame(root)
        bar.pack(fill="x", pady=(6, 2))
        ttk.Label(bar, text="目标 preset：").pack(side="left")
        self.mig_preset_var = tk.StringVar(value="cordis-director")
        ttk.Combobox(bar, textvariable=self.mig_preset_var, width=22,
                     values=("cordis-director", "director-test", "cordis",
                             "standard", "ptc", "minimal")).pack(side="left", padx=(0, 12))
        self.btn_mig_scan = ttk.Button(bar, text="重新扫描", command=self._mig_scan)
        self.btn_mig_scan.pack(side="left", ipadx=8)
        self.btn_mig_inject = ttk.Button(bar, text="写入（迁移）所选",
                                         command=self._mig_inject_click)
        self.btn_mig_inject.pack(side="left", padx=8, ipadx=8)
        self.btn_mig_verify = ttk.Button(bar, text="校验所选", command=self._mig_verify)
        self.btn_mig_verify.pack(side="left", ipadx=8)
        self.btn_mig_restore = ttk.Button(bar, text="从备份恢复…", command=self._mig_restore_click)
        self.btn_mig_restore.pack(side="left", padx=8, ipadx=8)
        self.btn_mig_open = ttk.Button(bar, text="打开备份文件夹", command=self._mig_open_backups)
        self.btn_mig_open.pack(side="left", ipadx=8)

        fbar = ttk.Frame(root)
        fbar.pack(fill="x", pady=(2, 2))
        ttk.Label(fbar, text="按名称/ID 过滤：").pack(side="left")
        self.mig_filter_var = tk.StringVar()
        self.mig_filter_var.trace_add("write", lambda *_: self._mig_render())
        filt = ttk.Entry(fbar, textvariable=self.mig_filter_var, width=44)
        filt.pack(side="left", padx=(0, 8))
        self.mig_show_sub = tk.BooleanVar(value=False)
        self.mig_show_sub.trace_add("write", lambda *_: self._mig_render())
        ttk.Checkbutton(fbar, text="显示子代理", variable=self.mig_show_sub,
                        command=self._mig_render).pack(side="left", padx=(0, 8))
        ttk.Label(fbar, text="（默认只看主对话；子代理默认隐藏）",
                  foreground="#888").pack(side="left")

        lf = ttk.LabelFrame(root, text="会话（header preset / 缓存 preset）", padding=4)
        lf.pack(fill="both", expand=True, pady=(4, 0))
        cols = ("title", "preset", "cache", "bytes", "id", "ws")
        tree = ttk.Treeview(lf, columns=cols, show="headings", height=11)
        for key, text, width in (("title", "会话名称", 360), ("preset", "preset(头)", 90),
                                 ("cache", "preset(缓存)", 110), ("bytes", "大小", 85),
                                 ("id", "会话 ID", 240), ("ws", "工作区", 150)):
            tree.heading(key, text=text)
            tree.column(key, width=width, anchor="w" if key in ("title", "id", "ws") else "center")
        ysb = ttk.Scrollbar(lf, command=tree.yview)
        tree.configure(yscrollcommand=ysb.set)
        ysb.pack(side="right", fill="y")
        tree.pack(fill="both", expand=True)
        self.mig_tree = tree

        self.mig_status = ttk.Label(root, text="就绪。先【重新扫描】查看会话。",
                                    foreground="#1a6b1a")
        self.mig_status.pack(anchor="w", pady=(6, 0))

    def _mig_node(self) -> str:
        node = find_node()
        if not node:
            raise RuntimeError("未找到 Node.js（≥22.19/24）。请先在「安装与启动」页完成安装。")
        return node

    def _mig_script(self) -> Path:
        return HERE / "migrate.mjs"

    def _mig_selected_id(self) -> str | None:
        sel = self.mig_tree.selection()
        return sel[0] if sel else None

    def _mig_set_busy(self, busy: bool) -> None:
        self.mig_busy = busy
        state = "disabled" if busy else "normal"
        for btn in (self.btn_mig_scan, self.btn_mig_inject,
                    self.btn_mig_verify, self.btn_mig_restore):
            btn.configure(state=state)
        if busy:
            self.mig_status.configure(text="工作中…", foreground="#a05a00")

    def _mig_fail(self, exc: BaseException) -> None:
        self._append(f"[会话迁移] 失败：{exc}")
        self._post(self._mig_set_busy, False)
        self._post(lambda: self.mig_status.configure(text=f"失败：{exc}", foreground="#a11"))

    # ---- 扫描
    def _mig_scan(self) -> None:
        if self.mig_busy:
            return
        self._mig_set_busy(True)
        threading.Thread(target=self._mig_scan_worker, daemon=True).start()

    def _mig_scan_worker(self) -> None:
        try:
            self._post(self._mig_set_busy, True)
            node = self._mig_node()
            script = self._mig_script()
            if not script.exists():
                raise RuntimeError(f"缺少随包文件 {script}")
            import json as _json
            raw = run_text([node, str(script), "list-json"])
            data = _json.loads(raw)
            rows: list[dict[str, str]] = []
            for item in data:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                rows.append({
                    "id": item["id"],
                    "title": item.get("title") or "(无标题)",
                    "preset": item.get("preset") or "(none)",
                    "cache": item.get("cache") or "(none)",
                    "bytes": f"{item.get('bytes') or 0}",
                    "ws": item.get("workspace") or "",
                    "sub": bool(item.get("subagent")),
                    "error": item.get("error") or "",
                })
            self._post(self._mig_apply_rows, rows)
        except Exception as exc:  # noqa: BLE001  扫描失败如实报到界面即可
            self._post(self._mig_fail, exc)

    def _mig_apply_rows(self, rows: list[dict[str, str]]) -> None:
        rows.sort(key=lambda r: -(int(r.get("bytes") or 0)))
        self.mig_rows = rows
        self._mig_render()
        self._mig_set_busy(False)

    def _mig_render(self, _event=None) -> None:
        q = self.mig_filter_var.get().strip().lower()
        show_sub = self.mig_show_sub.get()
        hidden = 0
        for child in self.mig_tree.get_children():
            self.mig_tree.delete(child)
        shown = 0
        for row in self.mig_rows:
            if row.get("sub") and not show_sub:
                hidden += 1
                continue
            hay = f"{row.get('title')} {row['id']} {row.get('workspace')}".lower()
            if q and q not in hay:
                continue
            shown += 1
            title = row.get("title") or "(无标题)"
            if row.get("error"):
                title = f"⚠ {title}（读取失败：{row['error']}）"
            self.mig_tree.insert("", "end", iid=row["id"],
                                 values=(title, row["preset"], row["cache"],
                                         row["bytes"], row["id"], row["ws"]))
        sub_note = f"，已隐藏 {hidden} 个子代理" if hidden else ""
        self.mig_status.configure(
            text=f"显示 {shown}/{len(self.mig_rows)} 个会话{sub_note}（输入关键词过滤）。"
                 "选中行 → 选目标 preset → 「写入（迁移）所选」。",
            foreground="#1a6b1a")

    # ---- 写入 / 校验 / 恢复
    def _mig_inject_click(self) -> None:
        if self.mig_busy:
            return
        sid = self._mig_selected_id()
        if not sid:
            messagebox.showinfo("会话迁移", "请先在列表里选择一个会话。", parent=self)
            return
        preset = self.mig_preset_var.get().strip()
        if not preset:
            messagebox.showinfo("会话迁移", "请填写目标 preset。", parent=self)
            return
        title = next((r.get("title") for r in self.mig_rows if r.get("id") == sid), sid)
        if not messagebox.askyesno(
                "会话迁移 · 确认",
                f"把会话「{title}」迁移到 preset：{preset}\n\n"
                "⚠️ 请先确保 dsh web 已停止（「安装与启动」页点 ⏹ 停止服务）。\n"
                "工具会先备份被改的两个文件本身；随时可在本页「从备份恢复…」。\n\n继续？",
                parent=self):
            return
        self._mig_set_busy(True)
        threading.Thread(target=self._mig_run_worker,
                         args=("inject", [sid, preset]),
                         daemon=True).start()

    def _mig_verify(self) -> None:
        if self.mig_busy:
            return
        sid = self._mig_selected_id()
        if not sid:
            messagebox.showinfo("会话迁移", "请先在列表里选择一个会话。", parent=self)
            return
        self._mig_set_busy(True)
        threading.Thread(target=self._mig_run_worker,
                         args=("verify", [sid]), daemon=True).start()

    def _mig_restore_click(self) -> None:
        if self.mig_busy:
            return
        backup_root = plugin_home() / "_session-preset-backup"
        chosen = filedialog.askdirectory(
            title="选择备份目录（含 manifest.json）", parent=self,
            initialdir=str(backup_root) if backup_root.exists() else None)
        if not chosen:
            return
        if not messagebox.askyesno(
                "会话迁移 · 恢复确认",
                "⚠️ 恢复 = 把「会话日志 + 投影缓存」这两个文件整体还原到备份时刻（非合并）。\n\n"
                "请先确保 dsh web 已停止（「安装与启动」页点 ⏹ 停止服务）；\n"
                "若该会话在备份之后又有新运行，恢复会丢掉其后追加的内容。\n\n继续？",
                parent=self):
            return
        self._mig_set_busy(True)
        threading.Thread(target=self._mig_run_worker,
                         args=("restore", [chosen]), daemon=True).start()

    def _mig_run_worker(self, op: str, args: list[str]) -> None:
        try:
            self._post(self._mig_set_busy, True)
            node = self._mig_node()
            proc = run([node, str(self._mig_script()), op, *args])
            out = decode_proc(proc)
            for line in out.splitlines():
                if line.strip():
                    self._append(f"[会话迁移·{op}] {line.strip()}")
            if proc.returncode != 0:
                raise RuntimeError(f"migrate {op} 退出码 {proc.returncode}（见上方日志）")
            tail = {
                "inject": "注入完成，重启 dsh web 后生效。",
                "verify": "校验完成（结果见上方日志）。",
                "restore": "恢复完成。",
            }[op]
            self._post(lambda: self.mig_status.configure(text=tail, foreground="#1a6b1a"))
        except Exception as exc:  # noqa: BLE001  迁移失败如实报到界面即可
            self._post(self._mig_fail, exc)
        finally:
            self._post(self._mig_set_busy, False)

    def _mig_open_backups(self) -> None:
        backup_root = plugin_home() / "_session-preset-backup"
        try:
            backup_root.mkdir(parents=True, exist_ok=True)
            os.startfile(str(backup_root))  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            self._mig_fail(exc)

    def _on_close(self) -> None:
        """关窗口前先停 dsh web 与还在跑的长任务，再销毁窗口。

        安装、构建、克隆都是几分钟的命令，而执行它们的工作线程随窗口一起消失：
        不在这里结束子进程，它们会变成孤儿继续往安装目录写文件——用户以为关了，
        其实还在装，下次重开还会撞上文件锁。
        """
        if self._long_task_running() and not messagebox.askyesno(
                "任务还在进行",
                "现在关闭会中断它。已经写进去的文件会留着，\n"
                "下次点【一键完整安装】会重新装依赖并重新构建。\n\n"
                "确定要关闭吗？", parent=self):
            return
        self._closing = True
        if self._op_target is not None:
            set_interrupted_target(self._op_target)
        self._stop_web_internal(quiet=False)
        # 用较短的等待：个别进程赖着不走时不必让界面干等，Job Object 会在本进程
        # 退出（句柄关闭）时兜底结束它们。
        childproc.kill_all(timeout=childproc.CLOSE_KILL_TIMEOUT)
        self._drain_ui_queue()             # 把「正在停止 / 已停止」这几句先刷出来
        try:
            self.destroy()
        except Exception:  # noqa: BLE001  已经在销毁中时 destroy 会报错，无需处理
            pass

    def _long_task_running(self) -> bool:
        """有没有「中途关掉会留下半成品」的长任务在跑（安装/更新/插件/迁移）。

        只看真正的长任务，**不看 `git_busy`**：读 git 信息（启动后与每次改路径都会
        排期）只是一次探测，把它当成「正在安装」会在启动后马上关窗时平白弹窗，
        还会把好端端的目录记进「被打断」名单、害得下次白重装一遍。
        """
        return (self._op_target is not None or self.plugin_busy or self.mig_busy)


def selfcheck() -> int:
    log_line("=== 环境自检（DSH-孤辰小助手） ===")
    log_line(f"Python     : {sys.executable}")
    log_line(f"工作目录   : {HERE}")
    log_line(f"Windows    : {os.environ.get('OS', '?')} / "
             f"{os.environ.get('PROCESSOR_ARCHITECTURE', '?')}")
    log_line(f"管理员权限 : {'是' if is_admin() else '否'}")
    log_line(f"关窗保险   : {'✓ 子进程已绑定 Job Object（本进程无论怎么死都跟着结束）' if childproc.job_available() else '— 不可用，仅正常关窗时结束子进程'}")

    node = find_node()
    if node:
        vers = run_text([node, "--version"]).strip()
        log_line(f"Node       : {node}  ({vers})")
    else:
        log_line("Node       : 未检测到可用的 Node.js")

    pnpm = find_pnpm()
    log_line(f"pnpm       : {pnpm or '未检测到'}")

    git = find_git()
    log_line(f"git        : {git or '未检测到（在线安装/下载插件需要它）'}")

    log_line("离线数据（assets/）：")
    for name, path, ok in Engine.describe_assets():
        log_line(f"  {'✓' if ok else '—'} {name:<12} {path}")

    target = project_dir()
    why = checkout_identity(target)
    if why:
        state = f"★ 已检测到已安装的 DSH（{why}），将直接使用"
    elif target.exists():
        state = "目录已存在，但不是 DSH 检出（安装时会克隆/解压到这里）"
    else:
        state = "尚未安装（安装时会克隆/解压到这里）"
    log_line(f"项目目录   : {target}  {state}")

    # 用真实 git 命令复核一遍（官方链接是最强辨识：重写/条件包含/worktree 都交给 git 解析）
    ident = verify_install_dir(target)
    if ident.ok:
        info = ginfo.repo_info(target)
        mark = {"official": "✓ 官方仓库", "unofficial": "✓ 非官方远端",
                "file": "✓ 由文件判定"}.get(ident.tier, "✓")
        log_line(f"git 校验   : {mark} —— {ident.evidence}")
        if info.version:
            log_line(f"版本       : v{info.version}")
        if info.commit:
            log_line(f"提交       : {info.short}  {info.subject}")
            log_line(f"提交时间   : {info.committed_at}")
        if info.branch:
            note = ""
            if info.upstream and not info.shallow:
                note = f"（相对 {info.upstream}：领先 {info.ahead} / 落后 {info.behind}）"
            log_line(f"分支       : {info.branch}{note}")
        log_line(f"克隆方式   : {'浅克隆（--depth 1，本地独有提交数算不准，更新交给 git 判断）' if info.shallow else '完整克隆'}")
        log_line(f"工作区     : {'干净' if info.dirty == 0 else f'有 {info.dirty} 处本地改动'}")
        for name, url in info.remotes.items():
            tag = "  ← 官方" if ginfo.official_remote({name: url}) == url else ""
            log_line(f"远端 {name:<7}: {url}{tag}")
        if ident.tier == "unofficial":
            log_line("提示       : 远端不在官方名下（fork/镜像/本地克隆）；"
                     "要与官方同步请自行 merge")
    else:
        log_line(f"git 校验   : —（{ident.evidence}）")
    log_line("=== 自检结束 ===")
    return 0


def main() -> int:
    args = [a.lower() for a in sys.argv[1:]]
    if "--selfcheck" in args:
        return selfcheck()
    if "--headless" in args:
        mode = "auto"
        for cand in ("online", "offline"):
            if f"--{cand}" in args:
                mode = cand
        eng = Engine(mode=mode, use_mirror="--no-mirror" not in args)
        try:
            log_line("=== 无界面完整安装开始 ===")
            eng.run_full(headless=True, start="--no-start" not in args)
            log_line("=== 完成 ===")
            return 0
        except Exception as exc:  # noqa: BLE001
            log_line(f"=== 失败：{exc} ===")
            return 1
    App().mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
