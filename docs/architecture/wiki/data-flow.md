---
sources:
  - packages/usl-convert/src/cli.ts 8f3801f3160e importCodexSessionFile exportCodexSession
  - crates/usl-capture/src/follow.rs ff0d8312aa29 FileFollower poll
  - crates/usl-core/src/store.rs ee1cbe611338 append flush
---

# 数据流

系统有三个真实入口：离线转换 CLI、live 捕获 example、存储 append/recover。下面按入口各铺一条端到端路径。

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
