---
sources:
  - crates/usl-fuse/src/main.rs d4f2ad47a0c3 SmokeFs mount2
covers:
  - crates/usl-fuse/
---

# usl-fuse：FUSE 挂载层（暂停）

## 职责

计划中在文件系统级别拦截 harness 的 `write()`，把写盘字节直接喂进捕获层——是「write 即事件边界」的物理实现。当前**暂停**：`src/main.rs` 只是一个最小只读 smoke 挂载，用来验证 fuser + fuse-t 在 macOS 上的可行性。

## 对外接口

无（只有 `main`，一个 `fuser::mount2` 的只读单文件冒烟）。

## 数据怎么流

计划流：harness 写挂载点 → FUSE `write()` 回调 → `CaptureSession::write` → usl-core。目前只验证了「挂载 + 读」这条链，未接写路径。

## 改动指南

- 现状结论已写进仓库根部的调研文档：fuse-t 1.2.7 在 macOS 26 不可用（缺 `com.apple.private.fskit.module-runner` 私有 entitlement），macFUSE 5.3.3 的 FSKit 后端也未达生产级——见 `docs/research/2026-08-macos-fuse-landscape.md`（本 wiki 范围外的研究文档）。
- 恢复开发时：把 `SmokeFs` 换成实现 `write/read/fsync` 回调的真文件系统，`write` 里调 `CaptureSession::write`；挂载特权走 setuid helper 或 `AuthorizationExecuteWithPrivileges`。
- 坑：FUSE 是旁路镜像不是过滤器——harness 读回自己的文件必须字节一致，脱敏只能发生在 DB 副本上。
