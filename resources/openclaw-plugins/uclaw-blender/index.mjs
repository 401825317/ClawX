import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';

const PLUGIN_ID = 'uclaw-blender';
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';

function hostApiOrigin() {
  return (process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function hostApiToken() {
  const token = process.env.CLAWX_HOST_API_TOKEN || '';
  if (!token.trim()) throw new Error('UClaw Host API token is unavailable for Blender runtime tools');
  return token;
}

async function hostApiFetch(route, options = {}) {
  const response = await fetch(`${hostApiOrigin()}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${hostApiToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `Blender Host API request failed: ${response.status}`);
  }
  return payload;
}

function summarizeJob(payload) {
  const job = payload?.job || payload;
  if (!job) return payload;
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    revision: job.revision,
    error: job.error,
    recoverable: job.recoverable,
    progress: job.progress,
    artifacts: (job.artifacts || []).map((artifact) => ({
      role: artifact.role,
      filePath: artifact.filePath,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    })),
    verifications: job.verifications,
    instruction: job.status === 'succeeded'
      ? 'Blender artifacts are verified. Return the artifact paths to the user.'
      : job.status === 'queued' || job.status === 'running'
        ? 'The Blender job is still running. Poll get_blender_job; do not claim completion.'
        : 'The Blender job did not complete. Report the concrete status and error; use repair only with bounded patch operations.',
  };
}

const vector3 = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const rgba = Type.Tuple([Type.Number({ minimum: 0, maximum: 1 }), Type.Number({ minimum: 0, maximum: 1 }), Type.Number({ minimum: 0, maximum: 1 }), Type.Number({ minimum: 0, maximum: 1 })]);
const transformSchema = Type.Object({
  location: Type.Optional(vector3),
  rotation: Type.Optional(vector3),
  scale: Type.Optional(vector3),
}, { additionalProperties: false });
const sceneSchema = Type.Object({
  schema: Type.Literal('uclaw.blender.scene/v1'),
  title: Type.String({ minLength: 1, maxLength: 160 }),
  seed: Type.Optional(Type.Integer()),
  units: Type.Optional(Type.Union([Type.Literal('METERS'), Type.Literal('CENTIMETERS'), Type.Literal('MILLIMETERS')])),
  assets: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }), path: Type.String({ minLength: 1 }), sha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), mediaType: Type.Optional(Type.Union([Type.Literal('image'), Type.Literal('model')])), license: Type.Optional(Type.String({ maxLength: 300 })), sourceUrl: Type.Optional(Type.String({ maxLength: 2000 })),
  }, { additionalProperties: false }), { maxItems: 32 })),
  materials: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }), name: Type.Optional(Type.String({ maxLength: 120 })), baseColor: Type.Optional(rgba), metallic: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), emissionColor: Type.Optional(rgba), emissionStrength: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })), textureAssetId: Type.Optional(Type.String({ maxLength: 80 })),
  }, { additionalProperties: false }), { maxItems: 64 })),
  objects: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }), name: Type.Optional(Type.String({ maxLength: 120 })), primitive: Type.Union([Type.Literal('cube'), Type.Literal('sphere'), Type.Literal('cylinder'), Type.Literal('cone'), Type.Literal('torus'), Type.Literal('plane'), Type.Literal('text')]), transform: Type.Optional(transformSchema), dimensions: Type.Optional(vector3), materialId: Type.Optional(Type.String({ maxLength: 80 })), text: Type.Optional(Type.String({ maxLength: 1000 })), bevelDepth: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 200 }),
  lights: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }), type: Type.Union([Type.Literal('AREA'), Type.Literal('POINT'), Type.Literal('SUN'), Type.Literal('SPOT')]), transform: Type.Optional(transformSchema), energy: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })), color: Type.Optional(rgba), size: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1000 })),
  }, { additionalProperties: false }), { maxItems: 32 })),
  cameras: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), transform: Type.Optional(transformSchema), lensMm: Type.Optional(Type.Number({ minimum: 8, maximum: 300 })) }, { additionalProperties: false }), { maxItems: 16 })),
  activeCameraId: Type.Optional(Type.String({ maxLength: 80 })),
  world: Type.Optional(Type.Object({ color: Type.Optional(rgba), strength: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })) }, { additionalProperties: false })),
  project: Type.Optional(Type.Object({ frameStart: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), frameEnd: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }, { additionalProperties: false })),
  render: Type.Optional(Type.Object({ engine: Type.Optional(Type.Union([Type.Literal('BLENDER_EEVEE_NEXT'), Type.Literal('CYCLES')])), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })), samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })), transparent: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  deliverables: Type.Optional(Type.Object({ blend: Type.Optional(Type.Boolean()), glb: Type.Optional(Type.Boolean()), heroImage: Type.Optional(Type.Boolean()), turntable: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  budgets: Type.Optional(Type.Object({ maxObjects: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), maxTriangles: Type.Optional(Type.Integer({ minimum: 1000, maximum: 5000000 })), maxTextureBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1073741824 })), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2147483648 })), maxRenderSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 1800 })) }, { additionalProperties: false })),
}, { additionalProperties: false, description: 'Declarative uclaw.blender.scene/v1 SceneSpec. Use only the listed lower-case primitives and transform.location/rotation/scale. Arbitrary Python, scripts, shell commands, execution URLs, add-ons, modifiers, and geometry nodes are rejected.' });

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Blender Runtime',
  description: 'Builds Blender scenes through a fixed SceneSpec interpreter. It never runs model-supplied Python.',
  register(api) {
    api.registerTool({
      name: 'blender_get_capabilities',
      label: 'Get Blender capabilities',
      description: 'Check whether the local UClaw Blender runtime has a trusted runner and an installed Blender executable.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return (await hostApiFetch('/api/blender/capabilities')).capabilities;
      },
    });
    api.registerTool({
      name: 'create_blender_scene',
      label: 'Create Blender scene',
      description: 'Create a real local Blender scene from a declarative SceneSpec. Never pass Python, bpy code, shell commands, or add-on installation instructions: the host accepts only the fixed uclaw.blender.scene/v1 schema and renders with a trusted runner.',
      parameters: Type.Object({
        scene: sceneSchema,
        clientRequestId: Type.Optional(Type.String({ maxLength: 160 })),
        waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 90000 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const payload = await hostApiFetch('/api/blender/jobs', {
          method: 'POST',
          body: JSON.stringify({
            clientRequestId: params.clientRequestId || `blender:${randomUUID()}`,
            sessionKey: ctx?.sessionKey,
            runId: ctx?.runId || `tool:${_toolCallId}`,
            taskId: `tool:${_toolCallId}`,
            cwd: ctx?.cwd,
            sceneSpec: params.scene,
            waitMs: params.waitMs ?? 90000,
          }),
        });
        return summarizeJob(payload);
      },
    });
    api.registerTool({
      name: 'get_blender_job',
      label: 'Get Blender job',
      description: 'Read the current state, progress, verified artifacts, and concrete failure details for a Blender job.',
      parameters: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return summarizeJob(await hostApiFetch(`/api/blender/jobs/${encodeURIComponent(params.jobId)}`));
      },
    });
    api.registerTool({
      name: 'repair_blender_scene',
      label: 'Repair Blender scene',
      description: 'Create a bounded repair of a terminal Blender job. Use only failed verification evidence and one of these patch operations: replace_object, replace_material, replace_lights, replace_camera, replace_render. Do not resend arbitrary Python or a new unbounded scene.',
      parameters: Type.Object({
        jobId: Type.String({ minLength: 1, maxLength: 160 }),
        baseRevision: Type.Integer({ minimum: 1 }),
        patches: Type.Array(Type.Object({ op: Type.String() }, { additionalProperties: true }), { minItems: 1, maxItems: 24 }),
        clientRequestId: Type.Optional(Type.String({ maxLength: 160 })),
        waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 90000 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const payload = await hostApiFetch(`/api/blender/jobs/${encodeURIComponent(params.jobId)}/repair`, {
          method: 'POST',
          body: JSON.stringify({
            baseRevision: params.baseRevision,
            patches: params.patches,
            clientRequestId: params.clientRequestId || `blender-repair:${randomUUID()}`,
            waitMs: params.waitMs ?? 90000,
          }),
        });
        return summarizeJob(payload);
      },
    });
  },
});

export default pluginEntry;
