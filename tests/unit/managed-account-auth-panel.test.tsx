import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { ManagedAccountAuthPanel } from '@/components/auth/ManagedAccountAuthPanel';
import { hostApiFetch } from '@/lib/host-api';

const managedAuthState = vi.hoisted(() => ({
  status: {
    managed: true,
    hasRelayToken: false,
    hasAuthToken: false,
    authValid: false,
    deviceActivated: false,
    activationRequired: false,
    bootstrap: {
      auth: {
        registrationEnabled: true,
        loginEnabled: true,
        activationRequired: false,
      },
    },
  },
  loading: false,
  refreshStatus: vi.fn(),
  logout: vi.fn(),
}));

const providerState = vi.hoisted(() => ({
  refreshProviderSnapshot: vi.fn(),
}));

const gatewayState = vi.hoisted(() => ({
  status: { state: 'stopped' },
  start: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/stores/managed-auth', () => ({
  useManagedAuthStore: (selector: (state: typeof managedAuthState) => unknown) => selector(managedAuthState),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'auth.errors.invalid_username') {
        return '用户名格式不正确，请使用字母、数字、下划线或短横线。';
      }
      if (key === 'auth.errors.password_policy') {
        return '密码长度需为 8-20 位。';
      }
      return String(options?.defaultValue ?? key);
    },
  }),
}));

describe('ManagedAccountAuthPanel username validation', () => {
  beforeEach(() => {
    vi.mocked(hostApiFetch).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
    managedAuthState.refreshStatus.mockReset();
    managedAuthState.refreshStatus.mockResolvedValue(managedAuthState.status);
    managedAuthState.logout.mockReset();
    providerState.refreshProviderSnapshot.mockReset();
    gatewayState.start.mockReset();
  });

  it('rejects Chinese characters before calling the register API', () => {
    render(<ManagedAccountAuthPanel defaultMode="register" />);

    fireEvent.change(screen.getByPlaceholderText('auth.placeholders.email'), {
      target: { value: '测试abc123' },
    });
    fireEvent.change(screen.getByPlaceholderText('auth.placeholders.password'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.actions\.registerAndActivate/ }));

    expect(toast.error).toHaveBeenCalledWith('用户名格式不正确，请使用字母、数字、下划线或短横线。');
    expect(hostApiFetch).not.toHaveBeenCalledWith(
      '/api/junfeiai/register',
      expect.anything(),
    );
  });

  it('rejects short passwords before calling the register API', () => {
    render(<ManagedAccountAuthPanel defaultMode="register" />);

    fireEvent.change(screen.getByPlaceholderText('auth.placeholders.email'), {
      target: { value: 'testuser' },
    });
    fireEvent.change(screen.getByPlaceholderText('auth.placeholders.password'), {
      target: { value: '1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.actions\.registerAndActivate/ }));

    expect(toast.error).toHaveBeenCalledWith('密码长度需为 8-20 位。');
    expect(hostApiFetch).not.toHaveBeenCalledWith(
      '/api/junfeiai/register',
      expect.anything(),
    );
  });
});
