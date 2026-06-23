import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from './token-usage-core';
import { listConfiguredAgentIds } from './agent-config';

export {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from './token-usage-core';

const TOKEN_USAGE_CACHE_TTL_MS = 15_000;
const TOKEN_USAGE_TRANSCRIPT_TAIL_BYTES = 512 * 1024;

let usageHistoryCache:
  | { limitKey: number; createdAt: number; entries: TokenUsageHistoryEntry[] }
  | null = null;
const usageHistoryInFlight = new Map<number, Promise<TokenUsageHistoryEntry[]>>();

async function listAgentIdsWithSessionDirs(): Promise<string[]> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');
  const agentIds = new Set<string>();

  try {
    for (const agentId of await listConfiguredAgentIds()) {
      const normalized = agentId.trim();
      if (normalized) {
        agentIds.add(normalized);
      }
    }
  } catch {
    // Ignore config discovery failures and fall back to disk scan.
  }

  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isDirectory()) {
        const normalized = entry.name.trim();
        if (normalized) {
          agentIds.add(normalized);
        }
      }
    }
  } catch {
    // Ignore disk discovery failures and return whatever we already found.
  }

  return [...agentIds];
}

async function listRecentSessionFiles(): Promise<Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number; size: number }>> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');

  try {
    const agentEntries = await listAgentIdsWithSessionDirs();
    const files: Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number; size: number }> = [];

    for (const agentId of agentEntries) {
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      try {
        const sessionEntries = await readdir(sessionsDir);

        for (const fileName of sessionEntries) {
          const sessionId = extractSessionIdFromTranscriptFileName(fileName);
          if (!sessionId) continue;
          const filePath = join(sessionsDir, fileName);
          try {
            const fileStat = await stat(filePath);
            files.push({
              filePath,
              sessionId,
              agentId,
              mtimeMs: fileStat.mtimeMs,
              size: fileStat.size,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

async function readTranscriptTail(filePath: string, size: number): Promise<string> {
  if (size <= 0) return '';

  const readBytes = Math.min(size, TOKEN_USAGE_TRANSCRIPT_TAIL_BYTES);
  const readStart = Math.max(0, size - readBytes);
  const handle = await open(filePath, 'r');

  try {
    const buffer = Buffer.allocUnsafe(readBytes);
    const { bytesRead } = await handle.read(buffer, 0, readBytes, readStart);
    let text = buffer.subarray(0, bytesRead).toString('utf8');

    if (readStart > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    return text;
  } finally {
    await handle.close();
  }
}

async function scanRecentTokenUsageHistory(limit?: number): Promise<TokenUsageHistoryEntry[]> {
  const files = await listRecentSessionFiles();
  const results: TokenUsageHistoryEntry[] = [];
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;

  for (const file of files) {
    if (results.length >= maxEntries) break;
    try {
      const content = await readTranscriptTail(file.filePath, file.size);
      const entries = parseUsageEntriesFromJsonl(content, {
        sessionId: file.sessionId,
        agentId: file.agentId,
      }, Number.isFinite(maxEntries) ? maxEntries - results.length : undefined);
      results.push(...entries);
    } catch (error) {
      logger.debug(`Failed to read token usage transcript ${file.filePath}:`, error);
    }
  }

  results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
}

export async function getRecentTokenUsageHistory(limit?: number): Promise<TokenUsageHistoryEntry[]> {
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;
  const limitKey = Number.isFinite(maxEntries) ? maxEntries : -1;
  const now = Date.now();

  if (
    usageHistoryCache
    && usageHistoryCache.limitKey === limitKey
    && now - usageHistoryCache.createdAt < TOKEN_USAGE_CACHE_TTL_MS
  ) {
    return usageHistoryCache.entries.map((entry) => ({ ...entry }));
  }

  const existing = usageHistoryInFlight.get(limitKey);
  if (existing) {
    return (await existing).map((entry) => ({ ...entry }));
  }

  const scanPromise = scanRecentTokenUsageHistory(limit);
  usageHistoryInFlight.set(limitKey, scanPromise);

  try {
    const entries = await scanPromise;
    usageHistoryCache = {
      limitKey,
      createdAt: Date.now(),
      entries: entries.map((entry) => ({ ...entry })),
    };
    return entries;
  } finally {
    usageHistoryInFlight.delete(limitKey);
  }
}
