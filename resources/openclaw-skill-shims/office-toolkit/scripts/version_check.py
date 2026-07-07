#!/usr/bin/env python3
"""
office-toolkit 版本号一致性校验脚本

校验三处版本号是否一致：
  1. SKILL.md frontmatter (version 字段)
  2. notebook task-20260701-002 版本追踪表（最新行）
  3. 项目 MEMORY.md 本地版本状态

用法：
  python scripts/version_check.py                        # 三处全量校验
  python scripts/version_check.py --format table         # 表格输出
  python scripts/version_check.py --quiet               # 仅返回 0/1 退出码
"""

import json
import os
import re
import sys
from pathlib import Path


# --- 路径配置 ---
SKILL_HOME = Path(__file__).resolve().parent.parent  # office-toolkit/
SKILL_MD = SKILL_HOME / "SKILL.md"
NOTEBOOK = (
    Path(os.environ.get("WORKSPACE", "D:/AgentWorkspace/Claw"))
    / ".workbuddy" / "memory" / "notebook" / "task-20260701-002.json"
)
MEMORY_MD = (
    Path(os.environ.get("WORKSPACE", "D:/AgentWorkspace/Claw"))
    / ".workbuddy" / "memory" / "MEMORY.md"
)


# --- 提取函数 ---

def extract_skill_version() -> tuple[str | None, str | None]:
    """从 SKILL.md frontmatter 提取 version 字段。返回 (version, error)。"""
    if not SKILL_MD.exists():
        return None, f"文件不存在: {SKILL_MD}"
    content = SKILL_MD.read_text(encoding="utf-8")
    m = re.search(r'^version:\s*([^\s\n]+)', content, re.MULTILINE)
    if not m:
        return None, "SKILL.md frontmatter 中未找到 version 字段"
    return m.group(1), None


def extract_notebook_version() -> tuple[str | None, str | None]:
    """从笔记本任务卡片版本追踪表提取最新版本号。返回 (version, error)。"""
    if not NOTEBOOK.exists():
        return None, f"笔记本文件不存在: {NOTEBOOK}"
    try:
        d = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return None, f"笔记本 JSON 解析失败: {e}"
    content = d.get("content", "")
    # 匹配版本追踪表中所有版本号，取最大的（最新版本）
    all_matches = re.findall(r"\|\s*(\d+\.\d+\.\d+)\s*\|", content)
    if not all_matches:
        return None, "笔记本版本追踪表中未找到版本号"
    # 按语义版本号排序取最大
    def ver_key(v):
        parts = v.split(".")
        return tuple(int(p) for p in parts)
    return max(all_matches, key=ver_key), None


def extract_memory_version() -> tuple[str | None, str | None]:
    """从项目 MEMORY.md 提取本地版本号。返回 (version, error)。"""
    if not MEMORY_MD.exists():
        return None, f"MEMORY.md 不存在: {MEMORY_MD}"
    content = MEMORY_MD.read_text(encoding="utf-8")
    # 匹配 "本地 vX.Y.Z" 或 "本地 vX.Y.Z。" 或 "线上 vX.Y.Z，本地 vX.Y.Z"
    m = re.search(r'本地\s*v(\d+\.\d+\.\d+)', content)
    if not m:
        return None, "MEMORY.md 中未找到「本地 vX.Y.Z」格式的版本号"
    return m.group(1), None


# --- 输出 ---

def format_table(results: list[dict]) -> str:
    """格式化为对齐表格。"""
    lines = []
    max_label = max(len(r["label"]) for r in results) + 2
    sep = "-" * (max_label + 20)
    lines.append(sep)
    for r in results:
        status = "✅" if not r["error"] else "❌"
        version = r["version"] or "—"
        label_pad = r["label"].ljust(max_label)
        lines.append(f"  {label_pad} {version:12s} {status}")
        if r["error"]:
            lines.append(f"  {' ' * max_label} → {r['error']}")
    lines.append(sep)
    return "\n".join(lines)


# --- 主逻辑 ---

def main():
    quiet = "--quiet" in sys.argv
    table_mode = "--format" in sys.argv and "table" in sys.argv

    skill_ver, skill_err = extract_skill_version()
    notebook_ver, notebook_err = extract_notebook_version()
    memory_ver, memory_err = extract_memory_version()

    results = [
        {"label": "SKILL.md frontmatter", "version": skill_ver, "error": skill_err},
        {"label": "notebook 版本追踪", "version": notebook_ver, "error": notebook_err},
        {"label": "MEMORY.md 本地版本", "version": memory_ver, "error": memory_err},
    ]

    # 收集所有已知版本号
    versions = {v for v in [skill_ver, notebook_ver, memory_ver] if v is not None}
    any_error = any(r["error"] for r in results)
    consistent = len(versions) <= 1  # 所有非 None 版本号相同

    if table_mode:
        print(format_table(results))

    if any_error:
        if not quiet:
            print(f"[FAIL] 存在读取错误，版本号无法验证", file=sys.stderr)
        sys.exit(2)

    if not consistent:
        if not quiet:
            print(f"[FAIL] 版本号不一致: {versions}", file=sys.stderr)
        sys.exit(1)

    if not quiet:
        ver = versions.pop() if versions else "?"
        print(f"[PASS] 三处版本号一致: v{ver}")

    sys.exit(0)


if __name__ == "__main__":
    main()
