---
sources:
  - packages/usl-convert/src/bundle.ts e4065ba3e060 SessionBundle validateBundle makeBundle
  - packages/usl-convert/src/evidence.ts 5a32569bbef3 EvidenceBuilder importSourceFor
  - packages/usl-convert/src/pi.ts 0ca0719d75fd importPiSession exportPiSession
  - packages/usl-convert/src/dimagent.ts ca2682e02dae importDimagentSession exportDimagentSession
  - packages/usl-convert/src/claude.ts c73673c89753 importClaudeSession
  - packages/usl-convert/src/codex.ts 2a0be20eaf1b importCodexSession exportCodexSession
  - packages/usl-convert/src/cli.ts 8871ac368eb8 main
  - packages/usl-convert/src/materialize.ts f2c7b312f69c buildSnapshot
covers:
  - packages/usl-convert/
---

# e-session-convert：跨 harness 转换层

## 职责

把四种 harness 的原生 session log（pi JSONL、dimagent sqlite、claude JSONL、codex rollout）导入统一的 `e-session-bundle` 枢轴，再导出回任意支持的目标格式。这是 USL「resume/handoff」的参考实现：bundle 的 `pivot` 是派生快照，`evidence` 是完整事件流（WAL 角色），转换保真靠 evidence 而非投影。

## 对外接口

- `importPiSessionFile / importClaudeSessionFile / importCodexSessionFile / importDimagentSession` — 各 harness 的 importer，见各自文件。
- `exportPiSession / exportDimagentSession / exportCodexSession` — 各目标格式的 exporter。
- `validateBundle / makeBundle`（`bundle.ts`）— bundle 不变式硬检。
- CLI 入口 `main()`（`cli.ts`）：`import/export/convert/inspect/list-formats` 子命令。

## 数据怎么流

importer 把原生条目逐条映射成 canonical event（`EvidenceBuilder.emit`，事件 id 由内容寻址确定 → 幂等），攒成 evidence 流；`buildSnapshot` 把事件按 run/turn/message/tool 分组物化成 pivot；`validateBundle` 硬检 `pivot.revision === evidence.length` 等不变式。exporter 反向：优先用 evidence 里 importer 存下的原生负载逐字还原（claude `signature`、codex `encrypted_content`/`session_meta`），缺失才合成并声明 loss。

## 改动指南

- 加 harness 先看 `bundle.ts` 的 `HARNESSES`（注册表）和 `evidence.ts` 的 `EvidenceBuilder`（事件构建），再照着 `pi.ts`/`claude.ts` 的 importer 结构写 `src/<harness>.ts`，CLI 里接 `import/export/convert` 分支。
- 改 fidelity 矩阵：每轴 `preserved/partial/evidence-only/dropped/not-in-source` 必须在 importer 里逐条声明（`loss`/`fidelity`），不能只写 README。
- 坑一：**unknown block 幂等**——任何 canonical→native→canonical 重编码路径都不能二次包裹 `unknown` block（`pi.ts` 的 `piBlocksToCanonical` 和 `canonicalBlocksToPi` 都有专门分支；e-core `normalizeContent` 同款 bug 已修）。
- 坑二：**tool result 形状随 harness 变**——pi 用 `[text]` 块、codex 用 `[tool-result]` 块 + 工具实体 `result`。exporter 一律从工具实体取 result，别依赖 message 块形状。
- 坑三：dimagent 是 SQLite，读取走 WAL-copy（复制 `.sqlite`+`-wal`+`-shm` 到临时目录再开副本），源文件字节级校验不变。
- 测试门槛：`npm run check` 25 个全绿（含 pi↔codex、codex→codex、claude→pi 三条 roundtrip）。
