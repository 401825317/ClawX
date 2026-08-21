import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from './store';

let pendingInstallationId: Promise<string> | null = null;

export function getOrCreateInstallationId(): Promise<string> {
  if (!pendingInstallationId) {
    pendingInstallationId = (async () => {
      const existing = await getSetting('machineId').catch(() => '');
      if (typeof existing === 'string' && existing.trim()) return existing.trim();
      const created = randomUUID();
      await setSetting('machineId', created);
      return created;
    })().catch((error) => {
      pendingInstallationId = null;
      throw error;
    });
  }
  return pendingInstallationId;
}

export const __test = {
  reset: () => {
    pendingInstallationId = null;
  },
};
