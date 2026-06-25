import { describe, expect, it } from 'vitest';
import {
  buildConfiguredModelOptions,
  formatModelDisplayLabel,
  formatModelRefLabel,
  resolveRuntimeProviderKey,
} from '../../src/lib/model-options';
import type { ProviderAccount, ProviderWithKeyInfo } from '../../src/lib/providers';

const now = '2026-04-28T00:00:00.000Z';

function account(overrides: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: 'custom-alpha1234',
    vendorId: 'custom',
    label: 'Alpha',
    authMode: 'api_key',
    model: 'model-alpha',
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProviderAccount;
}

function status(id: string, hasKey = true): ProviderWithKeyInfo {
  return {
    id,
    type: 'custom',
    name: id,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    hasKey,
    keyMasked: hasKey ? 'sk-***' : null,
  } as ProviderWithKeyInfo;
}

describe('model option helpers', () => {
  it('formats model refs using only the text after the provider prefix', () => {
    expect(formatModelRefLabel('openrouter/openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(formatModelRefLabel('custom-alpha1234/model-alpha')).toBe('model-alpha');
  });

  it('formats Lingzhi Wuxian smart routing as a user-facing model label', () => {
    expect(formatModelDisplayLabel('lingzhiwuxian/smart-latest')).toBe('智能路由');
    expect(formatModelDisplayLabel('lingzhiwuxian/qwen-latest')).toBe('通义千问最新版');
    expect(formatModelDisplayLabel('custom-alpha1234/model-alpha')).toBe('model-alpha');
  });

  it('builds one configured custom model option per account', () => {
    const options = buildConfiguredModelOptions(
      [
        account({ id: 'alpha1234', model: 'model-alpha', updatedAt: '2026-04-03T00:00:00.000Z' }),
        account({ id: 'beta5678', label: 'Beta', model: 'provider/model-beta', updatedAt: '2026-04-02T00:00:00.000Z' }),
      ],
      [status('alpha1234'), status('beta5678')],
      'alpha1234',
    );

    expect(options).toEqual([
      {
        modelRef: 'custom-alpha123/model-alpha',
        label: 'model-alpha',
        runtimeProviderKey: 'custom-alpha123',
        accountId: 'alpha1234',
      },
      {
        modelRef: 'custom-beta5678/provider/model-beta',
        label: 'provider/model-beta',
        runtimeProviderKey: 'custom-beta5678',
        accountId: 'beta5678',
      },
    ]);
  });

  it('labels configured Lingzhi Wuxian models with product names', () => {
    const options = buildConfiguredModelOptions(
      [
        account({
          id: 'lingzhiwuxian',
          vendorId: 'lingzhiwuxian',
          label: '零至无限',
          model: 'smart-latest',
        }),
      ],
      [{ ...status('lingzhiwuxian'), type: 'lingzhiwuxian', name: '零至无限' }],
      'lingzhiwuxian',
    );

    expect(options).toEqual([
      {
        modelRef: 'lingzhiwuxian/smart-latest',
        label: '智能路由',
        runtimeProviderKey: 'lingzhiwuxian',
        accountId: 'lingzhiwuxian',
      },
    ]);
  });

  it('keeps prefixed account models intact and skips accounts without credentials', () => {
    const runtimeKey = resolveRuntimeProviderKey(account({ id: 'gamma9012' }));
    const options = buildConfiguredModelOptions(
      [
        account({ id: 'gamma9012', model: `${runtimeKey}/model-gamma` }),
        account({ id: 'delta3456', label: 'Delta', model: 'model-delta' }),
      ],
      [status('gamma9012'), status('delta3456', false)],
      null,
    );

    expect(options).toHaveLength(1);
    expect(options[0].modelRef).toBe('custom-gamma901/model-gamma');
    expect(options[0].label).toBe('model-gamma');
  });

  it('treats malformed provider snapshots as empty options', () => {
    expect(
      buildConfiguredModelOptions(
        {} as ProviderAccount[],
        {} as ProviderWithKeyInfo[],
        null,
      ),
    ).toEqual([]);
  });
});
