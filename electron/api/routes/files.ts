import type { IncomingMessage, ServerResponse } from 'http';
import { dialog, nativeImage } from 'electron';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { expandFilePreviewPath, getOpenClawMediaDir } from '../../utils/paths';

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
};

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function isStreamableMediaMime(mimeType: string): boolean {
  return mimeType.startsWith('video/') || mimeType.startsWith('audio/') || mimeType.startsWith('image/');
}

function normalizeMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) return ext;
  }
  return '';
}

const DIRECTORY_MIME_TYPE = 'application/x-directory';
const REMOTE_MEDIA_MAX_REDIRECTS = 5;

function getOutboundDir(): string {
  return join(getOpenClawMediaDir(), 'outbound');
}

function parseRangeHeader(rangeHeader: string | undefined, fileSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (!startRaw && !endRaw) return null;

  let start: number;
  let end: number;
  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return null;
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

function isBlockedPrivateIpAddress(address: string): boolean {
  if (!isIP(address)) return true;
  if (address === '::1' || address === '::' || address.startsWith('fe80:')) return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(address)) return true;
  const ipv4Mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const ipv4 = ipv4Mapped ?? address;
  if (!isIP(ipv4) || !ipv4.includes('.')) return false;
  const parts = ipv4.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a >= 224;
}

async function resolveSafeRemoteMediaUrl(rawUrl: string): Promise<URL | null> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.includes('\0')) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
  ) {
    return null;
  }

  if (isIP(hostname)) {
    return isBlockedPrivateIpAddress(hostname) ? null : parsed;
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: false });
    if (addresses.length === 0 || addresses.some((entry) => isBlockedPrivateIpAddress(entry.address))) {
      return null;
    }
  } catch {
    return null;
  }
  return parsed;
}

function inferRemoteMediaMimeType(sourceUrl: URL, upstreamContentType: string | null, mimeHint: string | null): string {
  const upstreamMime = normalizeMimeType(upstreamContentType);
  if (upstreamMime && isStreamableMediaMime(upstreamMime)) return upstreamMime;
  const hintedMime = normalizeMimeType(mimeHint);
  if (hintedMime && isStreamableMediaMime(hintedMime)) return hintedMime;
  const extensionMime = getMimeType(extname(sourceUrl.pathname));
  return isStreamableMediaMime(extensionMime) ? extensionMime : 'application/octet-stream';
}

async function sendRemoteMediaResponse(
  req: IncomingMessage,
  res: ServerResponse,
  sourceUrl: URL,
  mimeHint: string | null,
): Promise<void> {
  const upstream = await fetchRemoteMedia(sourceUrl, req);
  const contentType = inferRemoteMediaMimeType(sourceUrl, upstream.headers.get('content-type'), mimeHint);
  if (!isStreamableMediaMime(contentType)) {
    sendJson(res, 415, { success: false, error: 'Remote media type is not streamable' });
    return;
  }

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=900');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) res.setHeader('Content-Length', contentLength);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) res.setHeader('Content-Range', contentRange);

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>).pipe(res);
}

async function fetchRemoteMedia(
  sourceUrl: URL,
  req: IncomingMessage,
  redirectCount = 0,
): Promise<Response> {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const upstream = await fetch(sourceUrl, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      Accept: 'video/*, audio/*, image/*, */*;q=0.8',
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
    redirect: 'manual',
  });
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
    if (redirectCount >= REMOTE_MEDIA_MAX_REDIRECTS) {
      throw new Error('Remote media redirect limit exceeded');
    }
    const nextUrl = await resolveSafeRemoteMediaUrl(new URL(upstream.headers.get('location')!, sourceUrl).toString());
    if (!nextUrl) {
      throw new Error('Remote media redirect target is not allowed');
    }
    return fetchRemoteMedia(nextUrl, req, redirectCount + 1);
  }
  return upstream;
}

async function resolveLocalMediaFile(filePath: string): Promise<{ realPath: string; size: number; mimeType: string } | null> {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return null;
  }
  const expanded = expandFilePreviewPath(filePath.trim());
  const fsP = await import('node:fs/promises');
  const realPath = await fsP.realpath(resolve(expanded));
  const stat = await fsP.stat(realPath);
  if (!stat.isFile()) return null;
  const mimeType = getMimeType(extname(realPath));
  if (!isStreamableMediaMime(mimeType)) return null;
  return { realPath, size: stat.size, mimeType };
}

function sendLocalMediaResponse(
  req: IncomingMessage,
  res: ServerResponse,
  file: { realPath: string; size: number; mimeType: string },
): void {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, file.size);
    if (!range) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${file.size}`);
      res.end();
      return;
    }
    const chunkSize = range.end - range.start + 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    res.setHeader('Content-Length', String(chunkSize));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file.realPath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(file.size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file.realPath).pipe(res);
}

async function generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    if (mimeType === 'image/svg+xml') {
      const buf = await readFile(filePath);
      return `data:${mimeType};base64,${buf.toString('base64')}`;
    }

    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const maxDim = 512;
    if (size.width > maxDim || size.height > maxDim) {
      const resized = size.width >= size.height
        ? img.resize({ width: maxDim })
        : img.resize({ height: maxDim });
      return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
    }
    const buf = await readFile(filePath);
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function getImageDimensions(filePath: string, mimeType: string): { width?: number; height?: number } {
  if (!mimeType.startsWith('image/') || mimeType === 'image/svg+xml') return {};
  const img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) return {};
  const size = img.getSize();
  return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : {};
}

/**
 * Resolve a Gateway-emitted outgoing-media URL to the original file on disk.
 * Mirror of `electron/main/ipc-handlers.ts::resolveOutgoingMediaUrl` — kept
 * in sync so the host-api HTTP path serves the same data as the IPC path.
 */
async function resolveOutgoingMediaUrl(
  gatewayUrl: string,
): Promise<{ path: string; mimeType: string } | null> {
  try {
    const m = gatewayUrl.match(/\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\//);
    if (!m) return null;
    const attachmentId = decodeURIComponent(m[1]);
    if (!/^[A-Za-z0-9._-]+$/.test(attachmentId)) return null;
    const recordPath = join(getOpenClawMediaDir(), 'outgoing', 'records', `${attachmentId}.json`);
    const fsP = await import('node:fs/promises');
    const raw = await fsP.readFile(recordPath, 'utf8');
    const record = JSON.parse(raw) as {
      original?: { path?: string; contentType?: string };
    };
    const original = record?.original;
    if (!original?.path) return null;
    return {
      path: original.path,
      mimeType: typeof original.contentType === 'string' && original.contentType
        ? original.contentType
        : 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/files/local-media' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const filePath = url.searchParams.get('path') || '';
      const file = await resolveLocalMediaFile(filePath);
      if (!file) {
        sendJson(res, 404, { success: false, error: 'Media file not found' });
        return true;
      }
      sendLocalMediaResponse(req, res, file);
    } catch (error) {
      sendJson(res, 404, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/remote-media' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const sourceUrl = await resolveSafeRemoteMediaUrl(url.searchParams.get('url') || '');
      if (!sourceUrl) {
        sendJson(res, 400, { success: false, error: 'Invalid remote media URL' });
        return true;
      }
      await sendRemoteMediaResponse(req, res, sourceUrl, url.searchParams.get('mimeType'));
    } catch (error) {
      sendJson(res, 502, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/stage-paths' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ filePaths: string[] }>(req);
      const fsP = await import('node:fs/promises');
      const outboundDir = getOutboundDir();
      await fsP.mkdir(outboundDir, { recursive: true });
      const results = [];
      for (const filePath of body.filePaths) {
        const id = crypto.randomUUID();
        const fileName = basename(filePath);
        const sourceStat = await fsP.stat(filePath);
        if (sourceStat.isDirectory()) {
          results.push({
            id,
            fileName,
            mimeType: DIRECTORY_MIME_TYPE,
            fileSize: 0,
            stagedPath: filePath,
            preview: null,
          });
          continue;
        }

        const ext = extname(filePath);
        const stagedPath = join(outboundDir, `${id}${ext}`);
        await fsP.copyFile(filePath, stagedPath);
        const s = await fsP.stat(stagedPath);
        const mimeType = getMimeType(ext);
        const preview = mimeType.startsWith('image/')
          ? await generateImagePreview(stagedPath, mimeType)
          : null;
        results.push({ id, fileName, mimeType, fileSize: s.size, stagedPath, preview });
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/stage-buffer' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ base64: string; fileName: string; mimeType: string }>(req);
      const fsP = await import('node:fs/promises');
      const outboundDir = getOutboundDir();
      await fsP.mkdir(outboundDir, { recursive: true });
      const id = crypto.randomUUID();
      const ext = extname(body.fileName) || mimeToExt(body.mimeType);
      const stagedPath = join(outboundDir, `${id}${ext}`);
      const buffer = Buffer.from(body.base64, 'base64');
      await fsP.writeFile(stagedPath, buffer);
      const mimeType = body.mimeType || getMimeType(ext);
      const preview = mimeType.startsWith('image/')
        ? await generateImagePreview(stagedPath, mimeType)
        : null;
      sendJson(res, 200, {
        id,
        fileName: body.fileName,
        mimeType,
        fileSize: buffer.length,
        stagedPath,
        preview,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/thumbnails' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        paths: Array<{ filePath?: string; gatewayUrl?: string; mimeType: string }>;
      }>(req);
      const fsP = await import('node:fs/promises');
      const results: Record<string, { preview: string | null; fileSize: number; filePath?: string; width?: number; height?: number }> = {};
      for (const entry of body.paths) {
        if (entry.filePath) {
          try {
            const s = await fsP.stat(entry.filePath);
            const preview = entry.mimeType.startsWith('image/')
              ? await generateImagePreview(entry.filePath, entry.mimeType)
              : null;
            results[entry.filePath] = { preview, fileSize: s.size, ...getImageDimensions(entry.filePath, entry.mimeType) };
          } catch {
            results[entry.filePath] = { preview: null, fileSize: 0 };
          }
          continue;
        }
        if (entry.gatewayUrl) {
          const resolved = await resolveOutgoingMediaUrl(entry.gatewayUrl);
          if (!resolved) {
            results[entry.gatewayUrl] = { preview: null, fileSize: 0 };
            continue;
          }
          try {
            const s = await fsP.stat(resolved.path);
            const preview = resolved.mimeType.startsWith('image/')
              ? await generateImagePreview(resolved.path, resolved.mimeType)
              : null;
            results[entry.gatewayUrl] = {
              preview,
              fileSize: s.size,
              filePath: resolved.path,
              ...getImageDimensions(resolved.path, resolved.mimeType),
            };
          } catch {
            results[entry.gatewayUrl] = { preview: null, fileSize: 0 };
          }
        }
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/save-image' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        base64?: string;
        mimeType?: string;
        filePath?: string;
        defaultFileName: string;
      }>(req);
      const ext = body.defaultFileName.includes('.')
        ? body.defaultFileName.split('.').pop()!
        : (body.mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', body.defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        sendJson(res, 200, { success: false });
        return true;
      }
      const fsP = await import('node:fs/promises');
      if (body.filePath) {
        await fsP.copyFile(body.filePath, result.filePath);
      } else if (body.base64) {
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        sendJson(res, 400, { success: false, error: 'No image data provided' });
        return true;
      }
      sendJson(res, 200, { success: true, savedPath: result.filePath });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
