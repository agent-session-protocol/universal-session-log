# usl-capture

**USL capture 层**：把 append-only 字节流变成 usl-core 里的 record。**FUSE-agnostic**——FUSE 挂载只是这层之上的薄适配器。

```
harness 写普通 JSONL 文件（任意 chunk 边界）
        │
        ▼
FileFollower：文件尾随（轮询新字节，处理截断/轮转）─── FUSE-less 的 write 拦截替代
        │
        ▼
Framer：增量行分帧（缓冲半行，跨 write() 边界拼接）
        │
        ▼
CaptureSession：完整行 → Record{kind, body} → usl-core append
        │
        ▼
usl-core（存储） ──▶ ClaudeToPi（读侧转换：claude JSONL → 可 resume 的 pi JSONL）
```

## 核心性质

**分帧与字节如何切块无关**：`"a\nb\nc"` 一次喂、逐字节喂、行中间断开喂，产出的完整行序列**完全一致**（`tests/capture.rs` 的 chunking determinism）。

这对应研究文档 §5.2 的「write() 即事件边界」：harness 一次 `write()` 不等于一条完整 JSONL 记录，Framer 负责把任意 write 边界归一到「完整行」这个语义边界。

## Record 约定（provisional）

| kind | 含义 | body |
|---|---|---|
| `0` | session header | JSON `{"harness","native_session_id","started_at_ms"}`（provenance） |
| `1` | 原始 JSONL 行 | 行字节（不含换行） |

> 这些 kind 常量是捕获层的临时约定；canonical 层（未来里程碑）会定义正式的 event kind 语义。引擎（usl-core）对 kind 不解读。

## 未决设计点

**live capture 的 session identity**：离线 import 的 `session_id = sha256(harness‖native_id‖source_sha256)` 依赖「整文件哈希」，但 live 流开始时 source 还不存在。当前 `CaptureSession` 由调用方传入 `session_id`（FUSE 层决定如何派生）。候选方案（待定）：用 `(harness, native_id, 挂载点 + 文件路径 + 启动 nonce)`，或对同一 harness session 的多次 live capture 用「capture instance id」区分。见研究文档 §9。

## 测试

`cargo test`：21 测试全绿，0 警告。

- `framer`：chunking 无关、尾部半行缓冲、CRLF、空行分帧（不过滤）、超长半行报错
- `capture`：chunking determinism（行序列一致）、header provenance、空行跳过、尾部半行 flush、write 返回计数
- `follow`：tail 只读新字节 / from_start 重放+尾随 / 无新数据返回空 / 截断重置
- `convert`：user/assistant 消息映射、thinking signature→thinkingSignature、tool_use→toolCall、tool_result→role toolResult、id/parent 链、未知类型跳过并声明 loss

## Demo（文件边界 live capture + 转换）

```bash
cargo run --example live_convert
```

模拟 harness 把 claude JSONL 按 17 字节一块流式写入普通文件 → `FileFollower` 观测增长 → `CaptureSession` 分帧入库 → `ClaudeToPi` 转换出可 resume 的 pi JSONL。这是 FUSE 挂载在 macOS 26 不可用（见 `docs/research/2026-08-macos-fuse-landscape.md`）时的等价验证路径。

## 依赖

`usl-core`（path）、`serde_json`。无 e 依赖、无 unsafe。
