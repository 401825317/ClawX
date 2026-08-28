import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import type { ManagedAuthStatus } from '@shared/managed-auth';
import '@/i18n';
import { ManagedAccountAuthPanel } from '@/components/auth/ManagedAccountAuthPanel';
import { ManagedAuthGate } from '@/components/auth/ManagedAuthGate';
import { TooltipProvider } from '@/components/ui/tooltip';
import { hostApi } from '@/lib/host-api';
import { Settings } from '@/pages/Settings';
import { Setup } from '@/pages/Setup';
import { useGatewayStore } from '@/stores/gateway';
import { useManagedAuthStore } from '@/stores/managed-auth';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function status(overrides: Partial<ManagedAuthStatus> = {}): ManagedAuthStatus {
  return {
    managed: true,
    hasAuthToken: false,
    hasRefreshToken: false,
    hasRelayToken: false,
    authValid: false,
    deviceActivated: false,
    activationRequired: false,
    bootstrap: {},
    ...overrides,
  };
}

function renderGate(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <ManagedAuthGate enabled />
    </MemoryRouter>,
  );
}

function renderSetup(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <MemoryRouter initialEntries={['/setup']}>
        <Setup />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe('ManagedAuthGate', () => {
  beforeEach(() => {
    useManagedAuthStore.setState({
      status: null,
      loading: false,
      verifying: false,
      initialized: true,
      error: null,
    });
    vi.spyOn(hostApi.managedAuth, 'status').mockImplementation(async () => (
      useManagedAuthStore.getState().status ?? status()
    ));
    useGatewayStore.setState((state) => ({
      status: { ...state.status, state: 'stopped', gatewayReady: false },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies managed auth once without periodic polling', async () => {
    vi.useFakeTimers();
    useManagedAuthStore.setState({ status: status({ authValid: true, hasRelayToken: true }) });

    renderGate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hostApi.managedAuth.status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(hostApi.managedAuth.status).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for unmanaged builds', () => {
    useManagedAuthStore.setState({ status: status({ managed: false }) });
    renderGate();
    expect(screen.queryByTestId('managed-auth-gate')).not.toBeInTheDocument();
    expect(screen.queryByText('UClaw')).not.toBeInTheDocument();
  });

  it('shows a fixed UClaw brand with login as the default and registration available', () => {
    useManagedAuthStore.setState({
      status: status({ bootstrap: { service: { displayName: 'backend-display-name' } } }),
    });
    renderGate();

    expect(screen.getByTestId('managed-auth-gate')).toBeInTheDocument();
    expect(screen.getByText('UClaw')).toBeInTheDocument();
    expect(screen.queryByText('backend-display-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('managed-account-auth-panel')).toBeInTheDocument();
    expect(screen.getByTestId('managed-auth-mode-register')).toBeInTheDocument();
    expect(screen.getByTestId('managed-auth-account-input')).toBeInTheDocument();
    expect(screen.getByTestId('managed-auth-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('managed-auth-submit')).toBeInTheDocument();
  });

  it('shows activation only after switching from login to a registration that requires it', async () => {
    useManagedAuthStore.setState({
      status: status({
        activationRequired: true,
        bootstrap: { auth: { registrationEnabled: true, activationRequired: true } },
      }),
    });
    renderGate();

    await waitFor(() => expect(hostApi.managedAuth.status).toHaveBeenCalled());
    expect(screen.queryByTestId('managed-auth-activation-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('managed-auth-mode-register'));
    expect(screen.getByTestId('managed-auth-activation-input')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('managed-auth-mode-login'));
    await waitFor(() => {
      expect(screen.queryByTestId('managed-auth-activation-input')).not.toBeInTheDocument();
    });
  });

  it('skips the gate on the setup route', () => {
    useManagedAuthStore.setState({ status: status() });
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <ManagedAuthGate enabled />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('managed-auth-gate')).not.toBeInTheDocument();
  });
});

describe('managed auth page integration', () => {
  beforeEach(() => {
    useManagedAuthStore.setState({
      status: null,
      loading: false,
      verifying: false,
      initialized: true,
      error: null,
    });
    vi.spyOn(hostApi.managedAuth, 'status').mockImplementation(async () => (
      useManagedAuthStore.getState().status ?? status()
    ));
    useGatewayStore.setState((state) => ({
      status: { ...state.status, state: 'stopped', gatewayReady: false },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the auth step from unmanaged setup', async () => {
    useManagedAuthStore.setState({ status: status({ managed: false }) });
    renderSetup();

    fireEvent.click(screen.getByTestId('setup-next-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('managed-account-auth-panel')).not.toBeInTheDocument();
      expect(screen.getByText('Environment Check')).toBeInTheDocument();
    });
  });

  it('opens managed setup in login mode and shows activation only after switching to registration', async () => {
    useManagedAuthStore.setState({
      status: status({
        activationRequired: true,
        bootstrap: { auth: { registrationEnabled: true, activationRequired: true } },
      }),
    });
    renderSetup();

    fireEvent.click(screen.getByTestId('setup-next-button'));
    await waitFor(() => {
      expect(screen.getByTestId('managed-account-auth-panel')).toBeInTheDocument();
      expect(screen.getByTestId('managed-auth-mode-login')).toBeInTheDocument();
      expect(screen.getByTestId('managed-auth-mode-register')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('managed-auth-activation-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('managed-auth-mode-register'));
    expect(screen.getByTestId('managed-auth-activation-input')).toBeInTheDocument();
  });

  it('loads the remote activation policy when the registration panel opens', async () => {
    useManagedAuthStore.setState({ status: status() });
    vi.spyOn(hostApi.managedAuth, 'status').mockResolvedValue(status({
      activationRequired: true,
      bootstrap: { auth: { activationRequired: true } },
    }));

    render(<ManagedAccountAuthPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('managed-auth-activation-input')).toBeInTheDocument();
    });
  });

  it('keeps the activation code optional when the remote policy disables it', async () => {
    useManagedAuthStore.setState({ status: status() });
    vi.spyOn(hostApi.managedAuth, 'status').mockResolvedValue(status({
      bootstrap: { auth: { activationRequired: false } },
    }));

    render(<ManagedAccountAuthPanel />);

    await waitFor(() => {
      expect(hostApi.managedAuth.status).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('managed-auth-activation-input')).not.toBeInTheDocument();
  });

  it('shows elapsed, Gateway-aware progress while login is pending', async () => {
    vi.useFakeTimers();
    useManagedAuthStore.setState({ status: status() });
    type LoginResult = Awaited<ReturnType<typeof hostApi.managedAuth.login>>;
    let finishLogin: ((result: LoginResult) => void) | undefined;
    vi.spyOn(hostApi.managedAuth, 'login').mockImplementation(() => new Promise((resolve) => {
      finishLogin = resolve;
    }));

    render(<ManagedAccountAuthPanel defaultMode="login" />);
    fireEvent.change(screen.getByTestId('managed-auth-account-input'), {
      target: { value: 'user_01' },
    });
    fireEvent.change(screen.getByTestId('managed-auth-password-input'), {
      target: { value: 'Password1' },
    });
    fireEvent.click(screen.getByTestId('managed-auth-submit'));

    expect(screen.getByTestId('managed-auth-progress')).toBeInTheDocument();
    expect(screen.getByTestId('managed-auth-progress-step-0')).toHaveAttribute('data-state', 'active');
    expect(screen.queryByTestId('managed-auth-account-input')).not.toBeInTheDocument();

    act(() => {
      useGatewayStore.setState((state) => ({
        status: { ...state.status, state: 'starting', gatewayReady: false },
      }));
    });
    expect(screen.getByTestId('managed-auth-progress-step-0')).toHaveAttribute('data-state', 'complete');
    expect(screen.getByTestId('managed-auth-progress-step-1')).toHaveAttribute('data-state', 'active');

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByText('15s elapsed')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('managed-auth-progress-slow-hint')).toBeInTheDocument();

    act(() => {
      useGatewayStore.setState((state) => ({
        status: { ...state.status, state: 'running', gatewayReady: true },
      }));
    });
    expect(screen.getByTestId('managed-auth-progress-step-1')).toHaveAttribute('data-state', 'complete');
    expect(screen.getByTestId('managed-auth-progress-step-2')).toHaveAttribute('data-state', 'active');

    await act(async () => {
      finishLogin?.({ success: false, errorCode: 'NETWORK' });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('managed-auth-progress')).not.toBeInTheDocument();
  });

  it('does not show the UClaw account section before managed status is confirmed', () => {
    const { rerender } = render(<Settings />);
    expect(screen.queryByTestId('settings-managed-auth-section')).not.toBeInTheDocument();

    useManagedAuthStore.setState({ status: status({ managed: false }) });
    rerender(<Settings />);
    expect(screen.queryByTestId('settings-managed-auth-section')).not.toBeInTheDocument();
  });

  it('shows the UClaw account section only for managed status', () => {
    useManagedAuthStore.setState({ status: status({ managed: true }) });
    render(<Settings />);
    expect(screen.getByTestId('settings-managed-auth-section')).toBeInTheDocument();
    expect(screen.getAllByText('UClaw').length).toBeGreaterThan(0);
  });

  it('maps a rejected verification-code request instead of reporting success', async () => {
    useManagedAuthStore.setState({
      status: status({ bootstrap: { auth: { emailVerifyEnabled: true } } }),
    });
    vi.spyOn(hostApi.managedAuth, 'sendVerificationCode').mockResolvedValue({
      success: false,
      errorCode: 'RATE_LIMIT',
    });
    render(<ManagedAccountAuthPanel />);

    fireEvent.change(screen.getByTestId('managed-auth-account-input'), {
      target: { value: 'user_01' },
    });
    fireEvent.click(screen.getByTestId('managed-auth-send-code'));

    await waitFor(() => {
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Too many requests'));
    });
  });
});
