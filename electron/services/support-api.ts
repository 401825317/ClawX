import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { getSupportContactConfig } from './support-service';

/** Create the read-only support service exposed to Renderer. */
export function createSupportApi(): CompleteHostServiceRegistry['support'] {
  return {
    config: () => getSupportContactConfig(),
  };
}
