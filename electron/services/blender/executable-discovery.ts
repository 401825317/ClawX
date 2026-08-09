import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type BlenderExecutableDiscovery = {
  found: boolean;
  executable?: string;
  source?: 'configured' | 'path' | 'standard-location';
  searched: string[];
  error?: string;
};

function existingFile(candidate: string): string | undefined {
  return candidate && existsSync(candidate) ? candidate : undefined;
}

function pathCandidates(): string[] {
  const value = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const names = process.platform === 'win32' ? ['blender.exe', 'blender'] : ['blender'];
  return value.split(delimiter).flatMap((entry) => names.map((name) => join(entry.trim().replace(/^"|"$/gu, ''), name)));
}

function standardCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Blender.app/Contents/MacOS/Blender',
      '/Applications/Blender Foundation/Blender.app/Contents/MacOS/Blender',
    ];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const foundationDir = join(programFiles, 'Blender Foundation');
    const versioned = existsSync(foundationDir)
      ? readdirSync(foundationDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^Blender(?:\s|$)/iu.test(entry.name))
        .map((entry) => join(foundationDir, entry.name, 'blender.exe'))
      : [];
    return [
      join(programFiles, 'Blender Foundation', 'Blender', 'blender.exe'),
      ...versioned,
      join(localAppData, 'Programs', 'Blender Foundation', 'Blender', 'blender.exe'),
    ];
  }
  return ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender'];
}

export function discoverBlenderExecutable(configuredPath = process.env.UCLAW_BLENDER_PATH): BlenderExecutableDiscovery {
  const searched: string[] = [];
  const configured = configuredPath?.trim();
  if (configured) {
    searched.push(configured);
    const executable = existingFile(configured);
    return executable
      ? { found: true, executable, source: 'configured', searched }
      : { found: false, searched, error: 'Configured UCLAW_BLENDER_PATH does not exist' };
  }
  for (const candidate of pathCandidates()) {
    searched.push(candidate);
    const executable = existingFile(candidate);
    if (executable) return { found: true, executable, source: 'path', searched };
  }
  for (const candidate of standardCandidates()) {
    searched.push(candidate);
    const executable = existingFile(candidate);
    if (executable) return { found: true, executable, source: 'standard-location', searched };
  }
  return { found: false, searched, error: 'Blender was not found. Set UCLAW_BLENDER_PATH or install Blender.' };
}
