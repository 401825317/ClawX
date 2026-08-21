import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { getSetting } from './store';
import { getUclawBuildIdentity } from './build-identity';
import { getOrCreateInstallationId } from './installation-id';

export async function getUclawDiagnosticHeaders(
  options: { includeRequestId?: boolean } = {},
): Promise<Record<string, string>> {
  const identity = getUclawBuildIdentity();
  const portableMode = process.env.CLAWX_PORTABLE?.trim() === '1'
    || Boolean(process.env.CLAWX_PORTABLE_ID?.trim());
  const runtimeMode = !app.isPackaged
    ? 'development'
    : (portableMode ? 'portable' : 'installed');
  const configuredChannel = await getSetting('updateChannel').catch(() => 'stable');
  const headers: Record<string, string> = {
    'X-UClaw-Client': 'desktop',
    'X-UClaw-Version': identity.appVersion,
    'X-UClaw-Commit': identity.gitCommit,
    'X-UClaw-Build-Id': identity.buildId,
    'X-UClaw-Platform': identity.platform,
    'X-UClaw-Arch': identity.arch,
    'X-UClaw-Channel': typeof configuredChannel === 'string' && configuredChannel.trim()
      ? configuredChannel.trim()
      : 'stable',
    'X-UClaw-Mode': runtimeMode,
  };
  const installationId = await getOrCreateInstallationId().catch(() => '');
  if (installationId) {
    headers['X-UClaw-Install-Id'] = createHash('sha256').update(installationId).digest('hex');
  }
  if (options.includeRequestId !== false) {
    headers['X-Request-Id'] = randomUUID();
  }
  return headers;
}

export function mergeUclawDiagnosticHeaders(
  current: Record<string, string>,
  diagnostics: Record<string, string>,
): Record<string, string> {
  const merged = { ...current };
  for (const [name, value] of Object.entries(diagnostics)) {
    const existing = Object.keys(merged).find(key => key.toLowerCase() === name.toLowerCase());
    if (existing) delete merged[existing];
    merged[name] = value;
  }
  return merged;
}
