# -*- coding: utf-8 -*-
"""把测试产生的临时目录收进一个进程级目录，进程退出时整体删掉。

为什么需要：各测试用 `tempfile.mkdtemp()` 造脚手架，很多（`make_cache`/`make_home`
之类）没有对应清理，跑一次全套就在 `%TEMP%` 里留上千个目录——实测一天能积到 1496 个。
这里在最早导入时把 `tempfile.tempdir` 指到一个专属目录，进程结束时整体删除；
即使某个用例中途失败、或 rmtree 撞上占用，最坏也只是剩一个目录，而不是几千个。

用法：测试模块顶部 `import _tempguard  # noqa: F401`（导入即有副作用，无需引用）。
"""
from __future__ import annotations

import atexit
import os
import shutil
import stat
import tempfile
from pathlib import Path

_ROOT = tempfile.mkdtemp(prefix="dsh-tests-")
tempfile.tempdir = _ROOT

# 别让测试把日志写进工具目录里的 installer.log：真机排查时会被测试噪音淹没
# （实测真机日志里混着 "[配置] 保存失败：disk full"、临时目录路径这些测试用例的输出，
#  看日志的人会以为真机上磁盘满了）。
try:
    import installer as _installer

    _installer.LOG_PATH = Path(_ROOT) / "installer-tests.log"
except Exception:            # noqa: BLE001  导入失败不该影响测试本身
    pass


def _wipe(path: str) -> None:
    """删掉整棵临时树。Windows 上 git 对象文件是只读的，直接删会留下半个目录，
    所以失败一次后把只读位摘掉再删第二遍。"""
    shutil.rmtree(path, ignore_errors=True)
    if not os.path.exists(path):
        return
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                os.chmod(os.path.join(root, name), stat.S_IWRITE)
            except OSError:          # 文件可能刚好被别人删了
                pass
    shutil.rmtree(path, ignore_errors=True)


atexit.register(_wipe, _ROOT)
