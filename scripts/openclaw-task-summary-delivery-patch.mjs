import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_TASK_SUMMARY_DELIVERY';
const HANDLER_MARKER = `${PATCH_MARKER}_HANDLER_V2`;
const SCHEMA_MARKER = `${PATCH_MARKER}_SCHEMA_V2`;
const TYPE_MARKER = `${PATCH_MARKER}_TYPE_V2`;
const LEGACY_HANDLER_MARKER = `${PATCH_MARKER}_HANDLER`;
const LEGACY_SCHEMA_MARKER = `${PATCH_MARKER}_SCHEMA`;
const LEGACY_TYPE_MARKER = `${PATCH_MARKER}_TYPE`;

const HANDLER_HELPERS = `const UCLAW_TASK_SUMMARY_ARTIFACT_RE = /UCLAW_ARTIFACT_STATUS=(available|missing)(?:;UCLAW_ARTIFACTS=([A-Za-z0-9_-]+))?/u;
function isUclawTaskSummaryLocalArtifactPath(value) {
\tif (typeof value !== "string") return false;
\tconst normalized = value.trim();
\treturn /^[A-Za-z]:[\\\\/]/u.test(normalized) || normalized.startsWith("/") || normalized.startsWith("\\\\\\\\");
}
function parseUclawTaskSummaryArtifactContract(summary) {
\tif (typeof summary !== "string") return void 0;
\tconst match = summary.match(UCLAW_TASK_SUMMARY_ARTIFACT_RE);
\tif (!match) return void 0;
\tlet payload = {};
\tif (match[2]) try {
\t\tpayload = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
\t} catch {}
\tconst byPath = /* @__PURE__ */ new Map();
\tconst remember = (value, metadata = {}) => {
\t\tif (!isUclawTaskSummaryLocalArtifactPath(value)) return;
\t\tconst artifactPath = value.trim();
\t\tconst current = byPath.get(artifactPath) ?? { path: artifactPath };
\t\tconst mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType.trim().slice(0, 240) : "";
\t\tconst name = typeof metadata.name === "string" ? metadata.name.trim().slice(0, 240) : "";
\t\tbyPath.set(artifactPath, {
\t\t\t...current,
\t\t\t...mimeType ? { mimeType } : {},
\t\t\t...name ? { name } : {}
\t\t});
\t};
\tif (Array.isArray(payload.paths)) for (const artifactPath of payload.paths) remember(artifactPath);
\tif (Array.isArray(payload.attachments)) for (const attachment of payload.attachments) {
\t\tif (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
\t\tremember(attachment.path, attachment);
\t}
\treturn {
\t\tstatus: match[1],
\t\tartifacts: [...byPath.values()].slice(0, 64)
\t};
}`;

const HANDLER_ANCHOR = `\t\tstatus: TASK_STATUS_TO_LEDGER_STATUS[task.status],
\t\ttitle: formatTaskStatusTitle(task),`;

const HANDLER_PATCH = `\t\tstatus: TASK_STATUS_TO_LEDGER_STATUS[task.status],
\t\tdeliveryStatus: task.deliveryStatus, // ${HANDLER_MARKER}
\t\t...task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {},
\t\t...artifactContract ? {
\t\t\tartifactStatus: artifactContract.status,
\t\t\tartifacts: artifactContract.artifacts
\t\t} : {},
\t\ttitle: formatTaskStatusTitle(task),`;

const LEGACY_HANDLER_PATCH = `\t\tstatus: TASK_STATUS_TO_LEDGER_STATUS[task.status],
\t\tdeliveryStatus: task.deliveryStatus, // ${LEGACY_HANDLER_MARKER}
\t\t...task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {},
\t\ttitle: formatTaskStatusTitle(task),`;

const SCHEMA_ANCHOR = `\tstatus: TaskLedgerStatusSchema,
\ttitle: Type.Optional(Type.String()),`;

const SCHEMA_PATCH = `\tstatus: TaskLedgerStatusSchema,
\tdeliveryStatus: Type.Optional(Type.String()), // ${SCHEMA_MARKER}
\tterminalOutcome: Type.Optional(Type.String()),
\tartifactStatus: Type.Optional(Type.String()),
\tartifacts: Type.Optional(Type.Array(Type.Object({
\t\tpath: Type.String(),
\t\tmimeType: Type.Optional(Type.String()),
\t\tname: Type.Optional(Type.String())
\t}, { additionalProperties: false }))),
\ttitle: Type.Optional(Type.String()),`;

const LEGACY_SCHEMA_PATCH = `\tstatus: TaskLedgerStatusSchema,
\tdeliveryStatus: Type.Optional(Type.String()), // ${LEGACY_SCHEMA_MARKER}
\tterminalOutcome: Type.Optional(Type.String()),
\ttitle: Type.Optional(Type.String()),`;

const DECLARATION_STATUS_RE = /^(\s+)status: Type\.TUnion<\[Type\.TLiteral<"queued">, Type\.TLiteral<"running">, Type\.TLiteral<"completed">, Type\.TLiteral<"failed">, Type\.TLiteral<"cancelled">, Type\.TLiteral<"timed_out">\]>;\n(?:\1deliveryStatus: Type\.TOptional<Type\.TString>; \/\/ UCLAW_TASK_SUMMARY_DELIVERY_TYPE\n\1terminalOutcome: Type\.TOptional<Type\.TString>;\n)?\1title: Type\.TOptional<Type\.TString>;/gmu;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function patchHandlerContent(content, filePath) {
  if (!content.includes('function mapTaskSummary(task)')) return null;
  if (content.includes(HANDLER_MARKER)) return { content, changed: false, category: 'handler' };
  let next = content;
  const legacyCount = countOccurrences(next, LEGACY_HANDLER_PATCH);
  const unpatchedCount = countOccurrences(next, HANDLER_ANCHOR);
  if (legacyCount === 1) {
    next = next.replace(LEGACY_HANDLER_PATCH, HANDLER_PATCH);
  } else if (unpatchedCount === 1) {
    next = next.replace(HANDLER_ANCHOR, HANDLER_PATCH);
  } else {
    throw new Error(
      `[openclaw-task-summary-delivery-patch] Expected one task summary handler anchor in ${filePath}; `
      + `found legacy=${legacyCount} unpatched=${unpatchedCount}.`,
    );
  }
  next = next.replace(
    'function mapTaskSummary(task) {',
    `${HANDLER_HELPERS}\nfunction mapTaskSummary(task) {\n\tconst artifactContract = parseUclawTaskSummaryArtifactContract(task.terminalSummary);`,
  );
  return {
    content: next,
    changed: true,
    category: 'handler',
  };
}

function patchSchemaContent(content, filePath) {
  if (!content.includes('const TaskSummarySchema = Type.Object({')) return null;
  if (content.includes(SCHEMA_MARKER)) return { content, changed: false, category: 'schema' };
  const legacyCount = countOccurrences(content, LEGACY_SCHEMA_PATCH);
  const unpatchedCount = countOccurrences(content, SCHEMA_ANCHOR);
  if (legacyCount === 1) {
    return {
      content: content.replace(LEGACY_SCHEMA_PATCH, SCHEMA_PATCH),
      changed: true,
      category: 'schema',
    };
  }
  if (unpatchedCount !== 1) {
    throw new Error(
      `[openclaw-task-summary-delivery-patch] Expected one task summary schema anchor in ${filePath}; `
      + `found legacy=${legacyCount} unpatched=${unpatchedCount}.`,
    );
  }
  return {
    content: content.replace(SCHEMA_ANCHOR, SCHEMA_PATCH),
    changed: true,
    category: 'schema',
  };
}

function patchDeclarationContent(content, filePath) {
  if (!content.includes('Public task summary returned by task list/get/cancel responses.')) return null;
  if (!content.includes('TaskSummarySchema')) return null;
  if (content.includes(TYPE_MARKER)) return { content, changed: false, category: 'type' };
  let count = 0;
  const patched = content.replace(DECLARATION_STATUS_RE, (_match, indent) => {
    count += 1;
    return `${indent}status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;\n${indent}deliveryStatus: Type.TOptional<Type.TString>; // ${TYPE_MARKER}\n${indent}terminalOutcome: Type.TOptional<Type.TString>;\n${indent}artifactStatus: Type.TOptional<Type.TString>;\n${indent}artifacts: Type.TOptional<Type.TArray<Type.TObject<{\n${indent}  path: Type.TString;\n${indent}  mimeType: Type.TOptional<Type.TString>;\n${indent}  name: Type.TOptional<Type.TString>;\n${indent}}>>>;\n${indent}title: Type.TOptional<Type.TString>;`;
  });
  if (count < 1) {
    throw new Error(`[openclaw-task-summary-delivery-patch] Expected task summary declaration anchors in ${filePath}; found none.`);
  }
  return { content: patched, changed: true, category: 'type' };
}

export function patchOpenClawTaskSummaryDeliveryContent(content, filePath = '<fixture>') {
  return patchHandlerContent(content, filePath)
    ?? patchSchemaContent(content, filePath)
    ?? patchDeclarationContent(content, filePath)
    ?? { content, changed: false, category: null };
}

function walkFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const filePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(filePath));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) files.push(filePath);
  }
  return files;
}

export function patchOpenClawTaskSummaryDeliveryRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-task-summary-delivery-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const categoryCounts = new Map();
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  for (const filePath of walkFiles(distDir)) {
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawTaskSummaryDeliveryContent(content, filePath);
    if (!result.category) continue;
    categoryCounts.set(result.category, (categoryCounts.get(result.category) ?? 0) + 1);
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  const handlerCount = categoryCounts.get('handler') ?? 0;
  const schemaCount = categoryCounts.get('schema') ?? 0;
  const typeCount = categoryCounts.get('type') ?? 0;
  if (handlerCount !== 1 || schemaCount !== 1 || typeCount < 2) {
    throw new Error(
      `[openclaw-task-summary-delivery-patch] Expected handler=1 schema=1 types>=2 in ${distDir}; found handler=${handlerCount} schema=${schemaCount} types=${typeCount}.`,
    );
  }

  logger.log?.(
    `[openclaw-task-summary-delivery-patch] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); ${alreadyPatchedFiles} already patched.`,
  );
  return {
    patchedFiles,
    alreadyPatchedFiles,
    categoryCounts: Object.fromEntries(categoryCounts),
  };
}

export function patchInstalledOpenClawTaskSummaryDeliveryRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawTaskSummaryDeliveryRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
