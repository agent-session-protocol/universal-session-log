import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem, arch } from "node:os";
import { dirname, join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../..");
export const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
export const hardware = () => ({ platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, memoryBytes: totalmem() });
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const fileBytes = path => { try { return statSync(path).size; } catch { return 0; } };
export const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };

export function createPiCorpus(home, count) {
  const root = join(home, ".pi/agent/sessions/fixture");
  mkdirSync(root, { recursive: true });
  const source = readFileSync(join(repoRoot, "fixtures/providers/pi/session.jsonl"), "utf8").trimEnd().split("\n");
  // Session-scale benchmarks use a stable two-record slice; feature coverage
  // remains in the complete corpus and provider conformance suite.
  const template = `${source[0]}\n${source[3]}\n`;
  for (let index = 0; index < count; index++) {
    const id = `i0-pi-${String(index).padStart(8, "0")}`;
    writeFileSync(join(root, `${id}.jsonl`), template.replaceAll("019fff74-b539-7a7d-90c9-ad8895912e04", id));
  }
  return root;
}

export async function runProcess(command, args, options = {}) {
  const started = performance.now();
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let peakRssBytes = 0;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const sample = setInterval(() => {
    try { peakRssBytes = Math.max(peakRssBytes, Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim()) * 1024 || 0); } catch {}
  }, 20);
  const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("exit", resolveCode); });
  clearInterval(sample);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  return { durationMs: performance.now() - started, peakRssBytes, stdout, stderr };
}

export function parseArgs(argv) {
  const value = key => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  return { sizes: (value("--sizes") ?? "100,1000,10000").split(",").map(Number), output: value("--output"), checkout: value("--checkout") };
}
