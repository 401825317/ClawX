import { createHash, randomUUID } from 'node:crypto';
import { copyFile, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getOpenClawMediaDir } from '../../utils/paths';
import { collectAndValidateArtifacts } from './artifact-validator';
import { discoverBlenderExecutable, type BlenderExecutableDiscovery } from './executable-discovery';
import { BlenderJobStore } from './job-store';
import { runTrustedBlender, terminateBlenderProcess } from './process-runner';
import { validateSceneSpec } from './scene-spec-validator';
import {
  BLENDER_SCENE_SCHEMA,
  type BlenderArtifact,
  type BlenderJobRequest,
  type BlenderJobSnapshot,
  type BlenderJobStatus,
  type BlenderRepairPatch,
  type BlenderSceneSpec,
  type BlenderVerification,
} from './types';

const TERMINAL = new Set<BlenderJobStatus>(['succeeded', 'failed', 'blocked', 'cancelled']);
const MAX_ASSET_BYTES = 250 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/gu, ' ').slice(0, 1_000);
}

function verification(
  id: string,
  status: BlenderVerification['status'],
  kind: BlenderVerification['kind'],
  severity: BlenderVerification['severity'],
  title: string,
  detail: string,
  required = true,
  evidence?: string,
): BlenderVerification {
  return { id, status, kind, severity, title, detail, required, ...(evidence ? { evidence } : {}) };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function promptDefaultScene(prompt: string): BlenderSceneSpec {
  const title = prompt.trim().slice(0, 160) || 'UClaw 3D Scene';
  return {
    schema: BLENDER_SCENE_SCHEMA,
    title,
    objects: [
      { id: 'hero-form', primitive: 'torus', transform: { location: [0, 0, 0], rotation: [0.2, 0, 0], scale: [1.4, 1.4, 1.4] }, materialId: 'hero-material' },
      { id: 'ground', primitive: 'plane', transform: { location: [0, 0, -1.15], scale: [8, 8, 8] }, materialId: 'ground-material' },
    ],
    materials: [
      { id: 'hero-material', baseColor: [0.08, 0.55, 0.9, 1], metallic: 0.72, roughness: 0.2, emissionColor: [0.01, 0.06, 0.15, 1], emissionStrength: 0.15 },
      { id: 'ground-material', baseColor: [0.015, 0.02, 0.035, 1], metallic: 0.05, roughness: 0.32 },
    ],
    lights: [
      { id: 'key', type: 'AREA', transform: { location: [4, -4, 5], rotation: [0.45, 0, 0.75] }, energy: 1_300, color: [0.72, 0.9, 1, 1], size: 5 },
      { id: 'rim', type: 'AREA', transform: { location: [-4, 2, 3], rotation: [0.6, 0, -2] }, energy: 900, color: [0.25, 0.4, 1, 1], size: 4 },
    ],
    cameras: [{ id: 'hero-camera', transform: { location: [4.8, -4.8, 3.2], rotation: [1.12, 0, 0.78] }, lensMm: 52 }],
    activeCameraId: 'hero-camera',
    world: { color: [0.005, 0.008, 0.02, 1], strength: 0.18 },
    project: { frameStart: 1, frameEnd: 96, fps: 24 },
    render: { engine: 'BLENDER_EEVEE_NEXT', width: 1024, height: 1024, samples: 64 },
    deliverables: { blend: true, glb: true, heroImage: true, turntable: false },
  };
}

export class BlenderJobService {
  private readonly store: BlenderJobStore;
  private readonly jobs = new Map<string, BlenderJobSnapshot>();
  private readonly clientJobs = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(snapshot: BlenderJobSnapshot) => void>();
  private readonly waiters = new Map<string, Set<(snapshot: BlenderJobSnapshot) => void>>();
  private readonly persistQueues = new Map<string, Promise<void>>();
  private activeJobId?: string;
  private activeChild?: ChildProcess;
  private initialized?: Promise<void>;

  constructor(store = new BlenderJobStore()) {
    this.store = store;
  }

  async capabilities(): Promise<{
    available: boolean;
    executable?: string;
    discovery: BlenderExecutableDiscovery;
    runnerAvailable: boolean;
    queueConcurrency: 1;
    schema: typeof BLENDER_SCENE_SCHEMA;
  }> {
    await this.ensureInitialized();
    const discovery = discoverBlenderExecutable();
    const { resolveTrustedBlenderRunner } = await import('./process-runner');
    const { existsSync } = await import('node:fs');
    return {
      available: discovery.found && existsSync(resolveTrustedBlenderRunner()),
      ...(discovery.executable ? { executable: discovery.executable } : {}),
      discovery,
      runnerAvailable: existsSync(resolveTrustedBlenderRunner()),
      queueConcurrency: 1,
      schema: BLENDER_SCENE_SCHEMA,
    };
  }

  subscribe(listener: (snapshot: BlenderJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(request: BlenderJobRequest): Promise<{ job: BlenderJobSnapshot; idempotent: boolean }> {
    await this.ensureInitialized();
    const clientRequestId = request.clientRequestId?.trim();
    if (!clientRequestId || clientRequestId.length > 160) throw new Error('clientRequestId is required and must be at most 160 characters');
    const existingId = this.clientJobs.get(clientRequestId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) return { job: clone(existing), idempotent: true };
    }
    const candidate = request.sceneSpec ?? request.scene ?? promptDefaultScene(request.prompt ?? '');
    const validation = validateSceneSpec(candidate);
    if (!validation.ok || !validation.normalized) throw new Error(`Invalid Blender SceneSpec: ${validation.errors.join('; ')}`);
    const jobId = randomUUID();
    const jobDir = await this.store.createJobDir(jobId);
    const now = Date.now();
    const snapshot: BlenderJobSnapshot = {
      version: 1,
      jobId,
      clientRequestId,
      ...(request.sessionKey?.trim() ? { sessionKey: request.sessionKey.trim() } : {}),
      ...(request.runId?.trim() ? { runId: request.runId.trim() } : {}),
      ...(request.taskId?.trim() ? { taskId: request.taskId.trim() } : {}),
      ...(request.cwd?.trim() && path.isAbsolute(request.cwd) ? { cwd: path.resolve(request.cwd) } : {}),
      title: validation.normalized.title,
      status: 'queued',
      stage: 'queued',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      jobDir,
      sceneSpec: validation.normalized,
      artifacts: [],
      verifications: [
        verification('verify:scene:structure', 'passed', 'scene.structure', 'info', 'SceneSpec structure', 'SceneSpec passed the fixed declarative schema validator.', true),
      ],
    };
    await fs.writeFile(path.join(jobDir, 'scene.json'), `${JSON.stringify(snapshot.sceneSpec, null, 2)}\n`, { mode: 0o600 });
    this.jobs.set(jobId, snapshot);
    this.clientJobs.set(clientRequestId, jobId);
    this.queue.push(jobId);
    await this.persist(snapshot, 'job.created', { promptOnly: !request.scene && !request.sceneSpec });
    void this.drain();
    return { job: clone(snapshot), idempotent: false };
  }

  async get(jobId: string): Promise<BlenderJobSnapshot | undefined> {
    await this.ensureInitialized();
    const inMemory = this.jobs.get(jobId);
    return inMemory ? clone(inMemory) : undefined;
  }

  async list(sessionKey?: string): Promise<BlenderJobSnapshot[]> {
    await this.ensureInitialized();
    return [...this.jobs.values()]
      .filter((snapshot) => !sessionKey || snapshot.sessionKey === sessionKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  async cancel(jobId: string, source = 'unknown'): Promise<BlenderJobSnapshot | undefined> {
    await this.ensureInitialized();
    const snapshot = this.jobs.get(jobId);
    if (!snapshot) return undefined;
    if (TERMINAL.has(snapshot.status)) return clone(snapshot);
    const queuedIndex = this.queue.indexOf(jobId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    snapshot.status = 'cancelled';
    snapshot.stage = 'recovering';
    snapshot.error = `Cancelled by ${source.slice(0, 80)}`;
    snapshot.completedAt = Date.now();
    await this.persist(snapshot, 'job.cancelled', { source: source.slice(0, 80) });
    if (this.activeJobId === jobId && this.activeChild) terminateBlenderProcess(this.activeChild);
    return clone(snapshot);
  }

  async waitForTerminal(jobId: string, waitMs: number): Promise<BlenderJobSnapshot | undefined> {
    const initial = await this.get(jobId);
    if (!initial || TERMINAL.has(initial.status) || waitMs <= 0) return initial;
    return await new Promise<BlenderJobSnapshot | undefined>((resolve) => {
      let onUpdate: (snapshot: BlenderJobSnapshot) => void;
      const timer = setTimeout(() => {
        this.waiters.get(jobId)?.delete(onUpdate);
        resolve(this.jobs.get(jobId) ? clone(this.jobs.get(jobId)!) : undefined);
      }, Math.min(Math.max(1, waitMs), 90_000));
      onUpdate = (snapshot: BlenderJobSnapshot): void => {
        if (!TERMINAL.has(snapshot.status)) return;
        clearTimeout(timer);
        this.waiters.get(jobId)?.delete(onUpdate);
        resolve(clone(snapshot));
      };
      const subscribers = this.waiters.get(jobId) ?? new Set<(snapshot: BlenderJobSnapshot) => void>();
      subscribers.add(onUpdate);
      this.waiters.set(jobId, subscribers);
    });
  }

  async repair(jobId: string, baseRevision: number, patches: BlenderRepairPatch[], clientRequestId: string): Promise<{ job: BlenderJobSnapshot; idempotent: boolean }> {
    const original = await this.get(jobId);
    if (!original) throw new Error('Blender job not found');
    if (!Number.isInteger(baseRevision) || baseRevision !== original.revision) throw new Error(`Repair revision mismatch: expected ${original.revision}`);
    if (!TERMINAL.has(original.status)) throw new Error('Only a terminal Blender job can be repaired');
    if (!Array.isArray(patches) || patches.length === 0 || patches.length > 24) throw new Error('Repair requires 1-24 bounded patch operations');
    const scene = clone(original.sceneSpec);
    for (const patch of patches) {
      if (patch.op === 'replace_object') {
        const index = scene.objects.findIndex((object) => object.id === patch.objectId);
        if (index < 0) throw new Error(`Unknown object id: ${patch.objectId}`);
        scene.objects[index] = patch.object;
      } else if (patch.op === 'replace_material') {
        const index = (scene.materials ?? []).findIndex((material) => material.id === patch.materialId);
        if (index < 0) throw new Error(`Unknown material id: ${patch.materialId}`);
        scene.materials![index] = patch.material;
      } else if (patch.op === 'replace_lights') {
        scene.lights = patch.lights;
      } else if (patch.op === 'replace_camera') {
        const index = (scene.cameras ?? []).findIndex((camera) => camera.id === patch.cameraId);
        if (index < 0) throw new Error(`Unknown camera id: ${patch.cameraId}`);
        scene.cameras![index] = patch.camera;
      } else if (patch.op === 'replace_render') {
        scene.render = patch.render;
      } else {
        throw new Error('Unsupported repair patch');
      }
    }
    return await this.create({
      clientRequestId,
      sessionKey: original.sessionKey,
      runId: original.runId,
      taskId: original.taskId,
      cwd: original.cwd,
      sceneSpec: scene,
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.store.initialize();
        const recovered = await this.store.list();
        for (const snapshot of recovered) {
          this.jobs.set(snapshot.jobId, snapshot);
          this.clientJobs.set(snapshot.clientRequestId, snapshot.jobId);
          if (snapshot.status === 'queued') {
            this.queue.push(snapshot.jobId);
          } else if (snapshot.status === 'running') {
            snapshot.status = 'blocked';
            snapshot.stage = 'recovering';
            snapshot.recoverable = true;
            snapshot.error = 'UClaw restarted while Blender was running; inspect outputs and retry explicitly.';
            snapshot.completedAt = Date.now();
            await this.persist(snapshot, 'job.recovered-blocked');
          }
        }
        void this.drain();
      })();
    }
    await this.initialized;
  }

  private async persist(snapshot: BlenderJobSnapshot, event: string, data: Record<string, unknown> = {}): Promise<void> {
    snapshot.revision += 1;
    snapshot.updatedAt = Date.now();
    const persisted = clone(snapshot);
    const previous = this.persistQueues.get(snapshot.jobId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      await this.store.save(persisted);
      await this.store.appendJournal(persisted, event, data);
      const safe = clone(persisted);
      for (const listener of this.listeners) listener(safe);
      for (const listener of this.waiters.get(persisted.jobId) ?? []) listener(safe);
    });
    this.persistQueues.set(snapshot.jobId, queued);
    try {
      await queued;
    } finally {
      if (this.persistQueues.get(snapshot.jobId) === queued) this.persistQueues.delete(snapshot.jobId);
    }
  }

  private async drain(): Promise<void> {
    if (this.activeJobId) return;
    const jobId = this.queue.shift();
    if (!jobId) return;
    const snapshot = this.jobs.get(jobId);
    if (!snapshot || snapshot.status !== 'queued') {
      void this.drain();
      return;
    }
    this.activeJobId = jobId;
    try {
      await this.execute(snapshot);
    } finally {
      this.activeChild = undefined;
      this.activeJobId = undefined;
      void this.drain();
    }
  }

  private async execute(snapshot: BlenderJobSnapshot): Promise<void> {
    const discovery = discoverBlenderExecutable();
    if (!discovery.found || !discovery.executable) {
      snapshot.status = 'blocked';
      snapshot.stage = 'recovering';
      snapshot.recoverable = true;
      snapshot.error = discovery.error;
      snapshot.completedAt = Date.now();
      snapshot.verifications.push(verification('verify:blender:available', 'blocked', 'command.exit', 'blocking', 'Blender executable', discovery.error ?? 'Blender is unavailable.', true));
      await this.persist(snapshot, 'job.blocked', { reason: discovery.error ?? 'blender_not_found' });
      return;
    }
    snapshot.status = 'running';
    snapshot.stage = 'staging_assets';
    snapshot.startedAt = Date.now();
    await this.persist(snapshot, 'job.started', { executable: discovery.executable, source: discovery.source });
    try {
      snapshot.sceneSpec = await this.stageAssets(snapshot);
      await fs.writeFile(path.join(snapshot.jobDir, 'scene.json'), `${JSON.stringify(snapshot.sceneSpec, null, 2)}\n`, { mode: 0o600 });
      snapshot.verifications.push(verification('verify:scene:assets', 'passed', 'scene.asset_resolution', 'info', 'Asset staging', 'All referenced local assets were staged into the private Blender job directory.', true));
      await this.persist(snapshot, 'job.assets-staged');
      if (snapshot.status === 'cancelled') return;
      snapshot.stage = 'building_scene';
      await this.persist(snapshot, 'job.runner-started');
      const result = await runTrustedBlender(
        discovery.executable,
        snapshot,
        async (event) => {
          if (snapshot.status === 'cancelled') return;
          if (event.stage) snapshot.stage = event.stage;
          snapshot.progress = { completed: event.completed ?? 0, total: event.total ?? 0, message: event.message ?? snapshot.stage };
          await this.persist(snapshot, 'job.progress', snapshot.progress);
        },
        (child) => { this.activeChild = child; },
      );
      if (snapshot.status === 'cancelled') return;
      snapshot.verifications.push(verification(
        'verify:blender:exit', result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed', 'command.exit',
        result.exitCode === 0 && !result.timedOut ? 'info' : 'blocking', 'Blender process exit',
        result.exitCode === 0 && !result.timedOut ? 'Trusted Blender runner completed.' : `Blender failed (exit=${result.exitCode ?? 'null'}, signal=${result.signal ?? 'none'}, timedOut=${String(result.timedOut)}).`,
        true,
        result.stderr.slice(-1_000),
      ));
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`Blender runner failed: ${result.stderr.slice(-700) || result.stdout.slice(-700) || `exit ${result.exitCode}`}`);
      snapshot.stage = 'validating';
      await this.persist(snapshot, 'job.validating');
      const validated = await collectAndValidateArtifacts(path.join(snapshot.jobDir, 'outputs'), snapshot.sceneSpec.budgets?.maxOutputBytes ?? 800 * 1024 * 1024);
      snapshot.artifacts = validated.artifacts;
      snapshot.verifications.push(...validated.verifications);
      this.verifyRequiredDeliverables(snapshot);
      const failed = snapshot.verifications.some((item) => item.required && item.status !== 'passed');
      snapshot.status = failed ? 'failed' : 'succeeded';
      snapshot.completedAt = Date.now();
      snapshot.stage = 'validating';
      await this.persist(snapshot, failed ? 'job.failed-validation' : 'job.succeeded', { artifactCount: snapshot.artifacts.length });
    } catch (error) {
      if (snapshot.status === 'cancelled') return;
      snapshot.status = 'failed';
      snapshot.error = shortError(error);
      snapshot.completedAt = Date.now();
      await this.persist(snapshot, 'job.failed', { error: snapshot.error });
    }
  }

  private async stageAssets(snapshot: BlenderJobSnapshot): Promise<BlenderSceneSpec> {
    const scene = clone(snapshot.sceneSpec);
    const roots = [getOpenClawMediaDir(), snapshot.jobDir];
    if (snapshot.cwd) roots.push(snapshot.cwd);
    let totalBytes = 0;
    const assets = [];
    await fs.mkdir(path.join(snapshot.jobDir, 'assets'), { recursive: true, mode: 0o700 });
    for (const asset of scene.assets ?? []) {
      const realPath = await fs.realpath(asset.path);
      if (!roots.some((root) => isInside(path.resolve(root), realPath))) {
        throw new Error(`Asset path is outside UClaw managed roots: ${asset.id}`);
      }
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) throw new Error(`Asset is not a regular file: ${asset.id}`);
      totalBytes += stat.size;
      if (totalBytes > (scene.budgets?.maxTextureBytes ?? MAX_ASSET_BYTES)) throw new Error('Staged asset bytes exceed scene budget');
      const extension = path.extname(realPath).toLowerCase().replace(/[^.a-z0-9]/gu, '').slice(0, 12);
      const target = path.join(snapshot.jobDir, 'assets', `${asset.id}${extension}`);
      await copyFile(realPath, target);
      const digest = await this.fileHash(target);
      if (asset.sha256 && asset.sha256 !== digest) throw new Error(`Asset SHA-256 does not match: ${asset.id}`);
      assets.push({ ...asset, path: target, sha256: digest });
    }
    scene.assets = assets;
    return scene;
  }

  private verifyRequiredDeliverables(snapshot: BlenderJobSnapshot): void {
    const roles = new Set(snapshot.artifacts.map((artifact) => artifact.role));
    const required: Array<[boolean, BlenderArtifact['role'], string]> = [
      [snapshot.sceneSpec.deliverables?.blend !== false, 'model3d.source', 'Blender source file'],
      [snapshot.sceneSpec.deliverables?.glb !== false, 'model3d.portable', 'GLB portable model'],
      [snapshot.sceneSpec.deliverables?.heroImage !== false, 'render.hero', 'Hero render'],
      [snapshot.sceneSpec.deliverables?.turntable === true, 'render.turntable', 'Turntable video'],
    ];
    for (const [expected, role, title] of required) {
      if (!expected) continue;
      snapshot.verifications.push(verification(
        `verify:deliverable:${role}`,
        roles.has(role) ? 'passed' : 'failed',
        'artifact.integrity', roles.has(role) ? 'info' : 'blocking', title,
        roles.has(role) ? `${title} was produced.` : `${title} is missing.`, true,
      ));
    }
  }

  private async fileHash(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
  }
}

export const blenderJobService = new BlenderJobService();
