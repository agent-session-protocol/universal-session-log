# SESDB 交付路线：v0.2 收口、I0 五 Provider、Skill 与 Memory

> 状态：执行中  
> 制定日期：2026-09-01  
> Obelisk 验收基线：[`tommy0103/obelisk@f256668`](https://github.com/tommy0103/obelisk/tree/f25666800cda53d78b4304bcd793b6e65a5aad21)（冻结，不自动前移）  
> 配套账本：[Obelisk 与 SESDB：冻结基线和交付账本](2026-09-obelisk-vs-sesdb.md)

## 目标与固定顺序

交付顺序固定为：

1. **可靠性与发布**；
2. **可验证 provenance**；
3. **五 Provider 与 I0**；
4. **Agent Skill**；
5. **人工批准 Memory**。

`v0.2.0-alpha.0` 可以在 I0 仍为 `in-progress` 时发布，但发布前必须通过
daemon durability、CJK 搜索、安全、四平台 CI 和 tarball journey。Alpha 不得
宣称 I0 已通过或已经实现完整 Obelisk parity。

上游新进展进入滚动观察账本，不改变冻结验收靶点。当前观察项包括 Kimi
discovery 变化和 [Obelisk #130](https://github.com/tommy0103/obelisk/issues/130)；
#130 应进入 Codex 写放大回归测试。

## 执行起点

制定本路线时，`origin/main` 比本地实现基线多两个 Site/GEO 提交；最近一次已知
[CI 失败](https://github.com/agent-session-protocol/universal-session-log/actions/runs/33478022938)
来自架构 Wiki 漂移。开始实现前必须先建立安全快照并完成非破坏性对齐，不能用
SESDB 重放覆盖这些 Site/SEO/GEO 工作。该记录只描述执行起点，不作为持续更新的
仓库状态页。

## A. `v0.2.0-alpha.0`：可靠性收口与发布

### A1. 安全对齐工作树

- 创建完整工作树安全快照，确认可恢复后再快进到 `origin/main`。
- 重放 SESDB 改动时，远端已有 Site/GEO 文件以远端版本为准，只合并 Console
  daemon adapter 所需改动。
- 不覆盖或回退现有 Site/SEO/GEO 工作。

### A2. sidecar 恢复与单写者可靠性

- writer 从 L1 replay 建立 canonical event ID、source checkpoint 和 visibility
  状态，不依赖 SQLite 判断采集幂等。
- 当 `builtThroughSeq < L1 nextSeq` 时补做 projection；schema 或 integrity 不匹配
  时全量重建。
- sidecar 事务失败后停止继续采集、标记 `degraded`，并自动 catch-up 或 rebuild。
- 恢复过程不得重复 canonical event；允许保留 orphan evidence。
- retraction 与 supersede 必须同步修正 session visibility。

### A3. 分层 watcher

用提示、热文件轮询和兜底审计替代“每 2 秒读取全树内容”：

- `notify` 只作为变化提示，不作为一致性来源。
- 长期开启的活跃 transcript 进入最多 64 个 hot-file 集合，每 2 秒检查
  stat/fingerprint。
- 每 30 秒执行一次完整 inventory/fingerprint audit，保证 watcher 丢事件后最终一致。

### A4. CJK 与 bounded 搜索

- SQLite schema 升级时自动重建 projection。
- 保留 `unicode61`，新增 trigram FTS。
- 中英混排及长度至少 3 字符的查询走 trigram。
- 1–2 字查询走参数化、有执行预算的 bounded fallback。
- 查询结果显式返回 `partial` 和 `matchMode`，不得把预算截断伪装成完整结果。

### A5. API 安全边界

- 所有错误响应固定包含 `details`。
- 精确解析并校验 `Host` 与 `Origin`，不使用前缀或子串匹配。
- 一次性 browser code 必须有 TTL。
- 浏览器 cookie 只授予读取能力；所有管理操作必须使用 bearer token。

### A6. 发布门槛

- 修复架构 Wiki 漂移。
- 远端矩阵覆盖 macOS arm64、macOS x64、Linux x64 和 Windows x64。
- 完成隔离安装的 tarball journey。
- 所有门槛通过后才创建 `v0.2.0-alpha.0` tag。

## B. `v0.2.0-alpha.1`：provenance 与 conformance

### B1. 更正既有声明

为 [#16](https://github.com/agent-session-protocol/universal-session-log/issues/16)
追加更正说明，不静默编辑旧回复：

- 当前只有部分 importer 提供 `sourceSha256`。
- 当前 bundle 的动态 `createdAt` 使其尚不具备字节确定性。
- 确定性只证明结果可复现，不能单独证明没有遗漏 native record。

新建独立的 byte-verifiable provenance issue，并让
[#1 conformance kit](https://github.com/agent-session-protocol/universal-session-log/issues/1)
和 #16 显式依赖它。

### B2. `asp-bundle/v2`

默认写 v2，继续读取 v1。v2 至少包含：

- `SourceArtifact`：逻辑路径、角色、大小、SHA-256 和 capture mode。
- `SourceProvenance`：native format、排序后的 source set、adapter
  id/version/revision。
- 基于稳定 canonical JSON 的 bundle integrity digest。
- 从源数据派生的稳定 `createdAt`。
- 默认不序列化绝对 HOME 路径。

### B3. 验证器与共享 conformance runner

新增 `usl-convert verify` 和共享 conformance runner，并验证：

- 修改任一源字节必须失败。
- 同一 source set 与 adapter 版本必须生成 byte-identical bundle。
- 每条非空 native record 必须映射到 evidence、明确声明 loss，或确定性失败。
- SQLite 使用事务一致的 backup artifact；声明应明确其证明的是一致快照，而非动态
  live-file 的逐字节身份。

发布 `@agent-session-protocol/usl-convert@0.2.0-alpha.0`。adapter registry 统一
CLI dispatch、format listing 和 conformance。

## C. `v0.2.0-beta.0`：五 Provider 与 I0

### C1. 多 artifact Provider contract

Rust `ProviderAdapter` 升级为 source unit 模型：

```text
discover -> SourceUnit[]
snapshot -> SourceSnapshot
parse -> canonical events + EvidenceSpan[]
```

contract 还必须包含 typed tree/exact-file watch targets 和 provider health。

### C2. 生产 adapters

按以下顺序补齐：

1. **Pi**：复用现有 TypeScript importer fixture 做 differential testing。
2. **Kimi**：支持 `state.json`、main/sub-agent `wire.jsonl` 和父子关系。
3. **DeepSeek Harness**：支持 `.jsonl.zstd`、chunk message 重组以及 tool
   call/result linkage。

与现有 Claude/Codex 一起形成五 Provider。Provider 默认 disabled；discover 只读
路径与 stat，不读取内容或产生写入。

### C3. clean-room corpus

建立可再分发的五 Provider 原生语料，覆盖：

- main/subagent；
- tool call/result；
- summary 与 partial write；
- rewrite/truncate；
- undo/clear；
- archive/delete。

不支持的行为必须明确标为 `unsupported`，不能当成空结果或成功。

### C4. parity runner 与 benchmark

- 新增隔离 HOME 的 SESDB runner 和 Obelisk runner。
- 在同一台机器运行 100/1k/10k 规模测试。
- 记录硬件、版本、冷建索引、noop reconcile、append-to-search p50/p95、重建、
  RSS、sidecar 大小和 SQLite 写入数。
- 基线继续对固定 commit 验收。
- 新增 `upstream-watch.json`，记录当前上游 commit、#130、same-mtime、watcher、
  CJK 等观察项，但不得自动移动 I0 靶点。

只有 corpus、两套 runner、journey 和硬件结果全部齐全后，I0 才能从
`in-progress` 改为 `passed`。

## D. `v0.3`：Agent Skill 与查询体验

- 发布只调用 localhost API/CLI 的 SESDB Skill；Skill 不得直接打开 SQLite。
- Skill 默认 bounded、active-only，并返回 generation、`asOf`、`builtThrough`
  和 evidence 回链。
- 未知 filter 必须 fail closed。
- 补齐 provider/project/session/time filters、session timeline window 和可执行的
  query diagnostics。
- Console 展示真实 freshness、degraded 和 rebuild 状态。
- Hosted 模式始终是严格 Demo，不探测或请求 localhost。

## E. 后续：人工批准 Memory，再评估 Desktop

- Memory 只能由用户显式批准后保存，并记录 evidence seq、scope、revision 和撤销
  控制。
- 未批准候选内容不进入默认检索。
- Agent Skill 只暴露 approved/active memory。
- Console 提供 review、approve、revoke 和 source inspection。
- Tauri、semantic/vector search 和自动 Skill discovery 排在 Memory 闭环之后，
  不进入下一轮 I0。

## Issue 与 milestone 整理

- 将现有 `v0.2 Adapter Foundation` 重命名为
  `usl-convert v0.2 Adapter Foundation`，避免与 SESDB 版本混淆。
- 新建 `SESDB v0.2 Alpha` 与 `SESDB I0 Obelisk Parity` milestones。
- 新建 SESDB parity epic，并拆出 daemon recovery、provenance、Pi/Kimi/DeepSeek
  provider、corpus/runner 和 benchmark 子 issue。
- [#19](https://github.com/agent-session-protocol/universal-session-log/issues/19)
  继续负责 converter/Gemini/OpenCode/ACP 路线，不改造成 SESDB epic。
- #5/#8 与 Rust provider issue 共享 fixture，但互不冒充完成。
- #16 在 provenance 和 #1 完成前保持 `blocked`/`needs-fixture`。

## 总体验收清单

### Workspace 与发布

- [x] Rust workspace 全绿（本地 macOS arm64，2026-09-01）。
- [x] `packages/usl-convert` 全绿（本地，2026-09-01）。
- [x] `packages/sesdb` 全绿（本地，2026-09-01）。
- [x] Site build 全绿（本地，2026-09-01）。
- [x] 架构 verifier 与 Obelisk baseline verifier 全绿（本地，2026-09-01）。
- [x] 隔离 tarball journey 全绿（本地 macOS arm64，2026-09-01）。
- [x] 四平台 GitHub CI 全绿后才发布 tag（CI run `33517726286`；
  `v0.2.0-alpha.0` release run `33518018563`，2026-09-01）。

### Durability

- [x] kill-point 覆盖 evidence、canonical、checkpoint、flush、sidecar transaction
  和 generation switch。
- [x] sidecar 删除或 schema 损坏后可仅从 L1 完整重建。
- [x] 事务失败恢复不重复 canonical event。

### Watcher

- [x] 覆盖 long-open fd。
- [x] 覆盖 same mtime。
- [x] 覆盖 same-size rewrite。
- [x] 覆盖 partial line。
- [x] 覆盖 watcher 丢事件。
- [x] 覆盖删除 grace。

### Provenance

- [x] 覆盖单文件与多文件 source set（`packages/usl-convert/test/provenance.test.ts`，2026-09-01）。
- [x] 覆盖 SQLite transaction-consistent backup snapshot（同上，2026-09-01）。
- [x] 覆盖源字节篡改（同上，2026-09-01）。
- [x] 覆盖移动根目录且不泄漏绝对 HOME（同上，2026-09-01）。
- [x] 覆盖 v1 兼容读取（同上，2026-09-01）。
- [x] 覆盖 byte-identical rerun（四 adapter shared conformance，2026-09-01）。

### Console

- [x] Playwright 覆盖 daemon 真实数据。
- [x] Hosted 模式零 localhost 请求。
- [x] 覆盖 offline、degraded、rebuilding 和 disabled 状态。

500ms append-to-queryable 继续作为优化目标和记录指标，不作为跨平台硬阈值。

## 不变量与边界

- USL L1 始终是唯一权威；SQLite、FTS 和 Console projection 均可删除重建。
- Provider 默认 disabled；discover 只读路径/stat。
- 不复制 Obelisk AGPL 实现；只使用冻结行为、公开文档、clean-room fixture 和
  黑盒 journey。
- Alpha 不宣称 I0 已通过，也不宣称完整 Obelisk parity。
- 路线中的能力只有在实现、文档、端到端测试和可观测指标同时具备后，才能从
  `specified`/`planned` 升为 `delivered`。
