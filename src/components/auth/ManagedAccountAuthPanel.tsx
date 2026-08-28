import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Circle, Key, Loader2, Mail, RefreshCw, UserPlus, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ManagedAuthStatus } from '@shared/managed-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { hostApi } from '@/lib/host-api';
import {
  getManagedAuthErrorMessage,
  isManagedDeviceAuthorizationRequired,
} from '@/lib/managed-auth-errors';
import { isManagedActivationRequired, isManagedAuthReady } from '@/lib/managed-auth';
import { isManagedUsernameValid } from '@/lib/managed-username';
import { cn } from '@/lib/utils';
import { useManagedAuthStore } from '@/stores/managed-auth';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';

interface ManagedAccountAuthPanelProps {
  className?: string;
  successVisible?: boolean;
  allowRegister?: boolean;
  defaultMode?: 'login' | 'register';
  onReadyChange?: (ready: boolean, status: ManagedAuthStatus | null) => void;
  onAuthenticated?: (status: ManagedAuthStatus) => void;
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const SLOW_AUTH_THRESHOLD_SECONDS = 15;

type ManagedAuthOperation = 'auth' | 'logout' | null;

interface ManagedAuthProgressProps {
  elapsedSeconds: number;
  mode: 'login' | 'register';
  step: number;
}

function ManagedAuthProgress({ elapsedSeconds, mode, step }: ManagedAuthProgressProps) {
  const { t } = useTranslation('setup');
  const steps = [
    t('auth.progress.steps.account'),
    t('auth.progress.steps.gateway'),
    t('auth.progress.steps.finish'),
  ];
  const phaseKey = step === 0 ? 'account' : step === 1 ? 'gateway' : 'finish';

  return (
    <div
      data-testid="managed-auth-progress"
      role="status"
      aria-live="polite"
      className="border-y border-black/10 py-5 dark:border-white/10"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base font-semibold text-foreground">
            {t(`auth.progress.title.${mode}`)}
          </p>
          <p data-testid="managed-auth-progress-phase" className="mt-1 text-meta leading-5 text-muted-foreground">
            {t(`auth.progress.phase.${phaseKey}`)}
          </p>
        </div>
        <span aria-hidden="true" className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {t('auth.progress.elapsed', { seconds: elapsedSeconds })}
        </span>
      </div>

      <ol className="mt-5 space-y-3">
        {steps.map((label, index) => {
          const completed = index < step;
          const active = index === step;
          return (
            <li
              key={label}
              data-testid={`managed-auth-progress-step-${index}`}
              data-state={completed ? 'complete' : active ? 'active' : 'pending'}
              className={cn(
                'flex min-h-7 items-center gap-3 text-sm',
                completed || active ? 'text-foreground' : 'text-muted-foreground/60',
              )}
            >
              <span className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                completed && 'border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500',
                active && 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-400',
                !completed && !active && 'border-black/15 text-muted-foreground/50 dark:border-white/15',
              )}>
                {completed ? (
                  <Check className="h-3.5 w-3.5" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Circle className="h-2.5 w-2.5" />
                )}
              </span>
              <span className={cn(active && 'font-medium')}>{label}</span>
            </li>
          );
        })}
      </ol>

      {elapsedSeconds >= SLOW_AUTH_THRESHOLD_SECONDS && (
        <p data-testid="managed-auth-progress-slow-hint" className="mt-4 text-xs leading-5 text-muted-foreground">
          {t('auth.progress.slowHint')}
        </p>
      )}
    </div>
  );
}

export function ManagedAccountAuthPanel({
  className,
  successVisible = true,
  allowRegister = true,
  defaultMode = 'register',
  onReadyChange,
  onAuthenticated,
}: ManagedAccountAuthPanelProps) {
  const { t } = useTranslation('setup');
  const status = useManagedAuthStore((state) => state.status);
  const loading = useManagedAuthStore((state) => state.loading);
  const loadLocalStatus = useManagedAuthStore((state) => state.loadLocalStatus);
  const refreshStatus = useManagedAuthStore((state) => state.refreshStatus);
  const logoutManagedAuth = useManagedAuthStore((state) => state.logout);
  const setStatus = useManagedAuthStore((state) => state.setStatus);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const refreshProviderSnapshot = useProviderStore((state) => state.refreshProviderSnapshot);

  const [mode, setMode] = useState<'login' | 'register'>(defaultMode);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [activationValid, setActivationValid] = useState<boolean | null>(null);
  const [deviceNeedsActivation, setDeviceNeedsActivation] = useState(false);
  const [checkingActivation, setCheckingActivation] = useState(false);
  const [sendingVerifyCode, setSendingVerifyCode] = useState(false);
  const [verifyCodeCountdown, setVerifyCodeCountdown] = useState(0);
  const [operation, setOperation] = useState<ManagedAuthOperation>(null);
  const [authProgressStep, setAuthProgressStep] = useState(0);
  const [authElapsedSeconds, setAuthElapsedSeconds] = useState(0);
  const submitting = operation !== null;

  const authConfig = status?.bootstrap.auth ?? {};
  const canRegister = allowRegister && authConfig.registrationEnabled !== false;
  const canLogin = authConfig.loginEnabled !== false;
  const authReady = isManagedAuthReady(status);
  const showActivationCode = mode === 'register'
    && (deviceNeedsActivation || isManagedActivationRequired(status) || authConfig.activationRequired === true);
  const emailVerifyEnabled = mode === 'register' && authConfig.emailVerifyEnabled === true;

  const refreshAndReportStatus = useCallback(async (force = false) => {
    try {
      const next = await refreshStatus(force);
      onReadyChange?.(isManagedAuthReady(next), next);
      return next;
    } catch (error) {
      onReadyChange?.(false, null);
      toast.error(t('auth.toast.statusFailed', { message: getManagedAuthErrorMessage(t, error) }));
      return null;
    }
  }, [onReadyChange, refreshStatus, t]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      // Render local state first, then fetch the server-owned registration policy.
      if (!useManagedAuthStore.getState().initialized) await loadLocalStatus();
      if (!cancelled) await refreshAndReportStatus();
    };
    void initialize().catch((error) => {
      toast.error(t('auth.toast.statusFailed', { message: getManagedAuthErrorMessage(t, error) }));
    });
    return () => {
      cancelled = true;
    };
  }, [loadLocalStatus, refreshAndReportStatus, t]);

  useEffect(() => {
    onReadyChange?.(authReady, status);
    if (authReady && status) onAuthenticated?.(status);
  }, [authReady, onAuthenticated, onReadyChange, status]);

  useEffect(() => {
    if (!canRegister || status?.deviceActivated) {
      setMode('login');
      return;
    }
    setMode(defaultMode);
  }, [canRegister, defaultMode, status?.deviceActivated]);

  useEffect(() => {
    if (verifyCodeCountdown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setVerifyCodeCountdown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verifyCodeCountdown]);

  useEffect(() => {
    if (operation !== 'auth') return undefined;
    const startedAt = Date.now();
    const updateElapsed = () => {
      setAuthElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [operation]);

  useEffect(() => {
    if (operation !== 'auth') return;
    if (gatewayState === 'starting' || gatewayState === 'reconnecting') {
      setAuthProgressStep((current) => Math.max(current, 1));
    } else if (gatewayState === 'running') {
      setAuthProgressStep((current) => (current >= 1 ? 2 : current));
    }
  }, [gatewayState, operation]);

  const checkActivation = async () => {
    const code = activationCode.trim();
    if (!code) {
      toast.error(t('auth.toast.enterActivationCode'));
      return;
    }
    setCheckingActivation(true);
    setActivationValid(null);
    try {
      const result = await hostApi.managedAuth.checkActivation({ code });
      setActivationValid(result.valid);
      if (result.valid) {
        toast.success(t('auth.toast.activationVerified'));
      } else {
        toast.error(getManagedAuthErrorMessage(t, result.errorCode || 'activation_invalid'));
      }
    } catch (error) {
      toast.error(t('auth.toast.activationCheckFailed', { message: getManagedAuthErrorMessage(t, error) }));
    } finally {
      setCheckingActivation(false);
    }
  };

  const sendVerifyCode = async () => {
    const normalizedAccount = account.trim();
    if (!normalizedAccount) {
      toast.error(t('auth.toast.enterAccountFirst'));
      return;
    }
    setSendingVerifyCode(true);
    try {
      const result = await hostApi.managedAuth.sendVerificationCode({ account: normalizedAccount });
      if ('success' in result && result.success === false) {
        toast.error(t('auth.toast.sendVerifyCodeFailed', {
          message: getManagedAuthErrorMessage(t, result.errorCode || 'UNKNOWN'),
        }));
        return;
      }
      setVerifyCodeCountdown(
        typeof result.countdown === 'number' && result.countdown > 0 ? result.countdown : 60,
      );
      toast.success(t('auth.toast.verifyCodeSent'));
    } catch (error) {
      toast.error(t('auth.toast.sendVerifyCodeFailed', { message: getManagedAuthErrorMessage(t, error) }));
    } finally {
      setSendingVerifyCode(false);
    }
  };

  const submitAuth = async () => {
    const normalizedAccount = account.trim();
    if (!normalizedAccount || !password) {
      toast.error(t('auth.toast.enterAccountPassword'));
      return;
    }
    if (mode === 'register' && !isManagedUsernameValid(normalizedAccount)) {
      toast.error(t('auth.errors.invalid_username'));
      return;
    }
    if (
      mode === 'register'
      && (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)
    ) {
      toast.error(t('auth.errors.password_policy'));
      return;
    }
    if (showActivationCode && !activationCode.trim()) {
      toast.error(t('auth.toast.enterActivationCode'));
      return;
    }
    if (emailVerifyEnabled && !verifyCode.trim()) {
      toast.error(t('auth.toast.enterVerifyCode'));
      return;
    }

    setAuthElapsedSeconds(0);
    setAuthProgressStep(0);
    setOperation('auth');
    try {
      const common = {
        account: normalizedAccount,
        password,
        activationCode: showActivationCode ? activationCode.trim() : undefined,
        verifyCode: emailVerifyEnabled ? verifyCode.trim() : undefined,
      };
      const result = mode === 'register'
        ? await hostApi.managedAuth.register({ ...common, username: normalizedAccount })
        : await hostApi.managedAuth.login(common);

      if (!result.success) {
        const authError = result.errorCode || 'UNKNOWN';
        if (isManagedDeviceAuthorizationRequired(authError)) {
          setDeviceNeedsActivation(true);
        }
        toast.error(t(`auth.toast.${mode}Failed`, { message: getManagedAuthErrorMessage(t, authError) }));
        return;
      }

      setAuthProgressStep(2);
      const next = result.status ?? await refreshStatus(true);
      setStatus(next);
      await refreshProviderSnapshot();
      setPassword('');
      toast.success(mode === 'register' ? t('auth.toast.activated') : t('auth.toast.loggedIn'));
    } catch (error) {
      if (isManagedDeviceAuthorizationRequired(error)) {
        setDeviceNeedsActivation(true);
      }
      toast.error(t(`auth.toast.${mode}Failed`, { message: getManagedAuthErrorMessage(t, error) }));
    } finally {
      setOperation(null);
    }
  };

  const logout = async () => {
    setOperation('logout');
    try {
      await logoutManagedAuth();
      await refreshProviderSnapshot();
      setPassword('');
      setActivationCode('');
      setVerifyCode('');
      setActivationValid(null);
      setDeviceNeedsActivation(false);
      toast.success(t('auth.toast.loggedOut'));
    } catch (error) {
      toast.error(t('auth.toast.logoutFailed', { message: getManagedAuthErrorMessage(t, error) }));
    } finally {
      setOperation(null);
    }
  };

  return (
    <div data-testid="managed-account-auth-panel" className={cn('space-y-5', className)}>
      {loading && !status ? (
        <div className="flex items-center gap-2 rounded-lg bg-surface-input/50 p-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('auth.status.checking')}
        </div>
      ) : operation === 'auth' ? (
        <ManagedAuthProgress
          elapsedSeconds={authElapsedSeconds}
          mode={mode}
          step={authProgressStep}
        />
      ) : authReady && successVisible ? (
        <div className="flex items-center gap-2 rounded-lg bg-green-500/10 p-4 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-5 w-5" />
          {t('auth.status.activatedForDevice')}
        </div>
      ) : (
        <div className="space-y-4">
          {allowRegister && canRegister && (
            <div className="flex w-full rounded-lg bg-black/5 p-1 text-meta dark:bg-white/5">
              <button
                data-testid="managed-auth-mode-login"
                type="button"
                onClick={() => setMode('login')}
                disabled={!canLogin}
                className={cn(
                  'flex-1 rounded-md px-3 py-2 font-medium transition-colors disabled:opacity-50',
                  mode === 'login' ? 'bg-surface-modal text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t('auth.actions.login')}
              </button>
              <button
                data-testid="managed-auth-mode-register"
                type="button"
                onClick={() => setMode('register')}
                className={cn(
                  'flex-1 rounded-md px-3 py-2 font-medium transition-colors',
                  mode === 'register' ? 'bg-surface-modal text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t('auth.actions.register')}
              </button>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="managed-auth-account">{t('auth.fields.account')}</Label>
              <Input
                id="managed-auth-account"
                data-testid="managed-auth-account-input"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                placeholder={t('auth.placeholders.account')}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="managed-auth-password">{t('auth.fields.password')}</Label>
              <Input
                id="managed-auth-password"
                data-testid="managed-auth-password-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('auth.placeholders.password')}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
            </div>
          </div>

          {showActivationCode && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="managed-auth-activation">{t('auth.fields.activationCode')}</Label>
                <Input
                  id="managed-auth-activation"
                  data-testid="managed-auth-activation-input"
                  value={activationCode}
                  onChange={(event) => {
                    setActivationCode(event.target.value);
                    setActivationValid(null);
                  }}
                  placeholder={t('auth.placeholders.activationCode')}
                />
                {activationValid !== null && (
                  <p className={cn('text-xs font-medium', activationValid ? 'text-green-600' : 'text-red-600')}>
                    {activationValid ? t('auth.status.activationVerified') : t('auth.status.activationInvalid')}
                  </p>
                )}
              </div>
              <Button
                data-testid="managed-auth-check-activation"
                variant="outline"
                onClick={() => void checkActivation()}
                disabled={checkingActivation || !activationCode.trim()}
              >
                {checkingActivation
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Check className="h-4 w-4" />}
                {t('auth.actions.check')}
              </Button>
            </div>
          )}

          {emailVerifyEnabled && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="managed-auth-verify">{t('auth.fields.verifyCode')}</Label>
                <Input
                  id="managed-auth-verify"
                  data-testid="managed-auth-verify-input"
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                  placeholder={t('auth.placeholders.verifyCode')}
                  inputMode="numeric"
                />
              </div>
              <Button
                data-testid="managed-auth-send-code"
                variant="outline"
                onClick={() => void sendVerifyCode()}
                disabled={sendingVerifyCode || verifyCodeCountdown > 0 || !account.trim()}
              >
                {sendingVerifyCode
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Mail className="h-4 w-4" />}
                {verifyCodeCountdown > 0
                  ? t('auth.actions.sendCodeCountdown', { seconds: verifyCodeCountdown })
                  : t('auth.actions.sendCode')}
              </Button>
            </div>
          )}

          <div className="flex flex-col justify-between gap-3 sm:flex-row">
            <Button
              variant="ghost"
              onClick={() => void refreshAndReportStatus(true)}
              disabled={loading || submitting}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {t('auth.actions.refresh')}
            </Button>
            <div className="flex flex-col justify-end gap-3 sm:flex-row">
              {(status?.hasAuthToken || status?.hasRefreshToken || status?.hasRelayToken) && (
                <Button
                  data-testid="managed-auth-logout"
                  variant="outline"
                  onClick={() => void logout()}
                  disabled={submitting}
                >
                  <XCircle className="h-4 w-4" />
                  {t('auth.actions.logout')}
                </Button>
              )}
              <Button
                data-testid="managed-auth-submit"
                onClick={() => void submitAuth()}
                disabled={submitting || (mode === 'register' ? !canRegister : !canLogin)}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : mode === 'register' ? (
                  <UserPlus className="h-4 w-4" />
                ) : (
                  <Key className="h-4 w-4" />
                )}
                {mode === 'register' ? t('auth.actions.registerAndActivate') : t('auth.actions.login')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
