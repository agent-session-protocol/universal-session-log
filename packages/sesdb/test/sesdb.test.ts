import test from "node:test";
import assert from "node:assert/strict";
import { EngineUnavailableError, MemoryEngine, NdjsonEngine, SesdbRpcError } from "../src/engine.js";
import { createSesdb } from "../src/index.js";
import { parseSessionQL, printSessionQL, SessionQLError } from "../src/query.js";

const sessionId = "a".repeat(64);
const sourceDigest = "b".repeat(64);

function storedBody(text: string, includeEvidence = true): number[] {
  const event = {
    schemaVersion: "1.0",
    eventId: `event-${text}`,
    sessionId,
    type: "message.completed",
    timestamp: "2026-08-31T00:00:00.000Z",
    payload: { message: { content: [{ type: "text", text }] } },
  };
  const value = includeEvidence ? {
    event,
    evidence: {
      sessionId,
      eventId: event.eventId,
      sourcePath: "/fixture/session.jsonl",
      sourceDigest,
      byteStart: 10,
      byteEnd: 100,
      parserVersion: "fixture@1",
    },
  } : event;
  return [...new TextEncoder().encode(JSON.stringify(value))];
}

function storedEvent(eventId: string, timestamp: string): number[] {
  const event = {
    schemaVersion: "1.0",
    eventId,
    sessionId,
    type: "message.completed",
    timestamp,
    payload: {},
  };
  return [...new TextEncoder().encode(JSON.stringify(event))];
}

test("SessionQL emits expression AST and has a deterministic parse/print boundary", () => {
  const plan = parseSessionQL('from events | where event.type = "tool.completed" and sessionId = $session | sort by event.timestamp desc | limit 5');
  assert.equal(plan.irVersion, "1.0");
  assert.equal(plan.stages[0].op, "where");
  assert.notEqual(typeof (plan.stages[0] as { expression: unknown }).expression, "string");
  assert.deepEqual(plan.parameters, [{ name: "session", type: "string", required: true }]);
  assert.deepEqual(parseSessionQL(printSessionQL(plan)), plan);
});

test("pipeline separators inside string literals are preserved", () => {
  const plan = parseSessionQL('from events | search text "a|b" | limit 1');
  assert.equal(plan.stages[0].op, "search");
  assert.equal((plan.stages[0] as { query: { value: string } }).query.value, "a|b");
});

test("SDK executes event filters at a fixed watermark", async () => {
  const engine = new MemoryEngine();
  await engine.request("appendBatch", { records: [
    { sessionId, kind: 1, tsMs: 1, body: storedBody("first") },
    { sessionId, kind: 1, tsMs: 2, body: storedBody("second") },
  ] });
  const result = await createSesdb(engine).query({
    sessionql: 'from events | where event.eventId = "event-second" | project eventId, event.type | limit 1',
    includeExplain: true,
  });
  assert.equal(result.asOfSeq, 2);
  assert.deepEqual(result.rows, [{ eventId: "event-second", "event.type": "message.completed" }]);
  assert.equal(result.explain?.stages.length, 3);
});

test("numeric filters and sorts use numeric rather than lexical order", async () => {
  const engine = new MemoryEngine();
  await engine.request("appendBatch", { records: [
    { sessionId, kind: 1, tsMs: 1, body: storedEvent("event-10", "2026-08-31T00:00:10.000Z") },
    { sessionId, kind: 1, tsMs: 2, body: storedEvent("event-2", "2026-08-31T00:00:02.000Z") },
  ] });
  const result = await createSesdb(engine).query(
    "from events | where globalSeq < 10 | sort by globalSeq desc | project globalSeq",
  );
  assert.deepEqual(result.rows, [{ globalSeq: 1 }, { globalSeq: 0 }]);
});

test("search requires complete evidence and never searches opaque records", async () => {
  const engine = new MemoryEngine();
  await engine.request("appendBatch", { records: [
    { sessionId, kind: 1, tsMs: 1, body: storedBody("中文 tool.completed") },
    { sessionId, kind: 1, tsMs: 2, body: storedBody("secret without evidence", false) },
    { sessionId, kind: 2, tsMs: 3, body: [...new TextEncoder().encode("opaque secret")] },
  ] });
  const db = createSesdb(engine);
  const hits = await db.search("TOOL.COMPLETED");
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence[0], {
    sessionId,
    eventId: "event-中文 tool.completed",
    sourcePath: "/fixture/session.jsonl",
    sourceDigest,
    byteStart: 10,
    byteEnd: 100,
    parserVersion: "fixture@1",
  });
  assert.equal((await db.search("secret")).length, 0);
});

test("unsupported query capabilities fail explicitly", async () => {
  const db = createSesdb(new MemoryEngine());
  await assert.rejects(db.query('from events | search hybrid "question"'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "unsupported_capability");
    return true;
  });
  assert.throws(() => parseSessionQL("from events | group by sessionId"), SessionQLError);
  assert.throws(() => parseSessionQL("from events | project event.unknown"), /unknown events field/);
});

test("memory engine validates a complete batch before appending", async () => {
  const engine = new MemoryEngine();
  await assert.rejects(engine.request("appendBatch", { records: [
    { sessionId, kind: 1, tsMs: 1, body: [1] },
    { sessionId: "bad", kind: 1, tsMs: 2, body: [2] },
  ] }), SesdbRpcError);
  assert.equal(engine.records.length, 0);
});

test("missing engine binaries reject pending requests instead of hanging", async () => {
  const engine = new NdjsonEngine({ binary: "/definitely/missing/sesdb-engine", requestTimeoutMs: 1_000 });
  await assert.rejects(engine.request("stats"), EngineUnavailableError);
  await engine.close();
});
