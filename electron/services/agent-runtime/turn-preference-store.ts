import { createHash, randomUUID } from 'node:crypto';

export type UClawMediaModePreference = 'chat' | 'image' | 'video';

export type UClawTurnMediaArtifactPreference = {
  id?: string;
  filePath?: string;
  mimeType?: string;
  title?: string;
};

export type UClawTurnPreferences = {
  mode?: UClawMediaModePreference;
  image?: {
    model?: string;
    size?: string;
    quality?: 'low' | 'medium' | 'high';
  };
  video?: {
    model?: string;
    size?: string;
    durationSeconds?: number;
  };
  selectedArtifacts?: UClawTurnMediaArtifactPreference[];
};

type StoredTurnPreference = {
  id: string;
  sessionKey: string;
  idempotencyKey: string;
  messageDigest: string;
  preferences: UClawTurnPreferences;
  createdAt: number;
  expiresAt: number;
};

const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const MAX_ARTIFACTS = 8;
const MAX_STRING_LENGTH = 512;

function optionalString(value: unknown, maximum = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function digestMessage(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function normalizeArtifact(value: unknown): UClawTurnMediaArtifactPreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const artifact: UClawTurnMediaArtifactPreference = {
    id: optionalString(record.id),
    filePath: optionalString(record.filePath, 2_048),
    mimeType: optionalString(record.mimeType),
    title: optionalString(record.title),
  };
  return Object.values(artifact).some(Boolean) ? artifact : undefined;
}

export function normalizeUClawTurnPreferences(value: unknown): UClawTurnPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mode = record.mode === 'chat' || record.mode === 'image' || record.mode === 'video'
    ? record.mode
    : undefined;
  const imageRecord = record.image && typeof record.image === 'object' && !Array.isArray(record.image)
    ? record.image as Record<string, unknown>
    : undefined;
  const imageQuality = imageRecord?.quality;
  const image = imageRecord
    ? {
        model: optionalString(imageRecord.model),
        size: optionalString(imageRecord.size),
        quality: imageQuality === 'low' || imageQuality === 'medium' || imageQuality === 'high'
          ? imageQuality
          : undefined,
      }
    : undefined;
  const videoRecord = record.video && typeof record.video === 'object' && !Array.isArray(record.video)
    ? record.video as Record<string, unknown>
    : undefined;
  const rawDuration = videoRecord?.durationSeconds;
  const video = videoRecord
    ? {
        model: optionalString(videoRecord.model),
        size: optionalString(videoRecord.size),
        durationSeconds: typeof rawDuration === 'number' && Number.isFinite(rawDuration)
          ? Math.max(1, Math.min(600, Math.floor(rawDuration)))
          : undefined,
      }
    : undefined;
  const selectedArtifacts = Array.isArray(record.selectedArtifacts)
    ? record.selectedArtifacts
      .map(normalizeArtifact)
      .filter((artifact): artifact is UClawTurnMediaArtifactPreference => Boolean(artifact))
      .slice(0, MAX_ARTIFACTS)
    : undefined;

  const normalized: UClawTurnPreferences = {
    mode,
    ...(image && Object.values(image).some(Boolean) ? { image } : {}),
    ...(video && Object.values(video).some(Boolean) ? { video } : {}),
    ...(selectedArtifacts?.length ? { selectedArtifacts } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Ephemeral UI defaults for exactly one OpenClaw turn. They are intentionally
 * not transcript messages: the plugin consumes them during prompt construction.
 */
export class AgentTurnPreferenceStore {
  private readonly entries = new Map<string, StoredTurnPreference>();

  enqueue(input: {
    sessionKey: string;
    idempotencyKey: string;
    message: string;
    preferences: UClawTurnPreferences;
  }): StoredTurnPreference {
    this.prune();
    const existing = [...this.entries.values()].find((entry) => (
      entry.sessionKey === input.sessionKey
      && entry.idempotencyKey === input.idempotencyKey
    ));
    if (existing) return structuredClone(existing);

    const now = Date.now();
    const entry: StoredTurnPreference = {
      id: randomUUID(),
      sessionKey: input.sessionKey,
      idempotencyKey: input.idempotencyKey,
      messageDigest: digestMessage(input.message),
      preferences: structuredClone(input.preferences),
      createdAt: now,
      expiresAt: now + TURN_PREFERENCE_TTL_MS,
    };
    this.entries.set(entry.id, entry);
    return structuredClone(entry);
  }

  consume(input: { sessionKey: string; message: string }): UClawTurnPreferences | undefined {
    this.prune();
    const messageDigest = digestMessage(input.message);
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.sessionKey === input.sessionKey && candidate.messageDigest === messageDigest)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!entry) return undefined;
    this.entries.delete(entry.id);
    return structuredClone(entry.preferences);
  }

  discard(id: string | undefined): void {
    if (id) this.entries.delete(id);
  }

  private prune(now = Date.now()): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

export const agentTurnPreferenceStore = new AgentTurnPreferenceStore();
