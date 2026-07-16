import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  DeterministicOpenAiServer,
  REGRESSION_API_KEY,
  REGRESSION_FALLBACK_MODEL,
  REGRESSION_MODEL,
} from './fixtures/deterministic-openai-server';
import {
  allocatePort,
  closePackagedApp,
  ensurePortableRoot,
  hostApiJson,
  launchPackagedApp,
  rawHostApi,
  seedGatewaySettings,
  waitForGateway,
  waitForGatewayReady,
  type PackagedAppContext,
} from './fixtures/packaged-app';

type ScenarioStatus = 'passed' | 'failed' | 'skipped';

type ScenarioResult = {
  id: string;
  title: string;
  status: ScenarioStatus;
  startedAt: string;
  durationMs: number;
  details?: unknown;
  error?: string;
  screenshot?: string;
};

type HostTask = {
  taskId?: string;
  status?: string;
  artifacts?: Array<{ filePath?: string; kind?: string; title?: string }>;
  verifications?: Array<{ status?: string; kind?: string }>;
  error?: string;
};

const appRoot = requiredEnv('UCLAW_PACKAGED_ROOT');
const sandboxRoot = requiredEnv('UCLAW_REGRESSION_SANDBOX');
const reportDir = requiredEnv('UCLAW_REGRESSION_REPORT_DIR');
const profile = process.env.UCLAW_REGRESSION_PROFILE || 'full';
const runId = process.env.UCLAW_REGRESSION_RUN_ID || `manual-${Date.now()}`;
const allowDesktopCapture = process.env.UCLAW_REGRESSION_ALLOW_DESKTOP_CAPTURE === '1';
const allowExternalDelivery = process.env.UCLAW_REGRESSION_ALLOW_EXTERNAL_DELIVERY === '1';
const liveLoginStdin = process.env.UCLAW_REGRESSION_LIVE_LOGIN_STDIN === '1';
const externalDelivery = {
  channel: process.env.UCLAW_REGRESSION_DELIVERY_CHANNEL?.trim() || '',
  accountId: process.env.UCLAW_REGRESSION_DELIVERY_ACCOUNT_ID?.trim() || '',
  target: process.env.UCLAW_REGRESSION_DELIVERY_TARGET?.trim() || '',
};
let regressionModelRef = '';
let regressionAccountId = '';
let fallbackAccountId = '';

type LiveLoginCredentials = {
  username: string;
  password: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Run the packaged regression orchestrator.`);
  return path.resolve(value);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 100);
}

function redactedError(error: unknown): string {
  return String(error instanceof Error ? error.stack || error.message : error)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|relay[_-]?token|password|secret)"?\s*[:=]\s*")([^"]+)(")/giu, '$1[REDACTED]$3')
    .replace(/([?&#](?:token|signature|sig|key)=)[^&#\s]+/giu, '$1[REDACTED]');
}

async function readLiveLoginCredentials(): Promise<LiveLoginCredentials> {
  if (!liveLoginStdin) throw new Error('Live login stdin was not enabled.');
  const stdin = process.stdin;
  const previousRawMode = stdin.isTTY ? stdin.isRaw : false;
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(previousRawMode);
      stdin.pause();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const lineEnd = buffer.search(/[\r\n]/u);
      if (lineEnd < 0) return;
      const value = buffer.slice(0, lineEnd);
      cleanup();
      resolve(value);
    };
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('error', onError);
    stdin.resume();
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Live login stdin must be one JSON line.');
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (!username || !password) throw new Error('Live login stdin requires username and password.');
  return { username, password };
}

async function loginManagedAccount(hostApiPort: number, credentials: LiveLoginCredentials): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${hostApiPort}/api/junfeiai/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload.success === false) {
    const code = typeof payload.code === 'string' ? payload.code : `http_${response.status}`;
    const message = typeof payload.message === 'string' ? payload.message : 'Managed login failed.';
    throw new Error(`Managed login failed (${code}): ${message}`);
  }
  return {
    managed: payload.managed === true,
    authValid: payload.authValid === true,
    hasRelayToken: payload.hasRelayToken === true,
    deviceActivated: payload.deviceActivated === true,
    activationRequired: payload.activationRequired === true,
  };
}

async function sanitizedControlUiInfo(page: Page): Promise<{
  success: boolean;
  port: number | null;
  tokenInFragment: boolean;
  sanitizedUrl: string;
}> {
  return await page.evaluate(async () => {
    const electronApi = (window as unknown as {
      electron: { ipcRenderer: { invoke(channel: string, payload: unknown): Promise<unknown> } };
    }).electron;
    const raw = await electronApi.ipcRenderer.invoke('hostapi:fetch', {
      path: '/api/gateway/control-ui',
      method: 'GET',
      headers: {},
      body: null,
    });
    const response = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const data = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? response.data as Record<string, unknown>
      : response;
    const json = data.json && typeof data.json === 'object' && !Array.isArray(data.json)
      ? data.json as Record<string, unknown>
      : {};
    const rawUrl = typeof json.url === 'string' ? json.url : '';
    const url = rawUrl ? new URL(rawUrl) : null;
    const tokenInFragment = Boolean(url?.hash && new URLSearchParams(url.hash.slice(1)).has('token'));
    if (url) {
      url.hash = '';
      for (const name of ['token', 'key', 'signature', 'sig']) url.searchParams.delete(name);
    }
    return {
      success: json.success === true,
      port: typeof json.port === 'number' ? json.port : null,
      tokenInFragment,
      sanitizedUrl: url?.toString() || '',
    };
  });
}

async function verifyOfficePackage(
  filePath: string,
  requiredEntry: RegExp,
  requiredText: string,
): Promise<{ bytes: number; entries: number }> {
  const file = await readFile(filePath);
  const zip = await JSZip.loadAsync(file);
  const entryNames = Object.keys(zip.files);
  expect(entryNames.some((entry) => requiredEntry.test(entry))).toBe(true);
  const xmlEntries = entryNames.filter((entry) => /\.xml$/iu.test(entry));
  const xml = (await Promise.all(xmlEntries.map(async (entry) => await zip.file(entry)?.async('string') ?? ''))).join('\n');
  expect(xml).toContain(requiredText);
  return { bytes: file.length, entries: entryNames.length };
}

async function listGatewaySessions(page: Page): Promise<Array<Record<string, unknown>>> {
  const payload = await hostApiJson<{ result?: { sessions?: Array<Record<string, unknown>> } }>(page, '/api/chat/sessions');
  return Array.isArray(payload.result?.sessions) ? payload.result.sessions : [];
}

class ScenarioRunner {
  readonly results: ScenarioResult[] = [];
  private pageProvider: () => Page | null = () => null;

  setPageProvider(provider: () => Page | null): void {
    this.pageProvider = provider;
  }

  async run(
    id: string,
    title: string,
    execute: () => Promise<unknown>,
    options?: { skip?: string },
  ): Promise<void> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    await test.step(`${id}: ${title}`, async () => {
      if (options?.skip) {
        this.results.push({ id, title, status: 'skipped', startedAt, durationMs: 0, details: { reason: options.skip } });
        return;
      }
      try {
        const details = await execute();
        this.results.push({ id, title, status: 'passed', startedAt, durationMs: Date.now() - startedAtMs, details });
      } catch (error) {
        let screenshot: string | undefined;
        const page = this.pageProvider();
        if (page && !page.isClosed()) {
          screenshot = path.join(reportDir, 'scenario-failures', `${safeName(id)}.png`);
          try {
            await mkdir(path.dirname(screenshot), { recursive: true });
            await page.screenshot({ path: screenshot, fullPage: true });
          } catch {
            screenshot = undefined;
          }
        }
        this.results.push({
          id,
          title,
          status: 'failed',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          error: redactedError(error),
          screenshot,
        });
      }
    });
  }

  async finish(): Promise<void> {
    await mkdir(reportDir, { recursive: true });
    const outputPath = path.join(reportDir, 'scenario-results.json');
    await writeFile(outputPath, `${JSON.stringify(this.results, null, 2)}\n`, 'utf8');
    await test.info().attach('scenario-results', { path: outputPath, contentType: 'application/json' });
    const failures = this.results.filter((result) => result.status === 'failed');
    expect(failures, failures.map((failure) => `${failure.id}: ${failure.error}`).join('\n\n')).toEqual([]);
  }
}

function contextOrThrow(context: PackagedAppContext | null): PackagedAppContext {
  if (!context) throw new Error('Packaged UClaw is not running.');
  return context;
}

async function startNewChat(page: Page): Promise<void> {
  await page.getByTestId('sidebar-new-chat').click();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 120_000 });
  if (regressionModelRef) await selectRegressionModel(page);
}

async function selectRegressionModel(page: Page): Promise<void> {
  const picker = page.getByTestId('chat-model-picker-button');
  await page.getByTestId('chat-model-picker-button').click();
  await page.getByTestId(`chat-model-picker-option-${REGRESSION_MODEL}`).click();
  await expect(picker).toContainText(REGRESSION_MODEL);
  await page.waitForTimeout(750);
  await expect(picker).toContainText(REGRESSION_MODEL);
}

async function addCustomProvider(
  page: Page,
  label: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  await page.getByTestId('sidebar-nav-models').click();
  await page.getByTestId('providers-add-button').click();
  await page.getByTestId('add-provider-type-custom').click();
  await page.getByTestId('add-provider-name-input').fill(label);
  await page.getByTestId('add-provider-base-url-input').fill(baseUrl);
  await page.getByTestId('add-provider-model-id-input').fill(model);
  await page.getByTestId('add-provider-api-key-input').fill(REGRESSION_API_KEY);
  await page.getByTestId('add-provider-submit-button').click();
  await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0, { timeout: 60_000 });
  const card = page.locator('[data-testid^="provider-card-"]').filter({ hasText: label });
  await expect(card).toBeVisible();
  const accounts = await hostApiJson<Array<{ id: string; label: string }>>(page, '/api/provider-accounts');
  const account = accounts.find((entry) => entry.label === label);
  if (!account?.id) throw new Error(`Provider account was not persisted for ${label}.`);
  return account.id;
}

async function sendChat(page: Page, prompt: string, expectedText: string, timeoutMs = 120_000): Promise<number> {
  const startedAt = Date.now();
  const chatMessages = page.locator('[data-testid^="chat-message-"]');
  const messageCountBeforeSend = await chatMessages.count();
  const sendButton = page.getByTestId('chat-composer-send');
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('chat-composer-input').fill(prompt);
  await sendButton.click();
  const expected = page.getByText(expectedText, { exact: false }).last();
  const error = page.getByTestId('chat-run-error');
  const transcriptFailure = page.getByText(/Agent failed before reply:/iu).last();
  const deadline = Date.now() + timeoutMs;
  let observedBusy = false;
  while (Date.now() < deadline) {
    if (await expected.isVisible()) break;
    if (await error.isVisible()) throw new Error(`Chat failed before expected output: ${await error.innerText()}`);
    if (await transcriptFailure.isVisible()) {
      throw new Error(`Chat failed before expected output: ${await transcriptFailure.innerText()}`);
    }
    const sendTitle = await sendButton.getAttribute('title') ?? '';
    const isIdle = /Send|发送/iu.test(sendTitle);
    if (!isIdle) observedBusy = true;
    const messageCount = await chatMessages.count();
    if (isIdle && (observedBusy || messageCount >= messageCountBeforeSend + 2)) {
      await page.waitForTimeout(500);
      if (await expected.isVisible()) break;
      const finalMessage = messageCount > 0
        ? (await chatMessages.nth(messageCount - 1).innerText()).trim().slice(0, 500)
        : '';
      throw new Error(
        `Chat run completed without expected output "${expectedText}".${finalMessage ? ` Final message: ${finalMessage}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await expect(expected).toBeVisible({ timeout: Math.max(1, deadline - Date.now()) });
  await expect(sendButton).toHaveAttribute('title', /Send|发送/iu, { timeout: 60_000 });
  return Date.now() - startedAt;
}

async function waitForChatFailure(page: Page, expectedText?: string, timeoutMs = 120_000): Promise<string> {
  const runError = page.getByTestId('chat-run-error');
  const transcriptFailure = page.getByText(/Agent failed before reply:/iu).last();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await runError.isVisible()
      ? await runError.innerText()
      : await transcriptFailure.isVisible()
        ? await transcriptFailure.innerText()
        : '';
    if (candidate) {
      if (expectedText && !candidate.includes(expectedText)) {
        throw new Error(`Chat failed with an unexpected error: ${candidate}`);
      }
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/iu, { timeout: 60_000 });
      return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chat did not reach a failure state within ${timeoutMs}ms.`);
}

function providerRequestCount(provider: DeterministicOpenAiServer | null, scenario: string): number {
  return provider?.requests.filter((request) => request.scenario === scenario).length ?? 0;
}

async function waitForProviderRequestCount(
  provider: DeterministicOpenAiServer | null,
  scenario: string,
  minimum: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = providerRequestCount(provider, scenario);
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Provider did not receive ${minimum} ${scenario} request(s) within ${timeoutMs}ms.`);
}

async function createHostTask(
  page: Page,
  kind: string,
  title: string,
  input: unknown,
  suffix: string,
): Promise<string> {
  const sessionKey = 'agent:main:main';
  const response = await hostApiJson<{ success: boolean; task: HostTask }>(page, '/api/task-bridge/tasks', 'POST', {
    kind,
    title,
    input,
    completion: { mode: 'internal' },
    correlation: {
      sessionKey,
      runId: `run-${runId}-${suffix}`,
      toolCallId: `tool-${runId}-${suffix}`,
      idempotencyKey: `idem-${runId}-${suffix}`,
    },
  });
  const taskId = response.task?.taskId;
  if (!taskId) throw new Error(`Host task ${kind} did not return a taskId.`);
  return taskId;
}

async function waitForHostTask(page: Page, taskId: string, timeoutMs = 180_000): Promise<HostTask> {
  const deadline = Date.now() + timeoutMs;
  let last: HostTask | null = null;
  while (Date.now() < deadline) {
    const response = await hostApiJson<{ tasks: HostTask[] }>(
      page,
      '/api/task-bridge/tasks?sessionKey=agent%3Amain%3Amain&activeOnly=false',
    );
    last = response.tasks.find((task) => task.taskId === taskId) ?? null;
    if (last && ['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost'].includes(last.status || '')) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Host task ${taskId} timed out. Last=${JSON.stringify(last)}`);
}

async function waitForCronDelivery(
  page: Page,
  jobId: string,
  timeoutMs = 10 * 60_000,
): Promise<{ success?: boolean; delivered?: boolean; deliveryStatus?: string; deliveryError?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastRun: { success?: boolean; delivered?: boolean; deliveryStatus?: string; deliveryError?: string } | undefined;
  while (Date.now() < deadline) {
    const jobs = await hostApiJson<Array<{
      id: string;
      lastRun?: { success?: boolean; delivered?: boolean; deliveryStatus?: string; deliveryError?: string };
    }>>(page, '/api/cron/jobs');
    lastRun = jobs.find((job) => job.id === jobId)?.lastRun;
    if (lastRun?.delivered === true || ['delivered', 'sent'].includes(lastRun?.deliveryStatus || '')) return lastRun;
    if (lastRun && lastRun.success === false) {
      throw new Error(`External delivery failed: ${lastRun.deliveryError || lastRun.deliveryStatus || 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`External delivery timed out. Last=${JSON.stringify(lastRun)}`);
}

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore cleanup failure.
      }
      reject(new Error('Duplicate UClaw process did not exit within the single-instance timeout.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function runLiveRegression(runner: ScenarioRunner): Promise<void> {
  let context: PackagedAppContext | null = null;
  runner.setPageProvider(() => context?.page ?? null);
  const gatewayPort = await allocatePort();
  const hostApiPort = await allocatePort();
  const osHome = path.join(sandboxRoot, 'live-os-home');
  await seedGatewaySettings(appRoot, gatewayPort);

  await runner.run('live.startup', 'start managed package with the supplied isolated profile', async () => {
    context = await launchPackagedApp({ appRoot, portableRoot: appRoot, osHome, gatewayPort, hostApiPort, managed: true });
    const setupVisible = await context.page.getByTestId('setup-page').isVisible().catch(() => false);
    if (!setupVisible) await expect(context.page.getByTestId('main-layout')).toBeVisible({ timeout: 120_000 });
    return { startupMs: context.startupMs, setupVisible, loginViaStdin: liveLoginStdin };
  });

  await runner.run('live.auth.login', 'authenticate the isolated managed test profile without persisting credentials in reports', async () => {
    const current = contextOrThrow(context);
    let login: Record<string, unknown> | null = null;
    if (liveLoginStdin) {
      const credentials = await readLiveLoginCredentials();
      try {
        login = await loginManagedAccount(current.hostApiPort, credentials);
      } finally {
        credentials.username = '';
        credentials.password = '';
      }
      await current.page.reload({ waitUntil: 'domcontentloaded' });
    }
    await expect(current.page.getByTestId('main-layout')).toBeVisible({ timeout: 180_000 });
    await expect(current.page.getByTestId('setup-page')).toHaveCount(0);
    const gateway = await waitForGatewayReady(current.page, 240_000);
    return { login, gateway: gateway.state };
  });

  await runner.run('live.managed.contract', 'verify managed Responses and media runtime configuration without reading secret values', async () => {
    const configPath = path.join(appRoot, 'UClawData', 'openclaw-home', '.openclaw', 'openclaw.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const agents = config.agents && typeof config.agents === 'object' ? config.agents as Record<string, unknown> : {};
    const defaults = agents.defaults && typeof agents.defaults === 'object' ? agents.defaults as Record<string, unknown> : {};
    const model = defaults.model && typeof defaults.model === 'object' ? defaults.model as Record<string, unknown> : {};
    const image = defaults.imageGenerationModel && typeof defaults.imageGenerationModel === 'object'
      ? defaults.imageGenerationModel as Record<string, unknown>
      : {};
    const video = defaults.videoGenerationModel && typeof defaults.videoGenerationModel === 'object'
      ? defaults.videoGenerationModel as Record<string, unknown>
      : {};
    const plugins = config.plugins && typeof config.plugins === 'object' ? config.plugins as Record<string, unknown> : {};
    const allow = Array.isArray(plugins.allow) ? plugins.allow.filter((value): value is string => typeof value === 'string') : [];
    expect(model.primary).toBe('openai/smart-latest');
    expect(image.primary).toBeTruthy();
    expect(video.primary).toBeTruthy();
    expect(allow).toEqual(expect.arrayContaining(['clawx-openai-image', 'openai', 'uclaw-task-bridge']));
    return {
      defaultModel: model.primary,
      thinking: defaults.thinkingDefault,
      reasoning: defaults.reasoningDefault,
      imageModel: image.primary,
      videoModel: video.primary,
      plugins: allow,
    };
  });

  await runner.run('live.account.status', 'read managed account, activation, and relay readiness using sanitized fields', async () => {
    const page = contextOrThrow(context).page;
    const local = await hostApiJson<Record<string, unknown>>(page, '/api/junfeiai/status/local');
    const remote = await hostApiJson<Record<string, unknown>>(page, '/api/junfeiai/status');
    expect(local.authValid === true || remote.authValid === true).toBe(true);
    expect(local.hasRelayToken === true || remote.hasRelayToken === true).toBe(true);
    expect(remote.activationRequired).not.toBe(true);
    return {
      authValid: local.authValid === true || remote.authValid === true,
      hasRelayToken: local.hasRelayToken === true || remote.hasRelayToken === true,
      deviceActivated: local.deviceActivated === true || remote.deviceActivated === true,
      activationRequired: remote.activationRequired === true,
    };
  });

  await runner.run('live.billing.read-only', 'read recharge overview and order history without creating or paying an order', async () => {
    const page = contextOrThrow(context).page;
    const overview = await hostApiJson<Record<string, unknown>>(page, '/api/junfeiai/topup/overview');
    const orders = await hostApiJson<unknown>(page, '/api/junfeiai/topup/orders?page=1&pageSize=20');
    const orderRecord = orders && typeof orders === 'object' && !Array.isArray(orders) ? orders as Record<string, unknown> : {};
    const rows = Array.isArray(orders)
      ? orders
      : Array.isArray(orderRecord.items)
        ? orderRecord.items
        : Array.isArray(orderRecord.orders)
          ? orderRecord.orders
          : Array.isArray(orderRecord.data)
            ? orderRecord.data
            : [];
    return {
      overviewAvailable: Object.keys(overview).length > 0,
      orderHistoryAvailable: Array.isArray(rows),
      orderCount: rows.length,
      paymentAttempted: false,
    };
  });

  await runner.run('live.responses.text', 'send one real managed Responses turn', async () => {
    const page = contextOrThrow(context).page;
    await startNewChat(page);
    return { latencyMs: await sendChat(
      page,
      `[UCLAW LIVE REGRESSION ${runId}] 请只回复 UCLAW_LIVE_TEXT_OK`,
      'UCLAW_LIVE_TEXT_OK',
      300_000,
    ) };
  });

  await runner.run('live.media.image', 'generate and render one real managed image', async () => {
    const page = contextOrThrow(context).page;
    await startNewChat(page);
    await page.getByTestId('chat-composer-mode-image').click();
    await page.getByTestId('chat-composer-input').fill(`[UCLAW LIVE REGRESSION ${runId}] 生成一张白底红色正方形测试图`);
    await page.getByTestId('chat-composer-send').click();
    await expect(page.getByTestId('chat-image-preview-card')).toBeVisible({ timeout: 10 * 60_000 });
    await expect(page.getByTestId('chat-image-generating-indicator')).toHaveCount(0, { timeout: 60_000 });
  });

  await runner.run('live.media.video', 'generate and render one real managed video', async () => {
    const page = contextOrThrow(context).page;
    await startNewChat(page);
    await page.getByTestId('chat-composer-mode-video').click();
    await page.getByTestId('chat-video-duration').selectOption({ index: 0 });
    await page.getByTestId('chat-composer-input').fill(`[UCLAW LIVE REGRESSION ${runId}] 生成一个最短时长的纯色测试视频`);
    await page.getByTestId('chat-composer-send').click();
    await expect(page.locator('video')).toBeVisible({ timeout: 20 * 60_000 });
    await expect(page.getByTestId('chat-video-generating-indicator')).toHaveCount(0, { timeout: 60_000 });
  });

  await runner.run('live.channels.status', 'probe configured external channel status without sending', async () => {
    const page = contextOrThrow(context).page;
    await page.getByTestId('sidebar-nav-channels').click();
    await expect(page.getByTestId('channels-page')).toBeVisible();
    const health = await hostApiJson<unknown>(page, '/api/gateway/health?probe=1');
    return { health: Boolean(health), externalDeliveryAllowed: allowExternalDelivery };
  });

  await runner.run(
    'live.channels.delivery',
    'deliver an external channel test message',
    async () => {
      const page = contextOrThrow(context).page;
      if (!externalDelivery.channel || !externalDelivery.accountId || !externalDelivery.target) {
        throw new Error('External delivery was enabled without a complete dedicated destination contract.');
      }
      const name = `UClaw live delivery ${runId}`;
      const created = await hostApiJson<Record<string, unknown>>(page, '/api/cron/jobs', 'POST', {
        name,
        message: `[UCLAW LIVE REGRESSION ${runId}] Reply with UCLAW_LIVE_DELIVERY_OK only.`,
        schedule: '0 0 1 1 *',
        enabled: true,
        agentId: 'main',
        delivery: {
          mode: 'announce',
          channel: externalDelivery.channel,
          accountId: externalDelivery.accountId,
          to: externalDelivery.target,
        },
      });
      let jobId = typeof created.id === 'string' ? created.id : '';
      const jobs = await hostApiJson<Array<{ id: string; name: string }>>(page, '/api/cron/jobs');
      jobId ||= jobs.find((job) => job.name === name)?.id || '';
      expect(jobId).toBeTruthy();
      try {
        await hostApiJson(page, '/api/cron/trigger', 'POST', { id: jobId });
        const lastRun = await waitForCronDelivery(page, jobId);
        expect(lastRun.success).toBe(true);
        return {
          channel: externalDelivery.channel,
          jobId,
          delivered: lastRun.delivered,
          deliveryStatus: lastRun.deliveryStatus,
        };
      } finally {
        await rawHostApi(page, `/api/cron/jobs/${encodeURIComponent(jobId)}`, 'DELETE');
      }
    },
    { skip: allowExternalDelivery ? undefined : 'Pass --allow-external-delivery only with a dedicated test destination.' },
  );

  await closePackagedApp(context);
  context = null;
}

test('runs the packaged UClaw regression matrix', async () => {
  test.setTimeout(30 * 60_000);
  const runner = new ScenarioRunner();
  let context: PackagedAppContext | null = null;
  let provider: DeterministicOpenAiServer | null = null;
  let fallbackProvider: DeterministicOpenAiServer | null = null;
  const processOutputs: string[][] = [];
  runner.setPageProvider(() => context?.page ?? null);

  const rememberContext = (launched: PackagedAppContext): PackagedAppContext => {
    processOutputs.push(launched.output);
    return launched;
  };

  try {
    await runner.run('package.identity', 'validate packaged identity and runtime layout', async () => {
      const manifest = JSON.parse(await readFile(path.join(appRoot, 'uclaw-usb-build.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest.sourceTreeState).toBe('clean');
      expect(manifest.arch).toBe('x64');
      expect(manifest.executableMachine).toBe('0x8664');
      for (const relativePath of [
        'UClaw.exe',
        'portable.flag',
        'resources/app.asar',
        'resources/bin/node.exe',
        'resources/bin/uv.exe',
        'resources/bin/agent-browser.exe',
        'resources/bin/ffmpeg.exe',
        'resources/bin/ffprobe.exe',
        'resources/bin/ffmpeg-runtime.json',
        'resources/app.asar.unpacked/node_modules/sharp/package.json',
        'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
        'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
        'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
        'resources/openclaw/openclaw.mjs',
        'resources/openclaw-plugins/uclaw-task-bridge/package.json',
        'resources/openclaw-plugins/uclaw-video-project/package.json',
      ]) await access(path.join(appRoot, relativePath));
      return { version: manifest.appVersion, buildId: manifest.buildId, gitCommit: manifest.gitCommit };
    });

    if (profile === 'live') {
      await runLiveRegression(runner);
      return;
    }

    const gatewayPort = await allocatePort();
    const hostApiPort = await allocatePort();
    const osHome = path.join(sandboxRoot, 'os-home');
    const toolTargetPath = path.join(
      appRoot,
      'UClawData',
      'openclaw-home',
      '.openclaw',
      'workspace',
      'uclaw-regression',
      'tool-output.txt',
    );
    await mkdir(path.dirname(toolTargetPath), { recursive: true });
    await seedGatewaySettings(appRoot, gatewayPort);
    if (profile === 'full') {
      provider = new DeterministicOpenAiServer(toolTargetPath, {
        name: 'primary',
        alwaysFailScenarios: ['FALLBACK'],
      });
      fallbackProvider = new DeterministicOpenAiServer(toolTargetPath, {
        name: 'fallback',
        model: REGRESSION_FALLBACK_MODEL,
      });
      await provider.start();
      await fallbackProvider.start();
    }

    await runner.run('startup.fresh', 'launch the real packaged executable with a fresh portable profile', async () => {
      context = rememberContext(await launchPackagedApp({
        appRoot,
        portableRoot: appRoot,
        osHome,
        gatewayPort,
        hostApiPort,
        managed: false,
      }));
      await expect(context.page.getByTestId('setup-page')).toBeVisible({ timeout: 120_000 });
      await expect(context.page.getByTestId('setup-welcome-step')).toBeVisible();
      expect(context.startupMs).toBeLessThan(120_000);
      return { startupMs: context.startupMs, executable: path.join(appRoot, 'UClaw.exe') };
    });

    await runner.run('setup.persist', 'persist first-run completion in the isolated regression profile', async () => {
      const page = contextOrThrow(context).page;
      const skipButton = page.getByTestId('setup-skip-button');
      let completionMode = 'production-offline-bootstrap';
      if (await skipButton.count() > 0) {
        await skipButton.click();
        completionMode = 'development-skip-control';
      } else {
        await hostApiJson(page, '/api/settings/setupComplete', 'PUT', { value: true });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.evaluate(() => {
          window.location.hash = '#/';
        });
      }
      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('chat-page')).toBeVisible();
      return { completionMode };
    });

    await runner.run('ui.navigation', 'navigate every core product page in the packaged renderer', async () => {
      const page = contextOrThrow(context).page;
      const pages: Array<{ navId: string; pageId?: string; route?: RegExp }> = [
        { navId: 'sidebar-nav-models', pageId: 'models-page' },
        { navId: 'sidebar-nav-agents', pageId: 'agents-page' },
        { navId: 'sidebar-nav-channels', pageId: 'channels-page' },
        { navId: 'sidebar-nav-skills', pageId: 'skills-page' },
        { navId: 'sidebar-nav-cron', route: /#\/cron(?:[/?]|$)/u },
        { navId: 'sidebar-nav-settings', pageId: 'settings-page' },
      ];
      for (const target of pages) {
        await page.getByTestId(target.navId).click();
        if (target.pageId) await expect(page.getByTestId(target.pageId)).toBeVisible({ timeout: 60_000 });
        if (target.route) {
          await expect(page).toHaveURL(target.route, { timeout: 60_000 });
          await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        }
      }
      await startNewChat(page);
      return { pages: pages.map((target) => target.pageId || target.route?.source) };
    });

    await runner.run('gateway.ready', 'wait for packaged Gateway process and core RPC readiness', async () => {
      const status = await waitForGatewayReady(contextOrThrow(context).page, 180_000);
      expect(status.port).toBe(gatewayPort);
      return status;
    });

    await runner.run('gateway.stop-start', 'stop and restart the real packaged Gateway', async () => {
      const page = contextOrThrow(context).page;
      await hostApiJson(page, '/api/gateway/stop', 'POST', {});
      await waitForGateway(page, (status) => status.state === 'stopped', 60_000);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await hostApiJson(page, '/api/gateway/start', 'POST', {});
      return await waitForGatewayReady(page, 180_000);
    });

    await runner.run('gateway.port-conflict', 'surface a foreign port owner and recover after release', async () => {
      const page = contextOrThrow(context).page;
      await hostApiJson(page, '/api/gateway/stop', 'POST', {});
      await waitForGateway(page, (status) => status.state === 'stopped', 60_000);
      const blocker = await listenOnPort(gatewayPort);
      try {
        const failedStart = await rawHostApi(page, '/api/gateway/start', 'POST', {});
        expect(failedStart.ok).toBe(false);
        await expect(page.getByTestId('main-layout')).toBeVisible();
      } finally {
        await closeServer(blocker);
      }
      await hostApiJson(page, '/api/gateway/start', 'POST', {});
      return await waitForGatewayReady(page, 180_000);
    });

    await runner.run(
      'provider.local-validation',
      'reject an invalid key then add a deterministic local Provider through the real UI',
      async () => {
        const page = contextOrThrow(context).page;
        const localProvider = provider;
        if (!localProvider) throw new Error('Deterministic provider was not started.');
        const beforeSwitch = await waitForGatewayReady(page, 180_000);
        await page.getByTestId('sidebar-nav-models').click();
        await page.getByTestId('providers-add-button').click();
        await page.getByTestId('add-provider-type-custom').click();
        await page.getByTestId('add-provider-name-input').fill('UClaw Regression Local');
        await page.getByTestId('add-provider-base-url-input').fill(localProvider.baseUrl);
        await page.getByTestId('add-provider-model-id-input').fill(REGRESSION_MODEL);
        await page.getByTestId('add-provider-api-key-input').fill('sk-uclaw-invalid');
        await page.getByTestId('add-provider-submit-button').click();
        await expect(page.getByTestId('add-provider-validation-error')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('add-provider-dialog')).toBeVisible();
        await page.getByTestId('add-provider-api-key-input').fill(REGRESSION_API_KEY);
        await page.getByTestId('add-provider-submit-button').click();
        await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0, { timeout: 60_000 });
        const card = page.locator('[data-testid^="provider-card-"]').filter({ hasText: 'UClaw Regression Local' });
        await expect(card).toBeVisible();
        const accounts = await hostApiJson<Array<{ id: string; label: string }>>(page, '/api/provider-accounts');
        const account = accounts.find((entry) => entry.label === 'UClaw Regression Local');
        expect(account?.id).toBeTruthy();
        regressionAccountId = account!.id;
        const selected = await hostApiJson<{ accountId: string | null }>(page, '/api/provider-accounts/default');
        expect(selected.accountId).toBe(account!.id);
        const afterSwitch = await waitForGateway(page, (status) => (
          status.state === 'running'
          && status.gatewayReady !== false
          && (
            status.pid !== beforeSwitch.pid
            || Number(status.connectedAt || 0) > Number(beforeSwitch.connectedAt || 0)
          )
        ), 180_000);
        const runtimeProviderKey = `custom-${account!.id.replaceAll('-', '').slice(0, 8)}`;
        regressionModelRef = `${runtimeProviderKey}/${REGRESSION_MODEL}`;
        return {
          accountId: account!.id,
          baseUrl: localProvider.baseUrl,
          gatewayPid: afterSwitch.pid,
          modelRef: regressionModelRef,
        };
      },
      { skip: profile !== 'full' ? 'The core profile does not configure a model Provider.' : undefined },
    );

    await runner.run(
      'provider.fallback-runtime',
      'route a real model turn to a secondary Provider after the primary returns persistent errors',
      async () => {
        const page = contextOrThrow(context).page;
        const localPrimary = provider;
        const localFallback = fallbackProvider;
        if (!localPrimary || !localFallback || !regressionAccountId) {
          throw new Error('Regression Provider prerequisites are unavailable.');
        }
        fallbackAccountId = await addCustomProvider(
          page,
          'UClaw Regression Fallback',
          localFallback.baseUrl,
          REGRESSION_FALLBACK_MODEL,
        );
        await hostApiJson(page, `/api/provider-accounts/${encodeURIComponent(regressionAccountId)}`, 'PUT', {
          updates: { fallbackAccountIds: [fallbackAccountId] },
        });
        await waitForGatewayReady(page, 180_000);
        const primaryAccount = await hostApiJson<{ fallbackAccountIds?: string[] }>(
          page,
          `/api/provider-accounts/${encodeURIComponent(regressionAccountId)}`,
        );
        expect(primaryAccount.fallbackAccountIds).toContain(fallbackAccountId);
        const primaryBefore = providerRequestCount(localPrimary, 'FALLBACK');
        const fallbackBefore = providerRequestCount(localFallback, 'FALLBACK');
        await startNewChat(page);
        const latencyMs = await sendChat(
          page,
          '[REGRESSION:FALLBACK] force the primary model to fail and use its configured fallback',
          'UCLAW_REGRESSION_FALLBACK_OK',
          240_000,
        );
        const primaryAttempts = providerRequestCount(localPrimary, 'FALLBACK') - primaryBefore;
        const fallbackAttempts = providerRequestCount(localFallback, 'FALLBACK') - fallbackBefore;
        expect(primaryAttempts).toBeGreaterThanOrEqual(1);
        expect(fallbackAttempts).toBeGreaterThanOrEqual(1);
        return { primaryAttempts, fallbackAttempts, latencyMs, fallbackAccountId };
      },
      { skip: profile !== 'full' ? 'Requires two deterministic local Providers.' : undefined },
    );

    await runner.run(
      'provider.delete-fallback',
      'delete the fallback Provider and remove stale runtime fallback references',
      async () => {
        if (!fallbackAccountId || !regressionAccountId) throw new Error('Fallback Provider account is unavailable.');
        const page = contextOrThrow(context).page;
        await page.getByTestId('sidebar-nav-models').click();
        const card = page.getByTestId(`provider-card-${fallbackAccountId}`);
        await expect(card).toBeVisible();
        await card.hover();
        await page.getByTestId(`provider-delete-${fallbackAccountId}`).click();
        await expect(card).toHaveCount(0, { timeout: 60_000 });
        const accounts = await hostApiJson<Array<{ id: string; fallbackAccountIds?: string[] }>>(page, '/api/provider-accounts');
        expect(accounts.some((account) => account.id === fallbackAccountId)).toBe(false);
        const primaryAccount = accounts.find((account) => account.id === regressionAccountId);
        expect(primaryAccount?.fallbackAccountIds ?? []).not.toContain(fallbackAccountId);
        await waitForGatewayReady(page, 180_000);
        await startNewChat(page);
        await sendChat(page, '[REGRESSION:RECOVERY] verify the primary after fallback deletion', 'UCLAW_REGRESSION_RECOVERY_OK');
        return { deletedAccountId: fallbackAccountId, primaryAccountId: regressionAccountId };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic fallback Provider.' : undefined },
    );

    await runner.run(
      'chat.simple',
      'complete a simple real Gateway/OpenClaw/model turn',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        return { latencyMs: await sendChat(page, '[REGRESSION:SIMPLE] reply with the regression token', 'UCLAW_REGRESSION_SIMPLE_OK') };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'chat.markdown-unicode',
      'render Markdown, a table, a code block, and multilingual text',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        await sendChat(page, '[REGRESSION:MARKDOWN] render structured output', 'UCLAW_REGRESSION_MARKDOWN_OK');
        await expect(page.getByText('UCLAW_CODE_BLOCK_OK')).toBeVisible();
        await expect(page.getByText('中文 / 日本語 / Русский')).toBeVisible();
        await expect(page.locator('table')).toBeVisible();
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'chat.multi-turn',
      'preserve context across two turns in one real session',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        await sendChat(page, '[REGRESSION:MULTI_TURN] first turn', 'user_messages=1');
        await sendChat(page, '[REGRESSION:MULTI_TURN] second turn', 'user_messages=2');
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'sessions.lifecycle',
      'create, persist, rename, reload, and hard-delete a real chat session and transcript',
      async () => {
        const page = contextOrThrow(context).page;
        const beforeKeys = new Set((await listGatewaySessions(page))
          .map((session) => String(session.key ?? session.sessionKey ?? ''))
          .filter(Boolean));
        await startNewChat(page);
        await sendChat(
          page,
          '[REGRESSION:SESSION_LIFECYCLE] create a uniquely persisted session',
          'UCLAW_REGRESSION_SESSION_LIFECYCLE_OK',
        );
        let createdKey = '';
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !createdKey) {
          const sessions = await listGatewaySessions(page);
          createdKey = sessions
            .map((session) => String(session.key ?? session.sessionKey ?? ''))
            .find((key) => key.startsWith('agent:') && !beforeKeys.has(key)) ?? '';
          if (!createdKey) await page.waitForTimeout(250);
        }
        expect(createdKey).toBeTruthy();
        const transcriptPath = `/api/sessions/transcript?sessionKey=${encodeURIComponent(createdKey)}&limit=20`;
        const transcript = await hostApiJson<{ messages?: unknown[] }>(page, transcriptPath);
        expect(transcript.messages?.length ?? 0).toBeGreaterThan(0);
        const label = `QA ${runId.slice(-10)}`;
        await hostApiJson(page, '/api/sessions/rename', 'POST', { sessionKey: createdKey, label });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`sidebar-session-${createdKey}`)).toContainText(label, { timeout: 60_000 });
        await hostApiJson(page, '/api/sessions/delete', 'POST', { sessionKey: createdKey });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`sidebar-session-${createdKey}`)).toHaveCount(0, { timeout: 60_000 });
        expect((await listGatewaySessions(page)).some((session) => (
          String(session.key ?? session.sessionKey ?? '') === createdKey
        ))).toBe(false);
        const missingTranscript = await rawHostApi(page, transcriptPath);
        expect(missingTranscript.status).toBe(404);
        return { sessionKey: createdKey, transcriptMessages: transcript.messages?.length ?? 0, deleted: true };
      },
      { skip: profile !== 'full' ? 'Requires a real model turn to persist the session.' : undefined },
    );

    for (const status of [429, 500]) {
      await runner.run(
        `chat.http-${status}`,
        `retry a transient HTTP ${status} and complete the model turn`,
        async () => {
          const page = contextOrThrow(context).page;
          await startNewChat(page);
          const latencyMs = await sendChat(
            page,
            `[REGRESSION:HTTP_${status}] inject one transient provider failure`,
            `UCLAW_REGRESSION_HTTP_${status}_RECOVERED`,
          );
          const attempts = provider?.requests.filter((request) => request.scenario === `HTTP_${status}`).length ?? 0;
          expect(attempts).toBeGreaterThanOrEqual(2);
          return { attempts, latencyMs };
        },
        { skip: profile !== 'full' ? 'Requires deterministic transient-error injection.' : undefined },
      );
    }

    await runner.run(
      'chat.malformed-stream',
      'surface a malformed provider stream without leaving chat stuck',
      async () => {
        const page = contextOrThrow(context).page;
        const beforeAttempts = provider?.requests.filter((request) => request.scenario === 'MALFORMED_STREAM').length ?? 0;
        await startNewChat(page);
        await page.getByTestId('chat-composer-input').fill('[REGRESSION:MALFORMED_STREAM] inject invalid SSE');
        await page.getByTestId('chat-composer-send').click();
        const failure = await waitForChatFailure(page);
        const attempts = (provider?.requests.filter((request) => request.scenario === 'MALFORMED_STREAM').length ?? 0) - beforeAttempts;
        expect(attempts).toBeGreaterThanOrEqual(1);
        return { attempts, failure };
      },
      { skip: profile !== 'full' ? 'Requires deterministic malformed-stream injection.' : undefined },
    );

    await runner.run(
      'chat.cancel',
      'cancel a slow model turn and return the composer to idle',
      async () => {
        const page = contextOrThrow(context).page;
        const beforeAttempts = providerRequestCount(provider, 'SLOW');
        await startNewChat(page);
        await page.getByTestId('chat-composer-input').fill('[REGRESSION:SLOW] hold the response until cancelled');
        await page.getByTestId('chat-composer-send').click();
        const attempts = await waitForProviderRequestCount(provider, 'SLOW', beforeAttempts + 1) - beforeAttempts;
        await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/iu, { timeout: 30_000 });
        await page.getByTestId('chat-composer-send').click();
        await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Send|发送/iu, { timeout: 120_000 });
        expect(attempts).toBeGreaterThanOrEqual(1);
        return { attempts };
      },
      { skip: profile !== 'full' ? 'Requires deterministic slow-response injection.' : undefined },
    );

    await runner.run(
      'chat.recovery',
      'complete a healthy turn after failures and cancellation',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        return { latencyMs: await sendChat(page, '[REGRESSION:RECOVERY] verify recovery', 'UCLAW_REGRESSION_RECOVERY_OK') };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'tools.file-write',
      'execute the real OpenClaw file-writing tool and verify its side effect',
      async () => {
        const page = contextOrThrow(context).page;
        await rm(toolTargetPath, { force: true });
        await startNewChat(page);
        await sendChat(page, '[REGRESSION:TOOL_WRITE] write the requested local evidence file', 'UCLAW_REGRESSION_TOOL_WRITE_OK', 180_000);
        expect(await readFile(toolTargetPath, 'utf8')).toBe('UCLAW_REGRESSION_TOOL_FILE_OK\n');
        return { file: toolTargetPath };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'tools.browser',
      'open and snapshot a local page through the real OpenClaw browser tool',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        await sendChat(page, '[REGRESSION:BROWSER] open and inspect the local browser fixture', 'UCLAW_REGRESSION_BROWSER_OK', 240_000);
        const browserCalls = provider?.requests.filter((request) => request.scenario === 'BROWSER').length ?? 0;
        expect(browserCalls).toBeGreaterThanOrEqual(3);
        return { providerTurns: browserCalls };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider and an available managed browser.' : undefined },
    );

    const officeArtifacts = [
      {
        id: 'artifacts.docx',
        title: 'generate a real DOCX through the packaged local-artifacts tool',
        scenario: 'ARTIFACT_DOCX',
        fileName: 'uclaw-regression.docx',
        entry: /^word\/document\.xml$/u,
        content: 'UCLAW_DOCX_CONTENT_OK',
      },
      {
        id: 'artifacts.xlsx',
        title: 'generate a real XLSX through the packaged local-artifacts tool',
        scenario: 'ARTIFACT_XLSX',
        fileName: 'uclaw-regression.xlsx',
        entry: /^xl\/worksheets\/sheet1\.xml$/u,
        content: 'UCLAW_XLSX_CONTENT_OK',
      },
      {
        id: 'artifacts.pptx',
        title: 'generate a real PPTX through the packaged local-artifacts tool',
        scenario: 'ARTIFACT_PPTX',
        fileName: 'uclaw-regression.pptx',
        entry: /^ppt\/slides\/slide1\.xml$/u,
        content: 'UCLAW_PPTX_CONTENT_OK',
      },
    ] as const;
    for (const artifact of officeArtifacts) {
      await runner.run(
        artifact.id,
        artifact.title,
        async () => {
          const page = contextOrThrow(context).page;
          const filePath = path.join(
            appRoot,
            'UClawData',
            'openclaw-home',
            'workspace',
            'uclaw-regression',
            'office',
            artifact.fileName,
          );
          await rm(filePath, { force: true });
          await startNewChat(page);
          await sendChat(
            page,
            `[REGRESSION:${artifact.scenario}] create the requested Office artifact`,
            `UCLAW_REGRESSION_${artifact.scenario}_OK`,
            240_000,
          );
          await expect(page.getByTestId('chat-generated-file').filter({ hasText: artifact.fileName })).toBeVisible({ timeout: 60_000 });
          const packageEvidence = await verifyOfficePackage(filePath, artifact.entry, artifact.content);
          const evidenceDir = path.join(reportDir, 'evidence', 'office');
          await mkdir(evidenceDir, { recursive: true });
          const evidenceFile = path.join(evidenceDir, artifact.fileName);
          await writeFile(evidenceFile, await readFile(filePath));
          const screenshot = path.join(evidenceDir, `${artifact.id.replace('artifacts.', '')}-ui.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          return {
            file: path.relative(reportDir, evidenceFile),
            screenshot: path.relative(reportDir, screenshot),
            ...packageEvidence,
          };
        },
        { skip: profile !== 'full' ? 'Requires the deterministic local Provider and packaged artifact plugin.' : undefined },
      );
    }

    await runner.run(
      'chat.http-401',
      'surface HTTP 401 without leaving chat stuck',
      async () => {
        const page = contextOrThrow(context).page;
        const beforeAttempts = provider?.requests.filter((request) => request.scenario === 'HTTP_401').length ?? 0;
        await startNewChat(page);
        await page.getByTestId('chat-composer-input').fill('[REGRESSION:HTTP_401] inject provider authentication failure');
        await page.getByTestId('chat-composer-send').click();
        const failure = await waitForChatFailure(page, 'UCLAW_REGRESSION_HTTP_401');
        const attempts = (provider?.requests.filter((request) => request.scenario === 'HTTP_401').length ?? 0) - beforeAttempts;
        expect(attempts).toBeGreaterThanOrEqual(1);
        return { attempts, failure };
      },
      { skip: profile !== 'full' ? 'Requires deterministic authentication-error injection.' : undefined },
    );

    await runner.run(
      'provider.auth-revalidate',
      'validate and replace Provider credentials after an authentication failure',
      async () => {
        if (!regressionAccountId) throw new Error('Regression Provider account ID is unavailable.');
        const page = contextOrThrow(context).page;
        await page.getByTestId('sidebar-nav-models').click();
        const card = page.getByTestId(`provider-card-${regressionAccountId}`);
        await expect(card).toBeVisible();
        await card.hover();
        await page.getByTestId(`provider-edit-${regressionAccountId}`).click();
        const keyInput = page.getByTestId(`provider-edit-key-input-${regressionAccountId}`);
        await keyInput.fill(REGRESSION_API_KEY);
        await page.getByTestId(`provider-edit-save-${regressionAccountId}`).click();
        await expect(keyInput).toHaveCount(0, { timeout: 60_000 });
        await waitForGatewayReady(page, 180_000);
        return { accountId: regressionAccountId };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'gateway.auth-reset',
      'restart the real Gateway after replacing Provider credentials',
      async () => {
        const page = contextOrThrow(context).page;
        const beforeRestart = await waitForGatewayReady(page, 180_000);
        await hostApiJson(page, '/api/gateway/stop', 'POST', {});
        await waitForGateway(page, (status) => status.state === 'stopped', 60_000);
        await hostApiJson(page, '/api/gateway/start', 'POST', {});
        const afterRestart = await waitForGatewayReady(page, 180_000);
        expect(
          afterRestart.pid !== beforeRestart.pid
          || Number(afterRestart.connectedAt || 0) > Number(beforeRestart.connectedAt || 0),
        ).toBe(true);
        return { beforePid: beforeRestart.pid, afterPid: afterRestart.pid };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run(
      'chat.auth-recovery',
      'reselect the local model and complete a healthy turn after authentication recovery',
      async () => {
        const page = contextOrThrow(context).page;
        await startNewChat(page);
        return { latencyMs: await sendChat(page, '[REGRESSION:RECOVERY] verify authentication recovery', 'UCLAW_REGRESSION_RECOVERY_OK') };
      },
      { skip: profile !== 'full' ? 'Requires the deterministic local Provider.' : undefined },
    );

    await runner.run('agents.crud', 'create, rename, display, and delete an Agent through real Host routes', async () => {
      const page = contextOrThrow(context).page;
      const created = await hostApiJson<{ createdAgentId: string }>(page, '/api/agents', 'POST', {
        name: 'Regression Analyst',
        inheritWorkspace: true,
        profile: { responsibility: 'Packaged regression verification' },
      });
      expect(created.createdAgentId).toBeTruthy();
      await page.getByTestId('sidebar-nav-agents').click();
      await page.reload();
      await expect(page.getByTestId(`agent-card-${created.createdAgentId}`)).toBeVisible({ timeout: 60_000 });
      await hostApiJson(page, `/api/agents/${encodeURIComponent(created.createdAgentId)}`, 'PUT', { name: 'Regression Renamed' });
      const agents = await hostApiJson<{ agents: Array<{ id: string; name: string }> }>(page, '/api/agents');
      expect(agents.agents.find((agent) => agent.id === created.createdAgentId)?.name).toBe('Regression Renamed');
      await hostApiJson(page, `/api/agents/${encodeURIComponent(created.createdAgentId)}`, 'DELETE');
      const afterDelete = await hostApiJson<{ agents: Array<{ id: string }> }>(page, '/api/agents');
      expect(afterDelete.agents.some((agent) => agent.id === created.createdAgentId)).toBe(false);
      await waitForGatewayReady(page, 180_000);
      return { agentId: created.createdAgentId };
    });

    await runner.run('cron.crud', 'create, disable, reject invalid, and delete a Cron job', async () => {
      const page = contextOrThrow(context).page;
      const name = `UClaw regression ${runId}`;
      const created = await hostApiJson<Record<string, unknown>>(page, '/api/cron/jobs', 'POST', {
        name,
        message: '[REGRESSION:CRON] scheduled regression probe',
        schedule: '0 0 1 1 *',
        enabled: true,
        agentId: 'main',
        delivery: { mode: 'none' },
      });
      let jobId = typeof created.id === 'string' ? created.id : '';
      const jobs = await hostApiJson<Array<{ id: string; name: string; enabled: boolean }>>(page, '/api/cron/jobs');
      jobId ||= jobs.find((job) => job.name === name)?.id || '';
      expect(jobId).toBeTruthy();
      await hostApiJson(page, '/api/cron/toggle', 'POST', { id: jobId, enabled: false });
      const invalid = await rawHostApi(page, '/api/cron/jobs', 'POST', {
        name: `${name} invalid`,
        message: 'invalid',
        schedule: 'not-a-cron-expression',
        enabled: false,
        delivery: { mode: 'none' },
      });
      expect(invalid.ok).toBe(false);
      await hostApiJson(page, `/api/cron/jobs/${encodeURIComponent(jobId)}`, 'DELETE');
      const afterDelete = await hostApiJson<Array<{ id: string }>>(page, '/api/cron/jobs');
      expect(afterDelete.some((job) => job.id === jobId)).toBe(false);
      return { jobId };
    });

    await runner.run('skills.local-config', 'discover packaged Skills, persist enablement, and expose enabled quick access', async () => {
      const page = contextOrThrow(context).page;
      const initial = await hostApiJson<{ skills?: Array<{
        id?: string;
        name?: string;
        enabled?: boolean;
        isCore?: boolean;
        source?: string;
      }> }>(page, '/api/skills/local');
      const skills = initial.skills ?? [];
      expect(skills.length).toBeGreaterThan(0);
      const target = skills.find((skill) => skill.id && !skill.isCore) ?? skills.find((skill) => skill.id);
      if (!target?.id) throw new Error('No configurable packaged Skill was discovered.');
      const disabled = await hostApiJson<{ success?: boolean }>(page, '/api/skills/config', 'PUT', {
        skillKey: target.id,
        enabled: false,
      });
      expect(disabled.success).toBe(true);
      const disabledConfigs = await hostApiJson<Record<string, { enabled?: boolean }>>(page, '/api/skills/configs');
      expect(disabledConfigs[target.id]?.enabled).toBe(false);
      const afterDisable = await hostApiJson<{ skills?: Array<{ id?: string; enabled?: boolean }> }>(page, '/api/skills/local');
      expect(afterDisable.skills?.find((skill) => skill.id === target.id)?.enabled).toBe(false);
      const restored = await hostApiJson<{ success?: boolean }>(page, '/api/skills/config', 'PUT', {
        skillKey: target.id,
        enabled: true,
      });
      expect(restored.success).toBe(true);
      const quickAccess = await hostApiJson<{ skills?: Array<{ id?: string; name?: string; slug?: string }> }>(
        page,
        '/api/skills/quick-access',
        'POST',
        {},
      );
      expect(quickAccess.skills?.some((skill) => (
        skill.id === target.id || skill.slug === target.id || skill.name === target.name
      ))).toBe(true);
      await page.getByTestId('sidebar-nav-skills').click();
      await expect(page.getByTestId('skills-page')).toBeVisible();
      return {
        discovered: skills.length,
        configuredSkill: target.id,
        source: target.source,
        quickAccessCount: quickAccess.skills?.length ?? 0,
        restored: true,
      };
    });

    await runner.run('skills.marketplace-capability', 'probe packaged Skill marketplace capability without installing from the network', async () => {
      const page = contextOrThrow(context).page;
      const response = await hostApiJson<{ success?: boolean; capability?: Record<string, unknown> }>(
        page,
        '/api/skills/marketplace/capability',
      );
      expect(response.success).toBe(true);
      return {
        capabilityAvailable: Boolean(response.capability),
        networkInstallAttempted: false,
      };
    });

    let renderedVideoPath = '';
    let composedVideoPath = '';
    await runner.run(
      'media.timeline',
      'render and verify a real local image timeline with packaged FFmpeg',
      async () => {
        const page = contextOrThrow(context).page;
        const capabilities = await hostApiJson<{ capabilities: Array<{ kind: string; availability: string }> }>(page, '/api/task-bridge/capabilities');
        expect(capabilities.capabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'local.video.timeline.render', availability: 'available' }),
          expect.objectContaining({ kind: 'local.video.compose', availability: 'available' }),
          expect.objectContaining({ kind: 'local.video.shot.qa', availability: 'available' }),
        ]));
        const mediaDir = path.join(appRoot, 'UClawData', 'openclaw-home', '.openclaw', 'media', 'regression');
        await mkdir(mediaDir, { recursive: true });
        const red = path.join(mediaDir, 'red.png');
        const blue = path.join(mediaDir, 'blue.png');
        await sharp({ create: { width: 320, height: 240, channels: 3, background: '#d7263d' } }).png().toFile(red);
        await sharp({ create: { width: 320, height: 240, channels: 3, background: '#1976d2' } }).png().toFile(blue);
        const taskId = await createHostTask(page, 'local.video.timeline.render', 'Regression timeline', {
          scenes: [
            { sourcePath: red, kind: 'image', durationSeconds: 1, motion: 'none', transition: 'cut', caption: 'red' },
            { sourcePath: blue, kind: 'image', durationSeconds: 1, motion: 'none', transition: 'cut', caption: 'blue' },
          ],
          filename: 'uclaw-regression-timeline.mp4',
          targetDurationSeconds: 2,
          width: 320,
          height: 240,
          fps: 12,
          keepOriginalAudio: false,
        }, 'timeline');
        const task = await waitForHostTask(page, taskId, 240_000);
        expect(task.status, task.error).toBe('succeeded');
        expect(task.verifications).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'passed', kind: 'media.metadata' })]));
        renderedVideoPath = task.artifacts?.find((artifact) => artifact.kind === 'video')?.filePath || '';
        expect(renderedVideoPath).toBeTruthy();
        expect((await stat(renderedVideoPath)).size).toBeGreaterThan(0);
        return { taskId, output: renderedVideoPath };
      },
      { skip: profile !== 'full' ? 'The core profile checks binaries but does not execute media work.' : undefined },
    );

    await runner.run(
      'media.compose',
      'compose two real segments and verify the final MP4',
      async () => {
        const page = contextOrThrow(context).page;
        if (!renderedVideoPath) throw new Error('Timeline output is unavailable.');
        const taskId = await createHostTask(page, 'local.video.compose', 'Regression composition', {
          segments: [renderedVideoPath, renderedVideoPath],
          filename: 'uclaw-regression-composed.mp4',
          targetDurationSeconds: 4,
          width: 320,
          height: 240,
          keepOriginalAudio: false,
        }, 'compose');
        const task = await waitForHostTask(page, taskId, 240_000);
        expect(task.status, task.error).toBe('succeeded');
        composedVideoPath = task.artifacts?.find((artifact) => artifact.kind === 'video')?.filePath || '';
        expect((await stat(composedVideoPath)).size).toBeGreaterThan(0);
        return { taskId, output: composedVideoPath };
      },
      { skip: profile !== 'full' ? 'The core profile does not execute media work.' : undefined },
    );

    await runner.run(
      'media.shot-qa',
      'run real FFprobe/frame/contact-sheet QA on the composed video',
      async () => {
        const page = contextOrThrow(context).page;
        if (!composedVideoPath) throw new Error('Composed video output is unavailable.');
        const taskId = await createHostTask(page, 'local.video.shot.qa', 'Regression shot QA', {
          sourcePath: composedVideoPath,
          expectedDurationSeconds: 4,
          durationToleranceSeconds: 1.5,
          expectedWidth: 320,
          expectedHeight: 240,
          requireAudio: false,
          includeSourceArtifact: true,
          sampleFrameCount: 3,
        }, 'shot-qa');
        const task = await waitForHostTask(page, taskId, 240_000);
        expect(task.status, task.error).toBe('succeeded');
        expect(task.verifications).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'passed', kind: 'media.shot.qa' })]));
        return { taskId, artifactCount: task.artifacts?.length || 0 };
      },
      { skip: profile !== 'full' ? 'The core profile does not execute media work.' : undefined },
    );

    await runner.run(
      'media.invalid-source',
      'fail closed when a local media task references a missing source',
      async () => {
        const page = contextOrThrow(context).page;
        const missing = path.join(appRoot, 'UClawData', 'openclaw-home', '.openclaw', 'media', 'regression', 'missing.png');
        const taskId = await createHostTask(page, 'local.video.timeline.render', 'Regression invalid source', {
          scenes: [{ sourcePath: missing, kind: 'image', durationSeconds: 1 }],
          filename: 'must-not-exist.mp4',
          width: 320,
          height: 240,
          fps: 12,
        }, 'invalid-media');
        const task = await waitForHostTask(page, taskId, 120_000);
        expect(['failed', 'blocked']).toContain(task.status);
        expect(task.artifacts?.length || 0).toBe(0);
        return { taskId, status: task.status, error: task.error };
      },
      { skip: profile !== 'full' ? 'The core profile does not execute media work.' : undefined },
    );

    await runner.run('media.controls', 'expose image and video modes with bounded controls', async () => {
      const page = contextOrThrow(context).page;
      await startNewChat(page);
      await page.getByTestId('chat-composer-mode-image').click();
      await expect(page.getByTestId('chat-image-options')).toBeVisible();
      await page.getByTestId('chat-composer-mode-video').click();
      await expect(page.getByTestId('chat-video-options')).toBeVisible();
      await expect(page.getByTestId('chat-video-size')).toBeVisible();
      await expect(page.getByTestId('chat-video-duration')).toBeVisible();
    });

    await runner.run('diagnostics.logs', 'read packaged runtime logs and verify credential redaction', async () => {
      const page = contextOrThrow(context).page;
      const logDir = await hostApiJson<{ dir?: string | null }>(page, '/api/logs/dir');
      const logFiles = await hostApiJson<{ files?: unknown[] }>(page, '/api/logs/files');
      const logs = await hostApiJson<{ content?: string }>(page, '/api/logs?tailLines=500');
      const content = logs.content ?? '';
      expect(logDir.dir).toBeTruthy();
      expect(path.resolve(logDir.dir!)).toBe(path.resolve(osHome, 'AppData', 'Local', 'UClawRuntime', 'logs'));
      expect(content).not.toContain(REGRESSION_API_KEY);
      expect(content).not.toMatch(/authorization\s*[:=]\s*bearer\s+(?!\[REDACTED\])\S+/iu);
      return {
        logDirectory: logDir.dir,
        listedFiles: logFiles.files?.length ?? 0,
        inspectedChars: content.length,
      };
    });

    await runner.run('diagnostics.doctor', 'run the bundled OpenClaw Doctor through the real Host API', async () => {
      const page = contextOrThrow(context).page;
      const result = await hostApiJson<{
        success?: boolean;
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
        command?: string;
        cwd?: string;
        durationMs?: number;
        timedOut?: boolean;
        error?: string;
      }>(page, '/api/app/openclaw-doctor', 'POST', { mode: 'diagnose' });
      expect(result.command).toBe('openclaw doctor');
      expect(result.timedOut).not.toBe(true);
      expect(typeof result.exitCode).toBe('number');
      expect(result.success, result.error || result.stderr).toBe(true);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(output).not.toContain(REGRESSION_API_KEY);
      return {
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        workingDirectory: result.cwd,
        outputChars: output.length,
      };
    });

    await runner.run('diagnostics.control-ui', 'verify Control UI reachability while stripping its one-time token before reporting', async () => {
      const page = contextOrThrow(context).page;
      const info = await sanitizedControlUiInfo(page);
      expect(info.success).toBe(true);
      expect(info.tokenInFragment).toBe(true);
      expect(info.sanitizedUrl).not.toMatch(/[?&#](?:token|key|signature|sig)=/iu);
      const response = await fetch(info.sanitizedUrl, { redirect: 'follow' });
      expect(response.ok).toBe(true);
      const html = await response.text();
      expect(html.length).toBeGreaterThan(100);
      return {
        port: info.port,
        tokenTransport: 'fragment-stripped-before-report',
        sanitizedUrl: info.sanitizedUrl,
        htmlBytes: Buffer.byteLength(html),
      };
    });

    await runner.run(
      'desktop.observe',
      'capture and verify one managed desktop screenshot',
      async () => {
        const page = contextOrThrow(context).page;
        const taskId = await createHostTask(page, 'desktop.observe', 'Regression desktop observation', {}, 'desktop');
        const task = await waitForHostTask(page, taskId, 120_000);
        expect(task.status, task.error).toBe('succeeded');
        return { taskId, artifacts: task.artifacts?.length || 0 };
      },
      { skip: allowDesktopCapture ? undefined : 'Desktop capture is privacy-sensitive; pass --allow-desktop-capture explicitly.' },
    );

    await runner.run('process.single-instance', 'reject a duplicate packaged process without disturbing the active app', async () => {
      const current = contextOrThrow(context);
      const child = spawn(path.join(appRoot, 'UClaw.exe'), [], {
        cwd: appRoot,
        env: current.env,
        windowsHide: true,
        stdio: 'ignore',
      });
      const exitCode = await waitForChildExit(child, 20_000);
      await expect(current.page.getByTestId('main-layout')).toBeVisible();
      return { duplicateExitCode: exitCode };
    });

    await runner.run('persistence.relaunch', 'preserve setup, Provider, sessions, and tool artifacts across relaunch', async () => {
      const previous = contextOrThrow(context);
      await closePackagedApp(previous);
      context = null;
      const nextHostPort = await allocatePort();
      context = rememberContext(await launchPackagedApp({
        appRoot,
        portableRoot: appRoot,
        osHome,
        gatewayPort,
        hostApiPort: nextHostPort,
        managed: false,
      }));
      await expect(context.page.getByTestId('main-layout')).toBeVisible({ timeout: 120_000 });
      await expect(context.page.getByTestId('setup-page')).toHaveCount(0);
      await waitForGatewayReady(context.page, 180_000);
      if (profile === 'full') {
        await context.page.getByTestId('sidebar-nav-models').click();
        await expect(context.page.locator('[data-testid^="provider-card-"]').filter({ hasText: 'UClaw Regression Local' })).toBeVisible();
        expect(await readFile(toolTargetPath, 'utf8')).toContain('UCLAW_REGRESSION_TOOL_FILE_OK');
      }
      return { startupMs: context.startupMs };
    });

    await closePackagedApp(context);
    context = null;

    await runner.run('managed.no-auth', 'defer Gateway cleanly for a fresh managed profile without credentials', async () => {
      const portableRoot = path.join(sandboxRoot, 'managed-no-auth-portable');
      const managedHome = path.join(sandboxRoot, 'managed-no-auth-home');
      await ensurePortableRoot(portableRoot);
      const managedGatewayPort = await allocatePort();
      const managedHostPort = await allocatePort();
      await seedGatewaySettings(portableRoot, managedGatewayPort);
      context = rememberContext(await launchPackagedApp({
        appRoot,
        portableRoot,
        osHome: managedHome,
        gatewayPort: managedGatewayPort,
        hostApiPort: managedHostPort,
        managed: true,
      }));
      await expect(context.page.getByTestId('setup-page')).toBeVisible({ timeout: 120_000 });
      const status = await waitForGateway(
        context.page,
        (candidate) => ['stopped', 'error'].includes(String(candidate.state)),
        30_000,
      );
      expect(status.state).not.toBe('running');
      await closePackagedApp(context);
      context = null;
      return status;
    });

    await runner.run('security.secret-redaction', 'keep deterministic credentials out of user-visible process output', async () => {
      const output = processOutputs.flat().join('');
      expect(output).not.toContain(REGRESSION_API_KEY);
      expect(output).not.toMatch(/authorization\s*[:=]\s*bearer\s+(?!\[REDACTED\])\S+/iu);
      expect(output).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}\b/u);
      return { inspectedChars: output.length };
    });

    if (provider || fallbackProvider) {
      await writeFile(
        path.join(reportDir, 'deterministic-provider-requests.json'),
        `${JSON.stringify([
          ...(provider?.requests ?? []),
          ...(fallbackProvider?.requests ?? []),
        ], null, 2)}\n`,
        'utf8',
      );
    }
  } finally {
    await closePackagedApp(context);
    await provider?.close();
    await fallbackProvider?.close();
    await runner.finish();
  }
});
