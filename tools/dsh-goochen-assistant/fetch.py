# -*- coding: utf-8 -*-
"""取件层：安装链每一步拿文件都走这里，规矩完全一致。

顺序（对每个文件都一样）：
  ① **随包离线数据**（assets/…）——有就直接用，不联网；
  ② **国内镜像**；
  ③ **官方源**；
  全都失败才报错，错误里带上每一个来源的失败原因。

另外两条是踩过坑定下来的：
· 进度是**一行原地刷新**（GUI 替换日志最后一行、控制台用 `\\r`），不是每来一次进度就
  追加一行——否则日志会被进度刷屏，真正的信息反而被冲走；
· 先写 `.part` 再原子改名：中断/失败绝不会留下半个文件被后面的步骤当成"已有离线包"。
"""
from __future__ import annotations

import os
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CHUNK = 64 * 1024
#: 控制台进度行宽度（原地刷新用空格盖掉上一次的内容）。
_LINE = 78


class FetchError(RuntimeError):
    """所有来源都失败。消息里列出每个来源的失败原因。"""


@dataclass(frozen=True)
class Source:
    """一个可用的来源。

    `path` 非空 = 随包离线数据（本机文件，直接用）；否则按 `url` 下载。
    """

    name: str
    url: str = ""
    path: Path | None = None


def human(n: float) -> str:
    """把字节数写成好读的形式。"""
    unit = "B"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            break
        n /= 1024
    return f"{n:,.0f} {unit}" if unit == "B" else f"{n:,.1f} {unit}"


class Reporter:
    """日志 + 单行进度。

    `line(text)` 追加一行（写日志文件）；`progress(text)` 原地刷新一行（**不进文件**，
    免得几百条进度把日志撑爆）。GUI 传进来的是"替换最后一行"的回调；控制台用 `\\r`。
    """

    def __init__(self, line, progress=None) -> None:
        self._line = line
        self._progress_sink = progress
        self._active = False

    def line(self, text: str) -> None:
        self._clear()
        self._line(text)

    def progress(self, text: str) -> None:
        self._active = True
        if self._progress_sink is not None:
            self._progress_sink(text)
        else:
            print("\r" + text.ljust(_LINE)[:_LINE], end="", flush=True)

    def done(self) -> None:
        """结束一次进度刷新（换行前把那一行擦掉）。"""
        self._clear()

    def _clear(self) -> None:
        if self._active and self._progress_sink is None:
            print("\r" + " " * _LINE + "\r", end="", flush=True)
        self._active = False


def _download(url: str, dest: Path, *, report: Reporter, timeout: float,
              opener=None) -> tuple[int, float]:
    """下载到 `dest`（先 `.part`、校验大小、再原子改名）。返回 (字节数, 秒数)。"""
    part = dest.with_name(dest.name + ".part")
    part.unlink(missing_ok=True)
    open_url = opener or urllib.request.urlopen
    started = time.monotonic()
    total = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open_url(url, timeout=timeout) as resp:
            raw_len = resp.headers.get("Content-Length")
            expected = int(raw_len) if raw_len else 0
            with part.open("wb") as fh:
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    fh.write(chunk)
                    total += len(chunk)
                    elapsed = max(time.monotonic() - started, 1e-6)
                    if expected:
                        pct = min(total * 100.0 / expected, 100.0)
                        filled = int(pct / 4)
                        bar = "█" * filled + "░" * (25 - filled)
                        report.progress(f"  下载中 {bar} {pct:5.1f}%  "
                                        f"{human(total)}/{human(expected)}  "
                                        f"{human(total / elapsed)}/s")
                    else:
                        report.progress(f"  下载中 {human(total)}  "
                                        f"{human(total / elapsed)}/s")
    except BaseException:
        part.unlink(missing_ok=True)     # 失败不留半个文件
        raise
    if expected and total != expected:
        part.unlink(missing_ok=True)
        raise OSError(f"大小不符：收到 {total} 字节，服务端声明 {expected} 字节")
    os.replace(part, dest)
    return total, time.monotonic() - started


def fetch(dest: Path, sources: list[Source], *, report: Reporter,
          timeout: float = 30.0, opener=None) -> Path:
    """按顺序取件：离线包 → 国内镜像 → 官方源。全失败抛 `FetchError`。

    返回实际可用的路径：离线包返回它自己的路径，下载成功返回 `dest`。
    """
    problems: list[str] = []
    for index, src in enumerate(sources):
        last = index == len(sources) - 1
        if src.path is not None:
            if src.path.exists():
                report.line(f"  ✓ 用随包离线数据：{src.path.name}"
                            f"（{human(src.path.stat().st_size)}）")
                return src.path
            problems.append(f"{src.name}：随包文件不存在（{src.path}）")
            report.line(f"  · {src.name}不可用：{src.path} 不存在")
            continue
        report.line(f"  → 尝试{src.name}：{src.url}")
        try:
            size, secs = _download(src.url, dest, report=report, timeout=timeout,
                                   opener=opener)
        except Exception as exc:                       # noqa: BLE001
            report.done()
            why = f"{type(exc).__name__}: {exc}"
            problems.append(f"{src.name}：{why}")
            report.line(f"  ✗ {src.name}失败（{why}）"
                        + ("。" if last else "，换下一个来源…"))
            continue
        report.done()
        report.line(f"  ✓ {src.name}下载完成：{human(size)}，用时 {secs:.1f}s")
        return dest
    raise FetchError("取件失败（所有来源都试过了）：\n  " + "\n  ".join(problems))
