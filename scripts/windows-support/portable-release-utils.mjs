import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function assertFormalVersion(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(String(version ?? ''))) {
    throw new Error(`Expected a stable semantic version, received "${version ?? ''}".`);
  }
}

export function assertGitCommit(commit) {
  if (!/^[0-9a-f]{40}$/u.test(String(commit ?? ''))) {
    throw new Error(`Expected a full Git commit, received "${commit ?? ''}".`);
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporaryPath = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, resolved);
}

export async function sha512File(filePath) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path.resolve(filePath));
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function packageIdentity(value = {}) {
  return {
    version: String(value.version ?? ''),
    buildId: String(value.buildId ?? ''),
    gitCommit: String(value.gitCommit ?? ''),
    zipFileName: String(value.zipFileName ?? value.file_name ?? value.fileName ?? ''),
    zipSize: Number(value.zipSize ?? value.size ?? 0),
    sha512: String(value.sha512 ?? '').toLowerCase(),
  };
}

export function comparePackageIdentity(expectedValue, actualValue, label = 'package') {
  const expected = packageIdentity(expectedValue);
  const actual = packageIdentity(actualValue);
  const mismatches = [];
  for (const field of ['version', 'buildId', 'gitCommit', 'zipFileName', 'zipSize', 'sha512']) {
    if (expected[field] !== actual[field]) {
      mismatches.push(`${label}.${field}: expected=${expected[field]} actual=${actual[field]}`);
    }
  }
  return mismatches;
}

export async function inspectPortableArtifact({
  zipPath,
  metadataPath = '',
  expectedVersion = '',
  expectedCommit = '',
}) {
  const resolvedZipPath = path.resolve(zipPath);
  const resolvedMetadataPath = path.resolve(
    metadataPath || resolvedZipPath.replace(/\.zip$/iu, '.json'),
  );
  const zipStat = await stat(resolvedZipPath);
  const metadata = await readJson(resolvedMetadataPath);
  const fileName = path.basename(resolvedZipPath);
  const expectedFileName = `UClaw-${metadata.version}-win-x64-usb.zip`;
  const packageType = metadata.package_type ?? metadata.packageType;
  const metadataFileName = metadata.file_name ?? metadata.fileName;

  assertFormalVersion(metadata.version);
  assertGitCommit(metadata.gitCommit);
  if (packageType !== 'portable_zip') {
    throw new Error(`Unexpected package type in ${resolvedMetadataPath}: ${packageType}`);
  }
  if (fileName !== expectedFileName || metadataFileName !== expectedFileName) {
    throw new Error(
      `Portable filename mismatch: zip=${fileName} metadata=${metadataFileName} expected=${expectedFileName}`,
    );
  }
  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(`Portable version mismatch: expected=${expectedVersion} actual=${metadata.version}`);
  }
  if (expectedCommit && metadata.gitCommit !== expectedCommit) {
    throw new Error(`Portable commit mismatch: expected=${expectedCommit} actual=${metadata.gitCommit}`);
  }
  if (!String(metadata.buildId ?? '').trim()) {
    throw new Error(`Portable build ID is missing in ${resolvedMetadataPath}`);
  }

  const digest = await sha512File(resolvedZipPath);
  return {
    zipPath: resolvedZipPath,
    metadataPath: resolvedMetadataPath,
    metadata,
    identity: {
      version: metadata.version,
      buildId: metadata.buildId,
      gitCommit: metadata.gitCommit,
      zipFileName: fileName,
      zipSize: zipStat.size,
      sha512: digest,
    },
    metadataMatches: Number(metadata.size) === zipStat.size
      && String(metadata.sha512 ?? '').toLowerCase() === digest,
  };
}
