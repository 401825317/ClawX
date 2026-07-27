import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcpVideoGenerationOptions } from '@shared/acp-chat/types';
import { UCLAW_VIDEO_MODELS } from '@shared/junfeiai-endpoints';
import { resolveOpenClawStateDir } from '../utils/paths';

const TURN_PREFERENCE_DIRECTORY_NAME = 'uclaw-turn-preferences';
const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCE_FILE_PREFIX = 'video-turn-';
const TURN_PREFERENCE_FILE_SUFFIX = '.json';

export type AcpTurnVideoPreferenceStore = {
  enqueue(input: {
    sessionKey: string;
    message: string;
    videoOptions: AcpVideoGenerationOptions;
  }): Promise<{ id: string } | null>;
  discard(id: string | undefined): Promise<void>;
};

type StoredTurnVideoPreference = {
  version: 1;
  id: string;
  sessionKey: string;
  messageDigest: string;
  videoOptions: AcpVideoGenerationOptions;
  createdAt: number;
  expiresAt: number;
};

function digestMessage(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function normalizeVideoOptions(value: AcpVideoGenerationOptions): AcpVideoGenerationOptions | null {
  const model = UCLAW_VIDEO_MODELS.find((entry) => entry.id === value.model);
  if (
    !model
    || !(model.resolutions as readonly string[]).includes(value.resolution)
    || !(model.durations as readonly number[]).includes(value.durationSeconds)
  ) {
    return null;
  }
  return {
    model: value.model,
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

/** Stores one turn's normalized video intent without persisting the prompt text. */
export function createAcpTurnVideoPreferenceStore(
  stateDirectory = resolveOpenClawStateDir(),
): AcpTurnVideoPreferenceStore {
  const directory = path.join(stateDirectory, TURN_PREFERENCE_DIRECTORY_NAME);

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
          await rm(filePath, { force: true });
        }
      } catch {
        await rm(filePath, { force: true }).catch(() => undefined);
      }
    }));
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
      const entry: StoredTurnVideoPreference = {
        version: 1,
        id,
        sessionKey: input.sessionKey,
        messageDigest: digestMessage(message),
        videoOptions,
        createdAt,
        expiresAt: createdAt + TURN_PREFERENCE_TTL_MS,
      };
      const filePath = path.join(directory, preferenceFileName(id));
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

      try {
        await writeFile(temporaryPath, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }

      return { id };
    },

    /** Removes an unclaimed preference after ACP rejects the corresponding prompt. */
    async discard(id) {
      if (!id) return;
      await rm(path.join(directory, preferenceFileName(id)), { force: true });
    },
  };
}

export const acpTurnVideoPreferenceStore = createAcpTurnVideoPreferenceStore();
