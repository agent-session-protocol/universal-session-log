# GEO readiness audit — 2026-09-01

## Scope

| Product | Audited target |
| --- | --- |
| ASP | `https://agent-session-protocol.github.io/` |
| USL | `https://agent-session-protocol.github.io/universal-session-log/` |
| SesDB | `https://agent-session-protocol.github.io/universal-session-log/console` |

All three targets are on `agent-session-protocol.github.io`. open-geo performs
robots, sitemap, `llms.txt`, security, and organization checks at host level, so
the three raw artifacts intentionally share most findings.

## Result

**Verdict: `ready_with_warnings` — 57/100, no crawl blocker.**

- HTTPS works and every target returns HTTP 200.
- Googlebot is not blocked (there is currently no `robots.txt`).
- Primary content is present in raw server-rendered HTML.
- The host-level `/llms.txt` exists and has a top-level heading.
- The target is safe to measure, but important discovery and entity signals are
  missing.

## Page-level check

open-geo's content score is host-homepage based. A separate pass with its own HTML
analyzer produced the following target-specific detail:

| Target | Title | Description | Canonical | H1 | Raw words | JSON-LD |
| --- | --- | --- | --- | ---: | ---: | ---: |
| ASP home | missing | missing | missing | 1 | 84 | 0 |
| USL home | missing | missing | missing | 1 | 443 | 0 |
| SesDB console | present | present | missing | 1 | 87 | 0 |

All three pages have a `<main>`/`<article>` landmark and a valid heading order.

## Remediation status

Implemented in the 2026-09-01 site changes:

- [x] Unique ASP, USL, and SesDB titles and descriptions.
- [x] Absolute canonical URLs for product, console, About/Contact, and docs pages.
- [x] Host-root and USL-subtree XML sitemaps plus robots declarations.
- [x] Organization, WebSite, SoftwareSourceCode, and SoftwareApplication JSON-LD.
- [x] About and Contact pages linked from the shared homepage.
- [x] Visible update dates, Atom feed, logo, and `/.well-known/security.txt`.
- [x] ASP's durable-session descriptor and `SesDB` public-brand casing.
- [x] Query-driven pages for session log vs memory/trace, USL vs OpenMemory and
      native files, SesDB's implemented local-search boundary, and ASP's place
      beside ACP, MCP, A2A, and OpenTelemetry.

Both static exports passed type checking and production builds. Running the same
open-geo checks against those exported files through a local `MockTransport`
produced **`ready / 100`** for ASP, USL, and SesDB with no non-pass checks. After
both GitHub Pages deployments completed, a forced no-cache public audit produced
the same **`ready / 100`** result for all three targets. The raw live artifacts
are stored alongside the baseline JSON files with a `live-2026-09-01` suffix.

## Findings and recommended order

### P0 — establish crawl and canonical identity

1. Add unique `title`, description, and canonical metadata to the ASP and USL
   homepages; add a canonical URL to the SesDB console.
2. Publish a valid host-root `/sitemap.xml` containing both the ASP root and USL
   subtree, and reference it from `/robots.txt`.
3. Add host-root Organization JSON-LD with a stable name, logo, canonical URL,
   and `sameAs` links. Add appropriate product/document schemas on the USL,
   SesDB, and ASP pages.
4. Keep the existing `/llms.txt`, but make the product identities and canonical
   URLs explicit. The USL subtree's own `llms.txt` is useful to AI clients but
   does not replace the host-root discovery files.

### P1 — improve trust and freshness

1. Link About and Contact/governance information from the shared homepage.
2. Add visible `dateModified` information to versioned specifications and docs.
3. Publish `/.well-known/security.txt`.
4. Add an RSS/Atom release or specification-update feed if the project will
   publish regularly; this is lower priority than metadata and sitemap work.

### P1 — resolve product/entity ambiguity

The grounded ASP research found multiple unrelated uses of “Agent Session
Protocol” and “ASP”. Use the full descriptor consistently:

> Agent Session Protocol (ASP) — the durable session storage and migration
> protocol for AI agents.

Likewise, standardize `SesDB` versus `SESDB` casing and always connect it to the
category phrase “local agent-session database and query engine”.

### P2 — build answerable pages from the query baseline (implemented)

Prioritize concise pages that directly answer repeated intents:

- session log versus memory versus observability trace;
- ASP versus ACP, MCP, A2A, and OpenTelemetry GenAI;
- USL versus OpenMemory and native harness session files;
- SesDB local search/indexing, supported formats, privacy, usage analytics, and
  training/evaluation dataset export;
- verified fidelity, opaque vendor fields, crash recovery, and cross-harness
  resume boundaries.

Each page should state current support honestly, include runnable examples, link
to the canonical spec/implementation, and avoid claiming exporters or production
readiness that have not been verified.

## Tool caveat

open-geo `v0.4.1` initially normalized `agent-session-protocol.github.io` to
`github.io`, which would have audited the wrong site. That result was discarded.
The managed runtime was patched to treat `github.io` as a multi-part public
suffix, its normalization/audit tests passed, and all three audits were rerun
against the correct host. The raw artifacts in this directory show
`domain: agent-session-protocol.github.io` and are the only accepted results.
