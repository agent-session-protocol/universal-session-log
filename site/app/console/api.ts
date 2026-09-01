export type RuntimeKey = "codex" | "claude" | "pi" | "opencode" | "dimagent" | "unknown" | string;

export interface SessionSummary {
  id: string;
  nativeSessionId: string;
  runtime: RuntimeKey;
  project: string | null;
  title: string | null;
  eventCount: number;
  firstSeenAt: number;
  lastUpdatedAt: number;
  status: "ingesting" | "synced";
}

export interface EventSummary {
  seq: number;
  sessionId: string;
  runtime: RuntimeKey;
  kind: number;
  eventType: string;
  timestamp: number;
  body: unknown;
}

export interface Overview {
  sessionCount: number;
  eventCount: number;
  eventsLast24h: number;
  fileBytes: number;
  dataBytes: number;
  integrityPercent: number;
  runtimes: Array<{ runtime: RuntimeKey; sessions: number }>;
  throughput: Array<{ startMs: number; events: number }>;
  generatedAt: number;
}

export interface Storage {
  fileBytes: number;
  dataBytes: number;
  headerBytes: number;
  recordCount: number;
  sessionCount: number;
}

export interface Integrity {
  status: "healthy" | "recovered" | "recovery-required";
  integrityPercent: number;
  checkedFrames: number;
  dataEnd: number;
  nextSeq: number;
  sessionCount: number;
  truncationOffset: number | null;
  quarantineCount: number;
  checkedAt: number;
}

export interface DashboardData {
  runtime: {
    mode: "demo" | "daemon";
    degraded: boolean;
    rebuilding: boolean;
    generation: number | null;
    builtThroughSeq: number | null;
    asOfSeq: number | null;
    enabledProviders: string[];
  };
  overview: Overview;
  sessions: SessionSummary[];
  events: EventSummary[];
  storage: Storage;
  integrity: Integrity;
}

export interface TokenUsage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  contextWindow: number | null;
  cacheHitRate: number;
}

export interface SessionDetail {
  session: SessionSummary;
  analytics: {
    tokens: TokenUsage;
    messageCount: number;
    reasoningCount: number;
    toolCallCount: number;
    toolResultCount: number;
    toolErrorCount: number;
    tools: Array<{ name: string; calls: number; errors: number }>;
  };
  timeline: Array<{
    id: string;
    seq: number;
    timestamp: number;
    category: "message" | "reasoning" | "tool-call" | "tool-result" | "event";
    role: string | null;
    title: string;
    content: string | null;
    toolName: string | null;
    callId: string | null;
    isError: boolean;
  }>;
}

export interface AnalyticsGroup {
  key: string;
  sessions: number;
  events: number;
  tokens: number;
  cachedInput: number;
  toolCalls: number;
  toolErrors: number;
}

export interface GlobalAnalytics {
  sessions: number;
  analyzableSessions: number;
  events: number;
  tokens: TokenUsage;
  messages: number;
  reasoningRecords: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
  byRuntime: AnalyticsGroup[];
  byProject: AnalyticsGroup[];
  trend: Array<{ startMs: number; sessions: number; tokens: number; toolCalls: number; toolErrors: number }>;
  topSessions: Array<{
    id: string;
    nativeSessionId: string;
    runtime: RuntimeKey;
    project: string | null;
    lastUpdatedAt: number;
    tokens: number;
    cachedInput: number;
    cacheHitRate: number;
    toolCalls: number;
    toolErrors: number;
  }>;
  availableRuntimes: string[];
  availableProjects: string[];
  generatedAt: number;
}

export interface AnalyticsFilters {
  runtime?: string;
  project?: string;
  tool?: string;
  search?: string;
  from?: number;
  to?: number;
}

async function fetchDemoDashboard(signal?: AbortSignal): Promise<DashboardData> {
  await delay(signal);
  return structuredClone(dashboard);
}

async function fetchDemoSessionDetail(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  await delay(signal);
  const detail = details[id];
  if (!detail) throw new Error(`Session not found: ${id}`);
  return structuredClone(detail);
}

async function fetchDemoGlobalAnalytics(filters: AnalyticsFilters = {}, signal?: AbortSignal): Promise<GlobalAnalytics> {
  await delay(signal);
  const selected = dashboard.sessions.filter((session) => {
    const detail = details[session.id];
    return (!filters.runtime || session.runtime === filters.runtime)
      && (!filters.project || session.project === filters.project)
      && (!filters.tool || detail.analytics.tools.some((tool) => tool.name === filters.tool))
      && (!filters.search || [session.title, session.project, session.nativeSessionId].some((value) => value?.toLowerCase().includes(filters.search!.toLowerCase())))
      && (!filters.from || session.lastUpdatedAt >= filters.from)
      && (!filters.to || session.lastUpdatedAt <= filters.to);
  });
  return buildAnalytics(selected);
}

export interface ConsoleDataSource {
  dashboard(signal?: AbortSignal): Promise<DashboardData>;
  session(id: string, signal?: AbortSignal): Promise<SessionDetail>;
  analytics(filters?: AnalyticsFilters, signal?: AbortSignal): Promise<GlobalAnalytics>;
}

declare global {
  interface Window { __SESDB_CONSOLE__?: { mode: "demo" | "daemon"; baseUrl?: string } }
}

const demoDataSource: ConsoleDataSource = {
  dashboard: fetchDemoDashboard,
  session: fetchDemoSessionDetail,
  analytics: fetchDemoGlobalAnalytics,
};

async function daemonJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const baseUrl = window.__SESDB_CONSOLE__?.baseUrl ?? "";
  const response = await fetch(`${baseUrl}${path}`, { ...init, credentials: "same-origin", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? `SesDB daemon returned ${response.status}`);
  return body as T;
}

const daemonDataSource: ConsoleDataSource = {
  async dashboard(signal) {
    const [sessionPage, index, providers, stats, integrity] = await Promise.all([
      daemonJson<{ items: Array<Record<string, unknown>> }>("/sessions?limit=1000", signal),
      daemonJson<{ generation: number; builtThroughSeq: number; asOfSeq: number; degraded: boolean; rebuilding?: boolean }>("/index/status", signal),
      daemonJson<{ providers: Record<string, { enabled: boolean }> }>("/providers", signal),
      daemonJson<{ result?: { nextSeq: number; sessionCount: number; dataEnd: number }; nextSeq?: number; sessionCount?: number; dataEnd?: number }>("/rpc", signal, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "stats" }) }),
      daemonJson<{ result?: Integrity }>("/rpc", signal, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "verify" }) }),
    ]);
    const rawStats = stats.result ?? stats as { nextSeq: number; sessionCount: number; dataEnd: number };
    const nativeSessions = sessionPage.items;
    const sessions: SessionSummary[] = nativeSessions.map((item) => ({
      id: String(item.id), nativeSessionId: String(item.nativeSessionId), runtime: String(item.provider), project: typeof item.project === "string" ? item.project : null,
      title: typeof item.title === "string" ? item.title : null, eventCount: Number(item.eventCount), firstSeenAt: Number(item.firstSeenAt), lastUpdatedAt: Number(item.lastUpdatedAt), status: "synced",
    }));
    const now = Date.now();
    const throughput = Array.from({ length: 24 }, (_, index) => ({ startMs: now - (23 - index) * 3600000, events: 0 }));
    const events: EventSummary[] = [];
    const storage: Storage = { fileBytes: rawStats.dataEnd, dataBytes: Math.max(0, rawStats.dataEnd - 4096), headerBytes: 4096, recordCount: rawStats.nextSeq, sessionCount: rawStats.sessionCount };
    const verified = integrity.result;
    const health: Integrity = verified ? { ...verified, status: verified.truncationOffset == null ? "healthy" : "recovery-required", integrityPercent: verified.truncationOffset == null ? 100 : 0, checkedFrames: verified.nextSeq, quarantineCount: verified.truncationOffset == null ? 0 : 1, checkedAt: now } : { status: index.degraded ? "recovery-required" : "healthy", integrityPercent: index.degraded ? 0 : 100, checkedFrames: index.builtThroughSeq, dataEnd: rawStats.dataEnd, nextSeq: rawStats.nextSeq, sessionCount: rawStats.sessionCount, truncationOffset: null, quarantineCount: 0, checkedAt: now };
    const enabledProviders = Object.entries(providers.providers).filter(([, value]) => value.enabled).map(([provider]) => provider);
    return { runtime: { mode: "daemon", degraded: index.degraded, rebuilding: index.rebuilding ?? false, generation: index.generation, builtThroughSeq: index.builtThroughSeq, asOfSeq: index.asOfSeq, enabledProviders }, overview: { sessionCount: sessions.length, eventCount: index.builtThroughSeq, eventsLast24h: 0, fileBytes: storage.fileBytes, dataBytes: storage.dataBytes, integrityPercent: health.integrityPercent, runtimes: Object.entries(Object.groupBy(sessions, value => value.runtime)).map(([runtime, values]) => ({ runtime, sessions: values!.length })), throughput, generatedAt: now }, sessions, events, storage, integrity: health };
  },
  async session(id, signal) {
    const [session, page] = await Promise.all([
      daemonJson<Record<string, unknown>>(`/sessions/${encodeURIComponent(id)}`, signal),
      daemonJson<{ items: Array<Record<string, unknown>> }>(`/sessions/${encodeURIComponent(id)}/events?limit=10000`, signal),
    ]);
    const summary: SessionSummary = { id: String(session.id), nativeSessionId: String(session.nativeSessionId), runtime: String(session.provider), project: typeof session.project === "string" ? session.project : null, title: typeof session.title === "string" ? session.title : null, eventCount: Number(session.eventCount), firstSeenAt: Number(session.firstSeenAt), lastUpdatedAt: Number(session.lastUpdatedAt), status: "synced" };
    const timeline: SessionDetail["timeline"] = page.items.map((item) => { const event = item.event as Record<string, unknown>; const type = String(item.eventType); const category = type.includes("tool.called") ? "tool-call" : type.includes("tool.completed") ? "tool-result" : type.includes("reasoning") ? "reasoning" : type.includes("message") ? "message" : "event"; return { id: String(item.eventId), seq: Number(item.seq), timestamp: Number(item.timestamp), category, role: null, title: type, content: JSON.stringify(event, null, 2), toolName: null, callId: null, isError: false }; });
    return { session: summary, analytics: { tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, contextWindow: null, cacheHitRate: 0 }, messageCount: timeline.filter(value => value.category === "message").length, reasoningCount: timeline.filter(value => value.category === "reasoning").length, toolCallCount: timeline.filter(value => value.category === "tool-call").length, toolResultCount: timeline.filter(value => value.category === "tool-result").length, toolErrorCount: 0, tools: [] }, timeline };
  },
  async analytics() { throw new Error("Capability unavailable: analytics is not part of the Claude/Codex I2 milestone."); },
};

function dataSource(): ConsoleDataSource {
  return typeof window !== "undefined" && window.__SESDB_CONSOLE__?.mode === "daemon" ? daemonDataSource : demoDataSource;
}

export function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> { return dataSource().dashboard(signal); }
export function fetchSessionDetail(id: string, signal?: AbortSignal): Promise<SessionDetail> { return dataSource().session(id, signal); }
export function fetchGlobalAnalytics(filters: AnalyticsFilters = {}, signal?: AbortSignal): Promise<GlobalAnalytics> { return dataSource().analytics(filters, signal); }

const HOUR = 60 * 60 * 1000;
const now = Date.now();

type DemoSpec = {
  id: string; runtime: RuntimeKey; project: string; title: string; age: number;
  events: number; input: number; cached: number; output: number; reasoning: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
};

const specs: DemoSpec[] = [
  { id: "auth-refresh-race", runtime: "codex", project: "web-platform", title: "Repair auth token refresh race", age: .15, events: 286, input: 48200, cached: 31100, output: 6200, reasoning: 4100, tools: [{ name: "read_file", calls: 18, errors: 0 }, { name: "shell", calls: 12, errors: 1 }, { name: "apply_patch", calls: 5, errors: 0 }] },
  { id: "checkout-latency", runtime: "claude", project: "commerce-api", title: "Trace checkout latency regression", age: .7, events: 244, input: 38900, cached: 20600, output: 7100, reasoning: 3200, tools: [{ name: "search", calls: 16, errors: 0 }, { name: "shell", calls: 9, errors: 0 }, { name: "read_file", calls: 11, errors: 0 }] },
  { id: "event-materializer", runtime: "pi", project: "session-service", title: "Add event materializer checkpointing", age: 2.3, events: 218, input: 30600, cached: 17200, output: 5400, reasoning: 2800, tools: [{ name: "read_file", calls: 13, errors: 0 }, { name: "apply_patch", calls: 7, errors: 0 }, { name: "shell", calls: 8, errors: 0 }] },
  { id: "approval-audit", runtime: "codex", project: "deployment", title: "Audit production approval boundaries", age: 5.8, events: 196, input: 28400, cached: 15100, output: 4300, reasoning: 3500, tools: [{ name: "search", calls: 10, errors: 0 }, { name: "read_file", calls: 14, errors: 0 }] },
  { id: "evidence-migration", runtime: "dimagent", project: "migration-tools", title: "Migrate evidence records to Query IR", age: 18, events: 176, input: 24100, cached: 9200, output: 5100, reasoning: 1900, tools: [{ name: "shell", calls: 11, errors: 1 }, { name: "apply_patch", calls: 6, errors: 0 }] },
  { id: "search-index", runtime: "opencode", project: "query-plane", title: "Benchmark hybrid search index", age: 29, events: 164, input: 21900, cached: 11800, output: 3900, reasoning: 2200, tools: [{ name: "search", calls: 19, errors: 0 }, { name: "shell", calls: 7, errors: 0 }] },
  { id: "lineage-traversal", runtime: "claude", project: "query-plane", title: "Implement lineage traversal operators", age: 76, events: 238, input: 35600, cached: 18900, output: 6800, reasoning: 3900, tools: [{ name: "read_file", calls: 17, errors: 0 }, { name: "apply_patch", calls: 8, errors: 0 }] },
  { id: "storage-recovery", runtime: "pi", project: "storage-engine", title: "Verify append-log crash recovery", age: 150, events: 186, input: 26300, cached: 13400, output: 4700, reasoning: 2600, tools: [{ name: "shell", calls: 15, errors: 0 }, { name: "read_file", calls: 9, errors: 0 }] },
];

const sessions: SessionSummary[] = specs.map((spec, index) => ({
  id: `demo-${spec.id}`, nativeSessionId: `${spec.runtime}-${spec.id}-2026`, runtime: spec.runtime,
  project: spec.project, title: spec.title, eventCount: spec.events,
  firstSeenAt: now - (spec.age + 1.8) * HOUR, lastUpdatedAt: now - spec.age * HOUR,
  status: index === 0 ? "ingesting" : "synced",
}));

const details: Record<string, SessionDetail> = Object.fromEntries(specs.map((spec, index) => {
  const session = sessions[index];
  const total = spec.input + spec.output + spec.reasoning;
  const toolCalls = spec.tools.reduce((sum, tool) => sum + tool.calls, 0);
  const toolErrors = spec.tools.reduce((sum, tool) => sum + tool.errors, 0);
  const base = session.firstSeenAt;
  const timeline: SessionDetail["timeline"] = [
    { id: `${spec.id}-1`, seq: 1200 + index * 50, timestamp: base, category: "message", role: "user", title: "User request", content: `Investigate and implement: ${spec.title}. Preserve compatibility and add focused verification.`, toolName: null, callId: null, isError: false },
    { id: `${spec.id}-2`, seq: 1201 + index * 50, timestamp: base + 42000, category: "reasoning", role: null, title: "Plan and evidence", content: "Mapped the affected modules, identified the smallest safe change, and selected checks for the highest-risk path.", toolName: null, callId: null, isError: false },
    { id: `${spec.id}-3`, seq: 1202 + index * 50, timestamp: base + 98000, category: "tool-call", role: null, title: `Call ${spec.tools[0].name}`, content: `{\n  \"scope\": \"${spec.project}\",\n  \"mode\": \"read-only discovery\"\n}`, toolName: spec.tools[0].name, callId: `call_${index + 1}_a`, isError: false },
    { id: `${spec.id}-4`, seq: 1203 + index * 50, timestamp: base + 124000, category: "tool-result", role: null, title: `${spec.tools[0].name} completed`, content: "Relevant implementation and tests located. No unrelated files changed.", toolName: spec.tools[0].name, callId: `call_${index + 1}_a`, isError: false },
    { id: `${spec.id}-5`, seq: 1204 + index * 50, timestamp: session.lastUpdatedAt, category: "message", role: "assistant", title: "Assistant response", content: `Implemented ${spec.title.toLowerCase()} and verified the focused workflow.`, toolName: null, callId: null, isError: false },
  ];
  return [session.id, { session, analytics: { tokens: { input: spec.input, cachedInput: spec.cached, cacheWrite: Math.round(spec.cached * .08), output: spec.output, reasoning: spec.reasoning, total, contextWindow: 200000, cacheHitRate: spec.cached / spec.input }, messageCount: 12 + index, reasoningCount: 4 + index % 4, toolCallCount: toolCalls, toolResultCount: toolCalls, toolErrorCount: toolErrors, tools: spec.tools }, timeline }];
}));

const recordCount = specs.reduce((sum, spec) => sum + spec.events, 0);
const events: EventSummary[] = sessions.slice(0, 8).map((session, index) => ({ seq: 1708 - index, sessionId: session.id, runtime: session.runtime, kind: index % 3, eventType: ["assistant.message", "tool.result", "session.updated"][index % 3], timestamp: session.lastUpdatedAt, body: { demo: true } }));
const throughput = Array.from({ length: 24 }, (_, index) => ({ startMs: now - (23 - index) * HOUR, events: [3, 1, 2, 0, 4, 6, 8, 5, 13, 19, 24, 17, 31, 28, 42, 36, 52, 44, 63, 58, 71, 66, 82, 94][index] }));
const storage: Storage = { fileBytes: 7_675_904, dataBytes: 7_671_808, headerBytes: 4096, recordCount, sessionCount: sessions.length };
const integrity: Integrity = { status: "healthy", integrityPercent: 100, checkedFrames: recordCount, dataEnd: storage.dataBytes, nextSeq: 1709, sessionCount: sessions.length, truncationOffset: null, quarantineCount: 0, checkedAt: now };
const dashboard: DashboardData = {
  runtime: { mode: "demo", degraded: false, rebuilding: false, generation: null, builtThroughSeq: null, asOfSeq: null, enabledProviders: [] },
  overview: { sessionCount: sessions.length, eventCount: recordCount, eventsLast24h: throughput.reduce((sum, item) => sum + item.events, 0), fileBytes: storage.fileBytes, dataBytes: storage.dataBytes, integrityPercent: 100, runtimes: Object.entries(Object.groupBy(sessions, (session) => session.runtime)).map(([runtime, values]) => ({ runtime, sessions: values!.length })), throughput, generatedAt: now },
  sessions, events, storage, integrity,
};

function buildAnalytics(selected: SessionSummary[]): GlobalAnalytics {
  const selectedDetails = selected.map((session) => details[session.id]);
  const tokenTotals = selectedDetails.reduce((sum, item) => ({ input: sum.input + item.analytics.tokens.input, cachedInput: sum.cachedInput + item.analytics.tokens.cachedInput, cacheWrite: sum.cacheWrite + item.analytics.tokens.cacheWrite, output: sum.output + item.analytics.tokens.output, reasoning: sum.reasoning + item.analytics.tokens.reasoning, total: sum.total + item.analytics.tokens.total }), { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
  const toolMap = new Map<string, { name: string; calls: number; errors: number }>();
  selectedDetails.flatMap((item) => item.analytics.tools).forEach((tool) => { const value = toolMap.get(tool.name) ?? { name: tool.name, calls: 0, errors: 0 }; value.calls += tool.calls; value.errors += tool.errors; toolMap.set(tool.name, value); });
  const tools = [...toolMap.values()].sort((a, b) => b.calls - a.calls);
  const group = (key: (session: SessionSummary) => string) => Object.entries(Object.groupBy(selected, key)).map(([name, values]) => ({ key: name, sessions: values!.length, events: values!.reduce((sum, item) => sum + item.eventCount, 0), tokens: values!.reduce((sum, item) => sum + details[item.id].analytics.tokens.total, 0), cachedInput: values!.reduce((sum, item) => sum + details[item.id].analytics.tokens.cachedInput, 0), toolCalls: values!.reduce((sum, item) => sum + details[item.id].analytics.toolCallCount, 0), toolErrors: values!.reduce((sum, item) => sum + details[item.id].analytics.toolErrorCount, 0) }));
  const trend = groupByDay(selected);
  return { sessions: selected.length, analyzableSessions: selected.length, events: selected.reduce((sum, item) => sum + item.eventCount, 0), tokens: { ...tokenTotals, contextWindow: null, cacheHitRate: tokenTotals.input ? tokenTotals.cachedInput / tokenTotals.input : 0 }, messages: selectedDetails.reduce((sum, item) => sum + item.analytics.messageCount, 0), reasoningRecords: selectedDetails.reduce((sum, item) => sum + item.analytics.reasoningCount, 0), toolCalls: tools.reduce((sum, item) => sum + item.calls, 0), toolResults: tools.reduce((sum, item) => sum + item.calls, 0), toolErrors: tools.reduce((sum, item) => sum + item.errors, 0), tools, byRuntime: group((session) => session.runtime), byProject: group((session) => session.project ?? "Unassigned"), trend, topSessions: selected.map((session) => ({ id: session.id, nativeSessionId: session.nativeSessionId, runtime: session.runtime, project: session.project, lastUpdatedAt: session.lastUpdatedAt, tokens: details[session.id].analytics.tokens.total, cachedInput: details[session.id].analytics.tokens.cachedInput, cacheHitRate: details[session.id].analytics.tokens.cacheHitRate, toolCalls: details[session.id].analytics.toolCallCount, toolErrors: details[session.id].analytics.toolErrorCount })).sort((a, b) => b.tokens - a.tokens), availableRuntimes: [...new Set(sessions.map((session) => session.runtime))], availableProjects: [...new Set(sessions.flatMap((session) => session.project ? [session.project] : []))], generatedAt: Date.now() };
}

function groupByDay(selected: SessionSummary[]): GlobalAnalytics["trend"] {
  const groups = new Map<number, GlobalAnalytics["trend"][number]>();
  selected.forEach((session) => { const date = new Date(session.lastUpdatedAt); date.setHours(0, 0, 0, 0); const startMs = date.getTime(); const value = groups.get(startMs) ?? { startMs, sessions: 0, tokens: 0, toolCalls: 0, toolErrors: 0 }; const detail = details[session.id]; value.sessions++; value.tokens += detail.analytics.tokens.total; value.toolCalls += detail.analytics.toolCallCount; value.toolErrors += detail.analytics.toolErrorCount; groups.set(startMs, value); });
  return [...groups.values()].sort((a, b) => a.startMs - b.startMs);
}

function delay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = window.setTimeout(resolve, 180);
    signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
