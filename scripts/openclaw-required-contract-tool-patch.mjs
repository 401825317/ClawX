import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_REQUIRED_TURN_CONTRACT_TOOL_V1';
const SOURCE_ANCHOR = 'const directoryRequiredToolNames = params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];';
const PATCHED_SOURCE = `const directoryRequiredToolNames = [
			...params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [],
			...effectiveTools.some((tool) => tool.name === "uclaw_declare_turn_contract") ? ["uclaw_declare_turn_contract"] : []
		]; // ${PATCH_MARKER}`;

export function patchOpenClawRequiredContractToolContent(content) {
  if (content.includes(PATCH_MARKER)) return { content, changed: false, matched: true };
  if (!content.includes(SOURCE_ANCHOR)) return { content, changed: false, matched: false };
  return {
    content: content.replace(SOURCE_ANCHOR, PATCHED_SOURCE),
    changed: true,
    matched: true,
  };
}

export function patchOpenClawRequiredContractToolRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-required-contract-tool-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  let targetFile;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchOpenClawRequiredContractToolContent(original);
    if (!patched.matched) continue;
    matchedFiles += 1;
    targetFile = filePath;
    if (patched.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, patched.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  if (matchedFiles !== 1) {
    throw new Error(`[openclaw-required-contract-tool-patch] Expected one directory-selection runtime; found ${matchedFiles}.`);
  }
  logger.log?.(`[openclaw-required-contract-tool-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`);
  return { matchedFiles, patchedFiles, alreadyPatchedFiles, targetFile };
}

export function patchInstalledOpenClawRequiredContractToolRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawRequiredContractToolRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
