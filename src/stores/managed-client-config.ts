import { create } from 'zustand';
import type { ManagedClientTextModelPolicy } from '@shared/managed-client-config';
import { createDefaultManagedClientTextModelPolicy } from '@shared/managed-client-config';
import { hostApi } from '@/lib/host-api';

interface ManagedClientConfigStore {
  textModelPolicy: ManagedClientTextModelPolicy;
  initialized: boolean;
  loading: boolean;
  loadTextModels: (refresh?: boolean) => Promise<ManagedClientTextModelPolicy>;
}

export const useManagedClientConfigStore = create<ManagedClientConfigStore>((set) => ({
  textModelPolicy: createDefaultManagedClientTextModelPolicy(),
  initialized: false,
  loading: false,

  loadTextModels: async (refresh = true) => {
    set({ loading: true });
    try {
      const textModelPolicy = await hostApi.managedClientConfig.textModels({ refresh });
      set({ textModelPolicy, initialized: true, loading: false });
      return textModelPolicy;
    } catch (error) {
      set({ initialized: true, loading: false });
      throw error;
    }
  },
}));
