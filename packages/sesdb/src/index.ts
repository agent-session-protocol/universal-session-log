import { createHash } from "node:crypto";
import type { EngineClient, ScanResult, StoredRecord } from "./engine.js";
import { DaemonEngine, NdjsonEngine, type DaemonOptions } from "./engine.js";
import {
  parseSessionQL,
  type Expression,
  type QueryPlan,
  type Stage,
  type ValueNode,
} from "./query.js";

export * from "./engine.js";
export * from "./query.js";

export interface EvidencePointer {
  sessionId: string;
  eventId: string;
  sourcePath: string;
  sourceDigest: string;
  byteStart: number;
  byteEnd: number;
  parserVersion: string;
}

export interface SearchHit {
  sessionId: string;
  eventId: string;
  text: string;
  score: number;
  evidence: EvidencePointer[];
}

export interface QueryRequest {
  sessionql: string;
  parameters?: Record<string, unknown>;
  includeExplain?: boolean;
}

export interface QueryResult<Row = Record<string, unknown>> {
  apiVersion: "query.usl.dev/v1";
  queryHash: string;
  asOfSeq: number;
  watermarks: Array<{ source: "l1" | "sidecar"; generation?: number; builtThroughSeq: number; asOfSeq: number }>;
  rows: Row[];
  warnings: Array<{ code: string; message: string }>;
  explain?: {
    normalizedPlan: QueryPlan;
    asOfDecision: { freshness: { kind: "indexed" }; committedSeqAtStart: number; selectedAsOfSeq: number };
    stages: Array<{ ordinal: number; op: Stage["op"]; inputType: string; outputType: string; indexes: string[]; inputRows: number; outputRows: number }>;
    warnings: Array<{ code: string; message: string }>;
  };
}

export interface Sesdb {
  search(text: string): Promise<SearchHit[]>;
  query(request: string | QueryRequest): Promise<QueryResult>;
  recent(limit?: number): Promise<StoredRecord[]>;
  raw(sessionId: string, fromSeq?: number): Promise<StoredRecord[]>;
  capabilities(): Promise<unknown>;
}

export interface SessionPage { items: Array<Record<string, unknown>>; generation: number; builtThroughSeq: number; nextCursor?: string; }
export interface SearchPage { items: Array<Record<string, unknown>>; generation: number; builtThroughSeq: number; nextCursor?: string; }
export interface LocalQueryFilters { provider?: "claude" | "codex" | "pi" | "kimi" | "deepseek"; project?: string; sessionId?: string; fromMs?: number; toMs?: number; }
export interface LocalPageOptions extends LocalQueryFilters { limit?: number; cursor?: string; history?: boolean; }
export interface ConnectedSesdb extends Sesdb {
  readonly engine: EngineClient;
  searchPage(text: string, options?: LocalPageOptions): Promise<SearchPage>;
  sessions(options?: number | LocalPageOptions): Promise<SessionPage>;
  timeline(sessionId: string, options?: Omit<LocalPageOptions, "provider" | "project" | "sessionId">): Promise<SearchPage>;
  providerHealth(): Promise<unknown>;
  reconcile(provider?: "claude" | "codex" | "pi" | "kimi" | "deepseek"): Promise<unknown>;
  rebuildIndex(): Promise<unknown>;
}

interface CanonicalEvent {
  schemaVersion: "1.0";
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: string;
  correlation?: Record<string, string>;
  payload: unknown;
  [key: string]: unknown;
}

interface IndexedEvent {
  record: StoredRecord;
  event: CanonicalEvent;
  evidence?: EvidencePointer;
  searchText?: string;
}

export class SesdbQueryError extends Error {
  readonly code: string;
  readonly retryable = false;
  readonly details = undefined;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SesdbQueryError";
    this.code = code;
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completeEvidence(value: unknown, event: CanonicalEvent): EvidencePointer | undefined {
  if (!isObject(value)) return undefined;
  const pointer = value as Partial<EvidencePointer>;
  if (
    pointer.sessionId !== event.sessionId ||
    pointer.eventId !== event.eventId ||
    typeof pointer.sourcePath !== "string" || !pointer.sourcePath ||
    typeof pointer.sourceDigest !== "string" || !pointer.sourceDigest.match(/^[0-9a-f]{64}$/) ||
    !Number.isSafeInteger(pointer.byteStart) || pointer.byteStart! < 0 ||
    !Number.isSafeInteger(pointer.byteEnd) || pointer.byteEnd! < pointer.byteStart! ||
    typeof pointer.parserVersion !== "string" || !pointer.parserVersion
  ) return undefined;
  return pointer as EvidencePointer;
}

function safeSearchText(event: CanonicalEvent): string {
  if (!isObject(event.payload)) return "";
  const payload = event.payload;
  const values: string[] = [event.type];
  const message = isObject(payload.message) ? payload.message : undefined;
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") values.push(block.text);
    }
  }
  const tool = isObject(payload.tool) ? payload.tool : undefined;
  for (const key of ["name", "status", "summary"] as const) {
    if (tool && typeof tool[key] === "string") values.push(tool[key] as string);
  }
  const artifact = isObject(payload.artifact) ? payload.artifact : payload;
  if (isObject(artifact) && typeof artifact.uri === "string") values.push(artifact.uri);
  return values.join("\n");
}

function decodeRecord(record: StoredRecord): IndexedEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(record.body)));
  } catch {
    return undefined;
  }
  const wrapper = isObject(value) && isObject(value.event) ? value : undefined;
  const eventValue = wrapper?.event ?? value;
  if (!isObject(eventValue)) return undefined;
  if (
    eventValue.schemaVersion !== "1.0" ||
    typeof eventValue.eventId !== "string" ||
    typeof eventValue.sessionId !== "string" ||
    typeof eventValue.type !== "string" ||
    typeof eventValue.timestamp !== "string" ||
    !Object.hasOwn(eventValue, "payload")
  ) return undefined;
  const event = eventValue as CanonicalEvent;
  if (event.sessionId !== record.sessionId) return undefined;
  const evidence = completeEvidence(wrapper?.evidence, event);
  return { record, event, ...(evidence ? { evidence, searchText: safeSearchText(event) } : {}) };
}

function field(row: IndexedEvent, path: string): unknown {
  if (path === "globalSeq" || path === "seq") return row.record.seq;
  if (path === "sessionId") return row.event.sessionId;
  if (path === "eventId") return row.event.eventId;
  const normalized = path.startsWith("event.") ? path.slice(6) : path;
  let value: unknown = row.event;
  for (const segment of normalized.split(".")) {
    if (!isObject(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function boundValue(node: ValueNode, row: IndexedEvent, parameters: Record<string, unknown>): unknown {
  if (node.kind === "field") return field(row, node.path);
  if (node.kind === "parameter") {
    if (!Object.hasOwn(parameters, node.name)) throw new SesdbQueryError("invalid_parameter", `missing parameter: $${node.name}`);
    return parameters[node.name];
  }
  return node.value;
}

function evaluate(expression: Expression, row: IndexedEvent, parameters: Record<string, unknown>): boolean {
  if (expression.kind === "and" || expression.kind === "or") {
    return expression.kind === "and"
      ? expression.items.every(item => evaluate(item, row, parameters))
      : expression.items.some(item => evaluate(item, row, parameters));
  }
  if (expression.kind === "not") return !evaluate(expression.item, row, parameters);
  if (expression.kind === "null") return (boundValue(expression.value, row, parameters) == null) !== Boolean(expression.negated);
  if (expression.kind === "in") {
    const right = boundValue(expression.right, row, parameters);
    if (!Array.isArray(right)) throw new SesdbQueryError("type_error", "right side of in must be an array");
    return right.includes(boundValue(expression.left, row, parameters)) !== Boolean(expression.negated);
  }
  const left = boundValue(expression.left, row, parameters) as string | number | boolean | null;
  const right = boundValue(expression.right, row, parameters) as string | number | boolean | null;
  if (expression.operator === "=") return left === right;
  if (expression.operator === "!=") return left !== right;
  if (typeof left !== typeof right || left === null || right === null) {
    throw new SesdbQueryError(
      "type_error",
      "ordered comparison requires matching non-null scalar types",
    );
  }
  const comparison = typeof left === "number"
    ? left - (right as number)
    : typeof left === "boolean"
      ? Number(left) - Number(right)
      : String(left).localeCompare(String(right));
  if (expression.operator === "<") return comparison < 0;
  if (expression.operator === "<=") return comparison <= 0;
  if (expression.operator === ">") return comparison > 0;
  return comparison >= 0;
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left !== typeof right) return typeof left < typeof right ? -1 : 1;
  return String(left).localeCompare(String(right));
}

async function scanSnapshot(engine: EngineClient, asOfSeq: number): Promise<IndexedEvent[]> {
  const output: IndexedEvent[] = [];
  let fromSeq = 0;
  let scannedRecords = 0;
  do {
    const page = await engine.request<ScanResult>("scan", { fromSeq, limit: 10_000 });
    for (const record of page.records) {
      if (record.seq >= asOfSeq) return output;
      if (++scannedRecords > 100_000) throw new SesdbQueryError("resource_limit", "query snapshot exceeds 100000 records");
      const decoded = decodeRecord(record);
      if (decoded) output.push(decoded);
    }
    if (!page.hasMore || page.nextFromSeq <= fromSeq) break;
    fromSeq = page.nextFromSeq;
  } while (fromSeq < asOfSeq);
  return output;
}

async function scanRawRecords(
  engine: EngineClient,
  parameters: { sessionId?: string; fromSeq: number },
): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  let fromSeq = parameters.fromSeq;
  do {
    const page = await engine.request<ScanResult>("scan", { ...parameters, fromSeq, limit: 10_000 });
    records.push(...page.records);
    if (!page.hasMore || page.nextFromSeq <= fromSeq) break;
    fromSeq = page.nextFromSeq;
    if (records.length >= 100_000) throw new SesdbQueryError("resource_limit", "raw result exceeds 100000 records");
  } while (true);
  return records;
}

export function createSesdb(engine: EngineClient): Sesdb {
  return {
    async search(text) {
      if (!text) return [];
      const result = await this.query({
        sessionql: "from events | search text $query | limit 100",
        parameters: { query: text },
      });
      return result.rows.map(row => ({
        sessionId: String(row.sessionId),
        eventId: String(row.eventId),
        text: String(row.searchText),
        score: 1,
        evidence: [row.evidence as unknown as EvidencePointer],
      }));
    },

    async query(request) {
      const input = typeof request === "string" ? { sessionql: request } : request;
      const parameters = input.parameters ?? {};
      const plan = parseSessionQL(input.sessionql);
      for (const parameter of plan.parameters) {
        if (!Object.hasOwn(parameters, parameter.name)) throw new SesdbQueryError("invalid_parameter", `missing parameter: $${parameter.name}`);
        if (typeof parameters[parameter.name] !== parameter.type) throw new SesdbQueryError("type_error", `$${parameter.name} must be a ${parameter.type}`);
      }
      if (plan.source !== "events") throw new SesdbQueryError("unsupported_capability", "foundation query execution currently supports only `from events`");
      const unsupportedSearch = plan.stages.find(
        (stage): stage is Extract<Stage, { op: "search" }> => stage.op === "search" && stage.kind !== "text",
      );
      if (unsupportedSearch) throw new SesdbQueryError("unsupported_capability", `${unsupportedSearch.kind} search is not available in the foundation engine`);

      const stats = await engine.request<{ nextSeq: number; generation?: number; builtThroughSeq?: number }>("stats");
      const asOfSeq = stats.nextSeq;
      let rows = await scanSnapshot(engine, asOfSeq);
      rows.sort((left, right) => left.event.eventId.localeCompare(right.event.eventId));
      const explainStages: NonNullable<QueryResult["explain"]>["stages"] = [];
      for (const [ordinal, stage] of plan.stages.entries()) {
        const inputRows = rows.length;
        if (stage.op === "where") rows = rows.filter(row => evaluate(stage.expression, row, parameters));
        else if (stage.op === "search") {
          const query = boundValue(stage.query, rows[0] ?? ({ event: {}, record: {} } as IndexedEvent), parameters);
          if (typeof query !== "string") throw new SesdbQueryError("type_error", "text search query must be a string");
          const needle = query.toLocaleLowerCase();
          rows = rows.filter(row => row.evidence && row.searchText?.toLocaleLowerCase().includes(needle));
        } else if (stage.op === "sort") {
          rows = [...rows].sort((left, right) => {
            for (const key of stage.keys) {
              const result = compare(field(left, key.field), field(right, key.field));
              if (result) return key.direction === "asc" ? result : -result;
            }
            return left.event.eventId.localeCompare(right.event.eventId);
          });
        } else if (stage.op === "limit") rows = rows.slice(0, stage.count);
        explainStages.push({
          ordinal,
          op: stage.op,
          inputType: "events",
          outputType: stage.op === "project" ? "projection" : "events",
          indexes: [],
          inputRows,
          outputRows: rows.length,
        });
      }
      const projection = [...plan.stages].reverse().find(
        (stage): stage is Extract<Stage, { op: "project" }> => stage.op === "project",
      );
      const warnings: QueryResult["warnings"] = [];
      if (!plan.stages.some(stage => stage.op === "limit") && rows.length > 1_000) {
        rows = rows.slice(0, 1_000);
        warnings.push({ code: "implicit_limit", message: "foundation queries return at most 1000 rows unless an explicit lower limit is provided" });
      }
      const resultRows = rows.map(row => {
        if (projection?.op === "project") return Object.fromEntries(projection.fields.map(item => [item.as ?? item.path, field(row, item.path)]));
        return {
          ...row.event,
          globalSeq: row.record.seq,
          ...(row.evidence ? { evidence: row.evidence, searchText: row.searchText } : {}),
        };
      });
      const queryHash = createHash("sha256").update(stable({ plan, parameters, asp: plan.asp })).digest("hex");
      return {
        apiVersion: "query.usl.dev/v1",
        queryHash,
        asOfSeq,
        watermarks: [
          { source: "l1", builtThroughSeq: asOfSeq, asOfSeq },
          ...(stats.generation === undefined ? [] : [{ source: "sidecar" as const, generation: stats.generation, builtThroughSeq: stats.builtThroughSeq ?? 0, asOfSeq }]),
        ],
        rows: resultRows,
        warnings,
        ...(input.includeExplain ? {
          explain: {
            normalizedPlan: plan,
            asOfDecision: { freshness: { kind: "indexed" }, committedSeqAtStart: asOfSeq, selectedAsOfSeq: asOfSeq },
            stages: explainStages,
            warnings,
          },
        } : {}),
      };
    },

    async recent(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new SesdbQueryError("invalid_parameter", "recent limit must be between 1 and 1000");
      const stats = await engine.request<{ nextSeq: number }>("stats");
      const fromSeq = Math.max(0, stats.nextSeq - limit);
      return (await engine.request<ScanResult>("scan", { fromSeq, limit })).records;
    },

    async raw(sessionId, fromSeq = 0) {
      if (!sessionId.match(/^[0-9a-f]{64}$/)) throw new SesdbQueryError("invalid_parameter", "sessionId must be 64 lowercase hex characters");
      return scanRawRecords(engine, { sessionId, fromSeq });
    },

    capabilities() {
      return engine.request("capabilities");
    },
  };
}

export async function connectSesdb(options: DaemonOptions = {}): Promise<ConnectedSesdb> {
  const engine: EngineClient = process.env.SESDB_TRANSPORT === "stdio" ? new NdjsonEngine(options) : await DaemonEngine.connect(options);
  const base = createSesdb(engine);
  const daemon = engine instanceof DaemonEngine ? engine : undefined;
  const required = () => { if (!daemon) throw new SesdbQueryError("unsupported_capability", "operation requires daemon transport"); return daemon; };
  return Object.assign(base, {
    engine,
    searchPage(text: string, settings: LocalPageOptions = {}) {
      const query = new URLSearchParams({ q: text, limit: String(settings.limit ?? 100), history: String(settings.history ?? false) });
      if (settings.cursor) query.set("cursor", settings.cursor);
      if (settings.provider) query.set("provider", settings.provider);
      if (settings.project) query.set("project", settings.project);
      if (settings.sessionId) query.set("sessionId", settings.sessionId);
      if (settings.fromMs !== undefined) query.set("fromMs", String(settings.fromMs));
      if (settings.toMs !== undefined) query.set("toMs", String(settings.toMs));
      return required().local<SearchPage>(`/search?${query}`);
    },
    sessions(options: number | LocalPageOptions = 100) { const settings = typeof options === "number" ? { limit: options } : options; const query = new URLSearchParams({ limit: String(settings.limit ?? 100) }); if (settings.cursor) query.set("cursor", settings.cursor); if (settings.provider) query.set("provider", settings.provider); if (settings.project) query.set("project", settings.project); if (settings.sessionId) query.set("sessionId", settings.sessionId); if (settings.fromMs !== undefined) query.set("fromMs", String(settings.fromMs)); if (settings.toMs !== undefined) query.set("toMs", String(settings.toMs)); return required().local<SessionPage>(`/sessions?${query}`); },
    timeline(sessionId: string, settings: Omit<LocalPageOptions, "provider" | "project" | "sessionId"> = {}) { const query = new URLSearchParams({ limit: String(settings.limit ?? 1000), history: String(settings.history ?? false) }); if (settings.cursor) query.set("cursor", settings.cursor); if (settings.fromMs !== undefined) query.set("fromMs", String(settings.fromMs)); if (settings.toMs !== undefined) query.set("toMs", String(settings.toMs)); return required().local<SearchPage>(`/sessions/${encodeURIComponent(sessionId)}/events?${query}`); },
    providerHealth() { return required().local("/providers"); },
    reconcile(provider?: "claude" | "codex" | "pi" | "kimi" | "deepseek") { return required().local(provider ? `/providers/${provider}/reconcile` : "/index/reconcile", { method: "POST" }); },
    rebuildIndex() { return required().local("/index/rebuild", { method: "POST" }); },
  });
}
