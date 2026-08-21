import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type {
  HostApiAction,
  HostApiModule,
  HostApiPayloadArgs,
  HostApiResult,
} from '@shared/host-api/contract';
import type { HostResponse } from '@shared/host-api/types';
import { UCLAW_PRODUCTION_ORIGIN } from '@shared/junfeiai-endpoints';

export type RawHostInvokeResponse<T> = HostResponse<T>;

export type PackagedAppContext = {
  browser: Browser;
  browserContext: BrowserContext;
  process: ChildProcess;
  page: Page;
  appRoot: string;
  portableRoot: string;
  osHome: string;
  runtimeCacheRoot: string;
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
  runtimeCacheRoot?: string;
  gatewayPort: number;
  hostApiPort: number;
  managed: boolean;
};

type ProcessOutput = {
  stdout: string[];
  stderr: string[];
};

const PROCESS_TAIL_MAX_LINES = 12;
const PROCESS_TAIL_MAX_LINE_CHARS = 500;
const PROCESS_TAIL_MAX_STREAM_CHARS = 2_000;
const REDACTED = '[redacted]';
const REDACTED_PATH = '[path-redacted]';
const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`<>]+/giu;
const FILE_URL_PATTERN = /\b(file:\/\/\/?)[^\s"'`<>]+/giu;
const QUOTED_ABSOLUTE_PATH_PATTERN = /(["'`])((?:[A-Z]:[\\/]+|\\{2,}(?:[?.][\\/]+)?|\/{2}(?!\/)|\/(?!\/))(?:(?!\1)[^\r\n])*)\1/giu;
const UNQUOTED_ABSOLUTE_PATH_PATTERN = /(^|[\s=(:,{}\x5B])((?:[A-Z]:[\\/]+|\\{2,}(?:[?.][\\/]+)?|\/{2}(?!\/)|\/(?!\/))(?:(?!\s+[A-Z_][A-Z0-9_.-]*=)[^\r\n"'`<>\x5B\x5D{},;)])*)/gimu;
const AUTH_HEADER_PATTERN = /((?:^|\s|["'{,])(?:authorization|proxy-authorization|cookie|set-cookie)(?:["']?)\s*[:=]\s*)[^\r\n]+/gimu;
const SENSITIVE_ASSIGNMENT_PATTERN = /((?:["']?(?:access[_-]?token|refresh[_-]?token|relay[_-]?token|id[_-]?token|session[_-]?token|token|api[_-]?key|api-key|x-api-key|x-auth-token|auth-token|access-key|secret-key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|passphrase|client[_-]?secret|secret|credentials?|auth)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;
const SENSITIVE_FLAG_PATTERN = /(\s--?(?:access[_-]?token|refresh[_-]?token|relay[_-]?token|token|api[_-]?key|password|passwd|secret|cookie|authorization)(?:=|\s+))\S+/giu;
const AUTHORIZATION_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/giu;
const COMMON_SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const SENSITIVE_QUERY_KEYS = new Set([
  'accesstoken', 'apikey', 'auth', 'authorization', 'clientsecret', 'cookie',
  'credential', 'idtoken', 'key', 'password', 'passwd', 'refreshtoken',
  'relaytoken', 'secret', 'session', 'sessionid', 'sessiontoken', 'sig',
  'signature', 'token', 'authtoken', 'xauthtoken', 'accesskey', 'secretkey',
  'xapikey',
]);

function normalizeSensitiveKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function decodePercentEncoding(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < 3 && decoded.includes('%'); pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

function isAbsolutePathValue(value: string): boolean {
  const decoded = decodePercentEncoding(value) ?? value;
  return /^(?:[A-Z]:[\\/]+|\\{2}|\/{1,2}(?!\/)|file:\/{2,})/iu.test(decoded);
}

function redactCredentialText(value: string): string {
  return value
    .replace(AUTH_HEADER_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_FLAG_PATTERN, `$1${REDACTED}`)
    .replace(AUTHORIZATION_VALUE_PATTERN, REDACTED)
    .replace(COMMON_SECRET_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED);
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = '';
    }
    for (const [key, entryValue] of [...parsed.searchParams.entries()]) {
      if (SENSITIVE_QUERY_KEYS.has(normalizeSensitiveKey(key)) || isAbsolutePathValue(entryValue)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    if (parsed.hash) parsed.hash = REDACTED;
    return redactCredentialText(parsed.toString().replace(/%5Bredacted%5D/giu, REDACTED));
  } catch {
    return redactCredentialText(value);
  }
}

function stripControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code >= 32 && code !== 127 ? character : ' ';
  }).join('');
}

function sanitizeProcessOutputText(value: string): string {
  const urls: string[] = [];
  let placeholder = '__UCLAW_PACKAGED_URL_';
  while (value.includes(placeholder)) placeholder += '_';
  let sanitized = stripControlCharacters(value)
    .replace(FILE_URL_PATTERN, `$1${REDACTED_PATH}`)
    .replace(ABSOLUTE_URL_PATTERN, (url) => {
      const index = urls.push(sanitizeDiagnosticUrl(url)) - 1;
      return `${placeholder}${index}__`;
    });
  sanitized = redactCredentialText(sanitized)
    .replace(QUOTED_ABSOLUTE_PATH_PATTERN, `$1${REDACTED_PATH}$1`)
    .replace(UNQUOTED_ABSOLUTE_PATH_PATTERN, `$1${REDACTED_PATH}`);
  for (const [index, url] of urls.entries()) {
    sanitized = sanitized.replaceAll(`${placeholder}${index}__`, url);
  }
  return sanitized;
}

function formatProcessStreamTail(label: keyof ProcessOutput, chunks: string[]): string | null {
  const lines = sanitizeProcessOutputText(chunks.join('').replace(/\r\n?/gu, '\n'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-PROCESS_TAIL_MAX_LINES)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (trimmed.length <= PROCESS_TAIL_MAX_LINE_CHARS) return trimmed;
      const marker = '[line-truncated] ';
      return marker + trimmed.slice(-(PROCESS_TAIL_MAX_LINE_CHARS - marker.length));
    });
  if (lines.length === 0) return null;
  const body = lines.join('\n');
  const bounded = body.length <= PROCESS_TAIL_MAX_STREAM_CHARS
    ? body
    : `[tail-truncated]\n${body.slice(-(PROCESS_TAIL_MAX_STREAM_CHARS - 17))}`;
  return `[${label} tail]\n${bounded}`;
}

function formatProcessOutputTail(output: ProcessOutput): string {
  const tails = ([
    formatProcessStreamTail('stdout', output.stdout),
    formatProcessStreamTail('stderr', output.stderr),
  ]).filter((tail): tail is string => tail !== null);
  return tails.length > 0 ? `\nSanitized process output tail:\n${tails.join('\n')}` : '';
}

async function allowExitedProcessOutputToDrain(child: ChildProcess): Promise<void> {
  const streams = [child.stdout, child.stderr]
    .filter((stream): stream is NonNullable<typeof stream> => stream != null);
  if (streams.length === 0 || streams.every((stream) => stream.readableEnded)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    child.once('close', finish);
  });
}

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

/** Seed a verified server-owned media policy for deterministic offline UI checks. */
export async function seedManagedMediaPolicyCache(portableRoot: string): Promise<void> {
  await ensurePortableRoot(portableRoot);
  const userDataDir = path.join(portableRoot, 'UClawData', 'clawx');
  const cachePath = path.join(userDataDir, 'managed-client-config.json');
  const existing = await readJsonObject(cachePath);
  const verifiedAt = Date.now();
  const origin = UCLAW_PRODUCTION_ORIGIN;
  await writeFile(cachePath, `${JSON.stringify({
    ...existing,
    imageModelPolicy: {
      version: 1,
      policiesByOrigin: {
        ...(existing.imageModelPolicy && typeof existing.imageModelPolicy === 'object'
          ? (existing.imageModelPolicy as Record<string, unknown>).policiesByOrigin
          : {}),
        [origin]: {
          verifiedAt,
          policy: {
            defaultModel: 'regression-image',
            defaultSize: '1024x1024',
            defaultQuality: 'standard',
            models: [{
              id: 'regression-image',
              sizes: ['1024x1024', '1024x1536'],
              qualities: ['standard', 'high'],
              defaultSize: '1024x1024',
              defaultQuality: 'standard',
              supportsEditing: false,
            }],
          },
        },
      },
    },
    videoModelPolicy: {
      version: 2,
      policiesByOrigin: {
        ...(existing.videoModelPolicy && typeof existing.videoModelPolicy === 'object'
          ? (existing.videoModelPolicy as Record<string, unknown>).policiesByOrigin
          : {}),
        [origin]: {
          verifiedAt,
          policy: {
            defaultModel: 'regression-video',
            defaultSize: '1280x720',
            defaultAspectRatio: '16:9',
            defaultResolution: '720P',
            defaultDurationSeconds: 6,
            models: [{
              id: 'regression-video',
              modes: ['text-to-video'],
              sizes: ['1280x720', '720x1280'],
              aspectRatios: ['16:9', '9:16'],
              resolutions: ['720P'],
              durations: [6, 15],
              defaultSize: '1280x720',
              defaultAspectRatio: '16:9',
              defaultResolution: '720P',
              defaultDurationSeconds: 6,
              requiresImage: false,
            }],
          },
        },
      },
    },
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

export async function waitForCdp(
  origin: string,
  child: ChildProcess,
  output: ProcessOutput = { stdout: [], stderr: [] },
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const hasExited = (child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined);
    if (hasExited) {
      await allowExitedProcessOutputToDrain(child);
      const exit = child.exitCode === null || child.exitCode === undefined
        ? 'null'
        : String(child.exitCode);
      const signal = child.signalCode === null || child.signalCode === undefined
        ? 'none'
        : child.signalCode;
      throw new Error(
        `Packaged UClaw exited before CDP became ready (exit=${exit}, signal=${signal}).`
        + formatProcessOutputTail(output),
      );
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
  const runtimeCacheRoot = options.runtimeCacheRoot
    ? path.resolve(options.runtimeCacheRoot)
    : path.join(options.osHome, 'AppData', 'Local', 'UClawRuntime');
  await mkdir(runtimeCacheRoot, { recursive: true });
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
    CLAWX_RUNTIME_CACHE_ROOT: runtimeCacheRoot,
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
  const startupOutput: ProcessOutput = { stdout: [], stderr: [] };
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    output.push(text);
    startupOutput.stdout.push(text);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    output.push(text);
    startupOutput.stderr.push(text);
  });
  let browser: Browser | null = null;
  try {
    const cdpOrigin = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(cdpOrigin, child, startupOutput);
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
      runtimeCacheRoot,
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
      context.page.evaluate(async () => {
        await window.clawx?.hostInvoke({
          id: `packaged-close-${Date.now()}`,
          module: 'app',
          action: 'quit',
        });
      }),
      new Promise((resolve) => setTimeout(resolve, Math.min(3_000, Math.floor(timeoutMs / 3)))),
    ]);
  } catch {
    // The renderer may disappear while the application is quitting.
  }
  if (await waitForProcessExit(context.process, timeoutMs)) {
    await context.browser.close().catch(() => undefined);
    return;
  }
  await context.browser.close().catch(() => undefined);
  terminateProcessTree(context.process);
  await waitForProcessExit(context.process, 5_000);
}

export async function rawHostInvoke<
  M extends HostApiModule,
  A extends HostApiAction<M>,
>(
  page: Page,
  module: M,
  action: A,
  ...payloadArgs: HostApiPayloadArgs<M, A>
): Promise<RawHostInvokeResponse<HostApiResult<M, A>>> {
  const response = await page.evaluate(async (request) => {
    const bridge = window.clawx?.hostInvoke;
    if (!bridge) {
      return {
        id: request.id,
        ok: false as const,
        error: { code: 'UNAVAILABLE', message: 'Typed Host API is unavailable' },
      };
    }
    return await bridge({
      id: request.id,
      module: request.module,
      action: request.action,
      ...(request.hasPayload ? { payload: request.payload } : {}),
    });
  }, {
    id: `packaged-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    module,
    action,
    hasPayload: payloadArgs.length > 0,
    payload: payloadArgs[0],
  });
  return response as RawHostInvokeResponse<HostApiResult<M, A>>;
}

export async function hostInvokeJson<
  M extends HostApiModule,
  A extends HostApiAction<M>,
>(
  page: Page,
  module: M,
  action: A,
  ...payloadArgs: HostApiPayloadArgs<M, A>
): Promise<HostApiResult<M, A>> {
  const response = await rawHostInvoke(page, module, action, ...payloadArgs);
  if (!response.ok) {
    throw new Error(
      `Host API ${module}.${action} failed: ${response.error?.message || response.error?.code || 'unknown error'}`,
    );
  }
  return response.data;
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
      const response = await rawHostInvoke(page, 'gateway', 'status');
      if (response.ok && response.data && typeof response.data === 'object') {
        lastStatus = response.data as Record<string, unknown>;
        if (predicate(lastStatus)) return lastStatus;
      } else {
        lastError = response.ok ? 'Gateway returned an empty status' : response.error?.message || '';
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
