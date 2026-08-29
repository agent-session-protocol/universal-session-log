---
generated: npx -y knip@5 --reporter json (TS) ; cargo build (Rust dead_code 告警)
generated-at: 50dc4e3d58fbcccfd61f99d10569193b35263880
---

# 体检报告

## 死代码

- Rust（usl-core / usl-capture / usl-fuse）：`cargo build` 无 `dead_code` 告警 → 无死代码。`cargo +nightly udeps` 未运行（本机无 nightly 工具链）。
- TS（e-session-convert）：knip `files: []` → 无死文件。

### 疑似（未使用导出，需人工确认）

knip 报 17 个未使用导出（`deadExports`）：`digestOf`、`importedCapabilities` 两个函数 + 15 个类型接口（`DimagentImportResult`、`BuildSnapshotInput`、`PiExportResult`、`ClaudeImportResult`、`CodexExportResult` 等）。这些是库的对外 API 面——cli.ts 只 import 函数、测试只 import 部分，类型接口供外部消费者使用，非真死代码，暂保留。

## 循环依赖

0 条。Rust 三 crate 依赖链（usl-fuse → usl-capture → usl-core）单向无环；TS 里 e-session-convert 各模块单向指向 e-core schema（本 wiki 范围外），无仓内环。

## 高危热点

仓库过于年轻（USL 各包仅数个提交），`git log --since=12mo` 的 churn 均匀（每文件 1–2 次改动），无有意义的热点。churn=2 的文件：`usl-core/src/{store,recover,format}.rs`、`usl-capture/src/lib.rs`、`e-session-convert/src/{pi,codex,cli}.ts`——这是本阶段集中打磨的核心路径，非历史热点。

## 断点

0 条。TS 依赖图（code-map）无 `error`（解析失败）与 `unresolved`（悬空相对导入）。模板字符串动态导入对静态解析不可见，盲区靠死文件复核与工人边界回报兜底。
