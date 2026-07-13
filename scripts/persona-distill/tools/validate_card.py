#!/usr/bin/env python3
"""人格卡 Schema 校验器。

用法:
    python tools/validate_card.py <persona-card.json>
    python tools/validate_card.py persona-cards/kxyy-yuanyuan/persona-card.json
    python tools/validate_card.py --all persona-cards/

基于 jsonschema 库对人格卡 JSON 进行严格校验，输出人类可读的错误报告。
"""

import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("[WARN] jsonschema 未安装。正在尝试安装...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "jsonschema", "-q"])
    import jsonschema


def load_schema() -> dict:
    """加载 Schema 定义文件"""
    schema_path = Path(__file__).resolve().parent.parent / "schema" / "persona-card.schema.json"
    if not schema_path.exists():
        print(f"[ERROR] Schema 文件不存在: {schema_path}")
        sys.exit(1)
    return json.loads(schema_path.read_text(encoding="utf-8"))


def load_card(card_path: Path) -> dict:
    """加载人格卡 JSON"""
    try:
        return json.loads(card_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[ERROR] JSON 解析失败: {card_path}")
        print(f"  {e}")
        sys.exit(1)


def format_error(error: jsonschema.exceptions.ValidationError, indent: int = 0) -> str:
    """格式化 jsonschema 校验错误为可读文本"""
    prefix = "  " * indent
    lines = [f"{prefix}[FAIL] {error.message}"]

    # 路径
    path_str = " → ".join([str(p) for p in error.absolute_path]) if error.absolute_path else "(根)"
    lines.append(f"{prefix}   路径: {path_str}")

    # Schema 路径
    if error.absolute_schema_path:
        schema_path_str = " → ".join([str(p) for p in list(error.absolute_schema_path)[-3:]])
        lines.append(f"{prefix}   Schema: {schema_path_str}")

    # 上下文信息
    if error.context:
        lines.append(f"{prefix}   详情:")
        for ctx_err in error.context:
            lines.append(format_error(ctx_err, indent + 1))

    return "\n".join(lines)


def validate_card(card_path: Path, schema: dict, verbose: bool = False) -> bool:
    """校验单张人格卡，返回是否通过"""
    print(f"\n--- 校验: {card_path.name} ---")

    try:
        card = load_card(card_path)
    except:
        return False

    # 基础检查
    issues_warning = []

    # meta 检查
    meta = card.get("meta", {})
    if not meta:
        issues_warning.append("[WARN] 缺少 meta 字段")
    else:
        print(f"  card_id: {meta.get('card_id', '(未设置)')}")
        print(f"  schema_version: {meta.get('schema_version', '(未设置)')}")
        print(f"  name: {meta.get('name', '(未设置)')}")

    # system_prompt 检查
    sp = card.get("system_prompt", "")
    if not sp:
        issues_warning.append("[WARN] system_prompt 为空！这会导致 LLM 无法正常运作")
    else:
        print(f"  system_prompt: {len(sp):,} 字符")

    # few_shot 检查
    fs = card.get("few_shot", [])
    if fs:
        user_count = sum(1 for m in fs if m.get("role") == "user")
        assistant_count = sum(1 for m in fs if m.get("role") == "assistant")
        print(f"  few_shot: {len(fs)} 条 (user={user_count}, assistant={assistant_count})")
    else:
        issues_warning.append("[WARN] few_shot 为空（非必需，但建议至少 10 条）")

    # personality_dimensions 检查
    pdims = card.get("personality_dimensions")
    if pdims:
        dims_filled = sum(1 for v in pdims.values() if v)
        print(f"  personality_dimensions: {dims_filled}/{len(pdims)} 个维度有数据")
    else:
        print(f"  personality_dimensions: (未设置，手动创建的人格卡可省略)")

    # Schema 严格校验
    validator = jsonschema.Draft202012Validator(schema)
    errors = list(validator.iter_errors(card))

    if errors:
        print(f"\n  [FAIL] Schema 校验失败: {len(errors)} 个错误")
        for err in errors[:10]:  # 只显示前10个
            print(format_error(err))
        if len(errors) > 10:
            print(f"  ... 还有 {len(errors) - 10} 个错误")
        return False

    # 检查警告
    if issues_warning:
        print(f"\n  [WARN] 警告 ({len(issues_warning)}):")
        for w in issues_warning:
            print(f"    {w}")

    print(f"  [OK] 校验通过")
    return True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    schema = load_schema()
    print(f"已加载 Schema v{schema.get('properties', {}).get('meta', {}).get('properties', {}).get('schema_version', {}).get('const', '?')}")

    arg = sys.argv[1]
    card_path = Path(arg)

    if arg == "--all" and len(sys.argv) > 2:
        # 批量校验目录下所有 persona-card.json
        base_dir = Path(sys.argv[2])
        card_files = sorted(base_dir.rglob("persona-card.json"))
        if not card_files:
            print(f"[ERROR] 在 {base_dir} 中未找到任何 persona-card.json")
            sys.exit(1)

        print(f"发现 {len(card_files)} 张人格卡\n")
        passed = 0
        failed = []
        for cf in card_files:
            if validate_card(cf, schema):
                passed += 1
            else:
                failed.append(cf)

        print(f"\n{'='*50}")
        print(f"批量校验完成: {passed}/{len(card_files)} 通过")
        if failed:
            print(f"失败: {len(failed)} 张")
            for f in failed:
                print(f"  ❌ {f}")
            sys.exit(1)
    else:
        if not card_path.exists():
            print(f"[ERROR] 文件不存在: {card_path}")
            sys.exit(1)

        ok = validate_card(card_path, schema)
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
