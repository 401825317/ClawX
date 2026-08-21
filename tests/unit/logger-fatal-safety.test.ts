// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => 'test',
  },
}));

import { __test, initLogger, logger } from '@electron/utils/logger';
import { createFatalHandler } from '@electron/main/fatal-handler';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger and fatal-path safety', () => {
  it('permanently disables stdout sinks after an asynchronous EPIPE event', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    process.stdout.emit('error', Object.assign(new Error('stdout closed'), { code: 'EPIPE' }));

    expect(() => logger.info('async EPIPE-safe message')).not.toThrow();
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(logger.getRecentLogs(1)[0]).toContain('async EPIPE-safe message');
  });

  it('permanently disables a console sink after EPIPE while retaining aggregated logs', () => {
    vi.useFakeTimers();
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      throw brokenPipe;
    });

    expect(() => logger.error('first EPIPE-safe message')).not.toThrow();
    expect(() => logger.error('second EPIPE-safe message')).not.toThrow();
    vi.advanceTimersByTime(1_000);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(logger.getRecentLogs(2).join('\n')).toContain('second EPIPE-safe message');
    vi.useRealTimers();
  });

  it('disables a console sink after any synchronous sink failure', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw Object.assign(new Error('stream unavailable'), { code: 'EIO' });
    });
    process.stderr.emit('error', Object.assign(new Error('non-pipe stream error'), { code: 'EIO' }));

    expect(() => logger.warn('first console-failure-safe message')).not.toThrow();
    expect(() => logger.warn('second console-failure-safe message')).not.toThrow();

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(logger.getRecentLogs(2).join('\n')).toContain('second console-failure-safe message');
  });

  it('installs bootstrap guards before output and keeps file logging after EPIPE', async () => {
    const bootstrapSource = await readFile(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const installAt = bootstrapSource.indexOf('installConsoleEpipeGuards();');
    const firstOutputAt = bootstrapSource.indexOf("safeConsoleWrite('warn'");
    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(firstOutputAt).toBeGreaterThan(installAt);

    initLogger();
    process.stderr.emit('error', Object.assign(new Error('stderr closed'), { code: 'EPIPE' }));
    logger.warn('file survives bootstrap EPIPE');
    __test.flushBufferSync();

    const path = logger.getLogFilePath();
    expect(path).not.toBeNull();
    expect(await readFile(path!, 'utf8')).toContain('file survives bootstrap EPIPE');
  });

  it('redacts Gateway stderr raw_params text using a deterministic UTF-8 summary', () => {
    const secret = '用户提示词🔒';
    const bytes = Buffer.from(secret, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    logger.warn(`[Gateway stderr] tool failed raw_params=${JSON.stringify(secret)} requestId=req-safe`);

    const line = logger.getRecentLogs(1)[0];
    expect(line).not.toContain(secret);
    expect(line).toContain(`raw_params={"redacted":true,"bytes":${bytes.byteLength},"sha256":"${sha256}"}`);
    expect(line).toContain('requestId=req-safe');
  });

  it('preserves adjacent diagnostics after an unquoted raw_params value', () => {
    logger.warn('tool failed raw_params=private-payload requestId=req-safe outcome=retry');

    const line = logger.getRecentLogs(1)[0];
    expect(line).not.toContain('private-payload');
    expect(line).toContain('requestId=req-safe');
    expect(line).toContain('outcome=retry');
  });

  it('redacts JSON-shaped rawParams text without consuming adjacent diagnostics', () => {
    const rawParams = { prompt: '不要写进日志', count: 2 };
    const canonical = JSON.stringify({ count: 2, prompt: '不要写进日志' });
    const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');

    logger.warn(`[Gateway stderr] {"rawParams":${JSON.stringify(rawParams)},"traceId":"trace-safe"}`);

    const line = logger.getRecentLogs(1)[0];
    expect(line).not.toContain('不要写进日志');
    expect(line).toContain(`"rawParams":{"redacted":true,"bytes":${Buffer.byteLength(canonical)},"sha256":"${sha256}"}`);
    expect(line).toContain('"traceId":"trace-safe"');
  });

  it('recursively summarizes structured raw_params and rawParams without exposing content', () => {
    const firstSecret = 'first private prompt';
    const secondSecret = { prompt: 'second private prompt' };
    const firstHash = createHash('sha256').update(firstSecret, 'utf8').digest('hex');
    const secondCanonical = JSON.stringify(secondSecret);
    const secondHash = createHash('sha256').update(secondCanonical, 'utf8').digest('hex');

    logger.info('structured params', {
      safe: 'visible-context',
      nested: {
        raw_params: firstSecret,
        deeper: [{ rawParams: secondSecret }],
      },
    });

    const line = logger.getRecentLogs(1)[0];
    expect(line).toContain('visible-context');
    expect(line).not.toContain(firstSecret);
    expect(line).not.toContain('second private prompt');
    expect(line).toContain(firstHash);
    expect(line).toContain(secondHash);
    expect(line.match(/"redacted": true/gu)).toHaveLength(2);
  });

  it('never invokes structured accessors while hashing raw params or extracting correlation', () => {
    const getter = vi.fn(() => 'ACCESSOR_SECRET');
    const rawParams: unknown[] = [];
    Object.defineProperty(rawParams, '0', { enumerable: true, get: getter });
    const details = Object.defineProperties({ raw_params: rawParams, count: 7n }, {
      traceId: { enumerable: true, get: getter },
    });

    expect(() => logger.info('accessor-safe diagnostics', details)).not.toThrow();

    const line = logger.getRecentLogs(1)[0];
    expect(getter).not.toHaveBeenCalled();
    expect(line).not.toContain('ACCESSOR_SECRET');
    expect(line).toContain('"count": "7n"');
    expect(line).toContain('"redacted": true');
    expect(line).not.toContain('traceId=');
  });

  it('fails closed for hostile structured values without breaking error logging', () => {
    const hostile = new Proxy({}, {
      ownKeys: () => { throw new Error('ownKeys must not escape'); },
      getPrototypeOf: () => { throw new Error('getPrototypeOf must not escape'); },
    });

    expect(() => logger.error('hostile diagnostics', hostile)).not.toThrow();
    expect(logger.getRecentLogs(1)[0]).toContain('[Unserializable]');
  });

  it('redacts raw_params in Error details while retaining a useful stack', () => {
    const failure = new Error('provider rejected raw_params="private-error-payload"');
    failure.stack = `${failure.name}: ${failure.message}\n    at gatewayCall (gateway.ts:42:5)`;

    logger.error('Gateway call failed', failure);

    const line = logger.getRecentLogs(1)[0];
    expect(line).not.toContain('private-error-payload');
    expect(line).toContain('provider rejected raw_params={"redacted":true');
    expect(line).toContain('at gatewayCall (gateway.ts:42:5)');
  });

  it('adds structured correlation without writing credentials, prompts, or user paths', () => {
    const token = 'sk-never-write-this-token';
    const apiKey = 'api-key-never-write-this';
    const prompt = 'do not persist this user prompt';
    logger.warn('provider request failed', {
      traceId: 'trace-123',
      runId: 'run-456',
      attempt: 2,
      token,
      apiKey,
      prompt,
      sourcePath: 'C:\\Users\\Alice\\Documents\\private.txt',
    });

    const line = logger.getRecentLogs(1)[0];
    expect(line).toMatch(/eventId=[0-9a-f-]{36}/u);
    expect(line).toContain('traceId=trace-123');
    expect(line).toContain('runId=run-456');
    expect(line).toContain('attempt=2');
    expect(line).not.toContain(token);
    expect(line).not.toContain(apiKey);
    expect(line).not.toContain(prompt);
    expect(line).not.toContain('C:\\Users\\Alice');
    expect(line).toContain('[UserPath]');
    expect(line).not.toContain('sha256');
  });

  it('redacts arbitrary local absolute paths without corrupting network URLs', () => {
    const networkUrl = 'https://example.test/api/v1/files/C:/literal?next=/tmp/demo';
    logger.info('absolute path contract', {
      drivePath: 'F:\\Portable UClaw\\resources\\app.asar',
      forwardDrivePath: 'Z:/Portable/UClaw/config.json',
      uncPath: '\\\\fileserver\\private-share\\customer\\state.json',
      devicePath: '\\\\?\\D:\\portable\\runtime.db',
      posixPath: '/opt/uclaw/private/openclaw.json',
      escapedJson: '{"cwd":"Q:\\\\Portable Folder\\\\resources"}',
      fileUrl: 'file:///E:/Portable%20UClaw/private.json',
      networkUrl,
    });

    const line = logger.getRecentLogs(1)[0];
    expect(line).toContain(networkUrl);
    expect(line).toContain('file:///[UserPath]');
    expect(line.match(/\[UserPath\]/gu)?.length).toBeGreaterThanOrEqual(7);
    for (const secretFragment of [
      'Portable UClaw',
      'Portable Folder',
      'fileserver',
      'private-share',
      'runtime.db',
      '/opt/uclaw',
      'E:/Portable%20UClaw',
    ]) {
      expect(line).not.toContain(secretFragment);
    }
  });

  it('preserves URL schemes and paths while still redacting sensitive query values', () => {
    const redacted = __test.redactSensitiveText(
      'endpoint=https://api.example.test/v1/C:/models?token=top-secret&next=/tmp/remote '
      + 'socket=wss://alice:password@relay.example.test/openclaw/session?refresh_token=refresh-secret&signature=signed-secret '
      + 'encoded=https://api.example.test/call?access%5Ftoken=encoded-secret',
    );

    expect(redacted).toContain('https://api.example.test/v1/C:/models?token=[redacted]&next=/tmp/remote');
    expect(redacted).toContain('wss://[credentials-redacted]@relay.example.test/openclaw/session?refresh_token=[redacted]&signature=[redacted]');
    expect(redacted).toContain('https://api.example.test/call?access%5Ftoken=[redacted]');
    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('alice:password');
    expect(redacted).not.toContain('refresh-secret');
    expect(redacted).not.toContain('signed-secret');
    expect(redacted).not.toContain('encoded-secret');
    expect(redacted).not.toContain('[UserPath]');
  });

  it('recognizes arbitrarily percent-encoded sensitive URL keys and encoded absolute paths', () => {
    const redacted = __test.redactSensitiveText(
      'https://example.test/call?%74%6f%6b%65%6e=secret-one'
      + '&%61pi%5fkey=secret-two&%2561%2575%2574%2568=secret-three'
      + '&win=C%3A%5CUsers%5CAlice%5Cprivate.txt'
      + '&unix=%2Fhome%2Falice%2Fprivate.json&relative=docs%2Fpublic.txt',
    );

    expect(redacted).toContain('%74%6f%6b%65%6e=[redacted]');
    expect(redacted).toContain('%61pi%5fkey=[redacted]');
    expect(redacted).toContain('%2561%2575%2574%2568=[redacted]');
    expect(redacted).toContain('win=[UserPath]');
    expect(redacted).toContain('unix=[UserPath]');
    expect(redacted).toContain('relative=docs%2Fpublic.txt');
    expect(redacted).not.toMatch(/secret-one|secret-two|secret-three|Alice|private\.json/u);
  });

  it('redacts unkeyed provider tokens and JWTs in free-form errors', () => {
    const token = 'sk-unkeyed-secret-12345678';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature12345678';

    logger.error(`provider failed with ${token} and ${jwt}`);

    const line = logger.getRecentLogs(1)[0];
    expect(line).not.toContain(token);
    expect(line).not.toContain(jwt);
    expect(line.match(/\[secret-redacted\]/gu)).toHaveLength(2);
  });

  it('redacts command and stack paths without consuming adjacent diagnostics', () => {
    const redacted = __test.redactSensitiveText([
      'entry=R:\\UClaw\\resources\\main.js cwd=S:/workspace/profile status=starting',
      'Error at \\\\server\\private\\index.js:4:2 code=EIO',
      'at /srv/uclaw/index.mjs:3:1 requestId=req-safe',
      'quoted="/var/lib/uclaw/data file.json" outcome=failed',
    ].join('\n'));

    expect(redacted).toContain('entry=[UserPath] cwd=[UserPath] status=starting');
    expect(redacted).toContain('Error at [UserPath] code=EIO');
    expect(redacted).toContain('at [UserPath] requestId=req-safe');
    expect(redacted).toContain('quoted="[UserPath]" outcome=failed');
    expect(redacted).not.toMatch(/R:\\|S:\/|server|\/srv\/|\/var\/lib\//u);
  });

  it('aggregates repeated errors while retaining first and last complete contexts', () => {
    vi.useFakeTimers();
    const before = logger.getRecentLogs().length;

    logger.error('Gateway retry failed', { traceId: 'first-trace', attempt: 1, reason: 'closed' });
    logger.error('Gateway retry failed', { traceId: 'first-trace', attempt: 1, reason: 'closed' });
    logger.error('Gateway retry failed', { traceId: 'first-trace', attempt: 1, reason: 'closed' });
    vi.advanceTimersByTime(1_000);

    const lines = logger.getRecentLogs().slice(before);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Gateway retry failed');
    expect(lines[1]).toMatch(/\[duplicate-error\] eventId=[0-9a-f-]{36} count=3/u);
    expect(lines[1]).toContain('first=');
    expect(lines[1]).toContain('last=');
    vi.useRealTimers();
  });

  it('truncates oversized log entries only at a complete UTF-8 boundary', () => {
    const bounded = __test.boundedLogLine(`prefix-${'界'.repeat(30)}`, 64);

    expect(bounded.byteLength).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(bounded.line, 'utf8')).toBe(bounded.byteLength);
    expect(bounded.line).not.toContain('\uFFFD');
    expect(bounded.line).toContain('[log entry truncated at 20MB]');
  });

  it('runs fatal cleanup, emergency logging, capture, and exit scheduling once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-fatal-handler-'));
    const emergencyLog = join(root, 'fatal.log');
    const stopGateway = vi.fn(async () => undefined);
    const stopBlender = vi.fn(async () => undefined);
    const captureFatal = vi.fn();
    const exit = vi.fn();
    let scheduled: (() => void) | undefined;
    const scheduleExit = vi.fn((callback: () => void) => {
      scheduled = callback;
    });
    try {
      const handler = createFatalHandler({
        getEmergencyLogPath: () => emergencyLog,
        stopGateway,
        stopBlender,
        captureFatal,
        exit,
        scheduleExit,
      });

      expect(handler('uncaught exception', new Error('primary failure'))).toBe(true);
      expect(handler('unhandled rejection', new Error('secondary failure'))).toBe(false);

      expect(stopGateway).toHaveBeenCalledTimes(1);
      expect(stopBlender).toHaveBeenCalledTimes(1);
      expect(captureFatal).toHaveBeenCalledTimes(1);
      expect(scheduleExit).toHaveBeenCalledWith(expect.any(Function), 3000);
      const written = await readFile(emergencyLog, 'utf8');
      expect(written).not.toContain('primary failure');
      expect(written).not.toContain('secondary failure');
      expect(written).toContain('uncaught_exception');
      expect(captureFatal).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'uncaught_exception',
        errorName: 'Error',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }));

      scheduled?.();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
