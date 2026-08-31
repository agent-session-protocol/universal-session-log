# Changelog

All notable changes to Universal Session Log are documented here.

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
