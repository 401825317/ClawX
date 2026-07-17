import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderAccount } from '../electron/shared/providers/types.ts';
import {
  buildJunFeiAIProviderAccount,
  hasJunFeiAIProviderAccountChanged,
  shouldSyncJunFeiAIRuntime,
  type JunFeiAIBootstrapPayload,
} from '../electron/services/junfeiai/junfeiai-service.ts';

const bootstrap: JunFeiAIBootstrapPayload = {
  service: {
    displayName: '零至无限',
    apiOrigin: 'https://zz-cn.lingzhiwuxian.com',
  },
  runtime: {
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
    defaultModel: 'smart-latest',
    fallbackModels: [],
  },
  client: {
    modelOptions: {
      text: {
        defaultModel: 'smart-latest',
        models: [{ id: 'smart-latest', enabled: true }],
      },
    },
  },
};

function existingAccount(isDefault: boolean): ProviderAccount {
  return {
    id: 'lingzhiwuxian',
    vendorId: 'lingzhiwuxian',
    label: '零至无限',
    authMode: 'api_key',
    baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
    apiProtocol: 'openai-responses',
    model: 'smart-latest',
    fallbackModels: [],
    enabled: true,
    isDefault,
    metadata: {
      resourceUrl: 'https://zz-cn.lingzhiwuxian.com',
      managedDefaultModel: 'smart-latest',
      managedAllowedModels: ['smart-latest'],
      managedRuntimeContractVersion: 4,
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

test('managed status refresh preserves the migrated OpenAI default ownership', () => {
  const existing = existingAccount(false);
  const rebuilt = buildJunFeiAIProviderAccount(bootstrap, existing);

  assert.equal(rebuilt.isDefault, false);
  assert.equal(hasJunFeiAIProviderAccountChanged(existing, rebuilt), false);
});

test('the first managed provider seed remains default before migration', () => {
  const account = buildJunFeiAIProviderAccount(bootstrap);

  assert.equal(account.isDefault, true);
});

test('background status refresh ignores provider metadata drift while preserving auth sync', () => {
  const statusRefresh = {
    syncRuntime: false,
    syncRuntimeOnAuthChange: true,
  };

  assert.equal(shouldSyncJunFeiAIRuntime(statusRefresh, {
    providerChanged: true,
    defaultProviderChanged: true,
    relaySecretChanged: false,
    shouldClearRuntimeKey: false,
  }), false);
  assert.equal(shouldSyncJunFeiAIRuntime(statusRefresh, {
    providerChanged: false,
    defaultProviderChanged: false,
    relaySecretChanged: true,
    shouldClearRuntimeKey: false,
  }), true);
  assert.equal(shouldSyncJunFeiAIRuntime(statusRefresh, {
    providerChanged: false,
    defaultProviderChanged: false,
    relaySecretChanged: false,
    shouldClearRuntimeKey: true,
  }), true);
});

test('explicit and default runtime sync still apply provider configuration changes', () => {
  const providerChange = {
    providerChanged: true,
    defaultProviderChanged: false,
    relaySecretChanged: false,
    shouldClearRuntimeKey: false,
  };

  assert.equal(shouldSyncJunFeiAIRuntime({ syncRuntime: true }, providerChange), true);
  assert.equal(shouldSyncJunFeiAIRuntime({}, providerChange), true);
});
