---
sources:
  - crates/usl-core/src/lib.rs 2f9d518caa24 SessionId Store Record
  - crates/usl-capture/src/lib.rs c353c76cdf5a CaptureSession Framer FileFollower
  - packages/usl-convert/src/bundle.ts 90529e25aa78 SessionBundle makeBundle
---

# 系统总览

USL 回答一个问题：**如何把任意 agent runtime（pi / Claude Code / Codex / opencode / dimagent）的 session log，收进一个统一、可恢复、可互转的存储层**，让「resume / fork / handoff（跨 harness 续跑）」和「统一历史渲染」成为可能。

系统由四个包分层组成，各管一段：

| 层 | 包 | 语言 | 一句话职责 |
|---|---|---|---|
| 存储 | [usl-core](modules/usl-core.md) | Rust | 把记录追加进单文件、崩溃后自愈、按 session 读取 |
| 捕获 | [usl-capture](modules/usl-capture.md) | Rust | 把 harness 写日志的字节流切成完整记录，喂进存储 |
| 挂载 | [usl-fuse](modules/usl-fuse.md) | Rust | 从文件系统级别拦截 harness 写盘（当前暂停） |
| 转换 | [e-session-convert](modules/usl-convert.md) | TS | 各 harness 原生格式 ↔ 统一 bundle 的导入导出 |

## 核心设计边界

三条贯穿全局的决策：

1. **正确性只来自 append log**：存储层每条记录带长度前缀 + CRC，恢复时扫帧、遇到撕裂帧就截断。header 只是冗余提示，可从数据区自愈——这跟「不依赖任何 WAL/checkpoint 也能恢复」是同一个命题（见 usl-core）。
2. **不透明负载一等化**：claude 的 thinking `signature`、codex 的 `encrypted_content` 这类「不可解析但必须原样往返」的字节，用 typed `unknown` block 保真，不在转换时 normalize 掉。
3. **转换保真靠 evidence 层**：每个 bundle 存完整事件流（evidence）+ 派生快照（pivot）。roundtrip 时 exporter 优先用 evidence 逐字还原原生负载，缺失才合成并声明 loss。

## 依赖方向

```
e-session-convert（TS 转换层）
      │ 依赖 e-core 的 schema 定义（本 wiki 范围外）
usl-capture（捕获层）
      │ 依赖
usl-core（存储引擎，叶子 crate）
```

`usl-fuse` 依赖 `usl-core` + `usl-capture`，因 macOS 26 无可用 FUSE 而暂停。`usl-core` 是叶子 crate，零依赖本仓库其它代码——这是它将来独立成库的前提。

## 谁在用它

当前是自研验证阶段：`usl-core` 有 32 个测试证明崩溃恢复与确定性，`usl-capture` 有 21 个测试证明分帧与转换，`e-session-convert` 有 25 个测试证明四路 harness 互转。真实数据冒烟：codex 会话（303 消息 / 91 工具）经 pi 往返零丢失。
