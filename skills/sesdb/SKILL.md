---
name: sesdb
description: Retrieve evidence-backed local coding-agent sessions through the SESDB CLI when a task needs prior session context, timelines, or source evidence.
---

# SESDB session retrieval

Use the `sesdb` CLI only. Never open `sesdb.sqlite`, `sesdb.usl`, provider
transcripts, or daemon credentials directly.

Start with `sesdb doctor`. If the daemon is offline, degraded, or rebuilding,
report that state instead of bypassing SESDB. Do not enable providers, reconcile,
rebuild, or perform another management operation unless the user explicitly asks.

## Retrieval

Queries are bounded and active-only by default:

- `sesdb search <text> [--limit N] [--provider P] [--project X] [--session ID] [--from-ms N] [--to-ms N]`
- `sesdb sessions [--limit N] [--provider P] [--project X] [--from-ms N] [--to-ms N]`
- `sesdb timeline <session-id> [--limit N] [--from-ms N] [--to-ms N]`

Use `--history` only when the user asks for retracted or superseded history.
Provider values are exactly `claude`, `codex`, `pi`, `kimi`, or `deepseek`.
Reject unknown filters or values; do not silently omit, reinterpret, or pass them
through. Prefer a narrow time or session window and a small explicit limit.

Treat `generation`, `asOf`, `builtThroughSeq`, `partial`, `matchMode`, and
`diagnostics` as part of the answer's freshness and completeness. State when a
result is partial. Each event's `evidenceSeqs` links back to immutable native
evidence; inspect a requested source with `sesdb evidence <seq>` and summarize
the relevant span rather than dumping raw private content.

Only approved, active memory may be presented as durable memory. Candidate,
revoked, or historical memory is not a default retrieval source. Use
`sesdb memory list` for approved memory. Inspect candidates only when the user
asks to review them. `memory propose`, `approve`, and `revoke` are mutations:
show the evidence and scope, obtain explicit user approval for the specific
action, then use the current revision reported by `sesdb memory get <id>`.
