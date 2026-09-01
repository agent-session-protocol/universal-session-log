import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface EngineRecord {
  sessionId: string;
  kind: number;
  tsMs: number;
  body: number[];
}

export interface StoredRecord extends EngineRecord {
  seq: number;
}

export interface ScanResult {
  records: StoredRecord[];
  nextSeq: number;
  nextFromSeq: number;
  hasMore: boolean;
}

export interface EngineClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface EngineOptions {
  path?: string;
  binary?: string;
  token?: string;
  requestTimeoutMs?: number;
}

export interface DaemonDescriptor {
  apiVersion: "sesdb.local/v1";
  baseUrl: string;
  token: string;
  pid: number;
  startedAtMs: number;
}

export interface DaemonOptions {
  home?: string;
  binary?: string;
  autoStart?: boolean;
  requestTimeoutMs?: number;
}

export interface RpcErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export class SesdbRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(error: RpcErrorShape) {
    super(error.message);
    this.name = "SesdbRpcError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export class EngineUnavailableError extends Error {
  constructor(binary: string, cause?: unknown) {
    super(
      `Unable to start SESDB engine at ${JSON.stringify(binary)}. ` +
      "Set SESDB_ENGINE to a sesdb-engine binary or build it with `cargo build -p sesdb-engine`.",
      { cause },
    );
    this.name = "EngineUnavailableError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcResponse {
  id?: number;
  ok: boolean;
  result?: unknown;
  error?: RpcErrorShape;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveEngineBinary(explicit?: string): string {
  const configured = explicit ?? process.env.SESDB_ENGINE;
  if (configured) return configured;

  const executableName = process.platform === "win32" ? "sesdb-engine.exe" : "sesdb-engine";
  const candidates = [
    fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/${executableName}`, import.meta.url)),
    fileURLToPath(new URL(`../../../target/release/${executableName}`, import.meta.url)),
    fileURLToPath(new URL(`../../../target/debug/${executableName}`, import.meta.url)),
  ];
  return candidates.find(executable) ?? executableName;
}

export function resolveDaemonBinary(explicit?: string): string {
  const configured = explicit ?? process.env.SESDB_DAEMON;
  if (configured) return configured;
  const executableName = process.platform === "win32" ? "sesdbd.exe" : "sesdbd";
  const candidates = [
    fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/${executableName}`, import.meta.url)),
    fileURLToPath(new URL(`../../../target/release/${executableName}`, import.meta.url)),
    fileURLToPath(new URL(`../../../target/debug/${executableName}`, import.meta.url)),
  ];
  return candidates.find(executable) ?? executableName;
}

function daemonHome(explicit?: string): string {
  return explicit ?? process.env.SESDB_HOME ?? join(homedir(), ".sesdb");
}

export async function readDaemonDescriptor(home = daemonHome()): Promise<DaemonDescriptor | undefined> {
  const path = join(home, "run", "daemon.json");
  try {
    const metadata = await stat(path);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("daemon descriptor must be owner-only (0600)");
    const value = JSON.parse(await readFile(path, "utf8")) as DaemonDescriptor;
    if (value.apiVersion !== "sesdb.local/v1" || !value.baseUrl.startsWith("http://127.0.0.1:") || !value.token.match(/^[0-9a-f]{64}$/)) throw new Error("invalid daemon descriptor");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function healthy(descriptor: DaemonDescriptor, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(`${descriptor.baseUrl}/health`, { headers: { authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

export async function ensureDaemon(options: DaemonOptions = {}): Promise<DaemonDescriptor> {
  const home = daemonHome(options.home);
  const existing = await readDaemonDescriptor(home);
  if (existing && await healthy(existing)) return existing;
  if (existing) await unlink(join(home, "run", "daemon.json")).catch(() => {});
  if (options.autoStart === false) throw new EngineUnavailableError(resolveDaemonBinary(options.binary));
  const binary = resolveDaemonBinary(options.binary);
  const child = spawn(binary, [], { detached: true, stdio: "ignore", env: { ...process.env, SESDB_HOME: home } });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("error", cause => reject(new EngineUnavailableError(binary, cause)));
    setTimeout(resolve, 20);
  });
  const deadline = Date.now() + (options.requestTimeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const descriptor = await readDaemonDescriptor(home);
    if (descriptor && await healthy(descriptor)) return descriptor;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new EngineUnavailableError(binary, new Error("daemon health check timed out"));
}

export class DaemonEngine implements EngineClient {
  readonly descriptor: DaemonDescriptor;
  readonly #requestTimeoutMs: number;
  constructor(descriptor: DaemonDescriptor, requestTimeoutMs = 30_000) { this.descriptor = descriptor; this.#requestTimeoutMs = requestTimeoutMs; }
  static async connect(options: DaemonOptions = {}): Promise<DaemonEngine> { return new DaemonEngine(await ensureDaemon(options), options.requestTimeoutMs); }
  async local<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.descriptor.baseUrl}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.descriptor.token}`, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: init.signal ?? AbortSignal.timeout(this.#requestTimeoutMs) });
    const value = await response.json() as T | RpcErrorShape;
    if (!response.ok) throw new SesdbRpcError(value as RpcErrorShape);
    return value as T;
  }
  request<T>(method: string, params?: unknown): Promise<T> { return this.local<T>("/rpc", { method: "POST", body: JSON.stringify({ method, params }) }); }
  async close(): Promise<void> {}
  async stop(): Promise<void> {
    await this.local("/daemon/stop", { method: "POST" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await healthy(this.descriptor, 200)) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export class NdjsonEngine implements EngineClient {
  readonly #child: ChildProcess;
  readonly #token: string;
  readonly #binary: string;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #buffer = "";
  #terminalError: Error | undefined;
  #closePromise: Promise<void>;

  constructor(options: EngineOptions = {}) {
    const path = options.path ?? process.env.SESDB_PATH ?? join(homedir(), ".sesdb", "sesdb.usl");
    this.#binary = resolveEngineBinary(options.binary);
    this.#token = options.token ?? process.env.SESDB_TOKEN ?? randomBytes(32).toString("hex");
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#child = spawn(this.#binary, [path], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, SESDB_TOKEN: this.#token },
    });

    this.#closePromise = new Promise(resolve => this.#child.once("close", () => resolve()));
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => this.#consume(chunk));
    this.#child.stdout?.on("end", () => {
      if (!this.#terminalError && this.#pending.size > 0) {
        this.#terminate(new Error("SESDB engine closed its response stream"));
      }
    });
    this.#child.on("error", cause => this.#terminate(new EngineUnavailableError(this.#binary, cause)));
    this.#child.on("exit", (code, signal) => {
      if (!this.#terminalError && this.#pending.size > 0) {
        this.#terminate(new Error(`SESDB engine exited before responding (code=${code}, signal=${signal})`));
      }
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (!this.#child.stdin?.writable) {
      return Promise.reject(new EngineUnavailableError(this.#binary));
    }

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`SESDB engine request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      this.#child.stdin?.write(
        `${JSON.stringify({ id, method, params, token: this.#token })}\n`,
        error => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(new EngineUnavailableError(this.#binary, error));
        },
      );
    });
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin?.end();
    await this.#closePromise;
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch (cause) {
        this.#terminate(new Error("SESDB engine emitted invalid NDJSON", { cause }));
        return;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new SesdbRpcError(response.error ?? {
          code: "protocol_error",
          message: "SESDB engine returned an error without details",
          retryable: false,
        }));
      }
    }
  }

  #terminate(error: Error): void {
    if (!this.#terminalError) this.#terminalError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#terminalError);
    }
    this.#pending.clear();
  }
}

export class MemoryEngine implements EngineClient {
  readonly records: StoredRecord[] = [];
  #nextSeq = 0;

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const input = params as Record<string, unknown>;
    if (method === "appendBatch") {
      const records = input.records;
      if (!Array.isArray(records)) throw new SesdbRpcError({ code: "invalid_parameter", message: "records must be an array", retryable: false });
      const parsed = records.map(validateMemoryRecord);
      const seqs = parsed.map(record => {
        const stored = { ...record, seq: this.#nextSeq++ };
        this.records.push(stored);
        return stored.seq;
      });
      return { seqs, nextSeq: this.#nextSeq } as T;
    }
    if (method === "scan") {
      const fromSeq = typeof input.fromSeq === "number" ? input.fromSeq : 0;
      const limit = typeof input.limit === "number" ? input.limit : 1_000;
      const matches = this.records.filter(record => record.seq >= fromSeq && (!input.sessionId || record.sessionId === input.sessionId));
      const records = matches.slice(0, limit);
      return {
        records,
        nextSeq: this.#nextSeq,
        nextFromSeq: records.at(-1)?.seq === undefined ? fromSeq : records.at(-1)!.seq + 1,
        hasMore: matches.length > records.length,
      } as T;
    }
    if (method === "stats") return { nextSeq: this.#nextSeq, sessionCount: new Set(this.records.map(record => record.sessionId)).size, dataEnd: 0 } as T;
    if (method === "flush") return { nextSeq: this.#nextSeq } as T;
    if (method === "capabilities") return { rpcVersion: "sesdb.engine/v1", tailMode: "unsupported" } as T;
    throw new SesdbRpcError({ code: "unsupported_capability", message: `unsupported method: ${method}`, retryable: false });
  }

  async close(): Promise<void> {}
}

function validateMemoryRecord(value: unknown): EngineRecord {
  if (!value || typeof value !== "object") throw new SesdbRpcError({ code: "invalid_parameter", message: "record must be an object", retryable: false });
  const record = value as Partial<EngineRecord>;
  const invalid =
    !record.sessionId?.match(/^[0-9a-f]{64}$/) ||
    !Number.isInteger(record.kind) ||
    !Number.isSafeInteger(record.tsMs) ||
    !Array.isArray(record.body) ||
    record.body.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255);
  if (invalid) {
    throw new SesdbRpcError({ code: "invalid_parameter", message: "invalid record", retryable: false });
  }
  return record as EngineRecord;
}
