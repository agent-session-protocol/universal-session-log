#!/usr/bin/env python3
"""Generate localized SESDB product scenario diagrams as SVG assets."""

from __future__ import annotations

import html
from pathlib import Path


OUT = Path(__file__).resolve().parents[1] / "site" / "public" / "diagrams"
W, H = 1200, 720

COLORS = {
    "canvas": "#f7f6f2",
    "surface": "#fffefa",
    "ink": "#202522",
    "muted": "#707873",
    "line": "#d9ddd8",
    "green": "#467061",
    "green_fill": "#e8f0ec",
    "orange": "#aa6948",
    "orange_fill": "#f6ebe5",
    "blue": "#69779b",
    "blue_fill": "#e9edf5",
    "purple": "#7b6d93",
    "purple_fill": "#eeeaf3",
    "gold": "#a1844c",
    "gold_fill": "#f3eddf",
}


def esc(value: str) -> str:
    return html.escape(value, quote=True)


def text_width(value: str, size: int = 12) -> float:
    units = sum(1.8 if ord(char) > 255 else 1 for char in value)
    return units * size * 0.56


def start(title: str, subtitle: str, number: str) -> list[str]:
    title_size = 30 if text_width(title, 30) <= 1060 else 25
    return [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
        '<style>text{font-family:"Helvetica Neue",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}.mono{font-family:"SFMono-Regular",Consolas,monospace}</style>',
        '<defs>',
        '<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="#202522" flood-opacity=".08"/></filter>',
        '<marker id="arrow-green" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#467061"/></marker>',
        '<marker id="arrow-orange" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#aa6948"/></marker>',
        '<marker id="arrow-blue" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#69779b"/></marker>',
        '<marker id="arrow-purple" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#7b6d93"/></marker>',
        '</defs>',
        f'<rect width="{W}" height="{H}" fill="{COLORS["canvas"]}"/>',
        f'<text x="56" y="54" fill="{COLORS["green"]}" font-size="12" font-weight="700" letter-spacing="2.2">SCENARIO {esc(number)} · SESDB</text>',
        f'<text x="56" y="94" fill="{COLORS["ink"]}" font-size="{title_size}" font-weight="700">{esc(title)}</text>',
        f'<text x="56" y="122" fill="{COLORS["muted"]}" font-size="14">{esc(subtitle)}</text>',
    ]


def finish(lines: list[str], legend: list[tuple[str, str, bool]]) -> None:
    x = 56
    for color, label, dashed in legend:
        dash = ' stroke-dasharray="6,4"' if dashed else ""
        lines.append(f'<line x1="{x}" y1="685" x2="{x + 30}" y2="685" stroke="{color}" stroke-width="2"{dash}/>' )
        lines.append(f'<text x="{x + 38}" y="689" fill="{COLORS["muted"]}" font-size="11">{esc(label)}</text>')
        x += 48 + text_width(label, 11) + 34
    lines.append('<text x="1144" y="689" text-anchor="end" fill="#9aa09c" font-size="10" letter-spacing="1">UNIVERSAL SESSION LOG</text>')
    lines.append('</svg>')


def group(lines: list[str], x: int, y: int, w: int, h: int, label: str) -> None:
    lines.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="#ffffff" fill-opacity=".45" stroke="{COLORS["line"]}" stroke-dasharray="6,5"/>')
    lines.append(f'<text x="{x + 16}" y="{y + 24}" fill="{COLORS["muted"]}" font-size="10" font-weight="700" letter-spacing="1.4">{esc(label.upper())}</text>')


def node(lines: list[str], x: int, y: int, w: int, h: int, title: str, note: str, tone: str = "green", badge: str = "") -> None:
    stroke = COLORS[tone]
    fill = COLORS[f"{tone}_fill"]
    lines.append(f'<g filter="url(#shadow)"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{COLORS["surface"]}" stroke="{COLORS["line"]}"/></g>')
    lines.append(f'<rect x="{x + 14}" y="{y + 16}" width="38" height="38" rx="9" fill="{fill}" stroke="{stroke}" stroke-opacity=".28"/>')
    lines.append(f'<text x="{x + 33}" y="{y + 41}" text-anchor="middle" fill="{stroke}" font-size="{11 if len(badge) > 3 else 14}" font-weight="700">{esc(badge or title[:2])}</text>')
    lines.append(f'<text x="{x + 64}" y="{y + 31}" fill="{COLORS["ink"]}" font-size="14" font-weight="700">{esc(title)}</text>')
    lines.append(f'<text x="{x + 64}" y="{y + 50}" fill="{COLORS["muted"]}" font-size="11">{esc(note)}</text>')


def sesdb(lines: list[str], x: int, y: int, w: int, h: int, title: str, notes: list[str]) -> None:
    lines.append(f'<g filter="url(#shadow)"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="#202522" stroke="#314139" stroke-width="2"/></g>')
    lines.append(f'<ellipse cx="{x + 46}" cy="{y + 38}" rx="25" ry="9" fill="#466e61" stroke="#83a99b"/>')
    lines.append(f'<path d="M{x + 21},{y + 38} v28 c0,5 11,9 25,9 s25,-4 25,-9 v-28" fill="#35584d" stroke="#83a99b"/>')
    lines.append(f'<ellipse cx="{x + 46}" cy="{y + 66}" rx="25" ry="9" fill="#315247" stroke="#83a99b"/>')
    lines.append(f'<text x="{x + 84}" y="{y + 36}" fill="#ffffff" font-size="19" font-weight="700">{esc(title)}</text>')
    for index, note in enumerate(notes):
        lines.append(f'<text x="{x + 84}" y="{y + 59 + index * 18}" fill="#b9c5bf" font-size="11">{esc(note)}</text>')


def arrow(lines: list[str], d: str, color: str, label: str = "", lx: int = 0, ly: int = 0, dashed: bool = False) -> None:
    dash = ' stroke-dasharray="7,5"' if dashed else ""
    lines.append(f'<path d="{d}" fill="none" stroke="{COLORS[color]}" stroke-width="2.2"{dash} marker-end="url(#arrow-{color})"/>')
    if label:
        width = max(54, text_width(label, 11) + 16)
        lines.append(f'<rect x="{lx - width / 2:.1f}" y="{ly - 14}" width="{width:.1f}" height="21" rx="5" fill="{COLORS["canvas"]}" fill-opacity=".96"/>')
        lines.append(f'<text x="{lx}" y="{ly}" text-anchor="middle" fill="{COLORS["muted"]}" font-size="11">{esc(label)}</text>')


def pill(lines: list[str], x: int, y: int, text: str, tone: str = "green") -> None:
    width = max(72, text_width(text, 11) + 24)
    lines.append(f'<rect x="{x}" y="{y}" width="{width:.1f}" height="28" rx="14" fill="{COLORS[f"{tone}_fill"]}" stroke="{COLORS[tone]}" stroke-opacity=".3"/>')
    lines.append(f'<text x="{x + width / 2:.1f}" y="{y + 18}" text-anchor="middle" fill="{COLORS[tone]}" font-size="11" font-weight="600">{esc(text)}</text>')


COPY = {
    "en": {
        "training": ("From agent sessions to better models", "Turn evidence-rich interaction histories into governed datasets for training, fine-tuning, and distillation."),
        "insights": ("Your sessions become an operating system for work", "Connect activity, projects, tools, and cost—then turn the same facts into reports and durable memory."),
        "browser": ("One place to explore every agent session", "Search and inspect canonical sessions across runtimes without losing their native evidence."),
        "handoff": ("Handoff across harnesses and environments", "SESDB carries checkpoints, lineage, and evidence so another agent can continue—not merely restart."),
    },
    "zh": {
        "training": ("从 Agent 会话到更好的模型", "将带证据的交互历史转化为可治理的数据集，用于训练、微调与蒸馏。"),
        "insights": ("让个人会话成为工作的操作系统", "关联活动、项目、工具与成本，并从同一事实产出周报和长期记忆。"),
        "browser": ("在一个平台浏览所有 Agent 会话", "跨 Runtime 搜索和检查 canonical session，同时保留原生证据。"),
        "handoff": ("跨 Harness、跨环境完成 Handoff", "SESDB 携带检查点、Lineage 与证据，让另一个 Agent 继续工作，而不是重新开始。"),
    },
}


def training(locale: str) -> list[str]:
    zh = locale == "zh"
    title, subtitle = COPY[locale]["training"]
    lines = start(title, subtitle, "01")
    group(lines, 44, 152, 230, 472, "Agent runtimes" if not zh else "Agent Runtime")
    group(lines, 294, 152, 300, 472, "Canonical data plane" if not zh else "Canonical 数据平面")
    group(lines, 614, 152, 542, 472, "Model improvement" if not zh else "模型改进")
    sources = [("Codex", "code + tool traces" if not zh else "代码与工具轨迹", "CX"), ("Claude Code", "reasoning + edits" if not zh else "推理与编辑", "CL"), ("Pi / OpenCode", "messages + events" if not zh else "消息与事件", "PI"), ("Custom agents", "domain workflows" if not zh else "领域工作流", "API")]
    for index, (name, note, badge) in enumerate(sources): node(lines, 66, 195 + index * 98, 186, 76, name, note, ["green", "orange", "blue", "purple"][index], badge)
    arrow(lines, "M252,233 H320", "green", "capture", 286, 224)
    arrow(lines, "M252,331 H320", "green")
    arrow(lines, "M252,429 H320", "green")
    arrow(lines, "M252,527 H320", "green")
    sesdb(lines, 320, 260, 248, 122, "SESDB", ["canonical events · lineage" if not zh else "canonical event · lineage", "append-only · replayable" if not zh else "append-only · 可回放"])
    node(lines, 320, 424, 248, 78, "Dataset builder" if not zh else "数据集构建器", "filter · redact · dedupe" if not zh else "过滤 · 脱敏 · 去重", "gold", "ETL")
    node(lines, 320, 524, 248, 70, "Policy + provenance" if not zh else "策略与 Provenance", "consent · source · version" if not zh else "授权 · 来源 · 版本", "purple", "POL")
    arrow(lines, "M444,382 V424", "orange", "curate" if not zh else "治理", 482, 408)
    arrow(lines, "M444,502 V524", "purple")
    node(lines, 648, 210, 206, 82, "SFT / fine-tuning" if not zh else "SFT / 微调", "instruction + response", "green", "SFT")
    node(lines, 914, 210, 206, 82, "Pre-training mix" if not zh else "训练数据混合", "high-signal trajectories" if not zh else "高价值轨迹", "blue", "PT")
    node(lines, 648, 338, 206, 82, "Distillation" if not zh else "模型蒸馏", "teacher traces → student", "orange", "KD")
    node(lines, 914, 338, 206, 82, "Preference data" if not zh else "偏好数据", "success · retry · reject" if not zh else "成功 · 重试 · 拒绝", "purple", "DPO")
    arrow(lines, "M568,463 H610 V251 H648", "green")
    arrow(lines, "M568,463 H610 V318 H1017 V210", "blue", "JSONL / Parquet", 800, 312)
    arrow(lines, "M610,251 V379 H648", "orange")
    arrow(lines, "M610,379 V452 H1017 V420", "purple", "preference pairs" if not zh else "偏好样本对", 810, 445)
    sesdb(lines, 752, 488, 270, 104, "Evaluated LLM" if not zh else "评测后的 LLM", ["quality · safety · task success" if not zh else "质量 · 安全 · 任务成功"])
    arrow(lines, "M751,420 V458 H824 V488", "green")
    arrow(lines, "M1017,420 V458 H950 V488", "green")
    arrow(lines, "M752,540 C680,540 684,574 594,574", "purple", "evaluation loop" if not zh else "评测反馈", 674, 564, True)
    finish(lines, [(COLORS["green"], "canonical data" if not zh else "canonical 数据", False), (COLORS["orange"], "curation / transform" if not zh else "治理与转换", False), (COLORS["purple"], "feedback / policy" if not zh else "反馈与策略", True)])
    return lines


def insights(locale: str) -> list[str]:
    zh = locale == "zh"
    title, subtitle = COPY[locale]["insights"]
    lines = start(title, subtitle, "02")
    group(lines, 44, 152, 266, 472, "Personal activity" if not zh else "个人活动")
    group(lines, 334, 152, 326, 472, "Session intelligence" if not zh else "会话智能")
    group(lines, 684, 152, 472, 472, "Useful outputs" if not zh else "可用产出")
    node(lines, 68, 204, 218, 78, "Coding sessions" if not zh else "编码会话", "prompts · edits · tools" if not zh else "提示 · 编辑 · 工具", "green", "DEV")
    node(lines, 68, 318, 218, 78, "Projects" if not zh else "项目", "repo · branch · milestone" if not zh else "仓库 · 分支 · 里程碑", "orange", "PRJ")
    node(lines, 68, 432, 218, 78, "Usage + cost" if not zh else "用量与成本", "tokens · cache · runtime" if not zh else "Token · 缓存 · Runtime", "blue", "TOK")
    pill(lines, 86, 548, "One private timeline" if not zh else "一条私有时间线", "purple")
    arrow(lines, "M286,243 H370", "green", "events", 328, 234)
    arrow(lines, "M286,357 H370", "orange", "context", 328, 348)
    arrow(lines, "M286,471 H370", "blue", "usage", 328, 462)
    sesdb(lines, 370, 226, 254, 116, "SESDB", ["identity · time · project" if not zh else "身份 · 时间 · 项目", "evidence-backed history" if not zh else "证据可追溯的历史"])
    node(lines, 370, 382, 254, 82, "SessionQL analytics" if not zh else "SessionQL 分析", "group · relate · aggregate" if not zh else "分组 · 关联 · 聚合", "green", "SQL")
    node(lines, 370, 500, 254, 72, "Memory compiler" if not zh else "记忆编译器", "extract · consolidate · expire" if not zh else "提取 · 整合 · 过期", "purple", "MEM")
    arrow(lines, "M497,342 V382", "green")
    arrow(lines, "M497,464 V500", "purple")
    outputs = [("Weekly report" if not zh else "个人周报", "outcomes + evidence" if not zh else "成果与证据", "green", "W"), ("Durable memory" if not zh else "长期记忆", "facts + decisions" if not zh else "事实与决策", "purple", "M"), ("Token dashboard" if not zh else "Token 看板", "runtime + cache + cost" if not zh else "Runtime · 缓存 · 成本", "blue", "T"), ("Project graph" if not zh else "项目关系图", "sessions ↔ milestones" if not zh else "会话 ↔ 里程碑", "orange", "G")]
    positions = [(720, 204), (934, 204), (720, 382), (934, 382)]
    for (name, note, tone, badge), (x, y) in zip(outputs, positions): node(lines, x, y, 188, 86, name, note, tone, badge)
    arrow(lines, "M624,423 H682 V247 H720", "green", "summarize" if not zh else "总结", 682, 238)
    arrow(lines, "M624,536 H700 V310 H1028 V290", "purple", "remember" if not zh else "记忆", 846, 304)
    arrow(lines, "M624,423 H682 V425 H720", "blue", "measure" if not zh else "度量", 682, 416)
    arrow(lines, "M624,423 H682 V490 H1028 V468", "orange", "relate" if not zh else "关联", 846, 484)
    pill(lines, 770, 534, "Same facts, multiple views" if not zh else "同一事实，多种视图", "green")
    finish(lines, [(COLORS["green"], "session facts" if not zh else "会话事实", False), (COLORS["blue"], "usage metrics" if not zh else "用量指标", False), (COLORS["purple"], "memory write" if not zh else "记忆写入", False)])
    return lines


def browser(locale: str) -> list[str]:
    zh = locale == "zh"
    title, subtitle = COPY[locale]["browser"]
    lines = start(title, subtitle, "03")
    group(lines, 44, 152, 250, 472, "All sources" if not zh else "全部来源")
    group(lines, 318, 152, 304, 472, "Query plane" if not zh else "查询平面")
    group(lines, 646, 152, 510, 472, "Interactive console" if not zh else "交互式控制台")
    for index, (name, badge, tone) in enumerate([("Codex", "CX", "green"), ("Claude Code", "CL", "orange"), ("Pi", "PI", "blue"), ("OpenCode", "OC", "purple")]):
        node(lines, 68, 194 + index * 96, 202, 72, name, "native session log" if not zh else "原生 Session Log", tone, badge)
    arrow(lines, "M270,230 H354", "green")
    arrow(lines, "M270,326 H354", "green")
    arrow(lines, "M270,422 H354", "green")
    arrow(lines, "M270,518 H354", "green")
    sesdb(lines, 354, 214, 232, 114, "SESDB", ["canonical timeline" if not zh else "canonical 时间线", "runtime provenance" if not zh else "Runtime provenance"])
    node(lines, 354, 366, 232, 80, "SessionQL" , "search · filter · lineage" if not zh else "搜索 · 筛选 · Lineage", "green", "Q")
    node(lines, 354, 484, 232, 76, "Evidence resolver" if not zh else "证据解析器", "event → source offsets" if not zh else "事件 → 原始偏移", "gold", "EV")
    arrow(lines, "M470,328 V366", "green")
    arrow(lines, "M470,446 V484", "orange")
    lines.append('<g filter="url(#shadow)"><rect x="682" y="186" width="438" height="382" rx="14" fill="#fffefa" stroke="#cfd5d0"/></g>')
    lines.append('<rect x="682" y="186" width="438" height="34" rx="14" fill="#202522"/><rect x="682" y="207" width="438" height="13" fill="#202522"/>')
    for x, color in [(700, "#d97663"), (716, "#d7a44c"), (732, "#6f9a7f")]: lines.append(f'<circle cx="{x}" cy="203" r="4" fill="{color}"/>')
    lines.append(f'<text x="754" y="207" fill="#dfe5e1" font-size="10" font-weight="600">SESDB CONSOLE</text>')
    lines.append(f'<rect x="698" y="236" width="116" height="312" rx="8" fill="#202522"/>')
    for index, label in enumerate((["Overview", "Sessions", "Analytics", "Runtimes", "Storage"] if not zh else ["概览", "会话", "分析", "Runtime", "存储"])):
        fill = "#355248" if index == 1 else "none"
        lines.append(f'<rect x="708" y="{252 + index * 43}" width="96" height="32" rx="6" fill="{fill}"/>')
        lines.append(f'<text x="720" y="{272 + index * 43}" fill="#d9e1dc" font-size="10">{esc(label)}</text>')
    lines.append(f'<rect x="830" y="238" width="274" height="36" rx="8" fill="#f3f4f1" stroke="#d9ddd8"/><text x="846" y="261" fill="#8b918d" font-size="10">{esc("Search sessions, projects, tools…" if not zh else "搜索会话、项目、工具…")}</text>')
    for index, (heading, note, tone) in enumerate([("Session timeline" if not zh else "会话时间线", "messages · tools · reasoning" if not zh else "消息 · 工具 · 推理", "green"), ("Native evidence" if not zh else "原生证据", "source offsets + payload" if not zh else "原始偏移与 Payload", "orange"), ("Usage summary" if not zh else "用量摘要", "tokens · cache · errors" if not zh else "Token · 缓存 · 错误", "blue")]):
        y = 292 + index * 82
        lines.append(f'<rect x="830" y="{y}" width="274" height="64" rx="8" fill="{COLORS[f"{tone}_fill"]}" stroke="{COLORS[tone]}" stroke-opacity=".24"/>')
        lines.append(f'<text x="846" y="{y + 25}" fill="{COLORS["ink"]}" font-size="12" font-weight="700">{esc(heading)}</text><text x="846" y="{y + 44}" fill="{COLORS["muted"]}" font-size="10">{esc(note)}</text>')
    arrow(lines, "M586,406 H646 V377 H682", "green", "typed results" if not zh else "类型化结果", 634, 368)
    arrow(lines, "M586,522 H646 V520 H682", "orange", "evidence" if not zh else "证据", 632, 511)
    finish(lines, [(COLORS["green"], "query + result" if not zh else "查询与结果", False), (COLORS["orange"], "evidence link" if not zh else "证据链接", False)])
    return lines


def handoff(locale: str) -> list[str]:
    zh = locale == "zh"
    title, subtitle = COPY[locale]["handoff"]
    lines = start(title, subtitle, "04")
    group(lines, 44, 152, 300, 472, "Origin environment" if not zh else "来源环境")
    group(lines, 368, 152, 464, 472, "Portable handoff plane" if not zh else "可移植 Handoff 平面")
    group(lines, 856, 152, 300, 472, "Target environment" if not zh else "目标环境")
    pill(lines, 72, 180, "Laptop · macOS" if not zh else "笔记本 · macOS", "blue")
    node(lines, 72, 240, 244, 84, "Harness A · Codex", "active coding session" if not zh else "正在进行的编码会话", "green", "A")
    node(lines, 72, 374, 244, 84, "Workspace A", "repo · branch · files" if not zh else "仓库 · 分支 · 文件", "orange", "FS")
    node(lines, 72, 508, 244, 78, "Checkpoint" if not zh else "检查点", "intent · plan · pending work" if not zh else "目标 · 计划 · 待办", "purple", "CP")
    arrow(lines, "M194,324 V374", "orange")
    arrow(lines, "M194,458 V508", "purple")
    sesdb(lines, 402, 208, 396, 128, "SESDB Handoff Layer" if not zh else "SESDB Handoff 中间层", ["canonical session bundle · asOfSeq" if not zh else "canonical session bundle · asOfSeq", "lineage · evidence · capability manifest" if not zh else "Lineage · 证据 · Capability Manifest"])
    node(lines, 402, 378, 184, 88, "Policy gate" if not zh else "策略门", "redact · authorize" if not zh else "脱敏 · 授权", "gold", "POL")
    node(lines, 614, 378, 184, 88, "Adapter B" if not zh else "适配器 B", "bundle → native input" if not zh else "Bundle → 原生输入", "blue", "↻")
    pill(lines, 467, 520, "resume · fork · handoff" if not zh else "resume · fork · handoff", "green")
    arrow(lines, "M316,282 H402", "green", "capture", 359, 273)
    arrow(lines, "M316,547 H360 V296 H402", "purple", "checkpoint" if not zh else "检查点", 360, 480)
    arrow(lines, "M600,336 V378 H494", "gold", "policy", 536, 367)
    arrow(lines, "M586,422 H614", "blue")
    arrow(lines, "M706,378 V336", "blue", "materialize" if not zh else "物化", 748, 362)
    pill(lines, 884, 180, "Cloud · Linux" if not zh else "云端 · Linux", "blue")
    node(lines, 884, 240, 244, 84, "Harness B · Claude", "resumed with context" if not zh else "携带上下文继续", "orange", "B")
    node(lines, 884, 374, 244, 84, "Workspace B", "container · new tools" if not zh else "容器 · 新工具集", "green", "ENV")
    node(lines, 884, 508, 244, 78, "Continued lineage" if not zh else "连续 Lineage", "same intent, new runtime" if not zh else "同一目标，新 Runtime", "purple", "LN")
    arrow(lines, "M798,272 H884", "blue", "resume", 841, 263)
    arrow(lines, "M1006,324 V374", "orange")
    arrow(lines, "M1006,458 V508", "purple")
    arrow(lines, "M884,547 H832 V590 H812 V336 H798", "purple", "result + lineage" if not zh else "结果与 Lineage", 758, 584, True)
    finish(lines, [(COLORS["green"], "canonical capture" if not zh else "canonical 捕获", False), (COLORS["blue"], "handoff / resume" if not zh else "Handoff / Resume", False), (COLORS["purple"], "lineage feedback" if not zh else "Lineage 回写", True)])
    return lines


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    builders = {"training-data": training, "personal-insights": insights, "session-browser": browser, "cross-harness-handoff": handoff}
    for name, builder in builders.items():
        for locale in ("en", "zh"):
            path = OUT / f"sesdb-{name}-{locale}.svg"
            path.write_text("\n".join(builder(locale)), encoding="utf-8")
            print(path)


if __name__ == "__main__":
    main()
