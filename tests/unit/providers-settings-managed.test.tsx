import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';

const mocks = vi.hoisted(() => ({
  refreshProviderSnapshot: vi.fn(),
  createAccount: vi.fn(),
  removeAccount: vi.fn(),
  updateAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
  validateAccountApiKey: vi.fn(),
}));

const providerState = vi.hoisted(() => ({
  statuses: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  vendors: [] as Array<Record<string, unknown>>,
  defaultAccountId: 'custom-local' as string | null,
  loading: false,
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: () => ({
    ...providerState,
    ...mocks,
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: { devModeUnlocked: boolean }) => unknown) => (
    selector({ devModeUnlocked: false })
  ),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    providers: {
      requestOAuth: vi.fn(),
      cancelOAuth: vi.fn(),
      submitOAuth: vi.fn(),
    },
  },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onOAuthCode: vi.fn(() => vi.fn()),
    onOAuthSuccess: vi.fn(() => vi.fn()),
    onOAuthError: vi.fn(() => vi.fn()),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ProvidersSettings managed account protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshProviderSnapshot.mockResolvedValue(undefined);
    providerState.accounts = [
      {
        id: 'openai',
        vendorId: 'openai',
        label: 'UClaw',
        authMode: 'api_key',
        model: 'smart-latest',
        enabled: true,
        isDefault: false,
        metadata: { managedBy: 'uclaw' },
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
      {
        id: 'custom-local',
        vendorId: 'custom',
        label: 'Local',
        authMode: 'api_key',
        enabled: true,
        isDefault: true,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
    ];
    providerState.statuses = [
      { id: 'openai', type: 'openai', hasKey: true },
      { id: 'custom-local', type: 'custom', hasKey: true },
    ];
    providerState.vendors = [
      { id: 'openai', name: 'OpenAI', icon: '' },
      { id: 'custom', name: 'Custom', icon: '' },
    ];
    providerState.defaultAccountId = 'custom-local';
  });

  it('hides edit and delete controls for UClaw-managed accounts only', () => {
    render(<ProvidersSettings />);

    expect(screen.queryByTestId('provider-edit-openai')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-delete-openai')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-set-default-openai')).toBeInTheDocument();
    expect(screen.getByTestId('provider-edit-custom-local')).toBeInTheDocument();
    expect(screen.getByTestId('provider-delete-custom-local')).toBeInTheDocument();
  });

  it('hides the add-provider flow when the backend exposes managed mode', () => {
    providerState.accounts = [providerState.accounts[0]];
    providerState.statuses = [providerState.statuses[0]];
    providerState.vendors = [{ id: 'openai', name: 'UClaw', icon: '' }];
    providerState.defaultAccountId = 'openai';

    render(<ProvidersSettings />);

    expect(screen.queryByTestId('providers-add-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-edit-openai')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-delete-openai')).not.toBeInTheDocument();
  });
});
