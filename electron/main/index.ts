import { app } from 'electron';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { installConsoleEpipeGuards, safeConsoleWrite } from '../utils/logger';
import { portableModeInfo } from '../utils/portable-bootstrap';
import {
  configurePortableOpenClawRuntime,
  resolvePortableOpenClawCacheRoot,
} from '../utils/portable-openclaw-runtime';

installConsoleEpipeGuards();

if (
  app.isPackaged
  && portableModeInfo.enabled
  && portableModeInfo.runtimeProfileDir
  && portableModeInfo.runtimeRootDir
  && portableModeInfo.portableId
) {
  try {
    configurePortableOpenClawRuntime({
      sourceDir: join(process.resourcesPath, 'openclaw'),
      profileDir: portableModeInfo.runtimeProfileDir,
      resourcesDir: process.resourcesPath,
      cacheRootDir: resolvePortableOpenClawCacheRoot(
        portableModeInfo.runtimeRootDir,
        portableModeInfo.portableId,
      ),
    });
  } catch (error) {
    // Identity validation happens before runtime modules are imported. Falling
    // back here is safe because no consumer has cached an OpenClaw path yet.
    delete process.env.CLAWX_OPENCLAW_RUNTIME_DIR;
    safeConsoleWrite('warn', `[portable] Local OpenClaw runtime cache is unavailable; using removable media: ${String(error)}`);
  }
}

void import('./app-runtime').catch((error) => {
  const errorRecord = typeof error === 'object' && error !== null
    ? error as { name?: unknown; code?: unknown }
    : null;
  const errorName = typeof errorRecord?.name === 'string'
    && /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/u.test(errorRecord.name)
    ? errorRecord.name
    : 'Error';
  const errorCode = typeof errorRecord?.code === 'string'
    && /^[A-Z0-9_-]{1,48}$/u.test(errorRecord.code)
    ? errorRecord.code
    : 'none';
  const classification = 'bootstrap_dynamic_import_failed';
  const fingerprint = createHash('sha256')
    .update(`${classification}\u0000${errorName}\u0000${errorCode}`, 'utf8')
    .digest('hex');
  safeConsoleWrite('error', `[ClawX] ${classification} errorName=${errorName} errorCode=${errorCode} fingerprint=${fingerprint}`);
  app.quit();
});
