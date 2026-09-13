import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PortableOpenClawRuntimePreparationProgress } from '@shared/portable-openclaw-runtime';

const CACHE_SCHEMA = 'uclaw.portable-openclaw-runtime/v1';
const CACHE_MARKER_FILE = '.uclaw-openclaw-runtime.json';
const CHALK_PACKAGE_DIR = join('node_modules', 'chalk');
const CHALK_SOURCE_FILE = join(CHALK_PACKAGE_DIR, 'source', 'index.js');
const CHALK_ANSI_STYLES_FILE = join(
  CHALK_PACKAGE_DIR,
  'source',
  'vendor',
  'ansi-styles',
  'index.js',
);

type PortableOpenClawRuntimeMarker = {
  schema: typeof CACHE_SCHEMA;
  cacheKey: string;
  appVersion: string | null;
  openClawVersion: string | null;
  preparedAt: string;
};

export type PreparePortableOpenClawRuntimeInput = {
  sourceDir: string;
  profileDir: string;
  resourcesDir: string;
  cacheRootDir?: string;
  onProgress?: (progress: PortableOpenClawRuntimePreparationProgress) => void;
};

export type PortableOpenClawRuntimeResult = {
  runtimeDir: string;
  cacheKey: string;
  cacheHit: boolean;
};

let configuredRuntime:
  | { input: PreparePortableOpenClawRuntimeInput; result: PortableOpenClawRuntimeResult; prepared: boolean }
  | null = null;
let configuredPreparation: Promise<PortableOpenClawRuntimeResult> | null = null;
const configuredPreparationProgressListeners = new Set<
  (progress: PortableOpenClawRuntimePreparationProgress) => void
>();

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveRuntimeIdentity(input: PreparePortableOpenClawRuntimeInput): {
  cacheKey: string;
  appVersion: string | null;
  openClawVersion: string | null;
} {
  const buildIdentity = readJson(join(input.resourcesDir, 'uclaw-build.json'));
  const openClawPackage = readJson(join(input.sourceDir, 'package.json'));
  const appVersion = readString(buildIdentity?.appVersion);
  const openClawVersion = readString(openClawPackage?.version);
  const buildId = readString(buildIdentity?.buildId);
  const gitCommit = readString(buildIdentity?.gitCommit);
  if (!appVersion || !openClawVersion || !buildId || !gitCommit) {
    throw new Error('Packaged OpenClaw runtime has no reliable build identity');
  }
  const identity = JSON.stringify({
    buildId,
    gitCommit,
    appVersion,
    openClawVersion,
    platform: readString(buildIdentity?.platform) ?? process.platform,
    arch: readString(buildIdentity?.arch) ?? process.arch,
  });
  return {
    cacheKey: createHash('sha256').update(identity).digest('hex').slice(0, 24),
    appVersion,
    openClawVersion,
  };
}

export function resolvePortableOpenClawCacheRoot(
  runtimeRootDir: string,
  portableId: string,
): string {
  const portableScope = createHash('sha256')
    .update(portableId, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return join(runtimeRootDir, 'oc', portableScope);
}

function resolveRuntimeCacheRoot(input: PreparePortableOpenClawRuntimeInput): string {
  return input.cacheRootDir?.trim() || join(input.profileDir, 'openclaw-runtime');
}

function resolveRuntimeDir(input: PreparePortableOpenClawRuntimeInput, cacheKey: string): string {
  return join(resolveRuntimeCacheRoot(input), cacheKey);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolvePackageImportTarget(packageDir: string, target: unknown): string | null {
  if (typeof target !== 'string' || !target.startsWith('./')) {
    return null;
  }
  const targetPath = resolve(packageDir, target);
  const relativeTarget = relative(packageDir, targetPath);
  if (
    !relativeTarget
    || relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    return null;
  }
  return targetPath;
}

function hasCompleteRuntimePayload(runtimeDir: string): boolean {
  const chalkPackageDir = join(runtimeDir, CHALK_PACKAGE_DIR);
  const chalkPackagePath = join(chalkPackageDir, 'package.json');
  const chalkSourcePath = join(runtimeDir, CHALK_SOURCE_FILE);
  const ansiStylesPath = join(runtimeDir, CHALK_ANSI_STYLES_FILE);
  if (
    !isFile(join(runtimeDir, 'openclaw.mjs'))
    || !isFile(join(runtimeDir, 'package.json'))
    || !isFile(chalkPackagePath)
    || !isFile(chalkSourcePath)
    || !isFile(ansiStylesPath)
  ) {
    return false;
  }

  const chalkPackage = readJson(chalkPackagePath);
  const imports = chalkPackage?.imports;
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
    return false;
  }
  const importTarget = resolvePackageImportTarget(
    chalkPackageDir,
    (imports as Record<string, unknown>)['#ansi-styles'],
  );
  return importTarget === resolve(ansiStylesPath) && isFile(importTarget);
}

function isCompleteRuntime(runtimeDir: string, cacheKey: string): boolean {
  if (!hasCompleteRuntimePayload(runtimeDir)) {
    return false;
  }
  const marker = readJson(join(runtimeDir, CACHE_MARKER_FILE));
  return marker?.schema === CACHE_SCHEMA && marker.cacheKey === cacheKey;
}

type RuntimeCopyEntry = {
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
};

type RuntimeCopyPlan = {
  entries: RuntimeCopyEntry[];
  totalBytes: number;
};

function normalizeRelativeRuntimePath(path: string): string {
  return path.split(sep).join('/');
}

function emitProgress(
  input: PreparePortableOpenClawRuntimeInput,
  progress: PortableOpenClawRuntimePreparationProgress,
): void {
  try {
    input.onProgress?.(progress);
  } catch {
    // Progress reporting must never prevent runtime preparation or cleanup.
  }
}

function emitConfiguredPreparationProgress(
  progress: PortableOpenClawRuntimePreparationProgress,
): void {
  for (const listener of configuredPreparationProgressListeners) {
    try {
      listener(progress);
    } catch {
      // One observer must not prevent other observers or the preparation task.
    }
  }
}

function copyPercent(copiedBytes: number, totalBytes: number): number | undefined {
  if (totalBytes <= 0) return undefined;
  return Math.max(5, Math.min(95, 5 + Math.floor(copiedBytes / totalBytes * 90)));
}

async function buildRuntimeCopyPlan(sourceDir: string): Promise<RuntimeCopyPlan> {
  const entries: RuntimeCopyEntry[] = [];
  let totalBytes = 0;

  async function visit(dir: string, relativeDir: string): Promise<void> {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const sourcePath = join(dir, entry.name);
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const resolved = await stat(sourcePath);
      if (resolved.isDirectory()) {
        await visit(sourcePath, relativePath);
        continue;
      }

      if (!resolved.isFile()) continue;
      const sizeBytes = resolved.size;
      entries.push({
        sourcePath,
        relativePath: normalizeRelativeRuntimePath(relativePath),
        sizeBytes,
      });
      totalBytes += sizeBytes;
    }
  }

  await visit(sourceDir, '');
  return { entries, totalBytes };
}

async function copyRuntimeEntry(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  await mkdir(dirname(targetPath), { recursive: true });
  if (sourceStat.isSymbolicLink()) {
    const linkTarget = await readlink(sourcePath);
    await copyFile(resolve(dirname(sourcePath), linkTarget), targetPath);
    return;
  }
  await copyFile(sourcePath, targetPath);
}

async function copyRuntimeWithProgress(
  input: PreparePortableOpenClawRuntimeInput,
  stagingDir: string,
): Promise<void> {
  emitProgress(input, { phase: 'scanning', percent: 4 });
  const plan = await buildRuntimeCopyPlan(input.sourceDir);
  emitProgress(input, {
    phase: 'copying',
    percent: plan.totalBytes > 0 ? 5 : undefined,
    copiedBytes: 0,
    totalBytes: plan.totalBytes,
    copiedFiles: 0,
    totalFiles: plan.entries.length,
  });

  let copiedBytes = 0;
  let copiedFiles = 0;
  let lastEmittedAt = 0;
  let lastEmittedPercent = -1;

  for (const entry of plan.entries) {
    await copyRuntimeEntry(entry.sourcePath, join(stagingDir, entry.relativePath));
    copiedBytes += entry.sizeBytes;
    copiedFiles += 1;

    const percent = copyPercent(copiedBytes, plan.totalBytes);
    const now = Date.now();
    if (
      copiedFiles === plan.entries.length
      || copiedFiles === 1
      || percent !== lastEmittedPercent
      || now - lastEmittedAt >= 250
    ) {
      emitProgress(input, {
        phase: 'copying',
        percent,
        copiedBytes,
        totalBytes: plan.totalBytes,
        copiedFiles,
        totalFiles: plan.entries.length,
        currentFile: entry.relativePath,
      });
      lastEmittedAt = now;
      lastEmittedPercent = percent ?? lastEmittedPercent;
    }
  }
}

/**
 * Copy the immutable packaged OpenClaw runtime from removable media to the
 * machine-local portable profile. A staging directory and completion marker
 * prevent interrupted copies from ever becoming launchable runtimes.
 */
export function findPreparedPortableOpenClawRuntime(
  input: PreparePortableOpenClawRuntimeInput,
): PortableOpenClawRuntimeResult | null {
  try {
    const identity = resolveRuntimeIdentity(input);
    const runtimeDir = resolveRuntimeDir(input, identity.cacheKey);
    return isCompleteRuntime(runtimeDir, identity.cacheKey)
      ? { runtimeDir, cacheKey: identity.cacheKey, cacheHit: true }
      : null;
  } catch {
    return null;
  }
}

/**
 * Select the local runtime path before runtime-dependent modules are imported.
 * The directory may still be pending population; callers must await
 * prepareConfiguredPortableOpenClawRuntime() before using OpenClaw.
 */
export function configurePortableOpenClawRuntime(
  input: PreparePortableOpenClawRuntimeInput,
): PortableOpenClawRuntimeResult {
  const identity = resolveRuntimeIdentity(input);
  const runtimeDir = resolveRuntimeDir(input, identity.cacheKey);
  const prepared = isCompleteRuntime(runtimeDir, identity.cacheKey);
  const result = { runtimeDir, cacheKey: identity.cacheKey, cacheHit: prepared };
  configuredRuntime = { input, result, prepared };
  configuredPreparation = null;
  configuredPreparationProgressListeners.clear();
  process.env.CLAWX_OPENCLAW_RUNTIME_DIR = runtimeDir;
  return result;
}

export async function prepareConfiguredPortableOpenClawRuntime(
  onProgress?: (progress: PortableOpenClawRuntimePreparationProgress) => void,
): Promise<PortableOpenClawRuntimeResult | null> {
  if (!configuredRuntime) return null;
  if (configuredRuntime.prepared) {
    emitProgress(
      {
        ...configuredRuntime.input,
        ...(onProgress ? { onProgress } : {}),
      },
      { phase: 'done', percent: 100 },
    );
    return configuredRuntime.result;
  }

  const progressListener = onProgress ?? configuredRuntime.input.onProgress;
  if (progressListener) {
    configuredPreparationProgressListeners.add(progressListener);
  }
  if (configuredPreparation) return configuredPreparation;

  const input = {
    ...configuredRuntime.input,
    onProgress: emitConfiguredPreparationProgress,
  };
  configuredPreparation = preparePortableOpenClawRuntime(input).then((result) => {
    if (configuredRuntime) {
      configuredRuntime = { ...configuredRuntime, result, prepared: true };
    }
    return result;
  }).finally(() => {
    configuredPreparation = null;
    configuredPreparationProgressListeners.clear();
  });
  return configuredPreparation;
}

export function isConfiguredPortableOpenClawRuntimePrepared(): boolean {
  return configuredRuntime?.prepared === true;
}

export async function preparePortableOpenClawRuntime(
  input: PreparePortableOpenClawRuntimeInput,
): Promise<PortableOpenClawRuntimeResult> {
  emitProgress(input, { phase: 'validating', percent: 0 });
  let stagingDir: string | null = null;
  let previousDir: string | null = null;
  let runtimeDir: string | null = null;
  try {
    if (!hasCompleteRuntimePayload(input.sourceDir)) {
      throw new Error(`Packaged OpenClaw runtime is incomplete: ${input.sourceDir}`);
    }

    const identity = resolveRuntimeIdentity(input);
    const cacheRoot = resolveRuntimeCacheRoot(input);
    runtimeDir = join(cacheRoot, identity.cacheKey);
    await mkdir(cacheRoot, { recursive: true });

    if (isCompleteRuntime(runtimeDir, identity.cacheKey)) {
      emitProgress(input, { phase: 'done', percent: 100 });
      return { runtimeDir, cacheKey: identity.cacheKey, cacheHit: true };
    }

    emitProgress(input, { phase: 'cleanup', percent: 2 });
    const staleEntries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(staleEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.staging-'))
      .map((entry) => rm(join(cacheRoot, entry.name), { recursive: true, force: true })));
    const operationId = `${process.pid}-${randomUUID().slice(0, 8)}`;
    stagingDir = join(cacheRoot, `.staging-${operationId}`);
    previousDir = join(cacheRoot, `.previous-${operationId}`);
    await rm(stagingDir, { recursive: true, force: true });
    await rm(previousDir, { recursive: true, force: true });

    await copyRuntimeWithProgress(input, stagingDir);
    emitProgress(input, { phase: 'validating', percent: 96 });
    if (!hasCompleteRuntimePayload(stagingDir)) {
      throw new Error('Copied OpenClaw runtime failed payload validation');
    }
    const marker: PortableOpenClawRuntimeMarker = {
      schema: CACHE_SCHEMA,
      cacheKey: identity.cacheKey,
      appVersion: identity.appVersion,
      openClawVersion: identity.openClawVersion,
      preparedAt: new Date().toISOString(),
    };
    await writeFile(join(stagingDir, CACHE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    if (!isCompleteRuntime(stagingDir, identity.cacheKey)) {
      throw new Error('Copied OpenClaw runtime failed completion validation');
    }

    emitProgress(input, { phase: 'publishing', percent: 99 });
    const hadPreviousRuntime = existsSync(runtimeDir);
    if (hadPreviousRuntime) {
      await rename(runtimeDir, previousDir);
    }
    try {
      await rename(stagingDir, runtimeDir);
    } catch (error) {
      if (hadPreviousRuntime && !existsSync(runtimeDir) && existsSync(previousDir)) {
        await rename(previousDir, runtimeDir);
      }
      throw error;
    }
    await rm(previousDir, { recursive: true, force: true });

    const oldEntries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(oldEntries
      .filter((entry) => (
        entry.isDirectory()
        && entry.name !== identity.cacheKey
        && !entry.name.startsWith('.staging-')
        && !entry.name.startsWith('.previous-')
      ))
      .map((entry) => rm(join(cacheRoot, entry.name), { recursive: true, force: true })));
    emitProgress(input, { phase: 'done', percent: 100 });
    return { runtimeDir, cacheKey: identity.cacheKey, cacheHit: false };
  } catch (error) {
    emitProgress(input, { phase: 'failed' });
    if (stagingDir) {
      await rm(stagingDir, { recursive: true, force: true });
    }
    if (runtimeDir && previousDir && !existsSync(runtimeDir) && existsSync(previousDir)) {
      await rename(previousDir, runtimeDir);
    }
    throw error;
  }
}
