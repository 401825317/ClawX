import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, realpath as realpathAsync, rename, rm, stat as statAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const PLUGIN_ID = 'uclaw-artifact-guard';
const REVISION_ID = `${PLUGIN_ID}:artifact-delivery`;
const PROMPT_CONTEXT_HOOK_ID = `${PLUGIN_ID}:prompt-history-maintenance`;
const MEDIA_TOOL_PREPARATION_HOOK_ID = `${PLUGIN_ID}:media-tool-preparation`;
const RUNTIME_EVENT_SOURCE = PLUGIN_ID;
let runtimeEventSeq = 0;
const TURN_PREFERENCES_TIMEOUT_MS = 1_200;
const TURN_PREFERENCES_CACHE_TTL_MS = 5 * 60 * 1000;
const TURN_PREFERENCES_CACHE_MAX_ENTRIES = 256;
const turnPreferencesByRunId = new Map();
const mediaInputStagePromises = new Map();
const MEDIA_SIDE_EFFECT_TOOLS = new Set(['image_generate', 'video_generate', 'create_blender_scene', 'repair_blender_scene']);
const NATIVE_MEDIA_GENERATION_TOOLS = new Set(['image_generate', 'video_generate']);
const NATIVE_MEDIA_PROMPT_MAX_CHARACTERS = 4_096;
const VIDEO_MODEL_PLANNING_CONTEXT = [
  'For video generation, select the provider model explicitly from the active video capability list and the current request inputs; call video_generate action:list when the compatible candidate is unclear.',
  'Do not treat a UI default model as a routing decision. Respect user-requested size and duration when they are supplied as tool constraints.',
  'For configured UClaw Grok candidates, use grok-image-video for text-only video and use grok-video-1.5 only with exactly one managed reference image. Never send grok-video-1.5 without that image.',
  'For a requested final video, create a uclaw_video_project before generation. Use one shot when one generated clip satisfies the brief; plan multiple shots only when the requested duration or creative structure requires them. Record every video_generate result, run deterministic shot QA plus semantic review before accepting a shot. When every required multi-shot clip is accepted, call uclaw_video_project action:compose exactly once; do not manually start a separate final Host task or deliver an intermediate clip.',
].join(' ');
const HIDDEN_PROGRESS_TOOLS = new Set([
  'tool_describe',
  'tool_search',
  'update_plan',
  'uclaw_get_runtime_capabilities',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
]);
const ASYNC_PROGRESS_STARTED_STATUSES = new Set([
  'accepted',
  'pending',
  'queued',
  'running',
  'started',
  'submitted',
]);
const SAFE_MEDIA_TOOL_ACTIONS = new Set(['list', 'status', 'get', 'inspect', 'describe', 'models', 'model', 'info', 'help']);
const MEDIA_INPUT_PARAM_KEYS = new Set(['image', 'images', 'mask', 'video', 'videos']);
const IMAGE_INPUT_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/iu;
const VIDEO_INPUT_EXT_RE = /\.(?:mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu;
const RUN_TOOL_EVIDENCE_TTL_MS = 30 * 60 * 1000;
const RUN_TOOL_EVIDENCE_MAX_ENTRIES = 256;
const toolEvidenceByRunId = new Map();
const PROGRESS_WRAPPER_TTL_MS = 30 * 60 * 1000;
const PROGRESS_WRAPPER_MAX_ENTRIES = 512;
const progressWrappersByParentToolCallId = new Map();

const HEARTBEAT_POLL_RE = /^\s*\[OpenClaw heartbeat poll\]\s*$/iu;
const HEARTBEAT_OK_RE = /^\s*HEARTBEAT_OK\s*$/iu;
const INTERNAL_SENTINEL_RE = /^\s*(?:HEARTBEAT_OK|NO_REPLY)\s*$/iu;
const GATEWAY_RESTART_CONTINUATION_RE = /\[System\]\s+Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool\/model work\. Continue from the existing transcript and finish the interrupted response\./iu;
const GATEWAY_RESTART_CONTINUATION_BLOCK_RE = /\n{0,2}\[System\]\s+Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool\/model work\. Continue from the existing transcript and finish the interrupted response\.(?:\n\nNote:\s+The interrupted final reply was captured:\s+"[^"]*")?/giu;
const GATEWAY_RESTART_CAPTURED_REPLY_NOTE_RE = /^\s*Note:\s+The interrupted final reply was captured:\s+"[^"]*"\s*$/giu;
const QUEUED_USER_MESSAGE_MARKER_RE = /^\s*\[Queued user message that arrived while the previous turn was still active\]\s*\n?/iu;
const RUNTIME_EVENT_CONTINUATION_RE = /^Continue the OpenClaw runtime event\.?\s*$/iu;
const ARTIFACT_EXT = 'pptx?|docx?|xlsx?|pdf|csv|tsv|md|html?|json|zip|png|jpe?g|webp|svg|txt|py|js|ts|tsx|jsx|css|mp4|mov|webm|blend|glb|gltf|obj|fbx';
const MEDIA_ARTIFACT_PATH_RE = new RegExp(`MEDIA:\\s*((?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_PATH_RE = new RegExp(`((?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_URL_RE = new RegExp(`(https?://[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_FIELD_RE = /(?:filePath|outputPath|output_path|mediaUrl|media_url|url|path|out)["']?\s*:\s*["']([^"']+)["']/giu;
const PRODUCER_TOOL_RE = /(?:^|[_-])(?:create|write|edit|generate|export|render|save|screenshot|capture|record)(?:$|[_-])|(?:pptx|docx|xlsx|pdf|image|video|artifact|media)/iu;
const GENERATED_ARTIFACT_CUE_RE = /(?:MEDIA:|filePath|outputPath|artifact|saved|wrote|created|generated|exported|rendered|已生成|已保存|已导出|已创建|写入|产物)/iu;
const TOOL_ERROR_STATUS_RE = /^(?:error|failed|failure|blocked)$/iu;
const SCREENSHOT_COMMAND_RE = /(?:screencapture|gnome-screenshot|scrot|grim|spectacle|import\s+-window\s+root|xwd|desktop[_-]?screenshot|screen\s*capture|screenshot|截图|截屏)/iu;
const TMP_SCREENSHOT_MEDIA_PATH_RE = /\/tmp\/((?:uclaw|clawx|desktop|screen|screenshot)[A-Za-z0-9._ -]*\.(?:png|jpe?g|webp|bmp))/giu;
const TRANSCRIPT_BLOAT_TOOL_RE = /^(?:exec|exec_command|shell|bash|terminal|run_command|read)$/iu;
const TRANSCRIPT_PATH_BOUNDARY = String.raw`(?=$|[?#\s"'},\]])`;
const TRANSCRIPT_BLOAT_SESSION_RE = new RegExp(
  String.raw`(?:^|[\\/])sessions?(?:[\\/]|$)|\.jsonl${TRANSCRIPT_PATH_BOUNDARY}|(?:^|[\\/])transcripts?(?:[\\/]|$)`,
  'iu',
);
const TRANSCRIPT_BLOAT_TRAJECTORY_RE = new RegExp(
  String.raw`(?:^|[\\/])trajectory(?:[\\/]|$)|\.trajectory(?:-path)?(?:\.jsonl|\.json)?${TRANSCRIPT_PATH_BOUNDARY}|\btrajectory(?:-path)?\b`,
  'iu',
);
const TRANSCRIPT_BLOAT_LOG_RE = new RegExp(
  String.raw`(?:^|[\\/])logs?(?:[\\/]|$)|\.log${TRANSCRIPT_PATH_BOUNDARY}`,
  'iu',
);
const TRANSCRIPT_BLOAT_MIN_CHARS = 1600;
const TRANSCRIPT_BLOAT_MIN_LINES = 36;
const TRANSCRIPT_BLOAT_EXTREME_CHARS = 5000;
const TRANSCRIPT_BLOAT_EXTREME_LINES = 120;
const TRANSCRIPT_BLOAT_MAX_HINTS = 3;
const TRANSCRIPT_BLOAT_MAX_ARTIFACT_REFS = 4;
const TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS = 8_000;
const TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS = 4_000;
function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.name === 'string' && part.type === 'toolCall') return `[tool:${part.name}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [extractTextFromContent(message.content)];
  for (const key of ['text', 'output', 'result']) {
    if (typeof message[key] === 'string') parts.push(message[key]);
  }
  if (message.details && typeof message.details === 'object') {
    try {
      parts.push(JSON.stringify(message.details));
    } catch {
      // ignore
    }
  }
  return parts.filter(Boolean).join('\n');
}

function extractAssistantVisibleText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const content = message.content;
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') parts.push(part.text);
        else if (typeof part.content === 'string') parts.push(part.content);
      }
    }
  }
  for (const key of ['text', 'output', 'result']) {
    if (typeof message[key] === 'string') parts.push(message[key]);
  }
  return parts.filter(Boolean).join('\n');
}

function extractMessageLists(event) {
  return [
    event?.messages,
    event?.messagesSnapshot,
    event?.finalMessages,
    event?.transcript,
    event?.conversation,
  ].filter(Array.isArray);
}

function latestUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && message.role === 'user') {
      return index;
    }
  }
  return -1;
}

function extractLatestUserRequestText(event) {
  const direct = [
    event?.userMessage,
    event?.userText,
    event?.prompt,
    event?.finalPromptText,
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n');
  if (direct.trim()) return direct;

  for (const messages of extractMessageLists(event)) {
    const index = latestUserMessageIndex(messages);
    if (index >= 0) {
      const text = extractMessageText(messages[index]);
      if (text.trim()) return text;
    }
  }
  return '';
}

function extractFinalAssistantText(event) {
  const direct = [event?.finalText, event?.assistantText, event?.lastAssistantMessage]
    .filter((value) => typeof value === 'string')
    .join('\n');
  if (direct.trim()) return direct;

  for (const messages of extractMessageLists(event)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && typeof message === 'object' && message.role === 'assistant') {
        // The newest assistant item is authoritative even when it is empty.
        // Falling back to an earlier tool-call-only assistant makes an empty
        // provider final look deliverable and bypasses the recovery revision.
        return extractAssistantVisibleText(message);
      }
    }
  }
  return '';
}

function eventId(event, ctx) {
  return [
    event?.runId,
    ctx?.runId,
    event?.sessionId,
    ctx?.sessionId,
    event?.sessionKey,
    ctx?.sessionKey,
    event?.messageId,
  ].filter((value) => typeof value === 'string' && value.trim()).join('|') || 'unknown';
}

function logDiagnostic(label, payload) {
  try {
    console.warn(`[uclaw-artifact-guard] ${label} ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`[uclaw-artifact-guard] ${label}`);
  }
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeHostApiOrigin() {
  const origin = normalizeOptionalString(process.env.CLAWX_HOST_API_ORIGIN);
  return origin ? origin.replace(/\/+$/, '') : undefined;
}

function pruneTurnPreferences(now = Date.now()) {
  for (const [runId, entry] of turnPreferencesByRunId) {
    if (entry.expiresAt <= now) turnPreferencesByRunId.delete(runId);
  }
  while (turnPreferencesByRunId.size > TURN_PREFERENCES_CACHE_MAX_ENTRIES) {
    const oldestRunId = turnPreferencesByRunId.keys().next().value;
    if (!oldestRunId) return;
    turnPreferencesByRunId.delete(oldestRunId);
  }
}

function cacheTurnPreferences(event, ctx, preferences) {
  const runId = getRunId(event, ctx);
  if (!runId || !isPlainRecord(preferences)) return;
  const now = Date.now();
  pruneTurnPreferences(now);
  turnPreferencesByRunId.set(runId, {
    preferences,
    expiresAt: now + TURN_PREFERENCES_CACHE_TTL_MS,
  });
  pruneTurnPreferences(now);
}

function getTurnPreferences(event, ctx) {
  pruneTurnPreferences();
  const runId = getRunId(event, ctx);
  return runId ? turnPreferencesByRunId.get(runId)?.preferences : undefined;
}

async function requestTurnPreferencesFromHost(event, ctx) {
  const sessionKey = getSessionKey(event, ctx);
  const message = extractLatestUserRequestText(event).trim();
  const origin = normalizeHostApiOrigin();
  const token = normalizeOptionalString(process.env.CLAWX_HOST_API_TOKEN);
  if (!sessionKey || !message || !origin || !token || typeof fetch !== 'function') return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_PREFERENCES_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/runtime/turn-preferences/consume`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionKey, message }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return isPlainRecord(payload?.preferences) ? payload.preferences : undefined;
  } catch (error) {
    logDiagnostic('turn-preferences-unavailable', {
      eventId: eventId(event, ctx),
      reason: error?.name === 'AbortError' ? 'host_api_timeout' : 'host_api_exception',
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function buildTurnPreferenceSystemContext(preferences) {
  if (!isPlainRecord(preferences)) return '';
  const mode = preferences.mode === 'image' || preferences.mode === 'video'
    ? preferences.mode
    : undefined;
  if (!mode) return '';

  const media = isPlainRecord(preferences[mode]) ? preferences[mode] : {};
  const constraints = [];
  for (const key of mode === 'image'
    ? ['model', 'size', 'quality']
    : ['size', 'durationSeconds']) {
    const value = media[key];
    if (typeof value === 'string' && value.trim()) constraints.push(`${key}=${value.trim()}`);
    else if (typeof value === 'number' && Number.isFinite(value)) constraints.push(`${key}=${value}`);
  }
  const selectedArtifactCount = Array.isArray(preferences.selectedArtifacts)
    ? preferences.selectedArtifacts.length
    : 0;
  if (selectedArtifactCount > 0) constraints.push(`selectedArtifacts=${selectedArtifactCount}`);

  const executionInstruction = mode === 'image'
    ? 'Produce a real image artifact by calling image_generate. Do not answer with only a description or promise.'
    : 'Produce a real video artifact by calling video_generate after any required uclaw_video_project setup. Do not answer with only a description or promise.';
  return [
    `The UClaw client explicitly selected ${mode} mode for this turn. Treat this UI mode as explicit current-turn user intent, not as an optional hint.`,
    executionInstruction,
    constraints.length > 0 ? `Apply these UI constraints unless the user explicitly overrides them in the message: ${constraints.join(', ')}.` : '',
    'If the requested media cannot be produced, report the concrete capability or tool failure only after a real tool attempt or capability check.',
  ].filter(Boolean).join(' ');
}

function normalizeToolName(event) {
  const direct = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name)
    ?? '';
  let resolved = direct;
  if (direct.trim().toLowerCase() === 'tool_call') {
    const params = normalizeToolParams(event);
    resolved = [params.id, params.toolName, params.tool_name, params.name]
      .find((value) => typeof value === 'string' && value.trim())?.trim()
      ?? direct;
    if (resolved === direct) {
      const envelope = parseProgressRecord(event?.result);
      const delegated = isPlainRecord(envelope?.result) ? envelope.result : envelope;
      const tool = isPlainRecord(envelope?.tool)
        ? envelope.tool
        : isPlainRecord(delegated?.tool)
          ? delegated.tool
          : undefined;
      resolved = [tool?.name, tool?.id, tool?.toolName, tool?.tool_name]
        .find((value) => typeof value === 'string' && value.trim())?.trim()
        ?? resolved;
    }
  }
  return resolved.includes(':') ? resolved.split(':').at(-1) ?? resolved : resolved;
}

function normalizeDirectToolName(event) {
  const direct = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name)
    ?? '';
  const normalized = direct.includes(':') ? direct.split(':').at(-1) ?? direct : direct;
  return normalized.trim().toLowerCase();
}

function normalizeToolParams(event) {
  if (isPlainRecord(event?.params)) return event.params;
  if (isPlainRecord(event?.input)) return event.input;
  if (isPlainRecord(event?.args)) return event.args;
  return {};
}

function normalizeEffectiveToolParams(event) {
  const params = normalizeToolParams(event);
  const directName = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name);
  if (directName?.trim().toLowerCase() !== 'tool_call') return params;
  return [params.args, params.arguments, params.params, params.input]
    .map((value) => isPlainRecord(value) ? value : null)
    .find(Boolean)
    ?? params;
}

function normalizeToolAction(params) {
  const raw = normalizeOptionalString(params?.action)
    ?? normalizeOptionalString(params?.mode)
    ?? normalizeOptionalString(params?.operation);
  return raw ? raw.toLowerCase() : '';
}

function isSafeMediaToolReadAction(params) {
  const action = normalizeToolAction(params);
  return Boolean(action && SAFE_MEDIA_TOOL_ACTIONS.has(action));
}

function resolveOpenClawHomeForPlugin() {
  const explicitHome = normalizeOptionalString(process.env.OPENCLAW_HOME);
  if (!explicitHome) return homedir();
  if (explicitHome === '~' || explicitHome.startsWith('~/') || explicitHome.startsWith('~\\')) {
    return resolve(explicitHome.replace(/^~(?=$|[\\/])/, homedir()));
  }
  return resolve(explicitHome);
}

function expandOpenClawPathForPlugin(value) {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(value.replace(/^~(?=$|[\\/])/, resolveOpenClawHomeForPlugin()));
  }
  return value;
}

function resolveOpenClawConfigDirForPlugin() {
  const explicitStateDir = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR);
  if (explicitStateDir) return resolve(expandOpenClawPathForPlugin(explicitStateDir));
  const explicitConfigPath = normalizeOptionalString(process.env.OPENCLAW_CONFIG_PATH)
    ?? normalizeOptionalString(process.env.OPENCLAW_CONFIG);
  if (explicitConfigPath) return dirname(resolve(expandOpenClawPathForPlugin(explicitConfigPath)));
  return join(resolveOpenClawHomeForPlugin(), '.openclaw');
}

function resolveManagedScreenshotDir() {
  return join(resolveOpenClawConfigDirForPlugin(), 'media', 'outbound');
}

function isRemoteOrManagedMediaRef(value) {
  return /^(?:https?:|data:|blob:|media:)/iu.test(String(value ?? '').trim());
}

function mediaInputExtensionAllowed(paramKey, filePath) {
  if (paramKey === 'video' || paramKey === 'videos') return VIDEO_INPUT_EXT_RE.test(filePath);
  return IMAGE_INPUT_EXT_RE.test(filePath);
}

function resolveLocalMediaInputPath(value) {
  const input = normalizeOptionalString(value);
  if (!input || isRemoteOrManagedMediaRef(input)) return undefined;
  const expanded = expandOpenClawPathForPlugin(input);
  if (!isAbsolute(expanded) && !expanded.startsWith('./') && !expanded.startsWith('../')) return undefined;
  return resolve(expanded);
}

async function stageMediaInputFile({ sourceValue, paramKey, runDir }) {
  const resolvedSource = resolveLocalMediaInputPath(sourceValue);
  if (!resolvedSource || !mediaInputExtensionAllowed(paramKey, resolvedSource)) return undefined;

  let sourcePath;
  let sourceStat;
  try {
    sourcePath = await realpathAsync(resolvedSource);
    sourceStat = await statAsync(sourcePath);
  } catch {
    return undefined;
  }
  if (!sourceStat.isFile()) return undefined;
  const relativeToRunDir = relative(runDir, sourcePath);
  if (!relativeToRunDir || (!relativeToRunDir.startsWith('..') && !isAbsolute(relativeToRunDir))) {
    return sourcePath;
  }

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const extension = extname(sourcePath).toLowerCase();
  const fingerprint = hashString(`${sourcePath}:${sourceStat.size}:${sourceStat.mtimeMs}`);
  const stagedPath = join(runDir, `${fingerprint}${extension}`);
  const stageKey = `${stagedPath}:${sourceStat.size}:${sourceStat.mtimeMs}`;
  const existingStage = mediaInputStagePromises.get(stageKey);
  if (existingStage) return await existingStage;
  const stagePromise = stageMediaInputFileOnce({ sourcePath, sourceStat, stagedPath });
  mediaInputStagePromises.set(stageKey, stagePromise);
  try {
    return await stagePromise;
  } finally {
    if (mediaInputStagePromises.get(stageKey) === stagePromise) {
      mediaInputStagePromises.delete(stageKey);
    }
  }
}

async function stageMediaInputFileOnce({ sourcePath, sourceStat, stagedPath }) {
  let stagedStat;
  try {
    stagedStat = await statAsync(stagedPath);
  } catch {
    stagedStat = undefined;
  }
  if (!stagedStat?.isFile() || stagedStat.size !== sourceStat.size) {
    const tempPath = `${stagedPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await copyFile(sourcePath, tempPath);
      const tempStat = await statAsync(tempPath);
      if (!tempStat.isFile() || tempStat.size !== sourceStat.size) {
        throw new Error('staged media temporary copy verification failed');
      }
      await rename(tempPath, stagedPath);
    } catch (error) {
      try {
        stagedStat = await statAsync(stagedPath);
      } catch {
        stagedStat = undefined;
      }
      if (!stagedStat?.isFile() || stagedStat.size !== sourceStat.size) {
        throw error;
      }
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    stagedStat = await statAsync(stagedPath);
  }
  if (!stagedStat.isFile() || stagedStat.size !== sourceStat.size) {
    throw new Error('staged media verification failed');
  }
  return stagedPath;
}

async function stageMediaToolInputs(event, ctx) {
  const toolName = normalizeToolName(event);
  const params = normalizeToolParams(event);
  if (!MEDIA_SIDE_EFFECT_TOOLS.has(toolName) || isSafeMediaToolReadAction(params)) {
    return { params, stagedCount: 0, stagedParamKeys: [] };
  }

  const runId = getRunId(event, ctx);
  if (!runId) return { params, stagedCount: 0, stagedParamKeys: [] };
  const runDir = join(resolveManagedScreenshotDir(), 'uclaw-runs', hashString(runId));
  const nextParams = { ...params };
  const stagedBySource = new Map();
  const stagedParamKeys = new Set();
  let stagedCount = 0;

  try {
    for (const paramKey of MEDIA_INPUT_PARAM_KEYS) {
      const rawValue = params[paramKey];
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      let changed = false;
      const nextValues = [];
      for (const value of values) {
        if (typeof value !== 'string') {
          nextValues.push(value);
          continue;
        }
        let stagedPath = stagedBySource.get(`${paramKey}:${value}`);
        if (!stagedPath) {
          stagedPath = await stageMediaInputFile({ sourceValue: value, paramKey, runDir });
          if (stagedPath) stagedBySource.set(`${paramKey}:${value}`, stagedPath);
        }
        if (stagedPath) {
          nextValues.push(stagedPath);
          changed = changed || stagedPath !== value;
          stagedCount += stagedPath !== value ? 1 : 0;
        } else {
          nextValues.push(value);
        }
      }
      if (!changed) continue;
      nextParams[paramKey] = Array.isArray(rawValue) ? nextValues : nextValues[0];
      stagedParamKeys.add(paramKey);
    }
  } catch (error) {
    return {
      params,
      stagedCount: 0,
      stagedParamKeys: [],
      blockReason: '参考媒体无法安全复制到当前运行的受控目录，已阻止本次媒体生成。',
      errorCode: normalizeOptionalString(error?.code) ?? 'stage_failed',
    };
  }

  return {
    params: nextParams,
    stagedCount,
    stagedParamKeys: [...stagedParamKeys],
  };
}

function commandParamKey(params) {
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof params?.[key] === 'string' && params[key].trim()) return key;
  }
  return undefined;
}

function rewriteTmpScreenshotMediaPaths(command) {
  const original = String(command ?? '');
  if (!SCREENSHOT_COMMAND_RE.test(original)) return null;

  const managedScreenshotDir = resolveManagedScreenshotDir();
  const rewrittenPaths = [];
  const rewritten = original.replace(TMP_SCREENSHOT_MEDIA_PATH_RE, (match, fileName) => {
    const replacement = join(managedScreenshotDir, fileName);
    if (replacement !== match) {
      rewrittenPaths.push({ from: match, to: replacement });
    }
    return replacement;
  });
  if (rewrittenPaths.length === 0 || rewritten === original) return null;

  return {
    command: `mkdir -p ${managedScreenshotDir} && ${rewritten}`,
    rewrittenPaths,
  };
}

function rewriteExecScreenshotParams(event) {
  const toolName = normalizeToolName(event);
  if (!/^(?:exec|exec_command|shell|bash|terminal|run_command)$/iu.test(toolName)) return null;
  const params = normalizeToolParams(event);
  const key = commandParamKey(params);
  if (!key) return null;
  const rewrite = rewriteTmpScreenshotMediaPaths(params[key]);
  if (!rewrite) return null;
  return {
    params: {
      ...params,
      [key]: rewrite.command,
    },
    rewrittenPaths: rewrite.rewrittenPaths,
    commandKey: key,
    toolName,
  };
}

function isHeartbeatPoll(text) {
  resetRegex(HEARTBEAT_POLL_RE);
  return HEARTBEAT_POLL_RE.test(String(text ?? ''));
}

function isHeartbeatOk(text) {
  resetRegex(HEARTBEAT_OK_RE);
  return HEARTBEAT_OK_RE.test(String(text ?? ''));
}

function isOpenClawRuntimeEventPromptText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  resetRegex(RUNTIME_EVENT_CONTINUATION_RE);
  if (RUNTIME_EVENT_CONTINUATION_RE.test(normalized)) return true;
  return normalized.split(/\n+/u).some((line) => {
    resetRegex(RUNTIME_EVENT_CONTINUATION_RE);
    return RUNTIME_EVENT_CONTINUATION_RE.test(line.trim());
  });
}

function isRuntimeSystemInjectionText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  if (/^\s*System\s*\(untrusted\)\s*:/iu.test(normalized)) return true;
  if (
    /An async command you ran earlier has completed/iu.test(normalized)
    && /Do not relay it to the user unless explicitly requested/iu.test(normalized)
  ) {
    return true;
  }
  if (/^\[Inter-session message\]/iu.test(normalized)) return true;
  if (isOpenClawRuntimeEventPromptText(normalized)) return true;
  if (
    /^\s*Current time\s*:/iu.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/iu.test(normalized)
  ) {
    return true;
  }
  return false;
}

function classifyInternalTranscriptMessage(message) {
  if (!isPlainRecord(message)) return undefined;
  const role = String(message.role ?? '').toLowerCase();
  const text = extractMessageText(message);
  const normalized = text.trim();
  if (!normalized) return undefined;

  resetRegex(INTERNAL_SENTINEL_RE);
  if (INTERNAL_SENTINEL_RE.test(normalized)) return 'internal_sentinel';
  if (role === 'user' && isHeartbeatPoll(normalized)) return 'heartbeat_poll_user';
  if ((role === 'toolresult' || role === 'tool_result' || role === 'tool') && isHeartbeatPoll(normalized)) {
    return 'heartbeat_poll_tool_result';
  }
  if ((role === 'user' || role === 'system') && GATEWAY_RESTART_CONTINUATION_RE.test(normalized)) {
    return 'gateway_restart_continuation';
  }
  if ((role === 'user' || role === 'assistant' || role === 'system') && isRuntimeSystemInjectionText(normalized)) {
    return 'runtime_system_injection';
  }
  return undefined;
}

function stripGatewayRestartContinuationText(value) {
  const original = String(value ?? '');
  const cleaned = original
    .replace(GATEWAY_RESTART_CONTINUATION_BLOCK_RE, '')
    .replace(GATEWAY_RESTART_CAPTURED_REPLY_NOTE_RE, '')
    .replace(QUEUED_USER_MESSAGE_MARKER_RE, '')
    .trim();
  return {
    text: cleaned,
    changed: cleaned !== original.trim(),
  };
}

function rewriteMessageText(message, transform) {
  if (!isPlainRecord(message)) return message;
  let changed = false;
  const next = { ...message };

  if (typeof message.text === 'string') {
    const rewritten = transform(message.text);
    if (rewritten !== message.text) {
      next.text = rewritten;
      changed = true;
    }
  }

  if (typeof message.content === 'string') {
    const rewritten = transform(message.content);
    if (rewritten !== message.content) {
      next.content = rewritten;
      changed = true;
    }
  } else if (Array.isArray(message.content)) {
    const content = [];
    for (const part of message.content) {
      if (typeof part === 'string') {
        const rewritten = transform(part);
        if (rewritten !== part) changed = true;
        if (rewritten) content.push(rewritten);
        continue;
      }
      if (!isPlainRecord(part)) {
        content.push(part);
        continue;
      }
      let nextPart = part;
      if (typeof part.text === 'string') {
        const rewritten = transform(part.text);
        if (rewritten !== part.text) {
          nextPart = { ...nextPart, text: rewritten };
          changed = true;
        }
      }
      if (typeof part.content === 'string') {
        const rewritten = transform(part.content);
        if (rewritten !== part.content) {
          nextPart = { ...nextPart, content: rewritten };
          changed = true;
        }
      }
      const textOnlyPart = ['text', 'input_text', 'output_text'].includes(String(nextPart.type ?? '').toLowerCase());
      const textValues = [nextPart.text, nextPart.content].filter((value) => typeof value === 'string');
      if (textOnlyPart && textValues.length > 0 && textValues.every((value) => !value.trim())) continue;
      content.push(nextPart);
    }
    if (changed) next.content = content;
  }

  return changed ? next : message;
}

function sanitizeInternalTranscriptMessage(message) {
  if (!isPlainRecord(message)) return { action: 'keep', message };
  const role = String(message.role ?? '').toLowerCase();
  const originalText = extractMessageText(message).trim();
  if (!originalText) return { action: 'keep', message };

  resetRegex(GATEWAY_RESTART_CONTINUATION_RE);
  if ((role === 'user' || role === 'system') && GATEWAY_RESTART_CONTINUATION_RE.test(originalText)) {
    const rewritten = rewriteMessageText(message, (value) => stripGatewayRestartContinuationText(value).text);
    if (extractMessageText(rewritten).trim()) {
      return { action: 'rewrite', message: rewritten, reason: 'gateway_restart_continuation_suffix' };
    }
    return { action: 'block', message, reason: 'gateway_restart_continuation' };
  }

  const reason = classifyInternalTranscriptMessage(message);
  if (reason) return { action: 'block', message, reason };
  return { action: 'keep', message };
}

function sanitizePromptHistoryMessages(event) {
  const result = { blocked: 0, rewritten: 0, reasons: {} };
  const visited = new Set();
  for (const messages of extractMessageLists(event)) {
    if (visited.has(messages)) continue;
    visited.add(messages);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const decision = sanitizeInternalTranscriptMessage(messages[index]);
      if (decision.action === 'keep') continue;
      const reason = decision.reason ?? 'internal_runtime_message';
      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      if (decision.action === 'block') {
        messages.splice(index, 1);
        result.blocked += 1;
      } else {
        messages[index] = decision.message;
        result.rewritten += 1;
      }
    }
  }
  return result;
}

const DESIGNED_PRESENTATION_TOOL_RE = /(?:^|:)(?:create_designed_pptx_file|repair_designed_pptx_file)$/iu;

function compactPresentationInvocationArgs(toolName, rawArgs) {
  const wasString = typeof rawArgs === 'string';
  let args = rawArgs;
  if (wasString) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return { value: rawArgs, omittedChars: 0 };
    }
  }
  if (!isPlainRecord(args)) return { value: rawArgs, omittedChars: 0 };

  const directoryTarget = String(args.id ?? '');
  const effectiveToolName = DESIGNED_PRESENTATION_TOOL_RE.test(directoryTarget)
    ? directoryTarget
    : String(toolName ?? '');
  if (!DESIGNED_PRESENTATION_TOOL_RE.test(effectiveToolName)) {
    return { value: rawArgs, omittedChars: 0 };
  }

  const payload = isPlainRecord(args.args) ? args.args : args;
  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  const patches = Array.isArray(payload.patches) ? payload.patches : [];
  if (slides.length === 0 && patches.length === 0) return { value: rawArgs, omittedChars: 0 };

  const compactPayload = { ...payload };
  delete compactPayload.slides;
  delete compactPayload.patches;
  compactPayload.summarizedForModel = true;
  compactPayload.summaryKind = 'designed_presentation_invocation';
  if (slides.length > 0) {
    compactPayload.slideCount = slides.length;
    compactPayload.elementCount = slides.reduce(
      (count, slide) => count + (Array.isArray(slide?.elements) ? slide.elements.length : 0),
      0,
    );
  }
  if (patches.length > 0) compactPayload.patchCount = patches.length;

  const compactArgs = payload === args ? compactPayload : { ...args, args: compactPayload };
  const serialized = JSON.stringify(compactArgs);
  const omittedChars = Math.max(0, JSON.stringify(args).length - serialized.length);
  return { value: wasString ? serialized : compactArgs, omittedChars };
}

function tryAssignCompactToolArg(target, key, value) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor && descriptor.set == null && descriptor.writable === false) return false;
    target[key] = value;
    return true;
  } catch {
    return false;
  }
}

function compactHistoricalPresentationToolCalls(event) {
  const result = { compacted: 0, omittedChars: 0 };
  const visited = new Set();
  for (const messages of extractMessageLists(event)) {
    if (visited.has(messages)) continue;
    visited.add(messages);
    const latestUserIndex = latestUserMessageIndex(messages);
    const latestUserText = latestUserIndex >= 0 ? extractMessageText(messages[latestUserIndex]).trim() : '';
    const promptText = String(event?.prompt ?? '').trim();
    const currentPromptAlreadyInMessages = Boolean(
      latestUserText
      && promptText
      && (latestUserText === promptText || promptText.includes(latestUserText)),
    );
    const isFinalizeRevision = /Before accepting the previous final answer|UClaw artifact delivery final reply/iu.test(promptText);
    const historyEnd = latestUserIndex < 0
      ? messages.length
      : (currentPromptAlreadyInMessages || isFinalizeRevision ? latestUserIndex : messages.length);
    for (let index = 0; index < historyEnd; index += 1) {
      const message = messages[index];
      if (!isPlainRecord(message) || String(message.role ?? '').toLowerCase() !== 'assistant') continue;
      const containers = [];
      if (Array.isArray(message.content)) containers.push(...message.content.filter(isPlainRecord));
      const topLevelCalls = Array.isArray(message.tool_calls) ? message.tool_calls : message.toolCalls;
      if (Array.isArray(topLevelCalls)) containers.push(...topLevelCalls.filter(isPlainRecord));
      for (const container of containers) {
        const fn = isPlainRecord(container.function) ? container.function : container;
        const toolName = String(fn.name ?? container.name ?? '');
        for (const key of ['arguments', 'input']) {
          if (!(key in fn)) continue;
          const compacted = compactPresentationInvocationArgs(toolName, fn[key]);
          if (compacted.omittedChars <= 0) continue;
          if (!tryAssignCompactToolArg(fn, key, compacted.value)) continue;
          result.compacted += 1;
          result.omittedChars += compacted.omittedChars;
        }
      }
    }
  }
  return result;
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function truncateText(value, maxChars = 240) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function resetRegex(regex) {
  regex.lastIndex = 0;
  return regex;
}

function stringifyJson(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function parseJsonRecordText(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^[{[]/u.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function appendStructuredResultText(parts, result) {
  if (!isRecord(result)) return;
  for (const key of ['filePath', 'outputPath', 'output_path', 'path', 'out', 'url', 'mediaUrl', 'media_url']) {
    if (typeof result[key] === 'string') parts.push(`${key}: "${result[key]}"`);
  }
  for (const key of ['artifact', 'artifacts', 'output', 'outputs', 'files', 'media']) {
    const rendered = stringifyJson(result[key]);
    if (rendered) parts.push(rendered);
  }
}

function appendPossiblyJsonText(parts, value) {
  const parsed = parseJsonRecordText(value);
  if (parsed) appendStructuredResultText(parts, parsed);
  else parts.push(value);
}

function stripArtifactRef(value) {
  return String(value ?? '')
    .trim()
    .replace(/^MEDIA:\s*/iu, '')
    .replace(/^[("'`]+/u, '')
    .replace(/[)"'`，,。；;：:\]}]+$/u, '')
    .trim();
}

function isUrlRef(value) {
  return /^https?:\/\//iu.test(value);
}

function normalizeLocalPath(value, cwd) {
  if (!value || isUrlRef(value)) return undefined;
  if (value.startsWith('~/')) return `${homedir()}${value.slice(1)}`;
  if (value.startsWith('./') || value.startsWith('../')) {
    return resolve(typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd(), value);
  }
  return value;
}

function canonicalLocalPath(value, cwd) {
  const normalized = normalizeLocalPath(stripArtifactRef(value), cwd);
  if (!normalized) return undefined;
  const absolute = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd(), normalized);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function artifactRefDedupeKey(value, cwd) {
  const stripped = stripArtifactRef(value);
  if (isUrlRef(stripped)) {
    try {
      const url = new URL(stripped);
      url.hash = '';
      return url.toString();
    } catch {
      return stripped;
    }
  }
  return (canonicalLocalPath(stripped, cwd) ?? stripped).replace(/\\/gu, '/');
}

function inferArtifactKind(ref) {
  const clean = ref.toLowerCase().split('?')[0] ?? ref.toLowerCase();
  if (/\.(png|jpe?g|webp|svg)$/iu.test(clean)) return 'image';
  if (/\.(mp4|mov|webm)$/iu.test(clean)) return 'video';
  if (/\.(blend|glb|gltf|obj|fbx)$/iu.test(clean)) return 'model3d';
  if (/\.pdf$/iu.test(clean)) return 'pdf';
  if (/\.(xlsx?|csv|tsv)$/iu.test(clean)) return 'spreadsheet';
  if (/\.pptx?$/iu.test(clean)) return 'presentation';
  if (/\.(docx?|md|txt)$/iu.test(clean)) return 'document';
  if (/\.html?$/iu.test(clean)) return 'webpage';
  if (/\.(js|ts|tsx|jsx|css|py|json)$/iu.test(clean)) return 'code';
  if (/\.zip$/iu.test(clean)) return 'archive';
  return 'file';
}

function inferMimeType(ref) {
  const clean = ref.toLowerCase().split('?')[0] ?? ref.toLowerCase();
  if (/\.png$/iu.test(clean)) return 'image/png';
  if (/\.jpe?g$/iu.test(clean)) return 'image/jpeg';
  if (/\.webp$/iu.test(clean)) return 'image/webp';
  if (/\.svg$/iu.test(clean)) return 'image/svg+xml';
  if (/\.mp4$/iu.test(clean)) return 'video/mp4';
  if (/\.webm$/iu.test(clean)) return 'video/webm';
  if (/\.blend$/iu.test(clean)) return 'application/x-blender';
  if (/\.glb$/iu.test(clean)) return 'model/gltf-binary';
  if (/\.gltf$/iu.test(clean)) return 'model/gltf+json';
  if (/\.obj$/iu.test(clean)) return 'model/obj';
  if (/\.fbx$/iu.test(clean)) return 'model/fbx';
  if (/\.pdf$/iu.test(clean)) return 'application/pdf';
  if (/\.pptx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (/\.docx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.xlsx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.csv$/iu.test(clean)) return 'text/csv';
  if (/\.html?$/iu.test(clean)) return 'text/html';
  if (/\.json$/iu.test(clean)) return 'application/json';
  return undefined;
}

function artifactTitle(ref) {
  try {
    const withoutQuery = ref.split('?')[0] ?? ref;
    return basename(withoutQuery) || undefined;
  } catch {
    return undefined;
  }
}

function verificationForArtifact(artifact, localPath) {
  const base = {
    kind: 'artifact.availability',
    required: true,
    source: RUNTIME_EVENT_SOURCE,
  };
  if (!localPath) {
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'blocked',
      severity: 'blocking',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '最终回复引用了产物，但无法解析为本地文件路径。',
      targetId: artifact.id,
      artifactId: artifact.id,
    };
  }

  try {
    if (!existsSync(localPath)) {
      return {
        ...base,
        id: `verification:${artifact.id}:availability`,
        status: 'blocked',
        severity: 'blocking',
        title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
        detail: '最终回复引用了产物路径，但本地文件不可访问。',
        targetId: artifact.id,
        artifactId: artifact.id,
        evidence: localPath,
      };
    }

    const stat = statSync(localPath);
    if (!stat.isFile()) {
      return {
        ...base,
        id: `verification:${artifact.id}:availability`,
        status: 'blocked',
        severity: 'blocking',
        title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
        detail: '本地产物路径不是普通文件。',
        targetId: artifact.id,
        artifactId: artifact.id,
        evidence: localPath,
      };
    }
    if (stat.size <= 0) {
      return {
        ...base,
        id: `verification:${artifact.id}:availability`,
        status: 'blocked',
        severity: 'blocking',
        title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
        detail: '本地产物文件为空。',
        targetId: artifact.id,
        artifactId: artifact.id,
        evidence: localPath,
      };
    }
    accessSync(localPath, fsConstants.R_OK);
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'passed',
      severity: 'info',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '本地产物是可读、非空的普通文件。',
      targetId: artifact.id,
      artifactId: artifact.id,
      evidence: `stat ok; sizeBytes=${stat.size}`,
    };
  } catch (error) {
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'blocked',
      severity: 'blocking',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '本地产物存在性验证失败。',
      targetId: artifact.id,
      artifactId: artifact.id,
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectRefsWithRegex(text, regex) {
  const refs = [];
  for (const match of text.matchAll(resetRegex(regex))) {
    const ref = stripArtifactRef(match[1] ?? match[0]);
    if (ref) refs.push(ref);
  }
  return refs;
}

function collectArtifactRefsFromText(text, options = {}) {
  const allowRawPaths = options.allowRawPaths !== false;
  const structuredRefs = [
    ...collectRefsWithRegex(text, MEDIA_ARTIFACT_PATH_RE),
    ...collectRefsWithRegex(text, ARTIFACT_URL_RE),
    ...collectRefsWithRegex(text, ARTIFACT_FIELD_RE),
  ];
  const rawPathText = [MEDIA_ARTIFACT_PATH_RE, ARTIFACT_URL_RE, ARTIFACT_FIELD_RE].reduce(
    (result, regex) => result.replace(resetRegex(regex), ' '),
    text,
  );
  return [
    ...structuredRefs,
    ...(allowRawPaths ? collectRefsWithRegex(rawPathText, ARTIFACT_PATH_RE) : []),
  ];
}

function extractArtifactRefs(event, finalText, options = {}) {
  const refs = [
    ...collectArtifactRefsFromText(finalText, options),
    ...extractMessageLists(event)
      .flatMap((messages) => messages)
      .flatMap((message) => collectArtifactRefsFromText(extractMessageText(message), options)),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = artifactRefDedupeKey(ref, event?.cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildArtifactEvidence(event, finalText, options = {}) {
  return extractArtifactRefs(event, finalText, options)
    .filter((ref) => !isUrlRef(ref))
    .map((ref) => {
    const filePath = canonicalLocalPath(ref, event?.cwd);
    const idSource = filePath ?? ref;
    const artifact = {
      id: `artifact:${hashString(idSource)}`,
      kind: inferArtifactKind(ref),
      title: artifactTitle(ref),
      filePath,
      mimeType: inferMimeType(ref),
      source: RUNTIME_EVENT_SOURCE,
    };
    const verification = verificationForArtifact(artifact, filePath);
    if (verification.status === 'passed' && filePath) {
      const sizeMatch = /sizeBytes=(\d+)/u.exec(verification.evidence ?? '');
      artifact.sizeBytes = sizeMatch ? Number(sizeMatch[1]) : undefined;
    }
    return {
      ref,
      artifact,
      verification,
    };
    });
}

function extractToolResultText(result, depth = 0, seen = new Set()) {
  if (depth > 4 || result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (seen.has(result)) return '';
    seen.add(result);
  }
  const parts = [];
  appendStructuredResultText(parts, result);
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (typeof part === 'string') {
        appendPossiblyJsonText(parts, part);
      } else if (isRecord(part)) {
        if (typeof part.text === 'string') appendPossiblyJsonText(parts, part.text);
        if (typeof part.content === 'string') appendPossiblyJsonText(parts, part.content);
        if (typeof part.url === 'string') parts.push(part.url);
        if (typeof part.filePath === 'string') parts.push(`filePath: "${part.filePath}"`);
        if (typeof part.outputPath === 'string') parts.push(`outputPath: "${part.outputPath}"`);
      }
    }
  }
  parts.push(stringifyJson(result?.details));
  if (isRecord(result?.result)) parts.push(extractToolResultText(result.result, depth + 1, seen));
  if (isRecord(result?.meta)) parts.push(extractToolResultText(result.meta, depth + 1, seen));
  return parts.filter(Boolean).join('\n');
}

function extractPrimaryToolResultText(result) {
  if (typeof result === 'string') return result;
  if (!isRecord(result)) return '';

  const parts = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (typeof part === 'string') parts.push(part);
      else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
    }
  }
  if (parts.length > 0) return parts.filter(Boolean).join('\n');

  for (const key of ['text', 'output', 'stdout']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key];
  }
  return '';
}

function countTextLines(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  return text.split(/\r?\n/u).length;
}

function collectTranscriptBloatKinds(text) {
  const normalized = String(text ?? '');
  const kinds = [];
  if (TRANSCRIPT_BLOAT_SESSION_RE.test(normalized)) kinds.push('session/jsonl');
  if (TRANSCRIPT_BLOAT_TRAJECTORY_RE.test(normalized)) kinds.push('trajectory');
  if (TRANSCRIPT_BLOAT_LOG_RE.test(normalized)) kinds.push('log');
  return kinds;
}

function collectTranscriptBloatHints(value, hints = [], seen = new Set(), depth = 0) {
  if (depth > 2 || value === null || value === undefined) return hints;
  if (typeof value === 'string') {
    const normalized = truncateText(value, 180);
    if (
      normalized
      && (TRANSCRIPT_BLOAT_SESSION_RE.test(normalized)
        || TRANSCRIPT_BLOAT_TRAJECTORY_RE.test(normalized)
        || TRANSCRIPT_BLOAT_LOG_RE.test(normalized)
        || /(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)/u.test(normalized))
    ) {
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hints.push(normalized);
      }
    }
    return hints;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectTranscriptBloatHints(item, hints, seen, depth + 1);
      if (hints.length >= TRANSCRIPT_BLOAT_MAX_HINTS) break;
    }
    return hints;
  }
  if (!isRecord(value)) return hints;
  const interestingKeys = [
    'args',
    'params',
    'result',
    'command',
    'cmd',
    'script',
    'path',
    'filePath',
    'outputPath',
    'output_path',
    'url',
    'mediaUrl',
    'media_url',
    'out',
    'file',
    'target',
    'source',
    'message',
    'error',
    'reason',
    'stdout',
    'stderr',
    'text',
    'content',
  ];
  for (const key of interestingKeys) {
    if (!(key in value)) continue;
    collectTranscriptBloatHints(value[key], hints, seen, depth + 1);
    if (hints.length >= TRANSCRIPT_BLOAT_MAX_HINTS) break;
  }
  return hints;
}

function collectStructuredArtifactRefsForTranscript(text) {
  const rawPathText = [MEDIA_ARTIFACT_PATH_RE, ARTIFACT_URL_RE, ARTIFACT_FIELD_RE].reduce(
    (result, regex) => result.replace(resetRegex(regex), ' '),
    text,
  );
  const refs = [
    ...collectRefsWithRegex(text, MEDIA_ARTIFACT_PATH_RE).map((ref) => `MEDIA:${ref}`),
    ...collectRefsWithRegex(text, ARTIFACT_URL_RE),
    ...collectRefsWithRegex(text, ARTIFACT_FIELD_RE),
    ...collectRefsWithRegex(rawPathText, ARTIFACT_PATH_RE),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const normalizedRef = stripArtifactRef(ref);
    if (!normalizedRef) return false;
    if (inferArtifactKind(normalizedRef) === 'file') return false;
    const key = artifactRefDedupeKey(normalizedRef);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TRANSCRIPT_BLOAT_MAX_ARTIFACT_REFS);
}

function buildTranscriptBloatSummary(meta) {
  const header = `已收敛高膨胀 ${meta.toolName || 'tool'} 结果（${meta.kinds.join(' / ') || '大块工具输出'}，${meta.lineCount} 行 / ${meta.charCount} 字符），模型可见 transcript 仅保留摘要。`;
  const lines = [header];
  if (meta.failure) lines.push(`结果摘要：${meta.failure}`);
  if (meta.hints.length > 0) lines.push(`目标线索：${meta.hints.join(' | ')}`);
  if (meta.artifactRefs.length > 0) lines.push(`保留产物证据：${meta.artifactRefs.join(' | ')}`);
  if (meta.excerpt) {
    lines.push('以下保留原始结果的首尾摘录，供当前任务继续判断：');
    lines.push(meta.excerpt);
  }
  lines.push('原始大段输出已省略；如需逐行排查，请继续针对目标文件或日志做 read / rg。');
  return lines.join('\n');
}

function buildLargeOutputExcerpt(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  const limit = TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS + TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS;
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS);
  const tail = normalized.slice(-TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS);
  return `${head}\n\n... 已省略中间 ${normalized.length - limit} 个字符 ...\n\n${tail}`;
}

function compactToolResultDetailsForTranscript(rawDetails, meta) {
  const compact = {};
  if (isRecord(rawDetails)) {
    for (const key of ['status', 'ok', 'message', 'error', 'reason', 'filePath', 'outputPath', 'output_path', 'url', 'mediaUrl', 'media_url', 'out']) {
      const value = rawDetails[key];
      if (typeof value === 'string' && value.trim()) compact[key] = truncateText(value, 240);
      else if (typeof value === 'boolean' || typeof value === 'number') compact[key] = value;
    }
  }
  compact.summarizedForModel = true;
  compact.summaryKind = 'tool_result_transcript_compaction';
  compact.omittedChars = meta.charCount;
  compact.omittedLines = meta.lineCount;
  compact.categories = meta.kinds;
  if (meta.hints.length > 0) compact.hints = meta.hints;
  if (meta.artifactRefs.length > 0) compact.preservedArtifactRefs = meta.artifactRefs;
  return compact;
}

function compactToolResultContentForTranscript(content, summaryText) {
  const preservedParts = Array.isArray(content)
    ? content
      .filter((part) => isRecord(part) && (
        typeof part.url === 'string'
        || typeof part.filePath === 'string'
        || typeof part.outputPath === 'string'
        || typeof part.mediaUrl === 'string'
      ))
      .map((part) => {
        const compact = {};
        for (const key of ['type', 'url', 'filePath', 'outputPath', 'mediaUrl', 'mimeType', 'title', 'name']) {
          if (typeof part[key] === 'string' && part[key].trim()) compact[key] = part[key];
        }
        return Object.keys(compact).length > 0 ? compact : undefined;
      })
      .filter(Boolean)
    : [];
  return [
    { type: 'text', text: summaryText },
    ...preservedParts,
  ];
}

function cloneJsonCompatible(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (Array.isArray(value)) return value.map((item) => cloneJsonCompatible(item));
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      next[key] = cloneJsonCompatible(nestedValue);
    }
    return next;
  }
}

function summarizeToolResultForTranscript(event) {
  const toolName = normalizeToolName(event).toLowerCase();
  if (!toolName || !TRANSCRIPT_BLOAT_TOOL_RE.test(toolName)) return undefined;

  const resultText = extractToolResultText(event?.result);
  const charCount = resultText.length;
  const lineCount = countTextLines(resultText);
  if (!resultText.trim()) return undefined;

  // Classify from the invocation target only. Source code and configuration
  // output commonly contain words such as sessionKey, stdout, or console;
  // treating result text as a path signal discards the evidence the model just
  // requested and can leave the following model turn with no usable context.
  const classificationText = [
    stringifyJson(event?.args),
    stringifyJson(event?.params),
  ].filter(Boolean).join('\n');
  const kinds = collectTranscriptBloatKinds(classificationText);
  const hasTargetKind = kinds.length > 0;
  const tooLarge = charCount >= TRANSCRIPT_BLOAT_MIN_CHARS || lineCount >= TRANSCRIPT_BLOAT_MIN_LINES;
  const extremelyLarge = charCount >= TRANSCRIPT_BLOAT_EXTREME_CHARS || lineCount >= TRANSCRIPT_BLOAT_EXTREME_LINES;
  if (!(tooLarge && hasTargetKind) && !extremelyLarge) return undefined;

  const hints = collectTranscriptBloatHints({
    args: event?.args,
    params: event?.params,
    result: event?.result,
  }).slice(0, TRANSCRIPT_BLOAT_MAX_HINTS);
  const artifactRefs = hasTargetKind
    ? collectStructuredArtifactRefsForTranscript(resultText)
    : [];
  const failure = summarizeToolFailure(event);
  const excerpt = hasTargetKind
    ? ''
    : buildLargeOutputExcerpt(extractPrimaryToolResultText(event?.result) || resultText);
  const summaryText = buildTranscriptBloatSummary({
    toolName,
    kinds: hasTargetKind ? kinds : ['large-output'],
    charCount,
    lineCount,
    hints,
    artifactRefs,
    failure,
    excerpt,
  });

  if (typeof event?.result === 'string') {
    return {
      summaryText,
      result: summaryText,
      meta: {
        toolName,
        kinds: hasTargetKind ? kinds : ['large-output'],
        charCount,
        lineCount,
        hints,
        artifactRefs,
      },
    };
  }

  const nextResult = isRecord(event?.result) ? cloneJsonCompatible(event.result) : {};
  nextResult.content = compactToolResultContentForTranscript(nextResult.content, summaryText);
  nextResult.details = compactToolResultDetailsForTranscript(nextResult.details, {
    kinds: hasTargetKind ? kinds : ['large-output'],
    charCount,
    lineCount,
    hints,
    artifactRefs,
  });
  for (const key of ['text', 'output', 'stdout', 'stderr', 'log', 'logs', 'transcript', 'trajectory']) {
    if (typeof nextResult[key] === 'string' && nextResult[key].trim()) {
      nextResult[key] = summaryText;
    }
  }

  return {
    summaryText,
    result: nextResult,
    meta: {
      toolName,
      kinds: hasTargetKind ? kinds : ['large-output'],
      charCount,
      lineCount,
      hints,
      artifactRefs,
    },
  };
}

function isProducerToolName(toolName) {
  return PRODUCER_TOOL_RE.test(toolName ?? '');
}

function hasGeneratedArtifactCue(text) {
  return GENERATED_ARTIFACT_CUE_RE.test(text);
}

function buildToolArtifactEvidence(event) {
  const resultText = extractToolResultText(event?.result);
  const toolName = normalizeToolName(event);
  // Media-tool args are source inputs, never generated-output evidence. In the
  // field failure, the rejected reference video was echoed in tool args and
  // could otherwise be mistaken for a newly generated video.
  const argsText = isProducerToolName(toolName) && !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
    ? stringifyJson(event?.args)
    : '';
  const text = [resultText, argsText].filter(Boolean).join('\n');
  if (!text.trim()) return [];
  return buildArtifactEvidence(
    { cwd: event?.cwd },
    text,
    {
      allowRawPaths: !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
        && (
          isProducerToolName(toolName)
          || hasGeneratedArtifactCue(text)
          || isSuccessfulProcessCompletion(event, toolName)
        ),
    },
  );
}

function isSuccessfulProcessCompletion(event, toolName = normalizeToolName(event)) {
  if (String(toolName ?? '').trim().toLowerCase() !== 'process') return false;
  const result = delegatedToolResult(event?.result) ?? event?.result;
  if (!isRecord(result) || resultIndicatesError(result)) return false;
  const details = isRecord(result.details) ? result.details : {};
  const status = readToolStatus(result)?.toLowerCase();
  return details.exitCode === 0 || status === 'completed' || status === 'ok' || status === 'success';
}

function readToolStatus(result) {
  const details = isRecord(result?.details) ? result.details : {};
  const status = typeof details.status === 'string' ? details.status : undefined;
  if (status) return status;
  if (typeof details.ok === 'boolean') return details.ok ? 'ok' : 'error';
  if (typeof result?.terminate === 'boolean' && result.terminate) return 'terminated';
  return undefined;
}

function delegatedToolResult(result) {
  const details = isRecord(result?.details) ? result.details : {};
  return isRecord(details.result) ? details.result : undefined;
}

function resultIndicatesError(result) {
  if (!isRecord(result)) return false;
  if (result.isError === true) return true;
  if (typeof result.error === 'string' && result.error.trim()) return true;
  if (result.ok === false || result.success === false) return true;
  if (typeof result.details?.error === 'string' && result.details.error.trim()) return true;
  if (result.details?.ok === false || result.details?.success === false) return true;
  const status = readToolStatus(result);
  return typeof status === 'string' && TOOL_ERROR_STATUS_RE.test(status);
}

function isToolError(event) {
  if (event?.isError === true) return true;
  if (typeof event?.error === 'string' && event.error.trim()) return true;
  return resultIndicatesError(event?.result)
    || resultIndicatesError(delegatedToolResult(event?.result));
}

function summarizeToolFailure(event) {
  const details = isRecord(event?.result?.details) ? event.result.details : {};
  const candidate = [
    details.error,
    details.message,
    details.reason,
    readToolStatus(event?.result),
  ].find((value) => typeof value === 'string' && value.trim());
  return candidate ? truncateText(redactProgressPreview(candidate), 180) : undefined;
}

function pruneToolEvidence(now = Date.now()) {
  for (const [runId, evidence] of toolEvidenceByRunId.entries()) {
    if (now - evidence.updatedAt > RUN_TOOL_EVIDENCE_TTL_MS) toolEvidenceByRunId.delete(runId);
  }
  while (toolEvidenceByRunId.size > RUN_TOOL_EVIDENCE_MAX_ENTRIES) {
    const oldestRunId = toolEvidenceByRunId.keys().next().value;
    if (!oldestRunId) break;
    toolEvidenceByRunId.delete(oldestRunId);
  }
}

function recordToolEvidence(event, ctx) {
  const runId = getRunId(event, ctx);
  const toolName = normalizeToolName(event);
  if (!runId || !toolName) return undefined;
  const effectiveParams = normalizeEffectiveToolParams(event);
  if (
    MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
    && isSafeMediaToolReadAction(effectiveParams)
  ) return undefined;

  const failed = isToolError(event);
  const artifacts = failed ? [] : buildToolArtifactEvidence(event).map((entry) => ({
    ...entry,
    artifact: {
      ...entry.artifact,
      sourceRunId: runId,
      sourceToolCallId: normalizeOptionalString(event?.toolCallId),
      sourceToolName: toolName,
    },
    successfulToolResult: true,
    sourceRunId: runId,
    sourceToolCallId: normalizeOptionalString(event?.toolCallId),
    sourceToolName: toolName,
  }));
  if (
    !failed
    && artifacts.length === 0
    && !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
  ) return undefined;

  const now = Date.now();
  pruneToolEvidence(now);
  const current = toolEvidenceByRunId.get(runId) ?? {
    updatedAt: now,
    attempts: [],
  };
  const toolCallId = normalizeOptionalString(event?.toolCallId);
  const attempt = {
    runId,
    toolName,
    toolCallId,
    failed,
    artifacts,
    updatedAt: now,
  };
  const duplicateIndex = current.attempts.findIndex((item) => (
    toolCallId && item.toolCallId === toolCallId && item.toolName === toolName
  ));
  if (duplicateIndex >= 0) current.attempts[duplicateIndex] = attempt;
  else current.attempts.push(attempt);
  current.updatedAt = now;
  toolEvidenceByRunId.delete(runId);
  toolEvidenceByRunId.set(runId, current);
  pruneToolEvidence(now);
  return attempt;
}

function getToolEvidenceForRun(runId) {
  if (!runId) return { updatedAt: 0, attempts: [] };
  pruneToolEvidence();
  return toolEvidenceByRunId.get(runId) ?? { updatedAt: 0, attempts: [] };
}

function findSuccessfulToolArtifact(entry, runToolEvidence) {
  const entryKeys = new Set(artifactIdentityKeys(entry));
  for (const attempt of runToolEvidence?.attempts ?? []) {
    if (attempt.failed) continue;
    for (const toolArtifact of attempt.artifacts ?? []) {
      if (artifactIdentityKeys(toolArtifact).some((key) => entryKeys.has(key))) {
        return toolArtifact;
      }
    }
  }
  return undefined;
}

function successfulMediaCompletionTool(runId) {
  const match = /^(image_generate|video_generate):[^:]+:(?:ok|unknown)$/iu.exec(String(runId ?? ''));
  return match?.[1]?.toLowerCase();
}

function bindArtifactsToCurrentRunToolEvidence(artifacts, runToolEvidence, runId) {
  const completionTool = successfulMediaCompletionTool(runId);
  return artifacts.map((entry) => {
    const matched = findSuccessfulToolArtifact(entry, runToolEvidence);
    const completionKindMatches = completionTool === 'video_generate'
      ? entry?.artifact?.kind === 'video'
      : completionTool === 'image_generate' && entry?.artifact?.kind === 'image';
    if (!matched && !completionKindMatches) return entry;
    const sourceRunId = matched?.sourceRunId ?? runId;
    const sourceToolCallId = matched?.sourceToolCallId;
    const sourceToolName = matched?.sourceToolName ?? completionTool;
    return {
      ...entry,
      successfulToolResult: true,
      sourceRunId,
      sourceToolCallId,
      sourceToolName,
      artifact: {
        ...entry.artifact,
        sourceRunId,
        sourceToolCallId,
        sourceToolName,
      },
    };
  });
}

function artifactIdentityKeys(entry) {
  const artifact = entry?.artifact ?? entry;
  return [
    entry?.ref,
    artifact?.id,
    artifact?.filePath,
    artifact?.url,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.toLowerCase());
}

function canonicalAuthorizationToolName(event) {
  const direct = normalizeToolName(event).trim().toLowerCase();
  return direct.includes(':') ? direct.split(':').at(-1) : direct;
}

function nativeMediaPromptLengthBlock(event) {
  const toolName = canonicalAuthorizationToolName(event);
  if (!NATIVE_MEDIA_GENERATION_TOOLS.has(toolName)) return undefined;
  const prompt = normalizeEffectiveToolParams(event).prompt;
  if (typeof prompt !== 'string') return undefined;
  const characterCount = Array.from(prompt).length;
  if (characterCount <= NATIVE_MEDIA_PROMPT_MAX_CHARACTERS) return undefined;
  return {
    toolName,
    characterCount,
    reason: `${toolName} prompt exceeds the unified ${NATIVE_MEDIA_PROMPT_MAX_CHARACTERS}-character limit (${characterCount}). Shorten the prompt before retrying.`,
  };
}

function applyTurnMediaDefaults(event, ctx) {
  const toolName = canonicalAuthorizationToolName(event);
  const preferences = getTurnPreferences(event, ctx);
  if (!isPlainRecord(preferences) || !NATIVE_MEDIA_GENERATION_TOOLS.has(toolName)) {
    return { params: normalizeToolParams(event), appliedKeys: [] };
  }

  const params = normalizeToolParams(event);
  const defaults = toolName === 'image_generate'
    ? isPlainRecord(preferences.image) ? preferences.image : undefined
    : isPlainRecord(preferences.video) ? preferences.video : undefined;
  if (!defaults) return { params, appliedKeys: [] };

  const nextParams = { ...params };
  const appliedKeys = [];
  for (const key of toolName === 'image_generate'
    ? ['model', 'size', 'quality']
    // A video model is a semantic/provider decision. The Agent must select it
    // from the current attachments and advertised capability profile; the UI
    // supplies only explicit geometry and timing constraints for this turn.
    : ['size', 'durationSeconds']) {
    const value = defaults[key];
    if (nextParams[key] !== undefined || value === undefined || value === null || value === '') continue;
    nextParams[key] = value;
    appliedKeys.push(key);
  }
  return { params: nextParams, appliedKeys };
}

function analyzeArtifactFinal(event, ctx) {
  const activeUserText = extractLatestUserRequestText(event);
  const finalText = extractFinalAssistantText(event);
  const emptyFinal = !finalText.trim();
  const heartbeatPoll = isHeartbeatPoll(activeUserText);
  const heartbeatOk = isHeartbeatOk(finalText);
  const currentRunId = getRunId(event, ctx);
  const runToolEvidence = getToolEvidenceForRun(currentRunId);
  const preferences = getTurnPreferences(event, ctx);
  const requestedMediaMode = preferences?.mode === 'image' || preferences?.mode === 'video'
    ? preferences.mode
    : undefined;
  const requestedMediaTool = requestedMediaMode === 'image'
    ? 'image_generate'
    : requestedMediaMode === 'video'
      ? 'video_generate'
      : undefined;
  const requestedMediaToolAttempts = requestedMediaTool
    ? runToolEvidence.attempts.filter((attempt) => attempt.toolName === requestedMediaTool)
    : [];
  const artifacts = bindArtifactsToCurrentRunToolEvidence(
    buildArtifactEvidence({ cwd: event?.cwd }, finalText),
    runToolEvidence,
    currentRunId,
  );
  const failedArtifacts = artifacts.filter(({ verification }) => (
    verification.status === 'blocked' || verification.status === 'failed'
  ));
  const verificationPassed = artifacts.some(({ verification }) => verification.status === 'passed');
  const verificationBlocked = failedArtifacts.length > 0;
  const passedArtifactCount = artifacts.filter(({ verification }) => verification.status === 'passed').length;
  const shouldReviseArtifact = failedArtifacts.length > 0;
  const shouldReviseMissingMediaAttempt = Boolean(
    requestedMediaTool
    && activeUserText.trim()
    && !heartbeatPoll
    && requestedMediaToolAttempts.length === 0,
  );
  const shouldReviseHeartbeat = Boolean(
    heartbeatPoll
    && !heartbeatOk,
  );
  const shouldReviseEmptyFinal = Boolean(
    activeUserText.trim()
    && !heartbeatPoll
    && emptyFinal
    && !shouldReviseMissingMediaAttempt,
  );
  const shouldRevise = shouldReviseHeartbeat
    || shouldReviseMissingMediaAttempt
    || shouldReviseEmptyFinal
    || shouldReviseArtifact;
  return {
    activeUserText,
    finalText,
    emptyFinal,
    heartbeatPoll,
    heartbeatOk,
    currentRunId,
    requestedMediaMode,
    requestedMediaTool,
    requestedMediaToolAttemptCount: requestedMediaToolAttempts.length,
    currentRunToolAttemptCount: runToolEvidence.attempts.length,
    currentRunFailedToolCount: runToolEvidence.attempts.filter((attempt) => attempt.failed).length,
    currentRunSuccessfulArtifactCount: runToolEvidence.attempts.reduce(
      (total, attempt) => total + (attempt.failed ? 0 : attempt.artifacts.length),
      0,
    ),
    passedArtifactCount,
    artifacts,
    verificationPassed,
    verificationBlocked,
    shouldReviseHeartbeat,
    shouldReviseMissingMediaAttempt,
    shouldReviseEmptyFinal,
    shouldReviseArtifact,
    shouldRevise,
  };
}

function buildRevision(analysis) {
  if (analysis?.shouldReviseHeartbeat) {
    return {
      action: 'revise',
      reason: 'UClaw heartbeat poll produced user-visible non-heartbeat content.',
      retry: {
        idempotencyKey: `${REVISION_ID}:heartbeat`,
        maxAttempts: 1,
        instruction: [
          '最新用户消息是内部心跳 `[OpenClaw heartbeat poll]`，不是用户的新任务。',
          '不要继续历史任务、不要评价上一轮、不要承诺补做，也不要输出任何产物说明。',
          '本轮最终回复必须只包含：HEARTBEAT_OK',
        ].join('\n'),
      },
    };
  }
  if (analysis?.shouldReviseMissingMediaAttempt) {
    const mode = analysis.requestedMediaMode === 'video' ? 'video' : 'image';
    const toolName = mode === 'video' ? 'video_generate' : 'image_generate';
    return {
      action: 'revise',
      reason: `UClaw ${mode} mode ended without a ${toolName} attempt.`,
      retry: {
        idempotencyKey: `${REVISION_ID}:missing-${mode}-attempt`,
        maxAttempts: 1,
        instruction: [
          `The UClaw client explicitly selected ${mode} mode for this turn, but the previous response ended without calling ${toolName}.`,
          mode === 'video'
            ? 'Continue the same request now: use the required uclaw_video_project flow when applicable, then call video_generate and deliver the verified video artifact.'
            : 'Continue the same request now: call image_generate and deliver the verified image artifact.',
          'Do not answer with another promise or capability description. If execution is unavailable or fails, report the concrete tool or provider failure after the real attempt.',
        ].join('\n'),
      },
    };
  }
  if (analysis?.shouldReviseEmptyFinal) {
    return {
      action: 'revise',
      reason: 'UClaw run ended without a user-visible final response.',
      retry: {
        idempotencyKey: `${REVISION_ID}:empty-final`,
        maxAttempts: 1,
        instruction: [
          '上一轮已经结束，但没有生成任何用户可见的最终回复。现在只补写最终交付，不要沉默。',
          '优先依据本轮已有工具结果、产物和验证事实作答；不要重复执行已经成功的外部动作、文件生成、图片生成或视频生成。',
          '如果已有证据足够，直接用简体中文给出结论、完成项和必要限制。',
          '如果已有工具结果不足或失败，明确说明实际尝试、失败点和下一步，不要假装完成。',
        ].join('\n'),
      },
    };
  }
  if (analysis?.shouldReviseArtifact) {
    return {
      action: 'revise',
      reason: 'UClaw final reply referenced a local artifact that failed deterministic availability verification.',
      retry: {
        idempotencyKey: `${REVISION_ID}:artifact-verification`,
        maxAttempts: 1,
        instruction: [
          '上一回复引用的本地产物没有通过确定性验证：路径必须指向可读、非空的普通文件。',
          '只根据已经发生的真实工具结果修正交付：如果已有正确文件，返回其 MEDIA:<absolute-path> 或绝对路径；如果生成失败，明确报告真实失败。',
          '不要根据用户措辞猜测任务类型，也不要伪造产物、审批或完成状态。',
        ].join('\n'),
      },
    };
  }
  return undefined;

}

function getRunId(event, ctx) {
  return normalizeOptionalString(event?.runId) ?? normalizeOptionalString(ctx?.runId);
}

function getSessionKey(event, ctx) {
  return normalizeOptionalString(event?.sessionKey) ?? normalizeOptionalString(ctx?.sessionKey);
}

function resolveAgentEventEmitter(api) {
  if (typeof api?.agent?.events?.emitAgentEvent === 'function') {
    return api.agent.events.emitAgentEvent.bind(api.agent.events);
  }
  if (typeof api?.emitAgentEvent === 'function') {
    return api.emitAgentEvent.bind(api);
  }
  return undefined;
}

function emitRuntimeEvent(api, event, stream, data) {
  const runId = getRunId(event);
  const emit = resolveAgentEventEmitter(api);
  if (!runId || !emit) return { emitted: false, reason: !runId ? 'missing-run-id' : 'missing-emitter' };
  try {
    return emit({
      runId,
      stream,
      data,
      contractVersion: 1,
      producer: RUNTIME_EVENT_SOURCE,
      seq: ++runtimeEventSeq,
      ts: Date.now(),
      ...(getSessionKey(event) ? { sessionKey: getSessionKey(event) } : {}),
    });
  } catch (error) {
    logDiagnostic('runtime-event-error', {
      eventId: eventId(event),
      stream,
      error: error instanceof Error ? error.message : String(error),
    });
    return { emitted: false, reason: 'emit-failed' };
  }
}

function emitFinalArtifactEvents(api, event, analysis) {
  for (const { artifact, verification } of analysis.artifacts) {
    emitRuntimeEvent(api, event, 'artifact', {
      artifact,
      source: RUNTIME_EVENT_SOURCE,
    });
    emitRuntimeEvent(api, event, 'verification', {
      verification,
      source: RUNTIME_EVENT_SOURCE,
    });
  }

}

function buildMiddlewareRunEvent(event, ctx) {
  return {
    runId: ctx?.runId,
    sessionKey: ctx?.sessionKey,
    cwd: event?.cwd,
  };
}

function buildToolStep(event) {
  const failed = isToolError(event);
  const status = failed ? 'error' : 'completed';
  const statusDetail = readToolStatus(event?.result);
  const toolName = normalizeToolName(event);
  return {
    id: event?.toolCallId ? `tool:${event.toolCallId}` : `tool:${hashString(toolName || 'unknown')}`,
    title: toolName ? `工具 ${toolName}` : '工具执行',
    status,
    kind: 'tool',
    detail: statusDetail ? `status=${statusDetail}` : undefined,
  };
}

function summarizeProgressCommand(command) {
  const candidate = String(command ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^(?:set\s+-[A-Za-z]+|printf\b|echo\b|#|true$|false$)/u.test(line));
  return truncateText(redactProgressPreview(candidate || String(command ?? '')), 160);
}

function redactProgressPreview(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, '[REDACTED]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|sess-[A-Za-z0-9_-]{8,})\b/gu, '[REDACTED]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s\/@]+(@)/gu, '$1[REDACTED]$2')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/((?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gimu, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|signature|sig|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY))["']?\s*[:=]\s*["'])[^"'\r\n]*(["'])/giu, '$1[REDACTED]$2')
    .replace(/((?:^|[\s{[(,;])(?:export\s+)?(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY)|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)\s*=\s*)[^\s,;)}\]]+/gimu, '$1[REDACTED]')
    .replace(/([?&#](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|signature|sig|secret|credential|x-amz-credential|x-amz-signature)=)[^&#\s"']*/giu, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)(?:=|\s+))["']?[^\s"']+["']?/giu, '$1[REDACTED]');
}

function extractProgressPathLike(params) {
  for (const key of ['path', 'filePath', 'url']) {
    if (typeof params?.[key] === 'string' && params[key].trim()) {
      return truncateText(redactProgressPreview(params[key].trim()), 160);
    }
  }
  return undefined;
}

function parseProgressRecord(value) {
  if (isPlainRecord(value)) {
    if (typeof value.summary === 'string') {
      const parsed = parseProgressRecord(value.summary);
      if (parsed) return parsed;
    }
    if (Array.isArray(value.content)) {
      for (const part of value.content) {
        if (!isPlainRecord(part) || typeof part.text !== 'string') continue;
        const parsed = parseProgressRecord(part.text);
        if (parsed) return parsed;
      }
    }
    return value;
  }
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function progressResultEnvelope(event) {
  return parseProgressRecord(event?.result) ?? parseProgressRecord(event?.meta);
}

function progressDelegatedResult(event) {
  const envelope = progressResultEnvelope(event);
  return isPlainRecord(envelope?.result) ? envelope.result : envelope;
}

function progressResultDetails(event) {
  const envelope = progressResultEnvelope(event);
  const delegated = progressDelegatedResult(event);
  return isPlainRecord(delegated?.details)
    ? delegated.details
    : isPlainRecord(envelope?.details)
      ? envelope.details
      : {};
}

function progressToolLabel(event, toolName) {
  const envelope = progressResultEnvelope(event);
  const delegated = progressDelegatedResult(event);
  const tool = isPlainRecord(envelope?.tool)
    ? envelope.tool
    : isPlainRecord(delegated?.tool)
      ? delegated.tool
      : undefined;
  const structuredLabel = normalizeOptionalString(tool?.label)
    ?? normalizeOptionalString(tool?.title)
    ?? String(toolName ?? '').replace(/[_-]+/gu, ' ').trim();
  return truncateText(redactProgressPreview(structuredLabel || 'tool'), 120);
}

function mediaProgressSummary(params, details = {}) {
  const values = { ...params, ...details };
  const parts = [];
  if (Number.isFinite(values.durationSeconds)) parts.push(`${Math.max(1, Math.round(values.durationSeconds))}s`);
  const size = normalizeOptionalString(values.size);
  const resolution = normalizeOptionalString(values.resolution);
  const aspectRatio = normalizeOptionalString(values.aspectRatio) ?? normalizeOptionalString(values.aspect_ratio);
  if (size) parts.push(size);
  if (resolution && resolution.toLowerCase() !== size?.toLowerCase()) parts.push(resolution);
  if (aspectRatio) parts.push(aspectRatio);
  if (values.audio === true) parts.push('audio');
  if (values.audio === false) parts.push('no audio');
  return parts.length > 0 ? truncateText(parts.join(' · '), 140) : undefined;
}

function extractToolProgressCommand(event) {
  const params = normalizeEffectiveToolParams(event);
  const commandKey = commandParamKey(params);
  if (commandKey) {
    return summarizeProgressCommand(params[commandKey]);
  }
  const pathLike = extractProgressPathLike(params);
  if (pathLike) return pathLike;
  const query = normalizeOptionalString(params.query)
    ?? normalizeOptionalString(params.searchQuery)
    ?? normalizeOptionalString(params.search_query);
  if (query) return truncateText(redactProgressPreview(query), 160);
  const toolName = normalizeToolName(event);
  if (NATIVE_MEDIA_GENERATION_TOOLS.has(toolName) || toolName === 'image_edit') {
    return mediaProgressSummary(params, progressResultDetails(event));
  }
  return undefined;
}

function extractOpenAppName(command) {
  const byApp = command.match(/\bopen\s+-a\s+["']?([^"'\n]+)["']?/iu);
  if (byApp?.[1]) return byApp[1].trim();
  const byPath = command.match(/\bopen\s+((?:\/|~\/)[^\n]+)/u);
  if (!byPath?.[1]) return undefined;
  const normalized = byPath[1].trim();
  return normalized.split(/[\\/]/u).pop()?.replace(/\.app$/iu, '') || normalized;
}

function buildNativeToolCommentary(toolName, command) {
  const label = String(toolName ?? '').trim().toLowerCase();
  if (label === 'exec') {
    if (!command) return '我先继续执行当前步骤。';
    if (/\b(?:mdfind|find|lsregister|locate|rg|ls)\b/iu.test(command) && /(?:\/Applications\b|\.app\b|kMDItemContentType\s*={1,2}\s*["']?com\.apple\.application)/iu.test(command)) {
      return '我先在本机查找相关应用和快捷方式。';
    }
    if (/\bopen\b/iu.test(command)) {
      const appName = extractOpenAppName(command);
      return appName ? `我先尝试打开 ${appName}。` : '我先尝试启动相关应用。';
    }
    if (/\bosascript\b/iu.test(command) && /\b(?:keystroke|key\s+code|activate)\b/iu.test(command)) {
      return '我尝试继续执行应用里的下一步操作。';
    }
    if (/\b(?:pgrep|ps)\b/iu.test(command)) {
      return '我再确认应用是否仍在运行。';
    }
    return undefined;
  }
  if (label === 'web_fetch' || label === 'browser') return '我先继续查看相关页面和内容。';
  if (label === 'read') return '我先查看相关内容。';
  if (label === 'edit' || label === 'apply_patch') return '我先修改相关内容。';
  return undefined;
}

function nativeToolProgressState(event, failed = false) {
  const details = progressResultDetails(event);
  const status = normalizeOptionalString(details.status)?.toLowerCase();
  if (status && /^(?:aborted|cancelled|canceled|stopped|terminated)$/u.test(status)) return 'aborted';
  if (status && /^(?:blocked|waiting_approval|approval_required|pending_approval)$/u.test(status)) return 'blocked';
  if (status && /^(?:partial|partially_completed|partial_failure)$/u.test(status)) return 'partial';
  if (failed) return 'error';
  if (details.async === true && status && ASYNC_PROGRESS_STARTED_STATUSES.has(status)) return 'submitted';
  return event?.result === undefined ? 'running' : 'completed';
}

function nativeToolProgressStatus(state) {
  if (state === 'error') return 'error';
  if (state === 'aborted') return 'aborted';
  if (state === 'blocked' || state === 'partial') return 'blocked';
  if (state === 'running' || state === 'submitted') return 'running';
  return 'completed';
}

function nativeToolProgressTranslationKey(state) {
  if (state === 'error') return 'runtimeProgress.toolFailed';
  if (state === 'blocked') return 'runtimeProgress.toolBlocked';
  if (state === 'aborted') return 'runtimeProgress.toolAborted';
  if (state === 'partial') return 'runtimeProgress.toolPartial';
  if (state === 'submitted') return 'runtimeProgress.toolSubmitted';
  if (state === 'running') return 'runtimeProgress.toolRunning';
  return 'runtimeProgress.toolCompleted';
}

function buildNativeToolActionText(toolLabel, state) {
  if (state === 'error') return `执行失败：${toolLabel}`;
  if (state === 'blocked') return `需要处理：${toolLabel}`;
  if (state === 'aborted') return `已停止：${toolLabel}`;
  if (state === 'partial') return `部分完成：${toolLabel}`;
  if (state === 'submitted') return `已提交：${toolLabel}`;
  if (state === 'running') return `正在执行：${toolLabel}`;
  return `已完成：${toolLabel}`;
}

function pruneProgressWrappers(now = Date.now()) {
  for (const [parentToolCallId, wrapper] of progressWrappersByParentToolCallId.entries()) {
    if (now - wrapper.updatedAt > PROGRESS_WRAPPER_TTL_MS) {
      progressWrappersByParentToolCallId.delete(parentToolCallId);
    }
  }
  while (progressWrappersByParentToolCallId.size > PROGRESS_WRAPPER_MAX_ENTRIES) {
    const oldestParentToolCallId = progressWrappersByParentToolCallId.keys().next().value;
    if (!oldestParentToolCallId) break;
    progressWrappersByParentToolCallId.delete(oldestParentToolCallId);
  }
}

function rememberStructuredProgressWrapper(event, ctx) {
  if (normalizeDirectToolName(event) !== 'tool_call') return;
  const parentToolCallId = normalizeOptionalString(event?.toolCallId) ?? normalizeOptionalString(event?.id);
  const targetToolName = normalizeToolName(event).trim().toLowerCase();
  if (!parentToolCallId || !targetToolName || targetToolName === 'tool_call') return;
  const now = Date.now();
  pruneProgressWrappers(now);
  progressWrappersByParentToolCallId.delete(parentToolCallId);
  progressWrappersByParentToolCallId.set(parentToolCallId, {
    runId: getRunId(event, ctx),
    targetToolName,
    updatedAt: now,
  });
}

function canonicalProgressToolCallId(event, ctx) {
  const toolCallId = normalizeOptionalString(event?.toolCallId) ?? normalizeOptionalString(event?.id);
  if (!toolCallId) return undefined;
  const nested = /^tool_search_code:(.+):([^:]+):\d+$/u.exec(toolCallId);
  if (!nested) return toolCallId;
  pruneProgressWrappers();
  const exactWrapper = progressWrappersByParentToolCallId.get(nested[1]);
  const resolvedWrapper = exactWrapper
    ? { parentToolCallId: nested[1], wrapper: exactWrapper }
    : Array.from(progressWrappersByParentToolCallId.entries())
        .reverse()
        .map(([parentToolCallId, wrapper]) => ({ parentToolCallId, wrapper }))
        .find(({ parentToolCallId }) => parentToolCallId.replaceAll('|', '_') === nested[1]);
  if (!resolvedWrapper) return toolCallId;
  const { parentToolCallId, wrapper } = resolvedWrapper;
  const runId = getRunId(event, ctx);
  if (wrapper.runId && runId && wrapper.runId !== runId) return toolCallId;
  const childToolName = String(nested[2] ?? '').trim().toLowerCase();
  return childToolName === wrapper.targetToolName ? parentToolCallId : toolCallId;
}

function buildNativeToolProgressId(event, ctx, suffix = '') {
  const toolCallId = canonicalProgressToolCallId(event, ctx);
  const base = toolCallId
    ? `progress:tool:${toolCallId}`
    : `progress:tool:${hashString(normalizeToolName(event) || 'tool')}`;
  return suffix ? `${base}:${suffix}` : base;
}

function emitNativeToolProgress(api, event, ctx, entry) {
  const runEvent = {
    runId: getRunId(event, ctx),
    sessionKey: getSessionKey(event, ctx),
    cwd: event?.cwd ?? ctx?.cwd,
  };
  if (!getRunId(runEvent)) return;
  emitRuntimeEvent(api, runEvent, 'progress', {
    entry: {
      ...entry,
      text: redactProgressPreview(entry?.text),
      detail: typeof entry?.detail === 'string' ? redactProgressPreview(entry.detail) : entry?.detail,
      command: typeof entry?.command === 'string' ? redactProgressPreview(entry.command) : entry?.command,
      toolLabel: typeof entry?.toolLabel === 'string' ? redactProgressPreview(entry.toolLabel) : entry?.toolLabel,
      translationParams: entry?.translationParams && typeof entry.translationParams === 'object'
        ? {
            ...entry.translationParams,
            tool: typeof entry.translationParams.tool === 'string'
              ? redactProgressPreview(entry.translationParams.tool)
              : entry.translationParams.tool,
          }
        : entry?.translationParams,
      source: 'native',
      toolCallId: canonicalProgressToolCallId(event, ctx),
    },
  });
}

function emitToolCallProgress(api, event, ctx) {
  rememberStructuredProgressWrapper(event, ctx);
  const toolName = normalizeToolName(event);
  if (!toolName || HIDDEN_PROGRESS_TOOLS.has(toolName)) return;
  const command = extractToolProgressCommand(event);
  const commentary = buildNativeToolCommentary(toolName, command);
  if (commentary) {
    emitNativeToolProgress(api, event, ctx, {
      id: buildNativeToolProgressId(event, ctx, 'commentary'),
      kind: 'commentary',
      text: commentary,
      command,
      stepId: normalizeOptionalString(event?.toolCallId),
    });
  }
  const toolLabel = progressToolLabel(event, toolName);
  const state = nativeToolProgressState(event);
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx),
    kind: 'action',
    text: buildNativeToolActionText(toolLabel, state),
    status: nativeToolProgressStatus(state),
    translationKey: nativeToolProgressTranslationKey(state),
    translationParams: { tool: toolLabel },
    toolName,
    toolLabel,
    command,
    stepId: normalizeOptionalString(event?.toolCallId),
  });
}

function emitToolResultProgress(api, event, ctx) {
  rememberStructuredProgressWrapper(event, ctx);
  const toolName = normalizeToolName(event);
  if (!toolName || HIDDEN_PROGRESS_TOOLS.has(toolName)) return;
  const failed = isToolError(event);
  const toolLabel = progressToolLabel(event, toolName);
  const state = nativeToolProgressState(event, failed);
  const details = progressResultDetails(event);
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx),
    kind: 'action',
    text: buildNativeToolActionText(toolLabel, state),
    status: nativeToolProgressStatus(state),
    translationKey: nativeToolProgressTranslationKey(state),
    translationParams: { tool: toolLabel },
    toolName,
    toolLabel,
    command: extractToolProgressCommand(event),
    taskId: normalizeOptionalString(details.taskId) ?? normalizeOptionalString(details.task_id),
    stepId: normalizeOptionalString(event?.toolCallId),
  });
  if (!failed) return;
  const detail = summarizeToolFailure(event);
  if (!detail) return;
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx, 'status'),
    kind: 'status',
    text: detail,
    status: 'error',
    detail,
    stepId: normalizeOptionalString(event?.toolCallId),
  });
}

function emitToolResultRuntimeEvents(api, event, ctx) {
  const runEvent = buildMiddlewareRunEvent(event, ctx);
  if (!getRunId(runEvent)) return;

  emitToolResultProgress(api, event, ctx);
  emitRuntimeEvent(api, runEvent, 'step', {
    step: buildToolStep(event),
    toolCallId: event?.toolCallId,
    source: RUNTIME_EVENT_SOURCE,
  });

  const failed = isToolError(event);
  if (failed) return;

  const artifacts = buildToolArtifactEvidence(event);
  for (const { artifact, verification } of artifacts) {
    const artifactWithSource = {
      ...artifact,
      sourceToolCallId: event?.toolCallId,
    };
    const verificationWithSource = {
      ...verification,
      targetId: artifactWithSource.id,
      artifactId: artifactWithSource.id,
    };

    emitRuntimeEvent(api, runEvent, 'artifact', {
      artifact: artifactWithSource,
      toolCallId: event?.toolCallId,
      source: RUNTIME_EVENT_SOURCE,
    });
    emitRuntimeEvent(api, runEvent, 'verification', {
      verification: verificationWithSource,
      toolCallId: event?.toolCallId,
      source: RUNTIME_EVENT_SOURCE,
    });

  }
}

function registerToolResultMiddleware(api) {
  if (typeof api.registerAgentToolResultMiddleware !== 'function') return;
  api.registerAgentToolResultMiddleware((event, ctx) => {
    recordToolEvidence(event, ctx);
    emitToolResultRuntimeEvents(api, event, ctx);
    const summarized = summarizeToolResultForTranscript(event);
    if (!summarized) return undefined;
    if (isRecord(event)) event.result = summarized.result;
    logDiagnostic('tool-result-transcript-compact', {
      eventId: eventId(event, ctx),
      toolName: summarized.meta.toolName,
      categories: summarized.meta.kinds,
      omittedChars: summarized.meta.charCount,
      omittedLines: summarized.meta.lineCount,
      hintCount: summarized.meta.hints.length,
      artifactRefCount: summarized.meta.artifactRefs.length,
    });
    return {
      result: summarized.result,
    };
  }, {
    runtimes: ['openclaw'],
  });
}

function registerLifecycleHook(api, name, handler, options) {
  if (typeof api.on === 'function') {
    api.on(name, handler, options);
    return true;
  }
  if (typeof api.registerHook === 'function') {
    api.registerHook(name, handler, options);
    return true;
  }
  return false;
}

function registerArtifactGuard(api) {
  registerToolResultMiddleware(api);
  if (typeof api.registerHook === 'function' || typeof api.on === 'function') {
    registerLifecycleHook(api, 'before_message_write', (event, ctx) => {
      const decision = sanitizeInternalTranscriptMessage(event?.message);
      if (decision.action === 'keep') return undefined;
      logDiagnostic(`internal-transcript-${decision.action}`, {
        eventId: eventId(event, ctx),
        role: event?.message?.role,
        reason: decision.reason,
      });
      if (decision.action === 'block') return { block: true };
      return { message: decision.message };
    }, {
      name: `${PLUGIN_ID}:internal-transcript-isolation`,
      description: 'Keep OpenClaw heartbeat, restart continuation, and runtime plumbing messages out of persisted transcripts.',
      priority: 1000,
    });
    registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
      const historySanitization = sanitizePromptHistoryMessages(event);
      if (historySanitization.blocked > 0 || historySanitization.rewritten > 0) {
        logDiagnostic('internal-prompt-history-sanitize', {
          eventId: eventId(event, ctx),
          ...historySanitization,
        });
      }
      const presentationCompaction = compactHistoricalPresentationToolCalls(event);
      if (presentationCompaction.compacted > 0) {
        logDiagnostic('presentation-prompt-history-compact', {
          eventId: eventId(event, ctx),
          ...presentationCompaction,
        });
      }
      const preferences = await requestTurnPreferencesFromHost(event, ctx);
      cacheTurnPreferences(event, ctx, preferences);
      const turnPreferenceContext = buildTurnPreferenceSystemContext(preferences);
      if (turnPreferenceContext) {
        logDiagnostic('turn-preferences-consumed', {
          eventId: eventId(event, ctx),
          mode: preferences.mode,
          selectedArtifactCount: Array.isArray(preferences.selectedArtifacts) ? preferences.selectedArtifacts.length : 0,
        });
      }
      return {
        appendSystemContext: [VIDEO_MODEL_PLANNING_CONTEXT, turnPreferenceContext].filter(Boolean).join('\n\n'),
      };
    }, {
      name: PROMPT_CONTEXT_HOOK_ID,
      description: 'Sanitize prompt history and project explicit per-turn media mode and constraints into the model prompt.',
      timeoutMs: TURN_PREFERENCES_TIMEOUT_MS + 2_000,
    });
    registerLifecycleHook(api, 'before_tool_call', async (event, ctx) => {
      const screenshotRewrite = rewriteExecScreenshotParams(event);
      const effectiveEvent = screenshotRewrite
        ? {
            ...event,
            params: screenshotRewrite.params,
          }
        : event;
      if (screenshotRewrite) {
        logDiagnostic('exec-screenshot-path-rewrite', {
          eventId: eventId(event, ctx),
          toolName: screenshotRewrite.toolName,
          commandKey: screenshotRewrite.commandKey,
          rewrittenPaths: screenshotRewrite.rewrittenPaths,
        });
      }

      const toolName = normalizeToolName(effectiveEvent);
      const promptLengthBlock = nativeMediaPromptLengthBlock(effectiveEvent);
      if (promptLengthBlock) {
        logDiagnostic('native-media-prompt-too-long', {
          eventId: eventId(event, ctx),
          toolName: promptLengthBlock.toolName,
          characterCount: promptLengthBlock.characterCount,
          limit: NATIVE_MEDIA_PROMPT_MAX_CHARACTERS,
        });
        return {
          block: true,
          blockReason: promptLengthBlock.reason,
          reason: promptLengthBlock.reason,
        };
      }
      if (toolName && MEDIA_SIDE_EFFECT_TOOLS.has(toolName)) {
        logDiagnostic('native-media-tool-call', {
          eventId: eventId(event, ctx),
          toolName,
          authorization: 'native_agent_tool_selection',
        });
      }

      const staging = await stageMediaToolInputs(effectiveEvent, ctx);
      if (staging.blockReason) {
        logDiagnostic('media-input-staging-failed', {
          eventId: eventId(event, ctx),
          toolName,
          errorCode: staging.errorCode,
        });
        return {
          block: true,
          blockReason: staging.blockReason,
          reason: staging.blockReason,
        };
      }
      if (staging.stagedCount > 0) {
        effectiveEvent.params = staging.params;
        logDiagnostic('media-input-staged', {
          eventId: eventId(event, ctx),
          toolName,
          stagedCount: staging.stagedCount,
          stagedParamKeys: staging.stagedParamKeys,
        });
      }

      const mediaDefaults = applyTurnMediaDefaults(effectiveEvent, ctx);
      if (mediaDefaults.appliedKeys.length > 0) {
        effectiveEvent.params = mediaDefaults.params;
        logDiagnostic('native-media-defaults-applied', {
          eventId: eventId(event, ctx),
          toolName,
          appliedKeys: mediaDefaults.appliedKeys,
        });
      }

      emitToolCallProgress(api, effectiveEvent, ctx);
      if (screenshotRewrite || staging.stagedCount > 0 || mediaDefaults.appliedKeys.length > 0) {
        return {
          params: effectiveEvent.params,
        };
      }
      return undefined;
    }, {
      name: MEDIA_TOOL_PREPARATION_HOOK_ID,
      description: 'Stage media inputs, rewrite managed screenshot paths, and project native media tool progress.',
      priority: 100,
    });
    registerLifecycleHook(api, 'before_agent_finalize', (event, ctx) => {
      const analysis = analyzeArtifactFinal(event, ctx);
      logDiagnostic('finalize-check', {
        eventId: eventId(event, ctx),
        finalTextChars: analysis.finalText.length,
        emptyFinal: analysis.emptyFinal,
        heartbeatPoll: analysis.heartbeatPoll,
        heartbeatOk: analysis.heartbeatOk,
        requestedMediaMode: analysis.requestedMediaMode,
        requestedMediaTool: analysis.requestedMediaTool,
        requestedMediaToolAttemptCount: analysis.requestedMediaToolAttemptCount,
        currentRunToolAttemptCount: analysis.currentRunToolAttemptCount,
        currentRunFailedToolCount: analysis.currentRunFailedToolCount,
        currentRunSuccessfulArtifactCount: analysis.currentRunSuccessfulArtifactCount,
        passedArtifactCount: analysis.passedArtifactCount,
        artifactCount: analysis.artifacts.length,
        verificationPassed: analysis.verificationPassed,
        verificationBlocked: analysis.verificationBlocked,
        shouldReviseHeartbeat: analysis.shouldReviseHeartbeat,
        shouldReviseMissingMediaAttempt: analysis.shouldReviseMissingMediaAttempt,
        shouldReviseEmptyFinal: analysis.shouldReviseEmptyFinal,
        shouldReviseArtifact: analysis.shouldReviseArtifact,
        shouldRevise: analysis.shouldRevise,
      });
      emitFinalArtifactEvents(api, event, analysis);
      if (!analysis.shouldRevise) return;
      return buildRevision(analysis);
    }, {
      name: REVISION_ID,
      description: 'Verify concrete artifact references and recover missing media execution or empty final responses.',
    });
  }
}

export default {
  id: PLUGIN_ID,
  name: 'UClaw Artifact Guard',
  version: '0.2.9',
  register(api) {
    registerArtifactGuard(api);
  },
};

export const __test = {
  analyzeArtifactFinal,
  buildRevision,
  nativeMediaPromptLengthBlock,
  buildToolArtifactEvidence,
  emitToolCallProgress,
  emitToolResultProgress,
  emitToolResultRuntimeEvents,
  rewriteTmpScreenshotMediaPaths,
  stageMediaToolInputs,
  sanitizeInternalTranscriptMessage,
  compactHistoricalPresentationToolCalls,
  cacheTurnPreferences,
  buildTurnPreferenceSystemContext,
  applyTurnMediaDefaults,
  VIDEO_MODEL_PLANNING_CONTEXT,
  registerArtifactGuard,
};
