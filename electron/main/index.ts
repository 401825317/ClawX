import { app } from 'electron';
import { join } from 'node:path';
import { portableModeInfo } from '../utils/portable-bootstrap';
import { configurePortableOpenClawRuntime } from '../utils/portable-openclaw-runtime';

if (app.isPackaged && portableModeInfo.enabled && portableModeInfo.runtimeProfileDir) {
  try {
    configurePortableOpenClawRuntime({
      sourceDir: join(process.resourcesPath, 'openclaw'),
      profileDir: portableModeInfo.runtimeProfileDir,
      resourcesDir: process.resourcesPath,
    });
  } catch (error) {
    // Identity validation happens before runtime modules are imported. Falling
    // back here is safe because no consumer has cached an OpenClaw path yet.
    delete process.env.CLAWX_OPENCLAW_RUNTIME_DIR;
    console.warn(`[portable] Local OpenClaw runtime cache is unavailable; using removable media: ${String(error)}`);
  }
}

void import('./app-runtime').catch((error) => {
  console.error('[ClawX] Application bootstrap failed:', error);
  app.quit();
});
