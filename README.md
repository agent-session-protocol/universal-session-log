# USL — Universal Session Log

> **USL 是 [Agent Session Protocol (ASP)](https://github.com/agent-session-protocol/asp) 的存储优先参考实现。** ACP 管实时（编辑器↔agent 的当下交互），ASP 管会话的持久与跨 runtime 迁移，**USL 是 ASP 背后的存储引擎**。

USL 回答一个问题：**如何把任意 agent runtime（pi / Claude Code / Codex / opencode / dimagent）的 session log，收进一个统一、可恢复、可互转的存储层**，让「resume / fork / handoff（跨 harness 续跑）」和「统一历史渲染」成为可能。

## 三个核心性质

1. **存储优先，正确性只来自 append log**：每条记录带长度前缀 + CRC，崩溃后扫帧截断自愈，恢复结果逐字节确定（不依赖 WAL/checkpoint/header）。
2. **不透明负载一等化**：claude 的 thinking `signature`、codex 的 `encrypted_content` 这类"不可解析但必须原样往返"的字节，typed `unknown` block 保真，转换不丢。
3. **转换保真靠 evidence 层**：跨 harness 转换（pi/dimagent/claude/codex 互转）优先用 importer 存下的原生负载逐字还原，缺失才声明 loss。

## 仓库布局

```
crates/
├── usl-core/       # Rust 存储引擎：append-only、崩溃可恢复、schema 无关
├── usl-capture/    # Rust 捕获层：文件边界 live ingest + 分帧 + 转换
└── usl-fuse/       # Rust FUSE 挂载层（暂停：macOS 26 无可用 FUSE）
packages/
└── usl-convert/    # TS 跨 harness 转换层（ASP 参考实现）
docs/
├── research/       # 研究背景（ASP/ACP/FUSE 分析）
└── architecture/   # 架构 wiki（源码出处可校验）
```

## 快速上手

```bash
# Rust 存储 + 捕获（54 测试）
cargo test --workspace

# TS 跨 harness 转换（25 测试）
cd packages/usl-convert && npm install && npm run check

# 架构 wiki 校验（源码出处/哈希/认领对账）
npm run lint:architecture
```

## 协议规范

本仓库只含实现；协议层（canonical schema、事件语义、fidelity 矩阵、opaque passthrough 约定）见 [ASP spec](https://github.com/agent-session-protocol/asp)。

## 状态

**验证阶段**：存储引擎 32 测试、捕获层 21 测试、转换层 25 测试全绿；真实数据冒烟——codex 会话（303 消息 / 91 工具 / 99 个加密 reasoning blob）经 pi 往返零丢失。
