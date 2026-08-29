# ADE（Agent Development Environment）调研报告

> 日期：2025-07-30 · 状态：调研结论 + `e` 定位建议
> 目标：搞清楚 ADE 赛道现状，回答"要不要兼容 VS Code 架构"，给出 `e` 的核心架构建议。

---

## 1. ADE 是什么：一个新分层正在形成

AI coding 的架构正在清晰分成四层：

| 层 | 角色 | 代表 |
|---|---|---|
| Model | 推理 | Claude / GPT / Gemini |
| **Harness（脚手架）** | 驱动模型的循环：tool 定义、上下文管理、会话持久化、权限、MCP | **pi**、Claude Code、Codex CLI、pi-mono |
| **ADE（本赛道）** | 管理"开发者 + 多个 harness/agent + 环境"的编排层：并行隔离、状态监控、review、远程开发、插件生态 | Orca、Superset、Conductor、cmux、herdr |
| Environment | agent 实际运行的计算/文件系统/网络 | 本地 worktree、devcontainer、SSH 主机、云 sandbox |

**类比关系（即 `e` 的 pitch）**：

```
pi : Claude Code  =  e : VS Code(+Copilot/Cursor)
```

pi 证明了 harness 层"极简内核 + 扩展"能赢。ADE 层还没有出现这样的玩家——现有产品全是"功能全家桶"路线。这就是 `e` 的空档。

**ADE 的核心功能集**（调研后归纳，各家实现程度不同）：

1. **Workspace 管理** — 多 repo、git worktree 隔离、branch/PR 关联
2. **Agent 编排** — 并行跑多个 CLI agent（Claude Code / Codex / pi / 任意）、派发任务、agent 间协作
3. **状态感知** — agent 是 working / blocked / done 的一眼可见（通知环、面板、徽章）
4. **Review 回路** — diff 查看、批注、修改、commit/push，不离开 ADE
5. **Session 持久化** — detach 后 agent 继续跑，跨终端/SSH reattach
6. **Preview & 网络** — dev server 预览、port 检测/转发、内嵌浏览器
7. **远程执行** — SSH 主机、devcontainer、云 sandbox
8. **可编程接口** — CLI / SDK / MCP，让人和 agent 都能驱动 ADE
9. **插件生态** — 用户扩展自己的 ADE 并分享

---

## 2. 竞品格局

### 2.1 完整 ADE（"全家桶"路线）

**Orca**（onorca.dev，当前工作区所运行的环境）
- 定位："The most powerful ADE / Worktree IDE"，免费开源跨平台，YC 背景
- 核心：worktree 隔离 + 并行跑所有 CLI agent + 内嵌终端/浏览器 + CLI/SDK/MCP 全套接口
- 形态：桌面 GUI 应用（重度集成）

**Superset**（superset-sh/superset）
- 定位："The Code Editor for AI Agents"，macOS 桌面应用
- 核心：10+ agent 并行、worktree 隔离、内置 terminal（tab/split/持久 session）、**内置 diff viewer + 编辑器**、内嵌浏览器 + port 预览、远程 host / CLI / SDK / MCP
- 最接近"IDE 级完备度"的开源参照物

**其他闭源参照**：Conductor（macOS，worktree 编排先行者）、Cursor 的 multi-agent、GitHub 的 Copilot Workspace 方向。

### 2.2 Terminal App 路线

**cmux**（manaflow-ai/cmux）
- Ghostty 内核的 macOS 终端，为 AI agent 加了三件事：**通知环/通知面板**（agent 需要关注时高亮）、**垂直 tab 元数据**（branch、PR 状态、监听端口）、**内嵌浏览器**（移植自 vercel-labs/agent-browser）
- `cmux ssh user@remote` 把远程主机变成一个 workspace，浏览器面板流量走远程网络（localhost just works）——这是对 "port forwarding" 问题的一个优雅答案
- 哲学：不改 agent 的工作方式，只让"人类同时看管多个 agent"变容易（"Zen of cmux"）

**Warp** — 商业化终端，Agent Mode 内置 harness，走"终端即 agent"路线，闭源，与 `e` 的极简 + 开源生态定位相反。

### 2.3 TUI 路线

**herdr**（herdrdev/herdr，Rust，~22k stars，增长极快）
- "agent multiplexer that lives in your terminal" —— 关键词是 **multiplexer 而非 IDE**
- 四个支柱：
  1. **真实终端视图**：每个 agent 的状态（blocked/working/done）一眼可见，不做"包装过的解释"
  2. **Session 持久化**：detach 后继续跑，任意终端/SSH reattach，重启存活
  3. **Agent 可编程**：纯 socket API，agent 自己 spawn pane、读输出、互相等待——agent 可以"用" herdr
  4. TUI 极简，Apache-2.0，brew 安装
- herdr 验证了一个重要论点：**ADE 的最小内核 ≈ 持久 session 多路复用 + 状态检测 + 一个 socket API**。它几乎就是 ADE 层的 pi。

### 2.4 结构化对话 UI 的参照

- VS Code 生态里 Copilot Chat、Codex 插件、Claude Code 插件（实际是终端包装 + diff 审批 UI）、Cline/Roo Code（开源 agent 的 webview 对话 UI）证明了 webview 是对话式 agent UI 的事实标准载体。
- 但这些 UI 与各家 agent 私有协议深度绑定，没有一个"通用对话 Tab"标准。**这是生态空白，也是机会。**

---

## 3. 关键问题：要不要兼容 VS Code 架构？

你的原思路：平迁 VS Code 插件生态（Codex/Claude Code 对话 Tab、Port Forwarding、SSH Remote）。逐条拆开看：

### 3.1 VS Code 的"重"不在你想抛弃的地方

VS Code 的架构本质：
- **Extension Host 进程**：插件跑在独立 Node 进程，JSON-RPC 通信——插件崩溃不拖垮 IDE。这个设计本身不算重。
- **vscode.d.ts API 表面**：上万个 API，多数为"文本编辑器"服务（document、selection、diagnostic、folding、semantic tokens……）。
- 真正的重量级来源：编辑器内核（Monaco）、扩展宿主全量 API 实现、update/同步等周边服务。

**ADE 需要编辑器内核吗？** ADE 的编辑需求是 review diff + 偶尔小改，不是主力写码。Superset/Orca 的答案都是内置一个轻 diff viewer，然后"一键在你自己的编辑器里打开"。**把编辑还给用户的编辑器，是 ADE 的正确边界。**

### 3.2 "平迁 VS Code 插件生态"是个错觉

| 你想要的 | 现实 |
|---|---|
| 平迁 Codex/Claude Code 对话 Tab | 这两个插件是**闭源的**，无法平迁；且它们的 UI 与自家协议绑定，没有复用价值 |
| 平迁 Port Forwarding | 实现耦合在 Remote Tunnels / Remote-SSH 扩展（**专有许可**）+ vscode server 二进制里。但能力本身可以用 ~200 行 SSH local-forward 自己实现 |
| 平迁 SSH Remote | VS Code Remote-SSH 的复杂度在于"在远程跑一个完整 vscode-server 来托管扩展宿主"。ADE 不需要远程扩展宿主，只需要远程 shell + 文件 + 端口——ssh2 库级别就能解决 |
| 平迁开源插件（主题、git 工具等） | 必须完整实现 extension host + API 表面（OpenVSCode Server / code-server 走了这条路，结果是背上了整个 VS Code） |

**结论：完全兼容 VS Code 架构 = 继承 VS Code 的全部重量，换来的生态大部分用不上。这个 challenge 成立，原思路应放弃"兼容"，保留"能力"。**

### 3.3 正确姿势：提取 VS Code 的三个好思想，用 pi 的方式重实现

1. **JSON-RPC 扩展宿主** → pi 已经是这个形态（扩展 = 独立模块，事件驱动 RPC）。`e` 的 package/plugin 直接沿用 pi 的模式：TypeScript 模块，声明式激活，窄 API 面。
2. **贡献点（contribution points）模型** → 插件不靠调用 API 堆砌，而是声明"我贡献一个面板 / 一个命令 / 一个 agent 适配器 / 一个 status 源"。这是 VS Code 生态繁荣的真正原因，**实现成本极低、生态收益极高**。
3. **Remote 作为一等公民** → 但不做 vscode-server。`e` 的 remote = SSH 连接池 + 远程 pty + local port forward（cmux 已证明这就够了）。

### 3.4 对话 Tab 怎么办

不做"平迁"，做**适配器**：
- 定义一个最小的 `AgentSession` 协议（消息流 + 工具调用 + 审批请求 + 状态），任何 harness（pi / Claude Code / Codex）写一个薄适配器即可接入。
- 对话 Tab 本身做成一个默认 package（webview 或 TUI 渲染），可以被社区替换。
- pi 自身就是第一个适配器——自家 harness 和自家 ADE 之间的协议可以先内联演进，稳定后再固化。

---

## 4. `e` 的定位建议

### 4.1 一句话定位

> **e 是 ADE 层的 pi：一个极简内核（worktree + session 多路复用 + 状态 + socket API），其余全部由 package 贡献。**

命名恰好成立：`e` = environment，Euler's number（自然增长的底数，暗合"生态自然生长"），且与 pi 形成数学双璧的品牌叙事（π 驱动 circle，e 驱动 growth）。

### 4.2 内核（core）只包含四样东西

对标 herdr 验证过的最小集 + pi 的扩展性：

```
┌─────────────────────────────────────────────┐
│  e core                                     │
│  1. workspace  — repo/worktree 抽象、增删、元数据 │
│  2. session    — 持久 pty 多路复用（detach/reattach）│
│  3. status     — agent 状态检测（blocked/working/done）│
│  4. api        — socket/JSON-RPC：人、CLI、agent、插件共用 │
└─────────────────────────────────────────────┘
   TUI 是默认 frontend，但只是 core 的一个 client
```

关键决策：
- **TUI-first**。GUI 做成 community package（或者干脆让 Orca/Superset 去服务 GUI 用户）。TUI 是极简定位的天然护城河，也和 pi 用户群重合。
- **Session 持久化是内核级能力**（herdr 证明这是杀手特性），不是插件。
- **Agent 是第一类用户**：socket API 让 agent 能 spawn session、读输出、互相等待（herdr 已验证），这让 `e` 同时是"人的 ADE"和"多 agent 的运行时"。
- **不内置编辑器**，提供 `e open <workspace> --editor code|nvim|zed` 的一键交接（Superset/Orca 都这么做）。

### 4.3 全部交给 package 的能力（候选默认包）

| Package | 对应竞品功能 | 备注 |
|---|---|---|
| `e-review` | Superset diff viewer | diff 查看/批注/commit |
| `e-preview` | cmux 内嵌浏览器 + port 检测 | 端口监听 + 转发 + 打开浏览器 |
| `e-remote` | cmux ssh / VS Code Remote | SSH 主机 = 远程 workspace，local forward |
| `e-chat` | Codex/Claude Code 对话 Tab | AgentSession 适配器 + 对话 UI |
| `e-orchestrate` | Orca 多 agent 编排 | 任务派发、agent 间消息 |
| `e-notify` | cmux 通知环 | OS 通知、声音、webhook |

包格式直接借鉴 pi 的 package 规范（manifest + 贡献点声明），让 pi 社区的知识可迁移。

### 4.4 与 Orca 的关系（需要想清楚的现实问题）

当前项目跑在 Orca worktree 里，且 Orca 已经是"功能全家桶"ADE。`e` 的差异化：
- Orca = IDE 级完备 GUI（对标 Superset）；`e` = pi 级极简内核（对标 herdr + 可扩展）
- `e` 可以作为 Orca 的下层 runtime 候选，也可以是独立产品。建议先作为独立极简产品打磨内核与包协议——**内核够小，未来嵌入任何地方都不亏**。

### 4.5 风险

1. **TUI 的表达力上限**：diff review、对话 UI 在 TUI 里体验受限 → 缓解：core 是 headless 的，frontend 可替换；webview 面板可以作为 package 存在（herdr 不做，是差异点）。
2. **状态检测的脆弱性**："blocked/working/done" 依赖对各家 agent 输出的启发式解析 → 缓解：定义 agent 侧主动上报协议（osc 序列 / MCP / hook），启发式只作 fallback。pi 是自家 harness，可以做到原生精确上报。
3. **生态冷启动**：VS Code 生态平迁已证伪，`e` 的包生态从零开始 → 缓解：前 10 个官方包覆盖 80% 场景；包格式与 pi 对齐，借 pi 的社区势能。

---

## 5. 建议的下一步

1. 写 `e` 的 RFC-0：core 四组件的 API 草案（workspace/session/status/socket 协议）
2. 做一个 spike：单文件原型，证明"持久 pty session + socket reattach + 状态检测"能跑（~500 行内）
3. 定义 package manifest 草案（贡献点模型），先写 `e-notify` 和 `e-preview` 两个狗食包
4. 与 pi 团队对齐：pi 侧状态上报 hook 的最小改动

---

## 附录：竞品速查表

| 项目 | 形态 | 开源 | 技术栈 | 核心差异点 |
|---|---|---|---|---|
| Orca | 桌面 GUI | ✅ | — | worktree IDE，全套 CLI/SDK/MCP，YC |
| Superset | 桌面 GUI | ✅ | Electron 系 | 内置 diff viewer/编辑器，远程 host |
| Conductor | macOS GUI | ❌ | — | worktree 编排先行者 |
| cmux | macOS 终端 | ✅ | Ghostty/Swift | 通知环、SSH workspace、内嵌浏览器 |
| Warp | 跨平台终端 | ❌ | Rust | 终端内置 agent（harness+ADE 混合） |
| herdr | TUI | ✅ Apache-2.0 | Rust | 持久 session 多路复用 + agent socket API，~22k★ |
| **`e`（拟）** | **TUI-first, headless core** | ✅ | 同 pi（TS） | **极简内核 + package 生态，pi 的 ADE 对应物** |
