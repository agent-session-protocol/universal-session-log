# Five-provider clean-room corpus

These fixtures are synthetic, redistributable test data created from public format
documentation. They contain no captured user prompts, credentials, HOME paths, repository
remotes, or proprietary source. `manifest.json` is the normative capability matrix: a scenario
is never inferred as supported from an empty fixture.

The corpus covers Claude Code, Codex CLI, Pi, Kimi Code CLI, and DeepSeek Harness. The
DeepSeek compressed artifact is generated from `deepseek/session.jsonl` as concatenated zstd
content for parser tests; the readable JSONL remains the reviewable clean-room source.

`rewrite-truncate`, `archive-delete`, and partial-write behavior are exercised by the isolated
SESDB runner because those are filesystem transitions, not durable records in every provider.
Unsupported cells remain explicit in `manifest.json`.
