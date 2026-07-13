import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  hasUsefulVideoAttachmentMetadata,
  parseAvMediaInfo,
  type VideoAttachmentMetadata,
} from '../../shared/video-attachment-metadata';

const execFileAsync = promisify(execFile);

export async function probeVideoAttachmentMetadata(
  filePath: string,
  mimeType: string,
): Promise<VideoAttachmentMetadata> {
  if (!mimeType.startsWith('video/') || process.platform !== 'darwin') return {};
  try {
    const { stdout } = await execFileAsync('/usr/bin/avmediainfo', [filePath], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const metadata = parseAvMediaInfo(stdout);
    return hasUsefulVideoAttachmentMetadata(metadata) ? metadata : {};
  } catch {
    // Metadata is presentation-only evidence. A probe failure must never block delivery.
    return {};
  }
}
