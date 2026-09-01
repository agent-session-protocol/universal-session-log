---
sources:
  - packages/usl-convert/src/cli.ts 8871ac368eb8 importCodexSessionFile exportCodexSession
  - crates/usl-capture/src/follow.rs ff0d8312aa29 FileFollower poll
  - crates/usl-core/src/store.rs cda9b6f609d1 append flush
  - packages/sesdb/src/index.ts 390298f3d548 createSesdb
  - crates/sesdb-engine/src/main.rs 514e426b6059 dispatch
  - crates/sesdb-engine/src/daemon.rs 7bfb7bbb6ecf Writer watch_tick run
  - site/app/console/api.ts 95d2f2e34691 fetchDashboard
  - site/lib/source.ts a516b27ff313 source
---

# 数据流

系统的真实入口包括离线转换 CLI、live 捕获 example、存储 append/recover、SESDB SDK/CLI、本地 daemon/Console，以及 Hosted Site 的静态 route 和 Demo Console。下面按入口铺端到端路径。

## 离线转换（CLI 入口）

`node src/cli.ts convert <from> <to> <input> <output>` 是转换层唯一入口（`cli.ts` 的 `main()`）。

1. **读源 → 建 bundle**：按 `from` 选 importer（`importPiSessionFile` / `importClaudeSessionFile` / `importCodexSessionFile` / `importDimagentSession`）。每个 importer 把原生条目映射成 canonical event（`EvidenceBuilder.emit`），攒成 `evidence` 流。
2. **evidence → 快照**：`buildSnapshot` 把事件流按 run/turn/message/tool 分组，物化成 `AgentSessionSnapshot`（pivot）。bundle 不变式由 `validateBundle` 硬检（pivot.revision === evidence.length 等）。
3. **写 bundle → 目标**：按 `to` 选 exporter（`exportPiSession` / `exportDimagentSession` / `exportCodexSession`），把 canonical 重编码成目标 harness 原生格式，声明 loss。

关键性质：同一 bundle 是「WAL 角色」——pivot 永远可从 evidence 重放重建；exporter 优先用 evidence 里存的原生负载逐字还原（如 codex 的 `encrypted_content`、claude 的 `signature`）。

## live 捕获（文件边界入口）

`usl-capture/examples/live_convert.rs` 演示不依赖 FUSE 的 live 捕获：

1. **harness 写盘**：harness 把 claude JSONL 按任意字节块 append 到普通文件。
2. **文件尾随**：`FileFollower::poll` 读出自上次以来的新字节（截断/轮转时重置从头读）。
3. **分帧**：`Framer::feed` 把字节切成完整 JSONL 行，缓冲跨 write 边界的半行——分帧结果与字节如何切块无关。
4. **入库**：`CaptureSession::write` 把每行包成 `Record`（kind 标记行类型），`Store::append` 追加进 usl-core。
5. **转换**：读回 usl-core 的记录，`ClaudeToPi::convert` 把 claude 行转成可 resume 的 pi 条目。

## 存储 append / recover（存储入口）

`usl-core` 的 `Store::append` 是唯一的写入口：

1. **追加**：`Record` 序列化成 payload，`encode_frame` 包上 `[len][crc32][payload]`，`write_all` 到文件末尾，`flush` 时先 `sync_data` 再写 header 再 `sync_all`。
2. **崩溃恢复**：重开时 `recover_from` 从数据区扫帧，遇撕裂/CRC 不符/超长长度就截断到最后一个完整帧，索引由完整帧重放重建。header 损坏可从数据区自愈。

## SESDB 查询（SDK / CLI 入口）

`createSesdb(engine).query(...)` 是 foundation 查询入口，CLI 的 `query/search/context` 子命令使用同一 SDK 门面。

1. **解析与定格**：SDK 把 SessionQL 解析成计划，绑定参数并拒绝 foundation 尚未支持的 source/stage。
2. **固定快照**：SDK 先通过 engine `stats` 取 `nextSeq` 作为 `asOfSeq`，再以有界分页 `scan` 读取 canonical events，避免同一查询混入后续追加数据。
3. **跨进程读库**：`NdjsonEngine.request` 在 stdin 发送带 token 的 NDJSON；`sesdb-engine` 的 `dispatch` 验证限额后调用 usl-core 的全局或按 session 有界扫描。
4. **物化结果**：SDK 在固定快照上执行文本搜索、过滤、投影、排序和 limit，返回带 `queryHash` 与 `asOfSeq` 的结果。

## SESDB daemon（provider / 本地 Console 入口）

`sesdb provider enable/reconcile` 和本地 Console 通过随机 localhost endpoint 进入同一个单写者 daemon。

1. **发现与提示**：provider 默认禁用；discover 只读取路径和 stat。启用后文件系统 watcher 只发变化提示，最多 64 个热文件每 2 秒检查，30 秒全量 inventory/fingerprint audit 负责最终一致。
2. **L1 采集**：完整 native 行依次写 evidence、canonical event 和 source checkpoint；rewrite/truncate 先写 visibility control。canonical ID、checkpoint 与 visibility 都由 L1 replay 恢复，不查询 SQLite 决定幂等。
3. **sidecar 投影**：L1 append 和 flush 成功后才提交 SQLite transaction。事务失败进入 degraded；下一轮采集前必须 catch-up，失败则从 L1 全量重建并原子切换 generation。
4. **本地读取**：Console 使用 HttpOnly 只读 cookie 查询 session、timeline、generation、L1/sidecar watermark、degraded/rebuilding freshness 和 integrity；provider 配置、reconcile、rebuild 与 stop 始终要求 bearer。Host/Origin 必须与当前 daemon authority 精确一致。

## Hosted Console（浏览器入口）

`/console` 页面的 React 组件使用共享 adapter 边界；Hosted 静态产物的
`console-mode.js` 永久把它固定为 Demo 模式。

1. **请求演示视图**：页面按当前 tab 调用 `fetchDashboard`、`fetchSessionDetail` 或 `fetchGlobalAnalytics`。
2. **浏览器内聚合**：Demo adapter 对文件内的样例 sessions/timeline 复制、筛选与聚合，再交还组件渲染。Hosted 脚本不会选择 daemon adapter，因此不会探测或请求 localhost。

## Hosted 文档（静态 route 入口）

Next.js 的 docs/search/LLM routes 通过 `site/lib/source.ts` 读取 `site/content/docs/` 的 MDX 事实源，在 production build 时生成静态页、搜索索引与 `llms*.txt`；运行时不查询 SESDB。
