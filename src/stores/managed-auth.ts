import { create } from 'zustand';
import type { ManagedAuthStatus } from '@shared/managed-auth';
import { hostApi } from '@/lib/host-api';
import { getManagedAuthErrorKey, type ManagedAuthErrorKey } from '@/lib/managed-auth-errors';
import { isManagedAuthLocallyReady } from '@/lib/managed-auth';

interface ManagedAuthStore {
  status: ManagedAuthStatus | null;
  loading: boolean;
  verifying: boolean;
  initialized: boolean;
  error: ManagedAuthErrorKey | null;
  loadLocalStatus: () => Promise<ManagedAuthStatus>;
  refreshStatus: (force?: boolean) => Promise<ManagedAuthStatus>;
  logout: () => Promise<ManagedAuthStatus>;
  setStatus: (status: ManagedAuthStatus | null) => void;
}

function statusError(status: ManagedAuthStatus): ManagedAuthErrorKey | null {
  if (!status.authErrorCode || status.authRejected) return null;
  return getManagedAuthErrorKey(status.authErrorCode);
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
      const status = await hostApi.managedAuth.localStatus();
      set({ status, loading: false, initialized: true, error: null });
      return status;
    } catch (error) {
      set({ loading: false, initialized: true, error: getManagedAuthErrorKey(error) });
      throw error;
    }
  },

  refreshStatus: async (force = false) => {
    const initialized = get().initialized;
    set({ loading: !initialized, verifying: true, error: null });
    try {
      const status = await hostApi.managedAuth.status(force ? { force: true } : undefined);
      set({
        status,
        loading: false,
        verifying: false,
        initialized: true,
        error: statusError(status),
      });
      return status;
    } catch (error) {
      const previousStatus = get().status;
      const keepLocalSession = isManagedAuthLocallyReady(previousStatus);
      set({
        loading: false,
        verifying: false,
        initialized: true,
        error: keepLocalSession ? null : getManagedAuthErrorKey(error),
      });
      throw error;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      const result = await hostApi.managedAuth.logout();
      if (!result.success) throw new Error(result.errorCode || 'UNKNOWN');
      const status = result.status ?? await hostApi.managedAuth.localStatus();
      set({ status, loading: false, verifying: false, initialized: true, error: null });
      return status;
    } catch (error) {
      set({ loading: false, verifying: false, initialized: true, error: getManagedAuthErrorKey(error) });
      throw error;
    }
  },

  setStatus: (status) => set({ status, initialized: true, error: null }),
}));
