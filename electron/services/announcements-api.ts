import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { getClientAnnouncementConfig } from './announcements-service';

/** Create the read-only announcement service exposed to Renderer. */
export function createAnnouncementsApi(): CompleteHostServiceRegistry['announcements'] {
  return {
    config: () => getClientAnnouncementConfig(),
  };
}
