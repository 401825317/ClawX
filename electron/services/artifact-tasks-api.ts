import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { artifactTaskService } from './artifact-task-service';
import { isRecord } from './payload-utils';

const ARTIFACT_KINDS = new Set([
  'presentation',
  'document',
  'spreadsheet',
  'webpage',
  'ecommerce-main-image',
]);

export function createArtifactTasksApi(): CompleteHostServiceRegistry['artifactTasks'] {
  return {
    prepare: async (payload) => {
      if (
        !isRecord(payload)
        || typeof payload.sessionKey !== 'string'
        || typeof payload.agentId !== 'string'
        || typeof payload.workspaceRoot !== 'string'
        || typeof payload.message !== 'string'
        || typeof payload.hasHistory !== 'boolean'
        || (payload.kindHint !== undefined && (
          typeof payload.kindHint !== 'string' || !ARTIFACT_KINDS.has(payload.kindHint)
        ))
      ) {
        throw new Error('Invalid artifactTasks.prepare payload');
      }
      return artifactTaskService.prepare(payload);
    },
    validateWebpage: async (payload) => {
      if (
        !isRecord(payload)
        || typeof payload.workspaceRoot !== 'string'
        || typeof payload.filePath !== 'string'
      ) {
        throw new Error('Invalid artifactTasks.validateWebpage payload');
      }
      return artifactTaskService.validateWebpage(payload);
    },
  };
}
