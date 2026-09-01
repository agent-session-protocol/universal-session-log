#!/usr/bin/env node
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPiCorpus, fileBytes, git, hardware, parseArgs, percentile, repoRoot, runProcess, writeJson } from "./lib.mjs";

const FROZEN = "f25666800cda53d78b4304bcd793b6e65a5aad21";
const options = parseArgs(process.argv.slice(2));
if (!options.checkout) throw new Error("--checkout <obelisk checkout> is required; the runner never vendors AGPL source");
const checkout = resolve(options.checkout);
if (git(checkout, "rev-parse", "HEAD") !== FROZEN) throw new Error(`Obelisk checkout must be frozen at ${FROZEN}`);
const cli = join(checkout, "packages/cli/dist/cli/src/obelisk.js");
const buildStarted = performance.now(); await runProcess("npm", ["ci"], { cwd: checkout }); await runProcess("npm", ["run", "build:cli"], { cwd: checkout }); const buildMs = performance.now() - buildStarted;
const result = { schemaVersion: "sesdb.i0-benchmark/v1", product: "obelisk", revision: FROZEN, hardware: hardware(), startedAt: new Date().toISOString(), buildMs, corpus: { provider: "pi", recordsPerSession: 2, featureCorpus: "fixtures/providers" }, sqliteWriteMetric: "sidecar-size-change observations at black-box command boundaries", runs: [] };

for (const sessions of options.sizes) {
  const home = mkdtempSync(join(tmpdir(), `obelisk-i0-${sessions}-`)); createPiCorpus(home, sessions);
  const env = { ...process.env, HOME: home }; const db = join(home, ".obelisk/obelisk.sqlite"); let writeObservations = 0; let lastSize = fileBytes(db);
  const command = async args => { const value = await runProcess("node", [cli, ...args], { cwd: checkout, env }); const size = fileBytes(db); if (size !== lastSize) { writeObservations++; lastSize = size; } return value; };
  try {
    const cold = await command(["--build"]); const noop = await command(["--build"]); const latencies = []; let peakRssBytes = Math.max(cold.peakRssBytes, noop.peakRssBytes);
    const target = join(home, ".pi/agent/sessions/fixture/i0-pi-00000000.jsonl");
    for (let index = 0; index < 20; index++) {
      appendFileSync(target, JSON.stringify({ type: "message", id: `benchmark-${index}`, parentId: "22222222", timestamp: new Date(Date.UTC(2026, 7, 15, 0, 0, index)).toISOString(), message: { role: "user", content: [{ type: "text", text: `benchmark-token-${index}` }] } }) + "\n");
      const started = performance.now(); const refresh = await command(["--build"]); const search = await command(["--search", `benchmark-token-${index}`]);
      if (!Array.isArray(JSON.parse(search.stdout)) || !JSON.parse(search.stdout).length) throw new Error(`appended token ${index} was not queryable`);
      latencies.push(performance.now() - started); peakRssBytes = Math.max(peakRssBytes, refresh.peakRssBytes, search.peakRssBytes);
    }
    const rebuild = await command(["--build"]); peakRssBytes = Math.max(peakRssBytes, rebuild.peakRssBytes);
    result.runs.push({ sessions, coldIndexMs: cold.durationMs, noopReconcileMs: noop.durationMs, appendToSearch: { samples: latencies.length, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) }, rebuildMs: rebuild.durationMs, rssBytes: peakRssBytes, sidecarBytes: fileBytes(db) + fileBytes(`${db}-wal`) + fileBytes(`${db}-shm`), sqliteWriteObservations: writeObservations });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
result.finishedAt = new Date().toISOString(); const output = options.output ?? join(repoRoot, "benchmarks/i0/results/obelisk.json"); writeJson(output, result); console.log(output);
