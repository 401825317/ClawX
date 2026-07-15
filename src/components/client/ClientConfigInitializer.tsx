import { useEffect } from 'react';
import { scheduleIdleWork } from '@/lib/deferred-work';
import { useClientConfigStore } from '@/stores/client-config';
import { useConversationStore } from '@/stores/conversation/store';
import { resolveConversationTimelineMode } from '../../../shared/conversation-rollout';

interface ClientConfigInitializerProps {
  enabled: boolean;
}

const CLIENT_CONFIG_IDLE_TIMEOUT_MS = 1_500;

export function ClientConfigInitializer(props: ClientConfigInitializerProps) {
  const fetchConfig = useClientConfigStore((state) => state.fetchConfig);
  const configuredTimelineMode = useClientConfigStore((state) => state.chatTimelineMode);
  const setTimelineMode = useConversationStore((state) => state.setMode);

  useEffect(() => {
    setTimelineMode(resolveConversationTimelineMode(
      window.electron?.chatTimelineModeOverride,
      configuredTimelineMode,
    ));
  }, [configuredTimelineMode, setTimelineMode]);

  useEffect(() => {
    if (!props.enabled) {
      return;
    }

    let cancelScheduledRefresh: (() => void) | null = null;

    const scheduleRefresh = () => {
      cancelScheduledRefresh?.();
      cancelScheduledRefresh = scheduleIdleWork(() => {
        cancelScheduledRefresh = null;
        if (document.visibilityState !== 'hidden') {
          void fetchConfig();
        }
      }, CLIENT_CONFIG_IDLE_TIMEOUT_MS);
    };

    scheduleRefresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        scheduleRefresh();
      }
    }, 10 * 60 * 1000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelScheduledRefresh?.();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchConfig, props.enabled]);

  return null;
}
