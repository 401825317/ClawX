import { app } from 'electron';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getPortableModeInfo } from '../utils/portable-mode';

const PORTABLE_UPDATE_READY_PATH = 'UCLAW_PORTABLE_UPDATE_READY_PATH';

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

/**
 * The portable updater passes a one-shot marker path to the restarted app.
 * Writing it only after the renderer is ready lets the helper distinguish a
 * successful relaunch from a process that merely started and exited again.
 */
export async function writePortableUpdateReadyMarker(): Promise<boolean> {
  const requestedPath = process.env[PORTABLE_UPDATE_READY_PATH]?.trim();
  if (!requestedPath) {
    return false;
  }

  const portable = getPortableModeInfo();
  if (!app.isPackaged || !portable.enabled || !portable.runtimeUpdatesDir) {
    throw new Error('Portable update startup marker was requested outside portable packaged mode');
  }

  const readyRoot = resolve(portable.runtimeUpdatesDir, 'ready');
  const readyPath = resolve(requestedPath);
  if (!isPathInside(readyRoot, readyPath)) {
    throw new Error('Portable update startup marker path is outside the runtime ready directory');
  }

  await mkdir(dirname(readyPath), { recursive: true });
  const temporaryPath = `${readyPath}.${process.pid}.tmp`;
  const marker = JSON.stringify({
    version: app.getVersion(),
    pid: process.pid,
    readyAt: new Date().toISOString(),
  });
  try {
    await writeFile(temporaryPath, `${marker}\n`, { encoding: 'utf-8', mode: 0o600 });
    await rename(temporaryPath, readyPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}
