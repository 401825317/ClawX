import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BlenderArtifact, BlenderVerification } from './types';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.blend': 'application/x-blender',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

const ROLE_BY_FILENAME: Array<[RegExp, BlenderArtifact['role']]> = [
  [/\.blend$/iu, 'model3d.source'],
  [/\.glb$/iu, 'model3d.portable'],
  [/hero\.png$/iu, 'render.hero'],
  [/turntable\.mp4$/iu, 'render.turntable'],
  [/manifest\.json$/iu, 'manifest'],
];

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function artifactRole(fileName: string): BlenderArtifact['role'] | undefined {
  return ROLE_BY_FILENAME.find(([pattern]) => pattern.test(fileName))?.[1];
}

function verification(
  id: string,
  status: BlenderVerification['status'],
  kind: BlenderVerification['kind'],
  severity: BlenderVerification['severity'],
  title: string,
  detail: string,
  required = true,
  artifactId?: string,
  evidence?: string,
): BlenderVerification {
  return { id, status, kind, severity, title, detail, required, ...(artifactId ? { artifactId } : {}), ...(evidence ? { evidence } : {}) };
}

function glbHeaderIsValid(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'glTF' && buffer.readUInt32LE(4) === 2;
}

function pngHeaderIsValid(buffer: Buffer): boolean {
  return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function renderQuality(filePath: string): Promise<{ mean: number; contrast: number } | undefined> {
  try {
    const sharp = (await import('sharp')).default;
    const stats = await sharp(filePath, { failOn: 'none' }).stats();
    const channels = stats.channels.slice(0, 3);
    if (channels.length === 0) return undefined;
    return {
      mean: channels.reduce((total, channel) => total + channel.mean, 0) / (channels.length * 255),
      contrast: channels.reduce((total, channel) => total + channel.stdev, 0) / (channels.length * 255),
    };
  } catch {
    return undefined;
  }
}

async function readHeader(filePath: string, size = 32): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function collectAndValidateArtifacts(
  outputDir: string,
  maxOutputBytes: number,
): Promise<{ artifacts: BlenderArtifact[]; verifications: BlenderVerification[] }> {
  const names = (await fs.readdir(outputDir)).sort();
  const artifacts: BlenderArtifact[] = [];
  const verifications: BlenderVerification[] = [];
  let totalBytes = 0;
  for (const fileName of names) {
    const role = artifactRole(fileName);
    if (!role) continue;
    const filePath = path.join(outputDir, fileName);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    totalBytes += stat.size;
    const digest = await sha256(filePath);
    const artifact: BlenderArtifact = {
      id: `blender-artifact:${digest.slice(0, 16)}`,
      role,
      title: fileName,
      filePath,
      fileName,
      mimeType: MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
      sizeBytes: stat.size,
      sha256: digest,
    };
    artifacts.push(artifact);
    verifications.push(verification(
      `verify:${artifact.id}:integrity`,
      stat.size > 0 ? 'passed' : 'failed',
      'artifact.integrity',
      stat.size > 0 ? 'info' : 'blocking',
      `${fileName} integrity`,
      stat.size > 0 ? 'Artifact exists and has a SHA-256 digest.' : 'Artifact is empty.',
      true,
      artifact.id,
      `sha256=${digest}; bytes=${stat.size}`,
    ));
    const prefix = await readHeader(filePath);
    if (role === 'model3d.portable') {
      verifications.push(verification(
        `verify:${artifact.id}:gltf`, glbHeaderIsValid(prefix) ? 'passed' : 'failed', 'model.gltf',
        glbHeaderIsValid(prefix) ? 'info' : 'blocking', `${fileName} GLB header`,
        glbHeaderIsValid(prefix) ? 'GLB v2 header is valid.' : 'GLB v2 header is invalid.', true, artifact.id,
      ));
    }
    if (role === 'render.hero') {
      const quality = await renderQuality(filePath);
      const visuallyUseful = Boolean(quality && quality.mean > 0.002 && quality.contrast > 0.002);
      verifications.push(verification(
        `verify:${artifact.id}:render`, pngHeaderIsValid(prefix) ? 'passed' : 'failed', 'render.visual',
        pngHeaderIsValid(prefix) ? 'info' : 'blocking', `${fileName} PNG header`,
        pngHeaderIsValid(prefix) ? 'PNG render is non-empty and readable.' : 'PNG header is invalid.', true, artifact.id,
      ));
      verifications.push(verification(
        `verify:${artifact.id}:render-content`, visuallyUseful ? 'passed' : 'failed', 'render.visual',
        visuallyUseful ? 'info' : 'blocking', `${fileName} visual content`,
        visuallyUseful ? 'Render has measurable luminance and contrast.' : 'Render is blank or lacks measurable contrast.', true, artifact.id,
        quality ? `mean=${quality.mean.toFixed(6)}; contrast=${quality.contrast.toFixed(6)}` : 'image_stats_unavailable',
      ));
    }
    if (role === 'render.turntable') {
      verifications.push(verification(
        `verify:${artifact.id}:media`, stat.size > 1024 ? 'passed' : 'failed', 'media.metadata',
        stat.size > 1024 ? 'info' : 'blocking', `${fileName} video size`,
        stat.size > 1024 ? 'Video output is non-empty.' : 'Video output is too small.', true, artifact.id,
      ));
    }
  }
  verifications.push(verification(
    'verify:scene:budget-output',
    totalBytes <= maxOutputBytes ? 'passed' : 'failed',
    'scene.budget',
    totalBytes <= maxOutputBytes ? 'info' : 'blocking',
    'Output budget',
    totalBytes <= maxOutputBytes ? 'Generated output is within the configured byte budget.' : 'Generated output exceeds the configured byte budget.',
    true,
    undefined,
    `bytes=${totalBytes}; maxBytes=${maxOutputBytes}`,
  ));
  return { artifacts, verifications };
}
