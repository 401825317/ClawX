import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_RULES = [
  {
    id: 'sessions-create-schema',
    search: `\tmodel: Type.Optional(NonEmptyString),
\tparentSessionKey: Type.Optional(NonEmptyString),`,
    replace: `\tmodel: Type.Optional(NonEmptyString),
\tcwd: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tparentSessionKey: Type.Optional(NonEmptyString),`,
  },
  {
    id: 'sessions-patch-schema',
    search: `\tspawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tspawnedCwd: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),`,
    replace: `\tcwd: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tspawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tspawnedCwd: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),`,
  },
  {
    id: 'sessions-patch-projection',
    search: `\tif (existing && !existing.sessionId) {
\t\tdelete next.label;
\t\tdelete next.category;
\t\tdelete next.displayName;
\t}
\tconst checkSpawnLineage = (field) => supportsSpawnLineage(storeKey) ? null : invalid(\`\${field} is only supported for subagent:* or acp:* sessions\`);`,
    replace: `\tif (existing && !existing.sessionId) {
\t\tdelete next.label;
\t\tdelete next.category;
\t\tdelete next.displayName;
\t}
\tif ("cwd" in patch) {
\t\tconst raw = patch.cwd;
\t\tif (raw === null) delete next.cwd;
\t\telse if (raw !== void 0) {
\t\t\tconst trimmed = normalizeOptionalString(raw) ?? "";
\t\t\tif (!trimmed) return invalid("invalid cwd: empty");
\t\t\tnext.cwd = trimmed;
\t\t}
\t}
\tconst checkSpawnLineage = (field) => supportsSpawnLineage(storeKey) ? null : invalid(\`\${field} is only supported for subagent:* or acp:* sessions\`);`,
  },
  {
    id: 'sessions-create-handler-cwd',
    search: `\t\t\tlabel: p.label,
\t\t\tmodel: p.model,
\t\t\tparentSessionKey: p.parentSessionKey,
\t\t\tspawnedCwd: sessionCwd,`,
    replace: `\t\t\tlabel: p.label,
\t\t\tmodel: p.model,
\t\t\tcwd: p.cwd,
\t\t\tparentSessionKey: p.parentSessionKey,
\t\t\tspawnedCwd: sessionCwd,`,
  },
  {
    id: 'sessions-create-cwd-projection',
    search: `\t\t\t\tpatch: {
\t\t\t\t\tkey: target.canonicalKey,
\t\t\t\t\tlabel: normalizeOptionalString(params.label),
\t\t\t\t\tmodel: normalizeOptionalString(params.model)
\t\t\t\t},`,
    replace: `\t\t\t\tpatch: {
\t\t\t\t\tkey: target.canonicalKey,
\t\t\t\t\tlabel: normalizeOptionalString(params.label),
\t\t\t\t\tmodel: normalizeOptionalString(params.model),
\t\t\t\t\tcwd: params.cwd
\t\t\t\t},`,
  },
  {
    id: 'sessions-list-cwd-projection',
    search: `\treturn {
\t\tkey,
\t\tspawnedBy: subagentOwner || entry?.spawnedBy,`,
    replace: `\treturn {
\t\tkey,
\t\tcwd: entry?.cwd,
\t\tspawnedBy: subagentOwner || entry?.spawnedBy,`,
  },
  {
    id: 'gateway-agent-runtime-cwd',
    search: `function resolveSessionRuntimeCwd(params) {
\treturn normalizeOptionalString(params.requestedCwd ?? params.sessionEntry?.spawnedCwd);
}`,
    replace: `function resolveSessionRuntimeCwd(params) {
\treturn normalizeOptionalString(params.requestedCwd) ?? normalizeOptionalString(params.sessionEntry?.cwd) ?? normalizeOptionalString(params.sessionEntry?.spawnedCwd);
}`,
  },
  {
    id: 'agent-command-runtime-cwd',
    search: `\tconst cwd = normalizeOptionalString(opts.cwd) ?? normalizeOptionalString(sessionEntryRaw?.spawnedCwd);`,
    replace: `\tconst cwd = normalizeOptionalString(opts.cwd) ?? normalizeOptionalString(sessionEntryRaw?.cwd) ?? normalizeOptionalString(sessionEntryRaw?.spawnedCwd);`,
  },
  {
    id: 'reply-agent-runtime-cwd',
    search: `\t\t\tcwd: normalizeOptionalString(sessionEntry?.spawnedCwd),`,
    replace: `\t\t\tcwd: normalizeOptionalString(sessionEntry?.cwd) ?? normalizeOptionalString(sessionEntry?.spawnedCwd),`,
  },
  {
    id: 'reply-session-state-preserve-cwd',
    search: `\t\tlabel: persistedLabel ?? baseEntry?.label,
\t\tspawnedBy: persistedSpawnedBy ?? baseEntry?.spawnedBy,`,
    replace: `\t\tlabel: persistedLabel ?? baseEntry?.label,
\t\tcwd: entry?.cwd ?? baseEntry?.cwd,
\t\tspawnedBy: persistedSpawnedBy ?? baseEntry?.spawnedBy,`,
  },
  {
    id: 'embedded-system-prompt-runtime-cwd',
    search: `\t\t\tembeddedSystemPrompt: {
\t\t\t\tconfig: params.config,
\t\t\t\tagentId: sessionAgentId,
\t\t\t\tworkspaceDir: effectiveWorkspace,
\t\t\t\tdefaultThinkLevel: params.thinkLevel,`,
    replace: `\t\t\tembeddedSystemPrompt: {
\t\t\t\tconfig: params.config,
\t\t\t\tagentId: sessionAgentId,
\t\t\t\tworkspaceDir: effectiveCwd,
\t\t\t\tdefaultThinkLevel: params.thinkLevel,`,
  },
  {
    id: 'system-prompt-report-runtime-cwd',
    search: `\t\t\tprovider: params.provider,
\t\t\tmodel: params.modelId,
\t\t\tworkspaceDir: effectiveWorkspace,
\t\t\tbootstrapMaxChars,`,
    replace: `\t\t\tprovider: params.provider,
\t\t\tmodel: params.modelId,
\t\t\tworkspaceDir: effectiveCwd,
\t\t\tbootstrapMaxChars,`,
  },
  {
    id: 'session-compact-runtime-cwd',
    search: `\t\t\t\t\t\t\tcwd: normalizeOptionalString(latestEntry.spawnedCwd),`,
    replace: `\t\t\t\t\t\t\tcwd: normalizeOptionalString(latestEntry.cwd) ?? normalizeOptionalString(latestEntry.spawnedCwd),`,
  },
  {
    id: 'session-entry-reserved-cwd',
    search: `\t"sessionFile",
\t"spawnedBy",
\t"spawnedWorkspaceDir",`,
    replace: `\t"sessionFile",
\t"cwd",
\t"spawnedBy",
\t"spawnedWorkspaceDir",`,
  },
];

function patchOpenClawSessionCwdContent(content) {
  let next = content;
  const matchedRules = [];
  const changedRules = [];

  for (const rule of PATCH_RULES) {
    if (next.includes(rule.replace)) {
      matchedRules.push(rule.id);
      continue;
    }
    if (!next.includes(rule.search)) continue;

    matchedRules.push(rule.id);
    changedRules.push(rule.id);
    next = next.replace(rule.search, rule.replace);
  }

  return {
    content: next,
    changed: next !== content,
    matchedRules,
    changedRules,
  };
}

export function patchOpenClawSessionCwdRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir, matchedRules: [] };

  const matchedRuleIds = new Set();
  const pendingWrites = [];

  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchOpenClawSessionCwdContent(original);
    for (const ruleId of patched.matchedRules) matchedRuleIds.add(ruleId);
    if (!patched.changed) continue;
    pendingWrites.push({ file, filePath, patched });
  }

  const missingRules = PATCH_RULES.filter((rule) => !matchedRuleIds.has(rule.id)).map((rule) => rule.id);
  if (missingRules.length > 0) {
    throw new Error(
      `[openclaw-session-cwd-runtime-patch] OpenClaw runtime anchors not found: ${missingRules.join(', ')}`,
    );
  }

  for (const pending of pendingWrites) {
    writeFileSync(pending.filePath, pending.patched.content, 'utf8');
    logger.log?.(
      `[openclaw-session-cwd-runtime-patch] Patched ${pending.file}: ${pending.patched.changedRules.join(', ')}`,
    );
  }

  const patchedFiles = pendingWrites.length;
  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-session-cwd-runtime-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return {
    patchedFiles,
    distDir,
    matchedRules: [...matchedRuleIds],
  };
}

export function patchInstalledOpenClawSessionCwdRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawSessionCwdRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
