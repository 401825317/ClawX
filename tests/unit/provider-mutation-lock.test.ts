import { describe, expect, it } from 'vitest';
import {
  ManagedProviderMutationError,
  assertProviderMutationAllowed,
  isOpenAiProviderIdentity,
} from '@electron/services/providers/provider-mutation-lock';

const managedOpenAi = {
  id: 'openai',
  vendorId: 'openai',
  metadata: { managedBy: 'uclaw' },
};

describe('provider mutation identity guard', () => {
  it('recognizes compatibility Provider objects by vendor or runtime type', () => {
    const compatibilityAccount = {
      id: 'compatibility-alias',
      vendorId: 'lingzhiwuxian',
    };
    const compatibilityRuntime = {
      id: 'runtime-alias',
      type: 'lingzhiwuxian',
    };

    expect(isOpenAiProviderIdentity(compatibilityAccount)).toBe(true);
    expect(isOpenAiProviderIdentity(compatibilityRuntime)).toBe(true);
    expect(() => assertProviderMutationAllowed(managedOpenAi, compatibilityAccount))
      .toThrow(ManagedProviderMutationError);
    expect(() => assertProviderMutationAllowed(managedOpenAi, compatibilityRuntime))
      .toThrow(ManagedProviderMutationError);
  });

  it('recognizes the current UClaw smart-latest relay even when data labels it custom', () => {
    const managedRelay = {
      id: 'legacy-relay',
      vendorId: 'custom',
      type: 'custom',
      baseUrl: 'https://ZZ-CN.LINGZHIWUXIAN.COM/v1/',
      modelId: 'smart-latest',
    };

    expect(isOpenAiProviderIdentity(managedRelay)).toBe(true);
    expect(() => assertProviderMutationAllowed(managedOpenAi, managedRelay))
      .toThrow(ManagedProviderMutationError);

    expect(isOpenAiProviderIdentity({
      ...managedRelay,
      modelId: 'custom-1234/smart-latest',
    })).toBe(true);
    expect(isOpenAiProviderIdentity({
      ...managedRelay,
      modelId: undefined,
      metadata: { customModels: ['smart-latest'] },
    })).toBe(true);
    expect(isOpenAiProviderIdentity({
      ...managedRelay,
      modelId: undefined,
      models: [{ id: 'smart-latest' }],
    })).toBe(true);
  });

  it('does not classify ordinary OpenAI-compatible custom Providers as OpenAI ownership', () => {
    const ordinaryCustom = {
      id: 'company-proxy',
      vendorId: 'custom',
      type: 'custom',
      baseUrl: 'https://llm.example.com/v1',
      model: 'smart-latest',
    };
    const sameHostDifferentModel = {
      id: 'other-model',
      vendorId: 'custom',
      type: 'custom',
      baseUrl: 'https://zz-cn.lingzhiwuxian.com/v1',
      model: 'other-model',
    };
    const codexCustom = {
      id: 'openai-codex',
      vendorId: 'custom',
      type: 'custom',
    };

    expect(isOpenAiProviderIdentity(ordinaryCustom)).toBe(false);
    expect(isOpenAiProviderIdentity(sameHostDifferentModel)).toBe(false);
    expect(isOpenAiProviderIdentity('openai-codex')).toBe(false);
    expect(isOpenAiProviderIdentity(codexCustom)).toBe(false);
    expect(isOpenAiProviderIdentity({
      ...sameHostDifferentModel,
      model: undefined,
      models: [{ id: 'other-model' }],
    })).toBe(false);
    expect(() => assertProviderMutationAllowed(managedOpenAi, ordinaryCustom)).not.toThrow();
    expect(() => assertProviderMutationAllowed(managedOpenAi, sameHostDifferentModel)).not.toThrow();
    expect(() => assertProviderMutationAllowed(managedOpenAi, codexCustom)).not.toThrow();
  });

  it.each([
    ['different protocol', 'http://zz-cn.lingzhiwuxian.com/v1'],
    ['temporary local debug endpoint', 'http://127.0.0.1:8083/v1'],
    ['unrelated local endpoint', 'https://127.0.0.1:8083/v1'],
    ['query parameters', 'https://zz-cn.lingzhiwuxian.com/v1?tenant=other'],
    ['URL credentials', 'https://user:password@zz-cn.lingzhiwuxian.com/v1'],
    ['URL fragment', 'https://zz-cn.lingzhiwuxian.com/v1#other'],
  ])('does not classify a smart-latest custom Provider with %s as managed', (_case, baseUrl) => {
    expect(isOpenAiProviderIdentity({
      id: 'custom-relay',
      vendorId: 'custom',
      type: 'custom',
      baseUrl,
      model: 'smart-latest',
    })).toBe(false);
  });
});
