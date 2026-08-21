import { app } from 'electron';
import { readFileSync } from 'fs';
import { join } from 'path';

export type UclawBuildIdentity = {
  appVersion: string;
  gitCommit: string;
  buildId: string;
  platform: string;
  arch: string;
};

let cachedIdentity: UclawBuildIdentity | null = null;

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getUclawBuildIdentity(): UclawBuildIdentity {
  if (cachedIdentity) return { ...cachedIdentity };

  const fallback: UclawBuildIdentity = {
    appVersion: app.getVersion(),
    gitCommit: 'development',
    buildId: `development-${app.getVersion()}`,
    platform: process.platform,
    arch: process.arch,
  };
  try {
    const raw = JSON.parse(readFileSync(join(process.resourcesPath, 'uclaw-build.json'), 'utf8')) as Record<string, unknown>;
    cachedIdentity = {
      appVersion: nonEmptyString(raw.appVersion) || fallback.appVersion,
      gitCommit: nonEmptyString(raw.gitCommit) || fallback.gitCommit,
      buildId: nonEmptyString(raw.buildId) || fallback.buildId,
      platform: nonEmptyString(raw.platform) || fallback.platform,
      arch: nonEmptyString(raw.arch) || fallback.arch,
    };
  } catch {
    cachedIdentity = fallback;
  }
  return { ...cachedIdentity };
}
