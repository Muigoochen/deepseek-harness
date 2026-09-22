# -*- coding: utf-8 -*-
"""登记「本助手启动的子进程」，并在关窗时把它们连同子孙一起结束。

为什么需要：Windows 不会因为父进程结束就带走子进程。安装、构建、克隆、拉取
这类命令要跑几分钟，而执行它们的工作线程是 daemon——界面一关，线程被直接
丢掉，子进程无人认领就成了看不见的孤儿：继续往安装目录写文件、占着文件锁，
用户以为已经停了，下次重开还会撞上它。

做法是给每个子进程留一个句柄（`run()` 登记，跑完注销），关窗前
`kill_all()` 统一清理。结束必须连子孙一起：`proc.kill()` 只杀得掉最外层
的 cmd.exe，真正的 node 会活下来继续占端口。

只依赖标准库；结束失败一律静默——进程可能刚好自己退出了。
"""
from __future__ import annotations

import os
import subprocess
import threading
from typing import Any, Optional

#: 还在跑的、由本助手启动的子进程。
_CHILDREN: "set[subprocess.Popen]" = set()
_LOCK = threading.Lock()

#: 单次 taskkill 的等待上限（秒）。
KILL_TIMEOUT = 15
#: 关窗那一条路的等待上限：反正 Job Object 会在进程退出时兜底，不必让界面干等。
CLOSE_KILL_TIMEOUT = 5

#: Job Object 句柄（仅 Windows）。取不到时全程为 None，退回 kill_all 那条路。
_JOB: Optional[int] = None
_JOB_READY = False
_JOB_LOCK = threading.Lock()

#: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE / JOB_OBJECT_LIMIT_BREAKAWAY_OK
#: / JobObjectExtendedLimitInformation
_KILL_ON_JOB_CLOSE = 0x2000
_ALLOW_BREAKAWAY = 0x0800
_EXTENDED_LIMIT = 9

#: 建 Job 时用的限制位：本进程一死就带走全部成员，但**允许**成员显式逃离
#: （浏览器这类"用户的程序"必须能留在 Job 外，见 `detached_creation_flags`）。
JOB_LIMIT_FLAGS = _KILL_ON_JOB_CLOSE | _ALLOW_BREAKAWAY


def detached_creation_flags() -> int:
    """启动"不该被关窗带走"的进程（浏览器、系统工具）时用的创建标志。

    Job 是**遗传**的：本助手在 Job 里的进程（例如 `dsh web` 的 node）拉起的浏览器，
    默认会进同一个 Job——于是用户关掉小助手时，连整台浏览器（以及他别的标签页）一起
    被杀。允许 breakaway + 显式声明逃离，这类外部程序才能留在 Job 外。
    返回 0 表示本平台不需要（非 Windows）。
    """
    if os.name != "nt":
        return 0
    return (int(getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000))
            | int(getattr(subprocess, "DETACHED_PROCESS", 0x00000008)))


def _win_job() -> Optional[int]:
    """创建（一次）带 `KILL_ON_JOB_CLOSE` 的 Job Object；拿不到就返回 None。

    这是「父死子必死」的保险：子进程进了这个 Job 之后，**句柄随本进程关闭**
    （正常退出、被任务管理器强杀、崩溃都一样）→ 系统自动结束 Job 里的全部进程。
    只用 kill_all() 的话，只有「点关闭按钮」这一条路能兜住。
    """
    global _JOB, _JOB_READY
    with _JOB_LOCK:
        if _JOB_READY:
            return _JOB
        _JOB_READY = True
        if os.name != "nt":
            return None
        try:
            import ctypes
            from ctypes import wintypes

            class _BasicLimit(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                            ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t),
                            ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t),
                            ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class _IoCounters(ctypes.Structure):
                _fields_ = [("ReadOperationCount", ctypes.c_uint64),
                            ("WriteOperationCount", ctypes.c_uint64),
                            ("OtherOperationCount", ctypes.c_uint64),
                            ("ReadTransferCount", ctypes.c_uint64),
                            ("WriteTransferCount", ctypes.c_uint64),
                            ("OtherTransferCount", ctypes.c_uint64)]

            class _ExtendedLimit(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", _BasicLimit),
                            ("IoInfo", _IoCounters),
                            ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            # 显式声明签名：HANDLE 在 64 位下是 8 字节，交给 ctypes 默认的 int 编组会截断
            kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
            kernel32.SetInformationJobObject.restype = wintypes.BOOL
            kernel32.SetInformationJobObject.argtypes = [
                wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                return None
            info = _ExtendedLimit()
            info.BasicLimitInformation.LimitFlags = JOB_LIMIT_FLAGS
            if not kernel32.SetInformationJobObject(
                    handle, _EXTENDED_LIMIT, ctypes.byref(info), ctypes.sizeof(info)):
                kernel32.CloseHandle(handle)
                return None
            _JOB = handle
            return _JOB
        except Exception:            # noqa: BLE001  Job 只是保险，取不到就退回 kill_all
            return None


def job_available() -> bool:
    """Job Object 保险是否生效（`--selfcheck` 报这一项）。"""
    return _win_job() is not None


def assign(proc: subprocess.Popen) -> bool:
    """把子进程放进 Job：本进程无论怎么死，它都会跟着结束。"""
    if os.name != "nt":
        return False
    handle = _win_job()
    if handle is None:
        return False
    try:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        return bool(kernel32.AssignProcessToJobObject(handle, int(proc._handle)))
    except Exception:                # noqa: BLE001  已在自己所属 Job 里且不许嵌套等，忽略
        return False


def _parse_netstat_pids(text: str, port: int) -> list[int]:
    """从 `netstat -ano` 输出里挑出**正在监听** `port` 的 pid（去重、保持出现顺序）。

    状态列在中文系统上也是英文 `LISTENING`，所以按它筛；IPv6 行（`[::]:3080`）同样以
    `TCP` 开头，取最后一个冒号后的数字即可。`ESTABLISHED` 行必须排除，否则会把连上来的
    一方（浏览器）也算成占用者。
    """
    pids: list[int] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        if parts[3].upper() != "LISTENING":
            continue
        if parts[1].rsplit(":", 1)[-1] != str(port):
            continue
        if parts[4].isdigit() and int(parts[4]) not in pids:
            pids.append(int(parts[4]))
    return pids


def port_owner_pids(port: int, *, timeout: int = 10) -> list[int]:
    """正在监听 `port` 的进程 pid 列表；查不到（netstat 不可用等）返回空表。"""
    try:
        done = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                              stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, errors="replace", timeout=timeout)
    except Exception:        # noqa: BLE001  netstat 缺失/卡住：当作查不到
        return []
    return _parse_netstat_pids(done.stdout or "", port)


def kill_pid_tree(pid: int, *, timeout: int = KILL_TIMEOUT) -> bool:
    """按 pid 结束整棵进程树。

    给"手上没有 Popen 对象"的场合用：端口被上一次没关干净的 dsh web 占着时，我们只有
    netstat 报出来的 pid。非 Windows 一律返回 False（本工具只服务 Windows）。
    """
    if pid <= 0 or os.name != "nt":
        return False
    try:
        done = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                              stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, errors="replace", timeout=timeout)
    except Exception:        # noqa: BLE001  taskkill 缺失/卡住
        return False
    return done.returncode == 0


def track(proc: subprocess.Popen) -> None:
    """登记一个子进程：关窗时它会被 `kill_all()` 结束，并被 Job 兜住。"""
    assign(proc)
    with _LOCK:
        for dead in [p for p in _CHILDREN if p.poll() is not None]:
            _CHILDREN.discard(dead)  # 顺手清掉跑完的，别让登记表无限长
        _CHILDREN.add(proc)


def untrack(proc: subprocess.Popen) -> None:
    """命令已经跑完，取消登记。"""
    with _LOCK:
        _CHILDREN.discard(proc)


def kill_tree(proc: subprocess.Popen, *, timeout: int = KILL_TIMEOUT) -> None:
    """结束一个子进程**连同它的子孙**；已经退出则什么都不做。

    Windows 用 `taskkill /T /F`：`proc.kill()` 只结束父进程，`pnpm` 拉起来的
    node 会留下来继续占用端口和文件锁。taskkill 不可用时退回 kill 父进程，
    至少不会什么都不做。
    """
    try:
        if proc.poll() is not None:
            return
    except OSError:              # 句柄已失效，当作已退出
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=timeout)
            return
        except Exception:        # noqa: BLE001  taskkill 缺失/卡住，退回结束父进程
            pass
    try:
        proc.kill()
    except Exception:            # noqa: BLE001  进程可能刚好自己退出了
        pass


def kill_all(*, timeout: int = KILL_TIMEOUT) -> int:
    """结束所有登记在册、还在跑的子进程；返回结束了几个。

    关窗时可以用更短的 `timeout`：Job Object 会在本进程退出（句柄关闭）时兜底
    结束全部成员，所以不必为了个别赖着不走的进程让界面干等。
    """
    with _LOCK:
        procs = [p for p in _CHILDREN if p.poll() is None]
    for proc in procs:
        kill_tree(proc, timeout=timeout)
    return len(procs)


def run(argv: Any, *, cwd: Optional[Any] = None, env: Optional[dict] = None,
        shell: bool = False, timeout: Optional[float] = None, text: bool = False,
        encoding: Optional[str] = None) -> subprocess.CompletedProcess:
    """跑一条命令并登记句柄，返回 `subprocess.CompletedProcess`。

    与 `subprocess.run(..., capture_output=True)` 的三处差异（都是刻意的）：
    ① 命令在跑的时候句柄登记在册，关窗时能被 `kill_all()` 一起结束；
    ② `stdin` 指向空设备——子进程读输入会立刻拿到 EOF，而不是跟界面抢键盘；
    ③ 超时抛出的 `TimeoutExpired` **不带**已读到的部分输出（那种情况下本来也没读全）。
    返回值（args/returncode/stdout/stderr）与老写法一致，调用方无需改动。
    字符串命令加 `shell=True`（Windows 上跑 `pnpm.cmd` 这类批处理需要）。
    `env=None` 就是**继承**（交给 `Popen` 自己的语义），不要改写成 `dict(os.environ)`：
    Windows 上 Python 会把环境变量名**大写化**（`npm_execpath` 存成 `NPM_EXECPATH`），
    于是 `dict(os.environ).get("npm_execpath")` 查不到——那只是键名大小写的假象，
    `Popen(env=…)` 传过去后 Node 仍然读得到（`process.env` 在 Windows 上不区分大小写）。
    真正的问题是**按前缀枚举**：`npm_config_*` 会变成 `NPM_CONFIG_*`，凡是 `startswith`
    大小写敏感的地方就会全部看不见。所以这里继续用 `env=None` 继承，不自己拼环境。
    """
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd) if cwd is not None else None,
        env=env,                          # None = 原样继承父进程的环境块
        stdin=subprocess.DEVNULL,          # 子进程别去抢界面的键盘输入
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        shell=shell, text=text, encoding=encoding,
        errors="replace" if encoding else None)
    track(proc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc, timeout=5)         # 超时的命令不能留着继续跑
        out, err = proc.communicate()
        raise
    finally:
        untrack(proc)
    return subprocess.CompletedProcess(argv, proc.returncode, out, err)


def running() -> int:
    """当前登记在册、还在跑的子进程数量。"""
    with _LOCK:
        return len([p for p in _CHILDREN if p.poll() is None])
