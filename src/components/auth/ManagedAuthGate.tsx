import { useEffect } from 'react';
import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ManagedAccountAuthPanel } from '@/components/auth/ManagedAccountAuthPanel';
import { scheduleAfterNavigationFrame, scheduleIdleWork } from '@/lib/deferred-work';
import {
  getManagedAuthServiceName,
  getManagedAuthStateKey,
} from '@/lib/managed-auth';
import { cn } from '@/lib/utils';
import { useManagedAuthStore } from '@/stores/managed-auth';

interface ManagedAuthGateProps {
  enabled: boolean;
}

const MANAGED_AUTH_REMOTE_VERIFY_IDLE_TIMEOUT_MS = 1_500;

export function ManagedAuthGate({ enabled }: ManagedAuthGateProps) {
  const { t } = useTranslation('setup');
  const location = useLocation();
  const status = useManagedAuthStore((state) => state.status);
  const loading = useManagedAuthStore((state) => state.loading);
  const initialized = useManagedAuthStore((state) => state.initialized);
  const error = useManagedAuthStore((state) => state.error);
  const loadLocalStatus = useManagedAuthStore((state) => state.loadLocalStatus);
  const refreshStatus = useManagedAuthStore((state) => state.refreshStatus);
  const onSetupPage = location.pathname.startsWith('/setup');
  const shouldCheck = enabled && !onSetupPage;
  const stateKey = getManagedAuthStateKey(status, { loading, error });
  const ready = stateKey === 'ready' || stateKey === 'unmanaged';

  useEffect(() => {
    if (!shouldCheck) {
      return undefined;
    }

    let cancelled = false;
    let cancelInitialCheck: (() => void) | null = null;
    let cancelRemoteVerify: (() => void) | null = null;
    const runRemoteVerify = async () => {
      try {
        await refreshStatus();
      } catch {
        if (!cancelled) {
          // Store already carries the error. The gate stays visible.
        }
      }
    };

    const scheduleRemoteVerify = () => {
      cancelRemoteVerify?.();
      cancelRemoteVerify = scheduleIdleWork(() => {
        cancelRemoteVerify = null;
        if (!cancelled && document.visibilityState !== 'hidden') {
          void runRemoteVerify();
        }
      }, MANAGED_AUTH_REMOTE_VERIFY_IDLE_TIMEOUT_MS);
    };

    const runInitialCheck = async () => {
      try {
        await loadLocalStatus();
      } catch {
        // Fall through to remote verification. The store keeps the local error.
      }
      if (!cancelled) {
        scheduleRemoteVerify();
      }
    };

    cancelInitialCheck = scheduleAfterNavigationFrame(() => {
      void runInitialCheck();
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        scheduleRemoteVerify();
      }
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      cancelInitialCheck?.();
      cancelRemoteVerify?.();
      window.clearInterval(timer);
    };
  }, [loadLocalStatus, refreshStatus, shouldCheck]);

  if (!shouldCheck || ready) {
    return null;
  }

  const serviceName = getManagedAuthServiceName(status) || t('auth.brand');
  const showSpinner = loading && !initialized;

  return (
    <div
      data-testid="managed-auth-gate"
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-background/80 p-4 backdrop-blur-xl"
    >
      <div className="w-full max-w-xl rounded-2xl border border-black/10 bg-surface-modal p-6 shadow-2xl dark:border-white/10">
        <div className="mb-5 flex items-start gap-3">
          <div className={cn(
            'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            stateKey === 'checking'
              ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
          )}>
            {showSpinner ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertCircle className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <p className="text-meta font-semibold text-muted-foreground">{serviceName}</p>
            </div>
            <h2 className="mt-1 text-2xl font-serif font-normal tracking-tight text-foreground">
              {t(`authGate.state.${stateKey}.title`)}
            </h2>
            <p className="mt-2 text-meta leading-6 text-muted-foreground">
              {error && stateKey === 'error'
                ? t('authGate.state.error.descriptionWithMessage', { message: error })
                : t(`authGate.state.${stateKey}.description`)}
            </p>
          </div>
        </div>

        {stateKey === 'checking' ? null : (
          <ManagedAccountAuthPanel
            defaultMode="login"
            allowRegister={false}
            successVisible={false}
          />
        )}
      </div>
    </div>
  );
}
