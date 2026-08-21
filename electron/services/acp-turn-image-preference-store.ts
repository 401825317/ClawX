import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcpImageGenerationOptions } from '@shared/acp-chat/types';
import type { ManagedClientImageModelPolicy } from '@shared/managed-client-config';
import { resolveOpenClawStateDir } from '../utils/paths';
import { getVerifiedManagedClientImageModelPolicySnapshot } from './managed-client-config-service';

const TURN_PREFERENCE_DIRECTORY_NAME = 'uclaw-turn-preferences';
const TURN_PREFERENCE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCE_FILE_PREFIX = 'turn-';
const TURN_PREFERENCE_FILE_SUFFIX = '.json';

export type AcpTurnImagePolicyResolver = () => ManagedClientImageModelPolicy | null;

type AcpTurnImagePreferenceStoreDependencies = {
  resolvePolicy: AcpTurnImagePolicyResolver;
};

export type AcpTurnImagePreferenceStore = {
  enqueue(input: {
    sessionKey: string;
    message: string;
    imageOptions: AcpImageGenerationOptions;
  }): Promise<{ id: string } | null>;
  discard(id: string | undefined): Promise<void>;
};

type StoredTurnImagePreference = {
  version: 2;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizedString).filter((entry): entry is string => Boolean(entry)))];
}

function normalizePolicy(value: unknown): ManagedClientImageModelPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const seen = new Set<string>();
  const models = value.models.flatMap((entry): ManagedClientImageModelPolicy['models'] => {
    if (!isRecord(entry)) return [];
    const id = normalizedString(entry.id);
    const sizes = normalizedStringList(entry.sizes);
    const qualities = normalizedStringList(entry.qualities);
    if (!id || seen.has(id) || sizes.length === 0 || qualities.length === 0) return [];
    seen.add(id);
    const defaultSize = normalizedString(entry.defaultSize);
    const defaultQuality = normalizedString(entry.defaultQuality);
    if (!defaultSize || !sizes.includes(defaultSize) || !defaultQuality || !qualities.includes(defaultQuality)) {
      return [];
    }
    return [{
      id,
      sizes,
      qualities,
      defaultSize,
      defaultQuality,
      supportsEditing: entry.supportsEditing === true,
    }];
  });
  const defaultModel = normalizedString(value.defaultModel);
  const selected = models.find((model) => model.id === defaultModel);
  const defaultSize = normalizedString(value.defaultSize);
  const defaultQuality = normalizedString(value.defaultQuality);
  if (
    !selected
    || !defaultSize
    || !selected.sizes.includes(defaultSize)
    || !defaultQuality
    || !selected.qualities.includes(defaultQuality)
  ) return null;
  return { models, defaultModel: selected.id, defaultSize, defaultQuality };
}

function normalizeImageOptions(
  value: AcpImageGenerationOptions,
  resolvePolicy: AcpTurnImagePolicyResolver,
): AcpImageGenerationOptions | null {
  const modelId = normalizedString(value.modelId);
  const size = normalizedString(value.size);
  const quality = normalizedString(value.quality);
  if (!modelId || !size || !quality) return null;

  let policy: ManagedClientImageModelPolicy | null;
  try {
    policy = normalizePolicy(resolvePolicy());
  } catch {
    return null;
  }
  const model = policy?.models.find((entry) => entry.id === modelId);
  if (!model || !model.sizes.includes(size) || !model.qualities.includes(quality)) {
    return null;
  }
  return {
    modelId,
    size,
    quality,
    ...(value.preset ? { preset: value.preset } : {}),
  };
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
  dependencies: Partial<AcpTurnImagePreferenceStoreDependencies> = {},
): AcpTurnImagePreferenceStore {
  const directory = path.join(stateDirectory, TURN_PREFERENCE_DIRECTORY_NAME);
  const resolvePolicy = dependencies.resolvePolicy ?? getVerifiedManagedClientImageModelPolicySnapshot;

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
      const imageOptions = normalizeImageOptions(input.imageOptions, resolvePolicy);
      if (!input.sessionKey || !message || !imageOptions) {
        return null;
      }

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await removeExpiredEntries(Date.now());

      const id = randomUUID();
      const createdAt = Date.now();
      const entry: StoredTurnImagePreference = {
        version: 2,
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
