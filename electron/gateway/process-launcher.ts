import { app, utilityProcess } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'path';
import type { GatewayLaunchContext } from './config-sync';
import { stripEnvironmentKeys } from './config-sync-env';
import type { GatewayLifecycleState } from './process-policy';
import { logger } from '../utils/logger';
import { captureGatewayProcessException, captureHandledException } from '../utils/telemetry';
import { appendNodeRequireToNodeOptions } from '../utils/paths';
import {
  clearGatewayOwnershipRecordIfMatches,
  createGatewayOwnershipRecord,
  inspectWindowsGatewayProcess,
  markOwnedGatewayChildExited,
  registerOwnedGatewayChildMetadata,
  trackOwnedGatewayChild,
  writeGatewayOwnershipRecord,
  type GatewayOwnershipRecord,
} from './gateway-ownership';

export const OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS =
  'OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS';

const GATEWAY_STDERR_DRAIN_TIMEOUT_MS = 100;

const GATEWAY_SQLITE_PATH_PATCH_SOURCE = `
(function () {
  if (process.platform !== 'win32') return;
  try {
    var sqlite = require('node:sqlite');
    if (sqlite.__clawxWindowsLongPathPatched) return;
    var path = require('node:path');

    function toSqlitePath(value) {
      if (typeof value !== 'string') return value;
      if (value === ':memory:' || value.slice(0, 5).toLowerCase() === 'file:') return value;
      if (!path.win32.isAbsolute(value)) return value;
      return path.win32.toNamespacedPath(value);
    }

    var OriginalDatabaseSync = sqlite.DatabaseSync;
    if (typeof OriginalDatabaseSync === 'function') {
      sqlite.DatabaseSync = new Proxy(OriginalDatabaseSync, {
        construct: function (target, args, newTarget) {
          var normalizedArgs = Array.prototype.slice.call(args);
          if (normalizedArgs.length > 0) normalizedArgs[0] = toSqlitePath(normalizedArgs[0]);
          return Reflect.construct(target, normalizedArgs, newTarget);
        },
      });
    }

    var originalBackup = sqlite.backup;
    if (typeof originalBackup === 'function') {
      sqlite.backup = function () {
        var args = Array.prototype.slice.call(arguments);
        if (args.length > 1) args[1] = toSqlitePath(args[1]);
        return originalBackup.apply(this, args);
      };
    }

    Object.defineProperty(sqlite, '__clawxWindowsLongPathPatched', { value: true });
    var moduleApi = require('node:module');
    if (typeof moduleApi.syncBuiltinESMExports === 'function') {
      moduleApi.syncBuiltinESMExports();
    }
  } catch (e) {
    // Older development Node versions may not expose node:sqlite.
  }
})();
`;

const GATEWAY_CHILD_PROCESS_PATCH_SOURCE = `
(function () {
  function valueReferencesElectronExecPath(value, execPath) {
    if (!execPath) return false;
    if (typeof value === 'string') return value.indexOf(execPath) !== -1;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (valueReferencesElectronExecPath(value[i], execPath)) return true;
      }
    }
    return false;
  }

  function ensureElectronRunAsNodeForChildProcess(method, args) {
    var shouldPatch = false;
    try {
      shouldPatch = method === 'fork'
        || valueReferencesElectronExecPath(args[0], process.execPath)
        || valueReferencesElectronExecPath(args[1], process.execPath);
    } catch (e) {
      shouldPatch = false;
    }
    if (!shouldPatch) return args;

    var optIdx = -1;
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'function') break;
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        optIdx = i;
        break;
      }
    }

    var opts = optIdx >= 0 ? Object.assign({}, args[optIdx]) : {};
    var hasExplicitEnv = Object.prototype.hasOwnProperty.call(opts, 'env');
    var baseEnv = hasExplicitEnv && opts.env && typeof opts.env === 'object'
      ? opts.env
      : process.env;
    opts.env = Object.assign({}, baseEnv, { ELECTRON_RUN_AS_NODE: '1' });

    if (optIdx >= 0) {
      args[optIdx] = opts;
      return args;
    }

    if (typeof args[args.length - 1] === 'function') {
      args.splice(args.length - 1, 0, opts);
    } else {
      args.push(opts);
    }
    return args;
  }

  try {
    var cp = require('node:child_process');
    if (!cp.__clawxElectronRunAsNodePatched) {
      cp.__clawxElectronRunAsNodePatched = true;
      var methods = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'];
      methods.forEach(function(method) {
        var original = cp[method];
        if (typeof original !== 'function') return;
        cp[method] = function() {
          var args = Array.prototype.slice.call(arguments);
          ensureElectronRunAsNodeForChildProcess(method, args);
          if (process.platform === 'win32') {
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
          }
          return original.apply(this, args);
        };
      });
      try {
        var moduleApi = require('node:module');
        if (typeof moduleApi.syncBuiltinESMExports === 'function') {
          moduleApi.syncBuiltinESMExports();
        }
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
})();
`;

const GATEWAY_FETCH_PATCH_SOURCE = `
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;

  function assignHeaders(target, source) {
    if (!source) return;
    if (typeof source.forEach === 'function') {
      source.forEach(function (value, key) { target[key] = value; });
    } else if (Array.isArray(source)) {
      source.forEach(function (entry) {
        if (Array.isArray(entry) && entry.length >= 2) target[String(entry[0])] = String(entry[1]);
      });
    } else if (typeof source === 'object') {
      Object.assign(target, source);
    }
  }

  function findHeaderKey(headers, name) {
    var expected = String(name).toLowerCase();
    return Object.keys(headers).find(function (key) { return key.toLowerCase() === expected; });
  }

  function setDefaultHeader(headers, name, value) {
    if (!findHeaderKey(headers, name) && typeof value === 'string' && value) {
      headers[name] = value;
    }
  }

  function removeHeader(headers, name) {
    var key = findHeaderKey(headers, name);
    if (key) delete headers[key];
  }

  var diagnosticHeaders = {};
  try {
    var parsedDiagnostics = JSON.parse(process.env.CLAWX_UCLAW_DIAGNOSTIC_HEADERS || '{}');
    if (parsedDiagnostics && typeof parsedDiagnostics === 'object' && !Array.isArray(parsedDiagnostics)) {
      diagnosticHeaders = parsedDiagnostics;
    }
  } catch (e) {
    diagnosticHeaders = {};
  }

  var uclawOrigin = '';
  try {
    uclawOrigin = new URL(process.env.CLAWX_UCLAW_ORIGIN || '').origin;
  } catch (e) {
    uclawOrigin = '';
  }

  globalThis.fetch = function clawxFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    var isUclawRequest = false;
    try {
      isUclawRequest = Boolean(uclawOrigin) && new URL(url).origin === uclawOrigin;
    } catch (e) {
      isUclawRequest = false;
    }

    if (url.indexOf('openrouter.ai') !== -1 || isUclawRequest) {
      init = init ? Object.assign({}, init) : {};
      var flat = {};
      if (input && typeof input === 'object') assignHeaders(flat, input.headers);
      assignHeaders(flat, init.headers);
      if (url.indexOf('openrouter.ai') !== -1) {
        removeHeader(flat, 'http-referer');
        removeHeader(flat, 'x-title');
        removeHeader(flat, 'x-openrouter-title');
        flat['HTTP-Referer'] = 'https://claw-x.com';
        flat['X-OpenRouter-Title'] = 'ClawX';
      }
      if (isUclawRequest) {
        Object.keys(diagnosticHeaders).forEach(function (key) {
          removeHeader(flat, key);
          flat[key] = diagnosticHeaders[key];
        });
        try {
          removeHeader(flat, 'X-Request-Id');
          flat['X-Request-Id'] = require('node:crypto').randomUUID();
        } catch (e) {
          // The server still supplies its own request id if crypto is unavailable.
        }
      }
      init.headers = flat;
    }
    if (!isUclawRequest) return _f.call(globalThis, input, init);

    init.redirect = 'manual';
    return (async function () {
      var currentInput = input;
      var currentUrl = url;
      var currentInit = init;
      for (var redirects = 0; ; redirects += 1) {
        var response = await _f.call(globalThis, currentInput, currentInit);
        if (!response || response.status < 300 || response.status >= 400 || redirects >= 5) {
          return response;
        }
        var location = response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('location') : '';
        if (!location) return response;
        var nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch (e) {
          return response;
        }
        if (nextUrl.origin !== uclawOrigin) return response;

        var method = String(currentInit.method || (currentInput && currentInput.method) || 'GET').toUpperCase();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          currentInit = Object.assign({}, currentInit, { method: 'GET', body: undefined });
          var redirectedHeaders = {};
          assignHeaders(redirectedHeaders, currentInit.headers);
          removeHeader(redirectedHeaders, 'content-length');
          removeHeader(redirectedHeaders, 'content-type');
          currentInit.headers = redirectedHeaders;
        } else if (method !== 'GET' && method !== 'HEAD' && !Object.prototype.hasOwnProperty.call(currentInit, 'body')) {
          // A Request object's consumed body cannot be replayed safely.
          return response;
        }
        currentInput = nextUrl.toString();
        currentUrl = nextUrl.toString();
      }
    })();
  };
})();
`;

const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
${GATEWAY_SQLITE_PATH_PATCH_SOURCE}
${GATEWAY_FETCH_PATCH_SOURCE}
${GATEWAY_CHILD_PROCESS_PATCH_SOURCE}
`;

export function buildGatewayFetchPreloadSource(): string {
  return GATEWAY_FETCH_PRELOAD_SOURCE;
}

/** Build the packaged-safe wrapper that patches fetch and child processes before OpenClaw loads. */
export function buildGatewayEntryWrapperSource(): string {
  return `'use strict';
${GATEWAY_SQLITE_PATH_PATCH_SOURCE}
${GATEWAY_FETCH_PATCH_SOURCE}
${GATEWAY_CHILD_PROCESS_PATCH_SOURCE}
(async function () {
  var entry = process.env.CLAWX_OPENCLAW_ENTRY;
  if (!entry) {
    throw new Error('CLAWX_OPENCLAW_ENTRY is required to launch OpenClaw Gateway');
  }
  process.argv[1] = entry;
  var pathToFileURL = require('node:url').pathToFileURL;
  await import(pathToFileURL(entry).href);
})().catch(function (error) {
  var message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  process.stderr.write('[clawx-gateway-wrapper] ' + message + '\\n');
  process.exit(1);
});
`;
}

export function buildGatewayRuntimeEnv(
  forkEnv: Record<string, string | undefined>,
  allowOlderBinaryDestructiveActions = false,
): Record<string, string | undefined> {
  const runtimeEnv = stripEnvironmentKeys({
    ...forkEnv,
    // ClawX does not expose LAN discovery, so keep Bonjour disabled even if
    // the parent process inherited an explicit opt-in value.
    OPENCLAW_DISABLE_BONJOUR: '1',
    // OpenClaw's built-in trace contains stage names and timings only. Keep it
    // enabled so packaged startup incidents are diagnosable from normal logs.
    OPENCLAW_GATEWAY_STARTUP_TRACE: '1',
    // Avoid detached media tasks in UClaw chat sessions. Their completion has
    // to cross a second session write lock and can otherwise be lost.
    UCLAW_SYNC_MEDIA_GENERATION: '1',
  }, [OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS]);

  // Never inherit this destructive override from the parent process.
  if (allowOlderBinaryDestructiveActions) {
    runtimeEnv[OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS] = '1';
  }
  return runtimeEnv;
}

function ensureGatewayFetchPreload(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-fetch-preload.cjs');
  try {
    writeFileSync(dest, GATEWAY_FETCH_PRELOAD_SOURCE, 'utf-8');
  } catch {
    // best-effort
  }
  return dest;
}

function ensureGatewayEntryWrapper(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-entry-wrapper.cjs');
  try {
    writeFileSync(dest, buildGatewayEntryWrapperSource(), 'utf-8');
  } catch {
    // best-effort; the fork error will include the missing wrapper path
  }
  return dest;
}

export async function launchGatewayProcess(options: {
  port: number;
  launchContext: GatewayLaunchContext;
  sanitizeSpawnArgs: (args: string[]) => string[];
  getCurrentState: () => GatewayLifecycleState;
  getShouldReconnect: () => boolean;
  onStderrLine: (line: string) => void;
  onSpawn: (pid: number | undefined) => void;
  /** Called synchronously from the spawn event before the launch promise resolves. */
  onSpawnChild?: (child: Electron.UtilityProcess) => void;
  onExit: (child: Electron.UtilityProcess, code: number | null) => void;
  onError: (child: Electron.UtilityProcess, error: Error) => void;
  allowOlderBinaryDestructiveActions?: boolean;
}): Promise<{ child: Electron.UtilityProcess; lastSpawnSummary: string }> {
  const {
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  } = options.launchContext;

  logger.info(
    `Starting Gateway process (mode=${mode}, port=${options.port}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount}, channels=${channelStartupSummary}, proxy=${proxySummary})`,
  );
  const lastSpawnSummary = `mode=${mode}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}"`;

  const runtimeEnv = buildGatewayRuntimeEnv(
    forkEnv,
    options.allowOlderBinaryDestructiveActions,
  );
  runtimeEnv.CLAWX_OPENCLAW_ENTRY = entryScript;
  const gatewayEntryScript = ensureGatewayEntryWrapper();

  // Disable OpenClaw's mDNS/Bonjour gateway advertiser unconditionally.
  //
  // The OpenClaw gateway advertises `_openclaw-gw._tcp.local` on every
  // active network interface using a hardcoded `openclaw.local` hostname,
  // which causes:
  //   - cross-machine name collisions when multiple OpenClaw/ClawX peers
  //     share a LAN (each falls back to "<name> (OpenClaw) (2)")
  //   - self-collisions on multi-homed hosts (Wi-Fi + Tailscale + utun ...)
  //   - "ghost" record collisions after an unclean ClawX exit, because
  //     SIGKILL prevents ciao from emitting the mDNS goodbye record.
  //
  // ClawX has no UI for LAN gateway discovery today, so the advertiser is
  // pure log noise.  `OPENCLAW_DISABLE_BONJOUR=1` short-circuits
  // `startGatewayBonjourAdvertiser()` (openclaw `src/infra/bonjour.ts`,
  // `isDisabledByEnv()`).  Set after the `forkEnv` spread so any
  // pre-existing value inherited from the user shell cannot re-enable it.
  // buildGatewayRuntimeEnv() applies both this policy and startup tracing
  // before any development-only environment augmentation below.

  // Only apply the fetch/child_process preload in dev mode.
  // In packaged builds Electron's UtilityProcess rejects NODE_OPTIONS
  // with --require, logging "Most NODE_OPTIONs are not supported in
  // packaged apps" and the preload never loads.
  if (!app.isPackaged) {
    try {
      const preloadPath = ensureGatewayFetchPreload();
      if (existsSync(preloadPath)) {
        runtimeEnv.NODE_OPTIONS = appendNodeRequireToNodeOptions(
          runtimeEnv.NODE_OPTIONS,
          preloadPath,
        );
      }
    } catch (err) {
      logger.warn('Failed to set up OpenRouter headers preload:', err);
    }
  }

  return await new Promise<{ child: Electron.UtilityProcess; lastSpawnSummary: string }>((resolve, reject) => {
    const child = utilityProcess.fork(gatewayEntryScript, gatewayArgs, {
      cwd: openclawDir,
      stdio: 'pipe',
      env: runtimeEnv as NodeJS.ProcessEnv,
      serviceName: 'OpenClaw Gateway',
    });
    trackOwnedGatewayChild(child);

    let settled = false;
    let childExited = false;
    let errorHandled = false;
    let exitEventHandled = false;
    let exitCallbackCalled = false;
    let stderrFinalized = !child.stderr;
    let stderrLineBuffer = '';
    const stderrDecoder = new StringDecoder('utf8');
    let pendingExit: { code: number | null } | null = null;
    let exitDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let ownershipRecord: GatewayOwnershipRecord | null = null;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve({ child, lastSpawnSummary });
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const clearOwnershipRecord = async (): Promise<void> => {
      if (!ownershipRecord) return;
      const record = ownershipRecord;
      ownershipRecord = null;
      try {
        await clearGatewayOwnershipRecordIfMatches(record);
      } catch {
        // A stale record only reduces crash-recovery convenience. It must never
        // affect the process lifecycle or be deleted without an exact match.
      }
    };

    const persistOwnershipRecord = async (): Promise<void> => {
      const pid = child.pid;
      if (!pid || process.platform !== 'win32' || childExited) return;
      const identity = await inspectWindowsGatewayProcess(pid);
      if (childExited) return;
      if (!identity) {
        logger.warn(`Gateway process started without a verifiable creation identity (pid=${pid}); orphan takeover disabled`);
        return;
      }
      if (!identity.commandIdentityHash) {
        logger.warn(`Gateway process started without a canonical command identity hash (pid=${pid}); orphan takeover disabled`);
        return;
      }
      const token = runtimeEnv.OPENCLAW_GATEWAY_TOKEN;
      if (!token) {
        logger.warn(`Gateway process started without an ownership token hash (pid=${pid}); orphan takeover disabled`);
        return;
      }
      try {
        const record = await createGatewayOwnershipRecord({
          pid,
          processCreationIdentity: identity.creationIdentity,
          runtimeRoot: openclawDir,
          token,
        });
        if (childExited) return;
        await writeGatewayOwnershipRecord(record);
        ownershipRecord = record;
        if (childExited) {
          await clearOwnershipRecord();
          return;
        }
        registerOwnedGatewayChildMetadata(child, {
          record,
          processIdentity: identity,
          port: options.port,
        });
      } catch {
        logger.warn(`Failed to persist Gateway ownership record (pid=${pid}); orphan takeover disabled`);
      }
    };

    const clearExitDrainTimer = (): void => {
      if (!exitDrainTimer) return;
      clearTimeout(exitDrainTimer);
      exitDrainTimer = null;
    };

    const notifyExitOnce = (): void => {
      if (!stderrFinalized || !pendingExit || exitCallbackCalled) return;
      const { code } = pendingExit;
      pendingExit = null;
      exitCallbackCalled = true;
      clearExitDrainTimer();
      options.onExit(child, code);
    };

    const emitBufferedStderrLines = (): void => {
      let newlineIndex = stderrLineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        let line = stderrLineBuffer.slice(0, newlineIndex);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        options.onStderrLine(line);
        newlineIndex = stderrLineBuffer.indexOf('\n');
      }
    };

    const finalizeStderr = (): void => {
      if (stderrFinalized) return;
      stderrFinalized = true;
      clearExitDrainTimer();

      try {
        stderrLineBuffer += stderrDecoder.end();
        emitBufferedStderrLines();
        if (stderrLineBuffer.length > 0) {
          const line = stderrLineBuffer.endsWith('\r')
            ? stderrLineBuffer.slice(0, -1)
            : stderrLineBuffer;
          stderrLineBuffer = '';
          options.onStderrLine(line);
        }
      } finally {
        // The process exit callback must observe every line that arrived
        // before the stream closed, even if a consumer callback throws.
        notifyExitOnce();
      }
    };

    child.on('error', (error: unknown) => {
      if (errorHandled) return;
      errorHandled = true;
      childExited = true;
      markOwnedGatewayChildExited(child);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Gateway process spawn error:', error);
      captureHandledException(normalizedError, { subsystem: 'gateway', phase: 'spawn' });
      void clearOwnershipRecord();
      rejectOnce(normalizedError);
      try {
        options.onError(child, normalizedError);
      } catch (callbackError) {
        // Preserve the original spawn error if a caller's error callback
        // fails while the launch promise is still being settled.
        logger.error('Gateway process error callback failed:', callbackError);
      }
    });

    child.on('exit', (code: number) => {
      if (exitEventHandled) return;
      exitEventHandled = true;
      childExited = true;
      markOwnedGatewayChildExited(child);
      void clearOwnershipRecord();
      // Only check shouldReconnect — not current state.  On Windows the WS
      // close handler fires before the process exit handler and sets state to
      // 'stopped', which would make an unexpected crash look like a planned
      // shutdown in logs.  shouldReconnect is the reliable indicator: stop()
      // sets it to false (expected), crashes leave it true (unexpected).
      const expectedExit = !options.getShouldReconnect();
      const level = expectedExit ? logger.info : logger.warn;
      level(`Gateway process exited (code=${code}, expected=${expectedExit ? 'yes' : 'no'})`);
      if (!expectedExit) {
        captureGatewayProcessException(
          new Error(`Gateway process exited unexpectedly with code ${code}`),
          { phase: 'exit', exitCode: code },
        );
      }
      pendingExit = { code };
      if (stderrFinalized) {
        notifyExitOnce();
      } else {
        exitDrainTimer = setTimeout(finalizeStderr, GATEWAY_STDERR_DRAIN_TIMEOUT_MS);
        exitDrainTimer.unref?.();
      }
    });

    child.stderr?.on('data', (data) => {
      if (stderrFinalized) return;
      const chunk = typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.isBuffer(data) || data instanceof Uint8Array
          ? data
          : Buffer.from(String(data));
      stderrLineBuffer += stderrDecoder.write(chunk);
      emitBufferedStderrLines();
    });
    child.stderr?.once('end', finalizeStderr);
    child.stderr?.once('close', finalizeStderr);
    child.stderr?.once('error', finalizeStderr);

    // UtilityProcess pipes must always be consumed. Gateway writes routine
    // diagnostics to stdout; leaving this pipe unread eventually blocks the
    // child and looks like a transport or heartbeat failure.
    child.stdout?.on('data', () => undefined);

    child.on('spawn', () => {
      logger.info(`Gateway process started (pid=${child.pid})`);
      options.onSpawnChild?.(child);
      options.onSpawn(child.pid);
      resolveOnce();
      // Ownership metadata improves crash recovery but is not a launch gate.
      // WMI can be slower than a child that fails during ESM initialization;
      // resolving first lets the manager retain the child and report its real
      // exit code/stderr instead of an ownership initialization wrapper error.
      void persistOwnershipRecord();
    });
  });
}
