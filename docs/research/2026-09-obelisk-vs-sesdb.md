# Obelisk 与 SESDB：冻结基线和交付账本（2026-09）

## 结论

产品完整度基线冻结为
[`tommy0103/obelisk@f256668`](https://github.com/tommy0103/obelisk/tree/f25666800cda53d78b4304bcd793b6e65a5aad21)，
冻结日为 2026-08-31。上游复扫可以补充观察，但不能移动已经验收的
parity gate。Obelisk 代码受 AGPL 约束；本项目只做行为研究、黑盒 journey
和同机性能比较，不复制实现。

机器可读的事实账本位于
[`benchmarks/obelisk-baseline/baseline.json`](../../benchmarks/obelisk-baseline/baseline.json)，
并由 `npm run lint:baseline` 校验。状态只有三种：

分阶段的交付顺序、发布门槛与完整验收清单见
[`2026-09-sesdb-delivery-roadmap.md`](2026-09-sesdb-delivery-roadmap.md)。本文件记录
冻结比较事实，路线文档负责后续执行；两者都不得用计划项冒充已交付能力。

- **delivered**：仓库内存在可执行代码和测试证据；
- **specified**：RFC 或研究已经定义语义，但产品闭环尚未完成；
- **planned**：路线目标，不得写进当前功能清单。

## 冻结时差距

| 能力 | Obelisk | SESDB | 本仓库证据 |
|---|---|---|---|
| 五 provider 增量索引 | delivered | planned | adapter/daemon 尚无实现 |
| FTS5 与结构查询 | delivered | planned / foundation | `packages/sesdb/test/sesdb.test.ts` 仅执行 bounded `events` |
| Agent Skill | delivered | planned | 无 Skill 发布物 |
| 人工批准 memory | delivered | specified | `docs/research/2026-08-universal-session-log-db.md` |
| 桌面产品 | delivered（Electron） | planned（Tauri） | Hosted Console 当前仅 Demo adapter |
| append-only 崩溃恢复 | 派生索引模型 | delivered | `crates/usl-core/tests/crash.rs` |
| evidence-first 跨 harness 往返 | 非目标 | delivered（四路） | `packages/usl-convert/test/roundtrip.test.ts` |
| 类型化 SessionQL | 非目标 | foundation delivered | `docs/rfcs/0001-sessionql-query-plane.md` |

Obelisk 的公开 README 是功能发现入口，公开 issues 是 same-mtime、持续写、
finalize 和查询边界的回归线索；二者都不能代替本项目的端到端验收：
[pinned README](https://github.com/tommy0103/obelisk/blob/f25666800cda53d78b4304bcd793b6e65a5aad21/README.md)、
[issues](https://github.com/tommy0103/obelisk/issues)。

## I0 当前状态

已完成：固定 revision、clean-room 边界、五 provider 集合、共同场景枚举、
journey 状态账本和 CI 校验。尚未完成：可再分发的五 provider 原生语料、
隔离 HOME 的 Obelisk runner、同机 journey 输出，以及带硬件信息的
100/1k/10k 性能结果。因此 I0 gate 明确保持 `in-progress`。

共同语料必须覆盖主线程、subagent、tool call/result、summary、partial write、
truncate/replace、undo/clear、archive 和 delete。任一结果至少记录版本、commit、
OS、CPU、内存、语料摘要、开始/结束时间、通过项和失败项；缺失能力必须报告为
unsupported 或 failed，不能折叠为空结果。

## 实施顺序

1. **I1 foundation**：正式纳入 Rust engine、SDK/CLI、SessionQL foundation，
   并完成跨平台产物与隔离安装冒烟测试。
2. **I2–I3 headless**：单写者 daemon、可重建 SQLite FTS5 sidecar、provider
   adapter、固定快照结构查询、Skill 与人工批准 Insight。
3. **I4 product**：standalone Console 与 Tauri 共用 localhost versioned API；
   Hosted Site 永远只使用 Demo adapter。
4. **I5–I7 exceed**：evidence lineage、handoff fidelity、replay→tail SessionQL、
   攻击面与性能验收。

每个里程碑结束时复扫上游并更新账本。只有 capability、文档、端到端测试和
可观测指标同时存在的能力，才可从 `specified/planned` 升为 `delivered`。
