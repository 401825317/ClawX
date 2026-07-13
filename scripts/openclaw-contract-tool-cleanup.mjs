import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_REQUIRED_TURN_CONTRACT_TOOL_V1';
const ORIGINAL_SOURCE = 'const directoryRequiredToolNames = params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];';
const PATCHED_SOURCE = `const directoryRequiredToolNames = [
			...params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [],
			...effectiveTools.some((tool) => tool.name === "uclaw_declare_turn_contract") ? ["uclaw_declare_turn_contract"] : []
		]; // ${PATCH_MARKER}`;

export function removeOpenClawRequiredContractToolContent(content) {
  if (content.includes(PATCHED_SOURCE)) {
    return { content: content.replace(PATCHED_SOURCE, ORIGINAL_SOURCE), changed: true, matched: true };
  }
  return { content, changed: false, matched: content.includes(ORIGINAL_SOURCE) };
}

export function cleanupOpenClawRequiredContractToolRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[openclaw-contract-tool-cleanup] OpenClaw dist directory not found: ${distDir}`);

  let matchedFiles = 0;
  let cleanedFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const original = readFileSync(filePath, 'utf8');
    const cleaned = removeOpenClawRequiredContractToolContent(original);
    if (!cleaned.matched) continue;
    matchedFiles += 1;
    if (!cleaned.changed) continue;
    cleanedFiles += 1;
    if (!dryRun) writeFileSync(filePath, cleaned.content, 'utf8');
  }

  if (matchedFiles !== 1) {
    throw new Error(`[openclaw-contract-tool-cleanup] Expected one directory-selection runtime; found ${matchedFiles}.`);
  }
  logger.log?.(`[openclaw-contract-tool-cleanup] ${dryRun ? 'Dry-run matched' : 'Cleaned'} ${cleanedFiles} file(s).`);
  return { matchedFiles, cleanedFiles };
}

export function cleanupInstalledOpenClawRequiredContractToolRuntime(cwd = process.cwd(), options = {}) {
  return cleanupOpenClawRequiredContractToolRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
