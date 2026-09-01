import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hostedConsole = '/universal-session-log/console?lang=en';

async function waitForJson(path: string, child: ChildProcess): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`sesdbd exited early with ${child.exitCode}`);
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error('timed out waiting for daemon descriptor');
}

async function daemonRequest(baseUrl: string, token: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

async function installDaemonMocks(page: Page, state: 'degraded' | 'rebuilding' | 'offline') {
  await page.route('**/console-mode.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.__SESDB_CONSOLE__={mode:"daemon",baseUrl:""};',
  }));
  await page.route('**/sessions?limit=1000', (route) => state === 'offline'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'storage_error', message: 'daemon offline', details: {}, retryable: true }) })
    : route.fulfill({ json: { items: [] } }));
  await page.route('**/index/status', (route) => route.fulfill({ json: {
    generation: 9, builtThroughSeq: 12, asOfSeq: 14, degraded: state === 'degraded', rebuilding: state === 'rebuilding',
  } }));
  await page.route('**/providers', (route) => route.fulfill({ json: { providers: { claude: { enabled: true }, codex: { enabled: false } } } }));
  await page.route('**/rpc', async (route) => {
    const method = (route.request().postDataJSON() as { method?: string }).method;
    await route.fulfill({ json: method === 'verify'
      ? { result: { dataEnd: 4096, nextSeq: 14, sessionCount: 0, frameCount: 14, truncationOffset: null } }
      : { nextSeq: 14, sessionCount: 0, dataEnd: 4096 } });
  });
}

test('Hosted Console stays demo-only and never probes another localhost authority', async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') && url.origin !== baseURL) unexpected.push(request.url());
  });
  await page.goto(hostedConsole);
  await expect(page.getByText('INTERACTIVE DEMO')).toBeVisible();
  await expect(page.getByText('Demo data ready')).toBeVisible();
  await expect(page.getByTestId('runtime-status')).toHaveCount(0);
  expect(await page.evaluate(() => window.__SESDB_CONSOLE__?.mode)).toBe('demo');
  expect(unexpected).toEqual([]);
});

test('local daemon serves disabled state, real provider data, and freshness', async ({ page }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'sesdb-console-e2e-'));
  const home = join(scratch, 'home');
  const provider = join(scratch, 'provider');
  await mkdir(provider, { recursive: true });
  await writeFile(join(provider, 'session.jsonl'), '{"type":"user","sessionId":"playwright-native-session","uuid":"u1","timestamp":1000,"message":{"content":"playwright real daemon needle"}}\n');
  const binary = resolve(process.cwd(), '../target/debug/sesdbd');
  const child = spawn(binary, [], {
    cwd: resolve(process.cwd(), '..'),
    env: { ...process.env, SESDB_HOME: home, SESDB_CONSOLE_DIR: resolve(process.cwd(), 'out') },
    stdio: 'ignore',
  });
  try {
    const descriptor = await waitForJson(join(home, 'run/daemon.json'), child);
    const baseUrl = String(descriptor.baseUrl);
    const token = String(descriptor.token);
    const browser = await daemonRequest(baseUrl, token, '/browser-session');
    await page.goto(String(browser.url));
    await page.goto(`${baseUrl}/universal-session-log/console?lang=en`);
    await expect(page.getByText('LOCAL DAEMON')).toBeVisible();
    await expect(page.getByText('Providers disabled', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('runtime-status')).toContainText('Providers disabled');

    await daemonRequest(baseUrl, token, '/providers/claude/enable', { root: provider });
    await daemonRequest(baseUrl, token, '/providers/claude/reconcile');
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await expect(page.getByTestId('runtime-status')).toContainText(/FRESH.*Generation.*Built \d+ \/ As of \d+.*claude/);
    await expect(page.getByText('playwright-native-s…')).toBeVisible();
    await expect(page.getByText('Total sessions').locator('..').getByText('1')).toBeVisible();
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => child.once('exit', resolvePromise));
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Console renders degraded index diagnostics', async ({ page }) => {
  await installDaemonMocks(page, 'degraded');
  await page.goto(hostedConsole);
  await expect(page.getByText('LOCAL DAEMON')).toBeVisible();
  await expect(page.getByText('Index degraded')).toBeVisible();
  await expect(page.getByTestId('runtime-status')).toContainText('DEGRADED');
  await expect(page.getByTestId('runtime-status')).toContainText('Built 12 / As of 14');
});

test('Console renders rebuilding freshness state', async ({ page }) => {
  await installDaemonMocks(page, 'rebuilding');
  await page.goto(hostedConsole);
  await expect(page.getByText('Index rebuilding')).toBeVisible();
  await expect(page.getByTestId('runtime-status')).toContainText('REBUILDING');
});

test('Console renders offline state without falling back to demo data', async ({ page }) => {
  await installDaemonMocks(page, 'offline');
  await page.goto(hostedConsole);
  await expect(page.getByText('Daemon offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Unable to read SesDB')).toBeVisible();
  await expect(page.getByText('daemon offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Repair auth token refresh race')).toHaveCount(0);
});
