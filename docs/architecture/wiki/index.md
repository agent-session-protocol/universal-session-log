---
baseline: 65031d774a4557ab35cd9c746ee9f4feace1b853
exclude:
  - Cargo.toml
  - CHANGELOG.md
  - LICENSE
  - README.md
  - README.zh-CN.md
  - package.json
  - docs/geo/
  - docs/research/
  - scripts/update-star-history.mjs
  - scripts/generate-sesdb-scenario-diagrams.py
  - benchmarks/obelisk-baseline/
---

# USL 架构导航

USL（Universal Session Log）是 ASP（Agent Session Protocol）的存储优先参考实现：一个 schema 无关、append-only、崩溃可恢复的 record store，加文件边界捕获、跨 harness 转换、SESDB 查询基础层与托管文档站。本 wiki 对运行时包、SessionQL RFC 和 Site 逐一建立 ownership；`docs/research/` 仍作为研究背景显式豁免。

## 模块

- [usl-core](modules/usl-core.md) — Rust 存储引擎：append-only、崩溃可恢复、schema 无关的 record store
- [usl-capture](modules/usl-capture.md) — Rust 捕获层：文件边界的 live ingest + 分帧 + 转换
- [usl-fuse](modules/usl-fuse.md) — Rust FUSE 挂载层：当前暂停（macOS 26 无可用 FUSE）
- [usl-convert](modules/usl-convert.md) — TS 跨 harness 转换层：pi/dimagent/claude/codex 互转
- [SESDB foundation](modules/sesdb.md) — Rust engine + JS SDK/CLI + SessionQL RFC：在 USL 日志上提供有界查询平面
- [Hosted Site](modules/site.md) — Next.js/Fumadocs 站点：产品首页、文档与仅演示数据的 Console

## 总览

- [系统总览](system.md)
- [数据流](data-flow.md)
- [体检报告](health.md)
