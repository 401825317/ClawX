import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  extname,
  join,
} from 'node:path';
import { pathToFileURL } from 'node:url';

export type LocalArtifactOpenabilityStatus = 'passed' | 'failed' | 'skipped';

export type LocalArtifactOpenabilitySeverity = 'info' | 'warning' | 'blocking';

export type LocalArtifactOpenabilityArtifactType =
  | 'presentation'
  | 'spreadsheet'
  | 'html'
  | 'markdown'
  | 'unsupported';

export type LocalArtifactOpenabilityVerifier =
  | 'libreoffice-pdf'
  | 'electron-browser-window'
  | 'filesystem-read'
  | 'none';

export type VerifyLocalArtifactOpenabilityInput = {
  filePath: string;
  timeoutMs?: number;
};

export type LocalArtifactOpenabilityResult = {
  status: LocalArtifactOpenabilityStatus;
  kind: 'artifact.openability';
  artifactType: LocalArtifactOpenabilityArtifactType;
  verifier: LocalArtifactOpenabilityVerifier;
  required: boolean;
  severity: LocalArtifactOpenabilitySeverity;
  detail: string;
  evidence?: string;
  durationMs: number;
};

type SupportedArtifactType = Exclude<LocalArtifactOpenabilityArtifactType, 'unsupported'>;

type CommandOutcome = {
  started: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: unknown;
};

type HtmlSmokeResult = {
  readyState: string;
  bodyElementCount: number;
  bodyTextLength: number;
  interactiveElementCount: number;
  enabledInteractiveElementCount: number;
  interactionDispatched: boolean;
};

const DEFAULT_OFFICE_TIMEOUT_MS = 30_000;
const DEFAULT_HTML_TIMEOUT_MS = 15_000;
const DEFAULT_MARKDOWN_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 120_000;
const PROCESS_KILL_GRACE_MS = 1_500;
const HTML_SETTLE_MS = 75;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_CHARS = 800;
const PDF_HEADER = Buffer.from('%PDF-', 'ascii');

const HTML_SMOKE_SCRIPT = String.raw`(() => {
  const body = document.body;
  if (!body) {
    return {
      readyState: document.readyState,
      bodyElementCount: 0,
      bodyTextLength: 0,
      interactiveElementCount: 0,
      enabledInteractiveElementCount: 0,
      interactionDispatched: false,
    };
  }

  const bodyElements = Array.from(body.querySelectorAll('*')).filter((element) => {
    return !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META'].includes(element.tagName);
  });
  const interactiveSelector = [
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const interactiveElements = Array.from(body.querySelectorAll(interactiveSelector));
  const enabledInteractiveElements = interactiveElements.filter((element) => {
    const htmlElement = element;
    const style = window.getComputedStyle(htmlElement);
    const disabled = htmlElement.matches(':disabled') || htmlElement.getAttribute('aria-disabled') === 'true';
    return !disabled
      && !htmlElement.hasAttribute('hidden')
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && htmlElement.getClientRects().length > 0;
  });

  let interactionDispatched = false;
  const target = enabledInteractiveElements[0];
  if (target) {
    const eventType = target.matches('input, select, textarea') ? 'input' : 'click';
    const preventDefault = (event) => event.preventDefault();
    document.addEventListener(eventType, preventDefault, { capture: true, once: true });
    target.focus({ preventScroll: true });
    const event = eventType === 'click'
      ? new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      : new Event(eventType, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    document.removeEventListener(eventType, preventDefault, true);
    interactionDispatched = true;
  }

  return {
    readyState: document.readyState,
    bodyElementCount: bodyElements.length,
    bodyTextLength: (body.innerText || body.textContent || '').trim().length,
    interactiveElementCount: interactiveElements.length,
    enabledInteractiveElementCount: enabledInteractiveElements.length,
    interactionDispatched,
  };
})()`;

class OpenabilityVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpenabilityVerificationError';
    this.code = code;
  }
}

function artifactTypeForPath(filePath: string): LocalArtifactOpenabilityArtifactType {
  switch (extname(filePath).toLowerCase()) {
    case '.pptx':
      return 'presentation';
    case '.xlsx':
      return 'spreadsheet';
    case '.html':
    case '.htm':
      return 'html';
    case '.md':
    case '.markdown':
      return 'markdown';
    default:
      return 'unsupported';
  }
}

function defaultTimeoutForType(artifactType: SupportedArtifactType): number {
  if (artifactType === 'presentation' || artifactType === 'spreadsheet') {
    return DEFAULT_OFFICE_TIMEOUT_MS;
  }
  if (artifactType === 'html') return DEFAULT_HTML_TIMEOUT_MS;
  return DEFAULT_MARKDOWN_TIMEOUT_MS;
}

function normalizedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

function result(
  startedAt: number,
  fields: Omit<LocalArtifactOpenabilityResult, 'kind' | 'durationMs'>,
): LocalArtifactOpenabilityResult {
  return {
    ...fields,
    kind: 'artifact.openability',
    durationMs: Date.now() - startedAt,
  };
}

function passed(
  startedAt: number,
  artifactType: SupportedArtifactType,
  verifier: Exclude<LocalArtifactOpenabilityVerifier, 'none'>,
  detail: string,
  evidence: string,
): LocalArtifactOpenabilityResult {
  return result(startedAt, {
    status: 'passed',
    artifactType,
    verifier,
    required: true,
    severity: 'info',
    detail,
    evidence,
  });
}

function failed(
  startedAt: number,
  artifactType: SupportedArtifactType,
  verifier: Exclude<LocalArtifactOpenabilityVerifier, 'none'>,
  detail: string,
  evidence?: string,
): LocalArtifactOpenabilityResult {
  return result(startedAt, {
    status: 'failed',
    artifactType,
    verifier,
    required: true,
    severity: 'blocking',
    detail,
    evidence,
  });
}

function skipped(
  startedAt: number,
  artifactType: LocalArtifactOpenabilityArtifactType,
  verifier: LocalArtifactOpenabilityVerifier,
  detail: string,
  evidence?: string,
): LocalArtifactOpenabilityResult {
  return result(startedAt, {
    status: 'skipped',
    artifactType,
    verifier,
    required: false,
    severity: 'warning',
    detail,
    evidence,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function redactDiagnosticValue(value: string, sensitivePaths: string[]): string {
  let redacted = value;
  const pathValues = [...new Set([...sensitivePaths, homedir()])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const sensitivePath of pathValues) {
    redacted = redacted.replace(new RegExp(escapeRegExp(sensitivePath), 'giu'), '[local-path]');
    const slashVariant = sensitivePath.replace(/\\/gu, '/');
    if (slashVariant !== sensitivePath) {
      redacted = redacted.replace(new RegExp(escapeRegExp(slashVariant), 'giu'), '[local-path]');
    }
  }

  return redacted
    .replace(/file:\/\/\/[^\s)'"<>]+/giu, 'file://[local-path]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|api_key|apikey|key|secret|signature|token)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

function safeDiagnostic(error: unknown, sensitivePaths: string[] = []): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  const redactedMessage = redactDiagnosticValue(message, sensitivePaths) || 'unknown error';
  return [code ? `code=${code}` : undefined, `message=${redactedMessage}`]
    .filter(Boolean)
    .join('; ');
}

function isToolUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code ?? '');
  return ['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN'].includes(code);
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  return current + buffer.subarray(0, remaining).toString('utf8');
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // Fall through to the direct kill below.
    }
  } else if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Best-effort fallback; the close grace timer still bounds the caller wait.
  }
}

async function runCommandWithTimeout(
  executable: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandOutcome> {
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      detached: process.platform !== 'win32',
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return {
      started: false,
      timedOut: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error,
    };
  }

  return await new Promise<CommandOutcome>((resolve) => {
    let started = false;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let killGraceTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: Pick<CommandOutcome, 'exitCode' | 'signal' | 'error'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve({
        started,
        timedOut,
        stdout,
        stderr,
        ...outcome,
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      killGraceTimer = setTimeout(() => {
        finish({ exitCode: child.exitCode, signal: child.signalCode });
      }, PROCESS_KILL_GRACE_MS);
    }, timeoutMs);

    child.once('spawn', () => {
      started = true;
    });
    child.stdout?.on('data', (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once('error', (error) => {
      finish({ exitCode: child.exitCode, signal: child.signalCode, error });
    });
    child.once('close', (exitCode, signal) => {
      finish({ exitCode, signal });
    });
  });
}

function pathCandidates(command: string): string[] {
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter(Boolean);

  if (process.platform !== 'win32') {
    return pathEntries.map((entry) => join(entry, command));
  }

  const commandHasExtension = extname(command).length > 0;
  const extensions = commandHasExtension
    ? ['']
    : (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean);
  return pathEntries.flatMap((entry) => extensions.map((extension) => join(entry, `${command}${extension}`)));
}

async function platformOfficeCandidates(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      join(homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ];
  }

  if (process.platform === 'win32') {
    const programFiles = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    ].filter((value): value is string => Boolean(value));
    return programFiles.flatMap((root) => [
      join(root, 'LibreOffice', 'program', 'soffice.exe'),
      join(root, 'LibreOffice', 'program', 'soffice.com'),
    ]);
  }

  const candidates = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/usr/local/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
  ];
  try {
    const optEntries = await readdir('/opt', { withFileTypes: true });
    for (const entry of optEntries) {
      if (entry.isDirectory() && /^libreoffice/iu.test(entry.name)) {
        candidates.push(join('/opt', entry.name, 'program', 'soffice'));
      }
    }
  } catch {
    // /opt is optional on Linux.
  }
  return candidates;
}

async function discoverOfficeExecutable(): Promise<string | null> {
  const commandNames = process.platform === 'win32'
    ? ['soffice', 'libreoffice']
    : ['soffice', 'libreoffice', 'LibreOffice'];
  const candidates = [
    ...commandNames.flatMap(pathCandidates),
    ...await platformOfficeCandidates(),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through all platform and PATH candidates.
    }
  }
  return null;
}

async function verifyOfficeArtifact(
  filePath: string,
  artifactType: 'presentation' | 'spreadsheet',
  timeoutMs: number,
  startedAt: number,
): Promise<LocalArtifactOpenabilityResult> {
  const officeExecutable = await discoverOfficeExecutable();
  if (!officeExecutable) {
    return skipped(
      startedAt,
      artifactType,
      'libreoffice-pdf',
      '未发现可用的 LibreOffice/soffice，已跳过 Office 真实打开验证。',
      `platform=${process.platform}; discovery=not-found`,
    );
  }

  let tempRoot: string | undefined;
  let conversionStarted = false;
  let verificationResult: LocalArtifactOpenabilityResult;
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'uclaw-artifact-openability-'));
    const outputDir = join(tempRoot, 'output');
    const profileDir = join(tempRoot, 'profile');
    await mkdir(outputDir, { recursive: true });

    const commandResult = await runCommandWithTimeout(
      officeExecutable,
      [
        '--headless',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--nolockcheck',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outputDir,
        filePath,
      ],
      timeoutMs,
      {
        ...process.env,
        SAL_USE_VCLPLUGIN: 'svp',
      },
    );
    conversionStarted = commandResult.started;

    if (!commandResult.started && commandResult.error && isToolUnavailableError(commandResult.error)) {
      verificationResult = skipped(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        'LibreOffice/soffice 当前无法启动，已跳过 Office 真实打开验证。',
        safeDiagnostic(commandResult.error, [filePath, tempRoot]),
      );
    } else if (commandResult.timedOut) {
      verificationResult = failed(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        `Office 真实打开验证超时（${timeoutMs}ms）。`,
        `office=${basename(officeExecutable)}; timedOut=true`,
      );
    } else if (commandResult.error) {
      verificationResult = failed(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        'LibreOffice/soffice 执行失败，产物未通过真实打开验证。',
        safeDiagnostic(commandResult.error, [filePath, tempRoot]),
      );
    } else if (commandResult.exitCode !== 0) {
      const diagnosticOutput = commandResult.stderr || commandResult.stdout || `signal=${commandResult.signal ?? 'none'}`;
      verificationResult = failed(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        'LibreOffice/soffice 无法将产物打开并导出为 PDF。',
        `exitCode=${commandResult.exitCode ?? 'null'}; ${redactDiagnosticValue(diagnosticOutput, [filePath, tempRoot])}`,
      );
    } else {
      const outputEntries = await readdir(outputDir, { withFileTypes: true });
      const pdfNames = outputEntries
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.pdf')
        .map((entry) => entry.name);
      if (pdfNames.length !== 1) {
        verificationResult = failed(
          startedAt,
          artifactType,
          'libreoffice-pdf',
          'LibreOffice/soffice 未生成唯一的 PDF 验证产物。',
          `pdfCount=${pdfNames.length}; exitCode=0`,
        );
      } else {
        const pdfPath = join(outputDir, pdfNames[0]);
        const pdfStat = await stat(pdfPath);
        const pdfBytes = await readFile(pdfPath);
        const hasPdfHeader = pdfBytes.length >= PDF_HEADER.length
          && pdfBytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER);
        if (!pdfStat.isFile() || pdfStat.size <= 0 || !hasPdfHeader) {
          verificationResult = failed(
            startedAt,
            artifactType,
            'libreoffice-pdf',
            'LibreOffice/soffice 导出的 PDF 为空或格式无效。',
            `pdfBytes=${pdfStat.size}; pdfHeader=${hasPdfHeader}`,
          );
        } else {
          verificationResult = passed(
            startedAt,
            artifactType,
            'libreoffice-pdf',
            'Office 产物已由 LibreOffice/soffice 真实打开并成功导出非空 PDF。',
            `office=${basename(officeExecutable)}; pdfBytes=${pdfStat.size}; pdfHeader=true`,
          );
        }
      }
    }
  } catch (error) {
    verificationResult = conversionStarted
      ? failed(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        'Office 真实打开验证执行失败。',
        safeDiagnostic(error, [filePath, tempRoot ?? '']),
      )
      : skipped(
        startedAt,
        artifactType,
        'libreoffice-pdf',
        '当前环境无法准备 LibreOffice 临时验证目录，已跳过 Office 真实打开验证。',
        safeDiagnostic(error, [filePath, tempRoot ?? '']),
      );
  }

  if (tempRoot) {
    try {
      await rm(tempRoot, { force: true, maxRetries: 2, recursive: true, retryDelay: 100 });
    } catch (error) {
      return conversionStarted
        ? failed(
          startedAt,
          artifactType,
          'libreoffice-pdf',
          'Office 真实打开验证的临时目录清理失败。',
          safeDiagnostic(error, [filePath, tempRoot]),
        )
        : skipped(
          startedAt,
          artifactType,
          'libreoffice-pdf',
          'Office 验证环境不可用，且临时目录清理失败。',
          safeDiagnostic(error, [filePath, tempRoot]),
        );
    }
  }
  return verificationResult;
}

function isHtmlSmokeResult(value: unknown): value is HtmlSmokeResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HtmlSmokeResult>;
  return typeof candidate.readyState === 'string'
    && typeof candidate.bodyElementCount === 'number'
    && typeof candidate.bodyTextLength === 'number'
    && typeof candidate.interactiveElementCount === 'number'
    && typeof candidate.enabledInteractiveElementCount === 'number'
    && typeof candidate.interactionDispatched === 'boolean';
}

async function verifyHtmlArtifact(
  filePath: string,
  timeoutMs: number,
  startedAt: number,
): Promise<LocalArtifactOpenabilityResult> {
  const processType = (process as NodeJS.Process & { type?: string }).type;
  if (processType !== 'browser') {
    return skipped(
      startedAt,
      'html',
      'electron-browser-window',
      'HTML 真实打开验证仅可在 Electron main process 执行，当前已跳过。',
      `processType=${processType ?? 'node'}`,
    );
  }

  let verificationWindow: Electron.BrowserWindow | undefined;
  let verificationResult: LocalArtifactOpenabilityResult;
  let loadStarted = false;
  let cleanupError: unknown;
  let timeoutTimer: NodeJS.Timeout | undefined;
  try {
    const electron = await import('electron');
    if (!electron.app?.isReady() || typeof electron.BrowserWindow !== 'function') {
      return skipped(
        startedAt,
        'html',
        'electron-browser-window',
        'Electron BrowserWindow 当前不可用，已跳过 HTML 真实打开验证。',
        'browserWindow=unavailable',
      );
    }

    verificationWindow = new electron.BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        javascript: true,
        nodeIntegration: false,
        partition: `uclaw-openability-${randomUUID()}`,
        sandbox: true,
        webSecurity: true,
      },
    });

    const webContents = verificationWindow.webContents;
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );

    const consoleErrors: string[] = [];
    const loadFailures: string[] = [];
    let fatalReject: (reason: unknown) => void = () => undefined;
    let timeoutReject: (reason: unknown) => void = () => undefined;
    const fatalPromise = new Promise<never>((_resolve, reject) => {
      fatalReject = reject;
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutReject = reject;
    });

    const onDidFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      const diagnostic = `code=${errorCode}; mainFrame=${isMainFrame}; description=${redactDiagnosticValue(errorDescription, [filePath])}`;
      loadFailures.push(diagnostic);
      fatalReject(new OpenabilityVerificationError('HTML_LOAD_FAILED', diagnostic));
    };
    const onRenderProcessGone = (
      _event: Electron.Event,
      details: Electron.RenderProcessGoneDetails,
    ): void => {
      fatalReject(new OpenabilityVerificationError(
        'HTML_RENDER_PROCESS_GONE',
        `reason=${details.reason}; exitCode=${details.exitCode}`,
      ));
    };
    const onConsoleMessage = (
      details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
      legacyLevel: number,
      legacyMessage: string,
    ): void => {
      const level = details.level ?? (legacyLevel === 3 ? 'error' : 'info');
      if (level !== 'error') return;
      const message = details.message || legacyMessage || 'console error';
      if (consoleErrors.length < 5) {
        consoleErrors.push(redactDiagnosticValue(message, [filePath]));
      }
    };

    webContents.on('did-fail-load', onDidFailLoad);
    webContents.on('render-process-gone', onRenderProcessGone);
    webContents.on('console-message', onConsoleMessage);
    timeoutTimer = setTimeout(() => {
      timeoutReject(new OpenabilityVerificationError('HTML_TIMEOUT', `timeoutMs=${timeoutMs}`));
    }, timeoutMs);

    try {
      loadStarted = true;
      await Promise.race([
        verificationWindow.loadFile(filePath),
        fatalPromise,
        timeoutPromise,
      ]);
      const smokeValue: unknown = await Promise.race([
        webContents.executeJavaScript(HTML_SMOKE_SCRIPT, true),
        fatalPromise,
        timeoutPromise,
      ]);
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, HTML_SETTLE_MS)),
        fatalPromise,
        timeoutPromise,
      ]);

      if (loadFailures.length > 0) {
        throw new OpenabilityVerificationError('HTML_LOAD_FAILED', loadFailures.join(' | '));
      }
      if (consoleErrors.length > 0) {
        throw new OpenabilityVerificationError('HTML_CONSOLE_ERROR', consoleErrors.join(' | '));
      }
      if (!isHtmlSmokeResult(smokeValue)) {
        throw new OpenabilityVerificationError('HTML_SMOKE_INVALID', 'invalid smoke result');
      }

      const domReady = smokeValue.readyState === 'complete'
        && smokeValue.bodyElementCount > 0
        && smokeValue.bodyTextLength > 0;
      const interactionReady = smokeValue.interactiveElementCount > 0
        && smokeValue.enabledInteractiveElementCount > 0
        && smokeValue.interactionDispatched;
      if (!domReady || !interactionReady) {
        throw new OpenabilityVerificationError(
          'HTML_SMOKE_FAILED',
          [
            `readyState=${smokeValue.readyState}`,
            `bodyElements=${smokeValue.bodyElementCount}`,
            `bodyTextLength=${smokeValue.bodyTextLength}`,
            `interactiveElements=${smokeValue.interactiveElementCount}`,
            `enabledInteractiveElements=${smokeValue.enabledInteractiveElementCount}`,
            `interactionDispatched=${smokeValue.interactionDispatched}`,
          ].join('; '),
        );
      }

      verificationResult = passed(
        startedAt,
        'html',
        'electron-browser-window',
        'HTML 产物已在隐藏 BrowserWindow 中真实加载，并通过最小 DOM/交互 smoke。',
        [
          `readyState=${smokeValue.readyState}`,
          `bodyElements=${smokeValue.bodyElementCount}`,
          `bodyTextLength=${smokeValue.bodyTextLength}`,
          `interactiveElements=${smokeValue.interactiveElementCount}`,
          `enabledInteractiveElements=${smokeValue.enabledInteractiveElementCount}`,
          'consoleErrors=0',
          'renderProcessGone=false',
        ].join('; '),
      );
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!webContents.isDestroyed()) {
        webContents.off('did-fail-load', onDidFailLoad);
        webContents.off('render-process-gone', onRenderProcessGone);
        webContents.off('console-message', onConsoleMessage);
      }
    }
  } catch (error) {
    verificationResult = loadStarted
      ? failed(
        startedAt,
        'html',
        'electron-browser-window',
        'HTML 产物未通过 Electron 真实打开验证。',
        safeDiagnostic(error, [filePath]),
      )
      : skipped(
        startedAt,
        'html',
        'electron-browser-window',
        'Electron BrowserWindow 当前无法创建，已跳过 HTML 真实打开验证。',
        safeDiagnostic(error, [filePath]),
      );
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (verificationWindow && !verificationWindow.isDestroyed()) {
      try {
        verificationWindow.destroy();
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError) {
    return loadStarted
      ? failed(
        startedAt,
        'html',
        'electron-browser-window',
        'HTML 真实打开验证窗口销毁失败。',
        safeDiagnostic(cleanupError, [filePath]),
      )
      : skipped(
        startedAt,
        'html',
        'electron-browser-window',
        'Electron HTML 验证工具不可用，且隐藏窗口清理失败。',
        safeDiagnostic(cleanupError, [filePath]),
      );
  }
  return verificationResult;
}

async function verifyMarkdownArtifact(
  filePath: string,
  timeoutMs: number,
  startedAt: number,
): Promise<LocalArtifactOpenabilityResult> {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const content = await readFile(filePath, { encoding: 'utf8', signal: controller.signal });
    return passed(
      startedAt,
      'markdown',
      'filesystem-read',
      'Markdown 产物可按 UTF-8 正常读取。',
      `chars=${content.length}; readable=true`,
    );
  } catch (error) {
    return failed(
      startedAt,
      'markdown',
      'filesystem-read',
      controller.signal.aborted
        ? `Markdown 读取验证超时（${timeoutMs}ms）。`
        : 'Markdown 产物无法正常读取。',
      safeDiagnostic(error, [filePath]),
    );
  } finally {
    clearTimeout(timeoutTimer);
  }
}

export async function verifyLocalArtifactOpenability(
  input: VerifyLocalArtifactOpenabilityInput,
): Promise<LocalArtifactOpenabilityResult> {
  const startedAt = Date.now();
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  const artifactType = artifactTypeForPath(filePath);

  if (artifactType === 'unsupported') {
    return skipped(
      startedAt,
      'unsupported',
      'none',
      filePath
        ? '该文件类型没有可用的真实打开验证器，已跳过。'
        : '未提供产物文件路径，无法执行真实打开验证。',
      filePath ? `extension=${extname(filePath).toLowerCase() || 'none'}` : 'filePath=missing',
    );
  }

  let fileSize: number;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return failed(
        startedAt,
        artifactType,
        artifactType === 'html'
          ? 'electron-browser-window'
          : artifactType === 'markdown'
            ? 'filesystem-read'
            : 'libreoffice-pdf',
        '产物路径不是普通文件，无法执行真实打开验证。',
        'isFile=false',
      );
    }
    fileSize = fileStat.size;
  } catch (error) {
    return failed(
      startedAt,
      artifactType,
      artifactType === 'html'
        ? 'electron-browser-window'
        : artifactType === 'markdown'
          ? 'filesystem-read'
          : 'libreoffice-pdf',
      '产物文件不存在或不可访问。',
      safeDiagnostic(error, [filePath]),
    );
  }

  if (fileSize <= 0) {
    return failed(
      startedAt,
      artifactType,
      artifactType === 'html'
        ? 'electron-browser-window'
        : artifactType === 'markdown'
          ? 'filesystem-read'
          : 'libreoffice-pdf',
      '产物文件为空，无法通过真实打开验证。',
      'fileBytes=0',
    );
  }

  const timeoutMs = normalizedTimeout(input.timeoutMs, defaultTimeoutForType(artifactType));
  if (artifactType === 'presentation' || artifactType === 'spreadsheet') {
    return await verifyOfficeArtifact(filePath, artifactType, timeoutMs, startedAt);
  }
  if (artifactType === 'html') {
    return await verifyHtmlArtifact(filePath, timeoutMs, startedAt);
  }
  return await verifyMarkdownArtifact(filePath, timeoutMs, startedAt);
}
