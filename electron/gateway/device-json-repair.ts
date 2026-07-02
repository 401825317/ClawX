import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOpenClawConfigDir } from '../utils/paths';
import { logger } from '../utils/logger';

export type DeviceJsonRepairSummary = {
  checked: number;
  repairedBom: number;
  quarantined: number;
  failed: number;
};

const DEVICE_JSON_ALLOWLIST = new Set(['pending.json', 'paired.json']);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3
    && buffer[0] === UTF8_BOM[0]
    && buffer[1] === UTF8_BOM[1]
    && buffer[2] === UTF8_BOM[2];
}

function parseJsonBuffer(buffer: Buffer): unknown {
  return JSON.parse(buffer.toString('utf8'));
}

function quarantinePath(filePath: string): string {
  return `${filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function repairDeviceJsonFile(filePath: string, summary: DeviceJsonRepairSummary): void {
  summary.checked++;
  const original = readFileSync(filePath);
  const withoutBom = hasUtf8Bom(original) ? original.subarray(3) : original;

  try {
    parseJsonBuffer(withoutBom);
  } catch (error) {
    const target = quarantinePath(filePath);
    try {
      renameSync(filePath, target);
      summary.quarantined++;
      logger.warn(`[gateway] Quarantined invalid OpenClaw device JSON before launch: ${filePath} -> ${target}`, error);
    } catch (renameError) {
      summary.failed++;
      logger.warn(`[gateway] Failed to quarantine invalid OpenClaw device JSON: ${filePath}`, renameError);
    }
    return;
  }

  if (withoutBom !== original) {
    try {
      writeFileSync(filePath, withoutBom);
      summary.repairedBom++;
      logger.info(`[gateway] Removed UTF-8 BOM from OpenClaw device JSON before launch: ${filePath}`);
    } catch (error) {
      summary.failed++;
      logger.warn(`[gateway] Failed to remove UTF-8 BOM from OpenClaw device JSON: ${filePath}`, error);
    }
  }
}

/**
 * OpenClaw's Gateway JSON reader rejects UTF-8 BOM. Older/client-side writes or
 * external editors can leave BOMs in devices/pending.json and paired.json, which
 * makes every Gateway handshake fail until the file is removed manually.
 */
export function repairOpenClawDeviceJsonFiles(configDir = getOpenClawConfigDir()): DeviceJsonRepairSummary {
  const summary: DeviceJsonRepairSummary = {
    checked: 0,
    repairedBom: 0,
    quarantined: 0,
    failed: 0,
  };
  const devicesDir = join(configDir, 'devices');
  if (!existsSync(devicesDir)) {
    return summary;
  }

  let entries;
  try {
    entries = readdirSync(devicesDir, { withFileTypes: true });
  } catch (error) {
    summary.failed++;
    logger.warn(`[gateway] Failed to scan OpenClaw devices directory before launch: ${devicesDir}`, error);
    return summary;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !DEVICE_JSON_ALLOWLIST.has(entry.name)) continue;
    repairDeviceJsonFile(join(devicesDir, entry.name), summary);
  }

  return summary;
}
