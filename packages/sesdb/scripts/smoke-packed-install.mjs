import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const executable = process.platform === "win32" ? "sesdb-engine.exe" : "sesdb-engine";
const engine = join(repoRoot, "target", "debug", executable);
const scratch = mkdtempSync(join(tmpdir(), "sesdb-pack-smoke-"));
let tarball;

try {
  const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  tarball = join(packageRoot, pack[0].filename);
  execFileSync("npm", ["init", "--yes"], { cwd: scratch, stdio: "ignore" });
  execFileSync("npm", ["install", tarball], { cwd: scratch, stdio: "inherit" });
  const cli = join(scratch, "node_modules", ".bin", process.platform === "win32" ? "sesdb.cmd" : "sesdb");
  const dbPath = join(scratch, "fresh.usl");
  const env = { ...process.env, SESDB_TRANSPORT: "stdio", SESDB_ENGINE: engine, SESDB_PATH: dbPath };
  const doctor = JSON.parse(execFileSync(cli, ["doctor"], { cwd: scratch, env, encoding: "utf8" }));
  if (!doctor.ok || doctor.integrity?.frameCount !== 0) throw new Error("doctor did not verify a fresh empty store");
  const verify = JSON.parse(execFileSync(cli, ["verify"], { cwd: scratch, env, encoding: "utf8" }));
  if (verify.frameCount !== 0) throw new Error("verify did not inspect the fresh store");
  const query = JSON.parse(execFileSync(cli, ["query", "from events | limit 1"], {
    cwd: scratch,
    env,
    encoding: "utf8",
  }));
  if (query.apiVersion !== "query.usl.dev/v1" || query.rows?.length !== 0) {
    throw new Error("query did not return a versioned empty result");
  }
  if (!readFileSync(join(scratch, "package.json"), "utf8").includes("agent-session-protocol/sesdb")) {
    throw new Error("packed package was not installed");
  }
  if (!readFileSync(join(scratch, "node_modules", "@agent-session-protocol", "sesdb", "console", "index.html"), "utf8").includes("SesDB Console")) {
    throw new Error("packed package is missing the Console entrypoint");
  }
  if (!readFileSync(join(scratch, "node_modules", "@agent-session-protocol", "sesdb", "console", "site", "console.html"), "utf8").includes("console-mode.js")) {
    throw new Error("packed package is missing the shared Site Console export");
  }
  if (!readFileSync(join(scratch, "node_modules", "@agent-session-protocol", "sesdb", "skill", "SKILL.md"), "utf8").includes("Use the `sesdb` CLI only")) {
    throw new Error("packed package is missing the localhost-only SESDB Skill");
  }
  console.log(`packed SESDB smoke test passed (${process.platform}-${process.arch})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
}
