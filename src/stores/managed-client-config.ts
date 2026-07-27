import { create } from 'zustand';
import type {
  ManagedClientTextModelPolicy,
  ManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';
import {
  createDefaultManagedClientTextModelPolicy,
  createDefaultManagedClientVideoModelPolicy,
} from '@shared/managed-client-config';
import { hostApi } from '@/lib/host-api';

interface ManagedClientConfigStore {
  textModelPolicy: ManagedClientTextModelPolicy;
  videoModelPolicy: ManagedClientVideoModelPolicy;
  initialized: boolean;
  loading: boolean;
  loadTextModels: (refresh?: boolean) => Promise<ManagedClientTextModelPolicy>;
  loadVideoModels: (refresh?: boolean) => Promise<ManagedClientVideoModelPolicy>;
}

export const useManagedClientConfigStore = create<ManagedClientConfigStore>((set) => ({
  textModelPolicy: createDefaultManagedClientTextModelPolicy(),
  videoModelPolicy: createDefaultManagedClientVideoModelPolicy(),
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

  loadVideoModels: async (refresh = true) => {
    const videoModelPolicy = await hostApi.managedClientConfig.videoModels({ refresh });
    set({ videoModelPolicy });
    return videoModelPolicy;
  },
}));
