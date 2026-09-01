# Changelog

All notable changes to Universal Session Log are documented here.

## [Unreleased] — v0.2 foundation

- Added the `sesdb-engine` authenticated NDJSON subprocess with exclusive store
  locking, bounded scans, structured errors, integrity checks, and atomic
  validation of append batches.
- Added the `@agent-session-protocol/sesdb` alpha SDK/CLI with executable
  canonical `events` queries, structured SessionQL IR, fixed query snapshots,
  safe literal search, and complete evidence pointers.
- Added a pinned, machine-verified Obelisk comparison ledger and clean-room
  status report; its I0 corpus/performance gate remains explicitly in progress.
- Added cross-platform engine release assembly, SESDB SDK/Site CI, and a packed
  install smoke test that runs `doctor`, `query`, and `verify` against an
  isolated store.
- Added `sesdbd`, four versioned L1 record kinds, a disposable bundled-FTS5
  sidecar, authenticated localhost API, and atomic endpoint descriptors.
- Added opt-in Claude/Codex incremental reconciliation with exact evidence,
  partial-line deferral, fingerprints, generations, and visibility controls.
- Added daemon SDK/CLI commands and a minimal real Console with a one-use,
  read-only browser session; the hosted Console remains demo-only.
- Pi/Kimi/DeepSeek, semantic search, memory, SQL, and Electron remain explicitly
  unavailable. The five-provider I0 gate remains in progress.

## [0.1.0] - 2026-08-31

The first public validation release of USL / SESDB.

### Included

- `usl-core`: append-only, checksummed session-log storage and deterministic recovery.
- `usl-capture`: incremental JSONL framing and capture independent of write boundaries.
- `@agent-session-protocol/usl-convert`: ASP-backed import and handoff across Pi,
  Claude Code, Codex, and Dimagent session formats.
- The SESDB interactive console, architecture explorer, bilingual product site, and
  evidence-backed architecture documentation.

### Status

- SessionQL remains an RFC and is not exposed as a working query engine in this release.
- `usl-fuse` remains an experimental, paused adapter and is not published as a package.

[0.1.0]: https://github.com/agent-session-protocol/universal-session-log/releases/tag/v0.1.0
