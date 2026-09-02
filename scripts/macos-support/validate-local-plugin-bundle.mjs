import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_OPENCLAW_PLUGIN_IDS } from '../openclaw-bundle-config.mjs';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function isValidVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  return Boolean(match) && (!match[4] || !match[4].split('.').some((part) => /^0\d+$/u.test(part)));
}

/**
 * Validate the metadata that identifies a local plugin in a packaged runtime.
 * Keeping this independent of the filesystem lets the ZIP staging check and
 * the electron-builder output check enforce the same contract.
 */
export function validateLocalPluginMetadata({
  pluginId,
  packageJson,
  manifest,
  hasEntry,
  hasDependency,
  label = `macOS plugin ${pluginId}`,
}) {
  const errors = [];
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    errors.push(`${label} package.json is missing or invalid`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(`${label} openclaw.plugin.json is missing or invalid`);
  }
  if (errors.length > 0) return errors;

  const expectedNames = new Set([pluginId, `${pluginId}-plugin`]);
  if (!expectedNames.has(packageJson.name)) {
    errors.push(`${label} package name mismatch: ${String(packageJson.name)}`);
  }
  if (manifest.id !== pluginId) {
    errors.push(`${label} manifest id mismatch: ${String(manifest.id)}`);
  }
  const packageVersion = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!packageVersion || !manifestVersion) {
    errors.push(`${label} package and manifest versions are required`);
  } else if (packageVersion !== manifestVersion) {
    errors.push(`${label} version mismatch: package=${packageVersion} manifest=${manifestVersion}`);
  } else if (!isValidVersion(packageVersion)) {
    errors.push(`${label} version is not semantic versioning: ${packageVersion}`);
  }

  const entry = typeof manifest.entry === 'string' ? manifest.entry.trim() : '';
  if (!isSafeRelativeEntry(entry) || packageJson.main !== entry) {
    errors.push(`${label} entry mismatch: package.main=${String(packageJson.main)} manifest.entry=${String(manifest.entry)}`);
  } else if (hasEntry && !hasEntry(entry)) {
    errors.push(`${label} entry is missing: ${entry}`);
  }

  const dependencies = Object.keys({
    ...(packageJson.dependencies && typeof packageJson.dependencies === 'object'
      ? packageJson.dependencies : {}),
    ...(packageJson.optionalDependencies && typeof packageJson.optionalDependencies === 'object'
      ? packageJson.optionalDependencies : {}),
  });
  if (hasDependency) {
    for (const dependency of dependencies) {
      if (!hasDependency(dependency)) {
        errors.push(`${label} is missing runtime dependency: ${dependency}`);
      }
    }
  }
  return errors;
}

function parseJson(text, label) {
  try {
    return JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function archivePathFor(pluginId, relativePath) {
  return `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/${relativePath}`;
}

function isSafeRelativeEntry(value) {
  if (typeof value !== 'string' || !value.trim() || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)) return false;
  return !value.replaceAll('\\', '/').split('/').includes('..');
}

/** Read one ZIP member with the system unzip implementation on macOS. */
export async function readMacosZipEntry(zipPath, entry) {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', zipPath, entry], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Validate every local plugin in a macOS USB ZIP. `entries` must be the output
 * of `unzip -Z1`; `readEntry` is injectable for deterministic unit tests.
 */
export async function validateLocalPluginsInMacosZip({
  zipPath,
  entries,
  readEntry = readMacosZipEntry,
  pluginIds = LOCAL_OPENCLAW_PLUGIN_IDS,
  label = 'macOS USB ZIP',
}) {
  const entrySet = new Set(entries);
  const errors = [];
  for (const pluginId of pluginIds) {
    const packageEntry = archivePathFor(pluginId, 'package.json');
    const manifestEntry = archivePathFor(pluginId, 'openclaw.plugin.json');
    const packageText = entrySet.has(packageEntry)
      ? await readEntry(zipPath, packageEntry)
      : null;
    const manifestText = entrySet.has(manifestEntry)
      ? await readEntry(zipPath, manifestEntry)
      : null;
    let packageJson;
    let manifest;
    try {
      packageJson = packageText === null ? null : parseJson(packageText, `${label} ${pluginId} package.json`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      manifest = manifestText === null ? null : parseJson(manifestText, `${label} ${pluginId} manifest`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const pluginPrefix = `UClaw.app/Contents/Resources/openclaw-plugins/${pluginId}/`;
    const pluginEntries = [...entrySet].filter((entry) => entry.startsWith(pluginPrefix));
    const pluginErrors = validateLocalPluginMetadata({
      pluginId,
      packageJson,
      manifest,
      label: `${label} ${pluginId}`,
      hasEntry: (entry) => entrySet.has(archivePathFor(pluginId, entry)),
      hasDependency: (dependency) => isSafeRelativeEntry(dependency)
        && entrySet.has(`${pluginPrefix}node_modules/${dependency.replaceAll('\\', '/')}/package.json`),
    });
    errors.push(...pluginErrors);
    // Keep this explicit so a ZIP containing only metadata cannot pass when a
    // malformed package declares no usable entrypoint.
    if (pluginEntries.length === 0) errors.push(`${label} ${pluginId} has no archive entries`);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

/** Validate local plugin directories produced by electron-builder. */
export async function validateLocalPluginsInDirectory({
  pluginsRoot,
  pluginIds = LOCAL_OPENCLAW_PLUGIN_IDS,
  label = 'macOS packaged app',
}) {
  const errors = [];
  for (const pluginId of pluginIds) {
    const pluginDir = path.join(pluginsRoot, pluginId);
    let packageJson;
    let manifest;
    try {
      packageJson = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
    } catch (error) {
      errors.push(`${label} ${pluginId} package.json is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      manifest = JSON.parse(await readFile(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
    } catch (error) {
      errors.push(`${label} ${pluginId} manifest is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pluginErrors = validateLocalPluginMetadata({
      pluginId,
      packageJson,
      manifest,
      label: `${label} ${pluginId}`,
      hasEntry: (entry) => isSafeRelativeEntry(entry) && existsSync(path.join(pluginDir, entry)),
      hasDependency: (dependency) => isSafeRelativeEntry(dependency)
        && existsSync(path.join(pluginDir, 'node_modules', ...dependency.split('/'), 'package.json')),
    });
    errors.push(...pluginErrors);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}
