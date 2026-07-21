import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

export type RawHostApiResponse = {
  transportOk: boolean;
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
  error: string;
};

export type PackagedAppContext = {
  browser: Browser;
  browserContext: BrowserContext;
  process: ChildProcess;
  page: Page;
  appRoot: string;
  portableRoot: string;
  osHome: string;
  gatewayPort: number;
  hostApiPort: number;
  startupMs: number;
  output: string[];
  env: NodeJS.ProcessEnv;
};

type LaunchOptions = {
  appRoot: string;
  portableRoot: string;
  osHome: string;
  gatewayPort: number;
  hostApiPort: number;
  managed: boolean;
};

function isolatedChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CLAWX|OPENCLAW|UCLAW)_/iu.test(key)
      || /^(?:PW_|PLAYWRIGHT_|ELECTRON_RUN_AS_NODE$)/iu.test(key)
      || key === 'NODE_OPTIONS'
      || /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?)(?:$|_)/iu.test(key)) {
      delete env[key];
    }
  }
  return env;
}

export async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral port.')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function ensurePortableRoot(portableRoot: string): Promise<void> {
  await mkdir(path.join(portableRoot, 'UClawData', 'clawx'), { recursive: true });
  await mkdir(path.join(portableRoot, 'UClawData', 'updates'), { recursive: true });
  await writeFile(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
}

export async function seedGatewaySettings(portableRoot: string, gatewayPort: number): Promise<void> {
  await ensurePortableRoot(portableRoot);
  const settingsPath = path.join(portableRoot, 'UClawData', 'clawx', 'settings.json');
  const settings = await readJsonObject(settingsPath);
  await writeFile(settingsPath, `${JSON.stringify({
    ...settings,
    gatewayAutoStart: true,
    gatewayPort,
    autoCheckUpdates: false,
    proxyEnabled: false,
  }, null, 2)}\n`, 'utf8');
}

export async function getStableWindow(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const candidate = context.pages().filter((page) => !page.isClosed()).at(-1);
    if (candidate && !candidate.isClosed()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 3_000 });
        return candidate;
      } catch (error) {
        if (!String(error).includes('has been closed')) throw error;
      }
    }
    try {
      await context.waitForEvent('page', { timeout: 3_000 });
    } catch {
      // Poll until the packaged window settles after startup/relaunch.
    }
  }
  throw new Error('No stable packaged UClaw window became available.');
}

async function waitForCdp(origin: string, child: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged UClaw exited before CDP became ready (exit=${child.exitCode}).`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`${origin}/json/version`, { signal: controller.signal });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged UClaw CDP endpoint did not become ready: ${lastError}`);
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGKILL');
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function launchPackagedApp(options: LaunchOptions): Promise<PackagedAppContext> {
  await ensurePortableRoot(options.portableRoot);
  await mkdir(path.join(options.osHome, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(path.join(options.osHome, 'AppData', 'Local'), { recursive: true });
  await mkdir(path.join(options.osHome, 'Temp'), { recursive: true });
  const executablePath = path.join(options.appRoot, 'UClaw.exe');
  const cdpPort = await allocatePort();
  const env: NodeJS.ProcessEnv = {
    ...isolatedChildEnvironment(),
    HOME: options.osHome,
    USERPROFILE: options.osHome,
    APPDATA: path.join(options.osHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(options.osHome, 'AppData', 'Local'),
    TEMP: path.join(options.osHome, 'Temp'),
    TMP: path.join(options.osHome, 'Temp'),
    CLAWX_PORTABLE_ROOT: options.portableRoot,
    CLAWX_RUNTIME_CACHE_ROOT: path.join(options.osHome, 'AppData', 'Local', 'UClawRuntime'),
    CLAWX_MANAGED_PROVIDER: options.managed ? '1' : '0',
    CLAWX_E2E: '0',
    CLAWX_E2E_SKIP_SETUP: '0',
    CLAWX_PORT_CLAWX_HOST_API: String(options.hostApiPort),
    CLAWX_PORT_OPENCLAW_GATEWAY: String(options.gatewayPort),
    CLAWX_REMOTE_DEBUGGING_PORT: String(cdpPort),
    OPENCLAW_DISABLE_UPDATE_CHECK: '1',
    VITE_DEV_SERVER_URL: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const startedAt = Date.now();
  const child = spawn(executablePath, [`--remote-debugging-port=${cdpPort}`], {
    cwd: options.appRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  let browser: Browser | null = null;
  try {
    const cdpOrigin = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(cdpOrigin, child);
    browser = await chromium.connectOverCDP(cdpOrigin, { timeout: 120_000 });
    const browserContext = browser.contexts()[0];
    if (!browserContext) throw new Error('Packaged UClaw exposed no Chromium browser context.');
    const page = await getStableWindow(browserContext);
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    return {
      browser,
      browserContext,
      process: child,
      page,
      appRoot: options.appRoot,
      portableRoot: options.portableRoot,
      osHome: options.osHome,
      gatewayPort: options.gatewayPort,
      hostApiPort: options.hostApiPort,
      startupMs: Date.now() - startedAt,
      output,
      env,
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    terminateProcessTree(child);
    throw error;
  }
}

export async function closePackagedApp(context: PackagedAppContext | null, timeoutMs = 15_000): Promise<void> {
  if (!context) return;
  try {
    await Promise.race([
      context.browser.close(),
      new Promise((resolve) => setTimeout(resolve, Math.floor(timeoutMs / 2))),
    ]);
  } catch {
    // Continue to process cleanup after a disconnected CDP session.
  }
  if (await waitForProcessExit(context.process, Math.ceil(timeoutMs / 2))) return;
  terminateProcessTree(context.process);
  await waitForProcessExit(context.process, 5_000);
}

export async function rawHostApi(
  page: Page,
  requestPath: string,
  method = 'GET',
  body?: unknown,
): Promise<RawHostApiResponse> {
  const rawResponse = await page.evaluate(async (request) => {
    const electronApi = (window as unknown as {
      electron: { ipcRenderer: { invoke(channel: string, payload: unknown): Promise<unknown> } };
    }).electron;
    return await electronApi.ipcRenderer.invoke('hostapi:fetch', {
      path: request.path,
      method: request.method,
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
      body: request.body === undefined ? null : JSON.stringify(request.body),
    });
  }, { path: requestPath, method, body }) as unknown;

  const response = rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)
    ? rawResponse as Record<string, unknown>
    : {};

  const data = response?.data && typeof response.data === 'object'
    ? response.data as Record<string, unknown>
    : response;
  const responseError = response?.error;
  const status = typeof data?.status === 'number' ? data.status : 200;
  const transportOk = response?.ok !== false && response?.success !== false;
  const payloadError = data?.json && typeof data.json === 'object' && !Array.isArray(data.json)
    ? data.json as Record<string, unknown>
    : null;
  return {
    transportOk,
    status,
    ok: transportOk && data?.ok !== false && status >= 200 && status < 300,
    json: data?.json,
    text: typeof data?.text === 'string' ? data.text : '',
    error: typeof responseError === 'string'
      ? responseError
      : responseError && typeof responseError === 'object' && typeof (responseError as Record<string, unknown>).message === 'string'
        ? String((responseError as Record<string, unknown>).message)
        : typeof payloadError?.error === 'string'
          ? payloadError.error
          : typeof payloadError?.message === 'string'
            ? payloadError.message
            : '',
  };
}

export async function hostApiJson<T>(
  page: Page,
  requestPath: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await rawHostApi(page, requestPath, method, body);
  if (!response.transportOk || !response.ok || response.status < 200 || response.status >= 300) {
    throw new Error(`Host API ${method} ${requestPath} failed (${response.status}): ${response.error || response.text || JSON.stringify(response.json)}`);
  }
  return response.json as T;
}

export async function waitForGateway(
  page: Page,
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: Record<string, unknown> = {};
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await rawHostApi(page, '/api/gateway/status');
      if (response.ok && response.json && typeof response.json === 'object') {
        lastStatus = response.json as Record<string, unknown>;
        if (predicate(lastStatus)) return lastStatus;
      } else {
        lastError = response.error || response.text;
      }
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Gateway condition timed out. Last status=${JSON.stringify(lastStatus)} error=${lastError}`);
}

export async function waitForGatewayReady(page: Page, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  return await waitForGateway(
    page,
    (status) => status.state === 'running' && status.gatewayReady !== false,
    timeoutMs,
  );
}
