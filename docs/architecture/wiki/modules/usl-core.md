---
sources:
  - crates/usl-core/src/format.rs 8a9230e382d8 Header encode_frame FORMAT_VERSION
  - crates/usl-core/src/recover.rs af85206e88de recover_from Recovered
  - crates/usl-core/src/store.rs ee1cbe611338 Store append flush verify
  - crates/usl-core/src/identity.rs c9e8baee2266 session_id source_sha256 SessionId
  - crates/usl-core/src/record.rs 7615544f8252 Record StoredRecord
  - crates/usl-core/src/index.rs dfe6668f5f17 Index FrameMeta
  - crates/usl-core/src/error.rs dbab3d8b7001 Error
covers:
  - crates/usl-core/
---

# usl-core：存储引擎

## 职责

一个 schema 无关、append-only、崩溃可恢复的单文件 record 数据库。它只存不透明记录（`seq + session_id + kind + ts + body`），不解读内容——canonical 语义是上层转换层的事。核心命题：**正确性只来自 append log + CRC，不依赖 header/WAL/checkpoint**。

## 对外接口

- `Store::create / Store::open` — 建库/开库（开库时扫帧重建索引、截断撕裂尾），见 `store.rs` 的 `Store`。
- `Store::append(&Record) -> seq` — 追加并分配单调 seq；`Store::flush` — 满 fsync（handoff 导出路径）。
- `Store::scan(session, from_seq) / get(session, seq)` — 按 session 读取。
- `Store::verify(path)` — 只读完整性报告（截断位置）。
- `identity::session_id(harness, native_id, source_sha256)` — 内容寻址的定宽 key（`SessionId = [u8;32]`），见 `identity.rs`。

## 数据怎么流

写入时，一条记录序列化成 payload，`encode_frame` 包成 `[len u32][crc32 u32][payload]` 追加到文件末尾；内存里同时维护 `Index`（session → 帧位置）。崩溃后重开，`recover_from` 从数据区顺序扫帧：长度越界/CRC 不符/半截帧都判为「撕裂」，截断到最后一个完整帧，索引由完整帧重放重建——所以对同一有效前缀，恢复结果逐字节确定。header（64 字节）只是冗余提示，写坏也能从数据区自愈。

## 改动指南

- 改字节布局先看 `format.rs`（`Header`、`encode_frame`、`MAX_FRAME_PAYLOAD`）。动了 header 字段要同步改 `Header::encode/decode`，否则 `store.rs` 的 `flush` 会写出不匹配的 header。
- 改恢复语义看 `recover.rs` 的 `recover_from`——三条截断判定（`len==0`、`len > MAX_FRAME_PAYLOAD`、CRC 不符）是崩溃一致性的命门，动了要跑 `tests/crash.rs`（逐字节切点枚举）和 `tests/determinism.rs`。
- 改 id 语义看 `identity.rs`：`session_id` 用长度前缀哈希身份元组，不是裸 id——这是防跨 harness 同 slug 撞 key 的关键。
- 坑：`read_frame_at` 里每次读都重验 CRC（防读取路径静默损坏）；`encode_frame` 对超长 payload 返回 `Err` 而不是 panic（数据库不能因单条大记录崩）。
- 测试门槛：`cargo test` 必须全绿（32 个，含 crash/determinism/corruption/boundary）。
