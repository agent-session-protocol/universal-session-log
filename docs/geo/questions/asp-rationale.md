# ASP query rationale

## Thesis

ASP is measured as an open specification for durable agent-session schemas,
event semantics, replay, fidelity declarations, opaque payload preservation, and
cross-runtime migration. ACP, MCP, A2A, and OpenTelemetry are complementary
protocols or telemetry conventions rather than interchangeable competitors.

## Grounded segments

- **Portable session model:** complete messages, tool calls/results, file diffs,
  canonical events, deterministic replay, compaction, and identity mapping.
- **Handoff and migration:** unfinished-work handoff, Claude Code/Codex migration,
  and persistence through process interruption.
- **Fidelity and extensions:** loss declarations, encrypted reasoning, unknown
  vendor payloads, and evidence-preserving round trips.
- **Discovery and implementation:** what Agent Session Protocol is, current
  stability, TypeScript integration, and the fidelity matrix.
- **Ecosystem comparisons:** ASP versus ACP, MCP, A2A, and OpenTelemetry GenAI.
  Abstract “portable IR library” comparisons were removed as unnatural.

## Primary sources

- <https://github.com/agent-session-protocol/asp>
- <https://github.com/agentclientprotocol/agent-client-protocol>
- <https://modelcontextprotocol.io/specification/>
- <https://a2a-protocol.org/dev/specification/>
- <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
- <https://openai.github.io/openai-agents-js/guides/sessions/>

## Naming risk

“Agent Session Protocol” and “ASP” collide with unrelated projects and generic
abbreviations. GEO content should consistently pair the full name with “durable
AI agent session storage and migration protocol” and its canonical URL.
