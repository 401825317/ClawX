import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcpImageGenerationOptions } from '@shared/acp-chat/types';
import { resolveOpenClawStateDir } from '../utils/paths';

const TURN_PREFERENCE_DIRECTORY_NAME = 'uclaw-turn-preferences';
const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCE_FILE_PREFIX = 'turn-';
const TURN_PREFERENCE_FILE_SUFFIX = '.json';
const IMAGE_SIZES = new Set<AcpImageGenerationOptions['size']>([
  '1024x1536',
  '1536x1024',
  '1024x1024',
  '2160x3840',
  '3840x2160',
]);
const IMAGE_QUALITIES = new Set<AcpImageGenerationOptions['quality']>(['low', 'medium', 'high']);

export type AcpTurnImagePreferenceStore = {
  enqueue(input: {
    sessionKey: string;
    message: string;
    imageOptions: AcpImageGenerationOptions;
  }): Promise<{ id: string } | null>;
  discard(id: string | undefined): Promise<void>;
};

type StoredTurnImagePreference = {
  version: 1;
  id: string;
  sessionKey: string;
  messageDigest: string;
  messageLength: number;
  imageOptions: AcpImageGenerationOptions;
  createdAt: number;
  expiresAt: number;
};

function digestMessage(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function normalizeImageOptions(value: AcpImageGenerationOptions): AcpImageGenerationOptions | null {
  if (!IMAGE_SIZES.has(value.size) || !IMAGE_QUALITIES.has(value.quality)) {
    return null;
  }
  return { size: value.size, quality: value.quality };
}

function preferenceFileName(id: string): string {
  return `${TURN_PREFERENCE_FILE_PREFIX}${id}${TURN_PREFERENCE_FILE_SUFFIX}`;
}

function isPreferenceFileName(fileName: string): boolean {
  return fileName.startsWith(TURN_PREFERENCE_FILE_PREFIX) && fileName.endsWith(TURN_PREFERENCE_FILE_SUFFIX);
}

/** Stores only a message digest so the gateway plugin can claim one turn's UI intent. */
export function createAcpTurnImagePreferenceStore(
  stateDirectory = resolveOpenClawStateDir(),
): AcpTurnImagePreferenceStore {
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
        const entry = JSON.parse(raw) as Partial<StoredTurnImagePreference>;
        if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
          await rm(filePath, { force: true });
        }
      } catch {
        await rm(filePath, { force: true }).catch(() => undefined);
      }
    }));
  };

  return {
    /** Creates one independent file so concurrent sessions cannot overwrite each other's preference. */
    async enqueue(input) {
      const message = input.message.trim();
      const imageOptions = normalizeImageOptions(input.imageOptions);
      if (!input.sessionKey || !message || !imageOptions) {
        return null;
      }

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await removeExpiredEntries(Date.now());

      const id = randomUUID();
      const createdAt = Date.now();
      const entry: StoredTurnImagePreference = {
        version: 1,
        id,
        sessionKey: input.sessionKey,
        messageDigest: digestMessage(message),
        messageLength: message.length,
        imageOptions,
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
      const fileName = preferenceFileName(id);
      await rm(path.join(directory, fileName), { force: true });
    },
  };
}

export const acpTurnImagePreferenceStore = createAcpTurnImagePreferenceStore();
