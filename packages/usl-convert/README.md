# usl-convert

Cross-harness agent session log conversion: **pi ↔ dimagent**, plus **claude** and **codex**
importers (ASP reference implementation), via a neutral intermediate format called **asp-bundle**.

```
pi session JSONL          dimcode.sqlite (WAL)      claude JSONL           codex rollout JSONL
~/.pi/agent/sessions/     ~/.dimcode/v2/            ~/.claude/projects/    ~/.codex/sessions/
        \                     /                           \                    /
      import pi          import dimagent             import claude       import codex
          \                 /                             \                  /
           asp-bundle.json   <- canonical pivot + evidence + fidelity report
          /                 \
      export pi          export dimagent          (claude/codex bundles also export via pi)
        /                     \
  resumable pi file      sessions+messages rows
```

## Design decisions

1. **The intermediate reuses the ASP (Agent Session Protocol) canonical schema.** The bundle's
   `pivot` is a plain `AgentSessionSnapshot` (vendored in `src/asp-schema/agent-session-contracts.ts`),
   built by the same materializer the store uses. Any ASP-compatible consumer can render a
   bundle with zero changes.

2. **Copy-on-write, with the evidence array as the WAL.** Importers never mutate the source
   session log; every conversion writes a new immutable bundle. Inside the bundle, `evidence`
   is the full ordered `AgentEventEnvelope` stream and `pivot` is always derivable from it —
   that is the WAL role. `provenance.sources` pins the complete logical source set by size and
   SHA-256, and re-importing the same source set with the same adapter revision yields identical
   canonical bundle bytes.

3. **Imported archives are read-only and unauthenticated.** Every imported event is marked
   `adapter: "usl-convert"`, `authenticated: false`, `authority: "authoritative"`,
   `confidence: 1`. The pivot's status is `exited`, capabilities are `read.*` only, and the
   control plane is explicitly unavailable. A converted log can never be confused with a live
   daemon session.

4. **Fidelity is declared, not promised.** Each bundle carries a `fidelity` matrix and a
   human-readable `loss` list. Exporters also return per-direction loss declarations. Round-trip
   guarantees are per-axis: `preserved | partial | evidence-only | dropped | not-in-source`.

## Format

`asp-bundle` v2 is the default write format; v1 remains readable. It is a canonical JSON file:

```jsonc
{
  "format": "asp-bundle",
  "version": 2,
  "createdAt": "source-derived ISO-8601",
  "native": { "harness": "pi" | "dimagent" | "claude" | "codex", "sessionId": "...", "sourceSha256": "..." },
  "provenance": {
    "nativeFormat": "pi",
    "sources": [{ "logicalPath": "session.jsonl", "role": "session-log", "size": 123, "sha256": "...", "captureMode": "exact-file" }],
    "adapter": { "id": "usl-convert/pi", "version": "0.2.0-alpha.0", "revision": "asp-bundle/v2" }
  },
  "pivot": { /* ASP AgentSessionSnapshot */ },
  "evidence": [ /* AgentEventEnvelope stream; pivot derivable from it */ ],
  "fidelity": [ { "axis": "tool-chain", "level": "preserved", "detail": "..." } ],
  "loss": [ "human-readable loss declarations" ],
  "integrity": { "algorithm": "sha256", "canonicalization": "canonical-json/v1", "digest": "..." }
}
```

Bundle invariants (enforced by `validateBundle`): `pivot.revision === evidence.length`,
`pivot.seq === evidence.length - 1`, `pivot.id === evidence[0].correlation.agentSessionId`,
every envelope passes the production `validateAgentEnvelope` exact-schema check.
The v2 validator also rejects absolute source paths, unsorted source sets, and integrity digest
mismatches. The source verifier resolves only portable logical paths under an explicit root.

## Fidelity matrix (current)

| axis              | pi import                    | dimagent import                   | claude import | codex import |
| ----------------- | ---------------------------- | --------------------------------- | ------------- | ------------ |
| messages/order    | preserved                    | preserved                         | preserved (block-append journal merged) | preserved (dual-stream dedup) |
| content blocks    | preserved (typed unknown)    | preserved (typed unknown)         | preserved (typed unknown) | preserved (typed unknown) |
| tool chain        | preserved                    | preserved                         | preserved     | preserved    |
| thinking          | preserved incl. signature    | partial (startTime/endTime lost)  | preserved incl. **signature** | partial (summary→thinking; **encrypted_content → typed unknown passthrough**) |
| run boundaries    | partial (inferred from user msgs) | preserved (metadata.runId)   | partial (inferred from user prompts) | preserved (turn_context) |
| turn boundaries   | partial (one per run)        | not-in-source (one per run)       | partial (one per run) | partial (one per turn_context) |
| model/usage       | evidence-only                | evidence-only                     | preserved (per-message model+usage) | evidence-only (token_count) |
| custom entries    | evidence-only                | n/a                               | evidence-only (attachment/title/mode/queue-op) | evidence-only (turn_context policies) |
| attachments       | n/a                          | evidence-only                     | evidence-only | n/a          |
| sidechain/subagent| n/a (tree branch)            | n/a                               | partial (parentId linkage; flag not projected) | n/a |
| compaction        | n/a                          | dropped (declared)                | not-in-source | not-in-source |
| file checkpoints  | n/a                          | dropped (declared)                | n/a           | n/a          |
| permissions       | n/a                          | dropped (declared)                | not-in-source | evidence-only (approval_policy) |
| approvals         | not-in-source                | not-in-source                     | not-in-source | not-in-source |

Known cross-direction losses (declared by the exporter):
- pi → dimagent drops thinking `signature`.
- dimagent → pi re-encodes non-text tool results (`structuredContent` objects) as text blocks.

## Usage

```bash
# GitHub Packages requires a GitHub token with read:packages access.
npm config set @agent-session-protocol:registry https://npm.pkg.github.com
npm install @agent-session-protocol/usl-convert

# list dimagent sessions
usl-convert dimagent-list ~/.dimcode/v2/dimcode.sqlite

# import into the intermediate format
usl-convert import pi ~/.pi/agent/sessions/<dir>/<file>.jsonl --out a.asp-bundle.json
usl-convert import dimagent ~/.dimcode/v2/dimcode.sqlite --session <sessionId> --out b.asp-bundle.json
usl-convert import claude ~/.claude/projects/<dir>/<uuid>.jsonl --out c.asp-bundle.json
usl-convert import codex ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl --out d.asp-bundle.json

# export back out
usl-convert export pi a.asp-bundle.json --out resumed.jsonl
usl-convert export pi a.asp-bundle.json --install-pi          # write into ~/.pi/agent/sessions/<dir>/
usl-convert export dimagent b.asp-bundle.json --out rows.json   # portable payload
usl-convert export dimagent b.asp-bundle.json --write --db <db> # apply transactionally

# one-shot cross conversion
usl-convert convert pi dimagent <file.jsonl> out.json
usl-convert convert dimagent pi <db> out.jsonl --session <sessionId>

# introspection
usl-convert inspect a.asp-bundle.json
usl-convert verify a.asp-bundle.json --source-root /path/to/captured/source-set
usl-convert conformance pi /path/to/session.jsonl
usl-convert conformance dimagent /path/to/dimcode.sqlite --session <sessionId>
usl-convert list-formats
```

## Safety notes

- **Reading a live dimagent DB is transaction-consistent**: Node's SQLite backup API captures
  a retained snapshot artifact. Its digest proves the backup bytes, not byte identity with the
  concurrently changing live database or WAL files.
- v2 does not serialize absolute HOME paths. Move the captured source root and bundle together,
  then pass the new root to `verify`; verification remains valid.
- Deterministic bytes prove reproducibility for a declared source set and adapter revision. They
  do not by themselves prove that an importer accounted for every native record; the shared
  conformance runner separately enforces evidence/loss accounting.
- **Writing (`--write`) is transactional** (`BEGIN IMMEDIATE`) and inserts a fresh session id;
  message ids are derived from the target session id so repeated exports never collide.
- The exporter never fabricates control-plane facts: exported sessions have no live
  capabilities, no approval state, and no pending actions.

## Layout

```
src/bundle.ts        asp-bundle schema + validation + fidelity types
src/evidence.ts      deterministic envelope builder shared by importers
src/materialize.ts   evidence -> AgentSessionSnapshot (reuses ASP materializer)
src/registry.ts      single adapter registry for CLI dispatch/listing/conformance
src/conformance.ts   byte determinism, source verification, native-record accounting
src/pi.ts            pi JSONL importer + exporter
src/dimagent.ts      dimagent sqlite importer + exporter (node:sqlite, WAL-safe)
src/cli.ts           import/export/convert/verify/conformance/inspect/list-formats
test/                fixtures (self-contained) + unit + roundtrip tests
```

For repository development, run `npm install && npm run check` in this directory.

## Roadmap

- More harnesses: Gemini CLI, opencode (SQLite + event tables), Aider (claude/codex importers
  were added by the USL spike, 2026-08).
- OTEL `gen_ai.*` exporter for observability backends.
- Resume-target fidelity profiles (e.g. compaction-aware export for long sessions).

## USL spike notes (2026-08)

Materializer gap found and fixed during the USL spike: `normalizeContent` double-wrapped
already-canonical `unknown` blocks, losing `nativeType` (patched in the ASP schema).
Real-data smoke: claude session (124 msgs / 58 tools) and codex rollout (303 msgs / 91 tools /
99 encrypted-reasoning blobs) import with zero undeclared loss; claude→pi cross-handoff export
produces a resumable pi file that re-imports with zero loss.
