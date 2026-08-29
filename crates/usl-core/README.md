# usl-core

**USL — Universal Session Log** 存储引擎（v0 PoC）。schema-agnostic、append-only、崩溃可恢复。

> 孵化位置：e 仓库 `packages/usl-core`。**设计目标是独立数据库**：本 crate 零依赖 e 的任何代码，e 将来通过供应链（cargo crate / napi / wasm / 独立 daemon + wire protocol）消费它。见上游调研 `docs/research/2026-08-universal-session-log-db.md` §6。

## 定位

引擎只存**不透明 record**，不做 envelope 校验——canonical schema 是上层：

```
Record { seq, session_id([u8;32]), kind, ts_ms, body(不透明字节) }
```

- `session_id` 是**内容寻址**定宽 key：`sha256(harness ‖ native_session_id ‖ source_sha256)`（长度前缀），见 `src/identity.rs`。同源幂等、跨 harness 同 slug 不撞。
- 引擎对 `session_id` 只要求「定宽、非零」，不解读其语义。

## 正确性命题

**正确性只来自 append log + CRC**，不依赖 header/WAL/checkpoint：

- 每帧 `[len u32][crc32 u32][payload]`，CRC 覆盖 payload。
- 崩溃恢复 = 顺序扫帧，遇到**撕裂/损坏帧即截断**到最后一个完整帧；索引由完整帧重放重建。
- header 是冗余提示，可从 data 区自愈；`flush()` 按「先 sync 数据、再写 header、再 sync」排序。

由此：**对同一有效前缀，无论后面跟着什么撕裂字节，恢复结果逐字节一致**（`tests/determinism.rs` 逐前缀断言）。

## 字节布局 v0

```
[0..64)   Header: magic "USLDB\0" | version u16 | page_size u32 | flags u32
          | data_end u64 | next_seq u64 | session_count u64 | reserved
          | header_crc u32(covers [0..48)) | reserved
[64..data_end)  帧序列：[len u32][crc32 u32][payload]
```

详见 `src/format.rs` 的文档注释。

## API

```rust
Store::create(path, StoreOpts) -> Store   // 已存在则失败
Store::open(path, StoreOpts) -> Store     // 撕裂尾物理截断
store.append(&Record) -> u64              // 返回分配的单调 seq（无 fsync，group-commit）
store.flush()                             // 满 fsync（handoff 导出路径）
store.scan(&SessionId, from_seq) -> Vec<StoredRecord>
store.get(&SessionId, seq) -> Option<StoredRecord>
Store::verify(path) -> Verification       // 只读完整性报告 + 截断位置
```

## 测试

`cargo test`：32 测试全绿，0 警告。

| 测试文件 | 验证什么 |
|---|---|
| `src/recover.rs`（单测） | 撕裂 payload / 零长度 / 超长长度 / CRC 破坏 / schema 不匹配（loud 报错） |
| `tests/crash.rs` | **对每个字节切点**枚举撕裂帧 → 恢复到最后一个完整帧 |
| `tests/boundary.rs` | 空 body / 4095·4096·4097 / 1 MiB / 跨 64 MiB 数据区不崩 / 超大帧优雅报错不 panic |
| `tests/determinism.rs` | 撕裂写 vs 干净写同前缀 → 恢复状态逐字节一致 |
| `tests/corruption.rs` | payload 位翻转检出+截断 / header 损坏自愈 / 撕裂长度不 OOM |
| `tests/concurrency.rs` | 后续 append 永不改写先前帧（稳定前缀读） |
| `tests/roundtrip.rs` | 多 session append/scan/get/flush/reopen 往返 |
| `tests/identity.rs` + `src/identity.rs` | 同源幂等 / 跨 harness 同 slug 不撞 / 长度前缀防歧义 |

## 出界（v1+ 里程碑）

WAL + checkpoint（大库快开）、segment 轮转、compaction/retention、tamper-evidence hash 链、canonical envelope 层、FUSE live capture、多进程 wire protocol。

## 依赖

`crc32fast`、`postcard`、`serde`、`sha2`（+ 其传递依赖）。无 e 依赖、无 unsafe。
