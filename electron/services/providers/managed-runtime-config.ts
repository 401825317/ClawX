import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ManagedClientTextModelPolicy } from '../../../shared/managed-client-config';
import {
  UCLAW_COMPATIBILITY_PROVIDER_ID,
  UCLAW_DEFAULT_API_PROTOCOL,
  UCLAW_DEFAULT_MODEL,
  UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW,
  UCLAW_DEFAULT_THINKING_LEVEL,
  UCLAW_LEGACY_PROVIDER_IDS,
  UCLAW_MANAGED_PROVIDER_BASE_URL,
  UCLAW_MANAGED_PROVIDER_ID,
  UCLAW_PROVIDER_REQUEST_TIMEOUT_SECONDS,
} from '../../../shared/junfeiai-endpoints';
import { resolveOpenClawConfigPath } from '../../utils/paths';
import { withConfigLock } from '../../utils/config-mutex';
import { isOpenAiProviderIdentity } from './provider-mutation-lock';

type JsonRecord = Record<string, unknown>;

type FileGeneration = {
  exists: boolean;
  sha256: string;
};

type FileState = {
  content: Buffer | null;
  generation: FileGeneration;
  mode: number;
};

export type ManagedRuntimeConfigSnapshot = {
  before: FileState;
  applied?: FileGeneration;
};

export type ManagedRuntimeProviderEntry = {
  baseUrl: string;
  api: string;
  timeoutSeconds: number;
  request: { allowPrivateNetwork: true };
  agentRuntime: { id: 'pi' };
  models: Array<Record<string, unknown> & { id: string; name: string }>;
};

const UCLAW_RESPONSES_REASONING_COMPAT = {
  supportsPromptCacheKey: true,
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
} as const;

let atomicWriteSequence = 0;

function generation(content: Buffer | null): FileGeneration {
  return {
    exists: content !== null,
    sha256: createHash('sha256').update(content ?? Buffer.alloc(0)).digest('hex'),
  };
}

function sameGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256;
}

async function readState(filePath: string): Promise<FileState> {
  try {
    const [content, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    return { content, generation: generation(content), mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: null, generation: generation(null), mode: 0o600 };
    }
    throw error;
  }
}

function parseStrictConfig(state: FileState): JsonRecord {
  if (state.content === null) return {};
  const parsed = JSON.parse(state.content.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenClaw config must contain a JSON object');
  }
  return parsed as JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function managedOpenAiProviderIds(additionalProviderIds: Iterable<string>): Set<string> {
  return new Set([
    UCLAW_MANAGED_PROVIDER_ID,
    UCLAW_COMPATIBILITY_PROVIDER_ID,
    ...UCLAW_LEGACY_PROVIDER_IDS,
    ...additionalProviderIds,
  ]);
}

function managedRuntimeModelEntry(
  model: ManagedClientTextModelPolicy['models'][number],
): Record<string, unknown> & { id: string; name: string } {
  const supportsManagedReasoning = model.id === UCLAW_DEFAULT_MODEL;
  return {
    id: model.id,
    name: model.label?.trim() || model.id,
    contextWindow: UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(supportsManagedReasoning ? { reasoning: true } : {}),
    compat: supportsManagedReasoning
      ? { ...UCLAW_RESPONSES_REASONING_COMPAT }
      : { supportsPromptCacheKey: true },
  };
}

/** Create the identical runtime catalog installed for both managed Provider ids. */
export function createManagedRuntimeProviderEntry(
  policy: ManagedClientTextModelPolicy,
): ManagedRuntimeProviderEntry {
  return {
    baseUrl: UCLAW_MANAGED_PROVIDER_BASE_URL,
    api: UCLAW_DEFAULT_API_PROTOCOL,
    timeoutSeconds: UCLAW_PROVIDER_REQUEST_TIMEOUT_SECONDS,
    request: { allowPrivateNetwork: true },
    agentRuntime: { id: 'pi' },
    models: policy.models.map(managedRuntimeModelEntry),
  };
}

function isManagedRuntimeProvider(
  providerId: string,
  entry: unknown,
  managedProviderIds: ReadonlySet<string>,
): boolean {
  return managedProviderIds.has(providerId)
    || isOpenAiProviderIdentity({
      ...(isRecord(entry) ? entry : {}),
      id: providerId,
    });
}

async function assertGeneration(filePath: string, expected: FileGeneration): Promise<void> {
  const current = await readState(filePath);
  if (!sameGeneration(current.generation, expected)) {
    throw new Error('OpenClaw config changed during the managed authentication transaction');
  }
}

async function replaceAtomically(
  filePath: string,
  content: Buffer,
  mode: number,
  expected: FileGeneration,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.uclaw-${process.pid}-${Date.now()}-${++atomicWriteSequence}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertGeneration(filePath, expected);
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

/** Capture the exact raw OpenClaw config generation; malformed JSON fails later before mutation. */
export async function snapshotManagedRuntimeConfig(): Promise<ManagedRuntimeConfigSnapshot> {
  return withConfigLock(async () => ({
    before: await readState(resolveOpenClawConfigPath()),
  }));
}

/** Discover managed OpenAI ids from the immutable runtime snapshot. */
export function getManagedRuntimeOpenAiProviderIds(
  snapshot: ManagedRuntimeConfigSnapshot,
): string[] {
  const config = parseStrictConfig(snapshot.before);
  if (!isRecord(config.models) || !isRecord(config.models.providers)) return [];
  const managedProviderIds = managedOpenAiProviderIds([]);
  return Object.entries(config.models.providers)
    .filter(([providerId, entry]) => (
      isManagedRuntimeProvider(providerId, entry, managedProviderIds)
    ))
    .map(([providerId]) => providerId)
    .sort();
}

/** Strictly parse and atomically replace the snapshotted config generation. */
export async function updateManagedRuntimeConfig(
  snapshot: ManagedRuntimeConfigSnapshot,
  mutate: (config: JsonRecord) => void | boolean,
): Promise<void> {
  await withConfigLock(async () => {
    const filePath = resolveOpenClawConfigPath();
    const current = await readState(filePath);
    if (!sameGeneration(current.generation, snapshot.before.generation)) {
      throw new Error('OpenClaw config changed before the managed authentication write');
    }
    const config = structuredClone(parseStrictConfig(current));
    const changed = mutate(config);
    if (changed === false) return;
    const commands = config.commands && typeof config.commands === 'object' && !Array.isArray(config.commands)
      ? { ...(config.commands as JsonRecord) }
      : {};
    commands.restart = true;
    config.commands = commands;
    const content = Buffer.from(JSON.stringify(config, null, 2), 'utf8');
    // Record the intended generation before I/O so a post-rename error can
    // still be distinguished from an unrelated external write during rollback.
    snapshot.applied = generation(content);
    await replaceAtomically(filePath, content, current.mode, current.generation);
  });
}

function removeManagedRuntimeAuthMetadata(
  config: JsonRecord,
  managedProviderIds: ReadonlySet<string>,
): boolean {
  if (!isRecord(config.auth)) return false;
  const auth = { ...config.auth };
  const profiles = isRecord(auth.profiles) ? { ...auth.profiles } : null;
  const removedProfileIds = new Set<string>();
  let changed = false;

  if (profiles) {
    for (const [profileId, profile] of Object.entries(profiles)) {
      const provider = isRecord(profile) ? profile.provider : undefined;
      if (
        typeof provider !== 'string'
        || (!managedProviderIds.has(provider) && !isOpenAiProviderIdentity(provider))
      ) {
        continue;
      }
      delete profiles[profileId];
      removedProfileIds.add(profileId);
      changed = true;
    }
    if (Object.keys(profiles).length > 0) auth.profiles = profiles;
    else delete auth.profiles;
  }

  const order = isRecord(auth.order) ? { ...auth.order } : null;
  if (order) {
    for (const [providerId, rawProfileIds] of Object.entries(order)) {
      if (managedProviderIds.has(providerId) || isOpenAiProviderIdentity(providerId)) {
        delete order[providerId];
        changed = true;
        continue;
      }
      if (!Array.isArray(rawProfileIds)) continue;
      const retainedProfileIds = rawProfileIds.filter(
        (profileId) => typeof profileId !== 'string' || !removedProfileIds.has(profileId),
      );
      if (retainedProfileIds.length === rawProfileIds.length) continue;
      changed = true;
      if (retainedProfileIds.length > 0) order[providerId] = retainedProfileIds;
      else delete order[providerId];
    }
    if (Object.keys(order).length > 0) auth.order = order;
    else delete auth.order;
  }

  const lastGood = isRecord(auth.lastGood) ? { ...auth.lastGood } : null;
  if (lastGood) {
    for (const [providerId, profileId] of Object.entries(lastGood)) {
      if (
        managedProviderIds.has(providerId)
        || isOpenAiProviderIdentity(providerId)
        || (typeof profileId === 'string' && removedProfileIds.has(profileId))
      ) {
        delete lastGood[providerId];
        changed = true;
      }
    }
    if (Object.keys(lastGood).length > 0) auth.lastGood = lastGood;
    else delete auth.lastGood;
  }

  const usageStats = isRecord(auth.usageStats) ? { ...auth.usageStats } : null;
  if (usageStats) {
    for (const profileId of removedProfileIds) {
      if (!Object.hasOwn(usageStats, profileId)) continue;
      delete usageStats[profileId];
      changed = true;
    }
    if (Object.keys(usageStats).length > 0) auth.usageStats = usageStats;
    else delete auth.usageStats;
  }

  if (!changed) return false;
  if (Object.keys(auth).length > 0) config.auth = auth;
  else delete config.auth;
  return true;
}

function isManagedModelRef(value: unknown, managedProviderIds: ReadonlySet<string>): boolean {
  if (typeof value !== 'string') return false;
  const providerId = value.trim().split('/', 1)[0];
  return managedProviderIds.has(providerId) || isOpenAiProviderIdentity(providerId);
}

function removeManagedRuntimeModelDefaults(
  config: JsonRecord,
  managedProviderIds: ReadonlySet<string>,
): boolean {
  if (!isRecord(config.agents) || !isRecord(config.agents.defaults)) return false;
  const agents = { ...config.agents };
  const defaults = { ...config.agents.defaults };
  const rawModel = defaults.model;
  let changed = false;

  if (typeof rawModel === 'string') {
    if (!isManagedModelRef(rawModel, managedProviderIds)) return false;
    delete defaults.model;
    changed = true;
  } else if (isRecord(rawModel)) {
    const model = { ...rawModel };
    const fallbacks = Array.isArray(model.fallbacks)
      ? model.fallbacks.filter((value) => !isManagedModelRef(value, managedProviderIds))
      : [];
    if (Array.isArray(model.fallbacks) && fallbacks.length !== model.fallbacks.length) {
      model.fallbacks = fallbacks;
      changed = true;
    }
    if (isManagedModelRef(model.primary, managedProviderIds)) {
      if (fallbacks.length > 0 && typeof fallbacks[0] === 'string') {
        model.primary = fallbacks[0];
        model.fallbacks = fallbacks.slice(1);
      } else {
        delete model.primary;
      }
      changed = true;
    }
    if (changed) {
      if (Array.isArray(model.fallbacks) && model.fallbacks.length === 0) {
        delete model.fallbacks;
      }
      if (Object.keys(model).length > 0) defaults.model = model;
      else delete defaults.model;
    }
  }

  if (!changed) return false;
  agents.defaults = defaults;
  config.agents = agents;
  return true;
}

/** Install both managed Provider catalogs and the canonical OpenAI default route. */
export async function installManagedRuntimeProviderState(
  snapshot: ManagedRuntimeConfigSnapshot,
  policy: ManagedClientTextModelPolicy,
  additionalProviderIds: Iterable<string> = [],
): Promise<void> {
  const managedProviderIds = managedOpenAiProviderIds(additionalProviderIds);
  const providerEntry = createManagedRuntimeProviderEntry(policy);
  await updateManagedRuntimeConfig(snapshot, (config) => {
    const before = JSON.stringify(config);
    const agents = isRecord(config.agents) ? { ...config.agents } : {};
    const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
    defaults.model = {
      primary: `${UCLAW_MANAGED_PROVIDER_ID}/${policy.defaultModel}`,
      fallbacks: [],
    };
    defaults.thinkingDefault = UCLAW_DEFAULT_THINKING_LEVEL;
    defaults.reasoningDefault = 'on';
    agents.defaults = defaults;
    config.agents = agents;

    removeManagedRuntimeAuthMetadata(config, managedProviderIds);

    const models = isRecord(config.models) ? { ...config.models } : {};
    const providers = isRecord(models.providers) ? { ...models.providers } : {};
    for (const [providerId, existingEntry] of Object.entries(providers)) {
      if (isManagedRuntimeProvider(providerId, existingEntry, managedProviderIds)) {
        delete providers[providerId];
      }
    }
    providers[UCLAW_MANAGED_PROVIDER_ID] = structuredClone(providerEntry);
    providers[UCLAW_COMPATIBILITY_PROVIDER_ID] = structuredClone(providerEntry);
    models.providers = providers;
    config.models = models;
    return JSON.stringify(config) !== before;
  });
}

/** Remove managed runtime providers and auth metadata with CAS rollback protection. */
export async function removeManagedRuntimeOpenAiState(
  snapshot: ManagedRuntimeConfigSnapshot,
  additionalProviderIds: Iterable<string> = [],
): Promise<void> {
  const managedProviderIds = managedOpenAiProviderIds(additionalProviderIds);
  try {
    await updateManagedRuntimeConfig(snapshot, (config) => {
      let changed = removeManagedRuntimeAuthMetadata(config, managedProviderIds);
      changed = removeManagedRuntimeModelDefaults(config, managedProviderIds) || changed;
      if (!isRecord(config.models) || !isRecord(config.models.providers)) return changed;

      const models = { ...config.models };
      const providers = { ...config.models.providers };
      for (const [providerId, entry] of Object.entries(providers)) {
        if (!isManagedRuntimeProvider(providerId, entry, managedProviderIds)) continue;
        delete providers[providerId];
        changed = true;
      }
      if (changed) {
        models.providers = providers;
        config.models = models;
      }
      return changed;
    });
  } catch (cause) {
    if (!snapshot.applied) throw cause;
    try {
      await restoreManagedRuntimeConfig(snapshot);
    } catch (rollbackCause) {
      throw new AggregateError(
        [cause, rollbackCause],
        'Failed to remove managed OpenClaw runtime state and restore the previous config',
        { cause: rollbackCause },
      );
    }
    throw cause;
  }
}

/** Restore the exact raw bytes only if the file is still the generation installed above. */
export async function restoreManagedRuntimeConfig(
  snapshot: ManagedRuntimeConfigSnapshot,
): Promise<void> {
  if (!snapshot.applied) return;
  await withConfigLock(async () => {
    const filePath = resolveOpenClawConfigPath();
    const current = await readState(filePath);
    if (sameGeneration(current.generation, snapshot.before.generation)) {
      return;
    }
    if (!sameGeneration(current.generation, snapshot.applied!)) {
      throw new Error('OpenClaw config changed after the managed authentication write');
    }
    if (snapshot.before.content === null) {
      await assertGeneration(filePath, current.generation);
      await unlink(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      return;
    }
    await replaceAtomically(
      filePath,
      snapshot.before.content,
      snapshot.before.mode,
      current.generation,
    );
  });
}
