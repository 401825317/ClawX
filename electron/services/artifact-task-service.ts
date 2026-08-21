import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile, type FileHandle } from 'fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import type {
  ArtifactRuntimePolicy,
  ArtifactTaskIntent,
  ArtifactTaskKind,
  ArtifactTaskMode,
  ArtifactTaskPreparePayload,
  ArtifactTaskPrepareResult,
  ArtifactRuntimeFeatureFlags,
  ArtifactWebpageValidationPayload,
  ArtifactWebpageValidationResult,
} from '../../shared/artifact-tasks';
import {
  getManagedClientRuntimeConfigSnapshot,
  subscribeManagedClientRuntimeConfig,
} from './managed-client-config-service';
import { resolveOpenClawStateDir } from '../utils/paths';
import { logger } from '../utils/logger';
import { captureHandledException } from '../utils/telemetry';
import { toManagedClientTextModelRef } from '../../shared/managed-client-config';
import { getOrCreateInstallationId } from '../utils/installation-id';
import {
  MAX_WORKSPACE_HTML_BYTES,
  WorkspaceHtmlPreviewService,
} from './workspace-html-preview';

type ArtifactSessionRecord = {
  sessionKey: string;
  agentId: string;
  workspaceRoot: string;
  kind: ArtifactTaskKind;
  skillId: string;
  targetFile?: string;
  updatedAt: string;
};

type ArtifactTaskStore = {
  version: 1;
  sessions: Record<string, ArtifactSessionRecord>;
};

type ArtifactRunMetrics = {
  preparedAtMs: number;
  dispatchedAtMs?: number;
  firstTextAtMs?: number;
  toolCallIds: Set<string>;
  repairCount: number;
};

const CREATE_INTENT = /(?:创建|新建|生成|制作|做一(?:个|份|套)|写一(?:个|份)|帮我做|create|generate|build|make|draft)/iu;
const MODIFY_INTENT = /(?:修改|调整|优化|更新|改一下|重做|继续完善|精修|\b(?:revise|modify|update|edit|refine)\b)/iu;
const REFINED_INTENT = /(?:精修|高级设计|高端设计|专业设计|搜索素材|联网找素材|视觉大片|refine|premium design|search (?:for )?assets)/iu;

const KIND_PATTERNS: Array<[ArtifactTaskKind, RegExp]> = [
  ['ecommerce-main-image', /(?:电商主图|商品主图|白底主图|商品场景图|商品卖点图|e-?commerce main image|product hero image)/iu],
  ['cad', /(?:\bcad\b|\bdxf\b|\bdwg\b|可编辑(?:的)?(?:cad)?图纸|建筑平面图|cad drawing|editable drawing|floor plan drawing)/iu],
  ['presentation', /(?:\bpptx?\b|演示文稿|幻灯片|slide deck|presentation)/iu],
  ['spreadsheet', /(?:\bxlsx?\b|\bexcel\b|电子表格|工作簿|数据表格|spreadsheet|workbook)/iu],
  ['webpage', /(?:\bhtml\b|网页|网站页面|网页应用|web\s*(?:page|app)|landing page)/iu],
  ['document', /(?:\bdocx?\b|\bword\b|文档|报告文件|方案书|合同文件|document)/iu],
];

const SKILL_BY_KIND: Record<ArtifactTaskKind, string> = {
  presentation: 'presentation-maker',
  document: 'document-maker',
  spreadsheet: 'spreadsheet-maker',
  webpage: 'uclaw-local-artifacts',
  cad: 'cad-editor',
  'ecommerce-main-image': 'ecommerce-main-image',
};
const SUPPORTED_PROMPT_CONTRACTS = new Set([
  'presentation-maker:v1',
  'document-maker:v1',
  'spreadsheet-maker:v1',
  'uclaw-local-artifacts:v1',
  'cad-editor:v1',
  'ecommerce-main-image:v1',
]);

function classifyKind(message: string): ArtifactTaskKind | null {
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

function classifyIntent(message: string): ArtifactTaskIntent | null {
  if (MODIFY_INTENT.test(message)) return 'modify';
  if (CREATE_INTENT.test(message)) return 'create';
  return null;
}

function policyFileName(sessionKey: string): string {
  return `${createHash('sha256').update(sessionKey).digest('hex')}.json`;
}

function rolloutBucket(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % 10_000;
}

function safeAgentId(agentId: string): string {
  const normalized = agentId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'main';
}

function newArtifactSessionKey(agentId: string): string {
  return `agent:${safeAgentId(agentId)}:session-artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const pathFromRoot = relative(resolve(workspaceRoot), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

type FileStats = Awaited<ReturnType<FileHandle['stat']>>;

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function sameFileIdentity(left: FileStats, right: FileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: FileStats, right: FileStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableWorkspaceHtml(
  requestedWorkspaceRoot: string,
  requestedFilePath: string,
  workspaceRoot: string,
  filePath: string,
): Promise<Buffer> {
  const workspaceBefore = await stat(workspaceRoot);
  if (!workspaceBefore.isDirectory()) throw new Error('Workspace root is not a directory');

  const handle = await open(filePath, 'r');
  try {
    const fileBefore = await handle.stat();
    if (!fileBefore.isFile()) throw new Error('Workspace HTML preview is not a regular file');
    if (!Number.isSafeInteger(fileBefore.size) || fileBefore.size > MAX_WORKSPACE_HTML_BYTES) {
      throw new Error('Workspace HTML preview exceeds the 20 MB limit');
    }

    const [workspaceAfterOpen, fileAfterOpen] = await Promise.all([
      realpath(resolve(requestedWorkspaceRoot)),
      realpath(resolve(requestedFilePath)),
    ]);
    if (!samePath(workspaceRoot, workspaceAfterOpen) || !samePath(filePath, fileAfterOpen)) {
      throw new Error('Workspace HTML preview path changed during authorization');
    }
    const pathStatsAfterOpen = await stat(fileAfterOpen);
    if (!sameFileIdentity(fileBefore, pathStatsAfterOpen)) {
      throw new Error('Workspace HTML preview file identity changed during authorization');
    }

    const capacity = Math.min(MAX_WORKSPACE_HTML_BYTES + 1, fileBefore.size + 1);
    const buffer = Buffer.allocUnsafe(capacity);
    let bytesRead = 0;
    while (bytesRead < capacity) {
      const result = await handle.read(buffer, bytesRead, capacity - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const fileAfterRead = await handle.stat();
    const [workspaceAfterRead, fileAfterReadPath] = await Promise.all([
      realpath(resolve(requestedWorkspaceRoot)),
      realpath(resolve(requestedFilePath)),
    ]);
    const [workspacePathAfterRead, filePathAfterRead] = await Promise.all([
      stat(workspaceAfterRead),
      stat(fileAfterReadPath),
    ]);
    if (
      bytesRead !== fileBefore.size
      || bytesRead > MAX_WORKSPACE_HTML_BYTES
      || !samePath(workspaceRoot, workspaceAfterRead)
      || !samePath(filePath, fileAfterReadPath)
      || !sameFileIdentity(workspaceBefore, workspacePathAfterRead)
      || !sameFileVersion(fileBefore, fileAfterRead)
      || !sameFileIdentity(fileAfterRead, filePathAfterRead)
    ) {
      throw new Error('Workspace HTML preview changed while being read');
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

type ManagedFeatureSwitch = {
  enabled?: unknown;
};

function runtimeFeatureFlags(config: ReturnType<typeof getManagedClientRuntimeConfigSnapshot>['config']): ArtifactRuntimeFeatureFlags {
  const features = config.features as typeof config.features & {
    htmlPreview?: ManagedFeatureSwitch;
    longTermRules?: ManagedFeatureSwitch;
  };
  return {
    artifacts: features.artifacts.enabled === true,
    // A missing switch must fail closed. This lets the server immediately stop
    // future behavior without granting legacy configurations a new capability.
    htmlPreview: features.htmlPreview?.enabled === true,
    longTermRules: features.longTermRules?.enabled === true,
  };
}

function matchesKnownTarget(message: string, record: ArtifactSessionRecord): boolean {
  const normalized = message.toLowerCase();
  const basename = record.targetFile?.split(/[\\/]/u).pop()?.toLowerCase();
  if (basename && normalized.includes(basename)) return true;
  // Deictic language is an explicit request to continue the agent's latest
  // artifact, never a reason to cross an agent boundary.
  return /(?:刚才|刚刚|上一(?:个|份|版|次)?|前面(?:的)?|这个|这份|该(?:文件|表格|文档|页面|ppt)|当前(?:文件|表格|文档|页面|ppt))/iu.test(message);
}

export class ArtifactTaskService {
  private loaded = false;
  private disposed = false;
  private store: ArtifactTaskStore = { version: 1, sessions: {} };
  private readonly policies = new Map<string, ArtifactRuntimePolicy>();
  private readonly metrics = new Map<string, ArtifactRunMetrics>();
  private readonly webpagePreviews = new WorkspaceHtmlPreviewService();
  private previewRevocation: Promise<void> = Promise.resolve();
  private readonly unsubscribeRuntimeConfig: () => void;

  constructor() {
    this.unsubscribeRuntimeConfig = subscribeManagedClientRuntimeConfig((current, previous) => {
      const wasEnabled = runtimeFeatureFlags(previous.config).htmlPreview;
      const isEnabled = runtimeFeatureFlags(current.config).htmlPreview;
      if (wasEnabled && !isEnabled) {
        this.previewRevocation = this.previewRevocation
          .then(() => this.webpagePreviews.closeAll(), () => this.webpagePreviews.closeAll());
      }
    });
  }

  private get storePath(): string {
    return join(resolveOpenClawStateDir(), 'uclaw-artifact-tasks.json');
  }

  private get policyDir(): string {
    return join(resolveOpenClawStateDir(), 'uclaw', 'artifact-policies');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.storePath, 'utf8')) as ArtifactTaskStore;
      if (value.version === 1 && value.sessions && typeof value.sessions === 'object') this.store = value;
    } catch {
      // The store is created after the first classified artifact task.
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(this.store, null, 2)}\n`, 'utf8');
    await rename(temporary, this.storePath);
  }

  private async writePolicy(policy: ArtifactRuntimePolicy): Promise<void> {
    await mkdir(this.policyDir, { recursive: true });
    const destination = join(this.policyDir, policyFileName(policy.sessionKey));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  }

  private async clearPolicy(sessionKey: string): Promise<void> {
    this.policies.delete(sessionKey);
    await rm(join(this.policyDir, policyFileName(sessionKey)), { force: true }).catch(() => undefined);
  }

  private recordForAgent(record: ArtifactSessionRecord | undefined, agentId: string): ArtifactSessionRecord | null {
    if (!record || record.agentId !== agentId) return null;
    return record;
  }

  private latestRecord(agentId: string, workspaceRoot: string, kind: ArtifactTaskKind): ArtifactSessionRecord | null {
    return Object.values(this.store.sessions)
      .filter(record => record.agentId === agentId && record.workspaceRoot === workspaceRoot && record.kind === kind)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  async prepare(input: ArtifactTaskPreparePayload): Promise<ArtifactTaskPrepareResult> {
    await this.load();
    const agentId = safeAgentId(input.agentId);
    const existingRecord = this.recordForAgent(this.store.sessions[input.sessionKey], agentId);
    const explicitKind = input.kindHint ?? classifyKind(input.message);
    const intent = classifyIntent(input.message) ?? (existingRecord ? 'modify' : null);
    const kind = explicitKind ?? existingRecord?.kind ?? null;
    if (!kind || !intent) {
      await this.clearPolicy(input.sessionKey);
      return { artifactTask: false, effectiveSessionKey: input.sessionKey, createSession: false };
    }

    const config = getManagedClientRuntimeConfigSnapshot().config;
    const feature = config.features.artifacts;
    const ecommerceFeature = config.features.ecommerceMainImage;
    const installId = await getOrCreateInstallationId().catch(() => '');
    const forced = process.env.CLAWX_ARTIFACTS_FORCE === '1';
    const artifactsEnabled = forced || (
      feature.enabled
      && feature.rolloutPercentage > 0
      && rolloutBucket(`${installId || 'anonymous'}:artifacts`) < feature.rolloutPercentage * 100
    );
    const ecommerceEnabled = kind !== 'ecommerce-main-image' || forced || (
      ecommerceFeature.enabled
      && ecommerceFeature.rolloutPercentage > 0
      && rolloutBucket(`${installId || 'anonymous'}:ecommerce-main-image`) < ecommerceFeature.rolloutPercentage * 100
    );
    const runtimeFeatures = runtimeFeatureFlags(config);
    const enabled = artifactsEnabled && ecommerceEnabled && runtimeFeatures.artifacts;
    if (!enabled) {
      await this.clearPolicy(input.sessionKey);
      return { artifactTask: false, effectiveSessionKey: input.sessionKey, createSession: false };
    }

    const workspaceRoot = resolve(input.workspaceRoot);
    const latest = intent === 'modify'
      ? this.latestRecord(agentId, workspaceRoot, kind)
      : null;
    // Reuse is only valid for an explicit modification of a known target.
    // A creation request in an artifact conversation starts a fresh task;
    // otherwise unrelated history silently contaminates the new artifact.
    const reusable = intent === 'modify' && existingRecord?.kind === kind && matchesKnownTarget(input.message, existingRecord)
      ? existingRecord
      : (latest && matchesKnownTarget(input.message, latest) ? latest : null);
    const effectiveSessionKey = reusable?.sessionKey
      ?? (input.hasHistory ? newArtifactSessionKey(input.agentId) : input.sessionKey);
    const createSession = effectiveSessionKey !== input.sessionKey;
    const mode: ArtifactTaskMode = REFINED_INTENT.test(input.message) ? 'refined' : 'fast';
    const now = new Date();
    const skillId = SKILL_BY_KIND[kind];
    const contractVersion = kind === 'ecommerce-main-image'
      ? ecommerceFeature.skillVersion
      : feature.policyVersion;
    const promptContract = `${skillId}:${contractVersion}`;
    if (!SUPPORTED_PROMPT_CONTRACTS.has(promptContract)) {
      await this.clearPolicy(input.sessionKey);
      logger.warn('[artifact-task] unsupported prompt contract', { kind, promptContract });
      return { artifactTask: false, effectiveSessionKey: input.sessionKey, createSession: false };
    }
    const record: ArtifactSessionRecord = {
      sessionKey: effectiveSessionKey,
      agentId,
      workspaceRoot,
      kind,
      skillId,
      ...(reusable?.targetFile ? { targetFile: reusable.targetFile } : {}),
      updatedAt: now.toISOString(),
    };
    this.store.sessions[effectiveSessionKey] = record;
    await this.persist();

    const policy: ArtifactRuntimePolicy = {
      schemaVersion: 1,
      sessionKey: effectiveSessionKey,
      workspaceRoot,
      kind,
      intent,
      mode,
      skillId,
      promptContract,
      modelAlias: feature.modelAlias.includes('/')
        ? feature.modelAlias
        : toManagedClientTextModelRef(feature.modelAlias),
      thinkingLevel: mode === 'fast' ? 'minimal' : 'high',
      fastMode: mode === 'fast',
      maxRepairs: mode === 'fast' ? 1 : 2,
      allowNetwork: mode === 'refined' && kind !== 'cad',
      allowImageGeneration: kind !== 'cad' && (kind === 'ecommerce-main-image' || mode === 'refined'),
      runtimeFeatures,
      ...(record.targetFile ? { targetFile: record.targetFile } : {}),
      preparedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.policies.set(effectiveSessionKey, policy);
    this.metrics.set(effectiveSessionKey, {
      preparedAtMs: Date.now(),
      toolCallIds: new Set(),
      repairCount: 0,
    });
    await this.writePolicy(policy);
    logger.info('[artifact-task] prepared', {
      kind,
      intent,
      mode,
      skillId,
      promptContract: policy.promptContract,
      model: policy.modelAlias,
      thinking: policy.thinkingLevel,
      sessionCreated: createSession,
    });
    return {
      artifactTask: true,
      effectiveSessionKey,
      createSession,
      kind,
      intent,
      mode,
      policyVersion: contractVersion,
    };
  }

  async validateWebpage(
    input: ArtifactWebpageValidationPayload,
  ): Promise<ArtifactWebpageValidationResult> {
    if (this.disposed) return { ok: false };
    const config = getManagedClientRuntimeConfigSnapshot().config;
    if (this.disposed) return { ok: false };
    if (runtimeFeatureFlags(config).htmlPreview !== true) {
      await this.previewRevocation;
      await this.webpagePreviews.closeAll();
      return { ok: false };
    }
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.filePath)) return { ok: false };
    if (!['.htm', '.html'].includes(extname(input.filePath).toLowerCase())) return { ok: false };
    try {
      const [workspaceRoot, filePath] = await Promise.all([
        realpath(resolve(input.workspaceRoot)),
        realpath(resolve(input.filePath)),
      ]);
      if (!isInsideWorkspace(workspaceRoot, filePath)) {
        return { ok: false };
      }
      const body = await readStableWorkspaceHtml(
        input.workspaceRoot,
        input.filePath,
        workspaceRoot,
        filePath,
      );
      if (this.disposed) return { ok: false };
      const preview = await this.webpagePreviews.start(filePath, body);
      return { ok: true, browserUrl: preview.browserUrl };
    } catch {
      return { ok: false };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeRuntimeConfig();
    await this.previewRevocation;
    await this.webpagePreviews.closeAll();
  }

  getPolicy(sessionKey: string): ArtifactRuntimePolicy | null {
    const policy = this.policies.get(sessionKey);
    if (!policy || Date.parse(policy.expiresAt) <= Date.now()) return null;
    return { ...policy };
  }

  markDispatched(sessionKey: string): void {
    const metric = this.metrics.get(sessionKey);
    if (metric) metric.dispatchedAtMs = Date.now();
  }

  markFirstText(sessionKey: string): void {
    const metric = this.metrics.get(sessionKey);
    if (metric && metric.firstTextAtMs == null) metric.firstTextAtMs = Date.now();
  }

  recordTool(sessionKey: string, update: { toolCallId?: string; title?: string | null; status?: string | null; rawOutput?: unknown }): void {
    const metric = this.metrics.get(sessionKey);
    if (!metric || !update.toolCallId) return;
    metric.toolCallIds.add(update.toolCallId);
    if (/repair/iu.test(update.title || '') && update.status === 'completed') metric.repairCount += 1;

    if (update.status === 'completed' && update.rawOutput && typeof update.rawOutput === 'object') {
      const output = update.rawOutput as { filePath?: unknown; details?: { filePath?: unknown } };
      const filePath = typeof output.filePath === 'string'
        ? output.filePath
        : (typeof output.details?.filePath === 'string' ? output.details.filePath : '');
      if (filePath) void this.recordTargetFile(sessionKey, filePath);
    }
  }

  private async recordTargetFile(sessionKey: string, filePath: string): Promise<void> {
    const record = this.store.sessions[sessionKey];
    if (!record || !isInsideWorkspace(record.workspaceRoot, filePath)) return;
    record.targetFile = resolve(filePath);
    record.updatedAt = new Date().toISOString();
    const policy = this.policies.get(sessionKey);
    if (policy) {
      policy.targetFile = record.targetFile;
      await this.writePolicy(policy).catch(() => undefined);
    }
    await this.persist().catch(() => undefined);
  }

  complete(sessionKey: string, outcome: 'success' | 'failure'): void {
    const metric = this.metrics.get(sessionKey);
    const policy = this.policies.get(sessionKey);
    if (!metric || !policy) return;
    const now = Date.now();
    logger.info('[artifact-task] completed', {
      kind: policy.kind,
      outcome,
      classifierMs: Math.max(0, (metric.dispatchedAtMs ?? now) - metric.preparedAtMs),
      dispatchToFirstTextMs: metric.firstTextAtMs && metric.dispatchedAtMs
        ? Math.max(0, metric.firstTextAtMs - metric.dispatchedAtMs)
        : null,
      totalMs: Math.max(0, now - metric.preparedAtMs),
      toolCount: metric.toolCallIds.size,
      repairCount: metric.repairCount,
      model: policy.modelAlias,
      thinking: policy.thinkingLevel,
    });
    this.metrics.delete(sessionKey);
  }

  reportFailure(sessionKey: string, error: unknown): void {
    const policy = this.policies.get(sessionKey);
    captureHandledException(error, {
      subsystem: 'artifact-task',
      kind: policy?.kind,
      mode: policy?.mode,
      policyVersion: policy?.promptContract,
    }, { artifactTask: true });
  }
}

export const artifactTaskService = new ArtifactTaskService();
