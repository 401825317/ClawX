import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type ManagedTokenCostScope,
  type TokenUsageHistoryEntry,
} from './token-usage-core';
import { listConfiguredAgentIds } from './agent-config';
import { listProviderAccounts } from '../services/providers/provider-store';
import {
  enrichManagedTokenUsageCosts,
  getManagedTokenCostSnapshot,
  type ManagedTokenCostSnapshot,
} from '../services/managed-token-usage-cost-service';

const COST_ENRICHMENT_WAIT_MS = 2_500;

export {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from './token-usage-core';

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

async function listRecentSessionFiles(): Promise<Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }>> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');

  try {
    const agentEntries = await listAgentIdsWithSessionDirs();
    const files: Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }> = [];

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

async function listManagedTokenCostScopes(): Promise<ManagedTokenCostScope[]> {
  try {
    const accounts = await listProviderAccounts();
    return accounts.flatMap((account) => {
      const modelIds = account.metadata?.managedAllowedModels;
      if (account.metadata?.managedBy !== 'uclaw' || !Array.isArray(modelIds) || modelIds.length === 0) {
        return [];
      }

      return [{
        providerIds: [...new Set([account.id, account.vendorId])],
        modelIds: [...new Set(modelIds)],
      }];
    });
  } catch (error) {
    logger.debug('Failed to resolve managed token cost metadata:', error);
    return [];
  }
}

async function getManagedTokenCostSnapshotWithinDisplayBudget(): Promise<ManagedTokenCostSnapshot | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getManagedTokenCostSnapshot(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), COST_ENRICHMENT_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stripProviderRequestIds(entries: readonly TokenUsageHistoryEntry[]): TokenUsageHistoryEntry[] {
  return entries.map((entry) => {
    const { providerRequestId: _providerRequestId, ...publicEntry } = entry;
    return publicEntry;
  });
}

export async function getRecentTokenUsageHistory(limit?: number): Promise<TokenUsageHistoryEntry[]> {
  const [files, managedCostScopes] = await Promise.all([
    listRecentSessionFiles(),
    listManagedTokenCostScopes(),
  ]);
  const results: TokenUsageHistoryEntry[] = [];
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;

  for (const file of files) {
    if (results.length >= maxEntries) break;
    try {
      const content = await readFile(file.filePath, 'utf8');
      const entries = parseUsageEntriesFromJsonl(content, {
        sessionId: file.sessionId,
        agentId: file.agentId,
        managedCostScopes,
      }, Number.isFinite(maxEntries) ? maxEntries - results.length : undefined);
      results.push(...entries);
    } catch (error) {
      logger.debug(`Failed to read token usage transcript ${file.filePath}:`, error);
    }
  }

  results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const limitedResults = Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
  if (!limitedResults.some((entry) => entry.costUnavailable)) {
    return stripProviderRequestIds(limitedResults);
  }

  const snapshot = await getManagedTokenCostSnapshotWithinDisplayBudget();
  return stripProviderRequestIds(enrichManagedTokenUsageCosts(limitedResults, snapshot));
}
