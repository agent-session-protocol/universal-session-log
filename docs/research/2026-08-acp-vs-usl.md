# ACP（Agent Client Protocol）vs USL 深度分析

> 日期：2026-08-29 · 依据：ACP 官方仓库 `agentclientprotocol/agent-client-protocol`（main，4.1k stars，2026-08-29 推送）+ V2 Draft 公告（2026-07-20）+ v2 schema/文档原文；USL 侧依据本仓库 `docs/architecture` 与各包源码。
> 一句话结论：**ACP 是"实时控制协议"，USL 是"会话日志数据库"——分层不同、互补而非竞争；USL 应当把 ACP 作为第五种 capture mode 接入，并反向提供 ACP agent 适配器当读面。**

---

## 1. ACP V2 是什么（深度解读）

ACP（Agent Client Protocol）回答"**任意编辑器怎么连任意 agent**"。JSON-RPC 2.0 经 stdio 传输，client = 编辑器（Zed/VSCode/…），agent = coding agent（Claude Code/Codex/…）。原 Zed 项目，现迁到中立的 `agentclientprotocol` 组织治理，4.1k stars。

### 1.1 V2 方法面（2026-07-20 Draft）

| 方向 | 方法 |
|---|---|
| Client → Agent | `session/new`、`session/resume`、`session/prompt`、`session/list`、`session/close`、`session/delete` |
| Client → Agent（通知） | `session/cancel` |
| Agent → Client | `session/request_permission`、`elicitation/create` |
| Agent → Client（通知） | `session/update`、`elicitation/complete` |

外加独立扩展：`terminal/*`（PTY）、`plan/*`（计划）、`nes/*`（Notification/Event Stream：文档 open/change/close/save/focus，LSP 风格 position）。

### 1.2 V2 五大主题（与 USL 高度相关）

1. **超越 turn**：`session/update` 可在任意时刻到达；`session/prompt` 的响应只表示"已受理"，不是"turn 结束"；agent 用 `idle` 状态声明"可以接新输入"；**多 client 可观察同一 session**。→ 这正是 USL 事件日志"不按 turn 绑定"的模型。
2. **稳定 ID + 统一 patch 语义**：user/agent 消息、tool call、terminal 输出都用稳定 ID 打补丁——`省略=不变、null=清除、值=替换、chunk=追加`；message ID 必需。→ 对应 USL 的 `entityRevision` + delta 合并。
3. **结构化 diff**：`oldText/newText` 换成结构化文件变更（add/delete/modify/move/copy + 二进制/非文本），可附 `git_patch`。→ USL 的 artifact 层可借鉴。
4. **更灵活的权限请求**：`title` + `description` + 可扩展 `subject`（不再硬绑 tool call）。→ USL 的 approval 事件建模参照。
5. **默认前向兼容**：未知枚举值用 `_` 前缀保留；`Other` content block 明确要求"**receiver 在 store/replay/proxy/forward 时必须保留原始 payload**"。→ 与 USL 的 typed `unknown` block / 不透明负载一字不差地同构。

### 1.3 内容模型（关键分歧点）

V2 的 `ContentBlock` 与 MCP 对齐：`Text / Image / Audio / ResourceLink / Resource / Other`。

**注意：V2 把 "thinking" 从 content block 里移除了**——thinking 现在降级为 session config option（`thought_level`）+ usage 指标（`thought_tokens`），不再是一等 content block。这对 USL 是个重要信号：ACP 的视角里 thinking 是"配置 + 统计"，不是"需要保真往返的内容"；而 USL 恰恰把 thinking（带 `signature`）当作 resume 关键的一等块。

tool call 侧有 `ToolCallStatus` + `ToolCallContentChunk`（流式内容块）+ 结构化 `Diff`，语义丰富。

---

## 2. 定位区别

| 维度 | ACP（V2） | USL / SESDB |
|---|---|---|
| **本质** | 实时**控制协议**（wire protocol） | **会话日志数据库**（storage + 转换） |
| **回答的问题** | 编辑器怎么实时驱动一个 agent | 会话怎么持久、回放、跨 runtime 迁移 |
| **数据流向** | editor ↔ agent 的双向 live 流 | harness 日志 → 统一存储 → 任意 harness 可 resume 的产物 |
| **持久化** | 无（session/resume 依赖 agent 自己还留着会话） | 一等（append-only + CRC + 崩溃恢复） |
| **跨 runtime** | 连"任意编辑器到任意 agent"，但**不跨**——resume 只在同一 agent 内 | 一等（pi/dimagent/claude/codex 四路互转已实测） |
| **保真声明** | 无（`Other` 块"应保留"是建议） | 强（fidelity 矩阵 + loss 声明 + evidence 逐字还原） |
| **时间轴** | 只关心"当下" | 关心"完整历史 + 血缘 DAG" |
| **治理/生态** | 中立组织、4.1k stars、SDK、编辑器集成 | 单一实现、无生态 |

**类比**：ACP 是"对话的 WebSocket"，USL 是"对话的数据库 + 格式转换器"。ACP 管"这一刻怎么交互"，USL 管"整个对话怎么存、怎么搬到另一个 agent 手里接着跑"。

---

## 3. 优缺点（双向）

### 3.1 ACP 相对 USL 的优势

1. **生态与治理**：中立组织、多厂商、4.1k stars、官方 SDK + 编辑器落地——USL 是单点实现，没有生态。
2. **实时控制完整**：prompt/steer/cancel/permission/elicitation/plan/terminal 一应俱全——USL 没有任何"驱动运行中 agent"的面。
3. **MCP 对齐**：ContentBlock 复用 MCP schema，与工具生态天然打通——USL 的 canonical 块是自定的。
4. **前向兼容的 `Other` 块**：与 USL 的 unknown 块同构，但它是"协议级规范"，USL 是"实现约定"。

### 3.2 ACP 相对 USL 的短板

1. **无持久化/恢复语义**：崩溃、重启、跨机迁移、审计、分析——ACP 一概不管；USL 有 CRC + 截断恢复 + 确定性 replay（32 测试背书）。
2. **不跨 runtime**：`session/resume` 只对"还支持 ACP、还留着会话"的同一个 agent 有意义；claude 会话转成 codex 可 resume 的产物，ACP 完全不做。USL 这是北极星。
3. **thinking 降级**：V2 把 thinking 移出 content block——对"resume 需要 thinking signature"的场景是退步；USL 把 thinking+signature 当一等块保真往返。
4. **无 provenance/保真度**：没有 evidence 层、source hash、fidelity 矩阵；"这条消息来自哪个 harness、保真度多少"无从谈起。
5. **display 导向**：ContentBlock 是"可展示信息"，不是"可 resume 的最小集"；opaque 负载（encrypted_content 等）只能塞进 `Other` 被动保留。

### 3.3 USL 相对 ACP 的短板

1. **无实时控制**：不能 prompt/steer/abort 一个运行中的 agent。
2. **无生态**：没有编辑器集成、没有多厂商、没有中立治理。
3. **live capture 受环境所累**：当前走文件边界（FUSE 在 macOS 26 不可用），没有协议级的原生捕获入口。

---

## 4. SESDB 如何集成兼容 ACP

**核心判断：ACP 是 USL 缺的那个"live front"，USL 是 ACP 缺的那个"durable back"——互相补位，不互相替代。** 三个集成方向：

### 4.1 方向一：ACP tap = 第五种 capture mode（写路径）

USL 的 capture 矩阵（§5.1）目前是：offline import / 文件边界 / FUSE / 原生插件 API。**加一种"ACP tap"**：一个 USL ingestor 充当 ACP client，订阅任意 ACP agent 的 `session/update` 通知，把 ACP 内容块映射成 USL canonical record，append 进 usl-core。

这是**最优的 live capture**：harness 中立（任何说 ACP 的 agent 都行）、语义级（不用解析文件格式）、无 FUSE/特权问题——直接替代"原生插件 API"模式，且覆盖面更广。

### 4.2 方向二：USL 提供 ACP agent 适配器（读路径）

反向：USL 实现一个 ACP **agent** 面，把 usl-core 里存的会话历史经 `session/resume` + `session/update` 重放出去。这样任意 ACP 编辑器（Zed/VSCode/…）就能**渲染/续跑一个 USL 存下的会话**——即使原 harness 已经不在。这正是 USL"统一历史渲染"北极星的协议化出口。

### 4.3 方向三：内容模型对齐（canonical 映射）

| ACP ContentBlock | USL ContentBlock | 备注 |
|---|---|---|
| `Text` | `text` | 直映射 |
| `Image` / `Audio` | `image`（audio 用 `unknown` 或扩展） | 直映射 |
| `ResourceLink` / `Resource` | `reference` | 直映射 |
| `Other`（`_` 前缀未知） | `unknown`（typed nativeType） | **双方都要求 opaque passthrough，语义一致** |
| （无 thinking 块） | `thinking`(+signature) | **分歧点**：USL 保留为一等块，ACP 里只能塞 `Other` 或丢 |
| `ToolCall*` | `tool-call` / `tool-result` | 映射到 tool 事件 + 工具实体 |

关键：**ACP 的 patch 语义（省略/null/值/chunk-append）正好落到 USL 的 `entityRevision` + delta 合并**；ACP 的"超越 turn + 多 client 观察"正好落到 USL 的 append-only 事件日志 + snapshot/cursor。两者的事件模型已经同构，映射成本低。

### 4.4 集成后的架构

```
ACP agent（claude/codex/…）──session/update──▶ USL ACP-tap ingestor ──▶ usl-core
                                                      │
ACP editor（Zed/VSCode/…）◀──session/update replay── USL ACP-agent adapter ◀── usl-core
                                                      │
                              （同一份 append-only 证据 + fidelity 矩阵）
```

ACP 负责"这一刻的实时交互"，USL 负责"整段历史的持久、血缘、跨 runtime 迁移"——编辑器通过 ACP 看实时，通过 USL 看历史/续跑。

---

## 5. 风险与未决

1. **V2 是 Draft**（2026-07-20），schema 未冻结——接入要 gate 在版本协商 + feature flag 后，别默认上生产。
2. **thinking 建模分歧**：ACP V2 移除了 thinking content block，USL 却依赖它保真 resume（`signature`）。若走 ACP tap，thinking 只能进 `Other` 块被动保留——**这是需要显式决策的保真度折损点**。
3. **transports**：ACP 目前 stdio 为主，transports 工作组在扩（多 client 观察同一 session 需要非 stdio 传输）；USL 的 ACP tap 需支持对应 transport。
4. **会话身份**：ACP `SessionId` 是 agent 自定字符串，USL 是内容寻址 `[u8;32]`——映射需要一张 (ACP session id → USL session_id) 表，且要放进 USL 的 lineage DAG（ACP resume = USL 的 `resume` relation）。
5. **治理不对称**：USL 单点、无治理；若真把 ACP 当 capture 标准，长期应考虑与 ACP 生态对齐（甚至 USL 的 canonical 层直接复用 MCP/ACP 的 ContentBlock 命名，少一套自定映射）。

---

## 6. 建议的落地顺序

1. 先做**方向三的映射表**（内容块 + patch 语义 → entityRevision）——纯文档/类型层，成本最低、立即复用。
2. 再做**方向一 ACP tap**（写路径）：拿一个真支持 ACP 的 agent 抓 `session/update`，验证"ACP 内容块 → USL record"的无损性（重点验证 `Other` 块 opaque passthrough 与 thinking 折损）。
3. 最后做**方向二 ACP agent 适配器**（读路径）：把 usl-core 存的会话经 ACP 重放给编辑器，完成"USL 存、编辑器看/续"的闭环。
