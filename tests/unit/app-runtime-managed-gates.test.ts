// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('app runtime managed gate startup', () => {
  it('checks a packaged portable payload before runtime preparation or Gateway startup', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const initialize = source.slice(
      source.indexOf('async function initialize()'),
      source.indexOf('if (gotTheLock)'),
    );
    const migration = initialize.indexOf('await migratePortableDefaultWorkspaceConfig();');
    const packageGate = initialize.indexOf('runPortableFirstLaunchRepair({');
    const runtimePreparation = initialize.indexOf('prepareConfiguredPortableOpenClawRuntime();');
    const providerSync = initialize.indexOf('syncAllProviderAuthToRuntime(');

    expect(migration).toBeGreaterThan(-1);
    expect(packageGate).toBeGreaterThan(migration);
    expect(runtimePreparation).toBeGreaterThan(packageGate);
    expect(providerSync).toBeGreaterThan(packageGate);
    expect(initialize).toContain('Portable package integrity check blocked startup');
  });

  it('applies proxy settings before starting the non-blocking gate watcher and rule repair', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const initialize = source.slice(
      source.indexOf('async function initialize()'),
      source.indexOf('// Set application menu'),
    );
    const proxy = initialize.indexOf('await applyProxySettings();');
    const subscribe = initialize.indexOf('subscribeManagedClientRuntimeConfig(');
    const start = initialize.indexOf('startManagedClientRuntimeConfigRefresh();');

    expect(proxy).toBeGreaterThan(-1);
    expect(subscribe).toBeGreaterThan(proxy);
    expect(start).toBeGreaterThan(subscribe);
    expect(initialize).not.toContain('await longTermRuleService.repairKnownWorkspaces()');
    expect(initialize).toContain('void longTermRuleService.repairKnownWorkspaces()');
    expect(initialize).toContain('if (!wasEnabled && isEnabled)');
    expect(initialize).not.toContain('if (!isEnabled) {\n        void longTermRuleService.repairKnownWorkspaces()');
  });

  it('initializes Classic telemetry only through initialize after Electron is ready', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const initialize = source.slice(
      source.indexOf('async function initialize()'),
      source.indexOf('if (gotTheLock)'),
    );
    const readyLifecycle = source.slice(source.indexOf('app.whenReady().then('));

    expect(initialize).toContain('telemetryInitializationPromise = initTelemetry();');
    expect(initialize).toContain('await telemetryInitializationPromise;');
    expect(initialize).toContain('if (!managedRuntimeShutdownRequested)');
    expect(readyLifecycle).toContain('await initialize();');
    expect(readyLifecycle.indexOf('await initialize();')).toBeGreaterThan(
      readyLifecycle.indexOf('app.whenReady().then('),
    );
    expect(source.match(/\binitTelemetry\(\)/g)).toHaveLength(1);
  });

  it('starts dynamic managed config refresh before telemetry reads its initial gate', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const initialize = source.slice(
      source.indexOf('async function initialize()'),
      source.indexOf('// Set application menu'),
    );

    expect(initialize.indexOf('startManagedClientRuntimeConfigRefresh();')).toBeLessThan(
      initialize.indexOf('telemetryInitializationPromise = initTelemetry();'),
    );
  });

  it('defers managed Gateway startup until local auth, relay, and activation are ready', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const startup = source.slice(source.indexOf('// Start Gateway automatically'), source.indexOf('// Merge ClawX context'));

    expect(startup).toContain('getManagedAuthLocalStatus()');
    expect(startup).toContain('isManagedRuntimeReady(managedAuthStatus)');
    expect(startup).toContain("event: 'managed_gateway_start_deferred'");
    expect(startup.indexOf('getManagedAuthLocalStatus()')).toBeLessThan(
      startup.indexOf('syncAllProviderAuthToRuntime('),
    );
  });

  it('stops refresh, Main subscription, and telemetry through one memoized shutdown', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const stopServices = source.slice(
      source.indexOf('function stopManagedRuntimeServices()'),
      source.indexOf('function isPortableRuntimeWarning'),
    );
    const quitLifecycle = source.slice(source.indexOf("app.on('before-quit'"));

    expect(stopServices).toContain('if (managedRuntimeShutdownPromise) return managedRuntimeShutdownPromise;');
    expect(stopServices).toContain('managedRuntimeShutdownRequested = true;');
    expect(stopServices).toContain('stopManagedRuntimeConfigRefresh = null;');
    expect(stopServices).toContain('unsubscribeManagedRuntimeConfig = null;');
    expect(stopServices).toContain('await telemetryInitialization;');
    expect(stopServices).toContain('await shutdownTelemetry();');
    expect(quitLifecycle).toContain('const managedRuntimeShutdown = stopManagedRuntimeServices();');
    expect(quitLifecycle).toContain('await managedRuntimeShutdown;');
    expect(quitLifecycle.match(/stopManagedRuntimeServices\(\)/g)).toHaveLength(1);
  });

  it('routes portable snapshot warnings to the real warning sink', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const helper = source.slice(
      source.indexOf('function isPortableRuntimeWarning'),
      source.indexOf('const portableRuntimeSnapshotService'),
    );
    const callback = source.slice(
      source.indexOf('const portableRuntimeSnapshotService'),
      source.indexOf('function registerUclawRequestDiagnostics'),
    );

    expect(helper).toContain("descriptor.value === 'warning'");
    expect(callback).toContain('if (isPortableRuntimeWarning(details))');
    expect(callback).toContain('logger.warn(message, details);');
    expect(callback).toContain('logger.info(message, details);');
  });

  it('disposes active HTML preview servers during application shutdown', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const shutdown = source.slice(
      source.indexOf("app.on('before-quit'"),
      source.indexOf('// Best-effort Gateway cleanup'),
    );

    expect(shutdown).toContain('artifactTaskService.dispose()');
    expect(shutdown).toContain("logger.warn('artifactTaskService.dispose() error during quit:'");
  });

  it('isolates main Renderer failures and links fatal exit to Gateway force cleanup', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/app-runtime.ts'), 'utf8');
    const windowFactory = source.slice(
      source.indexOf('function createMainWindow()'),
      source.indexOf('/**\n * Initialize the application'),
    );
    expect(windowFactory).toContain("render-process-gone");
    expect(windowFactory).toContain("unresponsive");
    expect(windowFactory).toContain("webContents.reload()");
    expect(windowFactory).toContain('isQuitting()');
    expect(source).toContain('forceTerminateGateway: () => gatewayManager.forceTerminateOwnedProcessForQuit()');
  });
});
