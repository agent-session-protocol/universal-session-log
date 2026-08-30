# RFC 0001: SessionQL 与 USL 查询平面

- 状态：Draft
- 目标版本：SessionQL 1.0 / Query IR 1.0
- ASP 基线：event schema 1.0 / projection 1.1
- 最后更新：2026-08-30

## 摘要

本文定义 Universal Session Log（USL）的引擎无关查询平面：SessionQL 文本语言、Query IR、搜索与事件模式语义、索引一致性、Insight、实时审计订阅、原 Runtime 恢复描述符，以及只读 SQL 附件。本文是实现契约，不规定 SESDB 内部执行算法，也不修改 Agent Session Protocol（ASP）。

系统边界如下：

- **ASP** 定义 canonical event、身份、因果关系与 provenance；
- **USL** 负责持久化、索引、SessionQL、投影与订阅；
- **SESDB** 是 USL 的参考执行器，不是规范来源；
- **SQL** 是只读分析附件，不与 SessionQL 能力等价。

文中的关键词“必须”“不得”“应”“可以”具有规范性含义。

## 1. 动机与目标

不同 Agent Runtime 会以不同原生结构记录消息、工具调用、审批、分支和恢复信息。ASP 把这些记录规范化为可验证的事件，但不会定义数据库查询、全文/向量索引或实时规则。USL 需要一个稳定边界，让 CLI、SDK、UI、自然语言转换器与不同执行器对同一份 canonical 事实获得相同语义。

本 RFC 的目标是：

1. 定义可版本协商、可序列化、可解释的查询接口；
2. 让 Codex、Pi 等来源的等价 ASP 事件产生相同查询结果；
3. 明确 append log、派生索引与固定查询快照之间的一致性；
4. 让搜索结果始终携带可定位到 canonical event 的证据；
5. 支持 lineage、事件序列、聚合、恢复定位与确定性的实时审计；
6. 为派生 Insight 提供带 provenance、可纠正且不污染事实层的生命周期。

### 1.1 非目标

- 不在本 RFC 中实现解析器、规划器、索引器或执行器；
- 不扩展或复制 ASP event schema；
- 不承诺历史时间点 fork、跨 Runtime handoff 或工具调用阻断；
- 不允许 SQL、Insight 或 sidecar 成为 canonical 事实真源；
- 不在 v1 支持任意用户函数、非确定性实时算子或隐式全局记忆注入。

## 2. 数据与版本模型

### 2.1 真源

L1 `.usl` append log 是唯一真源。所有投影、搜索 chunk、索引、Insight 物化视图和 SQL 表都必须能从其获准读取的 append-only stream 重建。删除 sidecar 不得造成 canonical 数据丢失。

每次成功追加分配数据库范围内严格递增的 `globalSeq`。canonical event stream 与 Insight stream 使用独立 namespace、ACL、retention 和 stream-local sequence，但共享 `globalSeq` 排序域，从而可以无歧义地 replay 后 tail。

ASP 版本不是由查询语言重新定义的。执行器必须声明可读的 ASP event/projection 版本，并通过协商拒绝不兼容版本；不得猜测字段含义。本文基线是 ASP event schema 1.0 与 projection 1.1。

### 2.2 逻辑数据源

`from` 后只能使用下列 v1 数据源：

| 数据源 | 行/实体语义 | 最小稳定身份 |
|---|---|---|
| `sessions` | canonical Session 投影 | `sessionId` |
| `events` | ASP canonical event | `eventId` |
| `turns` | Turn 投影 | `sessionId, runId, turnId` |
| `messages` | Message 投影 | `sessionId, messageId` |
| `tools` | Tool Call/Result 投影 | `sessionId, toolCallId` |
| `approvals` | 审批请求与决定投影 | `sessionId, approvalId` |
| `artifacts` | canonical artifact 投影 | `sessionId, artifactId` |
| `chunks` | `SearchChunkV1` | `chunkId` |
| `lineage` | fork/resume/handoff/subagent 边 | `edgeId` |
| `insights` | 有权限可见的 Insight | `insightId, revision` |

数据源字段由对应 ASP projection 或本文类型定义。未知字段必须产生静态验证错误，而不是被当作 `null`。跨版本新增字段只有在协商成功后才能引用。

## 3. SessionQL 1.0

### 3.1 管道语法

SessionQL 是单源、从左到右执行的管道语言：

```ebnf
query       = "from", source, { "|", stage } ;
source      = "sessions" | "events" | "turns" | "messages" | "tools"
            | "approvals" | "artifacts" | "chunks" | "lineage" | "insights" ;
stage       = where | search | match | traverse | group | summarize
            | project | sort | limit ;
where       = "where", expr ;
search      = "search", ("text" | "semantic" | "hybrid"), value,
              { search_option } ;
search_option = "in", field_list | "language", value
              | "recency_boost", duration | "top", integer ;
match       = "match", [ "partition by", field_list ], pattern ;
traverse    = "traverse", edge_set, [ "direction", ("out" | "in" | "both") ],
              [ "depth", integer, "..", integer ] ;
group       = "group by", field_list ;
summarize   = "summarize", aggregate_list ;
project     = "project", projection_list ;
sort        = "sort by", sort_list ;
limit       = "limit", integer ;
value       = string | number | boolean | null | timestamp | duration | parameter | array ;
parameter   = "$", identifier ;
```

字符串使用 JSON 转义规则；时间戳必须是带时区的 RFC 3339；duration 使用 `ms/s/m/h/d` 后缀。标识符和关键字是 ASCII；字符串内容、全文查询和参数值可以是任意 Unicode。注释以 `#` 开始，到行尾结束。

每个 stage 的输入、输出 row type 必须在执行前通过静态检查。`project` 只改变输出形状；`summarize` 把当前行集变成聚合行；`limit` 必须是非负整数且受服务端上限约束。

### 3.2 表达式

`where` 支持：

- 比较：`=`, `!=`, `<`, `<=`, `>`, `>=`；
- 布尔：`and`, `or`, `not`，优先级依次为 `not`、`and`、`or`；
- 集合：`in`, `not in`，右侧为数组参数或字面量；
- 空值：`is null`, `is not null`；
- 正则：`matches`，采用 RE2 兼容语义，不允许回溯扩展；
- 时间：时间戳比较及 `between <start> and <end>`，区间包含起点、不包含终点；
- canonical 字段访问：例如 `event.type`, `message.role`, `tool.name`, `provenance.runtime`。

所有用户输入都应通过 `$parameter` 绑定。参数有显式类型，不能用参数替代字段名、stage 或操作符。v1 禁止任意用户函数、动态代码和隐式字符串插值。

```sessionql
from tools
| where tool.name = $tool and event.time between $start and $end
| project sessionId, turnId, tool.status, tool.durationMs
| sort by event.time desc, toolCallId asc
| limit 100
```

### 3.3 搜索

`search text` 使用语言感知的全文索引，并保留代码符号、路径、域名等可检索 token；`search semantic` 使用向量相似度；`search hybrid` 使用两路排名的 Reciprocal Rank Fusion（RRF）：

```text
rrfScore(d) = sum(1 / (60 + rank_i(d)))
```

v1 中 `60` 是固定常量。缺少某一路结果不等于零相似度，只是不贡献该路的 RRF 分数。融合后的稳定排序为：`rrfScore desc, bestSourceRank asc, eventTime desc, chunkId asc`。这里时间只在 score 和来源 rank 完全相同时作稳定 tie-break，不得暗中参与相关性得分；只有查询给出 `recency_boost <duration>` 时才能参与相关性得分，且 explain 必须列出贡献。

默认命中单位是 Turn 或任务 episode 边界内的 `SearchChunkV1`。响应展示证据片段，随后按 Session 聚合；每个 Session 默认返回排名最高的 3 个 chunk，规范化 IR 因此写入 `hitsPerSession: 3`。`top N` 可以修改每个 Session 的片段数，但受服务端上限约束。Session 排名取其最佳 chunk 分数，随后以 `sessionId` 稳定排序。调用方若直接 `from chunks`，可请求未聚合的 chunk 行。

```sessionql
from sessions
| search hybrid $question language $language top 3
| where provenance.runtime in $runtimes
| project sessionId, title, search.hits, search.score
| sort by search.score desc, sessionId asc
| limit 20
```

搜索响应必须包含可高亮 evidence snippet、内容偏移和 `evidenceEventIds`；不得只返回不可审计的向量分数。

### 3.4 事件序列 `match`

`match` 只对具有时间/序列顺序的数据源有效。模式默认在同一 Session 内匹配；`partition by` 可以显式指定一个或多个 correlation key。v1 支持：

```ebnf
pattern     = atom, { ("next" | "then"), atom }, [ "within", duration ] ;
atom        = [ identifier, ":" ], event_predicate
            | "not", event_predicate, "until", event_predicate ;
```

- `A next B`：`B` 是分区内 `A` 后的下一个事件；
- `A then B`：`B` 在 `A` 之后，中间可有其他事件；
- `within`：从首个正事件到末个正事件的事件时间上限；
- `not X until B`：在前一正事件之后、`B` 之前不存在满足 `X` 的事件；必须由后续正事件或有限 `within` 封闭；
- 相同时间戳按 `globalSeq` 排序；迟到的来源事件按其 append 顺序参与匹配，原始发生时间仍可在谓词中显式过滤。

无界否定、无限重复和需要保留无界状态的模式在 v1 非法。batch 查询可以执行上述全部有界模式；subscription 还须满足第 9 节的确定性限制。

```sessionql
from events
| match a: event.type = "tool.call"
        then not event.type = "approval.decided" until b: event.type = "tool.result"
        within 10m
| project sessionId, a.eventId, b.eventId
```

### 3.5 Lineage 遍历

`traverse` 在 `fork | resume | handoff | subagent` 边上进行有界图遍历：

```sessionql
from sessions
| where sessionId = $root
| traverse {fork, subagent} direction out depth 1..4
| project sessionId, lineage.depth, lineage.path
```

遍历按 `(depth asc, edge.globalSeq asc, edgeId asc)` 输出。一个实体每条路径最多出现一次；循环路径必须截断并在 explain 中标记。最大深度由服务端能力声明，v1 查询不得请求无界遍历。

### 3.6 分组、聚合、投影与排序

`group by` 后只能引用分组键或聚合值。v1 聚合为 `count`, `count_distinct`, `min`, `max`, `sum`, `avg`, `p50`, `p95`。聚合必须定义 null 与空集行为：`count` 为 0，其余空集为 `null`，且 null 不参与数值聚合。

未写 `sort` 时，实体查询按最小稳定身份升序；搜索和 traverse 使用各自规定的稳定顺序；聚合按分组键升序。执行器不得依赖物理扫描顺序。

## 4. Query IR 与公共类型

### 4.1 兼容性边界

文本 SessionQL 与 Query IR 必须一一对应：每个合法文本 stage 恰好映射为一个有序的类型化 IR stage；IR 不得拥有文本语法无法表达的隐藏能力。解析器可以丢弃空白、注释和非语义括号，随后按规范形式序列化。以下两项必须一致：

1. 相同文本、参数类型和协商版本产生相同 canonical IR；
2. `parse(print(plan))` 与 `plan` 在语义上完全相等。

IR 是 SDK、UI、自然语言转换器和执行器之间的长期兼容边界。未知 major version 必须拒绝；同一 major 下未知 stage 必须拒绝并返回支持能力，不得跳过。

### 4.2 `QueryPlanV1`

以下 TypeScript 仅用于精确定义 JSON 形状；线上的字段名和枚举值具有规范性。

```typescript
type SourceV1 =
  | "sessions" | "events" | "turns" | "messages" | "tools"
  | "approvals" | "artifacts" | "chunks" | "lineage" | "insights";

interface ParameterDeclV1 {
  name: string;
  type: "string" | "number" | "boolean" | "timestamp" | "duration"
      | "string[]" | "number[]";
  required: boolean;
}

interface QueryPlanV1 {
  irVersion: "1.0";
  asp: { eventSchema: string; projection: string };
  source: SourceV1;
  stages: StageV1[];
  parameters: ParameterDeclV1[];
  mode: "batch" | "subscription";
}

type StageV1 =
  | { op: "where"; expression: ExpressionV1 }
  | { op: "search"; kind: "text" | "semantic" | "hybrid";
      query: ValueV1; fields?: string[]; language?: ValueV1;
      hitsPerSession: number; recencyBoost?: string }
  | { op: "match"; pattern: PatternV1 }
  | { op: "traverse"; edges: Array<"fork" | "resume" | "handoff" | "subagent">;
      direction: "out" | "in" | "both"; minDepth: number; maxDepth: number }
  | { op: "group"; keys: string[] }
  | { op: "summarize"; values: AggregateV1[] }
  | { op: "project"; fields: ProjectionV1[] }
  | { op: "sort"; keys: Array<{ field: string; direction: "asc" | "desc" }> }
  | { op: "limit"; count: number };

type ScalarV1 = string | number | boolean | null;
type ValueV1 =
  | { kind: "literal"; value: ScalarV1 | ScalarV1[]; valueType?: string }
  | { kind: "parameter"; name: string }
  | { kind: "field"; path: string };

type ExpressionV1 =
  | { kind: "compare"; operator: "=" | "!=" | "<" | "<=" | ">" | ">=";
      left: ValueV1; right: ValueV1 }
  | { kind: "in"; negated?: boolean; left: ValueV1; right: ValueV1 }
  | { kind: "null"; negated?: boolean; value: ValueV1 }
  | { kind: "matches"; value: ValueV1; pattern: ValueV1 }
  | { kind: "between"; value: ValueV1; start: ValueV1; end: ValueV1 }
  | { kind: "not"; item: ExpressionV1 }
  | { kind: "and" | "or"; items: ExpressionV1[] };

interface PositivePatternTermV1 {
  kind: "event";
  relation: "first" | "next" | "then";
  bind?: string;
  predicate: ExpressionV1;
}

interface AbsencePatternTermV1 {
  kind: "absenceUntil";
  relation: "next" | "then";
  predicate: ExpressionV1;
  until: { bind?: string; predicate: ExpressionV1 };
}

interface PatternV1 {
  partitionBy: string[]; // 未显式指定时规范化为 ["sessionId"]
  terms: Array<PositivePatternTermV1 | AbsencePatternTermV1>;
  within?: string;
}

interface AggregateV1 {
  function: "count" | "count_distinct" | "min" | "max" | "sum" | "avg" | "p50" | "p95";
  field?: string; // count(*) 时省略
  as: string;
}

type ProjectionV1 =
  | { kind: "field"; path: string; as?: string }
  | { kind: "aggregate"; name: string; as?: string };
```

时间戳和 duration 的 literal 通过 `valueType` 区分于普通字符串。所有表达式和模式必须作为上述 JSON AST 传输，不得把未解析表达式藏在字符串中。实现可以发布生成的 JSON Schema，但不得改变上述语义。

### 4.3 请求与结果

```typescript
type FreshnessV1 =
  | { kind: "indexed" }
  | { kind: "wait"; timeoutMs: number };

interface QueryRequestV1 {
  apiVersion: "query.usl.dev/v1";
  query: { sessionql: string } | { plan: QueryPlanV1 }; // 恰好一个
  parameters: Record<string, unknown>;
  page?: { size: number; cursor?: string };
  freshness: FreshnessV1;
  includeExplain?: boolean;
}

interface IndexWatermarkV1 {
  index: string;
  generation: string;
  builtThroughSeq: number;
  used: boolean;
}

interface QueryWarningV1 {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface QueryResultV1<Row = Record<string, unknown>> {
  apiVersion: "query.usl.dev/v1";
  queryHash: string;
  asOfSeq: number;
  watermarks: IndexWatermarkV1[];
  rows: Row[];
  nextCursor?: string;
  warnings: QueryWarningV1[];
  explain?: QueryExplainV1;
}

interface QueryExplainV1 {
  normalizedPlan: QueryPlanV1;
  asOfDecision: {
    freshness: FreshnessV1;
    committedSeqAtStart: number;
    selectedAsOfSeq: number;
  };
  stages: Array<{
    ordinal: number;
    op: StageV1["op"];
    inputType: string;
    outputType: string;
    indexes: string[];
    inputRows?: number;
    outputRows?: number;
    notes?: string[];
  }>;
  scores?: Array<{
    rowId: string;
    components: Record<string, number>;
    final: number;
  }>;
  warnings: QueryWarningV1[];
}
```

`queryHash` 是 canonical IR、已绑定参数的类型化 canonical JSON、ASP 协商版本和访问策略上下文哈希的摘要；不得包含 cursor。结果中的 `asOfSeq` 固定整个查询和所有后续分页。分页 cursor 至少绑定 `queryHash`、`asOfSeq`、参与索引 generation、最后一行完整排序键和稳定身份，并应被认证以防篡改。cursor 与查询、权限、generation 或快照不匹配时必须返回明确错误，不能从第一页静默重启。

`QueryExplainV1` 至少列出规范化计划、每个 stage 的输入/输出类型、所用索引、过滤行数、score 组成、回退扫描、截断/循环和 freshness 决策；不得泄露调用者无权访问的内容或统计。

### 4.4 搜索 chunk

```typescript
interface SearchChunkV1 {
  chunkId: string;
  sessionId: string;
  runId?: string;
  turnId?: string;
  episodeId?: string;
  ordinal: number;
  text: string;                 // 已按策略脱敏的 canonical 文本
  textFields: string[];         // message.text, tool.summary 等
  evidenceEventIds: string[];
  offsets: Array<{
    eventId: string;
    field: string;
    startUtf8: number;
    endUtf8: number;
  }>;
  asp: { eventSchema: string; projection: string };
  redactionPolicyHash: string;
  chunkerVersion: string;
}
```

偏移是脱敏后 `text` 的 UTF-8 byte offset，区间为 `[startUtf8, endUtf8)`。调用者必须使用同一 policy hash 的受权内容解释偏移。任何 chunk 都必须能沿 `evidenceEventIds` 回到可见 canonical 事实；证据被 retention 或 ACL 隐藏时必须省略 chunk 或显式标为不可用，不得展示孤立文本。

### 4.5 索引 manifest

```typescript
interface IndexManifestV1 {
  manifestVersion: "1.0";
  indexKind: "structured" | "fulltext" | "vector" | "lineage" | "analytics";
  generation: string;
  builtThroughSeq: number;
  createdAt: string;
  schemaVersion: string;
  asp: { eventSchema: string; projection: string };
  chunkerVersion?: string;
  embeddingModel?: { provider: string; model: string; dimensions: number };
  redactionPolicyHash: string;
}
```

### 4.6 Resume 描述符

```typescript
interface ResumeDescriptorV1 {
  descriptorVersion: "1.0";
  runtime: string;
  nativeSessionId: string;
  sessionId: string;
  match?: { runId?: string; turnId?: string; eventId?: string };
  capabilities: Array<"resume" | "fork-current" | "open" | "locate-turn">;
  unavailable?: Array<{
    capability: "resume" | "fork-current" | "historical-fork" | "cross-runtime-handoff";
    reason: string;
  }>;
}
```

`resume.describe` 返回原 Runtime 的原生 Session 描述符并尽可能定位命中 Turn。它不创建或修改 Session。v1 只承诺描述原 Runtime 当前支持的恢复能力，不承诺历史时间点 fork 或跨 Runtime handoff。

### 4.7 领域操作

实现必须以等价的本地 API、RPC 或 HTTP 暴露：

- `query.execute(QueryRequestV1) -> QueryResultV1`；
- `query.explain(QueryRequestV1) -> QueryExplainV1`；
- `query.subscribe(SubscribeRequestV1) -> stream<SubscriptionEnvelopeV1>`；
- `resume.describe({sessionId, match?}) -> ResumeDescriptorV1`。

服务必须提供 capability discovery，至少声明 API/IR/ASP 版本、支持的 source/stage/index、最大 page/limit/traversal depth、embedding 可用性和 subscription 限制。

## 5. 索引、chunk 与一致性

### 5.1 可重建 sidecar

sidecar 按不可变 generation 构建，可以删除后从 L1 重建：

1. Session、时间、event type 与结构字段倒排索引；
2. 已脱敏 canonical 内容全文索引；
3. `SearchChunkV1` 向量索引；
4. lineage/correlation 邻接索引；
5. DuckDB/Parquet 只读分析投影。

每个索引有独立 `IndexManifestV1` 和 watermark。索引文件不得原地升级：构建器写入并验证新 generation，再用原子 manifest/pointer 切换。查询开始后固定所选 generation；并发切换不影响该查询或后续分页。旧 generation 必须至少保留到所有已签发 cursor/查询租约过期。

崩溃留下的未发布 generation 必须被忽略或清理。embedding 模型、维度、chunker、ASP schema/projection 或脱敏策略改变时必须建立新 generation；不得混用不兼容向量或内容。

### 5.2 固定 `asOfSeq`

执行器在规划时确定查询所需索引集合：

- `freshness: indexed`：`asOfSeq` 取查询开始时 L1 committed seq 与所有必需索引 `builtThroughSeq` 的最小值；
- `freshness: wait(timeout)`：先记录查询开始时 L1 committed seq 为目标，等待所有必需索引达到该目标，然后固定为目标；超时必须返回 freshness timeout，或在调用方显式允许降级时返回较旧 `asOfSeq` 与 warning；
- 不允许把 watermark 落后的结果标为最新；
- 若执行器用 L1 tail scan 补齐某个索引之后的区间，explain 必须声明补扫范围，且结果语义仍必须精确截至 `asOfSeq`；
- 索引 watermark 高于 `asOfSeq` 时，索引项必须携带 seq 并过滤未来记录。

若查询不需要任何 sidecar，`indexed` 的 `asOfSeq` 就是查询开始时的 L1 committed seq。

`QueryResultV1.watermarks` 返回规划时检查的全部索引、generation、实际 watermark 及是否参与执行。ACL/redaction 变更不能仅靠旧索引的查询时过滤来假设安全；policy hash 不匹配必须切换/重建受保护 generation，或拒绝查询。

### 5.3 默认 chunk 策略

canonical chunk 以 Turn 或任务 episode 为首选边界。超长内容只在 ASP content block 边界切分；单个超长 block 再按语言/代码感知边界切分。默认目标约 768 embedding tokens、96 tokens overlap。tokenizer、边界规则、目标长度和 overlap 必须共同编码进 `chunkerVersion`。

重叠文本仍引用原 evidence offset；聚合结果应按 `chunkId` 去重，避免 overlap 重复计数。chunker 不得跨 Session，也不得跨越使因果/角色含义混淆的 Turn 边界。

### 5.4 raw、opaque 与 Tool 数据

- raw/opaque payload 默认不进入全文或向量索引；
- Tool 默认索引工具名、参数键、已脱敏的路径/域名、状态和摘要；
- secret、token、完整环境变量和未脱敏参数值不得进入默认索引；
- 完整 Tool Result 只可进入 ACL 隔离的受限全文索引，默认不生成 embedding；
- 调用者请求受限索引时，query hash、cursor、缓存与 explain 都必须绑定相同授权上下文；
- canonical 层无法安全脱敏的内容必须跳过，并产生可审计的索引诊断，不得退回 raw 索引。

## 6. Insight stream

Insight 是从事实推导出的声明，不是事实本身。它位于同一逻辑数据库的独立 append-only stream，拥有独立 namespace、ACL、索引、retention 和状态事件。

```typescript
interface InsightRecordV1 {
  insightVersion: "1.0";
  insightId: string;
  revision: number;
  kind: string;
  subject: { type: string; id: string };
  statement: string;
  confidence: number; // [0, 1]
  status: "proposed" | "confirmed" | "rejected" | "superseded";
  evidenceEventIds: string[];
  sourceQuery?: { sessionql?: string; queryHash: string };
  producer: {
    skill: { name: string; version: string };
    model?: { provider: string; model: string };
    promptHash?: string;
    redactionPolicyHash: string;
  };
  supersedes?: string;
  actor: { type: "user" | "agent" | "system"; id: string };
  globalSeq: number;
  createdAt: string;
}
```

BYOA Skill/CLI 通过普通受权查询读取 raw/canonical 事实，只能通过 `insight.append` 与 `insight.transition` 写 Insight。transition 必须追加新 revision，不能覆盖历史。状态迁移为：`proposed -> confirmed | rejected | superseded`，`confirmed -> superseded`；其他迁移需新 RFC。

规则如下：

1. Insight 默认是 `proposed`；Agent 查询上下文默认只返回 `confirmed`；
2. 生成 Insight 的查询默认排除 `insights`，且 Insight 不得默认作为新 Insight 的生成证据；显式启用时必须标记依赖链并检测循环；
3. Skill 由用户 mention 或 Agent 按可见配置显式调用，不得隐藏式全局注入；
4. 健康、政治、宗教等敏感属性推断默认关闭，并应由部署策略完全禁止或要求逐次明确同意；
5. 用户纠正、拒绝和遗忘通过追加 transition/tombstone 状态事件表达；物理清除按 retention/隐私策略执行并留下不含被遗忘内容的合规证明；
6. evidence、query hash、Skill、模型、Prompt 与脱敏策略 provenance 缺一不可；没有模型/Prompt 的确定性生产者可以显式省略对应字段。

## 7. 原 Runtime Resume

搜索或查询结果本身不得伪造可恢复性。客户端选中结果后调用 `resume.describe`：

1. USL 从 ASP provenance 找到 `runtime` 与 `nativeSessionId`；
2. 将命中 chunk/事件定位为 `runId/turnId/eventId`；
3. 查询 Runtime adapter 的当前 capability；
4. 返回 `ResumeDescriptorV1`，并为不可用能力填写原因。

执行 resume 是 Runtime/客户端操作，不属于查询平面。若原生 Session 已过期，描述符仍可用于 `open`/`locate-turn`，但不得声称 `resume` 可用。v1 中 `fork-current` 只表示 Runtime 可从当前头部 fork；命中历史 Turn 不意味着支持 historical fork。

## 8. 实时审计订阅

### 8.1 replay + tail

```typescript
interface SubscribeRequestV1 {
  apiVersion: "query.usl.dev/v1";
  plan: QueryPlanV1; // mode 必须是 subscription
  parameters: Record<string, unknown>;
  cursor?: string;
}

interface SubscriptionEnvelopeV1<Row = Record<string, unknown>> {
  deliveryId: string;
  globalSeq: number;
  phase: "replay" | "live";
  row: Row;
  cursor: string; // 已处理到的 globalSeq + query/policy 绑定
}
```

订阅以同一个 `globalSeq` 高水位完成 replay 后进入 tail，保证不漏事件，但采用 **at-least-once delivery**：网络重试、服务重启以及 replay/live 交界都可能重复。消费者必须用 `deliveryId` 或领域稳定身份幂等处理。cursor 可恢复且绑定 query hash、参数、ACL/policy 和服务端保留代际；cursor 早于 retention 时必须返回 `cursor_expired` 及允许重建的最早位置，不能静默跳过。

### 8.2 实时安全子集

subscription 只允许确定性且内存有界的算子：结构 `where/project`、有界 `match within`、受限时间窗聚合、稳定 `sort + limit`（服务端声明上限）。禁止 semantic/hybrid search、LLM/Insight 推理、无界否定、无界 lineage、任意用户函数和依赖 wall-clock 随机性的逻辑。纯全文条件只有在服务端声明 deterministic text capability 时可以启用。

实时规则用于审计、告警和通知。USL 不阻断 Tool Call，也不把“告警尚未计算”解释为允许执行。未来执行前阻断必须由 ASP/Runtime admission 协议另行定义。

## 9. SQL 只读分析附件

实现可以通过 DuckDB/Parquet 暴露固定 `asOfSeq` 的只读快照视图：

- `sessions`, `events`, `messages`, `tools`, `approvals`, `artifacts`, `lineage`, `insights`。

SQL attachment 必须只读，禁止 `INSERT/UPDATE/DELETE/COPY` 回写 L1 或 sidecar。每个连接/快照应暴露 `usl_as_of_seq()`（或等价元数据）和 projection/policy 版本。SQL 视图在支持范围内必须与同一 `asOfSeq`、同一 ACL 下的 SessionQL 投影结果一致。

SQL 不承诺 semantic/hybrid search、Session 聚合的 evidence snippet、Resume、lineage 专用语义或实时订阅。即使执行器通过 SQL 实现部分 stage，也不得宣称 SQL 与 SessionQL 能力等价。

## 10. 安全、隐私与可观测性

授权先于查询规划、索引选择、统计与缓存。实体不可见时，其存在不能通过 count、score、watermark、explain、错误差异或耗时缓存键泄露。部署可以对高风险聚合施加最小分组阈值。

所有 query/subscribe/resume/insight 操作应写审计记录，包括 actor、query hash、policy hash、`asOfSeq`、所用索引 generation、返回/拒绝状态；审计记录不得保存明文 secret 参数。缓存键必须包含访问策略上下文和 generation。

正则、图遍历、结果数、向量候选、模式状态、订阅窗口和执行时间必须有资源上限。超限返回结构化错误及安全的 explain，不允许退化为无界扫描。

## 11. Golden conformance cases

实现必须把以下案例固化为可移植 fixtures。示例 ID 是 fixture 中的稳定符号，不要求生产 ID 采用相同格式。

### G1. 文本与 IR 一一对应

SessionQL：

```sessionql
from tools
| where tool.name = $name and tool.status in ["failed", "denied"]
| project sessionId, turnId, toolCallId, tool.status
| sort by sessionId asc, toolCallId asc
| limit 50
```

参数：`name: string = "shell"`。canonical IR：

```json
{
  "irVersion": "1.0",
  "asp": {"eventSchema": "1.0", "projection": "1.1"},
  "source": "tools",
  "stages": [
    {"op":"where","expression":{"kind":"and","items":[
      {"kind":"compare","operator":"=","left":{"kind":"field","path":"tool.name"},"right":{"kind":"parameter","name":"name"}},
      {"kind":"in","left":{"kind":"field","path":"tool.status"},"right":{"kind":"literal","value":["failed","denied"]}}
    ]}},
    {"op":"project","fields":[
      {"kind":"field","path":"sessionId"},{"kind":"field","path":"turnId"},
      {"kind":"field","path":"toolCallId"},{"kind":"field","path":"tool.status"}
    ]},
    {"op":"sort","keys":[{"field":"sessionId","direction":"asc"},{"field":"toolCallId","direction":"asc"}]},
    {"op":"limit","count":50}
  ],
  "parameters":[{"name":"name","type":"string","required":true}],
  "mode":"batch"
}
```

解析、打印、再解析必须得到语义相等 IR。缺参数、错误参数类型和未知字段必须在执行前失败。

### G2. 跨 Runtime canonical 等价

fixtures 分别从 Codex 与 Pi 导入语义等价的 ASP 事件：用户请求、shell tool call、审批允许、tool result、assistant message。下列查询必须在忽略来源身份字段后产生相同的事件类型、角色、状态和聚合计数：

```sessionql
from events
| where sessionId = $session
| project event.type, message.role, tool.status
| sort by event.globalSeq asc
```

Runtime 原生字段只能通过 provenance 显式查询，不能改变 canonical 语义。

### G3. 多语言、代码、路径与模糊语义搜索

fixture 包含“修复登录超时”、`AbortController`、`src/auth/token.ts` 和语义等价但无共同关键词的英文说明。必须验证：

- text 可命中中文、代码符号和完整/分段路径；
- semantic 可命中语义等价英文；
- hybrid 的 score 等于固定 RRF 公式，explain 列出各路 rank；
- 未请求 `recency_boost` 时，较新但相关性较弱的 chunk 不得因时间反超。

### G4. chunk、Session 聚合、分页与 Resume

一个 Session 有 5 个匹配 chunk，另一个有 2 个。默认结果分别只带 3 和 2 个 evidence hit，offset 均能映射回脱敏 canonical 文本。两页结果在并发追加后仍固定原 `asOfSeq`，无重复/遗漏；篡改或跨 query 使用 cursor 必须失败。选中 Codex 命中后，`resume.describe` 返回 Codex `nativeSessionId` 与命中 `turnId`；若只支持当前 resume，`historical-fork` 必须列入 unavailable。

### G5. 事件序列

fixture 包含 call→approval→result、call→result 和超时 call。第 3.4 节示例只匹配 10 分钟内没有 approval 的 call→result；`next` 不得跨过中间事件；同时间戳按 `globalSeq` 决定顺序；无界否定在静态检查时失败。

### G6. Lineage 与聚合

fixture 是 root→fork→subagent，并带一条可检测循环边。深度 `1..2` 只返回两层，顺序符合 `(depth, edge.globalSeq, edgeId)`，循环在 explain 标记。按 runtime 分组的 tool failure `count`/`p95(durationMs)` 必须与手算 fixture 一致。

### G7. 索引落后、等待与 generation 切换

L1 committed seq 为 120，structured watermark 120，fulltext 115，vector 110：

- hybrid + `indexed` 的 `asOfSeq` 是 110，并返回三个 watermark；
- `wait(1000)` 只有两索引均到 120 才返回 `asOfSeq=120`，否则明确 timeout；
- 崩溃留下未发布 generation 不可见；
- 原子切换后已开始的分页继续使用旧 generation，新查询使用新 generation；
- 模型或 policy hash 改变时不能混用旧向量。

### G8. raw/opaque、Tool Result、ACL 与脱敏

raw secret 和 opaque encrypted content 在默认 text/semantic 搜索中均不可命中。Tool 名、参数键、脱敏路径、域名、状态可命中；完整 Tool Result 只有持有受限全文权限的 actor 可命中，且默认无 embedding。无权 actor 的结果、count、explain 与缓存不可泄露受限实体。

### G9. Insight provenance 与反馈回路

缺少 evidence/query hash/skill version/policy hash 的 append 必须失败。`proposed` 默认不进入 Agent 上下文，confirmed 才进入；用户纠正通过 superseding revision 表达，旧 revision 仍可审计。生成器默认查询排除 insights；显式 Insight 依赖形成循环时拒绝。

### G10. 订阅交界与恢复

在 replay 高水位 200 同时 append 201：消费者必须收到截至 200 的 replay 和从 201 开始的 live，允许 200/201 在重连边界重复但不得漏失。用 cursor 重连可继续；早于 retention 返回 `cursor_expired`。semantic stage 与无 `within` 的否定模式必须拒绝 subscription mode。

### G11. SQL 一致性

在同一 `asOfSeq`、ASP projection 与 ACL 下，SQL `messages/tools/approvals` 的选择、过滤与支持的聚合必须等于 SessionQL 对应投影。SQL 写操作必须失败；semantic search 和 subscribe 不得被宣称为 SQL capability。

## 12. 错误模型与互操作要求

错误至少区分：`parse_error`、`type_error`、`unsupported_version`、`unsupported_capability`、`invalid_parameter`、`permission_denied`、`freshness_timeout`、`cursor_mismatch`、`cursor_expired`、`resource_limit`、`index_unavailable`。错误应带稳定 code、安全 message、可选 source span 和 retryability；不得用空结果表示错误。

conformance suite 应使用同一 canonical fixtures 对至少两个执行器或一个执行器的两种规划路径运行 golden cases，并比较 canonical rows、排序、score、`asOfSeq` 和错误 code。浮点 score 比较必须规定精度；RRF 应优先用有理 rank 贡献或固定 IEEE 754 计算次序。

## 13. 分阶段交付

1. 发布语法 grammar、IR JSON Schema、capability discovery 与 G1/G2 fixtures；
2. 实现结构查询、稳定分页、watermark/generation 与 explain；
3. 实现全文、chunk、向量与 hybrid RRF；
4. 实现 match、lineage、Resume descriptor；
5. 实现确定性订阅、Insight stream 与只读 SQL attachment。

任一阶段都不得让 sidecar 写入或修正 L1。SESDB 可以按阶段成为参考执行器，但其私有 API、存储布局和优化不会自动成为规范。

## 14. 设计依据

SessionQL 借鉴 TraceQL/LogQL 的管道与结构查询方式，事件模式语义参考 Flink `MATCH_RECOGNIZE` 的有界匹配思想，SQL attachment 采用 DuckDB/Parquet 的只读分析生态。上述系统只提供设计参照；本 RFC 的语法、IR、默认排序、一致性和安全边界以本文为准。

## 15. 未决事项

以下内容留待后续 RFC，不阻塞 v1：

- 历史时间点 fork 与跨 Runtime handoff admission；
- 分布式多节点 `globalSeq` 分配和跨库 federation；
- 可证明删除、密钥擦除与跨 sidecar retention 的统一协议；
- 自定义 analyzer/embedding 的可移植 capability profile；
- 执行前 Tool admission/阻断协议。
