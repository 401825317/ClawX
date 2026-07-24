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
  it('recognizes the UClaw smart-latest relay even when legacy data labels it custom', () => {
    const legacyRelay = {
      id: 'legacy-relay',
      vendorId: 'custom',
      type: 'custom',
      baseUrl: 'https://ZZ-CN.LINGZHIWUXIAN.COM/v1/',
      modelId: 'smart-latest',
    };

    expect(isOpenAiProviderIdentity(legacyRelay)).toBe(true);
    expect(() => assertProviderMutationAllowed(managedOpenAi, legacyRelay))
      .toThrow(ManagedProviderMutationError);

    expect(isOpenAiProviderIdentity({
      ...legacyRelay,
      modelId: 'custom-1234/smart-latest',
    })).toBe(true);
    expect(isOpenAiProviderIdentity({
      ...legacyRelay,
      modelId: undefined,
      metadata: { customModels: ['smart-latest'] },
    })).toBe(true);
    expect(isOpenAiProviderIdentity({
      ...legacyRelay,
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

    expect(isOpenAiProviderIdentity(ordinaryCustom)).toBe(false);
    expect(isOpenAiProviderIdentity(sameHostDifferentModel)).toBe(false);
    expect(isOpenAiProviderIdentity({
      ...sameHostDifferentModel,
      model: undefined,
      models: [{ id: 'other-model' }],
    })).toBe(false);
    expect(() => assertProviderMutationAllowed(managedOpenAi, ordinaryCustom)).not.toThrow();
    expect(() => assertProviderMutationAllowed(managedOpenAi, sameHostDifferentModel)).not.toThrow();
  });
});
