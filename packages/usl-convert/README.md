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
   that is the WAL role. `native.sourceSha256` pins the source file for provenance, and
   re-importing the same file yields the same event ids (idempotent).

3. **Imported archives are read-only and unauthenticated.** Every imported event is marked
   `adapter: "usl-convert"`, `authenticated: false`, `authority: "authoritative"`,
   `confidence: 1`. The pivot's status is `exited`, capabilities are `read.*` only, and the
   control plane is explicitly unavailable. A converted log can never be confused with a live
   daemon session.

4. **Fidelity is declared, not promised.** Each bundle carries a `fidelity` matrix and a
   human-readable `loss` list. Exporters also return per-direction loss declarations. Round-trip
   guarantees are per-axis: `preserved | partial | evidence-only | dropped | not-in-source`.

## Format

`asp-bundle` v1 is a single JSON file:

```jsonc
{
  "format": "asp-bundle",
  "version": 1,
  "createdAt": "ISO-8601",
  "native": { "harness": "pi" | "dimagent", "sessionId": "...", "sourcePath": "...", "sourceSha256": "..." },
  "pivot": { /* ASP AgentSessionSnapshot */ },
  "evidence": [ /* AgentEventEnvelope stream; pivot derivable from it */ ],
  "fidelity": [ { "axis": "tool-chain", "level": "preserved", "detail": "..." } ],
  "loss": [ "human-readable loss declarations" ]
}
```

Bundle invariants (enforced by `validateBundle`): `pivot.revision === evidence.length`,
`pivot.seq === evidence.length - 1`, `pivot.id === evidence[0].correlation.agentSessionId`,
every envelope passes the production `validateAgentEnvelope` exact-schema check.

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
cd packages/usl-convert && npm install

# list dimagent sessions
node --import tsx src/cli.ts dimagent-list ~/.dimcode/v2/dimcode.sqlite

# import into the intermediate format
node --import tsx src/cli.ts import pi ~/.pi/agent/sessions/<dir>/<file>.jsonl --out a.asp-bundle.json
node --import tsx src/cli.ts import dimagent ~/.dimcode/v2/dimcode.sqlite --session <sessionId> --out b.asp-bundle.json
node --import tsx src/cli.ts import claude ~/.claude/projects/<dir>/<uuid>.jsonl --out c.asp-bundle.json
node --import tsx src/cli.ts import codex ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl --out d.asp-bundle.json

# export back out
node --import tsx src/cli.ts export pi a.asp-bundle.json --out resumed.jsonl
node --import tsx src/cli.ts export pi a.asp-bundle.json --install-pi          # write into ~/.pi/agent/sessions/<dir>/
node --import tsx src/cli.ts export dimagent b.asp-bundle.json --out rows.json   # portable payload
node --import tsx src/cli.ts export dimagent b.asp-bundle.json --write --db <db> # apply transactionally

# one-shot cross conversion
node --import tsx src/cli.ts convert pi dimagent <file.jsonl> out.json
node --import tsx src/cli.ts convert dimagent pi <db> out.jsonl --session <sessionId>

# introspection
node --import tsx src/cli.ts inspect a.asp-bundle.json
node --import tsx src/cli.ts list-formats
```

## Safety notes

- **Reading a live dimagent DB is WAL-safe**: the importer copies `dimcode.sqlite` + `-wal` +
  `-shm` to a temp dir and opens the copy; the source is never opened for write and is
  verified byte-identical after import.
- **Writing (`--write`) is transactional** (`BEGIN IMMEDIATE`) and inserts a fresh session id;
  message ids are derived from the target session id so repeated exports never collide.
- The exporter never fabricates control-plane facts: exported sessions have no live
  capabilities, no approval state, and no pending actions.

## Layout

```
src/bundle.ts        asp-bundle schema + validation + fidelity types
src/evidence.ts      deterministic envelope builder shared by importers
src/materialize.ts   evidence -> AgentSessionSnapshot (reuses ASP materializer)
src/pi.ts            pi JSONL importer + exporter
src/dimagent.ts      dimagent sqlite importer + exporter (node:sqlite, WAL-safe)
src/cli.ts           subcommands: import / export / convert / inspect / list-formats
test/                fixtures (self-contained) + unit + roundtrip tests
```

Run checks: `npm run check` (typecheck + 14 tests incl. pi→pi, dimagent→dimagent and
cross-harness roundtrips).

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
