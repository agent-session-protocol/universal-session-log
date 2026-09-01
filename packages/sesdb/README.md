# SesDB v0.2 alpha

SesDB is a local, evidence-backed session database. The USL append log is the
only durable authority; the bundled SQLite FTS5 database and Console are
rebuildable projections.

## Quick start

```bash
sesdb daemon start
sesdb provider discover
sesdb provider enable claude       # or: codex --root /isolated/root
sesdb index reconcile
sesdb search "literal phrase"
sesdb sessions
sesdb console                      # returns a one-use browser URL
```

Claude and Codex providers are disabled by default. Discovery reads only path
metadata. Enabling permits SesDB to read configured roots and persist exact
source bytes as evidence. Disabling stops collection without deleting facts.

Default files are `~/.sesdb/sesdb.usl`, `sesdb.sqlite`, `config.json`, and
`run/daemon.json`. The daemon binds only `127.0.0.1` on an ephemeral port and
uses a 256-bit bearer. The Console receives an HttpOnly, SameSite=Strict,
read-only cookie; management routes continue to require the bearer.

## SDK

```ts
import { connectSesdb } from "@agent-session-protocol/sesdb";

const db = await connectSesdb();
const page = await db.searchPage("tool failure");
await db.reconcile("codex");
await db.rebuildIndex();
```

`createSesdb(engine)` and the authenticated NDJSON `sesdb-engine` remain
compatible. Set `SESDB_TRANSPORT=stdio` for that development transport.

This alpha covers the Claude/Codex incremental slice, literal FTS5,
sessions/timeline/evidence APIs, rebuild, and a minimal real Console. Pi, Kimi,
DeepSeek, analytics, Memory, semantic search, subscriptions, SQL, and desktop
packaging are unavailable. The five-provider I0 gate remains in progress.
