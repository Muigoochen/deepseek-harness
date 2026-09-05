# -*- coding: utf-8 -*-
"""DeepSeek Harness 安装助手（图形版 · 双模：离线/在线/自动）

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

APP_TITLE = "DeepSeek Harness 安装助手 v0.1"
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
PROJECT_DIR = INSTALL_BASE / SOURCE_DIR_NAME
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
        project = PROJECT_DIR
        pkg = project / "package.json"
        if pkg.exists():
            self.log(f"④ 源码已存在：{project}（复用）")
            return project
        self.log("④ 准备项目源码 …")
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
            self.log("  git clone 官方源码（取决于网络）…")
            project.parent.mkdir(parents=True, exist_ok=True)
            proc = run(["git", "clone", "--depth", "1", HARNESS_GIT_URL, str(project)])
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
            self.log("…安装/构建完成（未自动启动）；可点『只启动网页版』开始使用")

    def run_start_only(self) -> None:
        env = self.check_env()
        if not env.get("node"):
            raise InstallError("未检测到 Node.js；请先完成「一键完整安装」")
        if not env.get("pnpm"):
            raise InstallError("未检测到 pnpm；请先完成「一键完整安装」")
        if not PROJECT_DIR.exists():
            raise InstallError(f"未找到项目源码 {PROJECT_DIR}；请先完成「一键完整安装」")
        self.start(PROJECT_DIR)


# ---------------------------------------------------------------- GUI
class App(tk.Tk):
    WIDTH, HEIGHT = 780, 640

    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry(f"{self.WIDTH}x{self.HEIGHT}")
        self.minsize(700, 560)
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
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(400, self._refresh_plugins)

    def _build_ui(self) -> None:
        pad = {"padx": 12, "pady": 5}
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)

        ttk.Label(root, text=APP_TITLE,
                  font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
        ttk.Label(root, text="自动：检测环境 → Node → pnpm → 源码 → 依赖 → 构建 → 打开网页版",
                  foreground="#555").pack(anchor="w", pady=(0, 6))

        # 安装方式
        box = ttk.LabelFrame(root, text="安装方式", padding=8)
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

        # 按钮
        btns = ttk.Frame(root)
        btns.pack(fill="x", pady=6)
        self.btn_full = ttk.Button(btns, text="一键完整安装", command=self.on_full)
        self.btn_full.pack(side="left", ipadx=16, ipady=3)
        self.btn_start = ttk.Button(btns, text="只启动网页版", command=self.on_start)
        self.btn_start.pack(side="left", padx=8, ipadx=16, ipady=3)
        self.btn_term = ttk.Button(btns, text="▶ 在窗口内运行 dsh web",
                                   command=self.on_terminal)
        self.btn_term.pack(side="left", padx=8, ipadx=16, ipady=3)
        self.btn_stop = ttk.Button(btns, text="⏹ 停止服务", command=self.on_stop_terminal,
                                   state="disabled")
        self.btn_stop.pack(side="left", padx=(0, 8), ipadx=16, ipady=3)
        ttk.Label(btns, text="（终端输出在本窗口实时显示）",
                  foreground="#666").pack(side="left", padx=0)

        # 打开与复制
        ops = ttk.LabelFrame(root, text="打开与复制（选浏览器 → 打开登录页 / 复制）", padding=8)
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
        ttk.Label(ops, text="用「▶ 在窗口内运行 dsh web」启动后，可在此再次打开或复制带 token 的登录地址。",
                  foreground="#666").pack(anchor="w", pady=(6, 0))

        self._build_plugin_ui(root)

        # 日志
        lf = ttk.LabelFrame(root, text="日志")
        lf.pack(fill="both", expand=True)
        self.txt = tk.Text(lf, height=14, wrap="word", state="disabled",
                           font=("Microsoft YaHei UI", 9))
        sb = ttk.Scrollbar(lf, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.txt.pack(fill="both", expand=True)

        self.status = ttk.Label(root, text="就绪", foreground="#1a6b1a")
        self.status.pack(anchor="w", pady=(6, 0))

        self._append("欢迎！选择安装方式后点击「一键完整安装」。")
        self.log = self._append

    def _append(self, msg: str) -> None:
        def write():
            self.txt.configure(state="normal")
            self.txt.insert("end", str(msg) + "\n")
            self.txt.see("end")
            self.txt.configure(state="disabled")
        try:
            self.after(0, write)
        except Exception:  # noqa: BLE001
            pass

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.btn_full.configure(state=state)
        self.btn_start.configure(state=state)
        self.btn_term.configure(state=state)
        for b in getattr(self, "_plugin_btns", ()):
            try:
                b.configure(state="disabled" if busy or self.plugin_busy else "normal")
            except Exception:  # noqa: BLE001
                pass
        self.btn_open_page.configure(state=state)

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
        self._set_busy(True)
        eng = Engine(mode=self.mode.get(), use_mirror=self.mirror.get(),
                     log=self._append)
        threading.Thread(target=self._job, args=(eng, "full"), daemon=True).start()

    def on_start(self) -> None:
        if self.busy:
            return
        self._set_busy(True)
        eng = Engine(mode=self.mode.get(), use_mirror=self.mirror.get(),
                     log=self._append)
        threading.Thread(target=self._job, args=(eng, "start"), daemon=True).start()

    def _job(self, eng: Engine, which: str) -> None:
        try:
            if which == "full":
                self._status("安装进行中…", "#b36b00")
                eng.run_full(headless=False, start=True)
                self._status("完成 ✓ 已启动网页版", "#1a6b1a")
                messagebox.showinfo("完成", f"安装完成！\n浏览器将打开 {WEB_URL}。\n"
                                            "日常使用直接点『只启动网页版』。")
            else:
                self._status("启动中…", "#b36b00")
                eng.run_start_only()
                self._status("运行中 ✓ 网页版已启动", "#1a6b1a")
                messagebox.showinfo("启动", f"网页版已启动：\n{WEB_URL}\n"
                                            "（详情看日志，含带 token 的地址）")
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
        """可用项目目录：优先用户目录安装位，其次脚本仓库（本机验证用）。"""
        cands = [PROJECT_DIR,
                 HERE.parent.parent,          # tools/dsh-offline-installer → 仓库根
                 HERE.parent / "deepseek-harness"]
        for cand in cands:
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
                                 f"已检查：{PROJECT_DIR}")
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
        self.btn_stop.configure(state="normal")
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
                         "请点『▶ 在窗口内运行 dsh web』后重试。")
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
                                 f"找不到项目源码目录；已检查 {PROJECT_DIR}")
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
            self.after(0, lambda: self.btn_stop.configure(state="disabled"))
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
                self.btn_stop.configure(state="disabled")
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
            self.btn_stop.configure(state="disabled")
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
        box = ttk.LabelFrame(root, text="插件（@dsh-user 插件管理 v0.1）", padding=8)
        box.pack(fill="x", pady=4)
        bar = ttk.Frame(box)
        bar.pack(fill="x")
        ttk.Button(bar, text="重新扫描", command=self._refresh_plugins,
                   width=10).pack(side="left")
        ttk.Button(bar, text="从文件夹导入…", command=self._plugin_import,
                   width=14).pack(side="left", padx=6)
        self.plugin_hint_lbl = ttk.Label(bar, text="扫描中…", foreground="#666")
        self.plugin_hint_lbl.pack(side="left", padx=6)
        self.plugin_rows = ttk.Frame(box)
        self.plugin_rows.pack(fill="x", pady=(6, 0))
        self.plugin_btns: list[ttk.Button] = []
        self.plugin_note = ttk.Label(
            box, text="外部/内置行 v0.1 只读展示；改动为草稿，点「保存」才落盘并重启验证。",
            foreground="#888", font=("Microsoft YaHei UI", 8))
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
            sources = pstore.discover_sources(project, ASSETS)
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
            self.after(0, lambda: self._apply_plugin_view(cards, home, project))
        except Exception as exc:  # noqa: BLE001
            self._append(f"[插件] 刷新失败：{exc}")

    def _apply_plugin_view(self, cards, home: Path, project: Path) -> None:
        self.plugin_cards = cards
        self.plugin_home_dir, self.plugin_project = home, project
        for child in self.plugin_rows.winfo_children():
            child.destroy()
        self.plugin_btns.clear()
        if not cards:
            ttk.Label(self.plugin_rows, text="（未发现插件：可在项目 plugins/ 或 assets/plugins/ 放置，或「从文件夹导入」）",
                      foreground="#888").pack(anchor="w")
        for card in cards:
            row = ttk.Frame(self.plugin_rows)
            row.pack(fill="x", pady=1)
            pending = self.plugin_pending.get(card.slug)
            mark = {"install": "待安装", "uninstall": "待卸载",
                    "set_on": "待启用", "set_off": "待停用"}.get(pending, "")
            tail = f"  [{mark}]" if mark else ""
            ttk.Label(row, text=card.slug, width=20,
                      font=("Microsoft YaHei UI", 9, "bold")).pack(side="left")
            st = self.STATE_CN.get(card.state, card.state)
            ttk.Label(row, text=st + tail, width=22,
                      foreground=self.STATE_COLOR.get(card.state, "#000")
                      ).pack(side="left")
            desc = (card.description or "")[:40]
            ttk.Label(row, text=desc, foreground="#666").pack(side="left", fill="x", expand=True)
            for text, act, enabled in self._row_actions(card):
                btn = ttk.Button(row, text=text, width=8,
                                 command=lambda s=card.slug, a=act: self._plugin_act(s, a))
                if not enabled:
                    btn.configure(state="disabled")
                btn.pack(side="left", padx=2)
                self.plugin_btns.append(btn)
        self.plugin_hint_lbl.configure(text=f"{len(cards)} 个插件"
                                       if cards else "无插件")
        self._set_plugin_busy(self.plugin_busy)

    @staticmethod
    def _row_actions(card: pstore.PluginCard) -> list[tuple[str, str, bool]]:
        st = card.state
        if st == "downloaded":
            return [("安装", "install", card.validation_errors == ()),
                    ("校验失败", "none", card.validation_errors != ())]
        if st == "enabled":
            return [("停用", "set_off", True), ("卸载", "uninstall", True)]
        if st == "disabled":
            return [("启用", "set_on", True), ("卸载", "uninstall", True)]
        return []          # external / first_party：只读展示

    def _plugin_act(self, slug: str, action: str) -> None:
        if self.plugin_busy or action == "none":
            if action == "none":
                messagebox.showinfo("校验失败",
                                    "该插件未通过安装前置校验（name/lib/client 等），见日志。")
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
        was_running = self.web_proc is not None and self.web_proc.poll() is None
        try:
            if home is None or project is None:
                raise pstore.PluginError("插件环境未就绪（先点「重新扫描」）。")
            pending = list(self.plugin_pending.items())
            # 卸载/启停前先停 web：避免删除运行中的共享目录/热态竞争
            had_uninstall = any(a == "uninstall" for _, a in pending)
            if had_uninstall and was_running:
                self._stop_web_internal(quiet=True)
            sources = {s.slug: s for s in pstore.discover_sources(project, ASSETS)}
            for slug, act in pending:
                try:
                    if act == "install":
                        src = sources.get(slug)
                        if src is None:
                            raise pstore.PluginError(f"{slug} 不在来源目录中")
                        pstore.install(home, src, project=project)
                        self._append(f"[插件] ✓ 已安装 {slug}")
                    elif act == "uninstall":
                        pstore.uninstall(home, slug, project=project)
                        self._append(f"[插件] ✓ 已卸载 {slug}")
                    elif act in ("set_on", "set_off"):
                        pstore.set_enabled(home, slug, enabled=(act == "set_on"),
                                           project=project)
                        self._append(f"[插件] ✓ {'启用' if act == 'set_on' else '停用'} {slug}")
                except (pstore.PluginError, pstore.ProtectedShapeError,
                        pstore.GateError) as exc:
                    ok_all = False
                    self._append(f"[插件] ✗ {slug}：{exc}")
                    break
            self.rollback_armed = ok_all and any(
                a in ("install", "set_on") for _, a in pending)
        except Exception as exc:  # noqa: BLE001
            ok_all = False
            self._append(f"[插件] ✗ 保存失败：{exc}")
        finally:
            self.after(0, lambda: self._plugin_save_done(ok_all, was_running))

    def _plugin_save_done(self, ok_all: bool, was_running: bool) -> None:
        self.plugin_pending.clear()
        self._set_plugin_busy(False)
        if ok_all and (was_running or self.rollback_armed):
            # 确定性验证：重启 + 健康检查（失败自动回滚）
            self._append("[插件] 正在重启网页版以确认生效…")
            self._stop_web_internal(quiet=True)
            if self._launch_web():
                self._activation_checks = 0
                self.after(600, self._activation_poll)
        elif ok_all:
            self._status("已保存（补丁已热应用；未运行服务，下次启动生效）")
            self._append("[插件] 已保存：改动已热应用；下次启动生效。")
        else:
            self._status("保存失败，见日志", "#b00000")
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
        project = self._resolve_web_project()
        if project is None:
            messagebox.showerror("未找到项目", "找不到项目源码目录，无法导入。")
            return
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
        dst = project / "plugins" / slug
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            messagebox.showerror("已存在", f"{dst} 已存在，请先处理。")
            return
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
            "__pycache__", "*.pyc", ".git", "tmp"))
        self._append(f"[插件] 已导入到 {dst}（重新扫描后即可安装）")
        self._refresh_plugins()

    def _on_close(self) -> None:
        """关窗口前先停 dsh web，再销毁窗口。"""
        self._stop_web_internal(quiet=False)
        try:
            self.destroy()
        except Exception:
            pass


def selfcheck() -> int:
    log_line("=== 环境自检（DeepSeek Harness 安装助手） ===")
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

    log_line("离线数据（assets/）：")
    for name, path, ok in Engine.describe_assets():
        log_line(f"  {'✓' if ok else '—'} {name:<12} {path}")

    target = PROJECT_DIR
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
