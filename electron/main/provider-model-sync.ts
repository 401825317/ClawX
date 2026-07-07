import { getProviderConfig } from '../utils/provider-registry';
import { getOpenClawProviderKeyForType, isOAuthProviderType } from '../utils/provider-keys';
import type { ProviderConfig } from '../utils/secure-storage';
import {
  piAiModelsJsonModelEntry,
  piAiPromptCacheModelEntry,
  type PiAiModelsJsonModelEntry,
} from '../shared/pi-ai-model-cost';
import {
  JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW,
  JUNFEIAI_PROVIDER_ID,
  normalizeJunFeiAIModelContextWindow,
} from '../utils/junfeiai-distribution';

export interface AgentProviderUpdatePayload {
  providerKey: string;
  entry: {
    baseUrl: string;
    api: string;
    apiKey: string | undefined;
    models: PiAiModelsJsonModelEntry[];
  };
}

export function getModelIdFromRef(modelRef: string | undefined, providerKey: string): string | undefined {
  if (!modelRef) return undefined;
  if (modelRef.startsWith(`${providerKey}/`)) {
    return modelRef.slice(providerKey.length + 1);
  }
  return modelRef;
}

function modelEntryForProvider(provider: ProviderConfig, modelId: string): PiAiModelsJsonModelEntry {
  if (provider.type !== JUNFEIAI_PROVIDER_ID) {
    return piAiModelsJsonModelEntry(modelId);
  }
  const registryModel = getProviderConfig(provider.type)?.models?.find((model) => model.id === modelId);
  const contextWindow = normalizeJunFeiAIModelContextWindow(registryModel?.contextWindow)
    ?? JUNFEIAI_DEFAULT_MODEL_CONTEXT_WINDOW;
  return piAiPromptCacheModelEntry(
    modelId,
    registryModel?.name || modelId,
    contextWindow,
  );
}

export function buildNonOAuthAgentProviderUpdate(
  provider: ProviderConfig,
  providerId: string,
  modelRef: string | undefined
): AgentProviderUpdatePayload | null {
  if (provider.type === 'custom' || provider.type === 'ollama' || isOAuthProviderType(provider.type)) {
    return null;
  }

  const providerKey = getOpenClawProviderKeyForType(provider.type, providerId);
  const meta = getProviderConfig(provider.type);
  const baseUrl = provider.baseUrl || meta?.baseUrl;
  const api = meta?.api;
  if (!baseUrl || !api) return null;

  const modelId = getModelIdFromRef(modelRef, providerKey);
  return {
    providerKey,
    entry: {
      baseUrl,
      api,
      apiKey: meta?.apiKeyEnv,
      models: modelId ? [modelEntryForProvider(provider, modelId)] : [],
    },
  };
}
