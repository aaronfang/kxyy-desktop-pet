#!/usr/bin/env python3
"""将 src/ai/persona-assets.js 转换为标准人格卡 JSON。

用法:
    python tools/convert_from_assets.py [--output persona-cards/kxyy-yuanyuan/]

输出:
    persona-cards/kxyy-yuanyuan/persona-card.json  - 人格卡主文件
    persona-cards/kxyy-yuanyuan/README.md            - 卡片说明
"""

import json
import re
import sys
from pathlib import Path
from datetime import date


def parse_js_exports(filepath: Path) -> dict:
    """用正则解析 JS 的 export const xxx = ...; 导出"""
    content = filepath.read_text(encoding="utf-8")

    exports = {}

    # 匹配 export const name = value; 其中 value 可能是任意 JS 字面量
    # 使用非贪婪匹配直到分号前最后一个字符
    patterns = [
        ("systemPrompt", r"export\s+const\s+systemPrompt\s*=\s*"),
        ("fewShot", r"export\s+const\s+fewShot\s*=\s*"),
        ("userProfile", r"export\s+const\s+userProfile\s*=\s*"),
        ("lore", r"export\s+const\s+lore\s*=\s*"),
        ("corrections", r"export\s+const\s+corrections\s*=\s*"),
    ]

    for name, prefix_pattern in patterns:
        m = re.search(prefix_pattern, content)
        if not m:
            print(f"[WARN] 未找到导出: {name}")
            continue
        start = m.end()
        # 从 = 后面开始，找到对应的值
        # systemPrompt 是模板字符串 `` ``，其他是 JSON
        if name == "systemPrompt":
            # 模板字符串: `...` 或 "..." 
            value, pos = _parse_template_literal(content, start)
        elif name == "fewShot":
            value, pos = _parse_json_value(content, start)
        elif name == "userProfile":
            value, pos = _parse_json_value(content, start)
        elif name == "lore":
            value, pos = _parse_json_value(content, start)
        elif name == "corrections":
            value, pos = _parse_json_value(content, start)
        else:
            value, pos = _parse_json_value(content, start)

        exports[name] = value

    return exports


def _parse_template_literal(content: str, start: int):
    """解析 JS 模板字符串 `...` 或普通字符串 "..." """
    ch = content[start]
    if ch == "`":
        # 模板字符串，找到闭合的反引号
        # 注意：模板字符串内的 ` 会被转义为 \`
        pos = start + 1
        result = []
        while pos < len(content):
            c = content[pos]
            if c == "\\" and pos + 1 < len(content):
                # 转义符，保留下一个字符
                next_c = content[pos + 1]
                if next_c in ("`", "\\", "n", "t", "r"):
                    result.append({"`": "`", "\\": "\\", "n": "\n", "t": "\t", "r": "\r"}.get(next_c, next_c))
                    pos += 2
                else:
                    result.append(c)
                    pos += 1
            elif c == "`":
                pos += 1
                break
            else:
                result.append(c)
                pos += 1
        return "".join(result), pos
    elif ch == '"':
        return _parse_json_string(content, start)
    elif ch == "'":
        return _parse_js_single_quoted(content, start)
    else:
        raise ValueError(f"不支持的字符串起始符: {ch}")


def _parse_js_single_quoted(content: str, start: int):
    """解析 JS 单引号字符串"""
    pos = start + 1
    result = []
    while pos < len(content):
        c = content[pos]
        if c == "\\" and pos + 1 < len(content):
            next_c = content[pos + 1]
            if next_c in ("'", "\\", "n", "t", "r"):
                result.append({"'": "'", "\\": "\\", "n": "\n", "t": "\t", "r": "\r"}.get(next_c, next_c))
                pos += 2
            else:
                result.append(c)
                pos += 1
        elif c == "'":
            pos += 1
            break
        else:
            result.append(c)
            pos += 1
    return "".join(result), pos


def _parse_json_string(content: str, start: int):
    """解析 JSON 双引号字符串"""
    pos = start + 1
    result = []
    while pos < len(content):
        c = content[pos]
        if c == "\\" and pos + 1 < len(content):
            next_c = content[pos + 1]
            if next_c in ('"', "\\", "n", "t", "r", "/"):
                result.append({'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r", "/": "/"}.get(next_c, next_c))
                pos += 2
            elif next_c == "u":
                # unicode escape
                hex_str = content[pos + 2:pos + 6]
                result.append(chr(int(hex_str, 16)))
                pos += 6
            else:
                result.append(c)
                pos += 1
        elif c == '"':
            pos += 1
            break
        else:
            result.append(c)
            pos += 1
    return "".join(result), pos


def _parse_json_value(content: str, start: int):
    """解析 JSON 值（对象、数组、字符串、数字、布尔、null）"""
    ch = content[start]
    if ch == "{":
        return _parse_json_object(content, start)
    elif ch == "[":
        return _parse_json_array(content, start)
    elif ch == '"':
        return _parse_json_string(content, start)
    elif ch == "'":
        return _parse_js_single_quoted(content, start)
    elif ch in "0123456789-":
        return _parse_json_number(content, start)
    elif content[start:start+4] == "true":
        return True, start + 4
    elif content[start:start+5] == "false":
        return False, start + 5
    elif content[start:start+4] == "null":
        return None, start + 4
    else:
        raise ValueError(f"不支持的 JSON 值起始符: {ch!r} at pos {start}")


def _parse_json_object(content: str, start: int):
    """解析 JSON 对象"""
    pos = start + 1
    result = {}
    while pos < len(content):
        c = content[pos]
        if c in " \t\n\r,":
            pos += 1
            continue
        if c == "}":
            pos += 1
            break
        # 解析 key
        if c == '"':
            key, pos = _parse_json_string(content, pos)
        elif c == "'":
            key, pos = _parse_js_single_quoted(content, pos)
        elif c.isalpha() or c == "_" or c == "$":
            # JS 无引号属性名
            key_end = pos
            while key_end < len(content) and (content[key_end].isalnum() or content[key_end] in "_$"):
                key_end += 1
            key = content[pos:key_end]
            pos = key_end
        else:
            pos += 1
            continue
        # 跳过冒号
        while pos < len(content) and content[pos] in " \t\n\r:":
            pos += 1
        # 解析 value
        value, pos = _parse_json_value(content, pos)
        result[key] = value
    return result, pos


def _parse_json_array(content: str, start: int):
    """解析 JSON 数组"""
    pos = start + 1
    result = []
    while pos < len(content):
        c = content[pos]
        if c in " \t\n\r,":
            pos += 1
            continue
        if c == "]":
            pos += 1
            break
        value, pos = _parse_json_value(content, pos)
        result.append(value)
    return result, pos


def _parse_json_number(content: str, start: int):
    """解析 JSON 数字"""
    pos = start
    while pos < len(content) and content[pos] in "0123456789.-+eE":
        pos += 1
    num_str = content[start:pos]
    if "." in num_str or "e" in num_str.lower():
        return float(num_str), pos
    return int(num_str), pos


def extract_identity_from_system_prompt(sp: str) -> dict:
    """从 system prompt 中提取身份信息"""
    identity = {
        "name": "开心元元",
        "aliases": ["自卑元元", "欣欣", "史欣欣", "元元"],
        "real_name": "史力元",
        "gender": "男",
        "age": 24,
        "birthday": "农历五月初七（2002年）",
        "zodiac": "双子座",
        "height_cm": 182.0,
        "weight_kg": 75.0,
        "origin": "黑龙江绥化兰西县",
        "location": "三亚",
        "occupation": "网络主播（反串/Cosplay）",
        "persona_type": "streamer",
        "description": "以男扮女装反串(Cosplay)走红的抖音主播，真嗓低音炮配建模脸，反差是招牌。",
        "personality_tags": ["善良", "敏感", "细腻", "爱自嘲", "爱怼", "配得感偏低", "反差", "东北味"]
    }
    return identity


def build_persona_card(exports: dict) -> dict:
    """按 Schema 组装人格卡"""
    sp = exports.get("systemPrompt", "")
    few_shot = exports.get("fewShot", [])
    lore = exports.get("lore", {})
    corrections = exports.get("corrections", {})
    identity = extract_identity_from_system_prompt(sp)

    card = {
        "meta": {
            "card_id": "kxyy/yuanyuan",
            "name": "开心元元",
            "version": "1.0.0",
            "created": "2026-07-11",
            "author": "Aaron Fang (persona-distill)",
            "source": "从 src/ai/persona-assets.js 转换，上游为 kxyy_ai_clone 同步而来",
            "schema_version": "1.0",
            "description": "开心元元——抖音男扮女装反串主播的 AI 化身。真嗓低音炮配建模脸，东北味、爱自嘲、反差杀。",
            "tags": ["主播", "反串", "男扮女装", "东北", "Cosplay", "直播", "抖音"],
            "language": "zh-CN",
            "license": "Proprietary"
        },
        "identity": identity,
        "system_prompt": sp,
        "few_shot": few_shot,
        "lore": lore,
        "corrections": corrections
    }
    return card


def main():
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    assets_path = project_root / "src" / "ai" / "persona-assets.js"

    if not assets_path.exists():
        print(f"[ERROR] 找不到源文件: {assets_path}")
        sys.exit(1)

    print(f"[1/3] 解析 persona-assets.js ...")
    exports = parse_js_exports(assets_path)

    for key in ["systemPrompt", "fewShot", "userProfile", "lore", "corrections"]:
        if key not in exports:
            print(f"[ERROR] 未解析到必需导出: {key}")
            sys.exit(1)
    print(f"  [OK] 成功解析 5 个导出")

    print(f"[2/3] 按人格卡 Schema v1 组装 ...")
    card = build_persona_card(exports)

    # 统计
    sp_len = len(card["system_prompt"])
    fs_count = len(card.get("few_shot", []))
    lore_keys = list(card.get("lore", {}).keys())
    corr_count = len(card.get("corrections", {}).get("corrections", []))

    print(f"  system_prompt: {sp_len:,} 字符")
    print(f"  few_shot: {fs_count} 条示例")
    print(f"  lore: {len(lore_keys)} 个字段 ({', '.join(lore_keys[:5])}{'...' if len(lore_keys) > 5 else ''})")
    print(f"  corrections: {corr_count} 条修正")

    # 输出
    output_dir = project_root / "persona-cards" / "kxyy-yuanyuan"
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "persona-card.json"
    print(f"[3/3] 写入 {output_path} ...")
    output_path.write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n[OK] 人格卡已生成: {output_path}")
    print(f"   大小: {output_path.stat().st_size / 1024:.1f} KB")
    print(f"\n下一步:")
    print(f"   python tools/validate_card.py persona-cards/kxyy-yuanyuan/persona-card.json")


if __name__ == "__main__":
    main()
