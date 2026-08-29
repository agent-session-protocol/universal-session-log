# USL — Universal Session Log

> **USL is the storage-first reference implementation of the [Agent Session Protocol (ASP)](https://github.com/agent-session-protocol/asp).** ACP handles the live present (editor↔agent interaction); ASP handles the durable past and cross-runtime migration; **USL is the storage engine behind ASP.**
>
> [English](README.md) · [中文](README.zh-CN.md)

USL answers one question: **how to collect the session logs of any agent runtime (pi / Claude Code / Codex / opencode / dimagent) into a unified, recoverable, inter-convertible storage layer** — making resume / fork / handoff (cross-harness continuation) and unified history rendering possible.

## Three core properties

1. **Storage-first; correctness comes from the append log alone.** Every record carries a length prefix + CRC; recovery scans frames and truncates at the first torn frame. Recovered state is byte-deterministic (no WAL/checkpoint/header dependency).
2. **Opaque payloads are first-class.** Bytes that can't be parsed but must round-trip (Claude's thinking `signature`, Codex's `encrypted_content`) are carried in a typed `unknown` block — never dropped in conversion.
3. **Round-trip fidelity comes from the evidence layer.** Cross-harness conversion (pi/dimagent/claude/codex) replays the importer's native payloads verbatim, declaring loss only when synthesizing.

## Repository layout

```
crates/
├── usl-core/       # Rust storage engine: append-only, crash-recoverable, schema-agnostic
├── usl-capture/    # Rust capture layer: file-boundary live ingest + framing + conversion
└── usl-fuse/       # Rust FUSE mount layer (paused: no usable FUSE on macOS 26)
packages/
└── usl-convert/    # TS cross-harness conversion layer (ASP reference)
docs/
├── research/       # research background (ASP/ACP/FUSE analyses)
└── architecture/   # architecture wiki (verifiable source provenance)
```

## Quick start

```bash
# Rust storage + capture (54 tests)
cargo test --workspace

# TS cross-harness conversion (25 tests)
cd packages/usl-convert && npm install && npm run check

# architecture wiki verification (source provenance / hash / coverage)
npm run lint:architecture
```

## Protocol spec

This repository contains only the implementation; the protocol layer (canonical schema, event semantics, fidelity matrix, opaque-passthrough conventions) lives in the [ASP spec](https://github.com/agent-session-protocol/asp).

## Status

**Validation stage**: storage engine 32 tests, capture 21 tests, conversion 25 tests — all green; real-data smoke — a Codex session (303 messages / 91 tools / 99 encrypted-reasoning blobs) round-trips through pi with zero loss.
