# USL / SesDB / ASP GEO baseline

This directory contains the bilingual query baseline and the first open-geo
readiness audit for the Agent Session Protocol project family.

## Query sets

Each CSV uses the open-geo `query,lens` contract. The English and Simplified
Chinese sets are independently grounded rather than mechanically translated.

| Product | English | Simplified Chinese | Lens balance per language |
| --- | --- | --- | --- |
| USL | [`questions/usl-en.csv`](questions/usl-en.csv) | [`questions/usl-zh-CN.csv`](questions/usl-zh-CN.csv) | 12 general / 5 branded / 3 comparative |
| SesDB | [`questions/sesdb-en.csv`](questions/sesdb-en.csv) | [`questions/sesdb-zh-CN.csv`](questions/sesdb-zh-CN.csv) | 11 general / 5 branded / 4 comparative |
| ASP | [`questions/asp-en.csv`](questions/asp-en.csv) | [`questions/asp-zh-CN.csv`](questions/asp-zh-CN.csv) | 10 general / 5 branded / 5 comparative |

Grounding and selection notes:

- [`questions/usl-rationale.md`](questions/usl-rationale.md)
- [`questions/sesdb-rationale.md`](questions/sesdb-rationale.md)
- [`questions/asp-rationale.md`](questions/asp-rationale.md)

## Readiness audit

- Human-readable findings: [`readiness-audit-2026-09-01.md`](readiness-audit-2026-09-01.md)
- Raw open-geo baseline and post-fix projected artifacts: [`audits/`](audits/)

The three products currently share one GitHub Pages host. Host-level findings
therefore overlap; target-path checks still verify that each product entry returns
HTTP 200 and contains server-rendered content.

## Method

- open-geo version: `v0.4.1`
- audit engine policy: `google`
- query count: 20 per product per language (120 total)
- synthesis: grounded recon, meaning-level deduplication, lens validation, and
  adversarial KEEP/CUT review
- build result: six runs of `python -m harvest.build`, all with `errors: []`

These files are a measurement baseline, not proof of search volume or ranking.
Run real engine captures only after reviewing the questions and connecting a
visible, logged-in browser as required by open-geo.

The 2026-09-01 remediation was first verified against both static exports with
the open-geo checker through a local `MockTransport`, then verified again after
GitHub Pages deployment. ASP, USL, and SesDB all returned `ready / 100` with no
non-pass checks. The public results use the `live-2026-09-01.json` suffix; the
files ending in `projected-2026-09-01.json` remain the pre-deployment build
verification.
