import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PortableRuntimeHealthSnapshot } from '@shared/portable-runtime-health';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';

export function PortableRuntimeHealthNotice() {
  const { t } = useTranslation('settings');
  const [health, setHealth] = useState<PortableRuntimeHealthSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    let eventRevision = 0;
    const subscribe = hostEvents.onPortableRuntimeHealthChanged;
    const unsubscribe = typeof subscribe === 'function'
      ? subscribe((snapshot) => {
          eventRevision += 1;
          if (active) setHealth(snapshot);
        })
      : () => undefined;
    const queryRevision = eventRevision;

    void (async () => {
      try {
        const query = hostApi.app.portableRuntimeHealth;
        const snapshot = typeof query === 'function' ? await query() : null;
        if (active && eventRevision === queryRevision) setHealth(snapshot);
      } catch {
        // Health reporting must never block Settings when Main is unavailable.
      }
    })();

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (health?.status !== 'warning' || !health.issue) return null;

  const copyKey = health.issue === 'snapshot-overdue'
    ? 'overdue'
    : health.issue === 'snapshot-not-completed'
      ? 'notCompleted'
      : 'repeatedlyDeferred';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="portable-runtime-health-notice"
      data-health-issue={health.issue}
      className="flex items-start gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{t(`portableRuntimeHealth.${copyKey}Title`)}</p>
        <p className="mt-1 text-sm leading-5 text-amber-900/80 dark:text-amber-100/80">
          {t(`portableRuntimeHealth.${copyKey}Description`, {
            attempts: health.consecutiveFailures,
          })}
        </p>
      </div>
    </div>
  );
}
