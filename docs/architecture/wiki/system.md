---
sources:
  - crates/usl-core/src/lib.rs 2f9d518caa24 SessionId Store Record
  - crates/usl-capture/src/lib.rs c353c76cdf5a CaptureSession Framer FileFollower
  - packages/usl-convert/src/bundle.ts a7fe35aa4a9e SessionBundle makeBundle
  - crates/sesdb-engine/src/main.rs 514e426b6059 main dispatch
  - crates/sesdb-engine/src/daemon.rs adb042773b4f Writer run
  - packages/sesdb/src/index.ts df9de71f8f65 createSesdb
  - site/app/console/api.ts 95d2f2e34691 fetchDashboard
---

# 系统总览

USL 回答一个问题：**如何把任意 agent runtime（pi / Claude Code / Codex / opencode / dimagent）的 session log，收进一个统一、可恢复、可互转且可查询的存储层**，让「resume / fork / handoff（跨 harness 续跑）」「统一历史渲染」和有边界的本地分析成为可能。

系统由存储/捕获、转换、SESDB 查询与 Hosted Site 几个责任域组成：

| 层 | 包 | 语言 | 一句话职责 |
|---|---|---|---|
| 存储 | [usl-core](modules/usl-core.md) | Rust | 把记录追加进单文件、崩溃后自愈、按 session 读取 |
| 捕获 | [usl-capture](modules/usl-capture.md) | Rust | 把 harness 写日志的字节流切成完整记录，喂进存储 |
| 挂载 | [usl-fuse](modules/usl-fuse.md) | Rust | 从文件系统级别拦截 harness 写盘（当前暂停） |
| 转换 | [e-session-convert](modules/usl-convert.md) | TS | 各 harness 原生格式 ↔ 统一 bundle 的导入导出 |
| 查询 | [SESDB v0.2](modules/sesdb.md) | Rust + TS | 五 Provider 通过 stdio engine 或 localhost daemon 增量进入 usl-core，JS SDK/CLI 执行有界查询 |
| 展示 | [Hosted Site](modules/site.md) | TS/React | 静态产品站、文档与仅用 demo 数据的 Console |

## 核心设计边界

三条贯穿全局的决策：

1. **正确性只来自 append log**：存储层每条记录带长度前缀 + CRC，恢复时扫帧、遇到撕裂帧就截断。header 只是冗余提示，可从数据区自愈——这跟「不依赖任何 WAL/checkpoint 也能恢复」是同一个命题（见 usl-core）。
2. **不透明负载一等化**：claude 的 thinking `signature`、codex 的 `encrypted_content` 这类「不可解析但必须原样往返」的字节，用 typed `unknown` block 保真，不在转换时 normalize 掉。
3. **转换保真靠 evidence 与 byte-verifiable provenance**：每个 v2 bundle 存完整事件流、派生快照、排序后的 source artifact 集合与 canonical JSON digest。roundtrip 时 exporter 优先用 evidence 逐字还原原生负载；共享 conformance runner 单独检查 native record 是否逐条映射或声明 loss。
4. **查询不取代事实真源**：SESDB 的查询快照、索引和投影都可从 append log 重建；SDK 与 engine 通过能力协商显式限定 foundation 子集。
5. **Hosted Site 不连本地库**：Console 是静态导出中的浏览器 demo，其 adapter 只读内建样例，与 SDK/engine 不存在运行时连线。

## 依赖方向

```
SESDB JS SDK/CLI ─NDJSON/localhost→ sesdb-engine/sesdbd ─调用→ usl-core
e-session-convert ─依赖→ 内置 ASP schema
usl-fuse ─依赖→ usl-capture ─依赖→ usl-core
Hosted Site ─读取→ MDX 文档 / Demo adapter（不连 SESDB）
```

`sesdb-engine`/`sesdbd` 是 usl-core 的单写者进程边界，JS SDK 和 Console 都不直接打开 store。`usl-fuse` 依赖 `usl-core` + `usl-capture`，因 macOS 26 无可用 FUSE 而暂停。Hosted Site 独立静态导出，没有对 SESDB SDK 的代码依赖；共享 Console 只有由本地 daemon 托管时才切换到 localhost adapter。

## 谁在用它

当前是自研验证阶段：Rust 测试覆盖崩溃恢复、sidecar kill point、watcher 审计、五 Provider clean-room journey、捕获分帧与 engine RPC；TS 测试覆盖跨 harness roundtrip 与 SESDB foundation 查询。I0 runner 记录同机 100/1k/10k session 结果并固定 Obelisk 黑盒 revision。Playwright 同时覆盖本地 daemon 的真实数据与 freshness 状态，以及 Hosted Console 不请求 localhost；Hosted Site 对外展示的 Console 数据仍只是演示样例。
