# USL — 通用 Agent Session Log 数据库设计调研

> 日期：2026-08 · 状态：调研稿（含 spike 实测）
> 调研分支：`research/universal-session-db`（worktree `SESDB`）
> 关联资产：`packages/e-core/src/agent-session*.ts`、`packages/e-session-convert/`、`packages/e-pi-adapter/`

## 1. 问题定义与北极星

**USL（Universal Session Log）** 要回答的问题：如何设计一款**适配所有 agent runtime 的 session log 数据库**——它不是某个 harness 的内部存储，也不是某个 ADE 产品的附属组件，而是一个独立的数据库系统：

- 一个**特殊进程**（daemon），用**私有存储格式**保存数据，实现数据库特性（WAL、索引、查询、恢复、一致性）；
- 以**数据库项目的工程标准**要求它（认真评估 Rust/Go 等实现语言，见 §6），而非"给 TS 项目挑一个嵌入式库"。

**北极星场景 = resume / fork / handoff**，统一定义：

> **handoff**：把 harness A 产出的 session S，导出为 harness B **能原生 resume** 的产物（A 与 B 可以相同），且转换中的保真度是**声明式、可校验**的。

与北极星并列第一的是**统一历史渲染**（任意 harness 的 session 都能投影成同一份结构化 Chat read model）。二者共享同一条数据管线：读模型是 handoff 的"预览"，handoff 是读模型的"导出"。

**副产品**（不为它们单独优化，只留接口）：usage/cost 分析、审计合规、评测/训练数据导出。

### 1.1 为什么现有东西不够

| 方案 | 定位 | 缺什么 |
|---|---|---|
| e-core `AgentSessionService` | 单 daemon 内、pi 单 harness 的 live evidence store | 不是独立产品；单 JSONL 文件 + 全量 replay，不是数据库；只为 live ingest 设计 |
| e-session-convert | 离线 pi↔dimagent 批转换 | 无存储层（bundle 是文件不是 DB）；只有 2 个 harness |
| OTEL `gen_ai.*` | 观测 ingest 标准 | 面向 trace/metrics，无 resume 语义，无不透明负载往返（见 §3） |
| Langfuse/LangSmith | SaaS 观测/评测 | 数据进 SaaS，不产出"harness 可 resume 的会话" |
| OpenHands/SWE-bench trajectory | 评测数据集格式 | 静态快照，无 live、无血缘、无互操作 |

**空档**：以 **resume-handoff 保真度**为一等目标的、runtime 中立的 session log 数据库，目前不存在。

## 2. Runtime 格式盘点（本机真实样本实测）

> 盘点方法：直接读取本机真实 session 数据（只读；SQLite 类用 WAL-copy：复制 `.sqlite`+`-wal`+`-shm` 到临时目录后打开副本，源文件字节级校验不变）。每行论断都可追溯到下方引用的样本。

### 2.1 总览表

| Harness | 载体 | 组织 | 事件粒度 | 会话间血缘 | resume 关键负载 |
|---|---|---|---|---|---|
| **pi** | `~/.pi/agent/sessions/<cwd编码>/<ts>_<id>.jsonl` | 单文件树状 entry（`id`/`parentId`），`session` header 开头 | message 级（无 token 流） | `session.previousSessionFile`（fork/compact 链） | entry 树完整性 + header；compaction entry 引用 `firstKeptEntryId` |
| **Claude Code** | `~/.claude/projects/<cwd编码>/<uuid>.jsonl` | 单文件链式 entry（`uuid`/`parentUuid`），`isSidechain` 标 sub-agent | message 级 | sidechain（文件内分支）；跨文件无显式链 | **thinking `signature`**、tool_use `id`、`model`/`version` |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | 单文件**双流**：`response_item`（协议真源）+ `event_msg`（UI 流）+ `turn_context` | item 级 + 事件级 | `session_meta.id`；`turn_aborted` | **reasoning `encrypted_content` 不透明 blob**、`call_id` 配对、全序 response_items |
| **opencode** | `~/.local/share/opencode/opencode.db`（WAL）+ `snapshot/` git 裸仓库 | 关系表 `session/message/part`（`data` 列为 JSON）+ **自身即事件溯源**（`event`/`event_sequence`） | part 级（text/reasoning/step-start/step-finish/tool） | `session.parent_id`（sub-agent）；`revert`、`time_compacting` 标记 | message.part 全集 + git snapshot 引用 |
| **dimagent** | `~/.dimcode/v2/dimcode.sqlite`（WAL） | 关系表 `sessions/messages(parts JSON)` + 专用血缘/压缩/用量表 | part 级（text/thinking/tool_use/tool_result） | **`session_relations` 显式 DAG**（`branch`×4 / `subagent`×13 实测） | parts 全集 + `compaction_states` 游标 |

实测数据规模（本机）：pi 61 个 session 目录、`message`×57331/`compaction`×24；claude 30 个项目、最大文件 200KB+；codex rollout×5（2025-09）；opencode message×22/part×21/event×102；dimagent sessions×38、parts 分布 text×2967/thinking×2223/tool_use×7029/tool_result×7027。

### 2.2 pi（`~/.pi/agent/sessions/`）

Entry 类型实测（全量 61 目录统计）：`message` 57331、`custom` 1102、`model_change` 1055、`thinking_level_change` 639、`session` 327、`custom_message` 130、**`compaction` 24**、`session_info` 9。

-  linkage：`id`/`parentId` 构成树（branch 由树分叉表达）；`session` header 带 `cwd`、`version`。
- `message.message` 载荷键：`api/provider/model/responseId/role/content/stopReason/rawStopReason/usage/errorMessage/timestamp` —— model/usage/stopReason 都是一等字段。
- `compaction` entry：`{firstKeptEntryId, summary, tokensBefore, usage, details, fromHook}` —— **pi 原生有 compaction，且 compaction 是树内的一个 entry 类型**（不是外部操作）。
- resume 语义：pi resume = 找到文件、按 `parentId` 树重建上下文；e-session-convert 的 pi exporter 已验证"导出文件可被 pi 原生 resume"。

### 2.3 Claude Code（`~/.claude/projects/`）

Entry 类型实测（6 个大文件聚合）：`assistant` 297、`user` 166、`attachment` 18、`custom-title` 14、`last-prompt` 13、`ai-title` 13、`queue-operation` 8、`mode` 4。

- linkage：`uuid` + `parentUuid` **单链**（树退化为链，分叉开新文件）；`isSidechain: true` 标记 sub-agent（Task tool）消息——**sub-agent 会话与主会话同文件、以 sidechain 维度区分**。
- user entry 富元数据：`cwd/gitBranch/entrypoint/userType/version/permissionMode/promptId/promptSource/sourceToolUseID/sourceToolAssistantUUID/isMeta/origin`。
- assistant `message`：`content[]`（`text`/`thinking`/`tool_use`）+ `model` + `stop_reason/stop_details` + **极丰富 `usage`**（`input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens/service_tier/inference_geo/speed`…）。
- **thinking block 携带 `signature`**（实测键 `["signature","thinking","type"]`）——Anthropic API 侧 resume 时需要原样回传校验。
- `tool_result` 嵌在 **user** entry 的 `message.content[]`（`tool_use_id` 回指 + `is_error` + `content` 可为 string 或 blocks）；entry 顶层还冗余一份 `toolUseResult`。
- `attachment` entry 独立成行（图片/文件引用），与消息流并列。

### 2.4 Codex CLI（`~/.codex/sessions/`）

实测 5 个 rollout 文件（2025-09，cli 0.36.0）聚合：`turn_context` 204、`token_count` 185、`reasoning` 180、`agent_reasoning` 180、`function_call`/`function_call_output` 各 160、`message` 64、`user_message` 32、`agent_message` 26、`session_meta` 5、`turn_aborted` 4。

- record 统一 `{timestamp, type, payload}`；`type ∈ {session_meta, response_item, event_msg, turn_context}`。
- **双流语义**：`response_item` 流是 OpenAI Responses API 协议真源（`message`/`reasoning`/`function_call`/`function_call_output`），`event_msg` 流是 TUI 渲染流（`user_message`/`agent_message`/`agent_reasoning`/`token_count`/`turn_aborted`）——**同一逻辑事件出现两次，导入时必须去重归一**（以 response_item 为权威，event_msg 补充 token_count）。
- **`reasoning.encrypted_content` 是不透明加密 blob**（实测 ~1KB base64），附带明文 `summary[]`；**handoff 到 codex resume 时必须原样往返**（OpenAI 服务端校验链）。
- `function_call.call_id` ↔ `function_call_output.call_id` 配对；`turn_context` 记录每 turn 的 `cwd/approval_policy/sandbox_policy/model`。
- `session_meta`：`{id, cwd, cli_version, model_provider, originator, instructions, timestamp}`。

### 2.5 opencode（`~/.local/share/opencode/`）

- **SQLite(WAL) 关系模型**：`session(id, project_id, parent_id, title, cost, tokens_*, revert, time_compacting, agent, model, …)`、`message(id, session_id, data JSON)`、`part(id, message_id, session_id, data JSON)`。
- `message.data` 实测：`{role, parentID(消息链), agent, mode, path{cwd,root}, cost, tokens{input,output,reasoning,cache{read,write}}, modelID, providerID, time{created}}`。
- `part.data` 的 `type` 实测：`text`/`reasoning`/`step-start`/`step-finish`（其余安装中还会有 `tool` 等）——**step 边界是一等 part 类型**。
- **opencode 自身就是事件溯源**：`event(aggregate_id, seq, type, data)` + `event_sequence` 表（102 条实测）——USL 导入时可选"读投影表"还是"重放 event 表"两条路径。
- **文件快照用 git 裸仓库**（`snapshot/<commit>/objects`）：内容寻址的文件状态，与消息流正交——USL 的 artifact 层可借鉴。
- sub-agent：schema 有 `session.parent_id`（本机样本为空）；compaction：`session.time_compacting` 标记。

### 2.6 dimagent（`~/.dimcode/v2/dimcode.sqlite`）

- `sessions(sessionId, cwd, title, status, version[乐观锁], …)`、`messages(messageId, sessionId, role, parts JSON, attachments, toolMetadata, metadata, orderKey, createdAt/updatedAt)`。
- `parts` 实测 type 分布：`text`/`thinking`/`tool_use`/`tool_result`；`orderKey` 提供全序。
- **`session_relations(relationId, sourceSessionId, targetSessionId, relationType, typeData, createdAt)`**：实测 `subagent`×13（typeData 带 `parentRunId/parentToolCallId/subagentType`）、`branch`×4——**五个 harness 中唯一把血缘建成显式表**的，是 USL lineage DAG 的直接形态参照。
- `compaction_states(sessionId, cursor, compactionSegments, checkpoints)`：压缩状态机外置；`file_checkpoints`、`usage_ledger`（逐条用量流水）等专用表。
- e-session-convert 已有 importer/exporter（详见其 README 的 fidelity 矩阵）。

### 2.7 横向结论（盘点 → 设计要求）

1. **不透明负载一等化**：claude `signature`、codex `encrypted_content` 不能解析但必须往返 → envelope 需要 opaque passthrough block（§4.2）。
2. **session 是 DAG 不是平表**：pi 树内分叉、claude sidechain、opencode `parent_id`、dimcode `session_relations` → USL 显式建模 lineage DAG（§4.3）。
3. **compaction 是一等领域事件**：pi（树内 entry）、opencode（`time_compacting`）、dimcode（`compaction_states`）三家都有 → envelope 缺 `compaction.*` 事件是实测缺口（§4.2）。
4. **usage 粒度差异巨大**：claude 逐消息含 cache 细分、codex 逐事件 token_count、opencode/dimcode 冗余在 session/ledger → usage 只能 evidence-only 对齐，canonical 层做可选投影。
5. **存储载体二分**：append-only JSONL（pi/claude/codex）vs SQLite WAL（opencode/dimagent）——直接决定 capture mode 矩阵（§5）。
6. **目录可重定向性**（FUSE/托管方案的前提）实测：

   | Harness | 重定向机制 | 证据 |
   |---|---|---|
   | pi | `PI_CODING_AGENT_DIR` | e 项目 spike 测试长期使用 |
   | claude | `CLAUDE_CONFIG_DIR` | 二进制 strings×24 |
   | codex | `CODEX_HOME` | 原生二进制 strings×68（含 `failed to resolve CODEX_HOME` 错误串） |
   | opencode | `XDG_DATA_HOME`/`XDG_CONFIG_HOME` | JS bundle 中 `process.env.XDG_DATA_HOME` 直接引用 |
   | dimagent | **未发现 env override**，固定 `~/.dimcode/v2` | binaries strings 无命中 → 需 symlink/bind/FUSE-overlay |

## 3. 外部标准与参照

### 3.1 OTEL Generative AI Semantic Conventions（1.44.0 registry 实测）

- 模型：**span**（`chat`/`invoke_agent`/`create_agent`/`execute_tool` 等 `gen_ai.operation.name`）+ **event**（input/output messages、choice）+ **attribute**（66 个 `gen_ai.*` 属性实测，含 `gen_ai.conversation.id` 会话相关、`gen_ai.agent.{id,name,version}`、`gen_ai.request/response.*`、`gen_ai.usage.*` token 属性、`gen_ai.tool.call.id`）。
- 目标：异构系统 → 观测后端的**传输与聚合**，message 以 JSON attribute/event body 携带。
- **与 USL 的差异**：无 resume 语义（不保留 signature/encrypted_content 这类"回传校验"负载）、无血缘 DAG、无本地持久化/恢复语义；`gen_ai.input.messages`/`output.messages` 是采样性 attribute 而非完备日志。**可借鉴**：属性命名空间、`conversation.id` 相关性键；USL 可提供一个 OTEL exporter 作为副产品接口（e-session-convert roadmap 已预见到这一点）。

### 3.2 Langfuse / LangSmith（SaaS 观测）

- Langfuse 三层：**Session > Trace > Observation**（observation = span/generation/event；generation 挂 model/usage/cost）。LangSmith：**Run 树**（run_type: llm/chain/tool/retriever/prompt）+ sessions + feedback。
- 与 USL 的差异：数据进 SaaS 供人观测/评测，**不以导出 harness 可 resume 会话为目标**；其 session 是"分析分组"而非"可执行上下文"。**可借鉴**：trace→observation 的树形投影、cost 聚合方式（副产品场景）。

### 3.3 ACP（Agent Client Protocol，Zed 系）

- 编辑器↔agent 的 **live JSON-RPC 协议**：`session/new`、`session/prompt`、`session/update` 通知携带结构化 content block（text/thinking/tool_call/plan…）。
- 与 USL 的差异：是**在线协议**不是持久格式；但它是"统一历史渲染"所需 content block 分类法的独立佐证（与 e `ContentBlock` 高度同构）。若未来 ACP 普及，USL 的 capture 层可增加 "ACP tap" mode。

### 3.4 评测 trajectory 格式

- OpenHands trajectory（step 序列：action/observation）、SWE-bench 提交格式、terminal-bench（asciinema cast + agent log）。
- 与 USL 的差异：静态、单 harness、无 live、无血缘。是 USL 的**导出目标**（副产品），不是设计输入。

### 3.5 小结

没有任何现有标准以"跨 runtime resume-handoff 保真"为目标；观测系标准（OTEL）解决的是"看"，trajectory 解决的是"评"，harness 原生格式解决的是"自己能 resume"。**USL 的空档 = 以 handoff 保真为一等目标的存储与互操作层。**

## 4. 核心设计（北极星 = handoff/resume + 统一渲染）

### 4.1 三层存储模型

```text
┌─ L0 raw blob 层：content-addressed，保留 harness 原生字节 ────────┐
│  import 即快照（copy-on-write，源文件不变量）；sha256 寻址，可去重 │
└───────────────────────────────────────────────────────────────────┘
              │ 每 harness 一个 parser（importer）
              ▼
┌─ L1 canonical event log：统一 envelope，append-only ─────────────┐
│  权威真源（WAL 角色）；可选 hash 链/Merkle tamper-evidence        │
│  不透明负载以 typed unknown block 一等保留（见 4.2）              │
└───────────────────────────────────────────────────────────────────┘
              │ 可随时重建（materializer）
              ▼
┌─ L2 projections（读模型，可丢弃重建）──────────────────────────┐
│  chat 渲染视图 / resume-export 视图 / 分析副本（DuckDB 只读）    │
└───────────────────────────────────────────────────────────────────┘
```

- **L0** 存 harness 原生字节（源 JSONL、SQLite 副本、附件、文件检查点），content-addressed，import 幂等（同一文件 → 同一 `sourceSha256` → 同一事件 id）。这一层直接继承 `e-session-bundle` 的 copy-on-write 决策与 opencode「git snapshot 做文件状态」的现成模式。
- **L1** 是数据库的**唯一持久化真源**：事件日志即数据库。索引与投影全部可由 L1 重放重建（e-core 已证明「重启 replay → 相同 projection」）。
- **L2** 为读模型，永不回写 L1；handoff 导出从 L1 + L0 拼装，不依赖 L2 的中间态。

### 4.2 统一 envelope 及其缺口（spike 实测）

以 `AgentEventEnvelope`（27 种 event type + correlation + authority/confidence）为种子，spike 把 pi/claude/codex/dimagent 四路真实数据压进去后，**四个已证实的缺口**：

1. **compaction 不是边缘情形，是一等领域事件**：pi 树内 `compaction` entry、opencode `time_compacting` 列、dimcode `compaction_states` 表——三家都有。envelope 缺 `compaction.*` 事件，当前只能落入 `unknown.observed`。**需新增**：`compaction.started/completed`（携带 `firstKeptEntryId`/`segments`/`cursor`），且 compaction 在 canonical 层应产生「旧消息被引用替换」的显式边界，而不是静默截断。
2. **subagent 血缘缺一等表达**：claude `isSidechain`、opencode `session.parent_id`、dimcode `session_relations(subagent)` 都表明 sub-agent 是原生存在。envelope 的 correlation 只有 `parentId`，无法表达「spawn 自某个 tool call 的独立 session」——这恰好落在 4.3 的 lineage DAG 上，而非 correlation 字段上。
3. **usage 粒度不可统一，只能 evidence-only 对齐**：claude 逐消息 cache 细分 usage、codex 逐事件 `token_count`、opencode/dimcode 冗余在 session 行/ledger 表。canonical 层做「可选 usage 投影」，不做逐 token 事件（那是分析副本的职责）。
4. **不透明负载必须一等化（本次最硬发现）**：
   - claude thinking 的 `signature`、codex reasoning 的 `encrypted_content`（实测 ~1KB base64）是「不可解析、必须原样往返」的字节——normalize 即丢 resume 能力。
   - 现有 typed `unknown` block（`{type, nativeType, value}`）是正确容器，但 spike 发现 **e-core `normalizeContent` 会把已经是 canonical 的 unknown block 二次包裹**（`nativeType` 被覆盖为 `"unknown"`），已在本分支修复（`agent-session-materializer.ts`），并作为上游候选提交。
   - 结论：envelope 需要一个**显式的 opaque block 语义**（`{type:"opaque", nativeType, digest, bytes/ref}`），与 `unknown`（「不认识但想尽力渲染」）区分——opaque 声明「这是必须原样往返、禁止重编码的负载」。

### 4.3 Session lineage DAG（handoff 的地基）

session 不是平表。五种 runtime 的原生血缘：pi 树内分叉、claude `isSidechain`、codex `turn_context` 序列、opencode `session.parent_id`、**dimcode `session_relations`（实测 `branch`×4 / `subagent`×13）**——dimcode 已经是显式 DAG，直接给出可推广形态：

```
relation { id, sourceSessionId, targetSessionId, type, typeData, createdAt }
type ∈ { fork, resume, handoff, subagent, compact }
```

- **fork**：同一会话分叉出两条线（pi 树分叉、dimcode `branch`）。
- **resume**：同一 harness 内继续（pi `previousSessionFile`）。
- **handoff**：**跨 harness** 导出→导入，USL 的核心动词。handoff 会**新建一个 session**（记录 `handoff` relation 指向源 session），**不伪装成同一 session**——因为 harness B 对上下文的理解与 A 不同，伪装会破坏溯源。
- **subagent**：dimcode `typeData{parentRunId,parentToolCallId,subagentType}` 已给出「spawn 自哪个 run 的哪个 tool call」的精确形态。
- **compact**：compaction 产生的「旧 session → 新 session」血缘（与 4.2-1 的 compaction 事件配套）。

### 4.4 Resume-target profiles（per-harness resume 最小集）

handoff 保真 = 导出器知道「目标 harness resume 需要哪些字段」。spike 实测出的最小集：

| 目标 harness | resume 必需（否则无法原生 resume） | spike 验证 |
|---|---|---|
| pi | entry 树（`id`/`parentId`）+ `session` header（cwd/version） | claude→pi 导出→re-import 0 loss |
| Claude Code | `uuid`/`parentUuid` 链 + thinking `signature` + tool_use `id` | signature 进 canonical thinking block（preserved） |
| Codex | `response_item` 全序 + `encrypted_content` 原样 + `call_id` 配对 | 99 个 blob 原样保留（passthrough） |
| opencode | message/part 全集 + git snapshot 引用 | 未做 exporter（后续路线） |
| dimagent | `parts` 全集 + `compaction_states` 游标 | 已有 exporter |

导出器按 profile 校验：缺了必需字段 → **拒绝导出**（而非静默降级）；非必需字段 → 声明 loss。这是「declared fidelity」从记录升级为**门控**。

### 4.5 Identity 与幂等

- `sourceSha256` 固定源文件 → 同一文件 re-import 得到同一事件 id（spike 已测：claude/codex 两次导入 eventId 完全一致）。
- 事件 id = `im:stableId(sessionId, nativeEventId | 序位, type)`（`evidence.ts` 既有方案，已验证）。
- 跨 harness handoff 是**新 identity + `handoff` relation**，源 identity 永不变。
- 事件 id 全局幂等：重放/重复 delivery 用 eventId 去重（e-core `eventIds` 表已验证的机制）。

### 4.6 安全与隐私（ingest 边界）

- **脱敏在 ingest 边界**，不在存储层：importer 解析时对 secret/绝对路径/PII 做脱敏后再入 L1（`sanitize-capture` 雏形可复用）。注意：L0 raw blob 保留原生字节用于 resume，因此 L0 必须独立加密/加 ACL，不能与「已脱敏」的 L1 混放。
- **at-rest 加密**：L0（含 signature/encrypted_content 等敏感原始负载）按 session 加密；L1 可选整库加密。
- **0600 + secret-free 日志**：继承 e-core 的路径（tamper → quarantine + degraded）。

## 5. Capture 与 live adapter（FUSE 论证）

### 5.1 Capture mode 矩阵

| mode | 适用 | 延迟 | 完整性 | 代价 | 结论 |
|---|---|---|---|---|---|
| offline import | 全部（基线） | n/a | 强（copy-on-write 快照） | 无 live | 永远可用 |
| fs watch + tail | append-only JSONL（pi/claude/codex） | 秒级 | **有竞态**（rename/截断/回滚/漏事件） | 低 | 不推荐作为唯一手段 |
| **FUSE 托管目录** | append-only JSONL | write() 级 | 强（write 即事件边界） | 高（见 5.2） | 通用兜底 |
| WAL 轮询快照 | SQLite harness（opencode/dimagent） | 秒~分钟 | 强（事务边界）但非实时 | 中 | 必须（FUSE 对 SQLite 只能看到 page 写） |
| 原生插件 API | pi（确有 extension API） | 实时 | 最强（语义级） | per-harness 定制 | 有则优先 |

**结论：混合架构**——per-harness 声明 capture mode；offline import 是恒基线，FUSE 是 append-only 文件类 harness 的通用 live 兜底，WAL 轮询覆盖 SQLite 类，原生插件 API 在可用时取代前三者。

### 5.2 FUSE 为什么值得（以及它的边界）

FUSE 相比 watch+tail 的**增量收益**：

1. **write() 即事件边界**：一次 `write(2)` 调用 = 一条完整 JSONL 记录（harness 每 flush 一条 entry），不需要自己做「行是否写完」的猜测，天然无半行竞态。
2. **可耦合 fsync 与 DB append 的持久化次序**：把「harness 认为已持久化」与「USL 已追加到 L1」对齐 → 给 harness 诚实的背压（对 resume-handoff 这个北极星，这是「harness 认为 durable ≠ 数据库 durable」的唯一干净解法）。
3. **可观测 rename/unlink/truncate**：harness 的「换文件」「fork 新文件」「compact 截断」动作都是血缘信号，watch+tail 容易漏。

**边界（必须写进设计，否则是幻觉）**：

- FUSE 是**旁路镜像，不是过滤器**：harness 读回自己的文件必须字节一致，否则 resume 损坏。脱敏只能发生在 DB 副本上，不能发生在 passthrough 路径。
- **SQLite 不适用**：FUSE 只能看到 page 级写，无法拼出逻辑记录；opencode/dimagent 走 WAL 轮询（`e-session-convert` 的 WAL-copy 已是现成范式）。
- **平台代价**：
  | 方案 | 机制 | 代价 |
  |---|---|---|
  | macFUSE | kext | 需用户授权；Apple Silicon kext 摩擦大；本机已装（`/Library/Filesystems/macfuse.fs` + libfuse2/3） |
  | FUSE-T | NFSv4 loopback 服务，无 kext | 元数据密集操作慢，但 append 文件场景足够 |
  | Linux fanotify | 通知 + 权限门 | **只能通知/阻断，不能拦截改写数据** → 不适合托管 |
  | Linux eBPF / Windows ProjFS | 内核探针 / 投影 FS | Linux 可行但重；ProjFS 是 Windows 的正确形态 |

- **目录重定向前提**（已实测，见 §2.7）：pi `PI_CODING_AGENT_DIR`、claude `CLAUDE_CONFIG_DIR`（strings×24）、codex `CODEX_HOME`（strings×68）、opencode `XDG_DATA_HOME/XDG_CONFIG_HOME` 都支持；**dimagent 无 env override（固定 `~/.dimcode/v2`）** → 只能 symlink/bind 进挂载点。

### 5.3 结论

FUSE 是**通用兜底**而非唯一答案：有原生插件 API 的 harness（pi）优先用 API；SQLite harness 用 WAL 轮询；其余 append-only JSONL harness 用 FUSE 托管目录。三种 live mode + offline import 构成完整 capture 矩阵。

> **2026-08-29 实测修正**（详见 [`2026-08-macos-fuse-landscape.md`](2026-08-macos-fuse-landscape.md)）：本机 macOS 26.5.1 上，fuser 0.15 + fuse-t 1.2.7 的挂载握手走到 NFSv4 `fs_locations` 后静默失败——**fuse-t 在 macOS 26 (Tahoe) 不可用**（FSKit 私有 entitlement 缺失，#104），其 NFS 后端还有 Apple kext 内核 panic 风险（#109）。macFUSE 5.3.3 新增的 FSKit 后端是 kext-less 的候选，但 macOS 26 上仍在修 bug（刚修完 write 静默损坏 #1187，26.6/27 上还有 #1192/#1181 open）。**结论：2026-08 时点，macOS 26 上无生产级纯用户态 FUSE；FUSE 托管目录方案在 macOS 上暂不具备实施条件。capture 层已按「文件边界」落地：`usl-capture` 的 `FileFollower`（文件尾随，替代 write 拦截）+ `ClaudeToPi`（读侧转换）+ `examples/live_convert` 演示（claude JSONL 流式写入 → 实时捕获 → 转成可 resume 的 pi JSONL），21 测试全绿。FUSE 挂载留待 FSKit 成熟或转 Linux 环境。**

## 6. 数据库内部设计（USL 作为数据库项目）

### 6.1 进程模型

```text
                  ┌─ wire protocol（Unix socket / gRPC）─┐
harness  ──FUSE/API/import──▶  USL daemon（唯一写者）      │◀── client SDK（TS/Rust/Go）
                              │  L0 blob store            │      Orca / e-core / CLI
                              │  L1 canonical event log   │
                              │  L2 projections + 索引    │
                              └───────────────────────────┘
```

- **daemon 唯一持有存储文件**，客户端只经 wire protocol（SDK 由 schema 生成，避免手写漂移——e 的教训：双份手写类型会漂）。
- **单写者多读者**：写路径只有 daemon；读路径用 `seq`/`revision` 快照隔离（envelope 已有单调 `seq`），不需要 MVCC。

### 6.2 存储格式规范草案

> **v0 已实现**（`packages/usl-core/`，Rust）：超块 + 帧（`[len][crc32][payload]`）+ 截断式恢复已落地，27 测试全绿 0 警告。实测结论：
> - **正确性不依赖 header**——损坏 header 可从 data 区自愈（`tests/corruption.rs`）；
> - **对同一有效前缀，恢复结果逐字节确定**，与后续撕裂字节无关（`tests/determinism.rs` 逐前缀断言）；
> - **对每个字节切点枚举撕裂帧**（覆盖 len 字段/crc 字段/payload 字节）→ 均恢复到最后一个完整帧（`tests/crash.rs`）；
> - 撕裂长度字段被拒绝且不 OOM（`MAX_FRAME_PAYLOAD` 上限）；schema 不匹配是 loud 报错而非静默截断。
> - `session_id` 定宽 `[u8;32]`，内容寻址 `sha256(harness‖native_id‖source_sha256)`（长度前缀）——修复了 e-session-convert 裸 hash 的跨 harness 碰撞隐患。

**目标**：单文件可移植（一个 session 的库可以像文件一样 handoff）+ 内容寻址 blob 侧车。

```text
┌ superblock（64B）：magic "USLDB\0" | version | page_size | wal_ptr |
│   checkpoint_ptr | lineage_root | flags(tamper-evidence 开关) ──────┐
├ L1 event segments（log-structured，append-only）：                    │
│   [len:u32][crc32][event JSONL record] × N，每 segment 上限 64MB     │
├ WAL：索引页的预写日志（只保护索引/元数据，事件直接落 segment）        │
├ checkpoint：周期性把投影索引刷到主文件（恢复点）                     │
├ L2 派生索引：session→event 区间、lineage DAG、message FTS           │
└ L0 blob 侧车目录（content-addressed，可外置/加密）                   │
```

- **恢复语义（ARIES 简化版）**：事件 segment 用「长度前缀 + CRC」判定最后一条是否完整，crash 后截断到最后一个完整 record（等价 WAL 的 redo-only，无 undo——因为 append-only 无原地更新）；索引从最后一个 checkpoint + 后续事件重放重建。
- **持久化分级**：事件追加 group-commit（批量 fsync）；checkpoint fsync；**handoff 导出路径强制满 fsync**（北极星要求）。
- **tamper-evidence 可选**：默认关（省写放大）；审计/合规场景开 hash 链（e-core `evidence.jsonl` 已有逐条 hash 链）或 Merkle 树（immudb 范式）。

### 6.3 索引架构

- **主索引**：`nativeSessionId → (agentSessionId, 事件区间, 快照) `；`agentSessionId → 事件区间`。
- **lineage DAG 二级索引**：`sourceSessionId → relations`、`targetSessionId → relations`（dimcode 已建双向外键索引的现成示范）。
- **message FTS**：FTS5/自研倒排（取决于实现语言）——副产品场景才需要，主路径不依赖。
- **projection 缓存**：L2 快照按 `revision` 版本化，读路径免重放。

### 6.4 查询模型

**领域 API + 订阅，不是通用 SQL**（SQL 只作为分析副本的只读附件）：

```text
listSessions(filter)                     → session 摘要列表
snapshot(sessionId, {atRevision})        → L2 快照（chat 渲染用）
events(sessionId, fromSeq)               → 事件流分页（live tail 基础）
lineage(sessionId, direction)            → DAG 邻居/整条链
search(messages, query)                  → FTS（副产品）
export(sessionId, harness, profile)      → 按 4.4 门控的 handoff 导出
subscribe(sessionId, fromSeq)            → 订阅增量
```

### 6.5 一致性与并发

- **单写者**：daemon 独占写，天然无写-写冲突；`sessions.version`（dimcode 乐观锁）语义仅用于「外部导入 vs live capture」的冲突判定。
- **多读者**：快照隔离 = 读一个 `seq` 号之前的稳定视图；不用锁、不用 MVCC。
- **import vs live 的合并**：离线 import 产物是 `exited` 只读会话（`e-session-convert` 已声明），永不与 live capture 抢同一 identity。

### 6.6 retention / compaction

- L1 append-only 保留（北极星需要完整溯源）；**compaction 只作用于 L2 投影与 L0 旧 blob 的 GC**，且必须写 `compact` lineage relation + `compaction.*` 事件（4.2-1）——「不得无声明丢 provenance」是硬约束。
- retention policy 显式声明（按 session 年龄/blob 体积），删除动作本身是可审计事件。

### 6.7 实现语言选型（结论：Rust）

| 维度 | Rust | Go | 嵌入式 SQLite/libsql | TS |
|---|---|---|---|---|
| 单二进制分发 | ★ | ★ | △（需宿主） | ✗ |
| FUSE 绑定 | ★（`fuser` crate） | ★（`go-fuse`，成熟，gocryptfs 同款） | ✗ | ✗（无维护良好的原生绑定） |
| 不可信输入鲁棒 | ★（内存安全） | ★ | ★（C 库，长期打磨） | △（原型快，生产边界靠 V8） |
| 自研存储引擎可控性 | ★ | ★ | ✗（引擎是别人的） | △ |
| 团队生态 | 与 herdr 同生态位 | — | — | pi/e 是 TS，但 USL 定位独立 |
| 长尾维护 | ★ | ★ | ★ | △ |

**结论**：核心 daemon + 存储引擎用 **Rust**（`fuser` 做 FUSE，单二进制，内存安全解析不可信日志，与 herdr 同生态位便于吸收人才）；**Go 是合理次选**（`go-fuse`/`bbolt`/`Badger` 生态，开发速度），若团队更熟 Go 可翻盘。**TS 排除出核心存储**，只保留为 importer/SDK 参考实现（本 spike 的 `e-session-convert` 角色）。嵌入式 SQLite 只作为「最快 MVP」的退路，不作为终态——因为北极星要的是「私有格式 + 事件日志 + lineage 一等」的自研可控性，而不是通用 SQL 引擎。

### 6.8 参考系统对照（借什么 / 不借什么）

| 系统 | 借 | 不借 |
|---|---|---|
| SQLite | 单文件可移植、页校验和、WAL 恢复纪律 | B-tree 通用引擎（我们是 log-structured，读模型是派生投影） |
| DuckDB | 列存 + 向量化 | 只做 L2 分析副本只读附件，不进主路径 |
| immudb | 可选 Merkle tamper-evidence 层 | 其 KV/SQL 主引擎 |
| dolt | 「内容寻址 + lineage 是头等对象」哲学 | MySQL 兼容层 |
| Kafka | segment 轮转 + offset/`fromSeq` 消费语义 | 分布式分区（单机 daemon 不需要） |
| bbolt / Badger / RocksDB | LSM「写放换读放」权衡作基准 | 引擎本身（事件日志本身就是 append，不需要 LSM 归并） |
| git | raw blob 内容寻址（去重/可校验）；opencode 已用 git snapshot 佐证 | 其 refs 模型（我们已有 lineage DAG） |
| TigerBeetle | 静态分配 + deterministic simulation 测试纪律（fault injection + replay 一致性） | 金融账本领域模型 |

## 7. Spike 结果（实测）

### 7.1 交付物

- `packages/e-session-convert/src/claude.ts` + `src/codex.ts`：claude/codex importer + **codex exporter**，注册进 bundle/CLI，`npm run check` **25/25 绿**（5 claude + 6 codex + 4 dimagent + 5 pi + 2 roundtrip）。
- 真实数据冒烟：claude（124 msgs / 58 tools / 4 runs，0 未声明 loss）、codex（303 msgs / 91 tools / **99 个 encrypted-reasoning blob 完整保留**，0 loss）。
- **cross-handoff 实测**：claude session → `export pi` → 可 resume 的 pi 文件 → re-import **0 loss**（thinking signature 走 pi 的 `thinkingSignature` 字段往返）。
- **pi↔codex 互转**（§7.4）：codex（303 msgs / 91 tools）→ pi → codex → 再导入 **0 loss**。

### 7.2 三个决定性格式发现

1. **claude 是「block-append journal」**：同一 `message.id` 的多个 entry 各追加一个 content block（实测 `[thinking] → [text] → [tool_use]` 三个 entry 拼成一条完整消息），`usage` 每组重复相同。importer 必须按 `message.id` 分组合并，否则同一逻辑消息被拆成 N 条、且后出现的 entry 会覆盖前一个。
2. **codex 是「双流」**：`response_item`（协议真源）+ `event_msg`（UI 流）重复同一逻辑事件；必须去重（response_item 权威），只保留 `event_msg.token_count`/`turn_aborted`。
3. **不透明负载（`signature` / `encrypted_content`）不可 normalize**——触发 e-core `normalizeContent` 二次包裹 bug，已修。

### 7.3 反证结论

枢轴 schema 的通用性**成立但有边界**：消息/工具链/血缘/不透明负载四轴都扛住了四路真实数据；但 compaction、subagent、usage 三轴暴露为「当前只能 evidence-only/unknown」，正是 4.2 的缺口清单。**USL 不该直接复用 e-core envelope 作终态，而应在它之上补 §4.2 的四个缺口，作为独立 spec。**

### 7.4 pi↔codex 互转实测（附两个跨 harness 保真 bug）

补齐 `exportCodexSession`（canonical → codex rollout）后，pi↔codex 双向可转：codex→codex、codex→pi→codex、pi→codex 三条 roundtrip 测试全绿；真实 codex rollout（303 msgs / 91 tools）→ pi → codex → 再导入 **0 loss**。

关键设计：exporter **优先用 importer 存下的 evidence 逐字还原**原生负载——`codex.session_meta`（cli_version/model_provider）、`codex.turn_context`（model/approval_policy/sandbox_policy）、reasoning 的 `{summary, content, encrypted_content}`——只有当证据缺失（跨 harness 源）时才合成并声明 loss。这印证了 §4.2「evidence 保真、canonical 投影」的分层：**roundtrip 保真来自 evidence 层，而非投影层**。

实测暴露两个跨 harness 保真 bug（均已修，都是「canonical 表示不一致」类）：

1. **unknown block 二次包裹**（pi import + export 两个方向）：pi 把 canonical `unknown` block 再包一层，`nativeType` 被覆盖为 `"unknown"`——codex 的 `encrypted_content` 经 pi 一趟就丢 `nativeType`。与 §7.2-3 的 `normalizeContent` 是同一 bug 类：**任何 canonical→native→canonical 重编码路径都必须让 `unknown` block 幂等**。
2. **tool result 的跨 harness 表示分歧**：pi 用 `[text]` 块、codex 用 `[tool-result]` 块 + 工具实体 `result`。exporter 改为从**工具实体**取 result（canonical 表示，与块形状无关）；pi 的 string→块重编码是声明 loss（codex `"a.ts b.ts"` 经 pi 变成 `[{"type":"text","text":"a.ts b.ts"}]`，值不丢、形状变）。

**对 USL 的设计约束（新增）**：工具结果、usage、reasoning 这类「形状随 harness 变」的字段，canonical 层必须选一个中立表示（如 tool result 一律存工具实体的 `result`，message 块只做渲染），否则每个 harness 对的往返都要踩一遍形状分歧。这是 §4.2 缺口清单之外新增的一条。

## 8. 与 e 的关系

| 资产 | USL 中的角色 | 改动 |
|---|---|---|
| `e-core` `AgentSessionService` | live ingest 前端的一个参考实现 / 未来 consumer | 存储层被 USL 取代；envelope 缺口（§4.2）回补后共用 |
| `e-session-convert` | importer/exporter 参考实现 + 本 spike 的验证床 | 保留为 TS 参考实现；生产 importer 迁到 Rust daemon |
| `e-pi-adapter` | pi 的 live capture（原生插件 API mode） | 输出端从 e-core socket 改到 USL wire protocol |
| `e-orca-bridge` | USL 的 chat 渲染 consumer | 读 USL 的 snapshot/events API，不变更其 reducer |

**边界**：USL 是独立 spec + 独立 package（Rust daemon），e 不拥有它、只消费它。e-core 里经评审证明的决策（validate-before-append、eventId 幂等、terminal sticky、tamper quarantine）作为**语义基线**写入 USL spec，而不是代码基线。

## 9. 未决问题与后续路线

**未决**：
1. FUSE 托管目录的「fsync 背压耦合」具体语义（harness 的 fsync 是否阻塞到 DB append 完成）需要原型验证——这是 5.2 唯一没实测的环节。
2. opencode importer：读投影表 vs 重放 `event` 表两条路径选哪条（影响保真上限）。
3. dimagent 无 env override 时，symlink 进 FUSE 挂载点是否会被 dimcode 的 `WAL` 语义破坏（可能 dimcode 自己 rename 目录）。
4. `opaque` vs `unknown` 两个 block 语义是否合并（担心：合并会诱导开发者把 opaque 当 unknown 渲染）。
5. Rust 自研引擎 vs「SQLite 单文件 + 事件表」的 MVP 捷径：北极星是否需要「私有格式」这个属性本身，还是「可移植单文件 + lineage 一等」就够。

**后续路线**（按优先级）：
1. opencode importer（补全 5/5 runtime，WAL-copy 范式现成）。
2. 最小 Rust PoC：存储格式（superblock + segment append + WAL + crash recovery）+ `fromSeq` 订阅。
3. FUSE loopback PoC（`fuser`）：验证 write 边界捕获 + fsync 背压。
4. OTEL `gen_ai.*` exporter（副产品接口）。
5. 剩余 runtime 盘点（gemini/kimi/cursor/aider）。

