import { buildBaselineRunKey, captureBaseline } from '../baseline-cache';
import { isInternalMessage } from './helpers';
import type { ContentBlock, RawMessage, ToolStatus } from './types';

const BASELINE_WRITE_TOOLS = new Set([
  'Write', 'write_file', 'create_file', 'WriteFile', 'createFile', 'write',
]);
const BASELINE_EDIT_TOOLS = new Set([
  'Edit', 'edit', 'edit_file', 'EditFile',
  'StrReplace', 'str_replace', 'str_replace_editor',
  'MultiEdit', 'multi_edit', 'multiEdit',
]);
const BASELINE_FILE_PATH_KEYS = ['file_path', 'filepath', 'path', 'fileName', 'file_name', 'target_path'];

export function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

function pickFilePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of BASELINE_FILE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isBaselineRealUserMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'user' || isInternalMessage(message)) return false;
  if (!Array.isArray(message.content)) return true;
  const blocks = message.content as Array<{ type?: string }>;
  return blocks.length === 0 || !blocks.every((block) => (
    block.type === 'tool_result' || block.type === 'toolResult'
  ));
}

function countBaselineRealUserMessages(messages: RawMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isBaselineRealUserMessage(message)) count += 1;
  }
  return count;
}

/** Build the stable baseline cache key for the current real user turn. */
export function getBaselineRunKeyForMessages(sessionKey: string, messages: RawMessage[]): string | null {
  return buildBaselineRunKey(sessionKey, countBaselineRealUserMessages(messages));
}

/** Capture pre-edit file baselines from streaming Write/Edit tool calls. */
export function captureBaselinesFromMessage(message: unknown, runKey: string | null): void {
  if (!runKey || !message || typeof message !== 'object') return;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_use' && block.type !== 'toolCall') continue;
    const name = typeof block.name === 'string' ? block.name : '';
    if (!name || (!BASELINE_WRITE_TOOLS.has(name) && !BASELINE_EDIT_TOOLS.has(name))) continue;
    const filePath = pickFilePathFromInput(block.input ?? block.arguments);
    if (filePath) captureBaseline(runKey, filePath);
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n');
}

function summarizeToolOutput(text: string): string | undefined {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const summary = lines.slice(0, 2).join(' / ');
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function normalizeToolStatus(rawStatus: unknown, fallback: 'running' | 'completed'): ToolStatus['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed' || status === 'success' || status === 'done') return 'completed';
  return fallback;
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolUseUpdates(message: unknown): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const updates: ToolStatus[] = [];
  if (Array.isArray(record.content)) {
    for (const block of record.content as ContentBlock[]) {
      if ((block.type !== 'tool_use' && block.type !== 'toolCall') || !block.name) continue;
      updates.push({
        id: block.id || block.name,
        toolCallId: block.id,
        name: block.name,
        status: 'running',
        updatedAt: Date.now(),
      });
    }
  }

  if (updates.length === 0) {
    const toolCalls = record.tool_calls ?? record.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
        const fn = (toolCall.function ?? toolCall) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const id = typeof toolCall.id === 'string' ? toolCall.id : name;
        updates.push({
          id,
          toolCallId: typeof toolCall.id === 'string' ? toolCall.id : undefined,
          name,
          status: 'running',
          updatedAt: Date.now(),
        });
      }
    }
  }
  return updates;
}

function extractToolResultBlocks(message: unknown, eventState: string): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const updates: ToolStatus[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    updates.push({
      id: block.id || block.name || 'tool',
      toolCallId: block.id,
      name: block.name || block.id || 'tool',
      status: normalizeToolStatus(undefined, eventState === 'delta' ? 'running' : 'completed'),
      summary: summarizeToolOutput(extractTextFromContent(block.content ?? block.text ?? '')),
      updatedAt: Date.now(),
    });
  }
  return updates;
}

function extractToolResultUpdate(message: unknown, eventState: string): ToolStatus | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
  if (!isToolResultRole(role)) return null;

  const toolName = typeof record.toolName === 'string'
    ? record.toolName
    : typeof record.name === 'string' ? record.name : '';
  const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
  const details = record.details && typeof record.details === 'object'
    ? record.details as Record<string, unknown>
    : undefined;
  const outputText = details && typeof details.aggregated === 'string'
    ? details.aggregated
    : extractTextFromContent(record.content);
  const name = toolName || toolCallId || 'tool';
  return {
    id: toolCallId || name,
    toolCallId,
    name,
    status: normalizeToolStatus(record.status ?? details?.status, eventState === 'delta' ? 'running' : 'completed'),
    durationMs: parseDurationMs(details?.durationMs ?? details?.duration ?? record.durationMs),
    summary: summarizeToolOutput(outputText) ?? summarizeToolOutput(String(details?.error ?? record.error ?? '')),
    updatedAt: Date.now(),
  };
}

function mergeToolStatus(existing: ToolStatus['status'], incoming: ToolStatus['status']): ToolStatus['status'] {
  const order: Record<ToolStatus['status'], number> = { running: 0, completed: 1, error: 2 };
  return order[incoming] >= order[existing] ? incoming : existing;
}

/** Merge tool status updates monotonically by tool-call identity. */
export function upsertToolStatuses(current: ToolStatus[], updates: ToolStatus[]): ToolStatus[] {
  if (updates.length === 0) return current;
  const next = [...current];
  for (const update of updates) {
    const key = update.toolCallId || update.id || update.name;
    if (!key) continue;
    const index = next.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
    if (index === -1) {
      next.push(update);
      continue;
    }
    const existing = next[index];
    next[index] = {
      ...existing,
      ...update,
      name: update.name || existing.name,
      status: mergeToolStatus(existing.status, update.status),
      durationMs: update.durationMs ?? existing.durationMs,
      summary: update.summary ?? existing.summary,
      updatedAt: update.updatedAt || existing.updatedAt,
    };
  }
  return next;
}

/** Normalize all supported tool call and result shapes from one chat event. */
export function collectToolUpdates(message: unknown, eventState: string): ToolStatus[] {
  const updates: ToolStatus[] = [];
  const toolResultUpdate = extractToolResultUpdate(message, eventState);
  if (toolResultUpdate) updates.push(toolResultUpdate);
  updates.push(...extractToolResultBlocks(message, eventState));
  updates.push(...extractToolUseUpdates(message));
  return updates;
}

/** Only an explicit chat.send RPC timeout is recoverable by history polling. */
export function isRecoverableChatSendTimeout(error: string): boolean {
  return error.includes('RPC timeout: chat.send');
}
