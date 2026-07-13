export interface VideoAttachmentMetadata {
  width?: number;
  height?: number;
  durationSeconds?: number;
  hasAudio?: boolean;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.round(parsed);
}

/** Parse the stable, human-readable fields emitted by macOS avmediainfo. */
export function parseAvMediaInfo(output: string): VideoAttachmentMetadata {
  const presentationDimensions = output.match(/^\s*Presentation Dimensions:\s*(\d+)\s*x\s*(\d+)\s*$/mi);
  const encodedDimensions = output.match(/^\s*Dimensions:\s*(\d+)\s*x\s*(\d+)\s*$/mi);
  const dimensions = presentationDimensions ?? encodedDimensions;
  const duration = output.match(/^Duration:\s*([0-9.]+)\s+seconds\b/mi);
  const hasAudio = /^Track\s+\d+:\s+Sound\b/mi.test(output);

  return {
    width: positiveInteger(dimensions?.[1]),
    height: positiveInteger(dimensions?.[2]),
    durationSeconds: positiveNumber(duration?.[1]),
    hasAudio,
  };
}

export function hasUsefulVideoAttachmentMetadata(metadata: VideoAttachmentMetadata): boolean {
  return (
    (typeof metadata.width === 'number' && typeof metadata.height === 'number')
    || typeof metadata.durationSeconds === 'number'
    || typeof metadata.hasAudio === 'boolean'
  );
}

export function formatVideoAttachmentMetadata(metadata: VideoAttachmentMetadata): string | null {
  const parts: string[] = [];
  if (typeof metadata.width === 'number' && typeof metadata.height === 'number') {
    parts.push(`${metadata.width} x ${metadata.height}`);
  }
  if (typeof metadata.durationSeconds === 'number') {
    const seconds = metadata.durationSeconds >= 10
      ? Math.round(metadata.durationSeconds).toString()
      : metadata.durationSeconds.toFixed(1);
    parts.push(`${seconds}s`);
  }
  if (typeof metadata.hasAudio === 'boolean') {
    parts.push(metadata.hasAudio ? '有音轨' : '无音轨');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
