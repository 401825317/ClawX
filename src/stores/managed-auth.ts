import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import {
  isManagedAuthLocallyReady,
  isManagedAuthRecoverableLocalSession,
  type ManagedAuthStatus,
} from '@/lib/managed-auth';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ManagedAuthStore {
  status: ManagedAuthStatus | null;
  loading: boolean;
  verifying: boolean;
  initialized: boolean;
  error: string | null;
  loadLocalStatus: () => Promise<ManagedAuthStatus>;
  refreshStatus: () => Promise<ManagedAuthStatus>;
  logout: () => Promise<void>;
  setStatus: (status: ManagedAuthStatus | null) => void;
}

export const useManagedAuthStore = create<ManagedAuthStore>((set, get) => ({
  status: null,
  loading: false,
  verifying: false,
  initialized: false,
  error: null,

  loadLocalStatus: async () => {
    set({ loading: true, error: null });
    try {
      const status = await hostApiFetch<ManagedAuthStatus>('/api/junfeiai/status/local');
      set({ status, loading: false, initialized: true, error: null });
      return status;
    } catch (error) {
      set({
        loading: false,
        initialized: true,
        error: errorMessage(error),
      });
      throw error;
    }
  },

  refreshStatus: async () => {
    const hasInitialized = get().initialized;
    set({
      loading: !hasInitialized,
      verifying: true,
      error: null,
    });
    try {
      const status = await hostApiFetch<ManagedAuthStatus>('/api/junfeiai/status');
      const previousStatus = get().status;
      if (
        isManagedAuthRecoverableLocalSession(status)
        && (isManagedAuthLocallyReady(previousStatus) || isManagedAuthRecoverableLocalSession(previousStatus))
      ) {
        set({ status: previousStatus, loading: false, verifying: false, initialized: true, error: null });
        return previousStatus as ManagedAuthStatus;
      }
      set({ status, loading: false, verifying: false, initialized: true, error: null });
      return status;
    } catch (error) {
      const previousStatus = get().status;
      const keepLocalReady = isManagedAuthLocallyReady(previousStatus);
      set({
        loading: false,
        verifying: false,
        initialized: true,
        ...(keepLocalReady ? { status: previousStatus } : {}),
        error: keepLocalReady ? null : errorMessage(error),
      });
      throw error;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      await hostApiFetch('/api/junfeiai/logout', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      set({
        status: {
          managed: true,
          hasRelayToken: false,
          hasAuthToken: false,
          authValid: false,
        },
        loading: false,
        verifying: false,
        initialized: true,
        error: null,
      });
      try {
        await get().refreshStatus();
      } catch (error) {
        set({
          loading: false,
          verifying: false,
          initialized: true,
          error: errorMessage(error),
        });
      }
    } catch (error) {
      set({
        loading: false,
        verifying: false,
        initialized: true,
        error: errorMessage(error),
      });
      throw error;
    }
  },

  setStatus: (status) => set({ status, initialized: true, error: null }),
}));
