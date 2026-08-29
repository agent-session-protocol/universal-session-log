# e 项目圆桌纪要：herdr 差异化 / fork 可行性 / NervaFS 结合

> 日期：2026-07-30 · 形式：Orca 编排的 4-agent 圆桌（pi 多模型路由）
> 成员：k3·high、gpt-5.6-sol·high、glm-5.2、deepseek-v4-pro
> 输入文档：`docs/research/2025-07-ade-landscape.md`
> 协调：k3（本 session）

---

## 执行摘要

三轮讨论收敛出 **高度一致的立场**，分歧远小于预期：

| 议题 | 结论 | 一致性 |
|---|---|---|
| R1: e vs herdr 差异化 | 做"TUI 版 herdr"必输；唯一生路是 headless 可嵌入 runtime + 类型化 AgentSession + pi 生态冷启动 | 4/4 |
| R2: fork herdr 可行性 | 不 fork 代码（三输）；第三条路：TS 独立重写 + herdr 协议兼容包 | 4/4 |
| R3: NervaFS 结合 | 分层结合，NervaFS 永远只做可选 package/backend，绝不进内核 | 4/4 |

三轮叠加后的完整架构图景：

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

---

## R1：e 定位 TUI，与 herdr 的区别是什么？

### 共识（4/4）
内核四组件（workspace/session/status/socket）中 **session、status、socket API 三件 herdr 已做成产品并攒下 22k stars**；worktree 是唯一差异但太浅（"一个周末能补齐"，glm-5.2）。**"内核比 herdr 强"不构成差异化。**

### 两派观点

**差异化不成立派（glm-5.2、gpt-5.6-sol）**
- 报告自己承认"herdr 几乎就是 ADE 层的 pi"——这句话已判 e 核心层死刑（glm-5.2）
- package 生态不是护城河是赌命：对 22k 星 Apache-2.0 在位者零起步打不赢冷启动
- herdr 无须改变灵魂就能补 worktree/hook/插件命令；其 socket API 已是编排底座（gpt-5.6-sol）
- **死线（glm-5.2）：不借 pi 社区冷启动（共享 TS + package 格式 + 明牌"pi 的 ADE"）就不立项**

**差异化成立但不在内核派（deepseek-v4-pro、k3）**
- 真正护城河是**贡献点模型**：herdr 是 Rust 单体，无声明式贡献点和包市场。"VS Code 的胜利不是编辑器内核赢了，是贡献点模型赢了。e 不能跟 herdr 比谁 multiplex 得更好，要比谁能让生态在其上生长。"（deepseek-v4-pro）
- TS+npm+贡献点生态 + harness 原生状态上报协议，是 herdr 因技术栈和定位做不了/不会做的（k3）
- 最大风险：herdr 的 socket API 在 6-12 个月成为事实标准锁定生态位（k3）

### 收敛的唯一生路
**headless 可嵌入 runtime，而非"更好的 TUI"**：
- herdr 的身份就是 TUI multiplexer，multiplex 逻辑与 TUI 渲染同一 Rust 二进制，不会拆成可嵌入底座
- e core = headless JSON-RPC，TUI 只是参考客户端，同一协议驱动 CLI/桌面/远程/agent
- 跨 harness 的结构化 AgentSession 标准（类型化事件，非解析 PTY 文本）

**金句**：做"TUI 版 herdr"已经输了；做"ADE 层的可嵌入 runtime + pi 生态入口"才有一战。

---

## R2：直接 fork herdr 改名来做？

### 结论：4/4 反对 fork 代码，全部指向"第三条路"

**技术层面**
- herdr 是单体紧耦合 TUI：PTY 管理、session 持久化、状态启发式、TUI 渲染全织在一起；socket API 是为"agent 驱动 herdr 这个产品"设计的，不是为"换前端/core 当库嵌入"设计的（glm-5.2）
- 改造成 headless core + 贡献点 package 是重写级工程，可复用仅两三成；fork 省下约 500 行，换来 5000 行架构债（deepseek-v4-pro）
- **致命伤：Rust core 接不进 pi 的 TS 包生态，亲手砍断 R1 确立的唯一冷启动生路**（glm-5.2）
- 反方提醒（gpt-5.6-sol）：Rust 承担 PTY/进程/持久化数据面很合适，TS 重写会重新踩可靠性坑；但未审计 daemon/UI 边界前不能假设其适合插件化

**社区/品牌层面**
- fork 改名 22k 星活跃项目 = 教科书级寄生 fork，零用户新项目在论战里默认输（glm-5.2）
- 叠加"pi 寄生"定位，一次 launch 同时寄生两个社区，信誉债太重
- 参照 Redis/Valkey：合法 fork 都能撕成那样（deepseek-v4-pro）

**法律层面**
- Apache-2.0 允许复制/修改/再发布/商用，带专利授权；须保留 LICENSE/NOTICE/署名，不授予 herdr 名称/Logo/背书权（gpt-5.6-sol）
- 但"这是合法的"是明知理亏者的辩护词（glm-5.2）

### 对两条既有结论的判定
1. **headless JSON-RPC core**：fork 后被推翻——被迫在"继承 herdr 的 PTY 中心协议"与"砸碎重设计"之间二选一，两条路都让结论破产（glm-5.2、k3）。**重写后成立且更应坚持。**
2. **类型化 AgentSession 标准**：**幸存且与 fork 无关**——它位于 PTY 数据面之上，herdr 的输出解析只作旧 harness 降级路径（gpt-5.6-sol）。herdr"刻意不解释 PTY"的哲学使得在其代码上叠加类型化事件层 = 架构精神分裂（glm-5.2）。

### 第三条路（4/4 收敛的变体）
- **glm-5.2**：TS 干净重写 core + `e-herdr-compat` 包在 wire 上说 herdr 协议。"别 fork herdr 的代码，fork 它的协议。代码是负债，协议是资产。"叙事 = "说所有人协议的 runtime"。
- **gpt-5.6-sol**：先推动 herdr 上游拆出稳定 daemon/socket 协议并贡献小改动；e 独立实现 headless 控制面，把 herdr 作为首个可替换 session backend（保留 tmux/自研 backend）；仅当上游拒绝关键补丁且审计证明边界清楚时才维护明确标注来源的窄 fork。
- **k3**：TS 独立重写 + herdr socket 兼容适配层 + 选择性回馈上游，做 herdr 的超集而非 fork。
- **deepseek-v4-pro**：协议兼容但独立实现；e 的 socket API 设计成 herdr 超集。"e 兼容 herdr 协议"是加分项，"e 是 herdr 的 fork"是减分项。

---

## R3：e 与 NervaFS 结合？会不会不纯粹？

### 结论：4/4 分层结合——NervaFS 永远只做可选 package/backend，绝不进内核

### 结合点分级（逐项排查后的收敛）

| 候选结合点 | 判定 | 说明 |
|---|---|---|
| **AgentSession 事件流 + audit** | **天作之合（唯一杀手级）** | e 的类型化事件 × NervaFS 的 audit-on-by-default = "默认产出结构化、可审计、可治理 agent 活动日志的 runtime"，切 herdr 完全不碰的企业/合规痛点（glm-5.2、deepseek、k3、gpt 全部点名） |
| workspace 元数据/治理 | 一般/可以做 | .e/ 目录或 sqlite 就够，挂 FUSE 杀鸡用牛刀（glm-5.2）；gpt-5.6-sol 认为 workspace 身份、repo/worktree 映射、策略、lockfile 适合入库 |
| session 状态/scrollback 落盘 | 价值薄/牵强 | PTY 流本质不是文件系统形态（glm-5.2）；deepseek 认为持久化状态落盘可让 session 可迁移可审计 |
| package 分发 | **不该做** | 分发天生是 git/npm 的活（4/4 一致） |
| identity/memory/tools/communication | 与 e core 正交 | 是 NervaFS 自己的命，e 不该碰（glm-5.2） |

### "不纯粹"风险：真实且生死级，但风险源不是 FUSE，是"强制"
- FUSE 代价具体而沉重：macFUSE 内核扩展授权（苹果年年收紧）、容器/sandbox/CI 常不可用、Windows 要 WinFsp、库化嵌入直接泡汤（glm-5.2、k3）
- 强制 FUSE = 同时杀掉"可嵌入 runtime"生路（R1）和"比 herdr 更轻"叙事，双输
- 可选则 FUSE 退化为"要审计/治理的高级用户装个包"，core 依然零假设、依然 ~500 行、依然裸目录可跑。"那一刻 FUSE 不是负担，是高级特性。"（glm-5.2）
- gpt-5.6-sol：pi 式极简不是代码少，而是**默认路径概念少、依赖少**。"FUSE is all agents need"可以是 NervaFS 的命题，不能成为 e 的前置假设。

### 硬约束（合并四人提案，建议写入 RFC-0）
1. **核心零 FUSE 假设**：`e init` 在没有 NervaFS 的机器上跑得起来——不可让步的红线（CI、容器、库化嵌入、无 WinFsp 的 Windows 开箱即跑）
2. **接口中立**：core 只定义窄的 WorkspaceStore / EventSink / Policy-Audit capability 接口，默认本地目录/SQLite 实现；core 不得 import NervaFS 特有概念
3. **卸载不降级**：卸载 e-nervafs 后核心功能不降级
4. **协议无专有字段**：公共协议不出现 NervaFS 专有字段；AgentSession 的规范真源是实时类型化事件，文件只是可验证投影
5. **两项目独立发布**，任何 workspace 可显式导出到普通目录
6. **audit 是唯一默认桥接面**（glm-5.2）：e 事件写入 NervaFS 审计日志是默认开启的"高级特性"，不是 core 必需

### ⚠️ 治理风险（圆桌当面点破）
> 发起人同时做 e 和 NervaFS，有动机把 e 设计成 NervaFS 的获客通道。e 的中立性（runtime-agnostic、substrate-agnostic）是借 pi 社区冷启动的前提，一旦被读成"NervaFS 专用 runtime"，冷启动当场归零。**NervaFS 应该因为"接口最全、做得最好"而赢，不该因为"被 e 绑定"而赢。**（glm-5.2；k3 同样点名"防范同一发起人带来的捆绑冲动"）

### 金句
- "NervaFS 是 e 的纵深，不是 e 的地基。让 NervaFS 去争'最佳审计 backend'，别让它当 core 的入场券。"（glm-5.2）
- "NervaFS 是 e 的差异化加速器，不是 e 的底盘。"（deepseek-v4-pro）
- "把它作为官方 dogfood 集成会形成可信的差异化，把它做成强制依赖则会把两个尚待验证的项目绑成一个更难采用的产品。"（gpt-5.6-sol）

---

## 对调研报告（2025-07-ade-landscape.md）的修订建议

圆桌三轮讨论实质推翻了报告中的两个表述：
1. ~~"TUI-first 是极简定位的天然护城河"~~ → 应改为 **headless core，TUI 是参考客户端**（R1 共识）
2. ~~内核四组件是对标 herdr 的最小集~~ → 四组件只是与 herdr 打平的入场券，**贡献点模型 + AgentSession 标准 + pi 生态才是胜负手**（R1）

新增三条行动项：
- `e-herdr-compat`：wire 级协议兼容包，叙事"说所有人协议的 runtime"（R2）
- 推动 herdr 上游拆 daemon/socket 协议，贡献小改动，herdr 作首个可替换 session backend（R2, gpt-5.6-sol）
- `e-nervafs`：分层结合的首个官方 backend 包，audit 为唯一默认桥接面，遵守六道硬约束（R3）
