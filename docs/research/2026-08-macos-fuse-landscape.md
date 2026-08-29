# macOS 26 (Tahoe) 上「纯用户态 FUSE」现状调研

> 日期：2026-08-29 · 性质：独立调研（可复用于任何需要 FUSE 的项目，与具体项目解耦）
> 实测环境：macOS 26.5.1 (25F80, arm64) · fuse-t 1.2.7 · macFUSE 5.2.0(已装)/5.3.3(最新)
> 结论一句话：**2026-08 时点，macOS 26 上没有生产级的纯用户态（kext-less）FUSE 方案。**

---

## 1. 实测现象（fuser crate + fuse-t 1.2.7）

用 Rust `fuser` 0.15.1（默认 `libfuse` 特性，经 `install_name_tool` 换链到 `libfuse-t.dylib`）挂一个只读 smoke 文件系统：

- go-nfsv4 正常 spawn，`libfuse2-compatible` 会话协商成功，NFS server 起在 `127.0.0.1:52100`；
- FUSE 回调**已被调用且正常往返**（`wire: send opcode=17 GETATTR nodeid=1` → `Received {96 0 3}`，我们的 `getattr` 回包成功）——**说明业务代码没问题**；
- 但挂载握手走到 NFSv4 `fs_locations` 这一步后，go-nfsv4 静默退出，daemon 随之 exit 0、无 stderr、无挂载。

**判定**：不是我们的代码，是 fuse-t 在 macOS 26 上挂不了载。

## 2. 根因（fuse-t 在 macOS 26 坏了）

fuse-t issue **#104**（open）：*"FUSE-T fails to enable on macOS 26 (Tahoe) — missing FSKit entitlement"*。日志报错：

```
(ExtensionFoundation) Host is missing entitlement: com.apple.private.fskit.module-runner
```

fuse-t 有三种后端：**NFS（默认）/ SMB / FSKit**，在 macOS 26 上**全部有问题**：

| 后端 | macOS 26 状态 | 证据 |
|---|---|---|
| NFS（默认） | 挂载失败；且 Apple NFS kext 有 bug 可致**内核 panic** | 本文 §1 + issue #109（FB23527406 已报 Apple） |
| SMB | Finder 挂起 / 连接反复断 | issue #113（macOS 26.6.2） |
| FSKit | 缺 `com.apple.private.fskit.module-runner` 私有 entitlement 无法启用；即便启用也"not production ready"（零可用空间、`ls: Illegal seek`） | issue #104、#98 |

## 3. 背景：macOS 文件系统架构的世代更替

```
kext（第三方内核扩展）
  → Apple 弃用；Apple Silicon 上需「恢复模式降安全策略」+ System Settings 审批
  → FSKit（macOS 15 起的新框架，云盘/文件系统 provider 的正统路径）
     但 FSKit 的 module-runner entitlement 是「私有」的（com.apple.private.*）
     → 第三方无法直接实现自己的 FSKit 文件系统，只能走「桥」（macFUSE/fuse-t 把 libfuse 翻译到 FSKit）
```

**关键结构性事实**：`com.apple.private.fskit.module-runner` 是 **private entitlement**。Apple 至今没有把 FSKit 开放给任意第三方文件系统开发者——这是"纯用户态 FUSE"迟迟没有生产级方案的根本原因。

## 4. 为什么还要用户态方案（kext vs 用户态的特权性质）

> 常见疑问："kext-less 还是要 root 挂载，那和 kext 到底差在哪？"

混淆点在**两种"特权"性质完全不同**：

| | kext（内核扩展） | 用户态 FUSE + mount |
|---|---|---|
| 特权是什么 | **把代码装进内核**，永久 kernel-space 执行 | **mount 这一个动作**，瞬时、窄、可审计 |
| 获取门槛 | Apple Silicon 要**恢复模式降安全策略** + 审批（永久降低整机安全姿态） | 一次 `sudo`，或 setuid helper（与挂磁盘镜像/NFS 同级） |
| 爆炸半径 | bug = **内核 panic 全机崩溃**；恶意 kext = 内核级沦陷 | bug = **崩自己的进程**，内核不碰 |
| 供应链风险 | 最高级攻击面 | 普通进程级 |
| 生命周期 | Apple 正在**弃用**（第三方 kext 最终会被移除） | 对齐 Apple 方向（FSKit 是正道） |

**核心好处三条**：

1. **不降安全姿态**——最大的一条。对企业/CI/租用机/多数用户，"进恢复模式关 SIP 允许第三方 kext"是硬拒绝项；用户态方案不动任何系统安全设置。
2. **爆炸半径可控**——"安全"不是"没特权"，而是"**没有内核态代码**"。kext 是你能在 Mac 上装的最危险的东西；一个只需 mount 特权的用户态 daemon 是最不危险的一档。
3. **未来正确**——kext 是死路，用户态（尤其 FSKit 形态）是 Apple 唯一给的方向。

**澄清**：root mount 不是用户态方案的固有缺陷。成熟方案（macFUSE）带 **setuid mount helper**（极小、可审计、只干 mount/unmount），daemon 全程普通权限跑。fuse-t 不带 helper 是它的缺陷（见 §5.1），不是"用户态"的原罪。

**诚实边界**（用户态不买什么）：仍要 mount 那一点特权（只是收窄到 setuid helper）；性能可能更差（NFS/FSKit 往返 vs 内核直通）；边角 bug 更多。

## 5. 三条路现状矩阵（2026-08）

### 5.1 fuse-t 1.2.7（kext-less，但三后端全残）

- 见 §2。macOS 26 上**实质不可用**。
- 额外问题：`mount` 需要 root，而 fuse-t **不附带 setuid helper**（pkg 全清单 79 文件无 setuid 二进制）→ 即使后端正常，非 root 也要 `sudo`/授权弹窗。kext-less ≠ 免特权。

### 5.2 macFUSE 5.3.3（kext 后端 + 新 FSKit 后端）

2026-07-04 发布，用 **Xcode 26.6 / macOS 26.5 SDK** 构建，是当前**最接近"纯用户态"的候选**：

- **kext 后端**：传统路径，成熟但重——Apple Silicon 需恢复模式降安全 + 审批。
- **FSKit 后端**（新增）：kext-less，走 `libfuse`/`libfuse3` + `MFMount.framework`。但 macOS 26 上**仍在修 bug，非生产级**：
  - #1187 `write(2)` 1–14 字节**静默数据损坏**（2026-08-08 已修，但性质严重）
  - #1188 短读崩溃（已修）
  - #1181 `exec()` 失败 EIO（open, 07-23）
  - #1192 fskitd 不报 `macfuse-local` 模块（macOS 26.6.2 / 27.0 beta，**2026-08-23 open**）
  - #1180 sshfs 在 5.3.3 回归（open, 07-17）

> 注：本机磁盘上装的是 **5.2.0**（无 FSKit 后端），要试 FSKit 需先升到 5.3.3。

### 5.3 直接写 FSKit（Apple 官方框架）

- 被 `com.apple.private.fskit.module-runner` 卡死——**非 Apple 授权不可用**。
- 生态里只有 macFUSE / fuse-t 在做 libfuse→FSKit 的桥，没有第三方直接发 FSKit 文件系统的可行路径。

## 6. 结论

1. **2026-08，macOS 26 上没有生产级纯用户态 FUSE。** 三条路：fuse-t（全残）、macFUSE FSKit（新但测试中）、直接 FSKit（私有 entitlement 堵死）。
2. **最值得押注**：macFUSE 5.3.3 的 FSKit 后端——kext-less、官方项目（原 osxfuse 作者）、已用 macOS 26 SDK 构建。但它刚修完一个**静默数据损坏**级 bug，且 26.6/27 上还有 open issue（#1192/#1181），**当前只能用于实验，不能用于生产数据路径**。
3. **结构性风险**：只要 `com.apple.private.fskit.module-runner` 不开放，所有"纯用户态 FUSE"都依赖第三方桥（macFUSE/fuse-t）去蹭 FSKit，而桥的质量/修复节奏不可控。
4. **"纯用户态" ≠ "免特权"**：kext-less（如 fuse-t NFS）仍需 root 挂载，除非有 setuid helper；FSKit 是唯一"应用自身不碰 root"的正统路径（模块跑在系统 fskitd 里）。

## 7. 给需要 FUSE 的项目的建议

| 场景 | 建议 |
|---|---|
| **现在就要、能接受重一次性配置** | macFUSE kext 后端（成熟；Apple Silicon 恢复模式降安全一次） |
| **要 kext-less、能接受测试版** | macFUSE 5.3.3 FSKit 后端，pin 版本、盯 #1192/#1181，跑**数据完整性回归**（对照文件哈希） |
| **长期/跨平台** | 别把 macOS 当 FUSE 主战场；Linux 上 FUSE 成熟、Windows 用 ProjFS；macOS 等 FSKit 开放 |
| **绝对别做** | 押 fuse-t 的 NFS 后端（Apple NFS kext 在 26 上有 kernel panic bug）；用 fuse-t 在 macOS 26 上做任何事 |

## 8. 复现与证据（附录）

```bash
# fuse-t 在 macOS 26 挂载失败的复现（需已装 fuse-t）
brew install --cask fuse-t
# 写一个 fuser smoke fs，install_name_tool 换链到 libfuse-t
install_name_tool -change /usr/local/lib/libfuse.2.dylib /usr/local/lib/libfuse-t.dylib ./my-fuse-fs
sudo ./my-fuse-fs /tmp/fuse-smoke-mnt   # 挂载握手到 fs_locations 后 daemon 静默退出
```

关键日志（go-nfsv4 debug 模式，`fuse-t.ini` 开 `debug=true`）：

```
fuse session negotiated profile=v2 client=libfuse2-compatible proto=7.8 ...
Server version 1.2.7 running at 127.0.0.1:52100
mount [-o port=52100,mountport=52100,vers=4,ro -t nfs fuse-t:/fuse-smoke-mnt /tmp/fuse-smoke-mnt]
NFSv4: COMPOUND Op: mount / opPutrootfh / opLookup / opGetattr / StatFS ...   ← 都在正常往返
NFSv4: COMPOUND Op: fs_locations   ← 走到这步后无下文，进程退出
```

证据来源（GitHub issues）：
- fuse-t #104 缺失 FSKit entitlement（open）· #109 Apple NFS kext kernel panic（open）· #113 SMB Finder 挂起（open）· #98 FSKit not production ready（open）
- macfuse #1192 fskitd 不报模块（macOS 26.6/27, open）· #1187 write 静默损坏（closed 08-08）· #1181 exec EIO（open）· #1180 sshfs 回归（open）

> 附：本机另一条线索——`/Library/Filesystems/macfuse.fs` 已含 macOS 26 的 kext（Extensions/26），说明 macFUSE 5.2.0 的 kext 路径已为 macOS 26 备好，只是尚未加载（需恢复模式降安全）。

---

## 9. 待研究问题（给后续 session 的方向）

本文是到 2026-08-29 为止的**快照**。后续值得深挖的方向（按优先级）：

1. **FSKit 的开放时间表**：`com.apple.private.fskit.module-runner` 是否会转公共 entitlement？有没有非 macFUSE/fuse-t 的第三方拿到授权的先例？线索：Apple 开发者论坛、WWDC session、已上架 App Store 的 FSKit provider。
2. **macFUSE FSKit 后端成熟度跟踪**：#1192（fskitd 不报模块，26.6/27）与 #1181（exec EIO）何时关；#1187（write 静默损坏）的修复是否彻底。**可做的实测**：macFUSE 5.3.3 FSKit 后端跑「文件哈希对照 + crash/断电」数据完整性回归。
3. **fuse-t 是否补 entitlement / 出新版**：盯 #104；若 fuse-t 拿到 FSKit entitlement，它的轻量后端是否有救。
4. **setuid helper 的开源范式**：macFUSE 的 `mount_macfuse`、sshfs 的 `fusermount` 实现——自研用户态 FUSE 时，怎么做最小、可审计的 mount helper（代码签名 + entitlements + 竞态处理）。
5. **跨平台"安全 FUSE"全景**：Linux（内核 FUSE 成熟 + fanotify 权限门 + virtiofs/9p）、Windows（ProjFS）、macOS（本文）——若目标是"跨平台安全用户态文件系统"，各平台最优解分别是什么、能否统一 API。
6. **Apple NFS kext 的 kernel panic bug（FB23527406）**：是否修复——决定"用户态 NFS loopback"这条路未来是否可行（fuse-t 及任何 NFS 方案都依赖它）。
7. **性能基准**：用户态（NFS loopback vs FSKit）vs kext，在「大文件顺序写 / 海量小文件 / 元数据密集」三类负载下的实测对比——量化"用户态方案的性能损失"到底多大。
