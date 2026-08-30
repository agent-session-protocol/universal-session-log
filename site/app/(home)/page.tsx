import Link from 'next/link';
import { ArrowRight, Boxes, Database, GitBranch, Radio, Search, ShieldCheck, Sparkles } from 'lucide-react';

const basePath = '/universal-session-log';
const consolePages = [
  ['overview', 'Overview', 'Snapshot health, ingest volume, and stream activity.'],
  ['sessions', 'Sessions', 'Canonical sessions across Codex, Claude Code, Pi, and Dimagent.'],
  ['query', 'Query Explorer', 'SessionQL editing with a typed, inspectable execution plan.'],
  ['insights', 'Insights', 'Provenance-complete derived knowledge and review workflow.'],
  ['audit', 'Live Audit', 'Deterministic replay-plus-tail subscriptions.'],
  ['indexes', 'Indexes', 'Immutable generations, watermarks, and policy isolation.'],
] as const;
const capabilities = [
  [Search, 'SessionQL', 'A typed pipeline language for events, search, bounded patterns, lineage, and aggregation.'],
  [Database, 'One source of truth', 'The append-only L1 log remains canonical; every index and projection is rebuildable.'],
  [ShieldCheck, 'Fixed snapshots', 'Every result and cursor is pinned to one asOfSeq, policy, and set of index generations.'],
  [Boxes, 'Evidence-first search', 'Text, semantic, and hybrid results link highlights and offsets back to canonical events.'],
  [GitBranch, 'Runtime lineage', 'Traverse fork, resume, handoff, and subagent edges without losing provenance.'],
  [Radio, 'Replay + tail', 'Bounded subscriptions move from deterministic replay into an at-least-once live stream.'],
] as const;

export default function HomePage() {
  return (
    <main className="flex-1 overflow-hidden">
      <section className="relative border-b border-fd-border px-6 py-20 sm:py-28">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_srgb,var(--color-fd-primary)_10%,transparent),transparent_44%)]" />
        <div className="relative mx-auto max-w-6xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1.5 text-xs font-medium text-fd-muted-foreground"><Sparkles className="size-3.5 text-fd-primary" />RFC 0001 · SessionQL 1.0 and Query IR 1.0</div>
          <div className="grid items-end gap-10 lg:grid-cols-[1.2fr_.8fr]">
            <div>
              <h1 className="max-w-4xl text-5xl font-bold tracking-[-0.055em] sm:text-7xl">The query plane for every agent session.</h1>
              <p className="mt-7 max-w-2xl text-lg leading-8 text-fd-muted-foreground sm:text-xl">USL turns runtime-specific logs into durable canonical facts, then makes them searchable, explainable, resumable, and safe to stream.</p>
            </div>
            <div className="rounded-xl border border-fd-border bg-fd-card p-1 shadow-sm">
              <div className="flex items-center gap-1.5 border-b border-fd-border px-3 py-2"><i className="size-2 rounded-full bg-red-400/70" /><i className="size-2 rounded-full bg-amber-400/70" /><i className="size-2 rounded-full bg-emerald-500/70" /><span className="ml-2 font-mono text-[10px] text-fd-muted-foreground">sessionql</span></div>
              <pre className="overflow-x-auto p-4 text-left font-mono text-xs leading-6 sm:text-[13px]"><code>{`from sessions
| search hybrid $question top 3
| where provenance.runtime in $runtimes
| project sessionId, title, search.hits
| sort by search.score desc
| limit 20`}</code></pre>
            </div>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/docs/sessionql" className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground hover:bg-fd-primary/90">Explore SessionQL <ArrowRight className="size-4" /></Link>
            <Link href="/docs/getting-started" className="rounded-lg border border-fd-border bg-fd-background px-5 py-2.5 text-sm font-semibold hover:bg-fd-accent">Start with the storage engine</Link>
          </div>
        </div>
      </section>

      <section className="border-b border-fd-border px-6 py-20"><div className="mx-auto max-w-6xl">
        <div className="mb-10 max-w-2xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">Portable semantics</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">One contract from storage to insight.</h2><p className="mt-4 leading-7 text-fd-muted-foreground">The L1 log stays simple. Typed query semantics, evidence, and policy-aware sidecars compose above it without taking ownership of the facts.</p></div>
        <div className="grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">{capabilities.map(([Icon, title, body]) => <article key={title} className="bg-fd-background p-6 text-left"><Icon className="mb-5 size-5 text-fd-primary" /><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{body}</p></article>)}</div>
      </div></section>

      <section className="border-b border-fd-border bg-fd-card/30 px-4 py-20 sm:px-6"><div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div className="max-w-2xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">Interactive architecture</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Follow the data, not a slide.</h2><p className="mt-4 leading-7 text-fd-muted-foreground">Explore modules, dependency edges, runtime flows, and evidence-backed wiki pages in the live architecture map.</p></div><a href={`${basePath}/architecture.html`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-fd-primary hover:underline">Open full screen <ArrowRight className="size-4" /></a></div>
        <div className="overflow-hidden rounded-2xl border border-fd-border bg-fd-background p-2 shadow-[0_18px_60px_-35px_rgba(0,0,0,.35)] sm:p-3"><iframe src={`${basePath}/architecture.html`} title="Interactive USL architecture map" loading="lazy" className="h-[560px] w-full rounded-xl border-0 sm:h-[680px]" /></div>
      </div></section>

      <section className="px-4 py-20 sm:px-6"><div className="mx-auto max-w-7xl">
        <div className="mb-10 max-w-3xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">Query Console</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Every operational surface, in English.</h2><p className="mt-4 leading-7 text-fd-muted-foreground">A reproducible product preview derived from RFC 0001. Open any capture to inspect the corresponding live console view.</p></div>
        <div className="grid gap-8 lg:grid-cols-2">{consolePages.map(([slug, title, description]) => <figure key={slug} className="group overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm"><a href={`${basePath}/query-console.html?view=${slug}`} target="_blank" rel="noreferrer" className="block overflow-hidden border-b border-fd-border bg-fd-muted/30"><img src={`${basePath}/screenshots/query-console-${slug}.png`} alt={`${title} page in the English USL Query Console`} className="aspect-[16/10] w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.015]" /></a><figcaption className="flex items-start gap-5 p-5 text-left"><div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{description}</p></div><a href={`${basePath}/query-console.html?view=${slug}`} target="_blank" rel="noreferrer" aria-label={`Open ${title}`} className="ml-auto rounded-md border border-fd-border p-2 text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground"><ArrowRight className="size-4" /></a></figcaption></figure>)}</div>
      </div></section>
    </main>
  );
}
