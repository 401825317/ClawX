import type { AgentProfileDraft, AgentProfileGenerationInput } from '@shared/types/agent';
import type { GatewayManager } from '../gateway/manager';
import {
  buildAgentProfilePrompt,
  buildFallbackAgentProfile,
  isAgentProfileGenerationFailureText,
  normalizeAgentProfileGenerationFailureText,
  parseGeneratedAgentProfile,
} from '../utils/agent-profile-generation';
import { deleteLocalChatSession } from '../utils/chat-session-cleanup';

const PROFILE_SESSION_PREFIX = 'agent:main:uclaw-profile-';
const PROFILE_GENERATION_TIMEOUT_MS = 180_000;
const PROFILE_GENERATION_POLL_MS = 1_000;
const PROFILE_GENERATION_HISTORY_TIMEOUT_MS = 6_000;
const PROFILE_GENERATION_MAX_HISTORY_TIMEOUTS = 2;
const PROFILE_GENERATION_RPC_TIMEOUT_MS = 15_000;
const CHAT_SEND_RPC_TIMEOUT_MS = 120_000;

type AgentProfileGenerationContext = {
  gatewayManager: Pick<GatewayManager, 'rpc'>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
    .trim();
}

function findLatestAssistantMessage(history: Record<string, unknown>): Record<string, unknown> | null {
  const messages = Array.isArray(history.messages) ? history.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && (message as Record<string, unknown>).role === 'assistant') {
      return message as Record<string, unknown>;
    }
  }
  return null;
}

function extractLatestAssistantFailure(history: Record<string, unknown>): string {
  const message = findLatestAssistantMessage(history);
  if (!message) return '';
  const explicitError = typeof message.errorMessage === 'string'
    ? message.errorMessage.trim()
    : typeof message.error_message === 'string' ? message.error_message.trim() : '';
  if (explicitError) return explicitError;
  if ((message.stopReason ?? message.stop_reason) !== 'error') return '';
  return extractMessageText(message.content)
    || 'Agent profile generation failed before the model produced a reply.';
}

function extractLatestAssistantText(history: Record<string, unknown>): string {
  const message = findLatestAssistantMessage(history);
  return message ? extractMessageText(message.content) : '';
}

function isChatHistoryTimeout(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('rpc timeout: chat.history')
    || (message.includes('chat.history') && message.includes('timeout'));
}

async function isSessionActive(
  context: AgentProfileGenerationContext,
  sessionKey: string,
): Promise<boolean> {
  try {
    const result = await context.gatewayManager.rpc<Record<string, unknown>>(
      'sessions.list',
      { includeDerivedTitles: false, includeLastMessage: false },
      PROFILE_GENERATION_RPC_TIMEOUT_MS,
    );
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    const session = sessions.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      return record.key === sessionKey || record.sessionKey === sessionKey;
    }) as Record<string, unknown> | undefined;
    return session?.hasActiveRun === true || session?.status === 'running' || session?.status === 'active';
  } catch {
    // If liveness cannot be checked, continue polling rather than parse a partial response.
    return true;
  }
}

/** Generate one Agent persona in an isolated, non-delivered OpenClaw session. */
export async function generateAgentProfileViaGateway(
  context: AgentProfileGenerationContext,
  input: AgentProfileGenerationInput,
): Promise<AgentProfileDraft> {
  const roleName = input.roleName.trim();
  const responsibility = input.responsibility.trim();
  if (!roleName || !responsibility) throw new Error('roleName and responsibility are required');

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const sessionKey = `${PROFILE_SESSION_PREFIX}${suffix}`;
  const normalizedInput = { ...input, roleName, responsibility };
  let lastParseError: Error | null = null;
  let consecutiveHistoryTimeouts = 0;

  try {
    // The main Agent's current managed default model remains authoritative.
    await context.gatewayManager.rpc(
      'sessions.create',
      { key: sessionKey, agentId: 'main' },
      PROFILE_GENERATION_RPC_TIMEOUT_MS,
    );
    await context.gatewayManager.rpc(
      'chat.send',
      {
        sessionKey,
        message: buildAgentProfilePrompt(normalizedInput),
        deliver: false,
        idempotencyKey: `uclaw-profile-${suffix}`,
      },
      CHAT_SEND_RPC_TIMEOUT_MS,
    );

    const deadline = Date.now() + PROFILE_GENERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(PROFILE_GENERATION_POLL_MS);
      let history: Record<string, unknown>;
      try {
        history = await context.gatewayManager.rpc<Record<string, unknown>>(
          'chat.history',
          { sessionKey, limit: 20, maxChars: 80_000 },
          PROFILE_GENERATION_HISTORY_TIMEOUT_MS,
        );
        consecutiveHistoryTimeouts = 0;
      } catch (error) {
        if (!isChatHistoryTimeout(error)) throw error;
        consecutiveHistoryTimeouts += 1;
        if (consecutiveHistoryTimeouts >= PROFILE_GENERATION_MAX_HISTORY_TIMEOUTS) {
          return buildFallbackAgentProfile(normalizedInput);
        }
        continue;
      }

      const failure = extractLatestAssistantFailure(history);
      if (failure) throw new Error(normalizeAgentProfileGenerationFailureText(failure));
      const text = extractLatestAssistantText(history);
      if (!text) continue;
      if (isAgentProfileGenerationFailureText(text)) {
        throw new Error(normalizeAgentProfileGenerationFailureText(text));
      }

      try {
        const profile = parseGeneratedAgentProfile(text, normalizedInput);
        if (await isSessionActive(context, sessionKey)) continue;
        return profile;
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error(String(error));
        if (!(await isSessionActive(context, sessionKey))) throw lastParseError;
      }
    }
    throw lastParseError ?? new Error('Timed out while generating the Agent profile. Please retry.');
  } finally {
    await Promise.resolve(context.gatewayManager.rpc(
      'chat.abort',
      { sessionKey },
      PROFILE_GENERATION_RPC_TIMEOUT_MS,
    )).catch(() => undefined);
    await deleteLocalChatSession(sessionKey).catch((error) => {
      console.warn('[agents] Failed to clean temporary profile generation session:', error);
    });
  }
}
