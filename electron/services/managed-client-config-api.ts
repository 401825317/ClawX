import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { isRecord } from './payload-utils';
import { getManagedClientTextModelPolicy } from './managed-client-config-service';

/** Create the read-only managed client configuration service exposed to Renderer. */
export function createManagedClientConfigApi(): CompleteHostServiceRegistry['managedClientConfig'] {
  return {
    textModels: (payload) => {
      if (payload !== undefined && (!isRecord(payload) || (
        payload.refresh !== undefined && typeof payload.refresh !== 'boolean'
      ))) {
        throw new Error('Invalid managedClientConfig.textModels payload');
      }
      return getManagedClientTextModelPolicy({ refresh: payload?.refresh === true });
    },
  };
}
