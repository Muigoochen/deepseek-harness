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
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import plugin_store as pstore  # 插件管理原语（同目录模块）

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
    return subprocess.run(argv, cwd=str(cwd) if cwd else None,
                          env=env if env is not None else dict(os.environ),
                          capture_output=True, text=False)


def run_cli(argv: list[str], cwd: Path | None = None,
            env: dict | None = None) -> subprocess.CompletedProcess:
    """Windows 下经 cmd shell 执行（能解析 pnpm.cmd 等批处理），
    其他平台退化到原生 run()。GUI 进程/线程都可用。"""
    if os.name == "nt":
        import subprocess as sp
        cmdline = " ".join(f'"{a}"' if (" " in a or a.endswith((".cmd", ".exe"))) and not a.startswith('"') else a
                           for a in argv)
        return sp.run(cmdline, cwd=str(cwd) if cwd else None,
                      env=env if env is not None else dict(os.environ),
                      capture_output=True, text=False, shell=True)
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
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                               encoding="utf-8")
    except OSError as exc:
        log_line(f"[配置] 保存失败（本次运行仍生效）：{exc}")


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
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        root = Path(f"{letter}:\\")
        if root == system or not root.exists():
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


def project_dir() -> Path:
    """实际安装位：用户配置优先，其次方案 A 默认（含空间回退）。"""
    raw = str(load_config().get("installDir", "")).strip()
    if raw:
        return Path(os.path.expandvars(raw)).expanduser()
    return default_project_dir()


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
    try:
        subprocess.Popen([exe, url], close_fds=True)
    except Exception as exc:  # noqa: BLE001
        return f"失败：{exc}"
    return f"已用 {Path(exe).name} 打开"


class InstallError(RuntimeError):
    pass


class Engine:
    """核心安装流程：由 worker 线程执行，log 回调发回 UI。"""

    def __init__(self, mode: str, use_mirror: bool, log=log_line):
        self.mode = mode                # "auto" | "offline" | "online"
        self.use_mirror = use_mirror
        self.log = log
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
        offline = self.use_offline(PNPM_TGZ_ASSET.exists(), "pnpm 离线包")
        if offline:
            proc = run(["npm", "install", "-g", str(PNPM_TGZ_ASSET)])
        else:
            proc = run(["npm", "install", "-g", "pnpm@11.7.0"])
        if proc.returncode != 0:
            raise InstallError(f"pnpm 安装失败：\n{decode_proc(proc)}")
        corepack = run(["corepack", "enable"])
        if corepack.returncode != 0:
            self.log("  （corepack enable 未生效，不影响：已有 pnpm 可用）")
        self.log("  pnpm 安装完成")
        return find_pnpm()

    def prepare_source(self) -> Path:
        project = project_dir()
        pkg = project / "package.json"
        if pkg.exists():
            self.log(f"④ 源码已存在：{project}（复用）")
            return project
        self.log(f"④ 准备项目源码 → {project}")
        offline = self.use_offline(
            SOURCE_ARCHIVE.exists() or STORE_DIR.exists(),
            "源码包/依赖缓存")
        if offline and SOURCE_ARCHIVE.exists():
            self.log("  解压随包源码 …")
            project.mkdir(parents=True, exist_ok=True)
            proc = run(["tar", "-xzf", str(SOURCE_ARCHIVE), "-C", str(project)])
            if proc.returncode != 0:
                raise InstallError(f"源码解压失败：\n{decode_proc(proc)}")
        else:
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
        if not (project / "package.json").exists():
            raise InstallError("源码就绪但缺少 package.json，安装中止")
        self.log(f"  源码就绪：{project}")
        return project

    def install_deps(self, project: Path) -> None:
        if (project / "node_modules").exists():
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

    def build(self, project: Path) -> None:
        if (project / BUILD_MARK).exists():
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
        self.install_deps(project)
        self.build(project)
        if start:
            self.start(project)
        else:
            self.log("…安装/构建完成（未自动启动）；可点『运行』开始使用")


# ---------------------------------------------------------------- GUI
class App(tk.Tk):
    WIDTH, HEIGHT = 860, 720

    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry(f"{self.WIDTH}x{self.HEIGHT}")
        self.minsize(760, 600)
        self.mode = tk.StringVar(value="auto")
        self.mirror = tk.BooleanVar(value=True)
        self.busy = False
        self.web_proc: subprocess.Popen | None = None
        self.web_dir: Path | None = None
        self.web_auth_url: str | None = None
        self.custom_browser: str | None = None
        self._open_pending = False
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
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(400, self._refresh_plugins)

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
        # 安装方式
        box = ttk.LabelFrame(tab_run, text="安装方式", padding=8)
        box.pack(fill="x", pady=4)
        hints = Engine.describe_assets()
        hint_txt = "已检测到离线数据：" if any(f for _, _, f in hints) else "未检测到离线数据（将走网络）："
        ttk.Label(box, text=hint_txt, foreground="#666").pack(anchor="w")
        for name, path, ok in hints:
            ttk.Label(box, text=f"  {'✓' if ok else '—'} {name}",
                      foreground="#2a6b2a" if ok else "#999").pack(anchor="w")
        ttk.Radiobutton(box, text="自动选择（推荐）——有离线包走离线，缺的自动联网补",
                        variable=self.mode, value="auto").pack(anchor="w", pady=(6, 0))
        ttk.Radiobutton(box, text="离线安装——完全不依赖网络（需随包离线数据）",
                        variable=self.mode, value="offline").pack(anchor="w")
        ttk.Radiobutton(box, text="在线安装——从网络源下载（较慢）",
                        variable=self.mode, value="online").pack(anchor="w")
        ttk.Checkbutton(box, text="在线安装时使用国内镜像 npmmirror 加速", variable=self.mirror
                        ).pack(anchor="w")

        # 安装位置（可配置；默认方案 A：%USERPROFILE%\deepseek-harness）
        loc = ttk.LabelFrame(tab_run, text="安装位置（产品会独立克隆到这里）", padding=8)
        loc.pack(fill="x", pady=4)
        lrow = ttk.Frame(loc)
        lrow.pack(fill="x")
        self.dir_var = tk.StringVar(value=str(project_dir()))
        dir_ent = ttk.Entry(lrow, textvariable=self.dir_var)
        dir_ent.pack(side="left", fill="x", expand=True)
        dir_ent.bind("<FocusOut>", self._dir_hint)
        dir_ent.bind("<Return>", self._dir_hint)
        ttk.Button(lrow, text="浏览…", command=self._on_pick_dir).pack(side="left", padx=(6, 0))
        ttk.Button(lrow, text="恢复默认", command=self._on_reset_dir).pack(side="left", padx=(6, 0))
        self.dir_hint = ttk.Label(loc, text="", foreground="#666")
        self.dir_hint.pack(anchor="w", pady=(4, 0))
        self._dir_hint()

        # 按钮
        btns = ttk.Frame(tab_run)
        btns.pack(fill="x", pady=6)
        self.btn_full = ttk.Button(btns, text="一键完整安装", command=self.on_full)
        self.btn_full.pack(side="left", ipadx=16, ipady=3)
        self.btn_term = ttk.Button(btns, text="运行", command=self.on_terminal)
        self.btn_term.pack(side="left", padx=8, ipadx=16, ipady=3)
        self.btn_stop = ttk.Button(btns, text="⏹ 停止服务", command=self.on_stop_terminal,
                                   state="disabled")
        self.btn_stop.pack(side="left", padx=(0, 8), ipadx=16, ipady=3)
        ttk.Label(btns, text="（终端输出在下方日志区实时显示）",
                  foreground="#666").pack(side="left", padx=0)

        # 打开与复制
        ops = ttk.LabelFrame(tab_run, text="打开与复制（选浏览器 → 打开登录页 / 复制）", padding=8)
        ops.pack(fill="x", pady=4)
        row = ttk.Frame(ops)
        row.pack(fill="x")
        ttk.Label(row, text="浏览器：").pack(side="left")
        self.browser_var = tk.StringVar(value="默认浏览器")
        self.browser_box = ttk.Combobox(row, textvariable=self.browser_var,
                                        values=BROWSER_CHOICES, state="readonly", width=20)
        self.browser_box.pack(side="left", padx=(0, 4))
        self.browser_box.bind("<<ComboboxSelected>>", self._on_browser_pick)
        self.custom_hint = ttk.Label(row, text="", foreground="#666")
        self.custom_hint.pack(side="left", padx=(0, 8))
        self.btn_open_page = ttk.Button(row, text="打开登录页", command=self.on_open_page)
        self.btn_open_page.pack(side="left", ipadx=12, ipady=2)
        self.btn_copy_url = ttk.Button(row, text="复制登录地址", command=self.on_copy_url,
                                       state="disabled")
        self.btn_copy_url.pack(side="left", padx=8, ipadx=12, ipady=2)
        self.btn_copy_path = ttk.Button(row, text="复制项目路径", command=self.on_copy_path)
        self.btn_copy_path.pack(side="left", ipadx=12, ipady=2)
        ttk.Label(ops, text="用「运行」启动后，可在此再次打开或复制带 token 的登录地址。",
                  foreground="#666").pack(anchor="w", pady=(6, 0))

        # 日志（终端）
        lf = ttk.LabelFrame(tab_run, text="日志（终端输出实时显示在此）")
        lf.pack(fill="both", expand=True, pady=(4, 0))
        self.txt = tk.Text(lf, height=12, wrap="word",
                           font=("Microsoft YaHei UI", 9))
        sb = ttk.Scrollbar(lf, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.txt.pack(fill="both", expand=True)
        # 只读但可选中/复制：拦截编辑类按键，保留 Ctrl 快捷键与鼠标选择
        self.txt.bind("<Key>", self._ro_key)
        self.txt.bind("<<Paste>>", lambda e: "break")
        self.txt.bind("<<Cut>>", lambda e: "break")
        self.txt.bind("<Button-3>", self._log_popup)

        # ---------------- Tab 2：插件 ----------------
        self._build_plugin_ui(tab_plug)

        # ---------------- Tab 3：会话迁移 ----------------
        self._build_migrate_ui(tab_mig)

        self.status = ttk.Label(root, text="就绪", foreground="#1a6b1a")
        self.status.pack(anchor="w", pady=(6, 0))

        self._append("欢迎！安装/启动/服务日志在「安装与启动」页；插件管理在「插件」页；"
                     "会话迁移（换 preset）在「会话迁移」页。")
        self.log = self._append

    def _append(self, msg: str) -> None:
        def write():
            self.txt.insert("end", str(msg) + "\n")
            self.txt.see("end")
        try:
            self.after(0, write)
        except Exception:  # noqa: BLE001
            pass

    def _ro_key(self, e) -> str | None:
        """只读保护：拦截会改动文本的按键，保留方向键与 Ctrl 组合（复制/全选）。"""
        if e.state & 0x0004:            # Control
            return None
        if e.keysym in ("Left", "Right", "Up", "Down", "Home", "End",
                        "Prior", "Next"):
            return None
        return "break"

    def _log_popup(self, e) -> None:
        m = tk.Menu(self, tearoff=0)
        m.add_command(label="复制选中", command=self._log_copy_sel)
        m.add_command(label="复制全部", command=self._log_copy_all)
        try:
            m.tk_popup(e.x_root, e.y_root)
        finally:
            m.grab_release()

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
        self.btn_open_page.configure(state=state)
        self._update_run_buttons()

    def _update_run_buttons(self) -> None:
        """「运行」与「停止服务」互斥：运行中=运行灰、停止可用；否则反之。"""
        def apply() -> None:
            try:
                running = self.web_proc is not None and self.web_proc.poll() is None
                self.btn_term.configure(
                    state="disabled" if (running or self.busy) else "normal")
                self.btn_stop.configure(
                    state="normal" if (running and not self.busy) else "disabled")
            except Exception:  # noqa: BLE001
                pass
        try:
            self.after(0, apply)
        except Exception:  # noqa: BLE001
            pass

    def _status(self, text: str, color: str = "#1a6b1a") -> None:
        def setit():
            self.status.configure(text=text, foreground=color)
        try:
            self.after(0, setit)
        except Exception:  # noqa: BLE001
            pass

    def on_full(self) -> None:
        if self.busy:
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
        self._set_busy(True)
        eng = Engine(mode=self.mode.get(), use_mirror=self.mirror.get(),
                     log=self._append)
        threading.Thread(target=self._job, args=(eng,), daemon=True).start()

    def _current_dir(self) -> Path:
        raw = self.dir_var.get().strip()
        return Path(os.path.expandvars(raw)).expanduser() if raw else default_project_dir()

    def _on_pick_dir(self) -> None:
        base = self._current_dir()
        picked = filedialog.askdirectory(
            title="选择安装位置（产品将装在其下的 deepseek-harness 里）", parent=self,
            initialdir=str(base.parent) if base.parent.exists() else None)
        if not picked:
            return
        chosen = Path(picked)
        # 选中的若是父目录，自动补产品目录名，避免源码摊在盘根/桌面
        if chosen.name.lower() != SOURCE_DIR_NAME:
            chosen = chosen / SOURCE_DIR_NAME
        self.dir_var.set(str(chosen))
        self._dir_hint()

    def _on_reset_dir(self) -> None:
        self.dir_var.set(str(default_project_dir()))
        self._dir_hint()

    def _dir_hint(self, _event=None) -> None:
        """即时反馈安装位置可用性：错误红、警告橙、正常绿（最多显示 2 条提示）。"""
        target = self._current_dir()
        errors, warns = check_install_dir(target)
        if errors:
            text, color = "✗ " + errors[0], "#b00000"
        elif warns:
            shown = "；".join(warns[:2]) + ("…" if len(warns) > 2 else "")
            text, color = "⚠ " + shown, "#a05a00"
        else:
            probe = target if target.exists() else (
                target.parent if target.parent.exists() else INSTALL_BASE)
            free = free_gb(probe)
            text = (f"✓ 可用（所在磁盘剩余 {free:.0f} GB）" if free >= 0 else "✓ 可用")
            color = "#1a6b1a"
        self.dir_hint.configure(text=text, foreground=color)

    def _job(self, eng: Engine) -> None:
        try:
            self._status("安装进行中…", "#b36b00")
            eng.run_full(headless=False, start=True)
            self._status("完成 ✓ 已启动网页版", "#1a6b1a")
            messagebox.showinfo("完成", f"安装完成！\n浏览器将打开 {WEB_URL}。\n"
                                        "日常使用点「运行」。")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            self._append(f"\n✗ 失败：{msg}")
            self._status("失败 ✗（详情见日志，可复制反馈）", "#b00000")
            try:
                messagebox.showerror("操作失败", msg)
            except Exception:  # noqa: BLE001
                pass
        finally:
            self._set_busy(False)

    def _resolve_web_project(self) -> Path | None:
        """可用项目目录：用户配置/默认安装位优先；仓库根仅在显式开发态兜底。

        小助手默认与所在仓库解耦（产品由官方链接独立克隆），因此仓库根不再
        作为常规候选；本机开发时设 DSH_ASSISTANT_DEV=1 可恢复该兜底。
        """
        cands = [project_dir(), DEFAULT_PROJECT_DIR]
        if os.environ.get("DSH_ASSISTANT_DEV") == "1":
            cands.append(HERE.parent.parent)      # 开发态：tools/<本工具> → dsh 检出根
        seen: set[Path] = set()
        for cand in cands:
            if cand in seen:
                continue
            seen.add(cand)
            if (cand / "package.json").exists() and (cand / "pnpm-workspace.yaml").exists():
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
            messagebox.showerror("未找到项目",
                                 f"找不到已安装的 deepseek-harness。请先执行「一键完整安装」。\n"
                                 f"已检查：{project_dir()}")
            return False
        if shutil.which("pnpm") is None:
            messagebox.showerror("缺少 pnpm",
                                 "未检测到 pnpm。请先执行「一键完整安装」。")
            return False
        self._append(f"[终端] 工作目录：{project}")
        self._append("[终端] 启动 dsh web；输出会实时显示在这里…")
        self.web_dir = project
        self.web_auth_url = None
        self._update_web_buttons()
        pnpm = find_pnpm() or shutil.which("pnpm.cmd") or "pnpm"
        # pnpm 是 .CMD 批处理：Windows 上必须让 cmd 用 call 执行脚本。
        # 用 shell=True + 单字符串原样传给 cmd——若用 list 参数，Python 会
        # 给整条命令再套一层引号，cmd 的引号规则会把带引号的路径误当命令名。
        cmdline = f'call "{pnpm}" dsh web'
        overlay = web_clock_overlay(project)
        if overlay is not None:
            cmdline += f' --patch "{overlay}"'
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
            messagebox.showerror("启动失败", str(exc))
            self._append(f"[终端] ✗ 启动失败：{exc}")
            return False
        self.web_proc = proc
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

    def _on_auth_url(self, url: str) -> None:
        """记录从 dsh web 输出里捕获的登录地址并刷新按钮状态。"""
        self.web_auth_url = url
        self._append("[浏览器] 已捕获登录地址，可『复制登录地址』或『打开登录页』。")
        try:
            self.after(0, self._update_web_buttons)
            self.after(0, self._poll_pending_open)
        except Exception:  # noqa: BLE001
            pass

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
                                 f"找不到项目源码目录；已检查 {project_dir()}")
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
            except Exception:  # noqa: BLE001
                pass
        try:
            self.after(0, apply)
        except Exception:  # noqa: BLE001
            pass

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
            if self.web_proc is proc:
                self.web_proc = None
            self.web_auth_url = None
            self._update_web_buttons()
            self.after(0, self._poll_pending_open)
            self.after(0, self._update_run_buttons)
            self.after(0, lambda: self._status("就绪"))

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
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        self.web_proc = None
        self.web_auth_url = None
        self._update_web_buttons()
        if not quiet:
            self._append("[终端] 已停止。")
            self._update_run_buttons()
            self._status("已停止")

    # ------------------------------------------------------------------ 插件区

    STATE_CN = {
        "enabled": "已启用",
        "disabled": "已停用",
        "external": "已启用·外部(只读)",
        "external-disabled": "已停用·外部(只读)",
        "first_party": "内置(只读)",
        "first_party-disabled": "内置·停用(只读)",
        "downloaded": "已下载",
    }
    STATE_COLOR = {
        "enabled": "#1a6b1a", "disabled": "#888", "external": "#1a4a8a",
        "external-disabled": "#888", "first_party": "#666",
        "first_party-disabled": "#888", "downloaded": "#a06700",
    }

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
            text="一行一个插件，安装/卸载/启用/停用按类型自动处理；"
                 "本地插件为草稿，点「全部保存并重启网页版」落盘；"
                 "在线插件真实安装到 profile，需重启网页版生效。",
            foreground="#888", font=("Microsoft YaHei UI", 8), justify="left")
        self.plugin_note.pack(anchor="w", pady=(4, 0))
        self.btn_save = ttk.Button(box, text="全部保存并重启网页版",
                                   command=self.on_plugin_save, state="disabled")
        self.btn_save.pack(anchor="e", pady=(2, 0))
        self._plugin_btns = self.plugin_btns

    def _set_plugin_busy(self, busy: bool) -> None:
        self.plugin_busy = busy
        for b in self.plugin_btns:
            try:
                b.configure(state="disabled" if busy or self.busy else "normal")
            except Exception:  # noqa: BLE001
                pass
        try:
            self.btn_save.configure(
                state="disabled" if busy or not self.plugin_pending else "normal")
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

    def _refresh_worker(self) -> None:
        try:
            env = self._plugin_env()
            if env is None:
                self.after(0, lambda: self.plugin_hint_lbl.configure(text="环境未就绪"))
                return
            home, project = env
            # 独立化：插件默认只来自「内置清单（各自独立仓库）+ 离线资产」；
            # 只有显式开发态才额外扫描项目 plugins/。
            dev = os.environ.get("DSH_ASSISTANT_DEV") == "1"
            cache = pstore.plugin_cache_dir(home)
            sources = pstore.discover_sources(project if dev else None, ASSETS, cache)
            patch_text = ""
            patch = pstore.web_patch(home)
            if patch.exists():
                patch_text = patch.read_text(encoding="utf-8")
            try:
                dump = pstore.structure_gate(home, patch_text, project=project)
            except pstore.GateError as exc:
                self._append(f"[插件] 当前补丁结构门未过：{exc}")
                dump = pstore.parse_dump("")
            cards = pstore.status_view(home, sources, dump)
            entries = pstore.market_entries(home, project, ASSETS)
            catalog = pstore.catalog_entries(home)
            self.after(0, lambda: self._apply_plugins(cards, entries, home, project,
                                                      catalog))
        except Exception as exc:  # noqa: BLE001
            self._append(f"[插件] 刷新失败：{exc}")

    def _apply_plugins(self, cards, entries, home: Path, project: Path,
                       catalog=()) -> None:
        self.plugin_cards = cards
        self.plugin_home_dir, self.plugin_project = home, project
        self.plugin_catalog = {c["slug"]: c for c in catalog}
        items = self._merge_plugins(cards, entries, catalog)
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
                pstore.bundle_remove(home, name, project=project,
                                     env=self._bundle_env())
                self._plog(f"[市场] ✓ 已卸载 {name}（重启生效）")
                self._status(f"已卸载 {name}")
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
            self._status(f"市场操作失败：{exc}", "#b00000")
            messagebox.showerror("市场操作失败", str(exc))
        finally:
            self.after(0, self._refresh_plugins)
            self._set_plugin_busy(False)

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

    def _merge_plugins(self, cards, entries, catalog=()) -> list[dict]:
        items: list[dict] = []
        known: set[str] = set()
        for card in cards:
            known.add(card.slug)
            items.append({
                "kind": "managed", "name": card.slug, "version": "",
                "state": card.state, "desc": (card.description or "")[:40],
                "warning": card.validation_errors[0][:24] if card.validation_errors else "",
                "value": card.slug, "spec": card.slug,
            })
        # 内置清单里尚未下载（未克隆）的插件
        for c in catalog:
            if c["slug"] in known:
                continue
            items.append({
                "kind": "catalog", "name": c["slug"], "version": "",
                "state": "nodl", "desc": (c["description"] or "")[:24],
                "warning": "", "value": c["slug"], "spec": c["repo"],
            })
        for e in entries:
            st = "installed" if e.installed else ("downloaded" if e.downloaded else "nodl")
            items.append({
                "kind": "bundle", "name": e.name, "version": e.version, "state": st,
                "desc": (e.description or "")[:22], "warning": "",
                "value": str(e.local) if e.local else e.spec, "spec": e.spec,
            })
        items.sort(key=lambda it: (self._plugin_rank(it), it["name"]))
        return items

    @staticmethod
    def _plugin_rank(it: dict) -> int:
        return {"enabled": 0, "installed": 0, "disabled": 1, "downloaded": 1,
                "external": 2, "external-disabled": 2, "nodl": 3,
                "first_party": 4, "first_party-disabled": 4}.get(it["state"], 5)

    def _render_plugin_row(self, row, it) -> None:
        ttk.Label(row, text=it["name"], width=20,
                  font=("Microsoft YaHei UI", 9, "bold")).pack(side="left")
        ttk.Label(row, text=it["version"] or "—", width=9,
                  foreground="#888").pack(side="left")
        st, color = self._state_display(it)
        ttk.Label(row, text=st, width=12, foreground=color).pack(side="left")
        ttk.Label(row, text=it["desc"], foreground="#666").pack(side="left", fill="x", expand=True)
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
        if it["kind"] == "managed":
            return self.STATE_CN.get(s, s), self.STATE_COLOR.get(s, "#000")
        if it["kind"] == "catalog":
            return {"nodl": ("未下载", "#999")}.get(s, (s, "#000"))
        return {"installed": ("已安装", "#2a6b2a"),
                "downloaded": ("已下载", "#1a6bb0"),
                "nodl": ("可下载", "#999")}.get(s, (s, "#000"))

    def _actions_for(self, it) -> list[tuple[str, str, str]]:
        if it["kind"] == "managed":
            return self._managed_actions(it)
        if it["kind"] == "catalog":
            return [("下载", "fetch", it["value"])]
        return self._bundle_actions(it)

    def _managed_actions(self, it) -> list[tuple[str, str, str]]:
        st, warn, slug = it["state"], it["warning"], it["value"]
        if st == "downloaded":
            return [("看原因", "none", slug)] if warn else [("安装", "install", slug)]
        if st == "enabled":
            return [("停用", "set_off", slug), ("卸载", "uninstall", slug)]
        if st == "disabled":
            return [("启用", "set_on", slug), ("卸载", "uninstall", slug)]
        if st in ("external", "external-disabled"):
            return [("接管", "adopt", slug)]
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
            acts.append(("卸载", "uninstall", spec))
            acts.append(("校验", "check", local))
            upd = self.market_updates.get(spec, "unknown")
            label = {"unknown": "查看更新", "outdated": "可更新",
                     "current": "已最新"}.get(upd, "查看更新")
            act = {"unknown": "check_update", "outdated": "update",
                   "current": "check_update"}.get(upd, "check_update")
            acts.append((label, act, spec))
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
            self._status("下载失败 ✗（详情见日志）")
        finally:
            self.after(0, lambda: self._set_plugin_busy(False))
            self.after(0, self._refresh_plugins)

    def _plugin_act(self, slug: str, action: str) -> None:
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

    def _render_pending_only(self, _slug: str) -> None:
        # 只刷新保存按钮可用性（行内容在保存/刷新后重建）
        self.btn_save.configure(state="normal")

    def on_plugin_save(self) -> None:
        if self.plugin_busy or not self.plugin_pending:
            return
        self._set_plugin_busy(True)
        threading.Thread(target=self._plugin_save_worker, daemon=True).start()

    def _plugin_save_worker(self) -> None:
        home, project = self.plugin_home_dir, self.plugin_project
        ok_all = True
        fail_msgs: list[str] = []
        was_running = self.web_proc is not None and self.web_proc.poll() is None
        try:
            if home is None or project is None:
                raise pstore.PluginError("插件环境未就绪（先点「重新扫描」）。")
            pending = list(self.plugin_pending.items())
            # 卸载/启停前先停 web：避免删除运行中的共享目录/热态竞争
            had_uninstall = any(a == "uninstall" for _, a in pending)
            if had_uninstall and was_running:
                self._stop_web_internal(quiet=True)
            sources = {s.slug: s for s in pstore.discover_sources(
                None, ASSETS, pstore.plugin_cache_dir(home))}
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
                    elif act == "adopt":
                        pstore.adopt(home, slug, project=project)
                        self._plog(f"[插件] ✓ 已接管 {slug}（转为助手管理）")
                except (pstore.PluginError, pstore.ProtectedShapeError,
                        pstore.GateError) as exc:
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
            self.after(0, lambda: self._plugin_save_done(ok_all, was_running,
                                                         fail_msgs))

    def _plugin_save_done(self, ok_all: bool, was_running: bool,
                          fail_msgs: list[str]) -> None:
        self.plugin_pending.clear()
        self._set_plugin_busy(False)
        if not ok_all:
            self._status("插件保存失败", "#b00000")
            messagebox.showerror(
                "插件保存失败",
                "\n".join(fail_msgs) + "\n\n详情见 installer.log 与「安装与启动」页日志区。")
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
        self.after(0, lambda: self._mig_set_busy(False))
        self.after(0, lambda: self.mig_status.configure(text=f"失败：{exc}", foreground="#a11"))

    # ---- 扫描
    def _mig_scan(self) -> None:
        if self.mig_busy:
            return
        self._mig_set_busy(True)
        threading.Thread(target=self._mig_scan_worker, daemon=True).start()

    def _mig_scan_worker(self) -> None:
        try:
            self.after(0, lambda: self._mig_set_busy(True))
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
            self.after(0, lambda: self._mig_apply_rows(rows))
        except Exception as exc:  # noqa: BLE001
            self.after(0, lambda: self._mig_fail(exc))

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
            self.after(0, lambda: self._mig_set_busy(True))
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
            self.after(0, lambda: self.mig_status.configure(text=tail, foreground="#1a6b1a"))
        except Exception as exc:  # noqa: BLE001
            self.after(0, lambda: self._mig_fail(exc))
        finally:
            self.after(0, lambda: self._mig_set_busy(False))

    def _mig_open_backups(self) -> None:
        backup_root = plugin_home() / "_session-preset-backup"
        try:
            backup_root.mkdir(parents=True, exist_ok=True)
            os.startfile(str(backup_root))  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            self._mig_fail(exc)

    def _on_close(self) -> None:
        """关窗口前先停 dsh web，再销毁窗口。"""
        self._stop_web_internal(quiet=False)
        try:
            self.destroy()
        except Exception:
            pass


def selfcheck() -> int:
    log_line("=== 环境自检（DSH-孤辰小助手） ===")
    log_line(f"Python     : {sys.executable}")
    log_line(f"工作目录   : {HERE}")
    log_line(f"Windows    : {os.environ.get('OS', '?')} / "
             f"{os.environ.get('PROCESSOR_ARCHITECTURE', '?')}")
    log_line(f"管理员权限 : {'是' if is_admin() else '否'}")

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
    log_line(f"项目目录   : {target}  "
             f"{'已存在' if target.exists() else '尚未安装'}")
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
