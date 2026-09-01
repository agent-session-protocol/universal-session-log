---
sources:
  - packages/usl-convert/src/bundle.ts a7fe35aa4a9e SessionBundle validateBundle makeBundle
  - packages/usl-convert/src/evidence.ts 5a32569bbef3 EvidenceBuilder importSourceFor
  - packages/usl-convert/src/pi.ts 2085fb9cc2f1 importPiSession exportPiSession
  - packages/usl-convert/src/dimagent.ts 4b75499211bd importDimagentSession exportDimagentSession
  - packages/usl-convert/src/claude.ts 10ffa9ce37bc importClaudeSession
  - packages/usl-convert/src/codex.ts 1ad3bfbbf7f4 importCodexSession exportCodexSession
  - packages/usl-convert/src/cli.ts 3d4127b793a0 main
  - packages/usl-convert/src/registry.ts b902040ee78e ADAPTER_REGISTRY adapterFor
  - packages/usl-convert/src/conformance.ts 4f65a7b5d384 runConformance
  - packages/usl-convert/src/materialize.ts f2c7b312f69c buildSnapshot
covers:
  - packages/usl-convert/
---

# e-session-convert：跨 harness 转换层

## 职责

把四种 harness 的原生 session log（pi JSONL、dimagent sqlite、claude JSONL、codex rollout）导入统一的 `asp-bundle/v2` 枢轴，再导出回任意支持的目标格式。这是 USL「resume/handoff」的参考实现：bundle 的 `pivot` 是派生快照，`evidence` 是完整事件流（WAL 角色），转换保真靠 evidence 而非投影。v2 额外记录可移动的源 artifact 集合、adapter revision 和 canonical JSON 完整性摘要；v1 只保留兼容读取。

## 对外接口

- `importPiSessionFile / importClaudeSessionFile / importCodexSessionFile / importDimagentSession` — 各 harness 的 importer，见各自文件。
- `exportPiSession / exportDimagentSession / exportCodexSession` — 各目标格式的 exporter。
- `validateBundle / makeBundle / verifyBundleSources`（`bundle.ts`）— bundle 不变式、内部 digest 与源 artifact 字节硬检。
- `ADAPTER_REGISTRY / adapterFor`（`registry.ts`）— import/export、格式列表和 conformance 共用的单一注册表。
- `runConformance`（`conformance.ts`）— 同源重跑字节一致、artifact 校验和每条 native record 的 evidence/loss 对账。
- CLI 入口 `main()`（`cli.ts`）：`import/export/convert/verify/conformance/inspect/list-formats` 子命令。

## 数据怎么流

importer 先把原生字节或 SQLite transaction-consistent backup 固化成排序后的 source set，再逐条映射成 canonical event（`EvidenceBuilder.emit`，事件 id 由内容寻址确定 → 幂等），攒成 evidence 流；`buildSnapshot` 把事件按 run/turn/message/tool 分组物化成 pivot。bundle 的 `createdAt` 从 evidence 派生，最后用稳定键序 canonical JSON 计算 integrity digest；绝对 HOME 路径不进入 v2。exporter 反向时优先用 evidence 里存下的原生负载逐字还原，缺失才合成并声明 loss。

## 改动指南

- 加 harness 先看 `bundle.ts` 的 `HARNESSES`、`evidence.ts` 的 `EvidenceBuilder` 和 `registry.ts` 的 `ADAPTER_REGISTRY`，再照着 `pi.ts`/`claude.ts` 的 importer 结构写 adapter；不要在 CLI 另建 dispatch 分支。
- 改 fidelity 矩阵：每轴 `preserved/partial/evidence-only/dropped/not-in-source` 必须在 importer 里逐条声明（`loss`/`fidelity`），不能只写 README。
- 坑一：**unknown block 幂等**——任何 canonical→native→canonical 重编码路径都不能二次包裹 `unknown` block（`pi.ts` 的 `piBlocksToCanonical` 和 `canonicalBlocksToPi` 都有专门分支；e-core `normalizeContent` 同款 bug 已修）。
- 坑二：**tool result 形状随 harness 变**——pi 用 `[text]` 块、codex 用 `[tool-result]` 块 + 工具实体 `result`。exporter 一律从工具实体取 result，别依赖 message 块形状。
- 坑三：dimagent 是 SQLite，读取必须走 SQLite backup API 并保留 snapshot artifact。它证明事务一致快照，不证明动态 live file/WAL 的逐字节身份。
- 坑四：确定性只能证明给定 source set 与 adapter revision 可复现；native record 是否遗漏必须由 `runConformance` 的 evidence/loss 对账单独证明。
- 测试门槛：`npm run check` 全绿，且 provenance 覆盖单/多文件、SQLite snapshot、篡改、移动根目录、v1 读取和 byte-identical rerun。
