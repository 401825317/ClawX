import { promises as fsP } from 'node:fs';
import { join } from 'node:path';
import type { GatewayManager } from '../gateway/manager';
import { getOpenClawConfigDir } from './paths';
import {
  removeSessionEntry,
  resolveSessionTranscriptPath,
  sweepSessionArtefacts,
} from './session-files';
import { logger } from './logger';
import { hostTaskService } from '../services/agent-runtime/host-task-service';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SESSION_LIFECYCLE_TIMEOUT_MS = 30_000;
const PROTECTED_MAIN_SESSION_ERROR = /Cannot delete the main session\b/i;

type SessionDeletionGateway = Pick<GatewayManager, 'rpc'>;
type SessionDeletionContext = Pick<GatewayManager, 'rpc' | 'getStatus'>;

export type OpenClawSessionDeletionMode = 'absent' | 'deleted' | 'reset-main';

export type LocalChatSessionDeletionResult = {
  lifecycle: OpenClawSessionDeletionMode;
  removedFiles: string[];
  removedHostTasks: number;
  sweepErrors: Array<{ path: string; error: NodeJS.ErrnoException }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasSessionEntry(sessionsJson: Record<string, unknown>, sessionKey: string): boolean {
  if (Array.isArray(sessionsJson.sessions)) {
    return (sessionsJson.sessions as Array<Record<string, unknown>>)
      .some((entry) => entry.key === sessionKey || entry.sessionKey === sessionKey);
  }
  return Object.hasOwn(sessionsJson, sessionKey);
}

/**
 * Transfer runtime ownership to OpenClaw before ClawX touches persisted files.
 * OpenClaw protects the configured main-session identity, so that one session
 * is rotated to a fresh empty generation instead of being deleted outright.
 */
export async function settleOpenClawSessionForDeletion(
  gatewayManager: SessionDeletionGateway,
  sessionKey: string,
): Promise<Exclude<OpenClawSessionDeletionMode, 'absent'>> {
  try {
    await gatewayManager.rpc(
      'sessions.delete',
      { key: sessionKey, deleteTranscript: true },
      SESSION_LIFECYCLE_TIMEOUT_MS,
    );
    return 'deleted';
  } catch (error) {
    if (!PROTECTED_MAIN_SESSION_ERROR.test(errorMessage(error))) throw error;
  }

  await gatewayManager.rpc(
    'sessions.reset',
    { key: sessionKey, reason: 'reset' },
    SESSION_LIFECYCLE_TIMEOUT_MS,
  );
  return 'reset-main';
}

export async function deleteLocalChatSession(
  sessionKey: string,
  gatewayManager: SessionDeletionContext,
): Promise<LocalChatSessionDeletionResult> {
  if (!sessionKey.startsWith('agent:')) throw new Error(`Invalid sessionKey: ${sessionKey}`);
  const parts = sessionKey.split(':');
  if (parts.length < 3) throw new Error(`Malformed sessionKey: ${sessionKey}`);
  const agentId = parts[1];
  const sessionSegments = parts.slice(2);
  if (!SAFE_SESSION_SEGMENT.test(agentId) || sessionSegments.some((segment) => !SAFE_SESSION_SEGMENT.test(segment))) {
    throw new Error(`Invalid sessionKey: ${sessionKey}`);
  }

  const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');

  let sessionsJson: Record<string, unknown> = {};
  let sessionsJsonExists = true;
  try {
    const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
    sessionsJson = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code !== 'ENOENT') throw error;
    sessionsJsonExists = false;
  }

  const resolution = resolveSessionTranscriptPath(sessionsJson, sessionsDir, sessionKey);
  if (!resolution.ok && resolution.failure.kind === 'path-outside-scope') {
    throw new Error(`Resolved session path is outside the agent sessions dir: ${resolution.failure.resolvedPath}`);
  }

  // OpenClaw owns admission, active Run cancellation, sub-runtime cleanup and
  // its in-memory session cache. A running Gateway must settle even when the
  // disk index is absent because a cached entry or late writer may still exist.
  // With neither a disk entry nor a running Gateway, only orphan local sources
  // remain and deletion stays available offline.
  const lifecycle = hasSessionEntry(sessionsJson, sessionKey)
    || gatewayManager.getStatus().state === 'running'
    ? await settleOpenClawSessionForDeletion(gatewayManager, sessionKey)
    : 'absent';

  const removedFiles: string[] = [];
  const sweepErrors: Array<{ path: string; error: NodeJS.ErrnoException }> = [];
  if (resolution.ok) {
    const sweep = await sweepSessionArtefacts(resolution.sessionsDirAbs, resolution.baseId);
    removedFiles.push(...sweep.removed);
    sweepErrors.push(...sweep.errors);
    for (const { path: failedPath, error } of sweep.errors) {
      logger.warn(`[chat-session-cleanup] Failed to unlink ${failedPath}: ${String(error)}`);
    }
  }

  // Host task snapshots are an independent restart replay source.
  const removedHostTasks = await hostTaskService.removeSession(sessionKey);

  if (lifecycle !== 'reset-main' && sessionsJsonExists) {
    try {
      const latestRaw = await fsP.readFile(sessionsJsonPath, 'utf8');
      const latestJson = JSON.parse(latestRaw) as Record<string, unknown>;
      removeSessionEntry(latestJson, sessionKey);
      await fsP.writeFile(sessionsJsonPath, JSON.stringify(latestJson, null, 2), 'utf8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      if (code !== 'ENOENT') throw error;
    }
  }

  return { lifecycle, removedFiles, removedHostTasks, sweepErrors };
}
