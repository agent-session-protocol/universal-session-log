'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Boxes, Database, GitBranch, Languages, Radio, Search, ShieldCheck, Sparkles } from 'lucide-react';

type Locale = 'en' | 'zh';
const basePath = '/universal-session-log';

const copy = {
  en: {
    toggle: '中文',
    badge: 'RFC 0001 · SessionQL 1.0 and Query IR 1.0',
    hero: 'The query plane for every agent session.',
    heroBody: 'USL turns runtime-specific logs into durable canonical facts, then makes them searchable, explainable, resumable, and safe to stream.',
    primary: 'Explore SessionQL',
    secondary: 'Start with the storage engine',
    portableKicker: 'Portable semantics',
    portableTitle: 'One contract from storage to insight.',
    portableBody: 'The L1 log stays simple. Typed query semantics, evidence, and policy-aware sidecars compose above it without taking ownership of the facts.',
    architectureKicker: 'Interactive architecture',
    architectureTitle: 'Follow the data, not a slide.',
    architectureBody: 'Explore modules, dependency edges, runtime flows, and evidence-backed wiki pages in the live architecture map.',
    fullscreen: 'Open full screen',
    consoleKicker: 'SESDB Console',
    consoleTitle: 'Operate the session database with confidence.',
    consoleBody: 'Monitor ingestion, inspect real sessions and native events, compare runtime usage, and verify the physical append log from one management console.',
  },
  zh: {
    toggle: 'EN',
    badge: 'RFC 0001 · SessionQL 1.0 与 Query IR 1.0',
    hero: '面向所有 Agent 会话的统一查询平面。',
    heroBody: 'USL 将不同 Runtime 的日志沉淀为持久、规范的事实，并提供可搜索、可解释、可恢复、可实时订阅的统一能力。',
    primary: '了解 SessionQL',
    secondary: '从存储引擎开始',
    portableKicker: '可移植语义',
    portableTitle: '从存储到洞察，遵循同一份契约。',
    portableBody: 'L1 日志保持简单可靠；类型化查询、证据与策略隔离的 sidecar 在其上组合，但永远不取代事实真源。',
    architectureKicker: '交互式架构',
    architectureTitle: '沿着数据流理解系统，而不是看一张静态幻灯片。',
    architectureBody: '在实时架构地图中探索模块、依赖边、运行流与每条结论可追溯的 Wiki 页面。',
    fullscreen: '全屏打开',
    consoleKicker: 'SESDB 管理控制台',
    consoleTitle: '一个后台，掌握每一条 Agent 会话。',
    consoleBody: '统一监控写入、检查真实 Session 与原生事件、比较不同 Runtime 的使用情况，并验证底层 append log 的完整性。',
  },
} as const;

const capabilities = {
  en: [
    [Search, 'SessionQL', 'A typed pipeline language for events, search, bounded patterns, lineage, and aggregation.'],
    [Database, 'One source of truth', 'The append-only L1 log remains canonical; every index and projection is rebuildable.'],
    [ShieldCheck, 'Fixed snapshots', 'Every result and cursor is pinned to one asOfSeq, policy, and set of index generations.'],
    [Boxes, 'Evidence-first search', 'Text, semantic, and hybrid results link highlights and offsets back to canonical events.'],
    [GitBranch, 'Runtime lineage', 'Traverse fork, resume, handoff, and subagent edges without losing provenance.'],
    [Radio, 'Replay + tail', 'Bounded subscriptions move from deterministic replay into an at-least-once live stream.'],
  ],
  zh: [
    [Search, 'SessionQL', '面向事件、搜索、有界模式、Lineage 与聚合的类型化管道语言。'],
    [Database, '唯一事实真源', 'Append-only L1 日志始终保持 canonical；所有索引与投影都可重建。'],
    [ShieldCheck, '固定快照', '每个结果与游标都绑定 asOfSeq、访问策略和索引 generation。'],
    [Boxes, '证据优先的搜索', '全文、语义与混合搜索的高亮和偏移都能回溯到 canonical event。'],
    [GitBranch, 'Runtime Lineage', '在保留 provenance 的前提下遍历 fork、resume、handoff 与 subagent。'],
    [Radio, 'Replay + Tail', '有界订阅先确定性回放，再进入 at-least-once 的实时事件流。'],
  ],
} as const;

const consolePages = {
  en: [
    ['overview', 'Operations overview', 'Live throughput, runtime distribution, recent sessions, and integrity health.'],
    ['sessions', 'Sessions and events', 'Browse real sessions and inspect the latest native events from every source.'],
    ['analytics', 'Global analytics', 'Compare tokens, cache efficiency, tools, projects, and runtimes in one metrics layer.'],
    ['runtimes', 'Source runtimes', 'Understand ingestion coverage across Codex, Claude Code, Pi, OpenCode, and Dimagent.'],
    ['storage', 'Physical storage', 'Inspect file size, valid data, headers, frames, and the append-only layout.'],
    ['integrity', 'Integrity report', 'Rescan frame boundaries, CRCs, recovery positions, and quarantine state.'],
  ],
  zh: [
    ['overview', '运行概览', '实时查看写入吞吐、Runtime 分布、最近会话与完整性状态。'],
    ['sessions', '会话与事件', '浏览真实 Session，并检查每个来源最近写入的原生事件。'],
    ['analytics', '全局分析', '在统一指标层比较 Token、缓存效率、工具、项目与 Runtime。'],
    ['runtimes', '来源 Runtime', '了解 Codex、Claude Code、Pi、OpenCode 与 Dimagent 的接入覆盖。'],
    ['storage', '物理存储', '检查文件大小、有效数据、Header、持久化帧与 append-only 布局。'],
    ['integrity', '完整性报告', '重新扫描帧边界、CRC、恢复位置与隔离状态。'],
  ],
} as const;

export default function HomePage() {
  const [locale, setLocale] = useState<Locale>('en');
  const t = copy[locale];

  useEffect(() => {
    const saved = window.localStorage.getItem('usl-locale');
    if (saved === 'en' || saved === 'zh') setLocale(saved);
    else if (navigator.language.toLowerCase().startsWith('zh')) setLocale('zh');
  }, []);

  const switchLocale = () => {
    const next = locale === 'en' ? 'zh' : 'en';
    setLocale(next);
    window.localStorage.setItem('usl-locale', next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  };

  return (
    <main className="flex-1 overflow-hidden">
      <button onClick={switchLocale} className="fixed right-5 top-18 z-40 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-background/90 px-3 py-2 text-xs font-semibold shadow-sm backdrop-blur hover:bg-fd-accent sm:right-8" aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}>
        <Languages className="size-4" />{t.toggle}
      </button>

      <section className="relative border-b border-fd-border px-6 py-20 sm:py-28">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_srgb,var(--color-fd-primary)_10%,transparent),transparent_44%)]" />
        <div className="relative mx-auto max-w-6xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1.5 text-xs font-medium text-fd-muted-foreground"><Sparkles className="size-3.5 text-fd-primary" />{t.badge}</div>
          <div className="grid items-end gap-10 lg:grid-cols-[1.2fr_.8fr]">
            <div><h1 className="max-w-4xl text-5xl font-bold tracking-[-0.055em] sm:text-7xl">{t.hero}</h1><p className="mt-7 max-w-2xl text-lg leading-8 text-fd-muted-foreground sm:text-xl">{t.heroBody}</p></div>
            <div className="rounded-xl border border-fd-border bg-fd-card p-1 shadow-sm"><div className="flex items-center gap-1.5 border-b border-fd-border px-3 py-2"><i className="size-2 rounded-full bg-red-400/70" /><i className="size-2 rounded-full bg-amber-400/70" /><i className="size-2 rounded-full bg-emerald-500/70" /><span className="ml-2 font-mono text-[10px] text-fd-muted-foreground">sessionql</span></div><pre className="overflow-x-auto p-4 text-left font-mono text-xs leading-6 sm:text-[13px]"><code>{`from sessions
| search hybrid $question top 3
| where provenance.runtime in $runtimes
| project sessionId, title, search.hits
| sort by search.score desc
| limit 20`}</code></pre></div>
          </div>
          <div className="mt-10 flex flex-wrap gap-3"><Link href="/docs/sessionql" className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground hover:bg-fd-primary/90">{t.primary} <ArrowRight className="size-4" /></Link><Link href="/docs/getting-started" className="rounded-lg border border-fd-border bg-fd-background px-5 py-2.5 text-sm font-semibold hover:bg-fd-accent">{t.secondary}</Link></div>
        </div>
      </section>

      <section className="border-b border-fd-border px-6 py-20"><div className="mx-auto max-w-6xl"><div className="mb-10 max-w-2xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">{t.portableKicker}</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.portableTitle}</h2><p className="mt-4 leading-7 text-fd-muted-foreground">{t.portableBody}</p></div><div className="grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">{capabilities[locale].map(([Icon, title, body]) => <article key={title} className="bg-fd-background p-6 text-left"><Icon className="mb-5 size-5 text-fd-primary" /><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{body}</p></article>)}</div></div></section>

      <section className="border-b border-fd-border bg-fd-card/30 px-4 py-20 sm:px-6"><div className="mx-auto max-w-7xl"><div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div className="max-w-2xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">{t.architectureKicker}</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.architectureTitle}</h2><p className="mt-4 leading-7 text-fd-muted-foreground">{t.architectureBody}</p></div><a href={`${basePath}/architecture.html?lang=${locale}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-fd-primary hover:underline">{t.fullscreen} <ArrowRight className="size-4" /></a></div><div className="overflow-hidden rounded-2xl border border-fd-border bg-fd-background p-2 shadow-[0_18px_60px_-35px_rgba(0,0,0,.35)] sm:p-3"><iframe key={locale} src={`${basePath}/architecture.html?lang=${locale}`} title={locale === 'en' ? 'Interactive USL architecture map' : 'USL 交互式架构图'} className="h-[560px] w-full rounded-xl border-0 sm:h-[680px]" /></div></div></section>

      <section className="px-4 py-20 sm:px-6"><div className="mx-auto max-w-7xl"><div className="mb-10 max-w-3xl"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-fd-primary">{t.consoleKicker}</p><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.consoleTitle}</h2><p className="mt-4 leading-7 text-fd-muted-foreground">{t.consoleBody}</p></div><div className="grid gap-8 lg:grid-cols-2">{consolePages[locale].map(([slug, title, description]) => <figure key={slug} className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm"><div className="overflow-hidden border-b border-fd-border bg-fd-muted/30"><img src={`${basePath}/screenshots/admin/${slug}-${locale}.png`} alt={`${title} — SESDB Console`} className="aspect-[16/10] w-full object-cover object-top" /></div><figcaption className="p-5 text-left"><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{description}</p></figcaption></figure>)}</div></div></section>
    </main>
  );
}
