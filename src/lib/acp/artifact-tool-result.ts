const MAX_ARTIFACT_RESULT_TEXT_LENGTH = 64 * 1024;
const MAX_ARTIFACT_PATH_LENGTH = 4096;

const OFFICE_ARTIFACT_CONTRACTS = {
  document: {
    extension: '.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  spreadsheet: {
    extension: '.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  presentation: {
    extension: '.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
} as const;

export type OfficeArtifactToolResult = {
  kind: keyof typeof OFFICE_ARTIFACT_CONTRACTS;
  filePath: string;
  fileName: string;
  mimeType: string;
  size?: number;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contractPayloadPresent(value: Record<string, unknown>): boolean {
  return ['ok', 'kind', 'filePath', 'mimeType', 'media'].some((key) => key in value);
}

function isSafeAbsolutePath(filePath: string): boolean {
  if (
    !filePath
    || filePath.length > MAX_ARTIFACT_PATH_LENGTH
    || filePath !== filePath.trim()
    || /[\0\r\n]/u.test(filePath)
  ) return false;

  if (/^\\\\[?.][\\/]/u.test(filePath)) return false;
  if (/^(?:\\\\|\/\/)/u.test(filePath)) {
    return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(filePath);
  }
  return /^\//u.test(filePath) || /^[A-Za-z]:[\\/]/u.test(filePath);
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
}

function validSize(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function parsePayload(value: Record<string, unknown>): OfficeArtifactToolResult | null {
  if (value.ok !== true) return null;
  if (typeof value.kind !== 'string' || !(value.kind in OFFICE_ARTIFACT_CONTRACTS)) return null;
  if (typeof value.filePath !== 'string' || !isSafeAbsolutePath(value.filePath)) return null;
  if (typeof value.mimeType !== 'string' || typeof value.media !== 'string') return null;

  const kind = value.kind as keyof typeof OFFICE_ARTIFACT_CONTRACTS;
  const contract = OFFICE_ARTIFACT_CONTRACTS[kind];
  const fileName = basename(value.filePath);
  if (!fileName.toLowerCase().endsWith(contract.extension)) return null;
  if (value.mimeType.toLowerCase() !== contract.mimeType) return null;
  if (value.media !== `MEDIA:${value.filePath}`) return null;

  const size = validSize(value.sizeBytes) ?? validSize(value.fileSize);
  return {
    kind,
    filePath: value.filePath,
    fileName,
    mimeType: contract.mimeType,
    ...(size !== undefined ? { size } : {}),
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (
    text.length === 0
    || text.length > MAX_ARTIFACT_RESULT_TEXT_LENGTH
    || !text.startsWith('{')
    || !text.endsWith('}')
  ) return null;
  try {
    return recordValue(JSON.parse(text));
  } catch {
    return null;
  }
}

function textPayloads(content: unknown): Record<string, unknown>[] {
  const direct = parseJsonRecord(content);
  if (direct) return [direct];
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const block = recordValue(entry);
    if (!block || block.type !== 'text') return [];
    const payload = parseJsonRecord(block.text);
    return payload ? [payload] : [];
  });
}

/** Parses only the versioned Office artifact result contract emitted by UClaw's local artifact tools. */
export function parseOfficeArtifactToolResult(value: unknown): OfficeArtifactToolResult | null {
  const root = recordValue(value);
  if (!root || root.isError === true) return null;

  const details = recordValue(root.details);
  if (details) return parsePayload(details);
  if (contractPayloadPresent(root)) return parsePayload(root);

  for (const payload of textPayloads(root.content)) {
    const artifact = parsePayload(payload);
    if (artifact) return artifact;
  }
  return null;
}
