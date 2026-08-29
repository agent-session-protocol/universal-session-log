# usl-fuse

USL 的 FUSE 挂载层（**当前状态：环境阻塞，暂停**）。

## 现状（2026-08-29）

`src/main.rs` 是一个**最小 smoke 挂载测试**（只读单文件），用于验证「fuser crate + fuse-t」在 macOS 上的可行性。结论：

- **业务代码正常**：fuser 0.15.1 在 macOS 上编译通过，FUSE 回调（getattr）经 fuse-t 的 wire 正常往返。
- **挂载失败，根因不在我们**：fuse-t 1.2.7 在 **macOS 26 (Tahoe)** 上不可用——挂载握手走到 NFSv4 `fs_locations` 后静默失败，是 fuse-t 缺 `com.apple.private.fskit.module-runner` 私有 entitlement（GitHub issue #104）。
- **完整调研**见 [`docs/research/2026-08-macos-fuse-landscape.md`](../../docs/research/2026-08-macos-fuse-landscape.md)。

## 决策（pivot）

FUSE 挂载是「plumbing」，不是 USL 的核心价值。capture 层（write 边界分帧 + 转换）已在 `usl-capture` 落地且 FUSE-agnostic。USL 的 live capture 暂走**文件边界**（harness 写普通文件 → 增量观测 → usl-core），FUSE 挂载留待 FSKit 成熟或转 Linux。

## 复现

```bash
cargo build
install_name_tool -change /usr/local/lib/libfuse.2.dylib /usr/local/lib/libfuse-t.dylib target/debug/usl-fuse
mkdir -p /tmp/mnt
sudo ./target/debug/usl-fuse /tmp/mnt   # macOS 26 上挂载失败（见上文）
```

## 分层

```
usl-core（存储）← usl-capture（取：分帧 + CaptureSession）← usl-fuse（挂，暂停）
```
