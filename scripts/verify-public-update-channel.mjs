#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { assertBlockmapMatchesInstaller } from './refresh-signed-windows-update-metadata.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const ENDPOINTS = JSON.parse(await readFile(path.join(ROOT, 'shared', 'junfeiai-endpoints.json'), 'utf8'));
const PRODUCTION_ORIGIN = String(
  process.env.UCLAW_UPDATE_VERIFY_ORIGIN || ENDPOINTS.productionOrigin || '',
).replace(/\/+$/u, '');
const UPDATE_CONFIG = ENDPOINTS.appUpdates || {};
const MANAGED_FEED_PATH = String(UPDATE_CONFIG.managedFeedPath || '').replace(/\/+$/u, '');
const MANAGED_API_PATH = String(UPDATE_CONFIG.managedApiPath || '').replace(/\/+$/u, '');
const LEGACY_FEED_BASE_URL = String(UPDATE_CONFIG.legacyInstalledFeedBaseUrl || '').replace(/\/+$/u, '');
const LEGACY_INSTALLER_FEED = process.env.UCLAW_UPDATE_VERIFY_LEGACY_FEED
  || `${LEGACY_FEED_BASE_URL}/latest/latest.yml`;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {
    version: PACKAGE_JSON.version,
    installerManifest: path.join(ROOT, 'release', 'latest.yml'),
    macManifest: path.join(ROOT, 'release', 'latest-mac.yml'),
    linuxManifest: path.join(ROOT, 'release', 'latest-linux.yml'),
    portableMetadata: path.join(
      ROOT,
      'release',
      `UClaw-${PACKAGE_JSON.version}-win-x64-usb.json`,
    ),
    remoteOnly: false,
    managedOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--':
        break;
      case '--version':
        options.version = readValue();
        break;
      case '--installer-manifest':
        options.installerManifest = path.resolve(readValue());
        break;
      case '--portable-metadata':
        options.portableMetadata = path.resolve(readValue());
        break;
      case '--mac-manifest':
        options.macManifest = path.resolve(readValue());
        break;
      case '--linux-manifest':
        options.linuxManifest = path.resolve(readValue());
        break;
      case '--remote-only':
        options.remoteOnly = true;
        break;
      case '--managed-only':
        options.managedOnly = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.version.trim()) throw new Error('Target version is required');
  if (!PRODUCTION_ORIGIN || !MANAGED_FEED_PATH || !MANAGED_API_PATH || !LEGACY_FEED_BASE_URL) {
    throw new Error('shared/junfeiai-endpoints.json is missing app update endpoints');
  }
  return options;
}

function printHelp() {
  console.log(`Verify public UClaw update channels

Usage:
  pnpm run test:update-channel -- [options]

Options:
  --version <version>                 Expected public version; defaults to package.json.
  --installer-manifest <path>         Signed latest.yml to compare.
  --mac-manifest <path>               Signed latest-mac.yml to compare.
  --linux-manifest <path>             Signed latest-linux.yml to compare.
  --portable-metadata <path>          Windows USB JSON to compare.
  --remote-only                       Check remote consistency without local artifacts.
  --managed-only                      Verify managed installer/portable records before promoting the legacy feed.
`);
}

async function sha512(filePath, encoding) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest(encoding);
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        contentType: response.headers.get('content-type') || '',
        text: await response.text(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) await delay(attempt * 500);
    }
  }
  throw new Error(
    `Request failed after ${FETCH_ATTEMPTS} attempts: `
    + (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

function artifactFileName(value) {
  if (!value) return '';
  try {
    return path.basename(new URL(String(value), 'https://update.invalid').pathname);
  } catch {
    return path.basename(String(value));
  }
}

function siblingFeedUrl(baseUrl, fileName) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${fileName}`;
  return url.toString();
}

function normalizeInstallerManifest(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} did not return an installer YAML object`);
  }
  const fileName = artifactFileName(value.path);
  const file = value.files?.find((entry) => artifactFileName(entry.url) === fileName);
  const normalized = {
    version: String(value.version || ''),
    fileName,
    size: Number(file?.size),
    sha512: String(file?.sha512 || value.sha512 || ''),
  };
  if (!normalized.version
    || !normalized.fileName
    || !Number.isFinite(normalized.size)
    || normalized.size <= 0
    || !normalized.sha512) {
    throw new Error(`${source} installer metadata is incomplete`);
  }
  if (value.sha512 && value.sha512 !== normalized.sha512) {
    throw new Error(`${source} top-level and file sha512 differ`);
  }
  return normalized;
}

function parseInstallerResponse(response, source) {
  if (/text\/html/iu.test(response.contentType)) {
    throw new Error(`${source} returned HTML instead of update YAML`);
  }
  return normalizeInstallerManifest(YAML.parse(response.text), source);
}

function normalizePortableInfo(value, source) {
  const envelope = value && typeof value === 'object' ? value : null;
  if (!envelope || envelope.success === false) {
    throw new Error(`${source} returned an unsuccessful response`);
  }
  const info = envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  const normalized = {
    version: String(info.version || ''),
    fileName: artifactFileName(info.fileName || info.file_name || info.downloadUrl || info.download_url),
    size: Number(info.size),
    sha512: String(info.sha512 || '').toLowerCase(),
    packageType: String(info.packageType || info.package_type || ''),
    downloadFileName: artifactFileName(info.downloadUrl || info.download_url),
  };
  if (!normalized.version
    || !normalized.fileName
    || !Number.isFinite(normalized.size)
    || normalized.size <= 0
    || !/^[a-f0-9]{128}$/u.test(normalized.sha512)
    || normalized.packageType !== 'portable_zip') {
    throw new Error(`${source} portable metadata is incomplete or invalid`);
  }
  if (normalized.downloadFileName && normalized.downloadFileName !== normalized.fileName) {
    throw new Error(`${source} portable filename and download URL differ`);
  }
  return normalized;
}

function assertSameArtifact(left, right, label) {
  for (const key of ['version', 'fileName', 'size', 'sha512']) {
    if (left[key] !== right[key]) {
      throw new Error(`${label} mismatch: ${key}`);
    }
  }
}

async function readLocalInstaller(manifestPath, options = {}) {
  if (!existsSync(manifestPath)) throw new Error(`Installer manifest missing: ${manifestPath}`);
  const manifest = normalizeInstallerManifest(
    YAML.parse(await readFile(manifestPath, 'utf8')),
    'local installer manifest',
  );
  const installerPath = path.join(path.dirname(manifestPath), manifest.fileName);
  const blockmapPath = `${installerPath}.blockmap`;
  if (!existsSync(installerPath)) throw new Error(`Installer missing: ${installerPath}`);
  if (options.requireBlockmap && (!existsSync(blockmapPath) || (await stat(blockmapPath)).size <= 0)) {
    throw new Error(`Installer blockmap missing or empty: ${blockmapPath}`);
  }
  if (options.requireBlockmap) await assertBlockmapMatchesInstaller(installerPath, blockmapPath);
  const installerStat = await stat(installerPath);
  const actual = {
    ...manifest,
    size: installerStat.size,
    sha512: await sha512(installerPath, 'base64'),
  };
  assertSameArtifact(manifest, actual, 'local installer file');
  return actual;
}

async function readLocalPortable(metadataPath) {
  if (!existsSync(metadataPath)) throw new Error(`Portable metadata missing: ${metadataPath}`);
  const metadata = normalizePortableInfo(
    JSON.parse(await readFile(metadataPath, 'utf8')),
    'local portable metadata',
  );
  const zipPath = path.join(path.dirname(metadataPath), metadata.fileName);
  if (!existsSync(zipPath)) throw new Error(`Portable ZIP missing: ${zipPath}`);
  const zipStat = await stat(zipPath);
  const actual = {
    ...metadata,
    size: zipStat.size,
    sha512: await sha512(zipPath, 'hex'),
  };
  assertSameArtifact(metadata, actual, 'local portable ZIP');
  return actual;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const managedFeedBase = `${PRODUCTION_ORIGIN}${MANAGED_FEED_PATH}/latest`;
  const managedInstallerUrl = `${managedFeedBase}/latest.yml`;
  const managedMacUrl = `${managedFeedBase}/latest-mac.yml`;
  const managedLinuxUrl = `${managedFeedBase}/latest-linux.yml`;
  const legacyMacUrl = process.env.UCLAW_UPDATE_VERIFY_LEGACY_MAC_FEED
    || siblingFeedUrl(LEGACY_INSTALLER_FEED, 'latest-mac.yml');
  const legacyLinuxUrl = process.env.UCLAW_UPDATE_VERIFY_LEGACY_LINUX_FEED
    || siblingFeedUrl(LEGACY_INSTALLER_FEED, 'latest-linux.yml');
  const portableUrl = new URL(`${PRODUCTION_ORIGIN}${MANAGED_API_PATH}/latest`);
  portableUrl.searchParams.set('channel', 'latest');
  portableUrl.searchParams.set('platform', 'win');
  portableUrl.searchParams.set('package_type', 'portable_zip');
  portableUrl.searchParams.set('arch', 'x64');

  const [
    managedResponse,
    managedMacResponse,
    managedLinuxResponse,
    legacyResponse,
    legacyMacResponse,
    legacyLinuxResponse,
    portableResponse,
  ] = await Promise.all([
    fetchText(managedInstallerUrl),
    fetchText(managedMacUrl),
    fetchText(managedLinuxUrl),
    options.managedOnly ? Promise.resolve(null) : fetchText(LEGACY_INSTALLER_FEED),
    options.managedOnly ? Promise.resolve(null) : fetchText(legacyMacUrl),
    options.managedOnly ? Promise.resolve(null) : fetchText(legacyLinuxUrl),
    fetchText(portableUrl),
  ]);
  const managed = parseInstallerResponse(managedResponse, 'managed installer feed');
  const managedMac = parseInstallerResponse(managedMacResponse, 'managed macOS installer feed');
  const managedLinux = parseInstallerResponse(managedLinuxResponse, 'managed Linux installer feed');
  const legacy = legacyResponse
    ? parseInstallerResponse(legacyResponse, 'legacy installer feed')
    : null;
  const legacyMac = legacyMacResponse
    ? parseInstallerResponse(legacyMacResponse, 'legacy macOS installer feed')
    : null;
  const legacyLinux = legacyLinuxResponse
    ? parseInstallerResponse(legacyLinuxResponse, 'legacy Linux installer feed')
    : null;
  const portable = normalizePortableInfo(
    JSON.parse(portableResponse.text),
    'portable update API',
  );

  const installedVersions = {
    managedWindows: managed.version,
    managedMac: managedMac.version,
    managedLinux: managedLinux.version,
    legacyWindows: legacy?.version ?? 'skipped',
    legacyMac: legacyMac?.version ?? 'skipped',
    legacyLinux: legacyLinux?.version ?? 'skipped',
  };
  if (Object.values(installedVersions).some((version) => version !== 'skipped' && version !== options.version)
    || portable.version !== options.version) {
    throw new Error(
      `Public version mismatch: expected=${options.version}, installed=${JSON.stringify(installedVersions)}, `
      + `portable=${portable.version}`,
    );
  }
  if (legacy) assertSameArtifact(managed, legacy, 'managed and legacy installer feeds');
  if (legacyMac) assertSameArtifact(managedMac, legacyMac, 'managed and legacy macOS installer feeds');
  if (legacyLinux) assertSameArtifact(managedLinux, legacyLinux, 'managed and legacy Linux installer feeds');

  if (!options.remoteOnly) {
    const [localInstaller, localMac, localLinux, localPortable] = await Promise.all([
      readLocalInstaller(options.installerManifest, { requireBlockmap: true }),
      readLocalInstaller(options.macManifest),
      readLocalInstaller(options.linuxManifest),
      readLocalPortable(options.portableMetadata),
    ]);
    assertSameArtifact(localInstaller, managed, 'local and public installer metadata');
    assertSameArtifact(localMac, managedMac, 'local and public macOS metadata');
    assertSameArtifact(localLinux, managedLinux, 'local and public Linux metadata');
    assertSameArtifact(localPortable, portable, 'local and public portable metadata');
  }

  console.log(JSON.stringify({
    status: 'passed',
    version: options.version,
    remoteOnly: options.remoteOnly,
    managedOnly: options.managedOnly,
    installed: {
      windows: managed,
      mac: managedMac,
      linux: managedLinux,
    },
    portable,
    contentTypes: {
      managed: managedResponse.contentType,
      managedMac: managedMacResponse.contentType,
      managedLinux: managedLinuxResponse.contentType,
      legacy: legacyResponse?.contentType ?? null,
      legacyMac: legacyMacResponse?.contentType ?? null,
      legacyLinux: legacyLinuxResponse?.contentType ?? null,
      portable: portableResponse.contentType,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(`[update-channel] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
