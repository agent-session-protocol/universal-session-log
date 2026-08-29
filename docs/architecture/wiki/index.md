---
baseline: ff066591267cc8e96121fe5a41072092a7cde145
exclude:
  - Cargo.toml
  - LICENSE
  - package.json
  - docs/research/
---

# USL 架构导航

USL（Universal Session Log）是 ASP（Agent Session Protocol）的存储优先参考实现：一个 schema 无关、append-only、崩溃可恢复的 record store，加文件边界捕获与跨 harness 转换。本 wiki 覆盖四个包；`docs/research/` 是研究背景（ASP/ACP/FUSE 分析），不在代码架构范围内，见 index 的 exclude 清单。

## 模块

- [usl-core](modules/usl-core.md) — Rust 存储引擎：append-only、崩溃可恢复、schema 无关的 record store
- [usl-capture](modules/usl-capture.md) — Rust 捕获层：文件边界的 live ingest + 分帧 + 转换
- [usl-fuse](modules/usl-fuse.md) — Rust FUSE 挂载层：当前暂停（macOS 26 无可用 FUSE）
- [usl-convert](modules/usl-convert.md) — TS 跨 harness 转换层：pi/dimagent/claude/codex 互转

## 总览

- [系统总览](system.md)
- [数据流](data-flow.md)
- [体检报告](health.md)
