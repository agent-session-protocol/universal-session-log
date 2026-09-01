---
generated: cargo build ; npx -y knip@5 --reporter json --include files,exports,cycles (per TS package; cycles include unsupported) ; npx -y knip@5 --reporter json (per TS package) ; code-map
generated-at: cd30a198a160afa854b4e83bb6f58e9fd4aaeb6a
---

# 体检报告

## 死代码

- Rust（usl-core / usl-capture / usl-fuse / sesdb-engine）：`cargo build` 无 `dead_code` 告警。`cargo +nightly udeps` 未运行（本机无 nightly 工具链）。
- TS SESDB SDK：knip 报 `scripts/smoke-packed-install.mjs` 为未使用文件，但该脚本由 GitHub CI 直接调用，不计为死代码。
- TS Hosted Site：knip 报 `site/lib/cn.ts` 为未使用文件；以文件名与导出名 `cn` 全仓复核后，除定义本身外无引用，确认为 1 个死文件。

### 疑似（存在动态引用痕迹，需人工确认）

2 个文件：SESDB 的 `scripts/smoke-packed-install.mjs` 由 `.github/workflows/ci.yml` 直接调用；Site 的 `public/console-mode.js` 由 `app/console/layout.tsx` 以静态脚本加载。两者都属于工具无法解析的动态入口。knip 对 e-session-convert 报出 26 个未使用导出/类型，Site 另报 3 个公开导出/类型；这 29 个 `deadExports` 作为 API 面保留，不按死文件计数。

## 循环依赖

knip v5 在当前环境拒绝固定命令中的 `cycles` include（`Invalid issue type: cycles`），因此 knip 循环检查未运行。作为降级证据，code-map 中 TS 相对导入单向：SDK → engine client，Site App → Demo adapter，未发现环；Rust workspace 的 crate 依赖为 sesdb-engine → usl-core 与 usl-fuse → usl-capture → usl-core，未发现环。

## 高危热点

12 个月 churn×当前行数的前 10 个源文件如下。Hosted 首页的改动次数最高，而转换器因文件大且多次调整占据其余高位；这是年轻仓库的集中开发区，不代表已发生故障。

| 文件 | 12 个月改动次数 | 行数 |
|---|---:|---:|
| `site/app/(home)/page.tsx` | 8 | 180 |
| `packages/usl-convert/src/codex.ts` | 3 | 414 |
| `packages/usl-convert/src/dimagent.ts` | 3 | 400 |
| `site/app/console/App.tsx` | 2 | 507 |
| `packages/usl-convert/src/pi.ts` | 3 | 331 |
| `packages/usl-convert/src/claude.ts` | 3 | 289 |
| `packages/usl-convert/src/cli.ts` | 3 | 212 |
| `packages/usl-convert/src/asp-schema/agent-session-contracts.ts` | 1 | 423 |
| `packages/usl-convert/test/dimagent.test.ts` | 3 | 121 |
| `site/app/console/api.ts` | 1 | 332 |

## 断点

0 条。code-map 对 e-session-convert、SESDB SDK 和 Site 的 TS/TSX 文件解析无 `error`，相对导入无 `unresolved`。模板字符串动态导入对静态解析不可见，盲区靠死文件复核与工人边界回报兜底。
