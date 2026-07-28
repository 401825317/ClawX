import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcpVideoGenerationOptions } from '@shared/acp-chat/types';
import { UCLAW_VIDEO_MODELS } from '@shared/junfeiai-endpoints';
import { resolveOpenClawStateDir } from '../utils/paths';

const TURN_PREFERENCE_DIRECTORY_NAME = 'uclaw-turn-preferences';
const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCE_FILE_PREFIX = 'video-turn-';
const TURN_PREFERENCE_FILE_SUFFIX = '.json';
const REFERENCE_IMAGE_FILE_PREFIX = 'video-reference-';

export type AcpTurnVideoReferenceImage = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

export type AcpTurnVideoPreferenceStore = {
  enqueue(input: {
    sessionKey: string;
    message: string;
    videoOptions: AcpVideoGenerationOptions;
    referenceImage?: AcpTurnVideoReferenceImage;
  }): Promise<{ id: string } | null>;
  discard(id: string | undefined): Promise<void>;
};

type StoredTurnVideoPreference = {
  version: 1;
  id: string;
  sessionKey: string;
  messageDigest: string;
  messageLength: number;
  videoOptions: AcpVideoGenerationOptions;
  referenceImage?: {
    filePath: string;
    fileName: string;
    mimeType: string;
  };
  createdAt: number;
  expiresAt: number;
};

function digestMessage(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function normalizeVideoOptions(value: AcpVideoGenerationOptions): AcpVideoGenerationOptions | null {
  const supported = UCLAW_VIDEO_MODELS.some((model) => (
    (model.aspectRatios as readonly string[]).includes(value.aspectRatio)
    && (model.resolutions as readonly string[]).includes(value.resolution)
    && (model.durations as readonly number[]).includes(value.durationSeconds)
  ));
  if (!supported) {
    return null;
  }
  return {
    aspectRatio: value.aspectRatio,
    resolution: value.resolution,
    durationSeconds: value.durationSeconds,
  };
}

function preferenceFileName(id: string): string {
  return `${TURN_PREFERENCE_FILE_PREFIX}${id}${TURN_PREFERENCE_FILE_SUFFIX}`;
}

function isPreferenceFileName(fileName: string): boolean {
  return fileName.startsWith(TURN_PREFERENCE_FILE_PREFIX) && fileName.endsWith(TURN_PREFERENCE_FILE_SUFFIX);
}

function referenceImageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.img';
  }
}

function isManagedReferenceImagePath(directory: string, filePath: unknown): filePath is string {
  return typeof filePath === 'string'
    && path.dirname(filePath) === directory
    && path.basename(filePath).startsWith(REFERENCE_IMAGE_FILE_PREFIX);
}

/** Stores one turn's normalized video intent without persisting the prompt text. */
export function createAcpTurnVideoPreferenceStore(
  stateDirectory = resolveOpenClawStateDir(),
): AcpTurnVideoPreferenceStore {
  // OpenClaw accepts local tool media only from its managed media roots.
  const directory = path.join(stateDirectory, 'media', TURN_PREFERENCE_DIRECTORY_NAME);
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearScheduledCleanup = (id: unknown): void => {
    if (typeof id !== 'string') return;
    const timer = cleanupTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    cleanupTimers.delete(id);
  };

  /** Atomically takes ownership before deleting a preference and its reference image. */
  const claimPreferenceFile = async (filePath: string, suffix: string): Promise<string | null> => {
    const claimedPath = `${filePath}.${process.pid}.${randomUUID()}.${suffix}`;
    try {
      await rename(filePath, claimedPath);
      return claimedPath;
    } catch {
      return null;
    }
  };

  const removeManagedReferenceImage = async (filePath: unknown): Promise<void> => {
    if (!isManagedReferenceImagePath(directory, filePath)) return;
    await rm(filePath, { force: true });
  };

  const removeOrphanedReferenceImages = async (entries: string[], now: number): Promise<void> => {
    await Promise.all(entries
      .filter((fileName) => fileName.startsWith(REFERENCE_IMAGE_FILE_PREFIX))
      .map(async (fileName) => {
        const filePath = path.join(directory, fileName);
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat && fileStat.mtimeMs + TURN_PREFERENCE_TTL_MS <= now) {
          await rm(filePath, { force: true });
        }
      }));
  };

  const removeExpiredEntries = async (now: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }

    await Promise.all(entries.filter(isPreferenceFileName).map(async (fileName) => {
      const filePath = path.join(directory, fileName);
      try {
        const raw = await readFile(filePath, 'utf8');
        const entry = JSON.parse(raw) as Partial<StoredTurnVideoPreference>;
        if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
          const claimedPath = await claimPreferenceFile(filePath, 'expired');
          if (!claimedPath) return;
          clearScheduledCleanup(entry.id);
          try {
            await removeManagedReferenceImage(entry.referenceImage?.filePath);
          } finally {
            await rm(claimedPath, { force: true });
          }
        }
      } catch {
        const claimedPath = await claimPreferenceFile(filePath, 'invalid');
        if (claimedPath) await rm(claimedPath, { force: true }).catch(() => undefined);
      }
    }));
    await removeOrphanedReferenceImages(entries, now);
  };

  const scheduleCleanup = (entry: StoredTurnVideoPreference): void => {
    clearScheduledCleanup(entry.id);
    const timer = setTimeout(async () => {
      cleanupTimers.delete(entry.id);
      await removeExpiredEntries(Date.now()).catch(() => undefined);
      await removeManagedReferenceImage(entry.referenceImage?.filePath).catch(() => undefined);
    }, Math.max(0, entry.expiresAt - Date.now()));
    timer.unref?.();
    cleanupTimers.set(entry.id, timer);
  };

  return {
    /** Creates an independent file so concurrent sessions cannot overwrite each other. */
    async enqueue(input) {
      const message = input.message.trim();
      const videoOptions = normalizeVideoOptions(input.videoOptions);
      if (!input.sessionKey || !message || !videoOptions) return null;

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await removeExpiredEntries(Date.now());

      const id = randomUUID();
      const createdAt = Date.now();
      const referenceImagePath = input.referenceImage
        ? path.join(
          directory,
          `${REFERENCE_IMAGE_FILE_PREFIX}${id}${referenceImageExtension(input.referenceImage.mimeType)}`,
        )
        : undefined;
      const entry: StoredTurnVideoPreference = {
        version: 1,
        id,
        sessionKey: input.sessionKey,
        messageDigest: digestMessage(message),
        messageLength: message.length,
        videoOptions,
        ...(input.referenceImage && referenceImagePath
          ? {
            referenceImage: {
              filePath: referenceImagePath,
              fileName: input.referenceImage.fileName,
              mimeType: input.referenceImage.mimeType,
            },
          }
          : {}),
        createdAt,
        expiresAt: createdAt + TURN_PREFERENCE_TTL_MS,
      };
      const filePath = path.join(directory, preferenceFileName(id));
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

      try {
        if (input.referenceImage && referenceImagePath) {
          await writeFile(referenceImagePath, input.referenceImage.buffer, { mode: 0o600, flag: 'wx' });
        }
        await writeFile(temporaryPath, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, filePath);
        scheduleCleanup(entry);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        await removeManagedReferenceImage(referenceImagePath).catch(() => undefined);
        throw error;
      }

      return { id };
    },

    /** Removes an unclaimed preference after ACP rejects the corresponding prompt. */
    async discard(id) {
      if (!id) return;
      const filePath = path.join(directory, preferenceFileName(id));
      const claimedPath = await claimPreferenceFile(filePath, 'discarded');
      if (!claimedPath) return;
      clearScheduledCleanup(id);
      const entry = await readFile(claimedPath, 'utf8')
        .then((raw) => JSON.parse(raw) as Partial<StoredTurnVideoPreference>)
        .catch(() => null);
      try {
        await removeManagedReferenceImage(entry?.referenceImage?.filePath);
      } finally {
        await rm(claimedPath, { force: true });
      }
    },
  };
}

export const acpTurnVideoPreferenceStore = createAcpTurnVideoPreferenceStore();
