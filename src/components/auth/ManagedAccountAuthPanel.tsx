import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Key, Loader2, Mail, RefreshCw, UserPlus, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { hostApiFetch } from '@/lib/host-api';
import {
  getManagedAuthErrorMessage,
  isManagedDeviceAuthorizationRequired,
} from '@/lib/managed-auth-errors';
import {
  isManagedActivationRequired,
  isManagedAuthReady,
  type ManagedAuthStatus,
} from '@/lib/managed-auth';
import { isManagedUsernameValid } from '@/lib/managed-username';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useManagedAuthStore } from '@/stores/managed-auth';
import { useProviderStore } from '@/stores/providers';

interface ManagedAccountAuthPanelProps {
  className?: string;
  successVisible?: boolean;
  allowRegister?: boolean;
  defaultMode?: 'login' | 'register';
  onReadyChange?: (ready: boolean, status: ManagedAuthStatus | null) => void;
  onAuthenticated?: (status: ManagedAuthStatus) => void;
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
  const refreshStatus = useManagedAuthStore((state) => state.refreshStatus);
  const logoutManagedAuth = useManagedAuthStore((state) => state.logout);
  const refreshProviderSnapshot = useProviderStore((state) => state.refreshProviderSnapshot);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const startGateway = useGatewayStore((state) => state.start);
  const [mode, setMode] = useState<'login' | 'register'>(defaultMode);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [activationTicket, setActivationTicket] = useState('');
  const [activationValid, setActivationValid] = useState<boolean | null>(null);
  const [loginDeviceAuthorizationRequired, setLoginDeviceAuthorizationRequired] = useState(false);
  const [checkingActivation, setCheckingActivation] = useState(false);
  const [sendingVerifyCode, setSendingVerifyCode] = useState(false);
  const [verifyCodeCountdown, setVerifyCodeCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const hasRelayToken = Boolean(status?.hasRelayToken);
  const hasAuthToken = Boolean(status?.hasAuthToken);
  const auth = status?.bootstrap?.auth ?? {};
  const requiresActivation = isManagedActivationRequired(status);
  const authReady = isManagedAuthReady(status);
  const emailVerifyEnabled = Boolean(auth.emailVerifyEnabled);
  const canRegister = allowRegister && auth.registrationEnabled !== false;
  const canLogin = auth.loginEnabled !== false;
  const activationRequiredForRegister = mode === 'register' && (requiresActivation || auth.activationRequired === true);
  const activationRequiredForLogin = mode === 'login' && (
    loginDeviceAuthorizationRequired
    || (hasAuthToken && requiresActivation)
  );
  const showActivationCode = activationRequiredForRegister || activationRequiredForLogin;

  const refreshAndReportStatus = useCallback(async () => {
    try {
      const next = await refreshStatus();
      onReadyChange?.(isManagedAuthReady(next), next);
      return next;
    } catch (error) {
      onReadyChange?.(false, null);
      toast.error(t('auth.toast.statusFailed', { message: getManagedAuthErrorMessage(t, error) }));
      return null;
    }
  }, [onReadyChange, refreshStatus, t]);

  useEffect(() => {
    void refreshAndReportStatus();
  }, [refreshAndReportStatus]);

  useEffect(() => {
    onReadyChange?.(authReady, status);
    if (authReady && status) {
      onAuthenticated?.(status);
    }
  }, [authReady, onAuthenticated, onReadyChange, status]);

  useEffect(() => {
    if (status?.deviceActivated || !canRegister) {
      setMode('login');
    } else if (requiresActivation || defaultMode === 'register') {
      setMode('register');
    } else {
      setMode('login');
    }
  }, [canRegister, defaultMode, requiresActivation, status?.deviceActivated]);

  useEffect(() => {
    if (verifyCodeCountdown <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setVerifyCodeCountdown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verifyCodeCountdown]);

  const checkActivation = async () => {
    const code = activationCode.trim();
    if (!code) {
      toast.error(t('auth.toast.enterActivationCode'));
      return;
    }
    setCheckingActivation(true);
    setActivationValid(null);
    try {
      const result = await hostApiFetch<{ valid?: boolean; activationTicket?: string; errorCode?: string }>(
        '/api/junfeiai/activation/check',
        {
          method: 'POST',
          body: JSON.stringify({ code }),
        },
      );
      setActivationValid(Boolean(result.valid));
      setActivationTicket(result.activationTicket || '');
      if (result.valid) {
        toast.success(t('auth.toast.activationVerified'));
      } else {
        const message = result.errorCode
          ? t(`auth.errors.${result.errorCode}`, { defaultValue: t('auth.toast.activationInvalid') })
          : t('auth.toast.activationInvalid');
        toast.error(message);
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
      const result = await hostApiFetch<{ message?: string; countdown?: number }>('/api/junfeiai/verification/send-code', {
        method: 'POST',
        body: JSON.stringify({
          account: normalizedAccount,
        }),
      });
      setVerifyCodeCountdown(typeof result.countdown === 'number' && result.countdown > 0 ? result.countdown : 60);
      toast.success(result.message || t('auth.toast.verifyCodeSent'));
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
    if (showActivationCode && !activationTicket && !activationCode.trim()) {
      toast.error(t('auth.toast.enterActivationCode'));
      return;
    }

    setSubmitting(true);
    try {
      await hostApiFetch(mode === 'register' ? '/api/junfeiai/register' : '/api/junfeiai/login', {
        method: 'POST',
        body: JSON.stringify({
          account: normalizedAccount,
          username: normalizedAccount,
          password,
          activationCode: activationCode.trim() || undefined,
          activationTicket: activationTicket || activationCode.trim() || undefined,
          verifyCode: emailVerifyEnabled ? (verifyCode.trim() || undefined) : undefined,
        }),
      });
      toast.success(mode === 'register' ? t('auth.toast.activated') : t('auth.toast.loggedIn'));
      setPassword('');
      setLoginDeviceAuthorizationRequired(false);
      const next = await refreshAndReportStatus();
      await refreshProviderSnapshot();
      if (next && isManagedAuthReady(next)) {
        if (gatewayStatus.state === 'stopped' || gatewayStatus.state === 'error') {
          await startGateway();
        }
        onAuthenticated?.(next);
      }
    } catch (error) {
      if (mode === 'login' && isManagedDeviceAuthorizationRequired(error)) {
        setLoginDeviceAuthorizationRequired(true);
        setActivationTicket('');
        setActivationValid(null);
        toast.error(t('auth.errors.device_authorization_required'));
      } else {
        toast.error(t(`auth.toast.${mode}Failed`, { message: getManagedAuthErrorMessage(t, error) }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    setSubmitting(true);
    try {
      await logoutManagedAuth();
      await refreshProviderSnapshot();
      toast.success(t('auth.toast.loggedOut'));
      setPassword('');
      setActivationCode('');
      setVerifyCode('');
      setActivationTicket('');
      setActivationValid(null);
      setLoginDeviceAuthorizationRequired(false);
    } catch (error) {
      toast.error(t('auth.toast.logoutFailed', { message: getManagedAuthErrorMessage(t, error) }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="managed-account-auth-panel" className={cn('space-y-5', className)}>
      {loading && !status ? (
        <div className="flex items-center gap-2 rounded-xl bg-surface-input/50 p-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('auth.status.checking')}
        </div>
      ) : authReady && successVisible ? (
        <div className="flex items-center gap-2 rounded-xl bg-green-500/10 p-4 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-5 w-5" />
          {t('auth.status.activatedForDevice')}
        </div>
      ) : (
        <div className="space-y-4">
          {(canRegister || allowRegister) ? (
            <div className="flex w-full rounded-xl bg-black/5 dark:bg-white/5 p-1 text-meta">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setLoginDeviceAuthorizationRequired(false);
              }}
              disabled={!canLogin}
              className={cn(
                'flex-1 rounded-lg px-3 py-2 font-medium transition-colors disabled:opacity-50',
                mode === 'login' ? 'bg-surface-modal text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {t('auth.actions.login')}
            </button>
            {canRegister && (
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setLoginDeviceAuthorizationRequired(false);
                }}
                disabled={!canRegister}
                className={cn(
                  'flex-1 rounded-lg px-3 py-2 font-medium transition-colors disabled:opacity-50',
                  mode === 'register' ? 'bg-surface-modal text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t('auth.actions.register')}
              </button>
            )}
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground/80 font-bold">{t('auth.fields.email')}</Label>
              <Input
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                placeholder={t('auth.placeholders.email')}
                className="h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground/80 font-bold">{t('auth.fields.password')}</Label>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('auth.placeholders.password')}
                className="h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40"
              />
            </div>
          </div>

          {showActivationCode && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground/80 font-bold">{t('auth.fields.activationCode')}</Label>
                <Input
                  value={activationCode}
                  onChange={(event) => {
                    setActivationCode(event.target.value);
                    setActivationTicket('');
                    setActivationValid(null);
                  }}
                  placeholder={showActivationCode ? t('auth.placeholders.required') : t('auth.placeholders.optional')}
                  className="h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40"
                />
                {activationValid !== null && (
                  <p className={cn('text-xs font-medium', activationValid ? 'text-green-600' : 'text-red-500')}>
                    {activationValid ? t('auth.status.activationVerified') : t('auth.status.activationInvalid')}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                className="h-[44px] rounded-full px-5 text-meta"
                onClick={() => void checkActivation()}
                disabled={checkingActivation || !activationCode.trim()}
              >
                {checkingActivation ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                {t('auth.actions.check')}
              </Button>
            </div>
          )}

          {mode === 'register' && emailVerifyEnabled && (
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground/80 font-bold">{t('auth.fields.verifyCode')}</Label>
                <Input
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                  placeholder={t('auth.placeholders.verifyCode')}
                  className="h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40"
                />
              </div>
              <Button
                variant="outline"
                className="h-[44px] rounded-full px-5 text-meta"
                onClick={() => void sendVerifyCode()}
                disabled={sendingVerifyCode || verifyCodeCountdown > 0 || !account.trim()}
              >
                {sendingVerifyCode ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Mail className="h-4 w-4 mr-2" />}
                {verifyCodeCountdown > 0 ? t('auth.actions.sendCodeCountdown', { seconds: verifyCodeCountdown }) : t('auth.actions.sendCode')}
              </Button>
            </div>
          )}

          <div className="flex flex-col justify-between gap-3 sm:flex-row">
            <Button
              variant="ghost"
              className="h-[42px] rounded-full px-5 text-meta"
              onClick={() => void refreshAndReportStatus()}
              disabled={loading || submitting}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} />
              {t('auth.actions.refresh')}
            </Button>
            <div className="flex flex-col justify-end gap-3 sm:flex-row">
              {(hasRelayToken || hasAuthToken) && (
                <Button
                  variant="outline"
                  className="h-[42px] rounded-full px-5 text-meta"
                  onClick={() => void logout()}
                  disabled={submitting}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <XCircle className="h-4 w-4 mr-2" />}
                  {t('auth.actions.logout')}
                </Button>
              )}
                <Button
                className="h-[42px] rounded-full px-6 text-meta font-semibold"
                onClick={() => void submitAuth()}
                disabled={submitting || (mode === 'register' ? !canRegister : !canLogin)}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : mode === 'register' ? (
                  <UserPlus className="h-4 w-4 mr-2" />
                ) : (
                  <Key className="h-4 w-4 mr-2" />
                )}
                {mode === 'register'
                  ? t('auth.actions.registerAndActivate')
                  : loginDeviceAuthorizationRequired
                    ? t('auth.actions.loginAndAuthorize')
                    : t('auth.actions.login')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
