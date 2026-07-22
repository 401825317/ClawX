import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { listRuntimeVideoGenerationProviders } from 'openclaw/plugin-sdk/video-generation-runtime';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'uclaw-video-project';
const PROJECT_SCHEMA = 'uclaw.video-project/v1';
const TOOL_NAMES = ['uclaw_video_project', 'uclaw_video_shot'];
const MAX_TEXT_CHARS = 4_000;
const MAX_PROJECTS_PER_SESSION = 80;
const MAX_SHOTS_PER_PROJECT = 48;
const MAX_ATTEMPTS_PER_SHOT = 12;
const MAX_ARTIFACTS_PER_PROJECT = 24;
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const COMPOSITION_MONITOR_INTERVAL_MS = 2_500;
const COMPOSITION_SCHEMA = 'uclaw.video-project.composition/v1';
const PROJECT_ID_RE = /^video-project-[a-z0-9-]{8,96}$/u;
const SHOT_ID_RE = /^[a-z][a-z0-9_-]{0,95}$/u;
const VIDEO_MODEL_REF_RE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/iu;

class VideoProjectError extends Error {
  constructor(message, code = 'video_project_error') {
    super(message);
    this.code = code;
  }
}

function cleanText(value, maxLength = MAX_TEXT_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, code: 'video_project_serialization_error' });
  }
}

function now() {
  return Date.now();
}

function projectStateDir() {
  const openClawHome = cleanText(process.env.OPENCLAW_HOME, 2_000) || path.join(homedir(), '.openclaw');
  return path.join(openClawHome, 'state', 'uclaw-video-projects');
}

function projectFile(projectId) {
  if (!PROJECT_ID_RE.test(projectId)) throw new VideoProjectError('VideoProject ID is invalid.', 'project_id_invalid');
  return path.join(projectStateDir(), `${projectId}.json`);
}

function sessionKeyFromContext(ctx) {
  const sessionKey = cleanText(ctx?.sessionKey || ctx?.session?.key || ctx?.session?.sessionKey, 500);
  if (!sessionKey) {
    throw new VideoProjectError(
      'VideoProject requires the current OpenClaw session identity; the model must not supply one.',
      'runtime_session_missing',
    );
  }
  return sessionKey;
}

function runIdFromContext(ctx) {
  const runId = cleanText(ctx?.runId || ctx?.agentRunId || ctx?.session?.runId, 500);
  if (!runId) {
    throw new VideoProjectError(
      'VideoProject composition requires the current OpenClaw run identity; the model must not supply one.',
      'runtime_run_missing',
    );
  }
  return runId;
}

function hostApiOrigin() {
  return String(process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function hostApiToken() {
  const token = cleanText(process.env.CLAWX_HOST_API_TOKEN, 4_000);
  if (!token) {
    throw new VideoProjectError(
      'UClaw Host API token is unavailable; no composition task was started.',
      'host_api_token_unavailable',
    );
  }
  return token;
}

async function hostApiFetch(route, options = {}) {
  let response;
  try {
    response = await fetch(`${hostApiOrigin()}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${hostApiToken()}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new VideoProjectError(
      `UClaw Host task bridge is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'host_api_unreachable',
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new VideoProjectError(
      cleanText(payload?.error, 1_500) || `UClaw Host task bridge request failed: ${response.status}`,
      response.status === 404 ? 'host_task_bridge_not_installed' : 'host_task_bridge_request_failed',
    );
  }
  return payload?.task ?? payload?.result?.task ?? payload?.result ?? payload;
}

function normalizeNumber(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function listAdvertisedVideoModels(provider) {
  const models = new Set(
    (Array.isArray(provider?.models) ? provider.models : [])
      .map((model) => cleanText(model, 240))
      .filter(Boolean),
  );
  if (models.size === 0) {
    const defaultModel = cleanText(provider?.defaultModel, 240);
    if (defaultModel) models.add(defaultModel);
  }
  return models;
}

function validateVideoModelAgainstProviders(model, providers) {
  const exactMatches = (Array.isArray(providers) ? providers : [])
    .filter((provider) => listAdvertisedVideoModels(provider).has(model));
  if (exactMatches.length === 1) return model;
  if (exactMatches.length > 1) {
    throw new VideoProjectError(
      `Video model "${model}" is advertised by multiple active video-generation providers. Use an explicit provider/model reference.`,
      'video_model_invalid',
    );
  }
  const separator = model.indexOf('/');
  const providerId = separator > 0 ? model.slice(0, separator).toLowerCase() : undefined;
  const modelId = separator > 0 ? model.slice(separator + 1) : model;
  const matches = (Array.isArray(providers) ? providers : []).filter((provider) => {
    const providerIds = [provider?.id, ...(Array.isArray(provider?.aliases) ? provider.aliases : [])]
      .map((value) => cleanText(value, 240).toLowerCase())
      .filter(Boolean);
    return (!providerId || providerIds.includes(providerId)) && listAdvertisedVideoModels(provider).has(modelId);
  });
  if (matches.length !== 1) {
    throw new VideoProjectError(
      `Video model "${model}" is not advertised by exactly one active video-generation provider. Call video_generate action:list and choose a listed model.`,
      'video_model_invalid',
    );
  }
  return model;
}

function normalizeVideoModel(value, providers) {
  const model = cleanText(value, 240);
  if (!model) return undefined;
  if (!VIDEO_MODEL_REF_RE.test(model)) {
    throw new VideoProjectError(
      `Video model "${model}" must be a model ID or provider/model reference.`,
      'video_model_invalid',
    );
  }
  return providers ? validateVideoModelAgainstProviders(model, providers) : model;
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const filePath = cleanText(value.filePath || value.path, 2_000);
  const url = cleanText(value.url, 2_000);
  if (!filePath && !url) return undefined;
  return {
    artifactId: cleanText(value.artifactId || value.id, 240) || undefined,
    filePath: filePath || undefined,
    url: url || undefined,
    title: cleanText(value.title || value.label, 300) || undefined,
    role: cleanText(value.role, 120) || 'reference',
  };
}

function normalizeArtifact(value, role = 'video') {
  const artifact = normalizeReference(value);
  if (!artifact) return undefined;
  return {
    ...artifact,
    role: cleanText(value?.role, 120) || role,
    mimeType: cleanText(value?.mimeType, 160) || undefined,
    durationSeconds: Number.isFinite(Number(value?.durationSeconds))
      ? Math.max(0, Math.min(86_400, Number(value.durationSeconds)))
      : undefined,
    width: Number.isFinite(Number(value?.width)) ? Math.max(1, Math.min(16_384, Math.floor(Number(value.width)))) : undefined,
    height: Number.isFinite(Number(value?.height)) ? Math.max(1, Math.min(16_384, Math.floor(Number(value.height)))) : undefined,
  };
}

function normalizeConstraints(value, providers) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    targetDurationSeconds: normalizeNumber(input.targetDurationSeconds, { min: 1, max: 3_600, fallback: undefined }),
    size: cleanText(input.size, 80) || undefined,
    aspectRatio: cleanText(input.aspectRatio, 40) || undefined,
    resolution: cleanText(input.resolution, 80) || undefined,
    qualityProfile: cleanText(input.qualityProfile, 120) || undefined,
    model: normalizeVideoModel(input.model, providers),
    keepOriginalAudio: input.keepOriginalAudio !== false,
    maxAttemptsPerShot: normalizeNumber(input.maxAttemptsPerShot, { min: 1, max: MAX_ATTEMPTS_PER_SHOT, fallback: 3 }),
  };
}

function normalizeQa(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = cleanText(value.status, 40).toLowerCase();
  if (!['pending', 'pass', 'fail', 'warning'].includes(status)) return undefined;
  const issues = Array.isArray(value.issues)
    ? value.issues.map((issue) => cleanText(issue, 700)).filter(Boolean).slice(0, 24)
    : [];
  return {
    status,
    deterministic: value.deterministic === true,
    semantic: value.semantic === true,
    summary: cleanText(value.summary, 1_500) || undefined,
    issues,
    reviewedAt: Number.isFinite(Number(value.reviewedAt)) ? Number(value.reviewedAt) : now(),
  };
}

function normalizeShot(value, index, constraints, projectReference, providers) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const shotId = cleanText(source.shotId || source.id, 96) || `shot-${index + 1}`;
  if (!SHOT_ID_RE.test(shotId)) {
    throw new VideoProjectError(`Shot ID "${shotId}" is invalid. Use lowercase letters, digits, _ or - and start with a letter.`, 'shot_id_invalid');
  }
  const prompt = cleanText(source.prompt, 8_000);
  if (!prompt) throw new VideoProjectError(`Shot ${shotId} requires a prompt.`, 'shot_prompt_missing');
  const reference = normalizeReference(source.reference) || (source.useProjectReference === false ? undefined : projectReference);
  const model = normalizeVideoModel(source.model, providers) || constraints.model;
  const captionPosition = cleanText(source.captionPosition, 40).toLowerCase() || 'bottom';
  if (!['top', 'center', 'bottom'].includes(captionPosition)) {
    throw new VideoProjectError(
      `Shot ${shotId} captionPosition must be top, center, or bottom.`,
      'shot_caption_position_invalid',
    );
  }
  if (modelRequiresExactlyOneReference(model) && !reference) {
    throw new VideoProjectError(
      'grok-video-1.5 requires exactly one reference image. Add a managed reference image or choose a text-to-video model.',
      'reference_image_required',
    );
  }
  return {
    shotId,
    title: cleanText(source.title, 500) || shotId,
    prompt,
    caption: cleanText(source.caption, 500) || undefined,
    captionPosition,
    durationSeconds: normalizeNumber(source.durationSeconds, { min: 1, max: 600, fallback: undefined }),
    model,
    reference,
    status: 'planned',
    attempts: [],
    acceptedAttemptId: undefined,
    retryReason: undefined,
    createdAt: now(),
    updatedAt: now(),
  };
}

function effectiveReference(shot, project) {
  return shot.reference || project.reference;
}

function modelRequiresExactlyOneReference(model) {
  return /(?:^|\/)grok-video-1\.5$/iu.test(cleanText(model, 240));
}

function shotGenerationInput(project, shot, providers) {
  const reference = effectiveReference(shot, project);
  const model = normalizeVideoModel(shot.model || project.constraints.model, providers);
  if (modelRequiresExactlyOneReference(model) && !reference) {
    throw new VideoProjectError(
      'grok-video-1.5 requires exactly one reference image. Add a managed reference image or choose a text-to-video model.',
      'reference_image_required',
    );
  }
  return {
    parentTaskId: project.projectId,
    segmentId: shot.shotId,
    prompt: shot.prompt,
    model,
    size: project.constraints.size,
    durationSeconds: shot.durationSeconds,
    aspectRatio: project.constraints.aspectRatio,
    resolution: project.constraints.resolution,
    keepOriginalAudio: project.constraints.keepOriginalAudio,
    ...(reference ? {
      image: reference.filePath || reference.url,
      imageRoles: ['reference_image'],
    } : {}),
  };
}

function validateProjectVideoModels(project, providers) {
  normalizeVideoModel(project.constraints?.model, providers);
  for (const shot of project.shots ?? []) {
    shotGenerationInput(project, shot, providers);
  }
}

function publicShot(project, shot, providers) {
  const currentAttempt = shot.attempts.at(-1);
  return {
    ...shot,
    effectiveReference: effectiveReference(shot, project),
    generationInput: shotGenerationInput(project, shot, providers),
    currentAttemptId: currentAttempt?.attemptId,
  };
}

function pendingGenerationInputs(project, providers) {
  return project.shots
    .filter((shot) => shot.status === 'planned' || shot.status === 'retry_ready')
    .map((shot) => shotGenerationInput(project, shot, providers));
}

function projectStatus(project) {
  if (project.composition?.status === 'blocked') return 'blocked';
  if (project.finalization?.status === 'blocked') return 'blocked';
  const verifiedArtifactPath = cleanText(project.composition?.finalArtifact?.filePath, 2_000);
  const finalizedArtifactPath = cleanText(project.finalization?.artifact?.filePath, 2_000);
  const hostVerified = project.composition?.finalQa?.status === 'passed'
    && Boolean(verifiedArtifactPath)
    && verifiedArtifactPath === finalizedArtifactPath;
  if (hostVerified && project.composition?.status === 'delivered' && project.finalization?.status === 'delivered') return 'completed';
  if (hostVerified && ['assembled', 'delivered'].includes(project.composition?.status)
    && ['assembled', 'delivered'].includes(project.finalization?.status)) return 'assembled';
  if (project.composition) return 'composing';
  if (project.cancelledAt) return 'cancelled';
  const shots = project.shots;
  if (shots.length === 0) return 'draft';
  if (shots.every((shot) => shot.status === 'accepted')) return 'ready_to_compose';
  if (shots.some((shot) => shot.status === 'qa_pending' || shot.status === 'produced')) return 'reviewing';
  if (shots.some((shot) => shot.status === 'generating' || shot.status === 'retry_ready')) return 'generating';
  if (shots.some((shot) => shot.status === 'rejected')) return 'blocked';
  return 'planned';
}

function updateDerivedState(project) {
  project.status = projectStatus(project);
  project.updatedAt = now();
  project.revision = Math.max(0, Number(project.revision) || 0) + 1;
  return project;
}

function projectSummary(project) {
  const count = (status) => project.shots.filter((shot) => shot.status === status).length;
  return {
    totalShots: project.shots.length,
    planned: count('planned'),
    generating: count('generating'),
    qaPending: count('qa_pending') + count('produced'),
    accepted: count('accepted'),
    retryReady: count('retry_ready'),
    rejected: count('rejected'),
  };
}

function projectResult(project, operation, providers) {
  const pendingInputs = pendingGenerationInputs(project, providers);
  const result = {
    schema: PROJECT_SCHEMA,
    ok: true,
    operation,
    pendingGenerationInputs: pendingInputs,
    project: {
      ...project,
      shots: project.shots.map((shot) => publicShot(project, shot, providers)),
      summary: projectSummary(project),
    },
  };
  if (pendingInputs.length === 1) {
    result.nextGenerationInput = pendingInputs[0];
  }
  if (project.status === 'ready_to_compose') {
    result.next = 'Every shot is accepted. Call uclaw_video_project action:compose once to create the durable Host render-or-source-QA workflow. Do not deliver any project video before that workflow reports a verified final artifact.';
  } else if (project.status === 'composing') {
    result.next = 'VideoProject composition is running or waiting for bridge delivery. Do not create another composition task; inspect this durable project state or wait for the Host completion event.';
  } else if (project.status === 'generating' || project.status === 'planned') {
    result.next = pendingInputs.length === 1
      ? 'Generate the single pending shot with video_generate using nextGenerationInput exactly as returned. Do not reconstruct parentTaskId or segmentId manually.'
      : 'Generate only planned or retry_ready shots with video_generate using each returned generationInput exactly as returned. Record every provider result with uclaw_video_shot.';
  } else if (project.status === 'reviewing') {
    result.next = 'Run deterministic Host QA and semantic review for produced shots. Record QA on the attempt, then accept it or mark the shot retry_ready.';
  } else {
    result.next = 'No media was generated by this tool. Continue from the durable project state.';
  }
  return result;
}

let operationQueue = Promise.resolve();

function enqueueOperation(work) {
  const run = operationQueue.then(work, work);
  operationQueue = run.catch(() => undefined);
  return run;
}

async function writeProject(project) {
  const dir = projectStateDir();
  await mkdir(dir, { recursive: true });
  const destination = projectFile(project.projectId);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

async function readProject(projectId) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(projectFile(projectId), 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new VideoProjectError(`VideoProject ${projectId} was not found.`, 'project_not_found');
    }
    throw new VideoProjectError(`VideoProject ${projectId} cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'project_read_failed');
  }
  if (!parsed || parsed.schema !== PROJECT_SCHEMA || !PROJECT_ID_RE.test(parsed.projectId || '')) {
    throw new VideoProjectError(`VideoProject ${projectId} has an unsupported state file.`, 'project_state_invalid');
  }
  return parsed;
}

async function ownProject(sessionKey, projectId) {
  const project = await readProject(projectId);
  if (project.sessionKey !== sessionKey) {
    throw new VideoProjectError('VideoProject belongs to another OpenClaw session.', 'project_session_mismatch');
  }
  return project;
}

function findShot(project, shotId) {
  const normalizedId = cleanText(shotId, 96);
  const shot = project.shots.find((candidate) => candidate.shotId === normalizedId);
  if (!shot) throw new VideoProjectError(`Shot ${normalizedId || '(missing)'} was not found.`, 'shot_not_found');
  return shot;
}

function latestAcceptedArtifact(project) {
  return project.shots
    .map((shot) => shot.attempts.find((attempt) => attempt.attemptId === shot.acceptedAttemptId)?.artifact)
    .filter(Boolean);
}

function parseSize(value) {
  const match = cleanText(value, 80).match(/^(\d{2,5})\s*x\s*(\d{2,5})$/iu);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseAspectRatio(value) {
  const match = cleanText(value, 40).match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u);
  if (!match) return undefined;
  const width = Number.parseFloat(match[1]);
  const height = Number.parseFloat(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

function parseResolutionShortEdge(value) {
  const normalized = cleanText(value, 80).toUpperCase();
  if (normalized === '4K') return 2_160;
  const match = normalized.match(/^(\d+)P$/u);
  if (!match) return undefined;
  const shortEdge = Number.parseInt(match[1], 10);
  return shortEdge > 0 ? shortEdge : undefined;
}

function artifactContractAssessment(project, artifact) {
  const width = Number(artifact?.width);
  const height = Number(artifact?.height);
  const actualDimensionsKnown = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const targetSize = parseSize(project.constraints?.size);
  const targetAspectRatio = targetSize
    ? targetSize.width / targetSize.height
    : parseAspectRatio(project.constraints?.aspectRatio);
  const targetShortEdge = parseResolutionShortEdge(project.constraints?.resolution);
  const requiresDimensions = Boolean(targetSize || targetAspectRatio || targetShortEdge);
  const issues = [];
  if (requiresDimensions && !actualDimensionsKnown) {
    issues.push('The generated artifact has no measured width and height.');
  }
  if (actualDimensionsKnown && targetSize && (width < targetSize.width || height < targetSize.height)) {
    issues.push(`Actual ${width}x${height} is below the required ${targetSize.width}x${targetSize.height}; upscaling is not accepted.`);
  }
  if (actualDimensionsKnown && targetShortEdge && Math.min(width, height) < targetShortEdge) {
    issues.push(`Actual short edge ${Math.min(width, height)}px is below the required ${targetShortEdge}px; upscaling is not accepted.`);
  }
  if (actualDimensionsKnown && targetAspectRatio) {
    const actualAspectRatio = width / height;
    if (Math.abs(actualAspectRatio - targetAspectRatio) / targetAspectRatio > 0.02) {
      issues.push(`Actual aspect ratio ${width}:${height} does not match the required geometry.`);
    }
  }
  return {
    status: issues.length === 0 ? 'passed' : 'blocked',
    actual: actualDimensionsKnown ? { width, height } : undefined,
    target: {
      ...(targetSize ? { width: targetSize.width, height: targetSize.height } : {}),
      ...(targetAspectRatio ? { aspectRatio: targetAspectRatio } : {}),
      ...(targetShortEdge ? { shortEdge: targetShortEdge } : {}),
    },
    issues,
  };
}

function assertArtifactMeetsGenerationContract(project, shot, artifact) {
  const assessment = artifactContractAssessment(project, artifact);
  if (assessment.status === 'blocked') {
    throw new VideoProjectError(
      `Shot ${shot.shotId} cannot be accepted: ${assessment.issues.join(' ')}`,
      assessment.actual ? 'artifact_resolution_below_contract' : 'artifact_dimensions_unverified',
    );
  }
  return assessment;
}

function evenDimension(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  if (rounded < minimum || rounded > maximum || rounded % 2 !== 0) {
    throw new VideoProjectError(`Composition dimension must be an even integer from ${minimum} to ${maximum}.`, 'composition_dimension_invalid');
  }
  return rounded;
}

function compositionFilename(value, projectId) {
  const candidate = cleanText(value, 180)
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  const fallback = `video-project-${projectId}.mp4`;
  const filename = candidate || fallback;
  return filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`;
}

function normalizeCompositionOptions(value, project) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const transition = cleanText(input.transition, 40) || 'cut';
  if (!['cut', 'crossfade', 'fade'].includes(transition)) {
    throw new VideoProjectError('Composition transition must be cut, crossfade, or fade.', 'composition_transition_invalid');
  }
  const transitionDurationSeconds = input.transitionDurationSeconds === undefined
    ? (transition === 'cut' ? 0 : 0.35)
    : Number(input.transitionDurationSeconds);
  if (!Number.isFinite(transitionDurationSeconds) || transitionDurationSeconds < 0 || transitionDurationSeconds > 5) {
    throw new VideoProjectError('Composition transitionDurationSeconds must be from 0 to 5.', 'composition_transition_duration_invalid');
  }
  const projectSize = parseSize(project.constraints?.size);
  const targetDurationSeconds = input.targetDurationSeconds === undefined
    ? project.constraints?.targetDurationSeconds
    : Number(input.targetDurationSeconds);
  if (targetDurationSeconds !== undefined && (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0 || targetDurationSeconds > 7_200)) {
    throw new VideoProjectError('Composition targetDurationSeconds must be from 0 to 7200.', 'composition_duration_invalid');
  }
  const fps = input.fps === undefined ? 30 : Number(input.fps);
  if (!Number.isInteger(fps) || fps < 12 || fps > 60) {
    throw new VideoProjectError('Composition fps must be an integer from 12 to 60.', 'composition_fps_invalid');
  }
  const narrationVolume = input.narrationVolume === undefined ? 1 : Number(input.narrationVolume);
  const backgroundMusicVolume = input.backgroundMusicVolume === undefined ? 0.18 : Number(input.backgroundMusicVolume);
  if (!Number.isFinite(narrationVolume) || narrationVolume < 0 || narrationVolume > 1
    || !Number.isFinite(backgroundMusicVolume) || backgroundMusicVolume < 0 || backgroundMusicVolume > 1) {
    throw new VideoProjectError('Composition audio volumes must be from 0 to 1.', 'composition_audio_volume_invalid');
  }
  return {
    filename: compositionFilename(input.filename, project.projectId),
    targetDurationSeconds: targetDurationSeconds === undefined ? undefined : Math.round(targetDurationSeconds * 1000) / 1000,
    width: evenDimension(input.width, projectSize?.width, 320, 7_680),
    height: evenDimension(input.height, projectSize?.height, 240, 4_320),
    fps,
    transition,
    transitionDurationSeconds: Math.round(transitionDurationSeconds * 1000) / 1000,
    narrationText: cleanText(input.narrationText, 16_000) || undefined,
    voice: cleanText(input.voice, 80) || 'zh-CN-XiaoxiaoNeural',
    narrationVolume,
    backgroundMusicPath: cleanText(input.backgroundMusicPath, 4_096) || undefined,
    backgroundMusicVolume,
    keepOriginalAudio: input.keepOriginalAudio === undefined
      ? project.constraints?.keepOriginalAudio !== false
      : input.keepOriginalAudio !== false,
    requireAudio: input.requireAudio === true,
  };
}

function acceptedCompositionSources(project) {
  if (!Array.isArray(project.shots) || project.shots.length === 0 || project.shots.some((shot) => shot.status !== 'accepted')) {
    throw new VideoProjectError('Composition requires every planned shot to be accepted.', 'composition_shots_unaccepted');
  }
  return project.shots.map((shot) => {
    const attempt = shot.attempts.find((candidate) => candidate.attemptId === shot.acceptedAttemptId);
    const artifact = attempt?.artifact;
    const sourcePath = cleanText(artifact?.filePath, 2_000);
    if (!sourcePath) {
      throw new VideoProjectError(
        `Accepted shot ${shot.shotId} has no managed local video path and cannot be composed.`,
        'composition_source_path_missing',
      );
    }
    const durationSeconds = Number(artifact?.durationSeconds ?? shot.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) {
      throw new VideoProjectError(
        `Accepted shot ${shot.shotId} has no usable duration and cannot be composed.`,
        'composition_source_duration_missing',
      );
    }
    assertArtifactMeetsGenerationContract(project, shot, artifact);
    if (!Number.isFinite(Number(artifact?.width)) || !Number.isFinite(Number(artifact?.height))) {
      throw new VideoProjectError(
        `Accepted shot ${shot.shotId} has no measured dimensions and cannot be composed safely.`,
        'composition_source_dimensions_missing',
      );
    }
    return {
      shotId: shot.shotId,
      title: shot.title,
      caption: shot.caption,
      captionPosition: shot.captionPosition || 'bottom',
      sourcePath,
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      artifact: normalizeArtifact(artifact, 'video'),
    };
  });
}

function assertCompositionDoesNotUpscale(sources, width, height) {
  for (const source of sources) {
    const sourceWidth = Number(source.artifact?.width);
    const sourceHeight = Number(source.artifact?.height);
    if (width > sourceWidth || height > sourceHeight) {
      throw new VideoProjectError(
        `Shot ${source.shotId} is ${sourceWidth}x${sourceHeight}, below the ${width}x${height} composition target. Upscaling generated source video is not accepted.`,
        'composition_source_upscale_forbidden',
      );
    }
  }
}

function needsTimelineRender(sources, options, width, height, targetDurationSeconds) {
  if (sources.length !== 1) return true;
  const source = sources[0];
  const sourceWidth = Number(source.artifact?.width);
  const sourceHeight = Number(source.artifact?.height);
  return Boolean(
    options.narrationText
    || options.backgroundMusicPath
    || options.keepOriginalAudio === false
    || source.caption
    || options.transition !== 'cut'
    || options.transitionDurationSeconds > 0
    || Math.abs(targetDurationSeconds - source.durationSeconds) > 0.05
    || width !== sourceWidth
    || height !== sourceHeight
  );
}

function buildCompositionPlan(project, options) {
  const sources = acceptedCompositionSources(project);
  const totalDurationSeconds = sources.reduce((total, source) => total + source.durationSeconds, 0);
  const targetDurationSeconds = options.targetDurationSeconds ?? totalDurationSeconds;
  if (targetDurationSeconds > totalDurationSeconds + 0.05) {
    throw new VideoProjectError(
      `Accepted shots total ${totalDurationSeconds.toFixed(3)}s, below requested composition duration ${targetDurationSeconds.toFixed(3)}s.`,
      'composition_duration_shortfall',
    );
  }
  const fallbackWidth = sources.find((source) => source.artifact?.width)?.artifact?.width ?? 1_920;
  const fallbackHeight = sources.find((source) => source.artifact?.height)?.artifact?.height ?? 1_080;
  const width = options.width ?? evenDimension(fallbackWidth, 1_920, 320, 7_680);
  const height = options.height ?? evenDimension(fallbackHeight, 1_080, 240, 4_320);
  assertCompositionDoesNotUpscale(sources, width, height);
  const mode = needsTimelineRender(sources, options, width, height, targetDurationSeconds)
    ? 'timeline'
    : 'source_qa';
  return {
    schema: COMPOSITION_SCHEMA,
    mode,
    sources,
    scenes: sources.map((source, index) => ({
      sourcePath: source.sourcePath,
      kind: 'video',
      durationSeconds: source.durationSeconds,
      motion: 'none',
      transition: index === 0 ? 'cut' : options.transition,
      transitionDurationSeconds: index === 0 ? 0 : options.transitionDurationSeconds,
      caption: source.caption,
      captionPosition: source.captionPosition,
    })),
    filename: options.filename,
    targetDurationSeconds: Math.round(targetDurationSeconds * 1000) / 1000,
    width,
    height,
    fps: options.fps,
    narrationText: options.narrationText,
    voice: options.voice,
    narrationVolume: options.narrationVolume,
    backgroundMusicPath: options.backgroundMusicPath,
    backgroundMusicVolume: options.backgroundMusicVolume,
    keepOriginalAudio: options.keepOriginalAudio,
    requireAudio: options.requireAudio,
  };
}

function hostTaskId(task) {
  const id = cleanText(task?.taskId || task?.id, 300);
  if (!id) throw new VideoProjectError('Host task start response did not include taskId.', 'host_task_id_missing');
  return id;
}

function hostTaskStatus(task) {
  return cleanText(task?.status, 80).toLowerCase() || 'unknown';
}

function hostTaskTerminal(task) {
  return ['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost'].includes(hostTaskStatus(task));
}

function hostTaskVideoArtifact(task) {
  const artifact = Array.isArray(task?.artifacts)
    ? task.artifacts.find((candidate) => cleanText(candidate?.kind, 80) === 'video' && cleanText(candidate?.filePath || candidate?.path, 2_000))
    : undefined;
  return normalizeArtifact(artifact, 'final_video');
}

function finalQaExpectedDurationSeconds(composition, sourceArtifact) {
  const actualDurationSeconds = Number(sourceArtifact?.durationSeconds);
  if (Number.isFinite(actualDurationSeconds) && actualDurationSeconds > 0) {
    return Math.round(actualDurationSeconds * 1000) / 1000;
  }
  return composition.plan.targetDurationSeconds;
}

function hostTaskVerification(task, kind) {
  return Array.isArray(task?.verifications)
    ? task.verifications.find((candidate) => cleanText(candidate?.kind, 160) === kind && cleanText(candidate?.status, 80) === 'passed')
    : undefined;
}

function compositionCorrelation(project, runId, toolCallId, attempt) {
  return {
    sessionKey: project.sessionKey,
    runId,
    toolCallId: cleanText(toolCallId, 300) || `video-project:${project.projectId}`,
    attempt,
  };
}

async function requestHostTask(request, params) {
  const task = await request('/api/task-bridge/tasks', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  hostTaskId(task);
  return task;
}

function compositionTaskRequest(project, composition) {
  return {
    schema: 'uclaw.video-project.compose-task/v1',
    kind: 'local.video.timeline.render',
    title: `Compose ${project.title}`.slice(0, 500),
    input: {
      scenes: composition.plan.scenes,
      filename: composition.plan.filename,
      targetDurationSeconds: composition.plan.targetDurationSeconds,
      width: composition.plan.width,
      height: composition.plan.height,
      fps: composition.plan.fps,
      narrationText: composition.plan.narrationText,
      voice: composition.plan.voice,
      narrationVolume: composition.plan.narrationVolume,
      backgroundMusicPath: composition.plan.backgroundMusicPath,
      backgroundMusicVolume: composition.plan.backgroundMusicVolume,
      keepOriginalAudio: composition.plan.keepOriginalAudio,
    },
    completion: { mode: 'internal' },
    correlation: {
      ...composition.correlation,
      idempotencyKey: composition.render.idempotencyKey,
    },
  };
}

function finalQaTaskRequest(project, composition, sourceArtifact) {
  return {
    schema: 'uclaw.video-project.final-qa-task/v1',
    kind: 'local.video.shot.qa',
    title: `Verify final ${project.title}`.slice(0, 500),
    input: {
      sourcePath: sourceArtifact.filePath,
      expectedDurationSeconds: finalQaExpectedDurationSeconds(composition, sourceArtifact),
      durationToleranceSeconds: 0.35,
      expectedWidth: composition.plan.width,
      expectedHeight: composition.plan.height,
      requireAudio: composition.plan.requireAudio,
      includeSourceArtifact: true,
      sampleFrameCount: 6,
    },
    completion: { mode: 'direct' },
    correlation: {
      ...composition.correlation,
      idempotencyKey: composition.qa.idempotencyKey,
    },
  };
}

function setCompositionBlocked(project, composition, error) {
  const message = cleanText(error, 1_500) || 'VideoProject composition did not complete.';
  composition.status = 'blocked';
  composition.error = message;
  composition.updatedAt = now();
  project.finalization = {
    status: 'blocked',
    artifact: undefined,
    note: message,
    updatedAt: now(),
    acceptedShotArtifacts: latestAcceptedArtifact(project).slice(0, MAX_ARTIFACTS_PER_PROJECT),
  };
}

async function ensureCompositionTask(project, request) {
  const composition = project.composition;
  if (!composition) return false;
  if (composition.plan.mode === 'source_qa') {
    if (composition.qa?.taskId) return false;
    const source = composition.plan.sources[0]?.artifact;
    if (!source?.filePath) throw new VideoProjectError('Final source video is unavailable for QA.', 'composition_source_path_missing');
    const task = await requestHostTask(request, finalQaTaskRequest(project, composition, source));
    composition.qa.taskId = hostTaskId(task);
    composition.qa.status = hostTaskStatus(task);
    composition.status = 'verifying';
    composition.updatedAt = now();
    return true;
  }
  if (composition.render?.taskId) return false;
  const task = await requestHostTask(request, compositionTaskRequest(project, composition));
  composition.render.taskId = hostTaskId(task);
  composition.render.status = hostTaskStatus(task);
  composition.status = composition.render.status === 'succeeded' ? 'rendered' : 'rendering';
  composition.updatedAt = now();
  return true;
}

async function getHostTask(request, taskId, sessionKey) {
  const query = new URLSearchParams({ sessionKey });
  return await request(`/api/task-bridge/tasks/${encodeURIComponent(taskId)}?${query.toString()}`);
}

async function synchronizeProjectComposition(project, request = hostApiFetch) {
  const composition = project.composition;
  if (!composition || ['delivered', 'blocked'].includes(composition.status)) return { changed: false, project };
  let changed = false;
  try {
    if (!composition.render?.taskId && !composition.qa?.taskId) {
      changed = await ensureCompositionTask(project, request) || changed;
    }

    if (composition.render?.taskId && !composition.qa?.taskId) {
      const task = await getHostTask(request, composition.render.taskId, project.sessionKey);
      const status = hostTaskStatus(task);
      if (composition.render.status !== status) {
        composition.render.status = status;
        composition.updatedAt = now();
        changed = true;
      }
      if (status === 'succeeded') {
        const artifact = hostTaskVideoArtifact(task);
        if (!artifact?.filePath) {
          throw new VideoProjectError('Composition task succeeded without a verified final video artifact.', 'composition_artifact_missing');
        }
        composition.render.artifact = artifact;
        if (!composition.qa) {
          composition.qa = {
            idempotencyKey: `${PLUGIN_ID}:${project.projectId}:compose:${composition.attempt}:final-qa`,
          };
        }
        const qaTask = await requestHostTask(request, finalQaTaskRequest(project, composition, artifact));
        composition.qa.taskId = hostTaskId(qaTask);
        composition.qa.status = hostTaskStatus(qaTask);
        composition.status = 'verifying';
        composition.updatedAt = now();
        changed = true;
      } else if (hostTaskTerminal(task)) {
        setCompositionBlocked(project, composition, task?.error || `Composition task finished with ${status}.`);
        changed = true;
      }
    }

    if (composition.qa?.taskId) {
      const task = await getHostTask(request, composition.qa.taskId, project.sessionKey);
      const status = hostTaskStatus(task);
      if (composition.qa.status !== status) {
        composition.qa.status = status;
        composition.updatedAt = now();
        changed = true;
      }
      if (status === 'succeeded') {
        const artifact = hostTaskVideoArtifact(task);
        const qa = hostTaskVerification(task, 'media.shot.qa');
        const metadata = hostTaskVerification(task, 'media.metadata');
        if (!artifact?.filePath || !qa || !metadata) {
          throw new VideoProjectError('Final video QA completed without required artifact or verification evidence.', 'composition_final_qa_missing');
        }
        const deliveryStatus = cleanText(task?.delivery?.status, 80);
        const nextStatus = deliveryStatus === 'delivered' ? 'delivered' : 'assembled';
        const finalizationStatus = nextStatus === 'delivered' ? 'delivered' : 'assembled';
        if (
          composition.status !== nextStatus
          || composition.finalArtifact?.filePath !== artifact.filePath
          || project.finalization?.status !== finalizationStatus
          || project.finalization?.artifact?.filePath !== artifact.filePath
        ) {
          composition.finalArtifact = artifact;
          composition.finalQa = {
            status: 'passed',
            taskId: composition.qa.taskId,
            verification: {
              detail: cleanText(qa.detail, 1_500) || undefined,
              evidence: cleanText(qa.evidence, 2_000) || undefined,
            },
            metadata: {
              detail: cleanText(metadata.detail, 1_500) || undefined,
            },
            updatedAt: now(),
          };
          composition.status = nextStatus;
          composition.updatedAt = now();
          project.finalization = {
            status: finalizationStatus,
            artifact,
            note: deliveryStatus === 'delivered'
              ? 'Final video QA passed and delivery was acknowledged by the UClaw task bridge.'
              : 'Final video QA passed; waiting for the UClaw task bridge delivery acknowledgement.',
            updatedAt: now(),
            acceptedShotArtifacts: latestAcceptedArtifact(project).slice(0, MAX_ARTIFACTS_PER_PROJECT),
          };
          changed = true;
        }
      } else if (hostTaskTerminal(task)) {
        setCompositionBlocked(project, composition, task?.error || `Final video QA finished with ${status}.`);
        changed = true;
      }
    }
  } catch (error) {
    setCompositionBlocked(project, composition, error instanceof Error ? error.message : String(error));
    changed = true;
  }
  if (changed) {
    updateDerivedState(project);
    await writeProject(project);
  }
  return { changed, project };
}

async function startProjectComposition(project, params, correlation, request = hostApiFetch) {
  const existing = project.composition;
  if (existing && ['starting', 'rendering', 'rendered', 'verifying'].includes(existing.status)) {
    await synchronizeProjectComposition(project, request);
    return project;
  }
  if (existing && ['assembled', 'delivered'].includes(existing.status) && params.retry !== true) {
    throw new VideoProjectError('This VideoProject already has a verified final composition.', 'composition_already_completed');
  }
  const attempt = (Number(existing?.attempt) || 0) + 1;
  const options = normalizeCompositionOptions({
    ...(project.compositionSpec || {}),
    ...(params.composition || {}),
  }, project);
  project.compositionSpec = options;
  const plan = buildCompositionPlan(project, options);
  project.composition = {
    schema: COMPOSITION_SCHEMA,
    attempt,
    status: 'starting',
    plan,
    correlation,
    render: plan.mode === 'timeline'
      ? { idempotencyKey: `${PLUGIN_ID}:${project.projectId}:compose:${attempt}:render` }
      : undefined,
    qa: plan.mode === 'source_qa'
      ? { idempotencyKey: `${PLUGIN_ID}:${project.projectId}:compose:${attempt}:final-qa` }
      : undefined,
    createdAt: now(),
    updatedAt: now(),
  };
  project.finalization = { status: 'pending', artifact: undefined, note: undefined, updatedAt: now() };
  updateDerivedState(project);
  await writeProject(project);
  await ensureCompositionTask(project, request);
  updateDerivedState(project);
  await writeProject(project);
  return project;
}

function buildError(operation, error) {
  const payload = {
    schema: PROJECT_SCHEMA,
    ok: false,
    operation,
    code: error instanceof VideoProjectError ? error.code : 'video_project_error',
    error: error instanceof Error ? error.message : String(error),
  };
  return { content: [{ type: 'text', text: safeJson(payload) }], details: payload };
}

const REFERENCE_SCHEMA = Type.Object({
  artifactId: Type.Optional(Type.String({ maxLength: 240 })),
  filePath: Type.Optional(Type.String({ maxLength: 2_000 })),
  path: Type.Optional(Type.String({ maxLength: 2_000 })),
  url: Type.Optional(Type.String({ maxLength: 2_000 })),
  title: Type.Optional(Type.String({ maxLength: 300 })),
  label: Type.Optional(Type.String({ maxLength: 300 })),
  role: Type.Optional(Type.String({ maxLength: 120 })),
}, { additionalProperties: false });

const CONSTRAINTS_SCHEMA = Type.Object({
  targetDurationSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600 })),
  size: Type.Optional(Type.String({ maxLength: 80 })),
  aspectRatio: Type.Optional(Type.String({ maxLength: 40 })),
  resolution: Type.Optional(Type.String({ maxLength: 80 })),
  qualityProfile: Type.Optional(Type.String({ maxLength: 120 })),
  model: Type.Optional(Type.String({ maxLength: 240 })),
  keepOriginalAudio: Type.Optional(Type.Boolean()),
  maxAttemptsPerShot: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ATTEMPTS_PER_SHOT })),
}, { additionalProperties: false });

const SHOT_SCHEMA = Type.Object({
  shotId: Type.Optional(Type.String({ maxLength: 96 })),
  id: Type.Optional(Type.String({ maxLength: 96 })),
  title: Type.Optional(Type.String({ maxLength: 500 })),
  prompt: Type.String({ minLength: 1, maxLength: 8_000 }),
  caption: Type.Optional(Type.String({ maxLength: 500 })),
  captionPosition: Type.Optional(Type.Union([
    Type.Literal('top'),
    Type.Literal('center'),
    Type.Literal('bottom'),
  ])),
  durationSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
  model: Type.Optional(Type.String({ maxLength: 240 })),
  reference: Type.Optional(REFERENCE_SCHEMA),
  useProjectReference: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const QA_SCHEMA = Type.Object({
  status: Type.Union([Type.Literal('pending'), Type.Literal('pass'), Type.Literal('fail'), Type.Literal('warning')]),
  deterministic: Type.Optional(Type.Boolean()),
  semantic: Type.Optional(Type.Boolean()),
  summary: Type.Optional(Type.String({ maxLength: 1_500 })),
  issues: Type.Optional(Type.Array(Type.String({ maxLength: 700 }), { maxItems: 24 })),
  reviewedAt: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const ARTIFACT_SCHEMA = Type.Object({
  artifactId: Type.Optional(Type.String({ maxLength: 240 })),
  id: Type.Optional(Type.String({ maxLength: 240 })),
  filePath: Type.Optional(Type.String({ maxLength: 2_000 })),
  path: Type.Optional(Type.String({ maxLength: 2_000 })),
  url: Type.Optional(Type.String({ maxLength: 2_000 })),
  title: Type.Optional(Type.String({ maxLength: 300 })),
  label: Type.Optional(Type.String({ maxLength: 300 })),
  role: Type.Optional(Type.String({ maxLength: 120 })),
  mimeType: Type.Optional(Type.String({ maxLength: 160 })),
  durationSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86_400 })),
  width: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
  height: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
}, { additionalProperties: false });

const COMPOSITION_REQUEST_SCHEMA = Type.Object({
  filename: Type.Optional(Type.String({ maxLength: 180 })),
  targetDurationSeconds: Type.Optional(Type.Number({ minimum: 0.25, maximum: 7200 })),
  width: Type.Optional(Type.Integer({ minimum: 320, maximum: 7680, multipleOf: 2 })),
  height: Type.Optional(Type.Integer({ minimum: 240, maximum: 4320, multipleOf: 2 })),
  fps: Type.Optional(Type.Integer({ minimum: 12, maximum: 60 })),
  transition: Type.Optional(Type.Union([Type.Literal('cut'), Type.Literal('crossfade'), Type.Literal('fade')])),
  transitionDurationSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
  narrationText: Type.Optional(Type.String({ maxLength: 16_000 })),
  voice: Type.Optional(Type.String({ maxLength: 80 })),
  narrationVolume: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  backgroundMusicPath: Type.Optional(Type.String({ maxLength: 4_096 })),
  backgroundMusicVolume: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  keepOriginalAudio: Type.Optional(Type.Boolean()),
  requireAudio: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

function createTools(toolContext, options = {}) {
  const request = options.hostApiFetch || hostApiFetch;
  const videoProviders = () => typeof options.listVideoProviders === 'function'
    ? options.listVideoProviders()
    : options.videoProviders;
  return [
    {
      name: 'uclaw_video_project',
      label: 'UClaw VideoProject',
      description: 'Create, inspect, compose, list, or finalize a durable video project. This tool never calls a video provider. After every shot is accepted, action:compose chooses verified source pass-through or one idempotent Host timeline render, then runs final QA; only that Host-verified artifact is delivered.',
      promptSnippet: 'Use uclaw_video_project for durable video state, not for provider generation. Create once per user video goal and persist intended narration, captions, audio policy, and output geometry in composition. Reuse its projectId as video_generate parentTaskId and the returned shotId as segmentId. When the project result exposes nextGenerationInput or a shot generationInput, copy that object exactly; do not reconstruct or omit parentTaskId or segmentId. Keep provider output and QA evidence in the project. When every shot is accepted, call action:compose exactly once and wait for its durable Host final-QA result before delivery. Never upscale or manually finalize a blocked source.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('create'), Type.Literal('get'), Type.Literal('list'), Type.Literal('compose'), Type.Literal('finalize')]),
        projectId: Type.Optional(Type.String({ maxLength: 120 })),
        title: Type.Optional(Type.String({ maxLength: 500 })),
        goal: Type.Optional(Type.String({ maxLength: 4_000 })),
        constraints: Type.Optional(CONSTRAINTS_SCHEMA),
        reference: Type.Optional(REFERENCE_SCHEMA),
        shots: Type.Optional(Type.Array(SHOT_SCHEMA, { maxItems: MAX_SHOTS_PER_PROJECT })),
        composition: Type.Optional(COMPOSITION_REQUEST_SCHEMA),
        retry: Type.Optional(Type.Boolean()),
        finalizationStatus: Type.Optional(Type.Union([
          Type.Literal('ready_to_compose'),
          Type.Literal('assembled'),
          Type.Literal('delivered'),
          Type.Literal('blocked'),
        ])),
        artifact: Type.Optional(ARTIFACT_SCHEMA),
        note: Type.Optional(Type.String({ maxLength: 1_500 })),
      }, { additionalProperties: false }),
      async execute(toolCallId, params) {
        const operation = params.action;
        try {
          const sessionKey = sessionKeyFromContext(toolContext);
          const result = await enqueueOperation(async () => {
            if (operation === 'create') {
              const title = cleanText(params.title, 500);
              const goal = cleanText(params.goal, 4_000);
              if (!title || !goal) throw new VideoProjectError('Creating a VideoProject requires both title and goal.', 'project_create_input_missing');
              const existing = await listProjects(sessionKey);
              if (existing.length >= MAX_PROJECTS_PER_SESSION) {
                throw new VideoProjectError('This session already reached its VideoProject limit.', 'project_limit_reached');
              }
              const providers = videoProviders();
              const constraints = normalizeConstraints(params.constraints, providers);
              const reference = normalizeReference(params.reference);
              const shots = (params.shots || []).map((shot, index) => normalizeShot(shot, index, constraints, reference, providers));
              if (new Set(shots.map((shot) => shot.shotId)).size !== shots.length) {
                throw new VideoProjectError('Shot IDs must be unique inside one VideoProject.', 'shot_id_duplicate');
              }
              const createdAt = now();
              const project = {
                schema: PROJECT_SCHEMA,
                projectId: `video-project-${randomUUID()}`,
                sessionKey,
                title,
                goal,
                constraints,
                reference,
                shots,
                status: 'draft',
                finalization: { status: 'pending', artifact: undefined, note: undefined, updatedAt: createdAt },
                createdAt,
                updatedAt: createdAt,
                revision: 0,
              };
              project.compositionSpec = normalizeCompositionOptions(params.composition, project);
              updateDerivedState(project);
              await writeProject(project);
              return projectResult(project, 'create', providers);
            }
            if (operation === 'list') {
              const projects = await listProjects(sessionKey);
              return {
                schema: PROJECT_SCHEMA,
                ok: true,
                operation: 'list',
                projects: projects.map((project) => ({
                  projectId: project.projectId,
                  title: project.title,
                  goal: project.goal,
                  status: project.status,
                  revision: project.revision,
                  updatedAt: project.updatedAt,
                  summary: projectSummary(project),
                })),
                next: 'Use get with a projectId before continuing or recovering a project.',
              };
            }
            const projectId = cleanText(params.projectId, 120);
            if (!projectId) throw new VideoProjectError(`${operation} requires projectId.`, 'project_id_missing');
            const project = await ownProject(sessionKey, projectId);
            validateProjectVideoModels(project, videoProviders());
            if (operation === 'get') {
              await synchronizeProjectComposition(project, request);
              return projectResult(project, 'get', videoProviders());
            }
            if (operation === 'compose') {
              const correlation = compositionCorrelation(
                project,
                runIdFromContext(toolContext),
                toolCallId,
                (Number(project.composition?.attempt) || 0) + 1,
              );
              await startProjectComposition(project, params, correlation, request);
              return projectResult(project, 'compose', videoProviders());
            }
            const finalizationStatus = params.finalizationStatus;
            if (!finalizationStatus) throw new VideoProjectError('Finalizing a VideoProject requires finalizationStatus.', 'finalization_status_missing');
            if (['ready_to_compose', 'assembled', 'delivered'].includes(finalizationStatus) && project.shots.some((shot) => shot.status !== 'accepted')) {
              throw new VideoProjectError('All planned shots must be accepted before this finalization state.', 'finalization_shots_unaccepted');
            }
            const artifact = normalizeArtifact(params.artifact, 'final_video');
            if (['assembled', 'delivered'].includes(finalizationStatus) && !artifact) {
              throw new VideoProjectError('Assembled or delivered projects require the verified final video artifact.', 'finalization_artifact_missing');
            }
            if (['assembled', 'delivered'].includes(finalizationStatus)) {
              if (project.composition?.status === 'blocked') {
                throw new VideoProjectError(
                  'Blocked Host composition or final QA cannot be overwritten by manual finalization.',
                  'finalization_composition_blocked',
                );
              }
              const hostArtifactPath = cleanText(project.composition?.finalArtifact?.filePath, 2_000);
              const requestedArtifactPath = cleanText(artifact?.filePath, 2_000);
              const hostStatusAllowsConfirmation = finalizationStatus === 'delivered'
                ? project.composition?.status === 'delivered'
                : ['assembled', 'delivered'].includes(project.composition?.status);
              if (
                !hostStatusAllowsConfirmation
                || project.composition?.finalQa?.status !== 'passed'
                || !hostArtifactPath
                || hostArtifactPath !== requestedArtifactPath
              ) {
                throw new VideoProjectError(
                  'Assembled or delivered can only confirm the same artifact already passed by Host final QA.',
                  'finalization_host_verification_required',
                );
              }
              project.finalization = {
                ...project.finalization,
                note: cleanText(params.note, 1_500) || project.finalization?.note,
                updatedAt: now(),
              };
              updateDerivedState(project);
              await writeProject(project);
              return projectResult(project, 'finalize', videoProviders());
            }
            project.finalization = {
              status: finalizationStatus,
              artifact: artifact || project.finalization?.artifact,
              note: cleanText(params.note, 1_500) || undefined,
              updatedAt: now(),
              acceptedShotArtifacts: latestAcceptedArtifact(project).slice(0, MAX_ARTIFACTS_PER_PROJECT),
            };
            updateDerivedState(project);
            await writeProject(project);
            return projectResult(project, 'finalize', videoProviders());
          });
          return { content: [{ type: 'text', text: safeJson(result) }], details: result };
        } catch (error) {
          return buildError(operation, error);
        }
      },
    },
    {
      name: 'uclaw_video_shot',
      label: 'UClaw VideoProject shot',
      description: 'Maintain one durable VideoProject shot. Use upsert to add or revise the plan before generation, record_attempt after video_generate returns, accept only after deterministic and semantic QA plus measured geometry, and retry after a failed review. This tool never submits a provider job itself.',
      promptSnippet: 'After video_generate returns, immediately record its provider task ID and measured output artifact with uclaw_video_shot. Run deterministic Host QA and semantic review before accepting. A source below the project geometry contract is blocked and must be retried, never upscaled. A retry preserves failed-attempt evidence and makes the same shot eligible for one new video_generate attempt.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('upsert'), Type.Literal('record_attempt'), Type.Literal('accept'), Type.Literal('retry')]),
        projectId: Type.String({ minLength: 1, maxLength: 120 }),
        shotId: Type.Optional(Type.String({ maxLength: 96 })),
        shot: Type.Optional(SHOT_SCHEMA),
        attemptId: Type.Optional(Type.String({ maxLength: 120 })),
        attemptStatus: Type.Optional(Type.Union([Type.Literal('submitted'), Type.Literal('succeeded'), Type.Literal('failed')])),
        providerTaskId: Type.Optional(Type.String({ maxLength: 300 })),
        artifact: Type.Optional(ARTIFACT_SCHEMA),
        qa: Type.Optional(QA_SCHEMA),
        reason: Type.Optional(Type.String({ maxLength: 1_500 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const operation = params.action;
        try {
          const sessionKey = sessionKeyFromContext(toolContext);
          const result = await enqueueOperation(async () => {
            const project = await ownProject(sessionKey, cleanText(params.projectId, 120));
            validateProjectVideoModels(project, videoProviders());
            if (project.status === 'completed' || project.status === 'assembled' || project.status === 'cancelled') {
              throw new VideoProjectError('Completed or cancelled VideoProjects cannot change shots.', 'project_terminal');
            }
            if (operation === 'upsert') {
              if (!params.shot) throw new VideoProjectError('upsert requires shot.', 'shot_input_missing');
              const providers = videoProviders();
              const normalized = normalizeShot(params.shot, project.shots.length, project.constraints, project.reference, providers);
              const existing = project.shots.find((candidate) => candidate.shotId === normalized.shotId);
              if (existing) {
                if (existing.attempts.length > 0) {
                  throw new VideoProjectError('A shot with attempts cannot be rewritten. Create a retry or a new shot ID.', 'shot_has_attempts');
                }
                Object.assign(existing, normalized, { createdAt: existing.createdAt, updatedAt: now() });
              } else {
                if (project.shots.length >= MAX_SHOTS_PER_PROJECT) {
                  throw new VideoProjectError('This VideoProject reached its shot limit.', 'shot_limit_reached');
                }
                project.shots.push(normalized);
              }
            } else {
              const shot = findShot(project, params.shotId);
              if (shot.status === 'accepted') {
                throw new VideoProjectError('Accepted shots cannot be changed. Create a new project revision for further generation.', 'shot_accepted');
              }
              if (operation === 'record_attempt') {
                const attemptStatus = params.attemptStatus;
                if (!attemptStatus) throw new VideoProjectError('record_attempt requires attemptStatus.', 'attempt_status_missing');
                const requestedAttemptId = cleanText(params.attemptId, 120);
                let attempt = requestedAttemptId ? shot.attempts.find((candidate) => candidate.attemptId === requestedAttemptId) : undefined;
                if (!attempt) {
                  if (shot.attempts.length >= project.constraints.maxAttemptsPerShot) {
                    throw new VideoProjectError('This shot exhausted its configured retry budget.', 'attempt_limit_reached');
                  }
                  attempt = {
                    attemptId: requestedAttemptId || `attempt-${shot.attempts.length + 1}-${randomUUID().slice(0, 8)}`,
                    createdAt: now(),
                    status: 'submitted',
                  };
                  shot.attempts.push(attempt);
                }
                attempt.status = attemptStatus;
                attempt.providerTaskId = cleanText(params.providerTaskId, 300) || attempt.providerTaskId;
                attempt.artifact = normalizeArtifact(params.artifact) || attempt.artifact;
                attempt.artifactContract = attempt.artifact
                  ? artifactContractAssessment(project, attempt.artifact)
                  : undefined;
                attempt.qa = normalizeQa(params.qa) || attempt.qa;
                attempt.error = attemptStatus === 'failed' ? cleanText(params.reason, 1_500) || 'Provider generation failed.' : undefined;
                attempt.updatedAt = now();
                if (attemptStatus === 'submitted') shot.status = 'generating';
                if (attemptStatus === 'succeeded') shot.status = attempt.qa?.status === 'pass' ? 'produced' : 'qa_pending';
                if (attemptStatus === 'failed') shot.status = shot.attempts.length >= project.constraints.maxAttemptsPerShot ? 'rejected' : 'retry_ready';
                shot.updatedAt = now();
              } else if (operation === 'accept') {
                const attempt = params.attemptId
                  ? shot.attempts.find((candidate) => candidate.attemptId === cleanText(params.attemptId, 120))
                  : shot.attempts.at(-1);
                if (!attempt || attempt.status !== 'succeeded' || !attempt.artifact) {
                  throw new VideoProjectError('Accept requires a succeeded attempt with a video artifact.', 'accept_attempt_invalid');
                }
                const qa = normalizeQa(params.qa) || attempt.qa;
                if (!qa || qa.status !== 'pass' || qa.deterministic !== true || qa.semantic !== true) {
                  throw new VideoProjectError('Accept requires a passing deterministic and semantic QA result.', 'accept_qa_missing');
                }
                attempt.artifactContract = assertArtifactMeetsGenerationContract(project, shot, attempt.artifact);
                attempt.qa = qa;
                attempt.acceptedAt = now();
                shot.status = 'accepted';
                shot.acceptedAttemptId = attempt.attemptId;
                shot.retryReason = undefined;
                shot.updatedAt = now();
              } else {
                if (shot.status === 'accepted') {
                  throw new VideoProjectError('Accepted shots cannot be retried without creating a new project revision.', 'retry_accepted_shot');
                }
                if (shot.attempts.length >= project.constraints.maxAttemptsPerShot) {
                  shot.status = 'rejected';
                  shot.retryReason = cleanText(params.reason, 1_500) || 'Retry budget exhausted.';
                } else {
                  shot.status = 'retry_ready';
                  shot.retryReason = cleanText(params.reason, 1_500) || 'QA or creative review requested another attempt.';
                }
                shot.updatedAt = now();
              }
            }
            updateDerivedState(project);
            await writeProject(project);
            return projectResult(project, operation, videoProviders());
          });
          return { content: [{ type: 'text', text: safeJson(result) }], details: result };
        } catch (error) {
          return buildError(operation, error);
        }
      },
    },
  ];
}

async function listProjects(sessionKey) {
  let entries = [];
  try {
    entries = await readdir(projectStateDir(), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw new VideoProjectError(`VideoProject state directory cannot be listed: ${error instanceof Error ? error.message : String(error)}`, 'project_list_failed');
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const projectId = entry.name.slice(0, -'.json'.length);
    if (!PROJECT_ID_RE.test(projectId)) continue;
    try {
      const project = await readProject(projectId);
      if (project.sessionKey === sessionKey) projects.push(project);
    } catch {
      // One corrupted historical project must not hide valid projects in this session.
    }
  }
  return projects.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)).slice(0, MAX_PROJECTS_PER_SESSION);
}

async function listAllProjects() {
  let entries = [];
  try {
    entries = await readdir(projectStateDir(), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw new VideoProjectError(`VideoProject state directory cannot be listed: ${error instanceof Error ? error.message : String(error)}`, 'project_list_failed');
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const projectId = entry.name.slice(0, -'.json'.length);
    if (!PROJECT_ID_RE.test(projectId)) continue;
    try {
      projects.push(await readProject(projectId));
    } catch {
      // Corrupted historical files must not prevent recovery of other projects.
    }
  }
  return projects;
}

function createCompositionMonitor(options = {}) {
  const request = options.hostApiFetch || hostApiFetch;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(250, Math.floor(options.intervalMs))
    : COMPOSITION_MONITOR_INTERVAL_MS;
  let timer;
  let polling = false;

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const projects = await listAllProjects();
      for (const project of projects) {
        if (!project.composition || ['delivered', 'blocked'].includes(project.composition.status)) continue;
        await enqueueOperation(async () => {
          await synchronizeProjectComposition(project, request);
        });
      }
    } finally {
      polling = false;
    }
  }

  return {
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), intervalMs);
      timer.unref?.();
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Video Project',
  description: 'Stores durable video project and shot state while leaving planning, generation, QA, and composition to their owning layers.',
  register(api) {
    api.registerTool((toolContext) => createTools(toolContext, {
      listVideoProviders: () => listRuntimeVideoGenerationProviders({ config: api.config }),
    }), { names: TOOL_NAMES });
    const monitor = createCompositionMonitor();
    api.registerService({
      id: 'uclaw-video-project-composition-monitor',
      start() {
        monitor.start();
      },
      stop() {
        monitor.stop();
      },
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: 'uclaw-video-project-composition-cleanup',
      cleanup() {
        monitor.stop();
      },
    });
  },
});

export default pluginEntry;

export const __test = {
  VideoProjectError,
  validateVideoModelAgainstProviders,
  normalizeVideoModel,
  normalizeConstraints,
  normalizeShot,
  modelRequiresExactlyOneReference,
  shotGenerationInput,
  validateProjectVideoModels,
  projectStatus,
  artifactContractAssessment,
  assertArtifactMeetsGenerationContract,
  createTools,
  normalizeCompositionOptions,
  buildCompositionPlan,
  needsTimelineRender,
  startProjectComposition,
  synchronizeProjectComposition,
  createCompositionMonitor,
};
