'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, Bot, Boxes, Brain, CheckCircle2, ChevronRight, CircleGauge,
  Clock3, Command, Database, FileJson, Filter, HardDrive, Hexagon, Layers3, Menu,
  RefreshCw, Search, ShieldCheck, TerminalSquare, Wrench, X, Zap, Languages, ArrowUpRight,
} from "lucide-react";
import { fetchDashboard, fetchGlobalAnalytics, fetchSessionDetail, type AnalyticsGroup, type DashboardData, type GlobalAnalytics, type RuntimeKey, type SessionDetail, type SessionSummary } from "./api";

type View = "overview" | "sessions" | "analytics" | "runtimes" | "storage" | "integrity";

const validViews: View[] = ["overview", "sessions", "analytics", "runtimes", "storage", "integrity"];

const englishReplacements: Array<[string, string]> = [
  ["运行概览", "Operations overview"], ["会话与事件", "Sessions & events"], ["全局分析", "Global analytics"],
  ["运行时", "Runtimes"], ["完整性", "Integrity"], ["存储", "Storage"], ["概览", "Overview"], ["会话", "Sessions"],
  ["所有数字均从当前 SESDB append log 实时投影。", "Every metric is projected from the current SESDB append log."],
  ["浏览真实 Session，并检查每个来源最近写入的原生事件。", "Browse sessions and inspect the latest native events from every source."],
  ["在统一 Session 指标层上，按时间、Runtime、项目与工具交叉筛选聚合。", "Filter the unified session metrics layer by time, runtime, project, and tool."],
  ["查看各 Agent Runtime 的 Session 覆盖和接入规模。", "Compare session coverage and ingestion volume across agent runtimes."],
  ["查看数据库物理布局、有效数据区域和持久化帧。", "Inspect the physical layout, valid data region, and persisted frames."],
  ["从磁盘重新扫描帧边界、CRC 与恢复位置。", "Rescan frame boundaries, CRCs, and recovery positions from disk."],
  ["数据库", "Database"], ["数据库文件", "Database file"], ["本地数据库", "Local database"],
  ["刷新数据", "Refresh data"], ["会话总数", "Total sessions"], ["事件记录", "Event records"], ["帧完整性", "Frame integrity"],
  ["写入吞吐", "Ingestion throughput"], ["持久化事件", "Persisted events"], ["最近 24 小时", "Last 24 hours"],
  ["CRC 校验", "CRC verified"], ["最近", "Recent"],
  ["运行时分布", "Runtime distribution"], ["查看详情", "View details"], ["最近会话与事件", "Recent sessions & events"],
  ["查看全部", "View all"], ["检查报告", "Open report"], ["只读扫描有效日志前缀", "Read-only scan of the valid log prefix"],
  ["会话总数", "Total sessions"], ["有效日志前缀中的唯一 Session", "Unique sessions in the valid log prefix"],
  ["个持久化帧", " persisted frames"], ["CRC 校验", "CRC verified"], ["帧", " frames"], ["事件", " events"],
  ["来自 Session header 的 harness", "Harness recorded in session headers"], ["个最近 Session", " recent sessions"],
  ["会话与事件", "Sessions & events"], ["Session 列表", "Session list"], ["条匹配结果", " matching results"], ["点击查看详情", "click to inspect"],
  ["全部运行时", "All runtimes"], ["最近事件", "Recent events"], ["按全局 sequence 倒序", "Newest global sequence first"],
  ["项目", "Project"], ["事件数", "Events"], ["最近事件", "Latest event"], ["状态", "Status"], ["更新时间", "Updated"],
  ["写入中", "Ingesting"], ["已同步", "Synced"], ["没有匹配的 Session", "No matching sessions"],
  ["调整搜索条件或通过管理 API 导入数据。", "Adjust the search or import data through the management API."],
  ["筛选条件", "Filters"], ["时间范围", "Time range"], ["全部时间", "All time"], ["最近 7 天", "Last 7 days"], ["最近 30 天", "Last 30 days"],
  ["全部 Runtime", "All runtimes"], ["全部项目", "All projects"], ["全部工具", "All tools"], ["工具", "Tool"], ["清除", "Clear"],
  ["匹配 Session", "Matching sessions"], ["个支持深度分析", " support deep analytics"], ["总 Token", "Total tokens"], ["正在计算", "Calculating"],
  ["平均", "Average"],
  ["缓存命中", "Cache hit"], ["跨 Runtime 归一化", "normalized across runtimes"], ["种工具", " tools"],
  ["Token 趋势", "Token trend"], ["按 Session 最后活动日期归组", "Grouped by last session activity"],
  ["工具调用排行", "Top tool calls"], ["跨 Session 合并调用与错误", "Calls and errors merged across sessions"], ["无错误", "No errors"],
  ["按 Runtime", "By runtime"], ["比较各 Agent 来源的消耗", "Compare usage across agent sources"], ["按项目", "By project"],
  ["定位 Token 与 Tool Call 热点", "Find token and tool-call hotspots"], ["高消耗 Session", "Highest-usage sessions"], ["当前筛选范围内按 Token 降序", "Sorted by tokens in the current filter"],
  ["当前筛选没有趋势数据", "No trend data for this filter"], ["没有工具调用", "No tool calls"], ["没有匹配的聚合数据", "No matching aggregate data"],
  ["请调整聚合筛选条件。", "Adjust the analytics filters."], ["来源构成", "Source composition"], ["个已识别 Runtime", " recognized runtimes"],
  ["的 Session", " of sessions"], ["暂无运行时数据", "No runtime data"], ["Session header 中的 harness 会自动聚合到这里。", "Harness values in session headers are aggregated here automatically."],
  ["文件大小", "File size"], ["当前 .usl 文件", "Current .usl file"], ["有效数据", "Valid data"], ["文件占比", " of file"],
  ["冗余恢复提示", "Redundant recovery hint"], ["持久化帧", "Persisted frames"], ["文件布局", "File layout"],
  ["记录格式", "Record format"], ["写入模式", "Write mode"], ["数据末端", "Data end"], ["等待 API", "Waiting for data"],
  ["校验结果", "Verification result"], ["当前有效日志前缀", "Current valid log prefix"], ["原始报告", "Raw report"],
  ["数据帧健康", "Data frames healthy"], ["已校验", "Verified"], ["帧已扫描", " frames scanned"], ["通过", "Passed"], ["可读", "Readable"], ["干净", "Clean"],
  ["有效数据", " valid data"], ["条待处理截断", " pending truncations"], ["Session 详情", "Session details"], ["返回会话", "Back to sessions"],
  ["正在解析原生 Session…", "Parsing native session…"], ["未命名项目", "Untitled project"], ["缓存读取", "Cached input"],
  ["个错误", " errors"], ["推理记录", "Reasoning records"], ["结构化日志", "Structured log"], ["个可渲染节点", " renderable nodes"],
  ["全部", "All"], ["消息", "Messages"], ["推理", "Reasoning"], ["此筛选下没有记录", "No records for this filter"],
  ["Token 明细", "Token breakdown"], ["按 Runtime 原生 usage 聚合", "Aggregated from native runtime usage"], ["工具使用", "Tool usage"], ["调用次数与错误数", "Calls and errors"],
  ["搜索会话、项目或哈希…", "Search sessions, projects, or hashes…"], ["数据库在线", "Demo data ready"], ["连接中", "Loading demo"], ["API 离线", "Demo unavailable"],
  ["关闭导航", "Close navigation"], ["关闭菜单", "Close menu"], ["打开菜单", "Open menu"], ["主导航", "Main navigation"],
  ["暂无事件", "No events yet"], ["事件写入后会出现在这里。", "New events appear here as they are written."], ["正在读取…", "Loading…"], ["正在同步", "Syncing"],
];

function EnglishLocaleBridge() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("lang") !== "en") { document.documentElement.lang = "zh-CN"; return; }
    document.documentElement.lang = "en";
    const translate = (root: Node) => {
      const replacements = [...englishReplacements].sort((a, b) => b[0].length - a[0].length);
      const updateText = (node: Text) => {
        let value = node.data;
        replacements.forEach(([from, to]) => { value = value.split(from).join(to); });
        value = value.replace(/(\d+)\s*秒前/g, "$1 seconds ago").replace(/(\d+)\s*分钟前/g, "$1 minutes ago").replace(/(\d+)\s*小时前/g, "$1 hours ago");
        value = value.replace(/(\d[\d,.]*)\s*条/g, "$1").replace(/(\d[\d,.]*)\s*个/g, "$1");
        if (value !== node.data) node.data = value;
      };
      if (root.nodeType === Node.TEXT_NODE) updateText(root as Text);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      nodes.forEach(updateText);
      if (root instanceof Element) {
        [root, ...root.querySelectorAll("[placeholder],[aria-label]")].forEach((element) => {
          ["placeholder", "aria-label"].forEach((name) => {
            let value = element.getAttribute(name);
            if (!value) return;
            replacements.forEach(([from, to]) => { value = value!.split(from).join(to); });
            element.setAttribute(name, value);
          });
        });
      }
    };
    translate(document.querySelector(".app-shell") ?? document.body);
    const observer = new MutationObserver((records) => records.forEach((record) => {
      if (record.type === "characterData") translate(record.target);
      record.addedNodes.forEach(translate);
    }));
    observer.observe(document.querySelector(".app-shell") ?? document.body, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}

const views: Array<{ id: View; label: string; icon: typeof Database }> = [
  { id: "overview", label: "概览", icon: CircleGauge },
  { id: "sessions", label: "会话", icon: TerminalSquare },
  { id: "analytics", label: "全局分析", icon: BarChart3 },
  { id: "runtimes", label: "运行时", icon: Boxes },
  { id: "storage", label: "存储", icon: HardDrive },
  { id: "integrity", label: "完整性", icon: ShieldCheck },
];

const runtimeMeta: Record<string, { label: string; color: string }> = {
  codex: { label: "Codex", color: "#467061" },
  claude: { label: "Claude Code", color: "#aa6948" },
  pi: { label: "Pi", color: "#69779b" },
  opencode: { label: "OpenCode", color: "#7b6d93" },
  dimagent: { label: "Dimagent", color: "#a1844c" },
  unknown: { label: "Unknown", color: "#7b817d" },
};

function runtimeInfo(runtime: RuntimeKey) {
  return runtimeMeta[runtime] ?? { label: runtime, color: "#7b817d" };
}

function compactNumber(value: number) {
  const locale = typeof document !== "undefined" && document.documentElement.lang === "en" ? "en-US" : "zh-CN";
  return new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function shortId(value: string) {
  return value.length > 22 ? `${value.slice(0, 19)}…` : value;
}

function Logo() {
  return <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>;
}

function Sidebar({ open, onClose, data, active, onNavigate }: {
  open: boolean;
  onClose: () => void;
  data: DashboardData | null;
  active: View;
  onNavigate: (view: View) => void;
}) {
  return <>
    {open && <button className="sidebar-backdrop" onClick={onClose} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? "is-open" : ""}`}>
      <div className="brand-row">
        <Logo /><div className="brand-name">SESDB</div><span className="brand-tag">CONSOLE</span>
        <button className="mobile-close" onClick={onClose} aria-label="关闭菜单"><X size={18} /></button>
      </div>
      <div className="workspace-switcher">
        <span className="workspace-avatar">L</span><div><strong>Local database</strong><small>.sesdb/sesdb.usl</small></div>
      </div>
      <nav className="nav-list" aria-label="主导航">
        <p className="nav-label">数据库</p>
        {views.map(({ id, label, icon: Icon }) => <button
          key={id}
          className={active === id ? "active" : ""}
          aria-current={active === id ? "page" : undefined}
          onClick={() => { onNavigate(id); onClose(); }}
        >
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
          {id === "sessions" && <small>{data ? compactNumber(data.overview.sessionCount) : "—"}</small>}
          {id === "integrity" && Boolean(data?.integrity.quarantineCount) && <em>{data?.integrity.quarantineCount}</em>}
        </button>)}
      </nav>
      <div className="sidebar-footer">
        <div className="storage-usage"><div><span>数据库文件</span><strong>{data ? bytes(data.storage.fileBytes) : "—"}</strong></div><div className="storage-track"><span style={{ width: data?.storage.fileBytes ? "100%" : "0%" }} /></div></div>
        <div className="user-row"><span className="user-avatar">DB</span><div><strong>usl-core</strong><small>append log v0</small></div><Database size={16} /></div>
      </div>
    </aside>
  </>;
}

function PageHeading({ eyebrow, title, description, loading, onRefresh }: {
  eyebrow: string; title: string; description: string; loading: boolean; onRefresh: () => void;
}) {
  return <section className="page-heading">
    <div><p className="eyebrow"><span />{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
    <div className="heading-actions"><button className="pause-button" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />刷新数据</button></div>
  </section>;
}

function MetricCard({ label, value, note, icon: Icon, tone }: {
  label: string; value: string; note: string; icon: typeof Database; tone: string;
}) {
  return <article className="metric-card">
    <div className="metric-top"><span className="metric-icon" style={{ color: tone, background: `${tone}16` }}><Icon size={17} /></span><span className="metric-label">{label}</span></div>
    <strong className="metric-value">{value}</strong><div className="metric-foot"><small>{note}</small></div>
  </article>;
}

function ThroughputChart({ buckets }: { buckets: DashboardData["overview"]["throughput"] }) {
  const values = buckets.map((bucket) => bucket.events);
  const max = Math.max(1, ...values);
  return <div className="chart-wrap" aria-label="24 小时事件写入量图表">
    <div className="chart-y-labels"><span>{compactNumber(max)}</span><span>{compactNumber(Math.round(max * .66))}</span><span>{compactNumber(Math.round(max * .33))}</span><span>0</span></div>
    <div className="chart-grid">{[0, 1, 2, 3].map((line) => <i key={line} style={{ top: `${line * 33.333}%` }} />)}<div className="bars">{values.map((value, index) => <span key={buckets[index]?.startMs ?? index} className={value === 0 ? "bar-empty" : ""} style={{ height: `${Math.max(1.5, value / max * 100)}%` }}><b>{value} events</b></span>)}</div></div>
    <div className="chart-x-labels">{[0, 6, 12, 18, 23].map((index) => <span key={index}>{buckets[index] ? new Date(buckets[index].startMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</span>)}</div>
  </div>;
}

function RuntimeDistribution({ data }: { data: DashboardData }) {
  const total = data.overview.sessionCount;
  const runtimes = data.overview.runtimes.map((item) => ({ ...item, ...runtimeInfo(item.runtime), percent: total ? Math.round(item.sessions / total * 100) : 0 }));
  let cursor = 0;
  const stops = runtimes.map((item) => { const start = cursor; cursor += item.percent; return `${item.color} ${start}% ${cursor}%`; });
  return <div className={`runtime-content ${runtimes.length ? "" : "runtime-empty"}`}>
    <div className="donut" style={{ background: stops.length ? `conic-gradient(${stops.join(",")})` : "#e3e5e1" }}><div><strong>{compactNumber(total)}</strong><span>会话总数</span></div></div>
    {runtimes.length ? <div className="runtime-list">{runtimes.map((item) => <div key={item.runtime}><span className="runtime-dot" style={{ background: item.color }} /><span>{item.label}</span><strong>{compactNumber(item.sessions)}</strong><small>{item.percent}%</small></div>)}</div> : <div className="inline-empty"><strong>暂无会话</strong><span>导入 Session 后将显示来源分布</span></div>}
  </div>;
}

function SessionTable({ sessions, data, onSelect }: { sessions: SessionSummary[]; data: DashboardData; onSelect?: (id: string) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>SESSION</th><th>项目</th><th>事件数</th><th>最近事件</th><th>状态</th><th>更新时间</th></tr></thead><tbody>
    {sessions.map((session) => {
      const meta = runtimeInfo(session.runtime);
      const latest = data.events.find((event) => event.sessionId === session.id);
      const status = session.status === "ingesting" ? "写入中" : "已同步";
      return <tr key={session.id} className={onSelect ? "clickable-row" : ""} tabIndex={onSelect ? 0 : undefined} onClick={() => onSelect?.(session.id)} onKeyDown={(event) => { if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(session.id); } }}><td><span className="runtime-logo" style={{ color: meta.color, background: `${meta.color}15` }}><Hexagon size={14} /></span><div><strong title={session.nativeSessionId}>{shortId(session.nativeSessionId)}</strong><small>{meta.label}</small></div></td><td>{session.project ?? "—"}</td><td className="mono">{compactNumber(session.eventCount)}</td><td className="mono">{latest?.eventType ?? "—"}</td><td><span className={`status-tag status-${status}`}>{status}</span></td><td>{relativeTime(session.lastUpdatedAt)}</td></tr>;
    })}
  </tbody></table>{sessions.length === 0 && <div className="empty-state"><Database size={22} /><strong>没有匹配的 Session</strong><span>调整搜索条件或通过管理 API 导入数据。</span></div>}</div>;
}

function IntegritySummary({ data, expanded = false }: { data: DashboardData; expanded?: boolean }) {
  const statusTitle = data.integrity.status === "recovery-required" ? "需要恢复" : data.integrity.status === "recovered" ? "已从截断恢复" : "数据帧健康";
  return <div className={expanded ? "integrity-expanded" : ""}>
    <div className="integrity-score"><div className="score-ring"><strong>{data.integrity.integrityPercent.toFixed(2)}</strong><span>%</span></div><div><strong>{statusTitle}</strong><p>已校验 {compactNumber(data.integrity.checkedFrames)} 帧<br />数据末端 {bytes(data.integrity.dataEnd)}</p></div></div>
    <div className="integrity-list">
      <div><span className="check-dot ok"><ShieldCheck size={14} /></span><p><strong>Frame CRC32</strong><small>{compactNumber(data.integrity.checkedFrames)} 帧已扫描</small></p><em>{data.integrity.status === "recovery-required" ? "异常" : "通过"}</em></div>
      <div><span className="check-dot ok"><Database size={14} /></span><p><strong>Append log</strong><small>{bytes(data.storage.dataBytes)} 有效数据</small></p><em>可读</em></div>
      <div><span className={`check-dot ${data.integrity.quarantineCount ? "warn" : "ok"}`}><Activity size={14} /></span><p><strong>Quarantine</strong><small>{data.integrity.quarantineCount} 条待处理截断</small></p><em className={data.integrity.quarantineCount ? "warning" : ""}>{data.integrity.quarantineCount ? "待复核" : "干净"}</em></div>
    </div>
  </div>;
}

function OverviewView({ data, loading, onRefresh, onNavigate }: { data: DashboardData | null; loading: boolean; onRefresh: () => void; onNavigate: (view: View) => void }) {
  return <>
    <PageHeading eyebrow="LIVE DATABASE" title="运行概览" description="所有数字均从当前 SESDB append log 实时投影。" loading={loading} onRefresh={onRefresh} />
    <section className="metrics-grid">
      <MetricCard label="会话总数" value={data ? compactNumber(data.overview.sessionCount) : "—"} note="有效日志前缀中的唯一 Session" icon={TerminalSquare} tone="#466e61" />
      <MetricCard label="事件记录" value={data ? compactNumber(data.overview.eventCount) : "—"} note={data ? `最近 24 小时 ${compactNumber(data.overview.eventsLast24h)} 条` : "等待 API"} icon={Zap} tone="#9b6748" />
      <MetricCard label="数据库文件" value={data ? bytes(data.storage.fileBytes) : "—"} note={data ? `${compactNumber(data.storage.recordCount)} 个持久化帧` : "等待 API"} icon={Database} tone="#68779a" />
      <MetricCard label="帧完整性" value={data ? `${data.integrity.integrityPercent.toFixed(2)}%` : "—"} note={data ? `CRC 校验 ${compactNumber(data.integrity.checkedFrames)} 帧` : "等待 API"} icon={ShieldCheck} tone="#8a7450" />
    </section>
    <section className="primary-grid">
      <article className="panel"><div className="panel-header"><div><h2>写入吞吐</h2><p>持久化事件 · 最近 24 小时</p></div><div className="legend"><span><i />Events</span><strong>{data ? compactNumber(data.overview.eventsLast24h) : "—"} <small>事件</small></strong></div></div><ThroughputChart buckets={data?.overview.throughput ?? []} /></article>
      <article className="panel"><div className="panel-header"><div><h2>运行时分布</h2><p>来自 Session header 的 harness</p></div><button className="text-button" onClick={() => onNavigate("runtimes")}>查看详情 <ChevronRight size={14} /></button></div>{data ? <RuntimeDistribution data={data} /> : <div className="panel-loading">正在读取…</div>}</article>
    </section>
    <section className="secondary-grid">
      <article className="panel"><div className="panel-header ingest-header"><div><h2>最近会话与事件</h2><p><span className="pulse" />{data ? `${data.sessions.length} 个最近 Session` : "正在同步"}</p></div><button className="text-button" onClick={() => onNavigate("sessions")}>查看全部 <ChevronRight size={14} /></button></div>{data ? <SessionTable sessions={data.sessions.slice(0, 5)} data={data} /> : <div className="panel-loading">正在读取…</div>}</article>
      <article className="panel integrity-panel"><div className="panel-header"><div><h2>完整性</h2><p>只读扫描有效日志前缀</p></div><button className="text-button" onClick={() => onNavigate("integrity")}>检查报告 <ChevronRight size={14} /></button></div>{data ? <IntegritySummary data={data} /> : <div className="panel-loading">正在读取…</div>}</article>
    </section>
  </>;
}

function SessionsView({ data, sessions, runtime, setRuntime, loading, onRefresh, onSelect }: { data: DashboardData | null; sessions: SessionSummary[]; runtime: string; setRuntime: (runtime: string) => void; loading: boolean; onRefresh: () => void; onSelect: (id: string) => void }) {
  return <>
    <PageHeading eyebrow="SESSION EXPLORER" title="会话与事件" description="浏览真实 Session，并检查每个来源最近写入的原生事件。" loading={loading} onRefresh={onRefresh} />
    <section className="sessions-layout">
      <article className="panel"><div className="panel-header ingest-header"><div><h2>Session 列表</h2><p>{sessions.length} 条匹配结果 · 点击查看详情</p></div><label className="compact-select"><select value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="all">全部运行时</option>{data?.overview.runtimes.map((item) => <option key={item.runtime} value={item.runtime}>{runtimeInfo(item.runtime).label}</option>)}</select></label></div>{data ? <SessionTable sessions={sessions} data={data} onSelect={onSelect} /> : <div className="panel-loading">正在读取…</div>}</article>
      <article className="panel events-panel"><div className="panel-header"><div><h2>最近事件</h2><p>按全局 sequence 倒序</p></div><span className="sequence-badge">{data?.events.length ?? 0} EVENTS</span></div><div className="event-list">{data?.events.map((event) => { const meta = runtimeInfo(event.runtime); return <div className="event-row" key={event.seq}><span className="event-seq">#{event.seq}</span><span className="runtime-dot" style={{ background: meta.color }} /><div><strong>{event.eventType}</strong><small>{shortId(event.sessionId)} · {relativeTime(event.timestamp)}</small></div><code>{meta.label}</code></div>; })}{data?.events.length === 0 && <div className="empty-state"><FileJson size={22} /><strong>暂无事件</strong><span>事件写入后会出现在这里。</span></div>}</div></article>
    </section>
  </>;
}

function SessionDetailView({ detail, loading, error, onBack }: { detail: SessionDetail | null; loading: boolean; error: string | null; onBack: () => void }) {
  const [filter, setFilter] = useState("all");
  if (loading) return <><button className="back-button" onClick={onBack}><ArrowLeft size={15} />返回会话</button><div className="detail-loading"><RefreshCw size={20} className="spin" /><span>正在解析原生 Session…</span></div></>;
  if (error || !detail) return <><button className="back-button" onClick={onBack}><ArrowLeft size={15} />返回会话</button><div className="api-error"><AlertTriangle size={17} /><div><strong>Session 渲染失败</strong><span>{error ?? "没有可用详情"}</span></div></div></>;

  const { session, analytics } = detail;
  const meta = runtimeInfo(session.runtime);
  const timeline = detail.timeline.filter((item) => filter === "all" || filter === "tools" && item.category.startsWith("tool-") || item.category === filter);
  return <>
    <button className="back-button" onClick={onBack}><ArrowLeft size={15} />返回会话</button>
    <section className="session-detail-heading"><div className="runtime-logo large" style={{ color: meta.color, background: `${meta.color}15` }}><Hexagon size={20} /></div><div><p>{meta.label} · {session.project ?? "未命名项目"}</p><h1>{session.title ?? session.nativeSessionId}</h1><code>{session.id}</code></div><span className={`status-tag status-${session.status === "ingesting" ? "写入中" : "已同步"}`}>{session.status === "ingesting" ? "写入中" : "已同步"}</span></section>
    <section className="metrics-grid detail-metrics">
      <MetricCard label="总 Token" value={compactNumber(analytics.tokens.total)} note={`Input ${compactNumber(analytics.tokens.input)} · Output ${compactNumber(analytics.tokens.output)}`} icon={Zap} tone="#466e61" />
      <MetricCard label="缓存读取" value={compactNumber(analytics.tokens.cachedInput)} note={`Cache hit ${(analytics.tokens.cacheHitRate * 100).toFixed(1)}%`} icon={Database} tone="#9b6748" />
      <MetricCard label="Tool Calls" value={compactNumber(analytics.toolCallCount)} note={`${analytics.toolErrorCount} 个错误 · ${analytics.tools.length} 种工具`} icon={Wrench} tone="#68779a" />
      <MetricCard label="推理记录" value={compactNumber(analytics.reasoningCount)} note={`${compactNumber(analytics.tokens.reasoning)} reasoning tokens`} icon={Brain} tone="#8a7450" />
    </section>
    <section className="detail-layout">
      <article className="panel timeline-panel"><div className="panel-header timeline-header"><div><h2>结构化日志</h2><p>{timeline.length} / {detail.timeline.length} 个可渲染节点</p></div><div className="timeline-filters">{[["all", "全部"], ["message", "消息"], ["tools", "工具"], ["reasoning", "推理"], ["event", "事件"]].map(([id, label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div><div className="timeline-list">{timeline.map((item) => <article className={`timeline-item ${item.category} ${item.isError ? "is-error" : ""}`} key={item.id}><div className="timeline-rail"><span>{item.category === "message" ? <Bot size={14} /> : item.category === "reasoning" ? <Brain size={14} /> : item.category.startsWith("tool-") ? <Wrench size={14} /> : <Activity size={14} />}</span><i /></div><div className="timeline-body"><header><div><strong>{item.title}</strong><span>{item.category}</span>{item.isError && <em>ERROR</em>}</div><time>#{item.seq} · {new Date(item.timestamp).toLocaleString("zh-CN")}</time></header>{item.callId && <code className="call-id">call · {item.callId}</code>}{item.content && <pre>{item.content}</pre>}</div></article>)}{timeline.length === 0 && <div className="empty-state"><FileJson size={22} /><strong>此筛选下没有记录</strong></div>}</div></article>
      <aside className="detail-aside"><article className="panel token-panel"><div className="panel-header"><div><h2>Token 明细</h2><p>按 Runtime 原生 usage 聚合</p></div></div><dl><div><dt>Input</dt><dd>{compactNumber(analytics.tokens.input)}</dd></div><div><dt>Cached input</dt><dd>{compactNumber(analytics.tokens.cachedInput)}</dd></div><div><dt>Cache write</dt><dd>{compactNumber(analytics.tokens.cacheWrite)}</dd></div><div><dt>Output</dt><dd>{compactNumber(analytics.tokens.output)}</dd></div><div><dt>Reasoning</dt><dd>{compactNumber(analytics.tokens.reasoning)}</dd></div><div className="total"><dt>Total</dt><dd>{compactNumber(analytics.tokens.total)}</dd></div>{analytics.tokens.contextWindow && <div><dt>Context window</dt><dd>{compactNumber(analytics.tokens.contextWindow)}</dd></div>}</dl></article><article className="panel tools-panel"><div className="panel-header"><div><h2>工具使用</h2><p>调用次数与错误数</p></div></div><div>{analytics.tools.map((tool) => <div className="tool-stat" key={tool.name}><span><Wrench size={13} /></span><strong>{tool.name}</strong><em>{tool.calls}</em>{tool.errors > 0 && <small>{tool.errors} errors</small>}</div>)}{analytics.tools.length === 0 && <div className="empty-state"><Wrench size={20} /><strong>没有 Tool Call</strong></div>}</div></article></aside>
    </section>
  </>;
}

function AnalyticsBreakdown({ title, note, groups }: { title: string; note: string; groups: AnalyticsGroup[] }) {
  const max = Math.max(1, ...groups.map((group) => group.tokens));
  return <article className="panel analytics-breakdown"><div className="panel-header"><div><h2>{title}</h2><p>{note}</p></div><span className="sequence-badge">{groups.length} GROUPS</span></div><div className="aggregate-list">{[...groups].sort((a, b) => b.tokens - a.tokens).map((group) => <div className="aggregate-row" key={group.key}><div className="aggregate-name"><strong>{group.key}</strong><small>{group.sessions} sessions · {compactNumber(group.events)} events</small></div><div className="aggregate-bar"><span style={{ width: `${Math.max(2, group.tokens / max * 100)}%` }} /></div><strong>{compactNumber(group.tokens)}</strong><small>{compactNumber(group.toolCalls)} calls{group.toolErrors ? ` · ${group.toolErrors} errors` : ""}</small></div>)}{groups.length === 0 && <div className="empty-state"><BarChart3 size={22} /><strong>没有匹配的聚合数据</strong></div>}</div></article>;
}

function AnalyticsView({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [analytics, setAnalytics] = useState<GlobalAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("all");
  const [runtime, setRuntime] = useState("");
  const [project, setProject] = useState("");
  const [tool, setTool] = useState("");

  const loadAnalytics = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const days = range === "all" ? 0 : Number(range);
    try {
      setAnalytics(await fetchGlobalAnalytics({
        runtime,
        project,
        tool,
        from: days ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined,
        to: days ? Date.now() : undefined,
      }, signal));
      setError(null);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [project, range, runtime, tool]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAnalytics(controller.signal);
    return () => controller.abort();
  }, [loadAnalytics]);

  const maxTrend = Math.max(1, ...(analytics?.trend.map((bucket) => bucket.tokens) ?? []));
  const reset = () => { setRange("all"); setRuntime(""); setProject(""); setTool(""); };
  return <>
    <PageHeading eyebrow="GLOBAL ANALYTICS" title="全局分析" description="在统一 Session 指标层上，按时间、Runtime、项目与工具交叉筛选聚合。" loading={loading} onRefresh={() => void loadAnalytics()} />
    <section className="analytics-filter-bar panel">
      <span><Filter size={14} />筛选条件</span>
      <label><small>时间范围</small><select value={range} onChange={(event) => setRange(event.target.value)}><option value="all">全部时间</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select></label>
      <label><small>Runtime</small><select value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="">全部 Runtime</option>{analytics?.availableRuntimes.map((value) => <option key={value} value={value}>{runtimeInfo(value).label}</option>)}</select></label>
      <label><small>项目</small><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">全部项目</option>{analytics?.availableProjects.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><small>工具</small><select value={tool} onChange={(event) => setTool(event.target.value)}><option value="">全部工具</option>{analytics?.tools.map((value) => <option key={value.name} value={value.name}>{value.name}</option>)}</select></label>
      <button onClick={reset} disabled={!range || range === "all" && !runtime && !project && !tool}>清除</button>
    </section>
    {error && <div className="api-error"><AlertTriangle size={17} /><div><strong>无法计算全局分析</strong><span>{error}</span></div><button onClick={() => void loadAnalytics()}>重试</button></div>}
    <section className="metrics-grid detail-metrics">
      <MetricCard label="匹配 Session" value={analytics ? compactNumber(analytics.sessions) : "—"} note={analytics ? `${analytics.analyzableSessions} 个支持深度分析` : "正在计算"} icon={TerminalSquare} tone="#466e61" />
      <MetricCard label="总 Token" value={analytics ? compactNumber(analytics.tokens.total) : "—"} note={analytics ? `平均 ${compactNumber(analytics.sessions ? analytics.tokens.total / analytics.sessions : 0)} / session` : "正在计算"} icon={Zap} tone="#9b6748" />
      <MetricCard label="缓存命中" value={analytics ? `${(analytics.tokens.cacheHitRate * 100).toFixed(1)}%` : "—"} note={analytics ? `${compactNumber(analytics.tokens.cachedInput)} cached input · 跨 Runtime 归一化` : "正在计算"} icon={Database} tone="#68779a" />
      <MetricCard label="Tool Calls" value={analytics ? compactNumber(analytics.toolCalls) : "—"} note={analytics ? `${analytics.toolErrors} errors · ${analytics.tools.length} 种工具` : "正在计算"} icon={Wrench} tone="#8a7450" />
    </section>
    <section className="analytics-grid">
      <article className="panel analytics-trend"><div className="panel-header"><div><h2>Token 趋势</h2><p>按 Session 最后活动日期归组</p></div><strong>{analytics ? compactNumber(analytics.tokens.total) : "—"}</strong></div><div className="trend-bars">{analytics?.trend.map((bucket) => <div key={bucket.startMs}><span><i style={{ height: `${Math.max(3, bucket.tokens / maxTrend * 100)}%` }}><b>{compactNumber(bucket.tokens)} tokens</b></i></span><small>{new Date(bucket.startMs).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small></div>)}{analytics?.trend.length === 0 && <div className="empty-state"><BarChart3 size={22} /><strong>当前筛选没有趋势数据</strong></div>}</div></article>
      <article className="panel analytics-tools"><div className="panel-header"><div><h2>工具调用排行</h2><p>跨 Session 合并调用与错误</p></div><span className="sequence-badge">TOP TOOLS</span></div><div>{analytics?.tools.slice(0, 8).map((item, index) => <div className="rank-row" key={item.name}><em>{String(index + 1).padStart(2, "0")}</em><span><strong>{item.name}</strong><small>{item.errors ? `${item.errors} errors` : "无错误"}</small></span><b>{compactNumber(item.calls)}</b></div>)}{analytics?.tools.length === 0 && <div className="empty-state"><Wrench size={22} /><strong>没有工具调用</strong></div>}</div></article>
    </section>
    <section className="analytics-breakdown-grid">
      <AnalyticsBreakdown title="按 Runtime" note="比较各 Agent 来源的消耗" groups={[...(analytics?.byRuntime ?? [])]} />
      <AnalyticsBreakdown title="按项目" note="定位 Token 与 Tool Call 热点" groups={[...(analytics?.byProject ?? [])]} />
    </section>
    <article className="panel analytics-sessions"><div className="panel-header"><div><h2>高消耗 Session</h2><p>当前筛选范围内按 Token 降序</p></div><span className="sequence-badge">TOP 20</span></div><div className="table-wrap"><table><thead><tr><th>SESSION</th><th>项目</th><th>Token</th><th>Cache hit</th><th>Tool Calls</th><th>更新时间</th></tr></thead><tbody>{analytics?.topSessions.map((session) => { const meta = runtimeInfo(session.runtime); return <tr className="clickable-row" key={session.id} tabIndex={0} onClick={() => onSelectSession(session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectSession(session.id); }}><td><span className="runtime-logo" style={{ color: meta.color, background: `${meta.color}15` }}><Hexagon size={14} /></span><div><strong>{shortId(session.nativeSessionId)}</strong><small>{meta.label}</small></div></td><td>{session.project || "—"}</td><td className="mono">{compactNumber(session.tokens)}</td><td className="mono">{(session.cacheHitRate * 100).toFixed(1)}%</td><td className="mono">{session.toolCalls}{session.toolErrors ? ` / ${session.toolErrors} err` : ""}</td><td>{relativeTime(session.lastUpdatedAt)}</td></tr>; })}</tbody></table>{analytics?.topSessions.length === 0 && <div className="empty-state"><Database size={22} /><strong>没有匹配的 Session</strong><span>请调整聚合筛选条件。</span></div>}</div></article>
  </>;
}

function RuntimesView({ data, loading, onRefresh, onSelect }: { data: DashboardData | null; loading: boolean; onRefresh: () => void; onSelect: (runtime: string) => void }) {
  return <>
    <PageHeading eyebrow="SOURCE RUNTIMES" title="运行时" description="查看各 Agent Runtime 的 Session 覆盖和接入规模。" loading={loading} onRefresh={onRefresh} />
    <section className="runtime-card-grid">{data?.overview.runtimes.map((item) => { const meta = runtimeInfo(item.runtime); const percent = data.overview.sessionCount ? Math.round(item.sessions / data.overview.sessionCount * 100) : 0; return <button className="runtime-card" key={item.runtime} onClick={() => onSelect(item.runtime)}><span className="runtime-card-icon" style={{ color: meta.color, background: `${meta.color}15` }}><Hexagon size={20} /></span><div><strong>{meta.label}</strong><small>{percent}% 的 Session</small></div><em>{compactNumber(item.sessions)}</em><ChevronRight size={16} /></button>; })}{data?.overview.runtimes.length === 0 && <article className="panel empty-state"><Boxes size={24} /><strong>暂无运行时数据</strong><span>Session header 中的 harness 会自动聚合到这里。</span></article>}</section>
    {data && <article className="panel runtime-detail-panel"><div className="panel-header"><div><h2>来源构成</h2><p>{data.overview.runtimes.length} 个已识别 Runtime</p></div></div><RuntimeDistribution data={data} /></article>}
  </>;
}

function StorageView({ data, loading, onRefresh }: { data: DashboardData | null; loading: boolean; onRefresh: () => void }) {
  const payloadPercent = data?.storage.fileBytes ? data.storage.dataBytes / data.storage.fileBytes * 100 : 0;
  return <>
    <PageHeading eyebrow="PHYSICAL STORAGE" title="存储" description="查看数据库物理布局、有效数据区域和持久化帧。" loading={loading} onRefresh={onRefresh} />
    <section className="metrics-grid storage-metrics"><MetricCard label="文件大小" value={data ? bytes(data.storage.fileBytes) : "—"} note="当前 .usl 文件" icon={HardDrive} tone="#466e61" /><MetricCard label="有效数据" value={data ? bytes(data.storage.dataBytes) : "—"} note={data ? `${payloadPercent.toFixed(1)}% 文件占比` : "等待 API"} icon={Layers3} tone="#9b6748" /><MetricCard label="Header" value={data ? bytes(data.storage.headerBytes) : "—"} note="冗余恢复提示" icon={FileJson} tone="#68779a" /><MetricCard label="持久化帧" value={data ? compactNumber(data.storage.recordCount) : "—"} note={data ? `${compactNumber(data.storage.sessionCount)} 个 Session` : "等待 API"} icon={Database} tone="#8a7450" /></section>
    <article className="panel storage-layout-panel"><div className="panel-header"><div><h2>文件布局</h2><p>Header + CRC framed records</p></div><code>{data ? bytes(data.storage.fileBytes) : "—"}</code></div><div className="storage-layout"><div className="storage-segment header-segment" style={{ width: `${Math.max(3, 100 - payloadPercent)}%` }}><strong>HEADER</strong><span>{data ? bytes(data.storage.headerBytes) : "—"}</span></div><div className="storage-segment data-segment" style={{ width: `${Math.max(0, payloadPercent)}%` }}><strong>DATA REGION</strong><span>{data ? bytes(data.storage.dataBytes) : "—"}</span></div></div><div className="storage-facts"><div><span>记录格式</span><strong>[len][crc32][payload]</strong></div><div><span>写入模式</span><strong>Append-only</strong></div><div><span>数据末端</span><strong>{data ? bytes(data.integrity.dataEnd) : "—"}</strong></div><div><span>Next sequence</span><strong>{data ? compactNumber(data.integrity.nextSeq) : "—"}</strong></div></div></article>
  </>;
}

function IntegrityView({ data, loading, onRefresh }: { data: DashboardData | null; loading: boolean; onRefresh: () => void }) {
  return <>
    <PageHeading eyebrow="INTEGRITY REPORT" title="完整性" description="从磁盘重新扫描帧边界、CRC 与恢复位置。" loading={loading} onRefresh={onRefresh} />
    <section className="integrity-view-grid"><article className="panel integrity-panel"><div className="panel-header"><div><h2>校验结果</h2><p>当前有效日志前缀</p></div>{data && <span className={`health-pill ${data.integrity.status}`}><CheckCircle2 size={13} />{data.integrity.status}</span>}</div>{data ? <IntegritySummary data={data} expanded /> : <div className="panel-loading">正在读取…</div>}</article><article className="panel report-panel"><div className="panel-header"><div><h2>原始报告</h2><p>Store::verify 返回值</p></div></div><dl><div><dt>checkedFrames</dt><dd>{data ? compactNumber(data.integrity.checkedFrames) : "—"}</dd></div><div><dt>sessionCount</dt><dd>{data ? compactNumber(data.integrity.sessionCount) : "—"}</dd></div><div><dt>nextSeq</dt><dd>{data ? compactNumber(data.integrity.nextSeq) : "—"}</dd></div><div><dt>dataEnd</dt><dd>{data ? data.integrity.dataEnd : "—"}</dd></div><div><dt>truncationOffset</dt><dd className={data?.integrity.truncationOffset ? "danger" : ""}>{data?.integrity.truncationOffset ?? "null"}</dd></div><div><dt>checkedAt</dt><dd>{data ? new Date(data.integrity.checkedAt).toLocaleString("zh-CN") : "—"}</dd></div></dl>{Boolean(data?.integrity.quarantineCount) && <div className="recovery-notice"><AlertTriangle size={16} /><span>启动时检测并截断了不完整帧，请复核对应来源。</span></div>}</article></section>
  </>;
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [locale, setLocale] = useState<"en" | "zh">("zh");
  const [runtime, setRuntime] = useState("all");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchDashboard()); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view") as View | null;
    if (requestedView && validViews.includes(requestedView)) setView(requestedView);
    setLocale(params.get("lang") === "en" ? "en" : "zh");
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filteredSessions = useMemo(() => (data?.sessions ?? []).filter((session) => {
    const runtimeMatch = runtime === "all" || session.runtime === runtime;
    const needle = search.trim().toLowerCase();
    return runtimeMatch && (!needle || [session.id, session.nativeSessionId, session.project, session.title, session.runtime].some((value) => value?.toLowerCase().includes(needle)));
  }), [data, runtime, search]);

  const navigate = (next: View) => {
    setSelectedSession(null); setDetail(null); setView(next);
    const url = new URL(window.location.href); url.searchParams.set("view", next); window.history.replaceState({}, "", url);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const selectRuntime = (selected: string) => { setRuntime(selected); navigate("sessions"); };
  const selectSession = async (id: string) => {
    setSelectedSession(id); setDetail(null); setDetailError(null); setDetailLoading(true); window.scrollTo({ top: 0, behavior: "smooth" });
    try { setDetail(await fetchSessionDetail(id)); }
    catch (reason) { setDetailError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setDetailLoading(false); }
  };
  const selectAnalyticsSession = (id: string) => { setView("sessions"); void selectSession(id); };
  const title = selectedSession ? "Session 详情" : views.find((item) => item.id === view)?.label ?? "概览";

  const switchUrl = `?lang=${locale === "en" ? "zh" : "en"}&view=${view}`;

  return <div className="app-shell">
    <EnglishLocaleBridge />
    <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} data={data} active={view} onNavigate={navigate} />
    <main className="main-content">
      <header className="topbar">
        <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={20} /></button>
        <div className="breadcrumb"><span>SESDB</span><ChevronRight size={14} /><strong>{title}</strong></div>
        <label className="command-search"><Search size={16} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话、项目或哈希…" /><kbd><Command size={12} /> K</kbd></label>
        <div className="top-actions"><span className="demo-pill">{locale === "en" ? "INTERACTIVE DEMO" : "交互式演示"}</span><a className="locale-button" href={switchUrl}><Languages size={14} />{locale === "en" ? "中文" : "EN"}</a><a className="site-button" href="../"><ArrowUpRight size={14} /><span>{locale === "en" ? "Product site" : "产品主页"}</span></a><div className={`system-health ${error ? "is-error" : ""}`}><span /><strong>{error ? "API 离线" : loading && !data ? "连接中" : "数据库在线"}</strong></div></div>
      </header>
      <div className="page">
        {error && <div className="api-error"><Activity size={17} /><div><strong>无法读取 SESDB</strong><span>{error}</span></div><button onClick={() => void load()}>重试</button></div>}
        {view === "overview" && <OverviewView data={data} loading={loading} onRefresh={() => void load()} onNavigate={navigate} />}
        {view === "sessions" && selectedSession && <SessionDetailView detail={detail} loading={detailLoading} error={detailError} onBack={() => { setSelectedSession(null); setDetail(null); }} />}
        {view === "sessions" && !selectedSession && <SessionsView data={data} sessions={filteredSessions} runtime={runtime} setRuntime={setRuntime} loading={loading} onRefresh={() => void load()} onSelect={(id) => void selectSession(id)} />}
        {view === "analytics" && <AnalyticsView onSelectSession={selectAnalyticsSession} />}
        {view === "runtimes" && <RuntimesView data={data} loading={loading} onRefresh={() => void load()} onSelect={selectRuntime} />}
        {view === "storage" && <StorageView data={data} loading={loading} onRefresh={() => void load()} />}
        {view === "integrity" && <IntegrityView data={data} loading={loading} onRefresh={() => void load()} />}
      </div>
    </main>
  </div>;
}
