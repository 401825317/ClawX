import { useEffect } from 'react';
import { UCLAW_SUPPORT_REFRESH_INTERVAL_MS } from '@shared/junfeiai-endpoints';
import { useAnnouncementsStore } from '@/stores/announcements';

type AnnouncementsInitializerProps = {
  enabled: boolean;
};

/** Loads public announcements without coupling them to auth or Gateway state. */
export function AnnouncementsInitializer({ enabled }: AnnouncementsInitializerProps) {
  const fetchConfig = useAnnouncementsStore((state) => state.fetchConfig);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    const refresh = () => {
      if (!cancelled && document.visibilityState !== 'hidden') void fetchConfig();
    };
    const initialTimer = window.setTimeout(refresh, 1500);
    const interval = window.setInterval(refresh, UCLAW_SUPPORT_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, fetchConfig]);

  return null;
}
