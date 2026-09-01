---
sources:
  - crates/sesdb-engine/src/main.rs 514e426b6059 main dispatch read_request_line
  - crates/sesdb-engine/src/daemon.rs 63cae68156de Writer ReplayState run reconcile watch_tick
  - crates/sesdb-engine/src/index.rs 194c771f98ad Sidecar catch_up rebuild_live search
  - crates/sesdb-engine/src/model.rs 10a9d8c8f1b4 NativeEvidence CanonicalEventBody MemoryRecord
  - crates/sesdb-engine/src/provider.rs 773a0a57a898 ProviderAdapter ClaudeAdapter CodexAdapter PiAdapter KimiAdapter DeepseekAdapter SourceUnit
  - packages/sesdb/src/engine.ts 5f9e4ed51bad NdjsonEngine MemoryEngine resolveEngineBinary
  - packages/sesdb/src/index.ts 51811cf26b78 createSesdb SesdbQueryError
  - packages/sesdb/src/query.ts 4df2001628a6 parseSessionQL printSessionQL SessionQLError
  - packages/sesdb/src/cli.ts 9e528c115819 main
  - docs/rfcs/0001-sessionql-query-plane.md 0c873e425273
  - skills/sesdb/SKILL.md 7d5b2230138d
covers:
  - crates/sesdb-engine/
  - packages/sesdb/
  - fixtures/providers/
  - benchmarks/i0/
  - docs/rfcs/0001-sessionql-query-plane.md
  - skills/sesdb/
---

# SESDB v0.2：本地增量查询平面

## 职责

在 usl-core 的持久记录之上提供单写者访问层。`sesdb-engine` 保留兼容 stdio；`sesdbd` 独占 L1，以多 artifact source unit 采集 Claude、Codex、Pi、Kimi 与 DeepSeek Harness，把可删除的 FTS5 sidecar 投影到固定 watermark，并通过随机 localhost endpoint 提供 API、Skill 与最小 Console。L1 replay 是事件去重、source checkpoint、visibility 和人工批准 Memory 的权威来源，SQLite 不参与采集幂等判断。RFC 的完整 SessionQL 仍只实现已声明子集。

## 对外接口

- `NdjsonEngine` / `DaemonEngine` / `EngineClient` / `MemoryEngine`（`packages/sesdb/src/engine.ts`）— stdio、daemon、抽象边界与测试内存实现。
- `createSesdb`（`packages/sesdb/src/index.ts`）— SDK 门面，提供 `search`、`query`、`context`、`events`、`capabilities`。foundation 查询执行当前只支持 `from events`。
- `parseSessionQL` / `printSessionQL`（`packages/sesdb/src/query.ts`）— SessionQL 文本与类型化计划之间的转换。
- `connectSesdb`（`packages/sesdb/src/index.ts`）— 自动检测陈旧 descriptor 并启动 daemon，暴露分页搜索、session、provider、reconcile 与 rebuild。
- `sesdb` CLI（`packages/sesdb/src/cli.ts`）— daemon/provider/index/session/console 与兼容查询入口。
- `sesdb-engine`（`crates/sesdb-engine/src/main.rs`）— stdin/stdout NDJSON RPC，实现 `appendBatch/scan/verify/stats/flush/capabilities`。
- `sesdbd`（`crates/sesdb-engine/src/daemon.rs`）— 单 writer、分层 watcher、HTTP API、带 TTL 的 browser session 与静态 Console；状态接口返回 generation、L1/sidecar watermark、degraded 和 rebuilding。
- `ProviderAdapter`（`crates/sesdb-engine/src/provider.rs`）— 五 Provider 的 metadata-only discover、多 artifact snapshot、evidence span、typed watch target、health、fingerprint 与 generation 逻辑；DeepSeek 同时解压 concatenated zstd frame。
- `sesdb` Skill（`skills/sesdb/SKILL.md`）— 只调用 localhost CLI/API 的 bounded、active-only retrieval，未知 filter 关闭失败，不直接读取 SQLite 或 provider 文件。

## 数据怎么流

provider 默认禁用；discover 仅 stat。Kimi 把 `state.json` 与 main/sub-agent wire 组成一个 source unit；DeepSeek 解压 `.jsonl.zstd` 并重组 chunk/tool linkage。启用后，文件系统通知只提供提示，最多 64 个热 source 每 2 秒检查快照/fingerprint，每 30 秒做一次全量 inventory/fingerprint 审计。完整记录依次生成 evidence、canonical event 和 checkpoint；rewrite 先写 visibility control 并开启 source generation。Memory candidate 只在用户明确批准后追加 approved revision，撤销再追加新 revision；默认读取和 Skill 只返回 approved/active。writer 严格执行 L1 append → flush → SQLite transaction；若事务失败就进入 degraded，下一轮先 catch-up 或重建，不继续采集。启动时从 L1 replay 恢复 canonical ID、checkpoint、visibility 与 Memory revision，落后的 sidecar 自动补投影，schema/integrity 异常则从固定 L1 `asOfSeq` 写临时 generation 并原子切换。搜索同时维护 `unicode61` 与 trigram FTS，三字符以上走 trigram，短查询走显式标注 `partial` 的有界 substring fallback；provider/project/session/time filters 和 timeline window 都返回 freshness 与 diagnostics。Host/Origin 按当前 daemon authority 精确匹配；浏览器只持有 HttpOnly 只读 cookie，Memory 写操作和其他管理 API 仍要求 daemon bearer。

## 改动指南

- 改持久性或 RPC 边界先看 `crates/sesdb-engine/src/main.rs` 的 `dispatch`：批量在验证完所有记录前不得写入，`appendBatch` 成功即代表已 durable flush。
- 改子进程协议要同步 `packages/sesdb/src/engine.ts` 的 pending-request 清理、超时与稳定错误码，并跑 Rust RPC 测试和 SDK 测试。
- 改查询语法先对照 `docs/rfcs/0001-sessionql-query-plane.md`，再同步 `query.ts` 的 parser/printer 和 `index.ts` 的执行能力；能解析不等于已能执行。
- engine 对同一 store 使用独占 `.lock`，store 与 lock 在 Unix 上都设为 `0600`；不要绕过锁启动第二个写者。
- watcher 的 2 秒轮询只允许读取热文件；全树内容审计固定在 30 秒兜底周期。新增提示源不能成为正确性的唯一依据，丢提示和删除 grace 必须使用可控时钟回归测试。
- sidecar 的 `builtThroughSeq` 必须与 L1 连续；禁止重新用 SQLite 的 `events`/`sources` 表决定 canonical 去重或 source generation。
- `fixtures/providers/` 是 CC0 clean-room feature corpus；`benchmarks/i0/` 只通过公开 CLI 黑盒运行冻结 Obelisk，不得把其 AGPL 实现复制进仓库或自动移动 baseline commit。
- Memory 状态变更必须校验证据 seq、scope 和 expected revision；candidate 不得进入 FTS 或默认 Skill retrieval，Console 的 read-only cookie 只能 review/source inspection，批准与撤销使用 bearer-only CLI。
