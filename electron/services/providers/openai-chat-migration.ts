import { constants } from 'fs';
import {
  access,
  readdir,
  unlink,
} from 'fs/promises';
import { join } from 'path';
import type { GatewayManager } from '../../gateway/manager';
import type { ProviderAccount } from '../../shared/providers/types';
import { setDefaultProvider } from '../../utils/secure-storage';
import {
  getOpenClawConfigPath,
  getOpenClawAgentsDir,
} from '../../utils/paths';
import {
  readJsonDocumentWithRetry,
  writeTextFileAtomically,
} from '../../utils/json-file-io';
import { withConfigLock } from '../../utils/config-mutex';
import {
  syncDefaultProviderToRuntime,
  syncSavedProviderToRuntime,
} from './provider-runtime-sync';
import {
  getProviderAccount,
  saveProviderAccount,
  setDefaultProviderAccount,
  providerAccountToConfig,
} from './provider-store';
import {
  deleteProviderSecret,
  getProviderSecret,
  setProviderSecret,
} from '../secrets/secret-store';
import { getClawXProviderStore } from './store-instance';
import {
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
  JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER,
  JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF,
  JUNFEIAI_PROVIDER_ID,
  JUNFEIAI_RUNTIME_CONTRACT_VERSION,
  getJunFeiAIOrigin,
  getJunFeiAIProviderBaseUrl,
  isJunFeiAIManagedDistribution,
} from '../../utils/junfeiai-distribution';
import { logger } from '../../utils/logger';

const MIGRATION_FLAG_KEY = 'managedOpenAiChatMigrated';
const OPENAI_ACCOUNT_LABEL = 'OpenAI';
const BACKUP_SUFFIX = '.uclaw-pre-responses.bak';

export interface OpenAiChatMigrationResult {
  changed: boolean;
  alreadyMigrated: boolean;
  filesUpdated: number;
  refsRewritten: number;
  defaultProvider: string;
  defaultModelRef: string;
  baseUrl: string;
  protocol: string;
}

export type OpenAiChatStartupMigrationResult =
  | { status: 'already-migrated' }
  | { status: 'migrated'; result: OpenAiChatMigrationResult }
  | { status: 'failed'; error: string };

type PreparedJsonWrite = {
  path: string;
  original: string | null;
  next: string;
  refs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeBaseUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function getRuntimeProvider(data: Record<string, unknown>, providerKey: string): Record<string, unknown> | null {
  const models = isRecord(data.models) ? data.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  return isRecord(providers[providerKey])
    ? providers[providerKey]
    : null;
}

function getOpenAiRuntimeProvider(data: Record<string, unknown>): Record<string, unknown> | null {
  return getRuntimeProvider(data, JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
}

export function isManagedOpenAiRuntimeForMigration(value: unknown): boolean {
  return isRecord(value)
    && value.api === JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL
    && normalizeBaseUrl(value.baseUrl) === normalizeBaseUrl(getJunFeiAIProviderBaseUrl());
}

/** Validate the configured fallback Provider written beside managed OpenAI. */
export function isManagedTextFailoverRuntimeForMigration(data: Record<string, unknown>): boolean {
  if (!JUNFEIAI_OPENCLAW_TEXT_FAILOVER.enabled) {
    return true;
  }

  const fallback = getRuntimeProvider(data, JUNFEIAI_OPENCLAW_TEXT_FAILOVER.fallbackProvider);
  const models = fallback && Array.isArray(fallback.models) ? fallback.models : [];
  const agents = isRecord(data.agents) ? data.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const modelConfig = isRecord(defaults.model) ? defaults.model : {};
  const fallbacks = Array.isArray(modelConfig.fallbacks) ? modelConfig.fallbacks : [];

  return Boolean(
    fallback
    && fallback.api === JUNFEIAI_OPENCLAW_TEXT_FAILOVER.fallbackApiProtocol
    && normalizeBaseUrl(fallback.baseUrl) === normalizeBaseUrl(getJunFeiAIProviderBaseUrl())
    && models.some((model) => isRecord(model) && model.id === JUNFEIAI_OPENCLAW_TEXT_FAILOVER.fallbackModel)
    && fallbacks.length === 1
    && fallbacks[0] === JUNFEIAI_OPENCLAW_TEXT_FAILOVER_MODEL_REF
  );
}

export function isManagedOpenAiAccountForMigration(account: ProviderAccount | null): boolean {
  const metadata = isRecord(account?.metadata) ? account.metadata : {};
  return Boolean(
    account
    && account.id === JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID
    && account.vendorId === JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID
    && account.apiProtocol === JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL
    && (
      metadata.managedTransport === JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL
      || typeof metadata.managedRuntimeContractVersion === 'number'
      || normalizeBaseUrl(account.baseUrl) === normalizeBaseUrl(getJunFeiAIProviderBaseUrl())
    ),
  );
}

function rewriteLegacyModelRef(value: string): string {
  return value.startsWith(`${JUNFEIAI_PROVIDER_ID}/`)
    ? `${JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID}/${value.slice(JUNFEIAI_PROVIDER_ID.length + 1)}`
    : value;
}

function rewriteJsonValue(value: unknown): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const next = rewriteLegacyModelRef(value);
    return { value: next, count: next === value ? 0 : 1 };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const next = value.map((item) => {
      const rewritten = rewriteJsonValue(item);
      count += rewritten.count;
      return rewritten.value;
    });
    return { value: next, count };
  }
  if (!isRecord(value)) {
    return { value, count: 0 };
  }

  let count = 0;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = rewriteLegacyModelRef(key);
    if (nextKey !== key && Object.prototype.hasOwnProperty.call(value, nextKey)) {
      throw new Error(`Cannot migrate model reference key "${key}" because "${nextKey}" already exists`);
    }
    if (nextKey !== key) count += 1;
    const rewritten = rewriteJsonValue(item);
    count += rewritten.count;
    next[nextKey] = rewritten.value;
  }
  return { value: next, count };
}

export function rewriteManagedChatModelRefsForMigration(value: unknown): {
  value: unknown;
  count: number;
} {
  return rewriteJsonValue(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonStrict(path: string, missingAsEmpty = false): Promise<{
  original: string | null;
  data: Record<string, unknown>;
} | null> {
  try {
    const document = await readJsonDocumentWithRetry<Record<string, unknown>>(path);
    if (document === null) {
      return missingAsEmpty ? { original: null, data: {} } : null;
    }
    return {
      original: document.raw,
      data: document.data,
    };
  } catch (error) {
    throw new Error(`Cannot read migration JSON ${path}: ${String(error)}`, { cause: error });
  }
}

async function prepareJsonRewrite(path: string, missingAsEmpty = false): Promise<PreparedJsonWrite | null> {
  const document = await readJsonStrict(path, missingAsEmpty);
  if (!document) return null;
  const rewritten = rewriteManagedChatModelRefsForMigration(document.data) as {
    value: Record<string, unknown>;
    count: number;
  };
  if (rewritten.count === 0) return null;
  return {
    path,
    original: document.original,
    next: JSON.stringify(rewritten.value, null, 2),
    refs: rewritten.count,
  };
}

async function writePreparedFiles(writes: PreparedJsonWrite[]): Promise<void> {
  const applied: PreparedJsonWrite[] = [];
  try {
    for (const write of writes) {
      if (write.original !== null) {
        const backupPath = `${write.path}${BACKUP_SUFFIX}`;
        if (!(await pathExists(backupPath))) {
          await writeTextFileAtomically(backupPath, write.original);
        }
      }
      await writeTextFileAtomically(write.path, write.next);
      applied.push(write);
    }
  } catch (error) {
    for (const write of applied.reverse()) {
      if (write.original === null) {
        await unlink(write.path).catch(() => undefined);
      } else {
        await writeTextFileAtomically(write.path, write.original).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function preparePersistedModelRefWrites(): Promise<PreparedJsonWrite[]> {
  const writes: PreparedJsonWrite[] = [];
  const rootWrite = await prepareJsonRewrite(getOpenClawConfigPath(), true);
  if (rootWrite) writes.push(rootWrite);

  let agentEntries: Awaited<ReturnType<typeof readdir>>;
  try {
    agentEntries = await readdir(getOpenClawAgentsDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return writes;
    throw error;
  }
  for (const entry of agentEntries) {
    if (!entry.isDirectory()) continue;
    const agentRoot = join(getOpenClawAgentsDir(), entry.name);
    for (const path of [
      join(agentRoot, 'agent', 'models.json'),
      join(agentRoot, 'sessions', 'sessions.json'),
    ]) {
      const write = await prepareJsonRewrite(path);
      if (write) writes.push(write);
    }
  }
  return writes;
}

async function assertNoPersonalOpenAiConflict(): Promise<void> {
  // The managed build reserves the openai provider id for the signed-in relay.
  // Other distributions keep the guard so a personal account is never replaced.
  if (isJunFeiAIManagedDistribution()) {
    return;
  }

  const account = await getProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  if (account && !isManagedOpenAiAccountForMigration(account)) {
    throw new Error('managed_openai_account_conflict: an existing personal OpenAI account uses the reserved provider id');
  }

  const document = await readJsonStrict(getOpenClawConfigPath(), true);
  const runtimeOpenAi = document ? getOpenAiRuntimeProvider(document.data) : null;
  if (runtimeOpenAi && !isManagedOpenAiRuntimeForMigration(runtimeOpenAi)) {
    throw new Error('managed_openai_runtime_conflict: models.providers.openai points to a personal OpenAI endpoint');
  }
}

async function shouldReplaceManagedOpenAiRuntime(): Promise<boolean> {
  if (!isJunFeiAIManagedDistribution()) {
    return false;
  }

  const document = await readJsonStrict(getOpenClawConfigPath(), true);
  const runtimeOpenAi = document ? getOpenAiRuntimeProvider(document.data) : null;
  return Boolean(runtimeOpenAi && !isManagedOpenAiRuntimeForMigration(runtimeOpenAi));
}

function normalizeManagedOpenAiAccount(
  source: ProviderAccount | null,
  existing: ProviderAccount | null,
): ProviderAccount {
  const now = new Date().toISOString();
  const managedExisting = isManagedOpenAiAccountForMigration(existing) ? existing : null;
  const model = source?.model || managedExisting?.model || JUNFEIAI_DEFAULT_MODEL;
  return {
    id: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    vendorId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    label: managedExisting?.label || OPENAI_ACCOUNT_LABEL,
    authMode: 'api_key',
    baseUrl: getJunFeiAIProviderBaseUrl(),
    apiProtocol: JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
    model,
    fallbackModels: source?.fallbackModels ?? managedExisting?.fallbackModels ?? [],
    enabled: true,
    isDefault: true,
    metadata: {
      ...(source?.metadata ?? {}),
      ...(managedExisting?.metadata ?? {}),
      resourceUrl: getJunFeiAIOrigin(),
      managedDefaultModel: source?.metadata?.managedDefaultModel || managedExisting?.metadata?.managedDefaultModel || model,
      managedAllowedModels: source?.metadata?.managedAllowedModels || managedExisting?.metadata?.managedAllowedModels || [model],
      managedTransport: JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
      managedRuntimeContractVersion: JUNFEIAI_RUNTIME_CONTRACT_VERSION,
    },
    createdAt: managedExisting?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function ensureManagedOpenAiChatAccount(
  sourceAccount?: ProviderAccount | null,
  runtimeApiKey?: string,
): Promise<ProviderAccount> {
  await assertNoPersonalOpenAiConflict();
  const source = sourceAccount ?? await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const existing = await getProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  const account = normalizeManagedOpenAiAccount(source, existing);
  await saveProviderAccount(account);

  if (runtimeApiKey !== undefined) {
    const explicitKey = runtimeApiKey.trim();
    if (explicitKey) {
      await setProviderSecret({
        type: 'api_key',
        accountId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
        apiKey: explicitKey,
      });
    } else {
      await deleteProviderSecret(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
    }
  } else {
    const relaySecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    if (relaySecret?.type === 'api_key' && relaySecret.apiKey.trim()) {
      await setProviderSecret({
        ...relaySecret,
        accountId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
      });
    } else {
      // Do not leave a replaced personal key attached to the managed account.
      await deleteProviderSecret(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
    }
  }
  return account;
}

export async function isManagedOpenAiChatMigrated(): Promise<boolean> {
  const store = await getClawXProviderStore();
  if (store.get(MIGRATION_FLAG_KEY) !== true) return false;
  const account = await getProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  if (!isManagedOpenAiAccountForMigration(account)) return false;
  const accountMetadata = isRecord(account.metadata) ? account.metadata : {};
  if (accountMetadata.managedRuntimeContractVersion !== JUNFEIAI_RUNTIME_CONTRACT_VERSION) return false;

  const document = await readJsonStrict(getOpenClawConfigPath(), true);
  const runtimeOpenAi = document ? getOpenAiRuntimeProvider(document.data) : null;
  const agents = document && isRecord(document.data.agents) ? document.data.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const model = isRecord(defaults.model) ? defaults.model : {};
  return Boolean(
    isManagedOpenAiRuntimeForMigration(runtimeOpenAi)
    && isManagedTextFailoverRuntimeForMigration(document.data)
    && typeof model.primary === 'string'
    && model.primary.startsWith(`${JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID}/`),
  );
}

/**
 * Runs the managed Responses migration without surfacing migration failures to
 * the application startup flow or taking ownership of Gateway/app restarts.
 */
export async function autoMigrateManagedChatToOpenAiOnStartup(): Promise<OpenAiChatStartupMigrationResult> {
  try {
    if (await isManagedOpenAiChatMigrated()) {
      return { status: 'already-migrated' };
    }
    return {
      status: 'migrated',
      result: await migrateManagedChatToOpenAi(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: message };
  }
}

export async function syncManagedOpenAiChatAfterRelayRefresh(
  sourceAccount: ProviderAccount,
  runtimeApiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<ProviderAccount | null> {
  if (!(await isManagedOpenAiChatMigrated())) return null;
  const account = await ensureManagedOpenAiChatAccount(sourceAccount, runtimeApiKey);
  await syncSavedProviderToRuntime(providerAccountToConfig(account), runtimeApiKey, gatewayManager);
  await setDefaultProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  await setDefaultProvider(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  await syncDefaultProviderToRuntime(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID, gatewayManager);
  return account;
}

export async function migrateManagedChatToOpenAi(): Promise<OpenAiChatMigrationResult> {
  const alreadyMigrated = await isManagedOpenAiChatMigrated();
  await assertNoPersonalOpenAiConflict();
  const replaceManagedOpenAiRuntime = await shouldReplaceManagedOpenAiRuntime();

  const sourceAccount = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const sourceSecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
  const runtimeApiKey = sourceSecret?.type === 'api_key' ? sourceSecret.apiKey.trim() : undefined;
  const account = await ensureManagedOpenAiChatAccount(sourceAccount, runtimeApiKey);

  // Prepare the target provider first. The legacy provider and key stay intact
  // so a failed or downgraded migration still has a compatible path.
  await syncSavedProviderToRuntime(providerAccountToConfig(account), runtimeApiKey, undefined, {
    replaceManagedOpenAiRuntime,
  });

  const writes = await withConfigLock(async () => {
    const prepared = await preparePersistedModelRefWrites();
    await writePreparedFiles(prepared);
    return prepared;
  });

  await setDefaultProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  await setDefaultProvider(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  await syncDefaultProviderToRuntime(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);

  const store = await getClawXProviderStore();
  store.set(MIGRATION_FLAG_KEY, true);

  const refsRewritten = writes.reduce((sum, write) => sum + write.refs, 0);
  logger.info('[provider-migration] Managed chat migrated to native OpenAI Responses', {
    alreadyMigrated,
    filesUpdated: writes.length,
    refsRewritten,
    sourceProvider: JUNFEIAI_PROVIDER_ID,
    targetProvider: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
  });

  return {
    changed: !alreadyMigrated || writes.length > 0,
    alreadyMigrated,
    filesUpdated: writes.length,
    refsRewritten,
    defaultProvider: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    defaultModelRef: `${JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID}/${account.model || JUNFEIAI_DEFAULT_MODEL}`,
    baseUrl: account.baseUrl || getJunFeiAIProviderBaseUrl(),
    protocol: JUNFEIAI_MANAGED_OPENAI_API_PROTOCOL,
  };
}
