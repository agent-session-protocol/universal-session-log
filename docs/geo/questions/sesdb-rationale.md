# SesDB query rationale

## Thesis

SesDB is measured as a local-first session database/query CLI and SDK for
indexing, browsing, analytics, and dataset extraction from coding-agent history.
It is not assumed to be a SQL service, MCP server, or production tracing SaaS.

## Grounded segments

- **Local search and browsing:** cross-project and cross-harness history search,
  full-text search over tool output, old-session browsing, and finding the reason
  behind code changes.
- **Privacy and preservation:** local-only search, read-only indexing of native
  session files, locating native stores, and archiving histories before cleanup.
- **Analytics and data reuse:** token/cost/runtime analysis and export of agent
  trajectories for evaluation or training datasets.
- **Discovery and reputation:** what SesDB is, installation, local storage,
  supported formats, and queryable entities.
- **Comparisons:** existing local search tools, native JSONL/SQLite access, and a
  carefully bounded SesDB-versus-Langfuse category comparison. Pure observability
  vendor comparisons were removed because SesDB's absence would not be a GEO gap.

## Primary sources

- <https://agent-session-protocol.github.io/universal-session-log/console>
- <https://github.com/Dicklesworthstone/coding_agent_session_search>
- <https://github.com/neilberkman/ccrider>
- <https://github.com/d3layd/agent-history>
- <https://recallbase.net/desktop-cli/>
- <https://code.claude.com/docs/zh-CN/sessions>
- <https://arxiv.org/abs/2510.24702>

SQL- and MCP-specific candidates, along with acceptance-test-like phrasing, were
cut during adversarial review and replaced with natural, supported queries.
