---
sources:
  - crates/usl-capture/src/framer.rs cb24316add9c Framer feed finish
  - crates/usl-capture/src/capture.rs 915c0f206d2c CaptureSession KIND_RAW_LINE
  - crates/usl-capture/src/follow.rs ff0d8312aa29 FileFollower poll
  - crates/usl-capture/src/convert.rs 4bcb61943381 ClaudeToPi
covers:
  - crates/usl-capture/
---

# usl-capture：捕获层

## 职责

把「harness 写日志」这个动作变成 usl-core 里的记录。它是 FUSE 挂载的 FUSE-agnostic 替代：harness 写普通文件，这一层负责观测增长、切分完整行、入库，并在读侧做 claude→pi 的转换演示。

## 对外接口

- `FileFollower`（`follow.rs`）— 文件尾随：`poll()` 读出自上次以来的新字节，截断/轮转时重置从头读。
- `Framer`（`framer.rs`）— 增量行分帧：`feed(bytes)` 返回完整行、缓冲半行，`finish()` 取尾部残行。
- `CaptureSession`（`capture.rs`）— 一次捕获会话：`start` 写 header 记录（harness 来源），`write` 逐行入库，`finish` 冲刷尾行 + fsync。
- `ClaudeToPi`（`convert.rs`）— demo 级转换：claude JSONL 行 → 可 resume 的 pi 条目。

## 数据怎么流

harness 把 JSONL 按任意字节块 append 到文件。`FileFollower` 把新增字节喂给 `Framer`，`Framer` 把字节切成完整行（跨块边界的半行会缓冲拼接），`CaptureSession` 把每行包成 `Record`（kind 标记行类型）追加进 usl-core。分帧结果与字节如何切块无关——这是「write() 边界不泄漏进记录」的核心性质。

## 改动指南

- 改分帧逻辑看 `framer.rs`：`feed` 里 `position(b'\n')` 切行、`finish` 用 `mem::take` 取残行。分帧与 chunk 无关的确定性是 `tests/capture.rs` 的 chunking determinism 兜底，动了要跑它。
- 改捕获会话看 `capture.rs`：`KIND_SESSION_HEADER`(0) / `KIND_RAW_LINE`(1) 是临时约定，canonical 层将来会定义正式 event kind。
- 改转换看 `convert.rs`：块级映射（thinking→thinkingSignature、tool_use→toolCall、tool_result→toolResult）集中在 `block_to_pi`。注意未知块要幂等，别二次包裹。
- 坑：live 捕获的 session identity 是个未决问题——`source_sha256` 在流开始时还不存在，当前由调用方传入 `session_id`，见 `capture.rs` 的 `CaptureSession::start` 注释。
- 测试门槛：`cargo test` 21 个全绿（framer 6 + capture 4 + follow 4 + convert 7）。
