#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const manifest = JSON.parse(readFileSync(join(here, "baseline.json"), "utf8"));
const errors = [];
const statuses = new Set(["delivered", "specified", "planned"]);
const expectedProviders = ["claude", "codex", "deepseek", "kimi", "pi"];
const expectedScenarios = [
  "archive", "delete", "main-thread", "partial-write", "subagent", "summary",
  "tool-call-and-result", "truncate-or-replace", "undo-or-clear",
];

if (manifest.schemaVersion !== "sesdb.obelisk-baseline/v1") errors.push("unexpected schemaVersion");
if (manifest.baseline?.revision !== "f25666800cda53d78b4304bcd793b6e65a5aad21") errors.push("pinned Obelisk revision moved");
if (manifest.baseline?.licenseBoundary !== "clean-room-behavior-only") errors.push("clean-room boundary is missing");

const providers = (manifest.providers ?? []).map(provider => provider.id).sort();
if (JSON.stringify(providers) !== JSON.stringify(expectedProviders)) errors.push("the five-provider parity set changed");
for (const provider of manifest.providers ?? []) {
  for (const field of ["obelisk", "sesdbAdapter", "sesdbConversion"]) {
    if (!statuses.has(provider[field])) errors.push(`${provider.id}.${field} has an invalid status`);
  }
}

const scenarios = [...(manifest.corpusScenarios ?? [])].sort();
if (JSON.stringify(scenarios) !== JSON.stringify(expectedScenarios)) errors.push("required corpus scenario coverage changed");

const journeyIds = new Set();
for (const journey of manifest.journeys ?? []) {
  if (journeyIds.has(journey.id)) errors.push(`duplicate journey: ${journey.id}`);
  journeyIds.add(journey.id);
  for (const side of ["obelisk", "sesdb"]) {
    if (!statuses.has(journey[side])) errors.push(`${journey.id}.${side} has an invalid status`);
  }
  if (journey.sesdb === "delivered" && !(journey.evidence?.length > 0)) {
    errors.push(`${journey.id} is delivered without local evidence`);
  }
  for (const path of journey.evidence ?? []) {
    try {
      if (!statSync(join(repo, path)).isFile()) errors.push(`${journey.id} evidence is not a file: ${path}`);
    } catch {
      errors.push(`${journey.id} evidence is missing: ${path}`);
    }
  }
}

if (!manifest.gate?.status || !["in-progress", "passed"].includes(manifest.gate.status)) errors.push("invalid I0 gate status");
if (manifest.gate?.status === "passed" && manifest.gate.missing?.length) errors.push("I0 cannot pass with missing requirements");

if (errors.length) {
  console.error(`Obelisk baseline verification failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Obelisk baseline is pinned; I0 gate: ${manifest.gate.status}`);
