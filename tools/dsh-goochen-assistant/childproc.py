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
from typing import Any, Optional, Sequence

#: 还在跑的、由本助手启动的子进程。
_CHILDREN: "set[subprocess.Popen]" = set()
_LOCK = threading.Lock()

#: 单次 taskkill 的等待上限（秒）。
KILL_TIMEOUT = 15


def track(proc: subprocess.Popen) -> None:
    """登记一个子进程：关窗时它会被 `kill_all()` 结束。"""
    with _LOCK:
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


def kill_all() -> int:
    """结束所有登记在册、还在跑的子进程；返回结束了几个。"""
    with _LOCK:
        procs = [p for p in _CHILDREN if p.poll() is None]
    for proc in procs:
        kill_tree(proc)
    return len(procs)


def run(argv: Any, *, cwd: Optional[Any] = None, env: Optional[dict] = None,
        shell: bool = False, timeout: Optional[float] = None, text: bool = False,
        encoding: Optional[str] = None) -> subprocess.CompletedProcess:
    """跑一条命令并登记句柄，返回 `subprocess.CompletedProcess`。

    语义等同于 `subprocess.run(..., capture_output=True)`，唯一的区别是命令
    在跑的时候句柄登记在册，所以关窗时能被 `kill_all()` 一起结束。字符串命令
    加 `shell=True`（Windows 上跑 `pnpm.cmd` 这类批处理需要）。
    """
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd) if cwd is not None else None,
        env=env if env is not None else dict(os.environ),
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
