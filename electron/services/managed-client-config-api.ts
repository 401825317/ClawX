import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { isRecord } from './payload-utils';
import {
  getManagedClientImageModelPolicy,
  getManagedClientTextModelPolicy,
  getManagedClientVideoModelPolicy,
  getManagedClientRuntimeConfig,
} from './managed-client-config-service';

function validatePolicyRequest(
  payload: unknown,
  action: 'textModels' | 'imageModels' | 'videoModels' | 'runtimeConfig',
): void {
  if (payload !== undefined && (!isRecord(payload) || (
    payload.refresh !== undefined && typeof payload.refresh !== 'boolean'
  ))) {
    throw new Error(`Invalid managedClientConfig.${action} payload`);
  }
}

/** Create the read-only managed client configuration service exposed to Renderer. */
export function createManagedClientConfigApi(): CompleteHostServiceRegistry['managedClientConfig'] {
  return {
    textModels: (payload) => {
      validatePolicyRequest(payload, 'textModels');
      return getManagedClientTextModelPolicy({ refresh: payload?.refresh === true });
    },
    imageModels: (payload) => {
      validatePolicyRequest(payload, 'imageModels');
      return getManagedClientImageModelPolicy({ refresh: payload?.refresh === true });
    },
    videoModels: (payload) => {
      validatePolicyRequest(payload, 'videoModels');
      return getManagedClientVideoModelPolicy({ refresh: payload?.refresh === true });
    },
    runtimeConfig: (payload) => {
      validatePolicyRequest(payload, 'runtimeConfig');
      return getManagedClientRuntimeConfig({ refresh: payload?.refresh === true });
    },
  };
}
