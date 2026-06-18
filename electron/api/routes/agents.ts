import type { IncomingMessage, ServerResponse } from 'http';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentModel,
  updateAgentName,
} from '../../utils/agent-config';
import { deleteChannelAccountConfig } from '../../utils/channel-config';
import { syncAgentModelOverrideToRuntime, syncAllProviderAuthToRuntime } from '../../services/providers/provider-runtime-sync';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { ensureClawXContext } from '../../utils/openclaw-workspace';
import { CHAT_SEND_RPC_TIMEOUT_MS } from '../../../shared/chat-timeouts';
import {
  buildAgentProfilePrompt,
  isAgentProfileGenerationFailureText,
  normalizeAgentProfileGenerationFailureText,
  parseGeneratedAgentProfile,
  type AgentProfileGenerationInput,
} from '../../utils/agent-profile-generation';
import { deleteLocalChatSession } from '../../utils/chat-session-cleanup';

function scheduleGatewayReload(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state !== 'stopped') {
    ctx.gatewayManager.debouncedReload();
    return;
  }
  void reason;
}

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
const PROFILE_GENERATION_TIMEOUT_MS = 180_000;
const PROFILE_GENERATION_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
    .trim();
}

function findLatestAssistantMessage(history: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (!message || message.role !== 'assistant') continue;
    return message;
  }
  return undefined;
}

function extractLatestAssistantText(history: Record<string, unknown> | undefined): string {
  const message = findLatestAssistantMessage(history);
  if (!message) return '';
  const text = extractMessageText(message.content);
  if (text) return text;
  return '';
}

function extractLatestAssistantFailure(history: Record<string, unknown> | undefined): string {
  const message = findLatestAssistantMessage(history);
  if (!message) return '';
  const errorMessage = typeof message.errorMessage === 'string'
    ? message.errorMessage.trim()
    : typeof message.error_message === 'string'
      ? message.error_message.trim()
      : '';
  if (errorMessage) return errorMessage;

  const stopReason = message.stopReason ?? message.stop_reason;
  if (stopReason === 'error') {
    const text = extractMessageText(message.content);
    if (text) return text;
    return 'Agent profile generation failed before the model produced a reply.';
  }
  return '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isSessionActive(ctx: HostApiContext, sessionKey: string): Promise<boolean> {
  try {
    const result = await ctx.gatewayManager.rpc<Record<string, unknown>>(
      'sessions.list',
      {
        includeDerivedTitles: false,
        includeLastMessage: false,
      },
      15_000,
    );
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    const session = sessions.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      return record.key === sessionKey || record.sessionKey === sessionKey;
    }) as Record<string, unknown> | undefined;
    if (!session) return false;
    return session.hasActiveRun === true || session.status === 'running' || session.status === 'active';
  } catch {
    return true;
  }
}

async function generateAgentProfileViaGateway(
  ctx: HostApiContext,
  input: AgentProfileGenerationInput,
) {
  const roleName = typeof input.roleName === 'string' ? input.roleName.trim() : '';
  const responsibility = typeof input.responsibility === 'string' ? input.responsibility.trim() : '';
  if (!roleName || !responsibility) {
    throw new Error('roleName and responsibility are required');
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const sessionKey = `agent:main:uclaw-profile-${suffix}`;
  const idempotencyKey = `uclaw-profile-${suffix}`;
  const prompt = buildAgentProfilePrompt({
    roleName,
    responsibility,
    avatarId: input.avatarId,
    locale: input.locale,
  });
  let lastParseError: Error | null = null;

  try {
    await ctx.gatewayManager.rpc<{ runId?: string }>(
      'chat.send',
      {
        sessionKey,
        message: prompt,
        deliver: false,
        idempotencyKey,
      },
      CHAT_SEND_RPC_TIMEOUT_MS,
    );

    const deadline = Date.now() + PROFILE_GENERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(PROFILE_GENERATION_POLL_MS);
      const history = await ctx.gatewayManager.rpc<Record<string, unknown>>(
        'chat.history',
        {
          sessionKey,
          limit: 20,
          maxChars: 80_000,
        },
        20_000,
      );
      const failure = extractLatestAssistantFailure(history);
      if (failure) {
        throw new Error(normalizeAgentProfileGenerationFailureText(failure));
      }
      const text = extractLatestAssistantText(history);
      if (!text) continue;
      if (isAgentProfileGenerationFailureText(text)) {
        throw new Error(normalizeAgentProfileGenerationFailureText(text));
      }

      try {
        const profile = parseGeneratedAgentProfile(text, input);
        if (await isSessionActive(ctx, sessionKey)) {
          continue;
        }
        return profile;
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error(String(error));
        if (!(await isSessionActive(ctx, sessionKey))) {
          throw lastParseError;
        }
      }
    }

    throw lastParseError ?? new Error('Timed out while generating the Agent profile. Please retry.');
  } finally {
    await ctx.gatewayManager.rpc('chat.abort', { sessionKey }, 15_000).catch(() => {
      // The run may already be complete, or the gateway may be shutting down.
    });
    await deleteLocalChatSession(sessionKey).catch((error) => {
      console.warn('[agents] Failed to clean temporary profile generation session:', error);
    });
  }
}

/**
 * Force a full Gateway process restart after agent deletion.
 *
 * A SIGUSR1 in-process reload is NOT sufficient here: channel plugins
 * (e.g. Feishu) maintain long-lived WebSocket connections to external
 * services and do not disconnect accounts that were removed from the
 * config during an in-process reload.  The only reliable way to drop
 * stale bot connections is to kill the Gateway process entirely and
 * spawn a fresh one that reads the updated openclaw.json from scratch.
 */
export async function restartGatewayForAgentDeletion(ctx: HostApiContext): Promise<void> {
  try {
    // Capture the PID of the running Gateway BEFORE stop() clears it.
    const status = ctx.gatewayManager.getStatus();
    const pid = status.pid;
    const port = status.port;
    console.log('[agents] Triggering Gateway restart (kill+respawn) after agent deletion', { pid, port });

    // Force-kill the Gateway process by PID.  The manager's stop() only
    // kills "owned" processes; if the manager connected to an already-
    // running Gateway (ownsProcess=false), stop() simply closes the WS
    // and the old process stays alive with its stale channel connections.
    if (pid) {
      try {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /F /PID ${pid} /T`);
        } else {
          process.kill(pid, 'SIGTERM');
          // Give it a moment to die
          await new Promise((resolve) => setTimeout(resolve, 500));
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
      } catch {
        // process already gone – that's fine
      }
    } else if (port) {
      // If we don't know the PID (e.g. connected to an orphaned Gateway from
      // a previous pnpm dev run), forcefully kill whatever is on the port.
      try {
        if (process.platform === 'darwin' || process.platform === 'linux') {
          // MUST use -sTCP:LISTEN. Otherwise lsof returns the client process (ClawX itself) 
          // that has an ESTABLISHED WebSocket connection to the port, causing us to kill ourselves.
          const { stdout } = await execAsync(`lsof -t -i :${port} -sTCP:LISTEN`);
          const pids = stdout.trim().split('\n').filter(Boolean);
          for (const p of pids) {
            try { process.kill(parseInt(p, 10), 'SIGTERM'); } catch { /* ignore */ }
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          for (const p of pids) {
            try { process.kill(parseInt(p, 10), 'SIGKILL'); } catch { /* ignore */ }
          }
        } else if (process.platform === 'win32') {
          // Find PID listening on the port
          const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
          const lines = stdout.trim().split('\n');
          const pids = new Set<string>();
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
              pids.add(parts[4]);
            }
          }
          for (const p of pids) {
            try { await execAsync(`taskkill /F /PID ${p} /T`); } catch { /* ignore */ }
          }
        }
      } catch {
        // Port might not be bound or command failed; ignore
      }
    }

    await ctx.gatewayManager.restart();
    console.log('[agents] Gateway restart completed after agent deletion');
  } catch (err) {
    console.warn('[agents] Gateway restart after agent deletion failed:', err);
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/agents/generate-profile' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<AgentProfileGenerationInput>(req);
      const profile = await generateAgentProfileViaGateway(ctx, body);
      sendJson(res, 200, { success: true, profile });
    } catch (error) {
      sendJson(res, 500, { success: false, error: getErrorMessage(error) });
    }
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    sendJson(res, 200, { success: true, ...(await listAgentsSnapshot()) });
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        name: string;
        inheritWorkspace?: boolean;
        profile?: Record<string, unknown>;
      }>(req);
      const snapshot = await createAgent(body.name, {
        inheritWorkspace: body.inheritWorkspace,
        profile: body.profile,
      });
      // Sync provider API keys to the new agent's auth-profiles.json so the
      // embedded runner can authenticate with LLM providers when messages
      // arrive via channel bots (e.g. Feishu). Without this, the copied
      // auth-profiles.json may contain a stale key → 401 from the LLM.
      syncAllProviderAuthToRuntime().catch((err) => {
        console.warn('[agents] Failed to sync provider auth after agent creation:', err);
      });
      scheduleGatewayReload(ctx, 'create-agent');
      // Ensure newly provisioned workspaces get ClawX context merge/cleanup
      // even when gateway status events do not fire (e.g. in-process reload).
      void ensureClawXContext({ waitForAllConfiguredWorkspaces: true }).catch((err) => {
        console.warn('[agents] Failed to ensure ClawX context after agent creation:', err);
      });
      sendJson(res, 200, { success: true, ...snapshot });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'PUT') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const body = await parseJsonBody<{ name: string }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentName(agentId, body.name);
        scheduleGatewayReload(ctx, 'update-agent');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 2 && parts[1] === 'model') {
      try {
        const body = await parseJsonBody<{ modelRef?: string | null }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentModel(agentId, body.modelRef ?? null);
        try {
          await syncAllProviderAuthToRuntime();
          // Ensure this agent's runtime model registry reflects the new model override.
          await syncAgentModelOverrideToRuntime(agentId);
        } catch (syncError) {
          console.warn('[agents] Failed to sync runtime after updating agent model:', syncError);
        }
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const snapshot = await assignChannelToAgent(agentId, channelType);
        scheduleGatewayReload(ctx, 'assign-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const { snapshot, removedEntry } = await deleteAgentConfig(agentId);
        // Await reload synchronously BEFORE responding to the client.
        // This ensures the Feishu plugin has disconnected the deleted bot
        // before the UI shows "delete success" and the user tries chatting.
        await restartGatewayForAgentDeletion(ctx);
        // Delete workspace after reload so the new config is already live.
        await removeAgentWorkspaceDirectory(removedEntry).catch((err) => {
          console.warn('[agents] Failed to remove workspace after agent deletion:', err);
        });
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const ownerId = agentId.trim().toLowerCase();
        const snapshotBefore = await listAgentsSnapshot();
        const ownedAccountIds = Object.entries(snapshotBefore.channelAccountOwners)
          .filter(([channelAccountKey, owner]) => {
            if (owner !== ownerId) return false;
            return channelAccountKey.startsWith(`${channelType}:`);
          })
          .map(([channelAccountKey]) => channelAccountKey.slice(channelAccountKey.indexOf(':') + 1));
        // Backward compatibility for legacy agentId->accountId mapping.
        if (ownedAccountIds.length === 0) {
          const legacyAccountId = resolveAccountIdForAgent(agentId);
          if (snapshotBefore.channelAccountOwners[`${channelType}:${legacyAccountId}`] === ownerId) {
            ownedAccountIds.push(legacyAccountId);
          }
        }

        for (const accountId of ownedAccountIds) {
          await deleteChannelAccountConfig(channelType, accountId);
          await clearChannelBinding(channelType, accountId);
        }
        const snapshot = await listAgentsSnapshot();
        scheduleGatewayReload(ctx, 'remove-agent-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  return false;
}
