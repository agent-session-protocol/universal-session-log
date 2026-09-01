---
sources:
  - site/app/console/App.tsx b91aafd1a769 App
  - site/app/console/api.ts 95d2f2e34691 fetchDashboard fetchSessionDetail fetchGlobalAnalytics
  - site/lib/source.ts a516b27ff313 source getLLMText
  - site/app/(home)/page.tsx 8002382c3d88 HomePage
covers:
  - site/
---

# Hosted Site：产品站与演示 Console

## 职责

把 USL/SESDB 的产品叙事、SessionQL 文档、架构可视化和管理台演示组合成可静态导出的 Next.js 站点。Hosted Console **只使用浏览器内的 Demo adapter 和样例数据**，不启动 SESDB engine，不读取或连接用户的本地数据库。

## 对外接口

- `/`（`site/app/(home)/page.tsx`）— 双语产品首页，链接 RFC、文档、架构图与 Console demo。
- `/docs/**` 及 `llms.txt` / `llms-full.txt`（`site/lib/source.ts` 与 app routes）— Fumadocs 内容源、搜索和面向 LLM 的文本导出。
- `/console`（`site/app/console/App.tsx`）— 会话、全局分析、runtime、存储与完整性的交互演示。
- `site/public/architecture.html` — 从 `docs/architecture/architecture.html` 同步的自包含架构图。

## 数据怎么流

首页和文档路由 Next.js 在构建时读取 MDX 内容，生成静态页、搜索数据和 LLM 文本端点。Console 组件通过 `api.ts` 的 adapter 边界调用 `fetchDashboard`、`fetchSessionDetail` 和 `fetchGlobalAnalytics`。同一份静态导出可由本地 daemon 注入 `mode="daemon"` 并读取 localhost API，同时展示 generation、watermark、provider、degraded 与 rebuilding 状态；但仓库发布的 `site/public/console-mode.js` 永久写死 `mode="demo"`，Hosted 构建只复制、筛选和聚合内建样例，不探测 localhost，也不触达 SDK、daemon 或 usl-core。

## 改动指南

- 改文档导航和导出先看 `site/lib/source.ts`、`site/content/docs/meta.json` 与对应 app route；新文档不要只加文件而忘了导航。
- 改 Console 交互看 `site/app/console/App.tsx`，改数据形状、样例或 daemon adapter 看 `site/app/console/api.ts`。Hosted 的 `console-mode.js` 必须继续固定 Demo；真实后端只能由本地 daemon 同路径覆盖，不能让托管站点自动探测本地 store。
- 架构图先在 `docs/architecture/` 重建并通过 verifier，然后原样同步到 `site/public/architecture.html`，不在 Site 副本上手改。
- 交付前跑 `pnpm --dir site types:check`、`pnpm --dir site build` 和 `pnpm --dir site test:e2e`；本站使用 `output: 'export'` 与 `/universal-session-log` base path，新 route 必须可静态导出。E2E 必须同时守住真实 daemon journey 和 Hosted 零 localhost 请求。
