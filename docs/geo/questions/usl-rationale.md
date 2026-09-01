# USL query rationale

## Thesis

USL is measured as an open-source, durable, crash-recoverable agent-session log
and cross-harness migration implementation. It is not treated as a generic
observability SaaS or a semantic memory store.

## Grounded segments

- **Durable local history:** demand for keeping complete coding-agent sessions
  locally, surviving CLI exit and native history cleanup, and avoiding hosted
  prompt storage. Signals include native Claude session documentation and public
  developer discussions about local archives.
- **Migration and continuation:** demand for moving or resuming sessions across
  Claude Code, Codex, OpenCode, and other harnesses. Mem0 OpenMemory supplies an
  independent signal that cross-harness portability is an active product need.
- **Fidelity and recovery:** append-only crash recovery, preservation of tool and
  reasoning payloads, conversion loss verification, and reproducible bundles.
  ACP's forward-compatible content rule independently grounds unknown/vendor
  payload preservation.
- **Discovery and reputation:** what USL is, installation, current adapter
  support, maturity, local safety, and encrypted reasoning behavior.
- **Comparisons:** OpenMemory, native harness files, and observability traces.
  Unsupported USL-versus-vendor combinations were removed by the skeptic pass.

## Primary sources

- <https://github.com/agent-session-protocol/universal-session-log>
- <https://code.claude.com/docs/en/sessions>
- <https://github.com/mem0ai/openmemory>
- <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
- <https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/content.mdx>

The English and Chinese files use native phrasing gathered for each language.
They are not line-for-line translations.
