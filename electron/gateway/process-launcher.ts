import { app, utilityProcess } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import type { GatewayLaunchContext } from './config-sync';
import type { GatewayLifecycleState } from './process-policy';
import { logger } from '../utils/logger';
import { appendNodeRequireToNodeOptions } from '../utils/paths';

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

const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;

  globalThis.fetch = function clawxFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      delete flat['x-openrouter-title'];
      delete flat['X-OpenRouter-Title'];
      flat['HTTP-Referer'] = 'https://claw-x.com';
      flat['X-OpenRouter-Title'] = 'UClaw';
      init.headers = flat;
    }
    return _f.call(globalThis, input, init);
  };
})();
${GATEWAY_CHILD_PROCESS_PATCH_SOURCE}
`;

const DEFAULT_CLAWHUB_MIRROR_URL = 'https://mirror-cn.clawhub.com';

export function buildGatewayFetchPreloadSource(): string {
  return GATEWAY_FETCH_PRELOAD_SOURCE;
}

export function buildGatewayEntryWrapperSource(): string {
  return `'use strict';
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
    // best-effort
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
  onExit: (child: Electron.UtilityProcess, code: number | null) => void;
  onError: (error: Error) => void;
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

  const runtimeEnv = { ...forkEnv };

  if (!runtimeEnv.OPENCLAW_CLAWHUB_URL?.trim()) {
    runtimeEnv.OPENCLAW_CLAWHUB_URL = DEFAULT_CLAWHUB_MIRROR_URL;
  }

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
  runtimeEnv.OPENCLAW_DISABLE_BONJOUR = '1';
  runtimeEnv.CLAWX_OPENCLAW_ENTRY = entryScript;

  const gatewayEntryScript = ensureGatewayEntryWrapper();

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

    let settled = false;
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

    child.on('error', (error) => {
      logger.error('Gateway process spawn error:', error);
      options.onError(error);
      rejectOnce(error);
    });

    child.on('exit', (code: number) => {
      // Only check shouldReconnect — not current state.  On Windows the WS
      // close handler fires before the process exit handler and sets state to
      // 'stopped', which would make an unexpected crash look like a planned
      // shutdown in logs.  shouldReconnect is the reliable indicator: stop()
      // sets it to false (expected), crashes leave it true (unexpected).
      const expectedExit = !options.getShouldReconnect();
      const level = expectedExit ? logger.info : logger.warn;
      level(`Gateway process exited (code=${code}, expected=${expectedExit ? 'yes' : 'no'})`);
      options.onExit(child, code);
    });

    child.stderr?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        options.onStderrLine(line);
      }
    });

    child.on('spawn', () => {
      logger.info(`Gateway process started (pid=${child.pid})`);
      options.onSpawn(child.pid);
      resolveOnce();
    });
  });
}
