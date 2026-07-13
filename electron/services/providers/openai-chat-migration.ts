import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ProviderAccount, ProviderSecret } from '../../shared/providers/types';
import { getClawXProviderStore } from './store-instance';
import { getProviderAccount, saveProviderAccount, providerAccountToConfig } from './provider-store';
import { deleteProviderSecret, getProviderSecret, setProviderSecret } from '../secrets/secret-store';
import { setDefaultProvider } from '../../utils/secure-storage';
import {
  removeProviderKeyFromOpenClaw,
  saveProviderKeyToOpenClaw,
} from '../../utils/openclaw-auth';
import { syncDefaultProviderToRuntime, syncSavedProviderToRuntime } from './provider-runtime-sync';
import { withConfigLock } from '../../utils/config-mutex';
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from '../../utils/channel-config';
import { parseJsonWithBom } from '../../utils/json';
import { getOpenClawAgentsDir } from '../../utils/paths';
import {
  JUNFEIAI_DEFAULT_API_PROTOCOL,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
  JUNFEIAI_PROVIDER_ID,
  getJunFeiAIProviderBaseUrl,
  getJunFeiAIOrigin,
} from '../../utils/junfeiai-distribution';
import { logger } from '../../utils/logger';

const MIGRATION_FLAG_KEY = 'managedOpenAiChatMigrated';
const OPENAI_ACCOUNT_LABEL = 'OpenAI';

export interface OpenAiChatMigrationResult {
  changed: boolean;
  alreadyMigrated: boolean;
  openClawConfigUpdated: boolean;
  filesUpdated: number;
  refsRewritten: number;
  defaultProvider: string;
  defaultModelRef: string;
  baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
  if (!isRecord(value)) return { value, count: 0 };

  let count = 0;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = rewriteLegacyModelRef(key);
    if (nextKey !== key) count += 1;
    const rewritten = rewriteJsonValue(item);
    count += rewritten.count;
    next[nextKey] = rewritten.value;
  }
  return { value: next, count };
}

function normalizeManagedOpenAiAccount(
  source: ProviderAccount | null,
  existing: ProviderAccount | null,
): ProviderAccount {
  const now = new Date().toISOString();
  const model = source?.model || existing?.model || JUNFEIAI_DEFAULT_MODEL;
  const metadata = {
    ...(source?.metadata ?? {}),
    ...(existing?.metadata ?? {}),
    resourceUrl: source?.metadata?.resourceUrl || existing?.metadata?.resourceUrl || getJunFeiAIOrigin(),
    managedDefaultModel: source?.metadata?.managedDefaultModel || existing?.metadata?.managedDefaultModel || model,
    managedAllowedModels: source?.metadata?.managedAllowedModels || existing?.metadata?.managedAllowedModels || [model],
  };

  return {
    id: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    vendorId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    label: existing?.label || OPENAI_ACCOUNT_LABEL,
    authMode: 'api_key',
    baseUrl: getJunFeiAIProviderBaseUrl(),
    apiProtocol: JUNFEIAI_DEFAULT_API_PROTOCOL,
    model,
    fallbackModels: source?.fallbackModels ?? existing?.fallbackModels ?? [],
    enabled: true,
    isDefault: true,
    metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function relaySecretToOpenAiSecret(secret: ProviderSecret | null): ProviderSecret | null {
  if (secret?.type !== 'api_key' || !secret.apiKey.trim()) return null;
  return { ...secret, accountId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID };
}

export async function isManagedOpenAiChatMigrated(): Promise<boolean> {
  const store = await getClawXProviderStore();
  return store.get(MIGRATION_FLAG_KEY) === true;
}

async function setManagedOpenAiChatMigrated(value: boolean): Promise<void> {
  const store = await getClawXProviderStore();
  store.set(MIGRATION_FLAG_KEY, value);
}

export async function ensureManagedOpenAiChatAccount(
  sourceAccount?: ProviderAccount | null,
  runtimeApiKey?: string,
): Promise<ProviderAccount> {
  const source = sourceAccount ?? await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const existing = await getProviderAccount(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  const account = normalizeManagedOpenAiAccount(source, existing);
  await saveProviderAccount(account);

  const explicitKey = runtimeApiKey?.trim();
  const relaySecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
  const openAiSecret = explicitKey
    ? { type: 'api_key' as const, accountId: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID, apiKey: explicitKey }
    : relaySecretToOpenAiSecret(relaySecret);
  if (openAiSecret) await setProviderSecret(openAiSecret);
  return account;
}

export async function syncManagedOpenAiChatRuntime(
  account: ProviderAccount,
  runtimeApiKey?: string,
): Promise<void> {
  const managedAccount = { ...account, apiProtocol: JUNFEIAI_DEFAULT_API_PROTOCOL } satisfies ProviderAccount;
  const hasExplicitKeyInput = runtimeApiKey !== undefined;
  const explicitKey = runtimeApiKey?.trim() ?? '';
  const openAiSecret = await getProviderSecret(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  if (hasExplicitKeyInput && !explicitKey) {
    await deleteProviderSecret(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  }
  const apiKey = hasExplicitKeyInput
    ? explicitKey
    : (openAiSecret?.type === 'api_key' ? openAiSecret.apiKey.trim() : '');

  await syncSavedProviderToRuntime(providerAccountToConfig(managedAccount), apiKey || undefined);
  await syncDefaultProviderToRuntime(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  if (apiKey) await saveProviderKeyToOpenClaw(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID, apiKey);
}

async function migrateOpenClawConfigRefs(): Promise<{ updated: boolean; refs: number }> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const models = isRecord(config.models) ? config.models : {};
    const providers = isRecord(models.providers) ? { ...models.providers } : {};
    let refs = 0;
    let updated = false;
    if (providers[JUNFEIAI_PROVIDER_ID]) {
      delete providers[JUNFEIAI_PROVIDER_ID];
      models.providers = providers;
      config.models = models;
      updated = true;
    }

    const rewritten = rewriteJsonValue(config) as { value: OpenClawConfig; count: number };
    refs += rewritten.count;
    if (refs > 0) updated = true;
    if (updated) await writeOpenClawConfig(rewritten.value);
    return { updated, refs };
  });
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.trim() ? parseJsonWithBom<Record<string, unknown>>(raw) : {};
  } catch {
    return null;
  }
}

async function migrateJsonFile(
  path: string,
  options?: { removeLegacyProviderEntry?: boolean },
): Promise<number> {
  const data = await readJsonFile(path);
  if (!data) return 0;
  let refs = 0;
  if (options?.removeLegacyProviderEntry && isRecord(data.providers) && data.providers[JUNFEIAI_PROVIDER_ID]) {
    delete data.providers[JUNFEIAI_PROVIDER_ID];
    refs += 1;
  }
  const rewritten = rewriteJsonValue(data) as { value: Record<string, unknown>; count: number };
  refs += rewritten.count;
  if (refs > 0) await writeFile(path, JSON.stringify(rewritten.value, null, 2), 'utf8');
  return refs;
}

async function migrateAgentFiles(): Promise<{ filesUpdated: number; refsRewritten: number }> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(getOpenClawAgentsDir(), { withFileTypes: true });
  } catch {
    return { filesUpdated: 0, refsRewritten: 0 };
  }

  let filesUpdated = 0;
  let refsRewritten = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(getOpenClawAgentsDir(), entry.name);
    const candidates = [
      { path: join(root, 'agent', 'models.json'), removeLegacyProviderEntry: true },
      { path: join(root, 'sessions', 'sessions.json'), removeLegacyProviderEntry: false },
    ];
    for (const candidate of candidates) {
      const refs = await migrateJsonFile(candidate.path, candidate);
      if (refs > 0) {
        filesUpdated += 1;
        refsRewritten += refs;
      }
    }
  }
  return { filesUpdated, refsRewritten };
}

/** Idempotently migrate managed chat from the legacy relay key to openai/responses. */
export async function migrateManagedChatToOpenAi(): Promise<OpenAiChatMigrationResult> {
  const alreadyMigrated = await isManagedOpenAiChatMigrated();
  const sourceAccount = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
  const sourceSecret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
  const runtimeApiKey = sourceSecret?.type === 'api_key' ? sourceSecret.apiKey.trim() : undefined;
  const account = await ensureManagedOpenAiChatAccount(sourceAccount, runtimeApiKey);

  await setDefaultProvider(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID);
  await syncManagedOpenAiChatRuntime(account, runtimeApiKey);
  if (runtimeApiKey) await saveProviderKeyToOpenClaw(JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID, runtimeApiKey);
  await removeProviderKeyFromOpenClaw(JUNFEIAI_PROVIDER_ID);

  const openClawConfig = await migrateOpenClawConfigRefs();
  const agentFiles = await migrateAgentFiles();
  await setManagedOpenAiChatMigrated(true);

  logger.info('[provider-migration] Managed chat migrated to OpenAI provider', {
    alreadyMigrated,
    openClawConfigUpdated: openClawConfig.updated,
    filesUpdated: agentFiles.filesUpdated,
    refsRewritten: openClawConfig.refs + agentFiles.refsRewritten,
    sourceProvider: JUNFEIAI_PROVIDER_ID,
    targetProvider: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
  });
  return {
    changed: !alreadyMigrated || openClawConfig.updated || agentFiles.filesUpdated > 0,
    alreadyMigrated,
    openClawConfigUpdated: openClawConfig.updated,
    filesUpdated: agentFiles.filesUpdated,
    refsRewritten: openClawConfig.refs + agentFiles.refsRewritten,
    defaultProvider: JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID,
    defaultModelRef: `${JUNFEIAI_MANAGED_OPENAI_PROVIDER_ID}/${account.model || JUNFEIAI_DEFAULT_MODEL}`,
    baseUrl: account.baseUrl || getJunFeiAIProviderBaseUrl(),
  };
}
