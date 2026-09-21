# -*- coding: utf-8 -*-
"""启动脚本（.bat）的静态检查。

守的是这个坑：`.bat` 由 cmd 按控制台的 **ANSI 码页**解析，注释里出现中文等多字节字符时，
解析会把后面那行的开头吃掉——实测报出 `'python.exe" set "PY' 不是内部或外部命令`，
`%PY%` 因此为空、以 **9009**（命令找不到）退出，界面根本起不来。
同类事故在"提示文案写中文"时最容易复发，所以这里直接把约束钉成测试：**纯 ASCII**。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))


class BatchScriptTest(unittest.TestCase):
    """本目录下所有 .bat 都必须是纯 ASCII。"""

    def test_all_batch_files_are_pure_ascii(self):
        bats = sorted(HERE.glob("*.bat"))
        self.assertTrue(bats, "至少要有一个启动脚本")
        for path in bats:
            raw = path.read_bytes()
            bad = [i for i, b in enumerate(raw) if b > 127]
            if bad:      # 断言消息会提前求值，所以这里不能用 assertEqual 配 bad[0]
                self.fail(
                    f"{path.name} 含 {len(bad)} 个非 ASCII 字节（首个在偏移 {bad[0]}）："
                    "cmd 按 ANSI 解析时会把下一行吃掉，必须改成英文注释")

    def test_run_bat_keeps_the_two_fixes(self):
        """修过的两处不能再丢：取真实退出码、优先官方 py 启动器。"""
        text = (HERE / "run.bat").read_text(encoding="ascii")
        self.assertIn('set "CODE=%ERRORLEVEL%"', text)
        self.assertIn("py -3", text)


if __name__ == "__main__":
    unittest.main()
