# -*- coding: utf-8 -*-
"""dsh-offline-installer 插件管理原语（v0.1，纯 Python 标准库）。

实现 `docs/插件管理-设计.md` v1.0 定稿 §5/§6：
- 受限方言：只识别"助手自有段"（注释标记包裹、位于文件尾的连续区域）内的
  `- insert:` 元素（子条目 id/name/disabled），其余一切内容只读。
- 台账 ledger：`$DSH_HOME/profiles/web/.dsh-plugin-ledger.json`，记录助手管理的行。
- 双门校验：结构门 = 克隆 home 后跑 `dsh --profile web --dump-config`（通过才 rename）；
  激活门 = 重启 + 健康检查（GUI 层调用，见 health_ok）。
- 外部行（现网 install.ps1/手动写入的 `@dsh-user/*`）一律只读，由 dump 有效组合展示。

约定：所有函数幂等、可跑在后台线程；全部路径显式传 home（默认 $env:DSH_HOME，
未设置即报错）；本模块不 import tkinter/subprocess 输出一律走调用方日志。

用法（模块级主要函数）：
  discover_sources(project, assets)          -> list[PluginSource]
  validate_package(pkg_dir)                  -> Validation
  install(home, source, project=None)        # 同步共享锚 + 台账行 + 自有段写盘
  set_enabled(home, slug, enabled, ...)      # 改台账 disabled + 写盘
  uninstall(home, slug, ...)                 # 台账删行 + 引用扫描 + 删共享目录
  status_view(home, sources, dump)           -> list[PluginCard]
  structure_gate(home, patch_text, run_dump) -> DumpResult（失败抛 GateError）
  parse_dump(text)                           -> DumpResult（dump 输出解析）
  bundle_candidates(project)                 -> list[BundleCandidate]（dsh.bundle 插件）
  bundle_installed(home)                     -> list[(name, builtin)]
  bundle_pack(dir, tgz, ...)                 # 把已构建 bundle 打成 npm 风格 tgz
  bundle_install(home, source, ...)          # dsh plugin add 真实写入 + 备份回滚
  bundle_remove(home, name, ...)
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

# ---------------------------------------------------------------- 常量

MANAGED_START = "# --- dsh-offline-installer managed: start ---"
MANAGED_END = "# --- dsh-offline-installer managed: end ---"
LEDGER_FILE = ".dsh-plugin-ledger.json"
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
NAME_RE = re.compile(r"^@dsh-user/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$")
NAME_LINE_RE = re.compile(
    r'^\s*name:\s*["\'](@dsh-user/[a-z0-9][a-z0-9-]*[a-z0-9]|@dsh-user/[a-z0-9])["\']\s*(?:#.*)?$'
)
DUMP_WARN_WORDS = ("warn", "did not activate", "not match", "not found", "failed")

# dump 输出的健康信号（激活门/冷启动审计文本）
LOADER_FAIL_MARKERS = ("did not activate", "FAILED", "fatal load failure")


# ---------------------------------------------------------------- 异常

class PluginError(RuntimeError):
    """插件管理的一般性错误（用户可读消息）。"""


class ProtectedShapeError(PluginError):
    """受限方言遇到不可表示/不可编辑形态：fail-loud，字节原样保留。"""


class GateError(PluginError):
    """结构门校验失败（未落盘）。"""


# ---------------------------------------------------------------- 数据类

@dataclass(frozen=True)
class ManagedRow:
    id: str          # == slug == 插件目录名
    disabled: bool = False

    @property
    def name(self) -> str:
        return f"@dsh-user/{self.id}"


@dataclass(frozen=True)
class Ledger:
    version: int = 1
    rows: tuple[ManagedRow, ...] = ()

    def row(self, slug: str) -> Optional[ManagedRow]:
        for r in self.rows:
            if r.id == slug:
                return r
        return None

    def upsert(self, row: ManagedRow) -> "Ledger":
        rest = [r for r in self.rows if r.id != row.id]
        return Ledger(version=self.version, rows=tuple(rest + [row]))

    def remove(self, slug: str) -> "Ledger":
        return Ledger(version=self.version, rows=tuple(r for r in self.rows if r.id != slug))


@dataclass(frozen=True)
class Validation:
    ok: bool
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class PluginSource:
    slug: str
    path: Path
    origin: str                      # project | asset | archive
    description: str
    has_client: bool
    validation: Validation


@dataclass(frozen=True)
class DumpEntry:
    id: str
    name: str
    disabled: bool
    layer: str                       # bundle | profile | home | overlay（dump 分节头）


@dataclass(frozen=True)
class DumpResult:
    ok: bool
    exit_code: int
    entries: tuple[DumpEntry, ...] = ()
    warnings: tuple[str, ...] = ()
    text: str = ""

    def find(self, name: str) -> Optional[DumpEntry]:
        for e in self.entries:
            if e.name == name:
                return e
        return None


@dataclass(frozen=True)
class PluginCard:
    """GUI 一行：由 台账(意图) + dump(有效) 合成。"""
    slug: str
    name: str
    state: str                       # enabled | disabled | downloaded | external | first_party
    description: str
    origin: str
    installed_dir: Optional[Path]    # 共享锚目录（存在时）
    source: Optional[Path]           # 发现的来源目录（存在时）
    first_party: bool = False
    validation_errors: tuple[str, ...] = ()


# ---------------------------------------------------------------- 路径

def default_home() -> Path:
    raw = os.environ.get("DSH_HOME")
    if not raw:
        raise PluginError("DSH_HOME 未设置；插件管理需要显式的 DSH_HOME。")
    return Path(raw)


def web_patch(home: Path) -> Path:
    return home / "profiles" / "web" / "cordis.patch.yml"


def ledger_path(home: Path) -> Path:
    return home / "profiles" / "web" / LEDGER_FILE


def anchor_root(home: Path) -> Path:
    return home / "profiles" / "node_modules" / "@dsh-user"


def anchor_dir(home: Path, slug: str) -> Path:
    return anchor_root(home) / slug


def is_valid_slug(slug: str) -> bool:
    return bool(SLUG_RE.match(slug))


# ---------------------------------------------------------------- 台账

def ledger_load(home: Path) -> Ledger:
    path = ledger_path(home)
    if not path.exists():
        return Ledger()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PluginError(f"台账损坏，无法解析：{path}（{exc}）") from exc
    rows = []
    for item in data.get("plugins", []):
        row_id = item.get("id")
        name = item.get("name")
        if not is_valid_slug(str(row_id)) or name != f"@dsh-user/{row_id}":
            raise PluginError(f"台账含非法行：{item!r}")
        rows.append(ManagedRow(id=row_id, disabled=bool(item.get("disabled", False))))
    return Ledger(version=int(data.get("version", 1)), rows=tuple(rows))


def ledger_save(home: Path, ledger: Ledger) -> None:
    path = ledger_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "version": ledger.version,
        "plugins": [
            {"id": r.id, "name": r.name, "disabled": r.disabled}
            for r in ledger.rows
        ],
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------- 受限方言：自有段

def _raw_lines(text: str) -> list[str]:
    return text.splitlines(keepends=True)


def find_managed_span(text: str) -> Optional[tuple[int, int]]:
    """返回 (start_line, end_line) 行号区间；行号按 keepends 行列表。

    start/end 标记必须是整行注释（仅允许行尾空白）。end 之后只允许空行。
    违反即 ProtectedShapeError。
    """
    lines = _raw_lines(text)
    starts = [i for i, ln in enumerate(lines) if ln.rstrip("\r\n").strip() == MANAGED_START]
    ends = [i for i, ln in enumerate(lines) if ln.rstrip("\r\n").strip() == MANAGED_END]
    if not starts and not ends:
        return None
    if len(starts) != 1 or len(ends) != 1:
        raise ProtectedShapeError("管理段标记必须且只能各出现一次（start/end）。")
    s, e = starts[0], ends[0]
    if s >= e:
        raise ProtectedShapeError("管理段标记顺序错误（start 在 end 之后）。")
    for ln in lines[e + 1:]:
        if ln.strip():
            raise ProtectedShapeError(
                "管理段之后存在非助手内容（分段须位于文件尾）；为保护内容本次拒改。")
    return s, e


def _parse_segment_lines(lines: Sequence[str], slug_of: Callable[[str], Optional[str]]) -> list[ManagedRow]:
    """把管理段内（不含标记行）逐行按受限方言解析为台账行。

    slug_of: 由 id 值得到 slug 的映射；仅当 id 与 name 自洽时接受。
    任何超出模板的形态（config、flow、未知键、顺序错乱）→ ProtectedShapeError。
    返回行顺序 = 文件内顺序。
    """
    rows: list[ManagedRow] = []
    i = 0
    n = len(lines)
    while i < n:
        ln = lines[i].rstrip("\r\n")
        if not ln.strip():
            i += 1
            continue
        if ln != "- insert:":
            raise ProtectedShapeError(f"管理段含不可识别的顶层内容：{ln!r}")
        i += 1
        if i >= n:
            raise ProtectedShapeError("管理段中 '- insert:' 后缺少子条目。")
        id_line = lines[i].rstrip("\r\n")
        m = re.match(r"^    - id: ([A-Za-z0-9-]+)$", id_line)
        if not m:
            raise ProtectedShapeError(f"管理段 insert 子条目须为 '    - id: <slug>'：{id_line!r}")
        slug = m.group(1)
        i += 1
        if i >= n:
            raise ProtectedShapeError(f"插件 {slug} 缺少 name 行。")
        name_line = lines[i].rstrip("\r\n")
        nm = re.match(r"^      name: '@dsh-user/([A-Za-z0-9-]+)'$", name_line)
        if not nm or nm.group(1) != slug:
            raise ProtectedShapeError(f"插件 {slug} 的 name 行与 id 不自洽：{name_line!r}")
        i += 1
        disabled = False
        if i < n and lines[i].rstrip("\r\n") == "      disabled: true":
            disabled = True
            i += 1
        if i < n and lines[i].rstrip("\r\n").startswith(("    ", "  ")) \
                and lines[i].strip() not in ("- insert:", ""):
            raise ProtectedShapeError(
                f"管理段内插件 {slug} 含非受控字段（如 config/手工修改）；为不覆盖用户内容本次拒改。")
        rows.append(ManagedRow(id=slug, disabled=disabled))
    return rows


def render_segment(rows: Iterable[ManagedRow]) -> str:
    lines = [MANAGED_START]
    for r in rows:
        lines.append("- insert:")
        lines.append(f"    - id: {r.id}")
        lines.append(f"      name: '@dsh-user/{r.id}'")
        if r.disabled:
            lines.append("      disabled: true")
    lines.append(MANAGED_END)
    return "\n".join(lines) + "\n"


def apply_managed(text: str, rows: Sequence[ManagedRow],
                  expect: Optional[Sequence[ManagedRow]] = None) -> str:
    """返回写盘文本：替换/追加管理段。

    expect = 当前补丁应反映的台账行（写盘前旧状态）。文件段内行与 expect 不一致
    （用户手改增删）→ ProtectedShapeError，绝不覆盖（D7）。结构错误/未知字段
    （config、flow、错键）同样 fail-loud。
    """
    seen = set()
    for r in rows:
        if r.id in seen:
            raise ProtectedShapeError(f"管理段行模板要求 id 唯一：{r.id} 重复。")
        if not is_valid_slug(r.id):
            raise ProtectedShapeError(f"非法插件目录名/slug：{r.id!r}")
        seen.add(r.id)

    lines = _raw_lines(text)
    span = find_managed_span(text)
    block = render_segment(rows)
    if span is not None:
        s, e = span
        existing = _parse_segment_lines(lines[s + 1:e], None)
        expect_list = list(expect) if expect is not None else None
        if expect_list is not None and existing != expect_list:
            raise ProtectedShapeError(
                "管理段内容与台账不一致（疑似手工增删/改动段内行）。"
                "为避免覆盖用户改动本次拒改；确认无误请手动删除管理段后重试。")
        if expect_list is None and existing and existing != list(rows) \
                and {r.id for r in existing} != {r.id for r in rows}:
            raise ProtectedShapeError(
                "管理段内容与目标台账不一致，为避免误覆盖本次拒改。")
        return "".join(lines[:s]) + block + "".join(lines[e + 1:])
    if expect and list(expect):
        raise ProtectedShapeError("台账有受管行但补丁里没有管理段（不一致）。")
    if not rows:
        return text
    if lines and not lines[-1].endswith(("\n", "\r")):
        lines.append("\n")
    return "".join(lines) + block


# ---------------------------------------------------------------- 发现与校验

def _pkg_json(dir_: Path) -> Optional[dict]:
    pj = dir_ / "package.json"
    if not pj.exists():
        return None
    try:
        return json.loads(pj.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _client_js(pkg: dict, dir_: Path) -> bool:
    """声明 dsh.client 时要求 lib/client.js（或 exports['./client'] 指向的文件）存在。"""
    if not pkg.get("dsh", {}).get("client"):
        return True
    exports = pkg.get("exports", {})
    target = None
    if isinstance(exports, dict) and isinstance(exports.get("./client"), str):
        target = exports["./client"]
    if target is None:
        target = "./lib/client.js"
    file = (dir_ / target.lstrip("./")).resolve()
    return file.is_file()


def validate_package(pkg_dir: Path) -> Validation:
    errs: list[str] = []
    pkg = _pkg_json(pkg_dir)
    if pkg is None:
        return Validation(ok=False, errors=("缺 package.json",))
    name = str(pkg.get("name", ""))
    slug = pkg_dir.name
    if name != f"@dsh-user/{slug}":
        errs.append(f"name 必须恰为 @dsh-user/{slug}（当前：{name!r}）")
    main = str(pkg.get("main", "./lib/index.js"))
    if not (pkg_dir / main.lstrip("./")).is_file():
        errs.append(f"入口 {main} 缺失（未构建 lib/？）")
    if pkg.get("dsh", {}).get("client") and not _client_js(pkg, pkg_dir):
        errs.append("声明 dsh.client 但缺 lib/client.js（冷启动会失败，拒绝安装）")
    if pkg.get("dsh", {}).get("client") and "./client" not in pkg.get("exports", {}):
        errs.append("声明 dsh.client 时 exports 需含 './client' 导出")
    return Validation(ok=not errs, errors=tuple(errs))


def _scan_base(base: Path, origin: str) -> list[PluginSource]:
    out: list[PluginSource] = []
    if not base.is_dir():
        return out
    for dir_ in sorted(base.iterdir()):
        if not dir_.is_dir() or not is_valid_slug(dir_.name):
            continue
        pkg = _pkg_json(dir_)
        if pkg is None:
            continue                       # 非插件目录（如 time-context 示例）
        if pkg.get("name") != f"@dsh-user/{dir_.name}":
            continue
        v = validate_package(dir_)
        out.append(PluginSource(
            slug=dir_.name,
            path=dir_,
            origin=origin,
            description=str(pkg.get("description", "")),
            has_client=bool(pkg.get("dsh", {}).get("client")),
            validation=v,
        ))
    return out


def discover_sources(project_root: Optional[Path], assets_dir: Optional[Path] = None) -> list[PluginSource]:
    out: list[PluginSource] = []
    if project_root is not None:
        out += _scan_base(project_root / "plugins", "project")
    if assets_dir is not None:
        out += _scan_base(assets_dir / "plugins", "asset")
    return out


# ---------------------------------------------------------------- dump 解析

def _layer_of(header: str) -> str:
    h = header.lower()
    if "cordis.patch.yml" in h or "patch.yml" in h:
        return "profile"
    if "bundle" in h or "base" in h:
        return "bundle"
    return "overlay"


def parse_dump(text: str) -> DumpResult:
    """解析 dump 输出（分节扁平条目）。

    条目边界 = 顶层 `- id: ...`；条目内读取 `name:` 与 `disabled:`，更深缩进的
    config 块跳过。`# == <层路径>` 头决定 layer。warnings 收集含错误词的原文行。
    """
    entries: list[DumpEntry] = []
    warnings: list[str] = []
    layer = "bundle"
    cur: Optional[dict] = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        low = raw.lower()
        if any(w in low for w in DUMP_WARN_WORDS):
            warnings.append(raw)
        if raw.startswith("#"):
            header = raw.lstrip("#").strip()
            if header.startswith("=="):
                layer = _layer_of(raw)
            continue
        if raw.startswith("- id: "):
            if cur is not None and cur["name"]:
                entries.append(DumpEntry(id=cur["id"], name=cur["name"],
                                         disabled=cur["disabled"],
                                         layer=cur["layer"]))
            cur = {"id": raw[6:].strip(), "name": None, "disabled": False,
                   "layer": layer}
            continue
        if cur is not None:
            if raw.startswith("  name: "):
                cur["name"] = raw[8:].strip().strip("'\"")
            elif raw.startswith("  disabled:"):
                cur["disabled"] = "true" in raw[11:].strip().lower()
            # 其余行（config 及其深层、注释）不参与，直到下一条 '- id:' 或 EOF
    if cur is not None and cur["name"]:
        entries.append(DumpEntry(id=cur["id"], name=cur["name"],
                                 disabled=cur["disabled"], layer=cur["layer"]))
    return DumpResult(ok=True, exit_code=0, entries=tuple(entries),
                      warnings=tuple(warnings), text=text)


# ---------------------------------------------------------------- 结构门（克隆 home + 真实/注入 dump）

def clone_profile_files(home: Path, dst_profiles: Path) -> Path:
    """把 $DSH_HOME/profiles 的普通文件拷到 dst_profiles；跳过 junction/目录链接
    与 node_modules（dump 不 import 模块，见 .probe 冒烟）。返回 dst_profiles。"""
    src = home / "profiles"
    if not src.is_dir():
        raise PluginError(f"缺少 profiles 目录：{src}")
    if dst_profiles.exists():
        shutil.rmtree(dst_profiles, ignore_errors=True)
    dst_profiles.mkdir(parents=True, exist_ok=True)
    copied = 0
    for root, dirs, files in os.walk(src, followlinks=False):
        rel = Path(root).relative_to(src)
        target_dir = dst_profiles / rel
        # 就地裁剪：junction/symlink 目录与任何 node_modules 均不进入
        keep = []
        for d in dirs:
            full = Path(root) / d
            if d == "node_modules":
                continue
            if full.is_symlink():
                continue
            keep.append(d)
        dirs[:] = keep
        target_dir.mkdir(parents=True, exist_ok=True)
        for f in files:
            full = Path(root) / f
            if full.is_symlink():
                continue
            shutil.copy2(full, target_dir / f)
            copied += 1
    return dst_profiles


def resolve_dsh_command(project: Optional[Path] = None) -> list[str]:
    """定位 dump 用 CLI。开发仓库走 node + apps/cli/lib/bin.js；否则找 PATH 上的 dsh。"""
    env_cli = os.environ.get("DSH_CLI")
    if env_cli:
        return [env_cli]
    if project is not None:
        bin_js = project / "apps" / "cli" / "lib" / "bin.js"
        if bin_js.is_file():
            node = shutil.which("node")
            if node:
                return [node, str(bin_js)]
    dsh = shutil.which("dsh")
    if dsh:
        return [dsh]
    raise PluginError("找不到 dsh CLI（结构门需要它）；请显式传 dsh_command/run_dump。")


def structure_gate(home: Path, patch_text: str,
                   run_dump: Optional[Callable[[Path], DumpResult]] = None,
                   *, project: Optional[Path] = None,
                   dsh_command: Optional[Sequence[str]] = None,
                   keep_clone: Optional[Path] = None) -> DumpResult:
    """结构门：把新补丁写入临时克隆 home 的 profiles/web/cordis.patch.yml 并跑 dump。

    通过 → DumpResult.ok（调用方随后 rename 落盘）；失败抛 GateError（不落盘）。
    run_dump 缺省时用真实 CLI（resolve_dsh_command）；测试可注入假 runner，
    其入参 = 克隆里补丁文件路径。
    """
    base = tempfile.mkdtemp(prefix="dsh-gate-", dir=str(home.parent if home.parent.exists() else None))
    tmp_home = Path(base)
    try:
        profiles = clone_profile_files(home, tmp_home / "profiles")
        patch = profiles / "web" / "cordis.patch.yml"
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text(patch_text, encoding="utf-8")
        if run_dump is not None:
            result = run_dump(patch)
        else:
            cmd = list(dsh_command) if dsh_command else resolve_dsh_command(project)
            result = _real_dump(cmd, tmp_home, patch_text)
        if not result.ok or result.exit_code != 0:
            raise GateError(
                f"结构门未通过（exit={result.exit_code}）：\n" +
                "\n".join(result.warnings[:10]))
        return result
    finally:
        if keep_clone is not None:
            if tmp_home.exists():
                shutil.copytree(tmp_home, keep_clone, dirs_exist_ok=True)
        shutil.rmtree(tmp_home, ignore_errors=True)


def _real_dump(cmd: Sequence[str], tmp_home: Path, _patch_text: str) -> DumpResult:
    env = dict(os.environ)
    env["DSH_HOME"] = str(tmp_home)
    argv = list(cmd) + ["--profile", "web", "--dump-config"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              env=env, timeout=180)
    except subprocess.TimeoutExpired as exc:
        return DumpResult(ok=False, exit_code=-1,
                          warnings=(f"dump 超时（180s）：{exc}",))
    text = (proc.stdout or "") + "\n[stderr]\n" + (proc.stderr or "")
    result = parse_dump(proc.stdout or "")
    return DumpResult(ok=proc.returncode == 0, exit_code=proc.returncode,
                      entries=result.entries, warnings=result.warnings, text=text)


# ---------------------------------------------------------------- 写盘原语

def _backup_of(patch: Path) -> Path:
    return patch.with_name(patch.name + ".bak")


def backup_patch(patch: Path) -> Optional[Path]:
    if not patch.exists():
        return None
    bak = _backup_of(patch)
    shutil.copy2(patch, bak)
    return bak


def commit_patch(home: Path, patch_text: str) -> Path:
    """原子落盘补丁（调用前必须已过结构门）。返回补丁路径。"""
    patch = web_patch(home)
    patch.parent.mkdir(parents=True, exist_ok=True)
    backup_patch(patch)
    tmp = patch.with_name(patch.name + ".tmp")
    tmp.write_text(patch_text, encoding="utf-8")
    os.replace(tmp, patch)
    return patch


def rollback_patch(home: Path) -> bool:
    """从 .bak 回滚（rename 回 = 一次热应用）。成功返回 True。"""
    patch = web_patch(home)
    bak = _backup_of(patch)
    if not bak.exists():
        return False
    os.replace(bak, patch)
    return True


def _save_ledger_and_patch(home: Path, ledger: Ledger,
                           patch_text: str) -> Path:
    ledger_save(home, ledger)
    return commit_patch(home, patch_text)


# ---------------------------------------------------------------- 操作原语（幂等）

def _read_patch(home: Path) -> str:
    patch = web_patch(home)
    if not patch.exists():
        return ""
    return patch.read_text(encoding="utf-8")


def install(home: Path, source: PluginSource, *, project: Optional[Path] = None,
            run_dump: Optional[Callable[[Path], DumpResult]] = None,
            dsh_command: Optional[Sequence[str]] = None) -> Ledger:
    """安装：① 同步包到共享锚（幂等整目录覆盖）② 台账加行 → 自有段写盘 → 结构门。"""
    if not source.validation.ok:
        raise PluginError(f"插件 {source.slug} 未通过安装前置校验：\n" +
                          "\n".join(source.validation.errors))
    ledger = ledger_load(home)
    if ledger.row(source.slug) is not None:
        raise PluginError(f"{source.slug} 已在台账（已安装）。")
    _sync_anchor(home, source.slug, source.path)
    new_ledger = ledger.upsert(ManagedRow(id=source.slug))
    text = apply_managed(_read_patch(home), new_ledger.rows, expect=ledger.rows)
    structure_gate(home, text, run_dump=run_dump, project=project,
                   dsh_command=dsh_command)
    _save_ledger_and_patch(home, new_ledger, text)
    return new_ledger


def set_enabled(home: Path, slug: str, enabled: bool, *, project: Optional[Path] = None,
                run_dump: Optional[Callable[[Path], DumpResult]] = None,
                dsh_command: Optional[Sequence[str]] = None) -> Ledger:
    """启用/停用：改台账 disabled → 自有段重写 → 结构门 → 落盘。"""
    if not is_valid_slug(slug):
        raise PluginError(f"非法 slug：{slug!r}")
    ledger = ledger_load(home)
    row = ledger.row(slug)
    if row is None:
        raise PluginError(f"{slug} 不在台账（未安装或外部行只读）。")
    if row.disabled == (not enabled):
        return ledger                       # 已是目标状态，幂等
    new_ledger = ledger.upsert(ManagedRow(id=slug, disabled=not enabled))
    text = apply_managed(_read_patch(home), new_ledger.rows, expect=ledger.rows)
    structure_gate(home, text, run_dump=run_dump, project=project,
                   dsh_command=dsh_command)
    _save_ledger_and_patch(home, new_ledger, text)
    return new_ledger


def _strip_managed(text: str) -> str:
    """去掉文本中的管理段（含标记），用于"自有段不自我引用"的引用扫描。"""
    try:
        span = find_managed_span(text)
    except ProtectedShapeError:
        return text
    if span is None:
        return text
    lines = _raw_lines(text)
    s, e = span
    return "".join(lines[:s] + lines[e + 1:])


def reference_scan(home: Path, slug: str, extra_files: Sequence[Path] = ()) -> list[Path]:
    """尽力引用扫描：找其它补丁/文件里对 '@dsh-user/<slug>' 的文本引用。

    保守语义：注释/字符串里的命中也算引用（无法证明非引用即保留）。
    助手自有文件（web 补丁及其 .bak）先剔除自身管理段再扫描——删除台账行后
    段内引用不算数，但同一文件管理段外的外部行引用仍会被抓到。
    返回命中文件列表。
    """
    needle = f"@dsh-user/{slug}"
    own = {web_patch(home).resolve(),
           web_patch(home).with_name(web_patch(home).name + ".bak").resolve()}
    hits: list[Path] = []
    files = list(_all_patch_files(home)) + list(extra_files)
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if f.resolve() in own:
            text = _strip_managed(text)
        if needle in text:
            hits.append(f)
    return hits


def _all_patch_files(home: Path) -> list[Path]:
    out: list[Path] = []
    prof = home / "profiles"
    if prof.is_dir():
        for p in sorted(prof.glob("*/cordis.patch.yml")):
            out.append(p)
        for p in sorted(prof.glob("*/cordis.patch.yml.bak")):
            out.append(p)
    home_patch = home / "cordis.patch.yml"
    if home_patch.exists():
        out.append(home_patch)
    return out


def uninstall(home: Path, slug: str, *, keep_files: bool = False,
              project: Optional[Path] = None,
              run_dump: Optional[Callable[[Path], DumpResult]] = None,
              dsh_command: Optional[Sequence[str]] = None,
              stop_web: Optional[Callable[[], None]] = None) -> Ledger:
    """卸载：台账删行 → 自有段写盘（结构门）→（停 web）→ 引用扫描零引用才删目录。

    卸载顺序（设计 §5.2/§6）：先改补丁 → stop_web 回调 → 再删共享目录。
    """
    if not is_valid_slug(slug):
        raise PluginError(f"非法 slug：{slug!r}")
    ledger = ledger_load(home)
    if ledger.row(slug) is None:
        raise PluginError(f"{slug} 不在台账（外部行不可卸载，v0.2 支持接管）。")
    new_ledger = ledger.remove(slug)
    text = apply_managed(_read_patch(home), new_ledger.rows, expect=ledger.rows)
    structure_gate(home, text, run_dump=run_dump, project=project,
                   dsh_command=dsh_command)
    _save_ledger_and_patch(home, new_ledger, text)
    if stop_web is not None:
        stop_web()
    if not keep_files:
        target = anchor_dir(home, slug)
        if target.exists():
            remaining = reference_scan(home, slug)
            if remaining:
                raise PluginError(
                    f"{slug} 仍被引用（{len(remaining)} 处），共享目录已保留：\n" +
                    "\n".join(str(f) for f in remaining[:5]))
            shutil.rmtree(target, ignore_errors=True)
    return new_ledger


def _sync_anchor(home: Path, slug: str, src: Path) -> None:
    if not src.is_dir():
        raise PluginError(f"来源目录不存在：{src}")
    dst = anchor_dir(home, slug)
    dst.parent.mkdir(parents=True, exist_ok=True)
    staging = dst.parent / f".staging-{slug}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(src, staging, ignore=shutil.ignore_patterns(
        "__pycache__", "*.pyc", ".git", "tmp"))
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    os.replace(staging, dst)


# ---------------------------------------------------------------- 外部行接管（v0.2）

def _leading_comment(lines: list[str], at: int) -> bool:
    """元素上方（跳过空行）是否紧贴注释行——有则视为他人注释归属，拒接管。"""
    p = at - 1
    while p >= 0 and not lines[p].strip():
        p -= 1
    return p >= 0 and lines[p].lstrip().startswith("#")


def find_standalone_element(text: str, slug: str) -> tuple[int, int, ManagedRow]:
    """找"干净可接管"的外部顶层元素（唯一、单子条目、无 config/注释、上方无注释）。

    返回 (start_line, end_line, row)（含行）。不满足 → ProtectedShapeError 给出原因。
    """
    lines = _raw_lines(text)
    matches: list[tuple[int, int, ManagedRow]] = []
    i = 0
    n = len(lines)
    while i < n:
        if lines[i].rstrip("\r\n") != "- insert:":
            i += 1
            continue
        start = i
        # 元素结束 = 下一行同为顶层（缩进 0 的非空行）或 EOF
        end = n - 1
        k = i + 1
        while k < n:
            ln = lines[k]
            if ln.strip() and not ln[0].isspace() and ln[0] != "#":
                end = k - 1
                break
            k += 1
        if _leading_comment(lines, start):
            i = k
            continue                      # 上方有注释：归属不明，不接管
        try:
            rows = _parse_standalone_block(lines[start + 1:end + 1])
        except ProtectedShapeError:
            i = k
            continue
        if rows:
            row = rows[0]
            if row.id == slug:
                matches.append((start, end, row))
        i = k
    if not matches:
        raise ProtectedShapeError(
            f"{slug} 没有可接管的独立外部行：需是单个顶层 `- insert:` 元素、"
            f"无 config/注释/多条目，且上方无注释。")
    if len(matches) > 1:
        raise ProtectedShapeError(f"{slug} 在补丁里出现多个候选外部行，接管有歧义。")
    return matches[0]


def _parse_standalone_block(lines: Sequence[str]) -> list[ManagedRow]:
    """解析独立 insert 元素内部：仅接受模板化子条目（id/name[/disabled]）。"""
    rows: list[ManagedRow] = []
    i = 0
    n = len(lines)
    while i < n:
        ln = lines[i].rstrip("\r\n")
        if not ln.strip():
            i += 1
            continue
        if ln.startswith("#"):
            raise ProtectedShapeError("元素内含注释，不接管")
        m = re.match(r"^    - id: ([A-Za-z0-9-]+)$", ln)
        if not m:
            raise ProtectedShapeError(f"元素含未知内容：{ln!r}")
        slug = m.group(1)
        i += 1
        if i >= n:
            raise ProtectedShapeError("缺 name 行")
        nm = re.match(r"^      name: '@dsh-user/([A-Za-z0-9-]+)'$",
                      lines[i].rstrip("\r\n"))
        if not nm or nm.group(1) != slug:
            raise ProtectedShapeError("id/name 不自洽")
        i += 1
        disabled = False
        if i < n and lines[i].rstrip("\r\n") == "      disabled: true":
            disabled = True
            i += 1
        if i < n and lines[i].rstrip("\r\n").startswith(("      ", "    ")) \
                and lines[i].strip() and not lines[i].lstrip().startswith("- "):
            raise ProtectedShapeError(f"{slug} 含 config/未知字段")
        if i < n and lines[i].lstrip().startswith("- ") \
                and not lines[i].startswith("    - id:"):
            raise ProtectedShapeError("多条目/复合元素，不接管")
        rows.append(ManagedRow(id=slug, disabled=disabled))
    return rows


def adopt(home: Path, slug: str, *, project: Optional[Path] = None,
          run_dump: Optional[Callable[[Path], DumpResult]] = None,
          dsh_command: Optional[Sequence[str]] = None) -> Ledger:
    """接管外部行：删除其独立顶层元素 → 并入台账/自有段 → 结构门 → 落盘。

    前置：该行不在台账、元素"干净可接管"（find_standalone_element）。包目录
    （共享锚）默认已存在（外部安装时同步过）；缺失会随下次重启暴露于激活门。
    """
    if not is_valid_slug(slug):
        raise PluginError(f"非法 slug：{slug!r}")
    ledger = ledger_load(home)
    if ledger.row(slug) is not None:
        raise PluginError(f"{slug} 已在台账（无需接管）。")
    text = _read_patch(home)
    start, end, row = find_standalone_element(text, slug)
    lines = _raw_lines(text)
    without = "".join(lines[:start] + lines[end + 1:])
    new_ledger = ledger.upsert(ManagedRow(id=slug, disabled=row.disabled))
    out = apply_managed(without, new_ledger.rows, expect=ledger.rows)
    structure_gate(home, out, run_dump=run_dump, project=project,
                   dsh_command=dsh_command)
    _save_ledger_and_patch(home, new_ledger, out)
    return new_ledger


def list_archive_plugins(archive: Path) -> list[tuple[str, Validation]]:
    """列出离线包（assets/plugins.tar.gz）里按规范打包的插件。

    仅作打包/分发自检辅助：逐成员读取 package.json，校验 name 恰为
    `@dsh-user/<目录名>`；文件存在性交由打包自检脚本保证（v0.2 pack_plugins.py）。
    """
    out: list[tuple[str, Validation]] = []
    try:
        with tarfile.open(archive, "r:gz") as tf:
            names = {m.name for m in tf.getmembers() if m.isfile()}
            for member in tf.getmembers():
                if not member.name.endswith("/package.json"):
                    continue
                slug = member.name.split("/")[0]
                if not is_valid_slug(slug) or f"{slug}/package.json" != member.name:
                    continue
                try:
                    fh = tf.extractfile(member)
                    pkg = json.loads(fh.read().decode("utf-8")) if fh else {}
                except (OSError, json.JSONDecodeError):
                    continue
                errs: list[str] = []
                if pkg.get("name") != f"@dsh-user/{slug}":
                    errs.append("name 与目录名不符")
                if f"{slug}/lib/index.js" not in names:
                    errs.append("缺 lib/index.js")
                if pkg.get("dsh", {}).get("client") and \
                        f"{slug}/lib/client.js" not in names:
                    errs.append("声明 dsh.client 但缺 lib/client.js")
                out.append((slug, Validation(ok=not errs, errors=tuple(errs))))
    except (OSError, tarfile.TarError) as exc:
        raise PluginError(f"无法读取离线包 {archive}：{exc}") from exc
    out.sort(key=lambda t: t[0])
    return out


# ---------------------------------------------------------------- 市场/包插件（dsh plugin，v0.3）

# 内置模板 bundle：由 profile 模板提供、不是依赖，不可安装/移除。
BUNDLE_BUILTIN = ("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                  "@deepseek-ai/dsh-acp-app", "@deepseek-ai/dsh-headless",
                  "@deepseek-ai/dsh-sdk-app", "@deepseek-ai/dsh-sdk-minimal")

# 收录清单：小助手认识的常用 bundle 插件（未下载可先抓取）。
CURATED_BUNDLES = (
    {"name": "dsh-market", "npm": "dshmarket",
     "git": "https://github.com/dsh-market/dsh-market.git",
     "description": "可视化插件市场（内含 dsh plugin 一键装社区插件）"},
    {"name": "dsh-lsp-actions", "npm": "dsh-lsp-actions",
     "git": "https://github.com/PerryLink/dsh-lsp-actions.git",
     "description": "LSP 动作（打开文件、运行测试等）"},
)


@dataclass(frozen=True)
class BundleCandidate:
    path: Path
    name: str
    version: str
    built: bool            # lib/index.js 已构建
    has_client: bool


def _web_pkg_json(home: Path) -> Path:
    return home / "profiles" / "web" / "package.json"


def profile_manifest(home: Path) -> dict:
    p = _web_pkg_json(home)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PluginError(f"profile package.json 损坏：{p}") from exc


def profile_manifest_write(home: Path, data: dict) -> None:
    p = _web_pkg_json(home)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                 encoding="utf-8")


def bundle_installed(home: Path) -> list[tuple[str, bool]]:
    """web profile 已安装的 bundle 层（dsh.profile.bundles）；bool=是否内置模板。"""
    data = profile_manifest(home)
    names = data.get("dsh", {}).get("profile", {}).get("bundles", []) or []
    return [(n, n in BUNDLE_BUILTIN) for n in names]


def bundle_candidates(project: Path,
                      assets_dir: Optional[Path] = None) -> list[BundleCandidate]:
    """扫描项目 plugins/ 与 assets/plugins/ 里声明 `dsh.bundle.patch` 的目录。"""
    roots = [project / "plugins"]
    if assets_dir is not None:
        roots.append(assets_dir / "plugins")
    out: list[BundleCandidate] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir():
                continue
            pkg = _pkg_json(d)
            if pkg is None or pkg.get("dsh", {}).get("bundle", {}).get("patch") is None:
                continue
            name = pkg.get("name") or d.name
            if name in seen:
                continue
            seen.add(name)
            main = (pkg.get("main") or "lib/index.js").lstrip("./")
            out.append(BundleCandidate(
                path=d, name=name, version=pkg.get("version", ""),
                built=(d / main).exists() or (d / "lib" / "index.js").exists(),
                has_client=bool(pkg.get("dsh", {}).get("client"))))
    out.sort(key=lambda b: (not b.built, b.name))
    return out


_PACK_EXCLUDE_DIRS = {"node_modules", ".git", "dist", "__pycache__", "tmp", ".dsh"}
_PACK_MUST = {"package.json", "cordis.patch.yml", "lib", "client", "LICENSE"}


def _bundle_members(dir_: Path) -> list[str]:
    """按 package.json.files（缺省用默认集合）收集要进 tgz 的相对路径；跳过坏目录。"""
    pkg = _pkg_json(dir_) or {}
    want = set(pkg.get("files") or []) | _PACK_MUST
    members: list[str] = []
    for entry in sorted(want):
        p = dir_ / entry
        if not p.exists():
            continue
        if p.is_file():
            members.append(entry)
            continue
        for root, dirs, files in os.walk(p, followlinks=False):
            dirs[:] = [d for d in dirs if d not in _PACK_EXCLUDE_DIRS]
            rel = Path(root).relative_to(dir_)
            for f in files:
                members.append((rel / f).as_posix())
    return [m for m in dict.fromkeys(members) if m]


def bundle_pack(dir_: Path, out: Path, *, name: str, version: str) -> Path:
    """把**已构建**的 bundle 打成 npm 风格 tgz（`package/` 前缀，省 npm/pnpm）。"""
    if not (dir_ / "cordis.patch.yml").exists():
        raise PluginError(f"{name} 缺 cordis.patch.yml，不能作为 bundle 安装")
    if not (dir_ / "lib" / "index.js").exists() and not _pkg_main_present(dir_):
        raise PluginError(f"{name} 未构建（缺 lib/index.js）——先构建，或改用现成 .tgz")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    with tarfile.open(tmp, "w:gz") as tf:
        for rel in _bundle_members(dir_):
            p = dir_ / rel
            if not p.is_file():
                continue
            data = p.read_bytes()
            info = tarfile.TarInfo(f"package/{rel}")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    os.replace(tmp, out)
    return out


def _pkg_main_present(dir_: Path) -> bool:
    pkg = _pkg_json(dir_) or {}
    main = (pkg.get("main") or "lib/index.js").lstrip("./")
    return (dir_ / main).exists()


def _bundle_name(source: Path) -> str:
    if source.is_dir():
        pkg = _pkg_json(source)
        if pkg is None:
            raise PluginError(f"{source} 缺 package.json")
        return pkg.get("name") or ""
    with tarfile.open(source, "r:gz") as tf:
        for m in tf.getmembers():
            if m.name in ("package/package.json", "package.json"):
                raw = tf.extractfile(m)
                if raw is None:
                    continue
                return (json.loads(raw.read().decode("utf-8")) or {}).get("name") or ""
    raise PluginError(f"无法从 {source} 识别包名")


def _spec_url(spec: str) -> str:
    for c in CURATED_BUNDLES:
        if spec in (c["name"], c["npm"]):
            return c["git"]
    if spec.startswith("github:"):
        return "https://github.com/" + spec[7:].rstrip("/") + ".git"
    if "://" in spec:
        base = spec.rstrip("/")
        if "github.com" in base and not base.endswith(".git"):
            return base + ".git"
        return base
    return spec


def _tail(o: str, e: str) -> str:
    lines = (e or o or "").strip().splitlines()
    return "\n".join(lines[-8:])


def _build_report(o: str, e: str) -> str:
    """构建失败：合并 stdout+stderr，取末尾较完整的一段（tsc 诊断通常在 stdout）。"""
    lines = (e or "").strip().splitlines() + (o or "").strip().splitlines()
    return "\n".join([ln for ln in lines if ln.strip()][-24:])


def bundle_fetch(spec: str, dest_dir: Path, *,
                 run_git: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                 ) -> Path:
    """抓取 bundle 源到 dest_dir/<name>（git clone 浅克隆）。已在本地则复用。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = _spec_name(spec)
    target = dest_dir / name
    if (target / "package.json").exists():
        return target

    def git(args: list[str]) -> tuple[int, str, str]:
        if run_git is not None:
            return run_git(args)
        try:
            r = subprocess.run(["git"] + args, capture_output=True, text=True)
            return r.returncode, r.stdout, r.stderr
        except OSError as exc:
            raise PluginError(f"无法运行 git（抓取 {spec}）：{exc}") from exc

    url = _spec_url(spec)
    code, o, e = git(["clone", "--depth", "1", url, str(target)])
    if code != 0:
        raise PluginError(f"git clone 失败（{url}）：\n{_tail(o, e)}")
    return target


def _spec_name(spec: str) -> str:
    for c in CURATED_BUNDLES:
        if spec in (c["name"], c["npm"]):
            return c["name"]
    if spec.startswith("github:"):
        tail = spec[7:].split("/")[1] if "/" in spec[7:] else spec[7:]
        return tail.rstrip("/").lower()
    if "://" in spec:
        return spec.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git").lower()
    return spec


def _spec_pkg_name(spec: str) -> str:
    """规格对应的**npm 包名**（用于提示；真正判定用安装前后 bundle 集合差）。"""
    for c in CURATED_BUNDLES:
        if spec in (c["name"], c["npm"]):
            return c["npm"]
    if spec.startswith("github:"):
        tail = spec[7:].rstrip("/").split("/")[1] if "/" in spec[7:] else spec[7:]
        return tail.lower()
    if "://" in spec:
        return spec.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git").lower()
    return spec


def bundle_build(dir_: Path, *,
                 run_pnpm: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                 ) -> bool:
    """用 pnpm 构建 bundle 到 lib/（需目标机有 pnpm；缺 node_modules 先装依赖）。"""
    env_pnpm = shutil.which("pnpm") or "pnpm"

    def run(args: list[str]) -> tuple[int, str, str]:
        if run_pnpm is not None:
            return run_pnpm(args)
        try:
            r = subprocess.run(args, cwd=str(dir_), shell=(os.name == "nt"),
                               capture_output=True, text=True)
            return r.returncode, r.stdout, r.stderr
        except OSError as exc:
            raise PluginError(f"无法运行 pnpm：{exc}") from exc

    if not (dir_ / "node_modules").exists():
        code, o, e = run([env_pnpm, "install"])
        if code != 0:
            raise PluginError(f"插件依赖安装失败：\n{_tail(o, e)}")
    code, o, e = run([env_pnpm, "run", "build"])
    if code != 0:
        raise PluginError(
            "插件构建失败：\n" + _build_report(o, e)
            + "\n\n若为依赖/类型问题，可改用 npm 包安装：`dsh plugin add <包名>`（用预构建产物，无需本地构建）。")
    return (dir_ / "lib" / "index.js").exists()


def _backup_manifest(home: Path) -> tuple[Path, Optional[bytes]]:
    p = _web_pkg_json(home)
    return p, (p.read_bytes() if p.exists() else None)


def _restore_manifest(home: Path, backup: tuple[Path, Optional[bytes]]) -> None:
    p, data = backup
    if data is None:
        if p.exists():
            p.unlink()
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def _dsh_fail_msg(code: int, out: str, err: str, args: Sequence[str]) -> str:
    reason = ""
    comb = (err or out or "")
    if "pnpm not found" in comb or "pnpm not found on PATH" in comb:
        reason = "未检测到 pnpm（小助手构建需要它）"
    elif "allowBuilds" in comb:
        reason = "git 源构建被 pnpm 拦截（allowBuilds）"
    return (f"dsh plugin {' '.join(args)} 失败(exit {code})："
            f"{reason}\n{_tail(out, err)}")


def _run_dsh_plugin(args: Sequence[str], *, project: Path,
                    run_dsh: Optional[Callable[[list[str]], tuple[int, str, str]]],
                    dsh_command: Optional[Sequence[str]] = None,
                    env: Optional[dict] = None) -> tuple[int, str, str]:
    if run_dsh is not None:
        return run_dsh(list(args))
    cmd = (resolve_dsh_command(project) if not dsh_command else list(dsh_command)) \
        + ["plugin", "--profile", "web"] + list(args)
    try:
        r = subprocess.run(cmd, cwd=str(project), env=env,
                           capture_output=True, text=True)
    except OSError as exc:
        raise PluginError(f"无法运行 dsh plugin：{exc}") from exc
    return r.returncode, r.stdout, r.stderr


def bundle_install(home: Path, source: "Path | str", *,
                   project: Optional[Path] = None,
                   run_dsh: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                   dsh_command: Optional[Sequence[str]] = None,
                   env: Optional[dict] = None) -> str:
    """真实安装 bundle：`dsh plugin --profile web add <源>`，备份可回滚。

    source 若是存在的本地目录/.tgz → 以绝对路径安装；否则视为**远程规格**
    （npm 包名 / github:xxx / git URL），原样转发给 `dsh plugin add`
    （走 registry，无需本地构建）。成功判定 = 安装前后 `dsh.profile.bundles`
    出现新 bundle。
    """
    before = {n for n, _ in bundle_installed(home)}
    if isinstance(source, str) and not Path(source).exists():
        spec = source
        expected = _spec_pkg_name(spec)
        argv = ["add", spec]
    else:
        src = Path(source)
        if not src.exists():
            raise PluginError(f"插件源不存在：{src}")
        expected = _bundle_name(src)
        if not expected:
            raise PluginError(f"无法识别 {src} 的包名")
        argv = ["add", str(src.resolve())]
    if expected and expected in BUNDLE_BUILTIN:
        raise PluginError(f"{expected} 是内置模板 bundle，无需安装")
    backup = _backup_manifest(home)
    project = project or Path.cwd()
    code, out, err = _run_dsh_plugin(argv, project=project, run_dsh=run_dsh,
                                     dsh_command=dsh_command, env=env)
    if code != 0:
        _restore_manifest(home, backup)
        raise PluginError(_dsh_fail_msg(code, out, err, argv))
    added = {n for n, _ in bundle_installed(home)} - before
    if not added:
        _restore_manifest(home, backup)
        raise PluginError(f"安装后未发现新增 bundle（预期 {expected}），见日志")
    return sorted(added)[0]


def bundle_remove(home: Path, name: str, *, project: Optional[Path] = None,
                  run_dsh: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                  dsh_command: Optional[Sequence[str]] = None,
                  env: Optional[dict] = None) -> None:
    if name in BUNDLE_BUILTIN:
        raise PluginError(f"{name} 是内置模板 bundle，不可移除")
    if name not in {n for n, _ in bundle_installed(home)}:
        raise PluginError(f"{name} 未安装")
    backup = _backup_manifest(home)
    project = project or Path.cwd()
    argv = ["remove", name]
    code, out, err = _run_dsh_plugin(argv, project=project, run_dsh=run_dsh,
                                     dsh_command=dsh_command, env=env)
    if code != 0:
        _restore_manifest(home, backup)
        raise PluginError(_dsh_fail_msg(code, out, err, argv))
    if name in {n for n, _ in bundle_installed(home)}:
        raise PluginError(f"移除后仍在 dsh.profile.bundles：{name}")


# ---------------------------------------------------------------- 插件市场（收录 + 本地 + 已装）

@dataclass(frozen=True)
class MarketEntry:
    name: str            # 展示名（收录=目录名，否则=包名）
    version: str
    downloaded: bool     # 本地已有源码/tgz
    installed: bool      # 已在 dsh.profile.bundles
    builtin: bool
    spec: str            # 用于 下载/安装 的 registry 规格（npm 名 / git url）
    local: Optional[Path]
    description: str


def _curated_spec(name_or_npm: str) -> Optional[str]:
    for c in CURATED_BUNDLES:
        if name_or_npm in (c["npm"], c["name"]):
            return c["npm"]
    return None


def market_entries(home: Path, project: Path,
                   assets_dir: Optional[Path] = None) -> list[MarketEntry]:
    """合并 收录清单 + 本地 bundle 候选 + 已安装 bundle，剔除内置模板。"""
    row: dict[str, MarketEntry] = {}
    for c in CURATED_BUNDLES:
        row[c["npm"]] = MarketEntry(name=c["name"], version="", downloaded=False,
                                    installed=False, builtin=False, spec=c["npm"],
                                    local=None, description=c["description"])
    for cand in bundle_candidates(project, assets_dir):
        if cand.name in BUNDLE_BUILTIN:
            continue
        base = row.get(cand.name)
        if base is None:
            row[cand.name] = MarketEntry(name=cand.name, version=cand.version,
                                         downloaded=True, installed=False,
                                         builtin=False,
                                         spec=_curated_spec(cand.name) or cand.name,
                                         local=cand.path, description="")
        else:
            row[cand.name] = replace(base, downloaded=True, version=cand.version,
                                     local=cand.path)
    for name, builtin in bundle_installed(home):
        if builtin:
            continue
        base = row.get(name)
        if base is None:
            row[name] = MarketEntry(name=name, version="", downloaded=False,
                                    installed=True, builtin=False, spec=name,
                                    local=None, description="")
        else:
            row[name] = replace(base, installed=True)
    return list(row.values())


def _pkg_from_tgz(tgz: Path) -> Optional[dict]:
    try:
        with tarfile.open(tgz, "r:gz") as tf:
            for m in tf.getmembers():
                if m.name in ("package/package.json", "package.json"):
                    raw = tf.extractfile(m)
                    if raw is None:
                        return None
                    return json.loads(raw.read().decode("utf-8"))
    except (OSError, tarfile.TarError, json.JSONDecodeError):
        return None
    return None


def bundle_check(source: Path) -> tuple[str, list[str]]:
    """校验 bundle 源（目录或 tgz）：返回 (包名, 错误列表)。"""
    if source.is_dir():
        pkg = _pkg_json(source)
        try:
            name = _bundle_name(source)
        except PluginError:
            name = ""
    else:
        pkg = _pkg_from_tgz(source)
        name = (pkg or {}).get("name", "")
    errs: list[str] = []
    if pkg is None:
        return name, ["缺 package.json"]
    if not pkg.get("dsh", {}).get("bundle", {}).get("patch"):
        errs.append("未声明 dsh.bundle.patch（不是 bundle 插件）")
    if source.is_dir():
        if not (source / "cordis.patch.yml").exists():
            errs.append("缺 cordis.patch.yml")
        main = (pkg.get("main") or "lib/index.js").lstrip("./")
        if not (source / main).exists():
            errs.append(f"入口 {main} 缺失（未构建 lib/）")
        if pkg.get("dsh", {}).get("client") and not (source / "lib" / "client.js").exists():
            errs.append("声明 dsh.client 但缺 lib/client.js")
    else:
        with tarfile.open(source, "r:gz") as tf:
            names = {m.name for m in tf.getmembers()}
        if "package/cordis.patch.yml" not in names:
            errs.append("tgz 缺 package/cordis.patch.yml")
        if "package/lib/index.js" not in names and not pkg.get("main", "").endswith("index.js"):
            errs.append("tgz 缺 package/lib/index.js（未构建）")
    return name, errs


def bundle_latest_version(spec: str, *,
                          run_npm: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                          ) -> Optional[str]:
    """查 registry 最新版本（best-effort，npm view 需网络）。失败/无 npm 返回 None。"""
    def npm(args: list[str]) -> tuple[int, str, str]:
        if run_npm is not None:
            return run_npm(args)
        try:
            r = subprocess.run(["npm", "view", spec, "version"],
                               capture_output=True, text=True)
            return r.returncode, r.stdout, r.stderr
        except OSError:
            return 127, "", "npm 不可用"
    code, o, _e = npm(["view", spec, "version"])
    if code != 0 or not o.strip():
        return None
    return o.strip().splitlines()[-1].strip()


def bundle_update(home: Path, spec: str, *, project: Optional[Path] = None,
                  run_dsh: Optional[Callable[[list[str]], tuple[int, str, str]]] = None,
                  dsh_command: Optional[Sequence[str]] = None,
                  env: Optional[dict] = None) -> str:
    """更新已安装 bundle：registry 源 `dsh plugin add <spec>@latest`，备份可回滚。"""
    name = _spec_pkg_name(spec)
    if name in BUNDLE_BUILTIN:
        raise PluginError(f"{name} 是内置模板 bundle，不可更新")
    if name not in {n for n, _ in bundle_installed(home)}:
        raise PluginError(f"{name} 未安装，无法更新")
    backup = _backup_manifest(home)
    project = project or Path.cwd()
    argv = ["add", f"{spec}@latest"]
    code, out, err = _run_dsh_plugin(argv, project=project, run_dsh=run_dsh,
                                     dsh_command=dsh_command, env=env)
    if code != 0:
        _restore_manifest(home, backup)
        raise PluginError(_dsh_fail_msg(code, out, err, argv))
    if name not in {n for n, _ in bundle_installed(home)}:
        _restore_manifest(home, backup)
        raise PluginError(f"更新后 {name} 不在 dsh.profile.bundles（见日志）")
    return name


# ---------------------------------------------------------------- 状态合成

def web_patch_declared_ids(home: Path) -> set[str]:
    """返回用户在 web 补丁里声明的 id 集合（自有段 + 外部 + 第一方行）。

    dump 输出是整套 web profile（bundles+profile+用户补丁）的全量清单；插件区
    只应展示**用户补丁声明过**的行，否则会把全部内置 `@deepseek-ai/*` 插件
    当成"内置(只读)"罗列出来（表现为"150 个插件"）。
    """
    patch = web_patch(home)
    if not patch.exists():
        return set()
    ids: set[str] = set()
    for ln in patch.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^    - id: ([A-Za-z0-9-]+)$", ln)
        if m:
            ids.add(m.group(1))
    return ids


def status_view(home: Path, sources: Sequence[PluginSource],
                dump: DumpResult) -> list[PluginCard]:
    ledger = ledger_load(home)
    by_slug = {s.slug: s for s in sources}
    declared = web_patch_declared_ids(home)
    cards: list[PluginCard] = []
    slugs: set[str] = set()

    # 第一方/外部：仅用户补丁声明的 @dsh-user 行（含不在台账的 → 外部）
    for e in dump.entries:
        m = NAME_RE.match(e.name)
        if m:
            slug = m.group(1)
            if slug not in declared:
                continue
            slugs.add(slug)
            src = by_slug.get(slug)
            managed = ledger.row(slug) is not None
            state = "enabled" if not e.disabled else "disabled"
            if not managed:
                state = "external" if state == "enabled" else "external-disabled"
            cards.append(PluginCard(
                slug=slug, name=e.name, state=state,
                description=src.description if src else "",
                origin=(src.origin if src else "external"),
                installed_dir=anchor_dir(home, slug) if anchor_dir(home, slug).exists() else None,
                source=src.path if src else None,
                first_party=False,
                validation_errors=src.validation.errors if src else ()))
    # 第一方 @deepseek-ai 行只读展示（仅用户补丁里显式加过的那几条）
    for e in dump.entries:
        if e.id in declared and e.name.startswith("@deepseek-ai/") \
                and e.name not in {c.name for c in cards}:
            cards.append(PluginCard(
                slug=e.id, name=e.name,
                state="first_party" if not e.disabled else "first_party-disabled",
                description="", origin="bundle/profile",
                installed_dir=None, source=None, first_party=True))

    # 已下载（来源有、组合无）
    for s in sources:
        if s.slug not in slugs:
            slugs.add(s.slug)
            cards.append(PluginCard(
                slug=s.slug, name=f"@dsh-user/{s.slug}", state="downloaded",
                description=s.description, origin=s.origin,
                installed_dir=None, source=s.path,
                first_party=False, validation_errors=s.validation.errors))
    cards.sort(key=lambda c: (c.state not in ("enabled",), c.name))
    return cards


# ---------------------------------------------------------------- 激活门（GUI 用）

def health_ok(log_text: str) -> bool:
    """激活门健康信号：启动日志无 loader 失败/激活失败标记。"""
    low = log_text.lower()
    return not any(m.lower() in low for m in LOADER_FAIL_MARKERS)
