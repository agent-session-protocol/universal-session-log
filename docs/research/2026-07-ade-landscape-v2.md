# ADE（Agent Development Environment）调研报告 v2

> 日期：2026-07-30 · 状态：**已按圆桌结论修订**（取代 v1 `2025-07-ade-landscape.md`）
> 修订依据：`2026-07-roundtable-herdr-fork-nervafs.md`（4-agent 圆桌，k3 / gpt-5.6-sol / glm-5.2 / deepseek-v4-pro，三轮讨论）
> v1 被推翻的表述：①"TUI-first 是极简定位的天然护城河" ②"内核四组件即差异化"

---

## 1. ADE 是什么：一个新分层正在形成

AI coding 架构清晰分成四层：

| 层 | 角色 | 代表 |
|---|---|---|
| Model | 推理 | Claude / GPT / Gemini |
| **Harness** | 驱动模型的循环：tool、上下文、会话、权限、MCP | **pi**、Claude Code、Codex CLI |
| **ADE（本赛道）** | 管理"开发者 + 多 harness/agent + 环境"的编排层 | Orca、Superset、cmux、herdr |
| Environment / Substrate | agent 运行的计算/文件系统/网络/治理 | 本地 worktree、devcontainer、SSH、sandbox、**NervaFS** |

**类比关系（e 的 pitch）**：`pi : Claude Code = e : VS Code(+Copilot/Cursor)`

pi 证明 harness 层"极简内核 + 扩展"能赢。ADE 层还没有这样的玩家——现有产品全是"功能全家桶"。**但注意：herdr 已经占据了"ADE 层的极简 multiplexer"生态位（见 §2.3），e 的空档不在"极简 TUI"，而在"可嵌入 runtime + 生态"（见 §4）。**

---

## 2. 竞品格局

### 2.1 完整 ADE（全家桶路线）
- **Orca**（onorca.dev）：桌面 GUI，worktree 隔离 + 并行跑所有 CLI agent + 内嵌终端/浏览器 + CLI/SDK/MCP，YC。本项目当前即运行在其 worktree 中。
- **Superset**（superset-sh/superset）：macOS 桌面，"The Code Editor for AI Agents"，内置 terminal/diff viewer/浏览器/远程 host，开源。
- 闭源参照：Conductor、Cursor multi-agent。

### 2.2 Terminal App 路线
- **cmux**（manaflow-ai/cmux）：Ghostty 内核 macOS 终端。通知环/面板、垂直 tab 元数据（branch/PR/端口）、内嵌浏览器、`cmux ssh` 远程 workspace（浏览器流量走远程网络）。哲学：不改 agent 工作方式，只让人类同时看管多个 agent 变容易。
- **Warp**：商业化，harness+ADE 混合，闭源。

### 2.3 TUI 路线：herdr —— 关键参照物
- **herdr**（herdrdev/herdr，Rust，~22k stars，高增长，Apache-2.0）
- 四支柱：真实终端视图（不做"包装过的解释"）、持久 session 多路复用（detach/reattach/SSH/重启存活）、**agent 可用的纯 socket API**（agent spawn pane、读输出、互相等待）、TUI 极简
- **圆桌判定（4/4）：herdr 已占据"ADE 层极简 multiplexer"生态位。e 的内核四组件中 session/status/socket 三件是 herdr 既有能力，worktree 差异"一个周末能补齐"。做"TUI 版 herdr"必输。**

### 2.4 结构化对话 UI 参照
Copilot Chat / Codex 插件 / Claude Code 插件 / Cline / Roo Code 证明 webview 是对话式 agent UI 的事实标准载体，但均与各家私有协议绑定，无"通用对话 Tab"标准。

---

## 3. 要不要兼容 VS Code 架构？（维持 v1 结论，圆桌未推翻）

**放弃"兼容"，保留"能力"。**
- Codex/Claude Code 插件闭源，无法平迁；Port Forwarding 耦合在专有 Remote 扩展 + vscode-server 里；SSH Remote 的复杂度来自"远程跑完整扩展宿主"——ADE 不需要。
- 兼容 = 继承 extension host + 上万 API 的全部重量（code-server 的教训），换来的生态大部分用不上。
- 正确姿势是提取三个好思想，用 pi 的方式重实现：
  1. **JSON-RPC 扩展宿主**（pi 已是此形态）
  2. **贡献点模型**——插件声明"我贡献面板/命令/agent 适配器"。VS Code 生态繁荣的真正原因，实现成本低、生态收益高。**（圆桌确认：这是 e 对 herdr 的核心胜负手，见 §4.2）**
  3. **Remote 一等公民**——但只做 SSH 连接池 + 远程 pty + local forward（cmux 已证明够用），不做 vscode-server。
- 对话 Tab 不做平迁，做**适配器**：定义最小 AgentSession 协议，各 harness 写薄适配器接入。

---

## 4. e 的定位（v2 修订核心）

### 4.1 一句话定位（修订后）

> **e 是 ADE 层的可嵌入 runtime：headless core + 贡献点 package 生态 + 跨 harness 结构化 AgentSession 标准。TUI 只是参考客户端。**

命名叙事不变：e = environment，Euler's number（自然增长的底数 = 生态自然生长），与 pi 成数学双璧。

### 4.2 对 herdr 的差异化（圆桌 R1 收敛）

**不是内核，是三件 herdr 做不了/不会做的事：**

1. **headless 可嵌入 runtime**——herdr 的身份就是 TUI multiplexer，multiplex 逻辑与 TUI 渲染是同一 Rust 二进制，它不会把自己拆成别人能嵌入的底座。e core = headless JSON-RPC，同一协议驱动 TUI（参考客户端）/未来 GUI/嵌入 Orca 当 runtime/远程/agent。**这是架构级差异，不是功能级差异。**
2. **贡献点 package 生态（TS + npm）**——herdr 是 Rust 单体，无声明式贡献点、无包市场。"VS Code 的胜利不是编辑器内核赢了，是贡献点模型赢了。e 不能跟 herdr 比谁 multiplex 得更好，要比谁能让生态在其上生长。"（deepseek-v4-pro）
3. **跨 harness 结构化 AgentSession 标准**——类型化事件（message/tool/approval/artifact/task），而非解析 PTY 文本。herdr 的哲学就是"真实终端视图、刻意不解释 PTY"，在其架构上叠加解释层 = 架构精神分裂（glm-5.2）。PTY 输出解析只作旧 harness 的降级路径。

**冷启动死线（glm-5.2）：不借 pi 社区冷启动（共享 TS + package 格式 + 明牌"pi 的 ADE"）就不立项。**

**最大风险（k3）**：herdr 的 socket API 在 6-12 个月内成为事实标准锁定生态位 → 对策见 §4.3 协议兼容。

### 4.3 与 herdr 的关系：不 fork，协议兼容（圆桌 R2 收敛，4/4）

**不 fork herdr 代码**——技术（改造=重写级，可复用两三成；Rust core 接不进 pi 的 TS 包生态）、社区（寄生 fork 论战默认输）、法律（Apache-2.0 允许但"合法"不是理由）三输。

**第三条路（4/4 收敛）：**
- e core 用 TS 干净重写（与 pi 同栈），herdr 协议兼容做成 `e-herdr-compat` 包——wire 上说 herdr 的 socket 协议，让现有 herdr-aware agent 直接驱动 e
- 推动 herdr 上游拆出稳定 daemon/socket 协议并贡献小改动；**herdr 作为 e 的首个可替换 session backend**（保留 tmux/自研 backend）
- 叙事："**说所有人协议的 runtime**"——说 herdr 的 agent API、说 pi 的 package 格式、再加新的类型化 AgentSession
- 仅当上游拒绝关键 daemon 化补丁且源码审计证明边界清楚时，才维护明确标注来源的窄 fork（gpt-5.6-sol）
- "代码是负债，协议是资产。"（glm-5.2）

### 4.4 架构图景

```
┌─ e core (TS, ~500行级, headless, 零外部依赖) ─────────────┐
│  workspace / session(pty mux) / status / JSON-RPC socket  │
│  + 窄接口: WorkspaceStore · EventSink · Audit capability  │
│  默认实现: 本地目录 / sqlite（e init 裸目录可跑）           │
└───────────────────────────────────────────────────────────┘
        ▲ 同一协议                    ▲ 贡献点
   TUI (参考客户端)              ┌────┴─────────────────┐
   未来 GUI/webview              │ packages             │
   嵌入 Orca 当 runtime          │ e-herdr-compat (协议) │
                                │ e-nervafs (审计后端)  │
                                │ e-review / e-preview…│
                                └──────────────────────┘
   数据面之下: herdr 可作为首个可替换 session backend（非 fork）
```

### 4.5 内核 vs package 边界

**core 只含**：workspace（repo/worktree 抽象）、session（持久 pty 多路复用）、status（agent 状态检测）、api（JSON-RPC socket，人/CLI/agent/插件共用）+ 窄接口（WorkspaceStore/EventSink/Audit capability，默认本地目录/sqlite 实现）。

**全部交给 package**：review（diff 查看/批注）、preview（端口检测/转发/浏览器）、remote（SSH workspace）、chat（AgentSession 对话 Tab）、orchestrate（多 agent 编排）、notify（OS 通知）、herdr-compat、nervafs。

### 4.6 与 NervaFS 的关系：分层结合（圆桌 R3 收敛，4/4）

**NervaFS 永远只做可选 package/backend（`e-nervafs`），绝不进内核。**

- **唯一天作之合**：AgentSession 类型化事件流 × NervaFS audit-on-by-default = "默认产出结构化、可审计、可治理 agent 活动日志的 runtime"，切 herdr 完全不碰的企业/合规痛点
- 其余结合点牵强或反向：workspace 元数据（.e/ 目录或 sqlite 就够）、session scrollback（PTY 流不是文件系统形态）、package 分发（4/4 否决，"别发明轮子"，用 npm/git）
- "不纯粹"风险真实且生死级，但**风险源不是 FUSE，是"强制"**——强制 FUSE 同时杀掉"可嵌入"生路和"比 herdr 更轻"叙事；可选则 FUSE 退化为高级特性
- pi 式极简不是代码少，而是**默认路径概念少、依赖少**。"FUSE is all agents need"可以是 NervaFS 的命题，不能成为 e 的前置假设（gpt-5.6-sol）

**六道硬约束（写入 RFC-0）：**
1. 核心零 FUSE 假设——`e init` 在无 NervaFS 机器上跑得起来（不可让步的红线）
2. 接口中立——core 不得 import NervaFS 特有概念
3. 卸载不降级——卸载 e-nervafs 后核心功能不降级
4. 协议无专有字段——AgentSession 规范真源是实时类型化事件，文件只是可验证投影
5. 两项目独立发布，任何 workspace 可显式导出到普通目录
6. audit 是唯一默认桥接面

**⚠️ 治理风险**：发起人同时做 e 和 NervaFS，有动机把 e 设计成 NervaFS 获客通道。e 的中立性是借 pi 社区冷启动的前提，一旦被读成"NervaFS 专用 runtime"冷启动当场归零。**NervaFS 应该因为"接口最全、做得最好"而赢，不该因为"被 e 绑定"而赢。**

---

## 5. 风险（v2 更新）

1. **冷启动赌局**：package 生态对 22k 星在位者零起步，生死线是完全绑定 pi 社区势能（TS + package 格式 + "pi 的 ADE"品牌）。前 10 个官方包必须覆盖 80% 场景。
2. **herdr socket API 成为事实标准**（6-12 个月窗口，k3）→ 对策：e-herdr-compat 协议兼容，把 herdr 的网络效应变成 e 的入口而非壁垒。
3. **状态检测脆弱性**：blocked/working/done 依赖启发式解析 → 定义 agent 侧主动上报协议（OSC/MCP/hook），pi 原生精确上报，启发式只作 fallback。
4. **TUI 表达力上限**：diff review、对话 UI 体验受限 → core headless 可替换 frontend；webview 面板可作 package（herdr 不做，差异点）。
5. **捆绑冲动**（同一发起人做 e + NervaFS）→ 六道硬约束物理拦截（§4.6）。
6. **TS 重写的可靠性坑**（gpt-5.6-sol 提醒）：PTY/进程/持久化数据面 Rust 有优势，TS 重写需把 session 数据面的可靠性工程（缓冲、重连、崩溃恢复）列为 core 的第一批测试目标，不能因"~500 行"的叙事低估。

---

## 6. 建议的下一步

1. **RFC-0**：core 四组件 API 草案 + 窄接口（WorkspaceStore/EventSink/Audit）+ 六道 NervaFS 约束 + 贡献点 manifest 草案
2. **Spike**：单文件原型证明"持久 pty session + socket reattach + 状态检测"（~500 行），同时把可靠性工程（缓冲/重连/崩溃恢复）列为验收项
3. **狗食包**：`e-notify`、`e-preview` 先行；`e-herdr-compat` 做协议兼容验证；`e-nervafs` 做分层结合验证（audit 桥接）
4. **上游接触**：向 herdr 提 daemon/socket 协议拆分议题，探合作意愿（决定"兼容包"还是"窄 fork"路径）
5. **pi 对齐**：pi 侧状态上报 hook 最小改动；package 格式复用确认
