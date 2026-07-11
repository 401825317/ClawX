import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BLENDER_SCENE_SCHEMA,
  type BlenderAnimationTrack,
  type BlenderAssetRef,
  type BlenderCamera,
  type BlenderLight,
  type BlenderMaterial,
  type BlenderSceneObject,
  type BlenderSceneSpec,
  type BlenderSceneSpecValidation,
  type BlenderTransform,
} from './types';

const MAX_OBJECTS = 250;
const MAX_MATERIALS = 128;
const MAX_ASSETS = 64;
const MAX_LIGHTS = 24;
const MAX_CAMERAS = 8;
const MAX_TEXT_LENGTH = 4_000;
const MAX_RENDER_DIMENSION = 2_048;
const MAX_RENDER_SAMPLES = 128;
const MAX_FRAMES = 900;
const FINITE_NUMBER = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], field: string, errors: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) errors.push(`${field}.${key} is not allowed in SceneSpec`);
  }
}

function cleanId(value: unknown, field: string, errors: string[]): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,95}$/u.test(id)) {
    errors.push(`${field} must be an ASCII identifier up to 96 characters`);
  }
  return id;
}

function vec3(value: unknown, field: string, errors: string[], fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !FINITE_NUMBER(item) || Math.abs(item) > 100_000)) {
    if (value !== undefined) errors.push(`${field} must be a finite 3-number vector`);
    return fallback;
  }
  return [value[0], value[1], value[2]];
}

function rgba(value: unknown, field: string, errors: string[], fallback: [number, number, number, number]): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => !FINITE_NUMBER(item) || item < 0 || item > 1)) {
    if (value !== undefined) errors.push(`${field} must be an RGBA vector in [0, 1]`);
    return fallback;
  }
  return [value[0], value[1], value[2], value[3]];
}

function boundedNumber(value: unknown, field: string, errors: string[], fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!FINITE_NUMBER(value) || value < min || value > max) {
    errors.push(`${field} must be between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function transform(value: unknown, field: string, errors: string[]): BlenderTransform | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    location: vec3(raw.location, `${field}.location`, errors, [0, 0, 0]),
    rotation: vec3(raw.rotation, `${field}.rotation`, errors, [0, 0, 0]),
    scale: vec3(raw.scale, `${field}.scale`, errors, [1, 1, 1]),
  };
}

function normalizeAsset(value: unknown, index: number, errors: string[]): BlenderAssetRef {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['id', 'path', 'sha256', 'mediaType', 'license', 'sourceUrl'], `assets[${index}]`, errors);
  const assetPath = typeof raw.path === 'string' ? raw.path.trim() : '';
  const mediaType = raw.mediaType === 'image' || raw.mediaType === 'model' ? raw.mediaType : undefined;
  const result: BlenderAssetRef = {
    id: cleanId(raw.id, `assets[${index}].id`, errors),
    path: assetPath,
    ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256.trim().toLowerCase() } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(typeof raw.license === 'string' ? { license: raw.license.trim().slice(0, 300) } : {}),
    ...(typeof raw.sourceUrl === 'string' ? { sourceUrl: raw.sourceUrl.trim().slice(0, 2_000) } : {}),
  };
  if (!path.isAbsolute(assetPath)) errors.push(`assets[${index}].path must be an absolute local path`);
  if (assetPath && (!existsSync(assetPath) || !statSync(assetPath).isFile())) errors.push(`assets[${index}].path does not reference a readable file`);
  if (result.sha256 && !/^[a-f0-9]{64}$/u.test(result.sha256)) errors.push(`assets[${index}].sha256 must be a SHA-256 hex digest`);
  return result;
}

function normalizeMaterial(value: unknown, index: number, errors: string[]): BlenderMaterial {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['id', 'name', 'baseColor', 'metallic', 'roughness', 'emissionColor', 'emissionStrength', 'textureAssetId'], `materials[${index}]`, errors);
  return {
    id: cleanId(raw.id, `materials[${index}].id`, errors),
    ...(typeof raw.name === 'string' ? { name: raw.name.trim().slice(0, 120) } : {}),
    baseColor: rgba(raw.baseColor, `materials[${index}].baseColor`, errors, [0.8, 0.8, 0.8, 1]),
    metallic: boundedNumber(raw.metallic, `materials[${index}].metallic`, errors, 0, 0, 1),
    roughness: boundedNumber(raw.roughness, `materials[${index}].roughness`, errors, 0.45, 0, 1),
    ...(raw.emissionColor !== undefined ? { emissionColor: rgba(raw.emissionColor, `materials[${index}].emissionColor`, errors, [0, 0, 0, 1]) } : {}),
    ...(raw.emissionStrength !== undefined ? { emissionStrength: boundedNumber(raw.emissionStrength, `materials[${index}].emissionStrength`, errors, 0, 0, 100) } : {}),
    ...(typeof raw.textureAssetId === 'string' ? { textureAssetId: cleanId(raw.textureAssetId, `materials[${index}].textureAssetId`, errors) } : {}),
  };
}

function normalizeObject(value: unknown, index: number, errors: string[]): BlenderSceneObject {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['id', 'name', 'primitive', 'transform', 'dimensions', 'materialId', 'text', 'bevelDepth'], `objects[${index}]`, errors);
  const primitive = raw.primitive;
  if (!['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'text'].includes(String(primitive))) {
    errors.push(`objects[${index}].primitive is not supported`);
  }
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT_LENGTH) : undefined;
  if (raw.text !== undefined && !text?.trim()) errors.push(`objects[${index}].text cannot be empty`);
  return {
    id: cleanId(raw.id, `objects[${index}].id`, errors),
    ...(typeof raw.name === 'string' ? { name: raw.name.trim().slice(0, 120) } : {}),
    primitive: (['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'text'].includes(String(primitive)) ? primitive : 'cube') as BlenderSceneObject['primitive'],
    transform: transform(raw.transform, `objects[${index}].transform`, errors),
    ...(raw.dimensions !== undefined ? { dimensions: vec3(raw.dimensions, `objects[${index}].dimensions`, errors, [1, 1, 1]) } : {}),
    ...(typeof raw.materialId === 'string' ? { materialId: cleanId(raw.materialId, `objects[${index}].materialId`, errors) } : {}),
    ...(text ? { text } : {}),
    ...(raw.bevelDepth !== undefined ? { bevelDepth: boundedNumber(raw.bevelDepth, `objects[${index}].bevelDepth`, errors, 0.02, 0, 1) } : {}),
  };
}

function normalizeLight(value: unknown, index: number, errors: string[]): BlenderLight {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['id', 'type', 'transform', 'energy', 'color', 'size'], `lights[${index}]`, errors);
  const type = ['AREA', 'POINT', 'SUN', 'SPOT'].includes(String(raw.type)) ? raw.type as BlenderLight['type'] : 'AREA';
  if (type !== raw.type) errors.push(`lights[${index}].type is not supported`);
  return {
    id: cleanId(raw.id, `lights[${index}].id`, errors),
    type,
    transform: transform(raw.transform, `lights[${index}].transform`, errors),
    energy: boundedNumber(raw.energy, `lights[${index}].energy`, errors, type === 'SUN' ? 2 : 800, 0, 100_000),
    color: rgba(raw.color, `lights[${index}].color`, errors, [1, 1, 1, 1]),
    ...(raw.size !== undefined ? { size: boundedNumber(raw.size, `lights[${index}].size`, errors, 2, 0.01, 1000) } : {}),
  };
}

function normalizeCamera(value: unknown, index: number, errors: string[]): BlenderCamera {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['id', 'transform', 'lensMm'], `cameras[${index}]`, errors);
  return {
    id: cleanId(raw.id, `cameras[${index}].id`, errors),
    transform: transform(raw.transform, `cameras[${index}].transform`, errors),
    lensMm: boundedNumber(raw.lensMm, `cameras[${index}].lensMm`, errors, 50, 8, 300),
  };
}

function normalizeAnimation(value: unknown, index: number, errors: string[]): BlenderAnimationTrack {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  rejectUnknown(raw, ['objectId', 'property', 'keyframes'], `animation[${index}]`, errors);
  const objectId = cleanId(raw.objectId, `animation[${index}].objectId`, errors);
  const property = raw.property === 'location' || raw.property === 'rotation' || raw.property === 'scale'
    ? raw.property
    : 'location';
  if (property !== raw.property) errors.push(`animation[${index}].property is not supported`);
  const rawKeyframes = Array.isArray(raw.keyframes) ? raw.keyframes : [];
  if (!rawKeyframes.length || rawKeyframes.length > 120) errors.push(`animation[${index}].keyframes must contain 1-120 keyframes`);
  const keyframes = rawKeyframes.slice(0, 120).map((item, keyframeIndex) => {
    const keyframe = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    rejectUnknown(keyframe, ['frame', 'value'], `animation[${index}].keyframes[${keyframeIndex}]`, errors);
    return {
      frame: Math.floor(boundedNumber(keyframe.frame, `animation[${index}].keyframes[${keyframeIndex}].frame`, errors, 1, 1, MAX_FRAMES)),
      value: vec3(keyframe.value, `animation[${index}].keyframes[${keyframeIndex}].value`, errors, [0, 0, 0]),
    };
  });
  return { objectId, property, keyframes };
}

function uniqueIds(values: Array<{ id: string }>, field: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of values) {
    if (!item.id || seen.has(item.id)) errors.push(`${field} ids must be unique`);
    seen.add(item.id);
  }
}

export function validateSceneSpec(input: unknown): BlenderSceneSpecValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['scene must be an object'] };
  const raw = input as Record<string, unknown>;
  rejectUnknown(raw, ['schema', 'title', 'seed', 'units', 'project', 'assets', 'materials', 'objects', 'lights', 'cameras', 'activeCameraId', 'world', 'animation', 'render', 'deliverables', 'budgets'], 'scene', errors);
  if (raw.schema !== BLENDER_SCENE_SCHEMA) errors.push(`scene.schema must equal ${BLENDER_SCENE_SCHEMA}`);
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 160) : '';
  if (!title) errors.push('scene.title is required');
  const objects = Array.isArray(raw.objects) ? raw.objects.map((item, index) => normalizeObject(item, index, errors)) : [];
  if (!objects.length) errors.push('scene.objects must contain at least one object');
  if (objects.length > MAX_OBJECTS) errors.push(`scene.objects exceeds ${MAX_OBJECTS}`);
  const assets = Array.isArray(raw.assets) ? raw.assets.map((item, index) => normalizeAsset(item, index, errors)) : [];
  const materials = Array.isArray(raw.materials) ? raw.materials.map((item, index) => normalizeMaterial(item, index, errors)) : [];
  const lights = Array.isArray(raw.lights) ? raw.lights.map((item, index) => normalizeLight(item, index, errors)) : [];
  const cameras = Array.isArray(raw.cameras) ? raw.cameras.map((item, index) => normalizeCamera(item, index, errors)) : [];
  const animation = Array.isArray(raw.animation) ? raw.animation.map((item, index) => normalizeAnimation(item, index, errors)) : [];
  if (assets.length > MAX_ASSETS) errors.push(`scene.assets exceeds ${MAX_ASSETS}`);
  if (materials.length > MAX_MATERIALS) errors.push(`scene.materials exceeds ${MAX_MATERIALS}`);
  if (lights.length > MAX_LIGHTS) errors.push(`scene.lights exceeds ${MAX_LIGHTS}`);
  if (cameras.length > MAX_CAMERAS) errors.push(`scene.cameras exceeds ${MAX_CAMERAS}`);
  uniqueIds(objects, 'scene.objects', errors);
  uniqueIds(assets, 'scene.assets', errors);
  uniqueIds(materials, 'scene.materials', errors);
  uniqueIds(lights, 'scene.lights', errors);
  uniqueIds(cameras, 'scene.cameras', errors);
  const materialIds = new Set(materials.map((item) => item.id));
  const assetIds = new Set(assets.map((item) => item.id));
  for (const object of objects) if (object.materialId && !materialIds.has(object.materialId)) errors.push(`object ${object.id} references missing material ${object.materialId}`);
  for (const material of materials) if (material.textureAssetId && !assetIds.has(material.textureAssetId)) errors.push(`material ${material.id} references missing asset ${material.textureAssetId}`);
  for (const track of animation) if (!objects.some((object) => object.id === track.objectId)) errors.push(`animation references missing object ${track.objectId}`);
  const projectRaw = raw.project && typeof raw.project === 'object' && !Array.isArray(raw.project) ? raw.project as Record<string, unknown> : {};
  const frameStart = Math.floor(boundedNumber(projectRaw.frameStart, 'project.frameStart', errors, 1, 1, MAX_FRAMES));
  const frameEnd = Math.floor(boundedNumber(projectRaw.frameEnd, 'project.frameEnd', errors, 120, frameStart, MAX_FRAMES));
  const fps = Math.floor(boundedNumber(projectRaw.fps, 'project.fps', errors, 24, 1, 120));
  const renderRaw = raw.render && typeof raw.render === 'object' && !Array.isArray(raw.render) ? raw.render as Record<string, unknown> : {};
  const engine = renderRaw.engine === 'CYCLES' ? 'CYCLES' : 'BLENDER_EEVEE_NEXT';
  if (renderRaw.engine !== undefined && renderRaw.engine !== engine) errors.push('render.engine must be BLENDER_EEVEE_NEXT or CYCLES');
  const width = Math.floor(boundedNumber(renderRaw.width, 'render.width', errors, 1024, 64, MAX_RENDER_DIMENSION));
  const height = Math.floor(boundedNumber(renderRaw.height, 'render.height', errors, 1024, 64, MAX_RENDER_DIMENSION));
  const samples = Math.floor(boundedNumber(renderRaw.samples, 'render.samples', errors, engine === 'CYCLES' ? 32 : 64, 1, MAX_RENDER_SAMPLES));
  const deliverableRaw = raw.deliverables && typeof raw.deliverables === 'object' && !Array.isArray(raw.deliverables) ? raw.deliverables as Record<string, unknown> : {};
  const budgetRaw = raw.budgets && typeof raw.budgets === 'object' && !Array.isArray(raw.budgets) ? raw.budgets as Record<string, unknown> : {};
  const activeCameraId = typeof raw.activeCameraId === 'string' ? cleanId(raw.activeCameraId, 'activeCameraId', errors) : cameras[0]?.id;
  if (activeCameraId && !cameras.some((camera) => camera.id === activeCameraId)) errors.push(`activeCameraId references missing camera ${activeCameraId}`);
  const spec: BlenderSceneSpec = {
    schema: BLENDER_SCENE_SCHEMA,
    title,
    ...(FINITE_NUMBER(raw.seed) ? { seed: Math.floor(raw.seed) } : {}),
    units: raw.units === 'CENTIMETERS' || raw.units === 'MILLIMETERS' ? raw.units : 'METERS',
    project: { frameStart, frameEnd, fps },
    assets,
    materials,
    objects,
    lights,
    cameras,
    ...(activeCameraId ? { activeCameraId } : {}),
    world: {
      color: rgba((raw.world as Record<string, unknown> | undefined)?.color, 'world.color', errors, [0.035, 0.035, 0.05, 1]),
      strength: boundedNumber((raw.world as Record<string, unknown> | undefined)?.strength, 'world.strength', errors, 0.25, 0, 5),
    },
    ...(animation.length ? { animation } : {}),
    render: { engine, width, height, samples, transparent: renderRaw.transparent === true },
    deliverables: {
      blend: deliverableRaw.blend !== false,
      glb: deliverableRaw.glb !== false,
      heroImage: deliverableRaw.heroImage !== false,
      turntable: deliverableRaw.turntable === true,
    },
    budgets: {
      maxObjects: Math.floor(boundedNumber(budgetRaw.maxObjects, 'budgets.maxObjects', errors, Math.min(MAX_OBJECTS, Math.max(objects.length, 100)), 1, MAX_OBJECTS)),
      maxTriangles: Math.floor(boundedNumber(budgetRaw.maxTriangles, 'budgets.maxTriangles', errors, 1_000_000, 1_000, 5_000_000)),
      maxTextureBytes: Math.floor(boundedNumber(budgetRaw.maxTextureBytes, 'budgets.maxTextureBytes', errors, 250 * 1024 * 1024, 1_024, 1024 * 1024 * 1024)),
      maxOutputBytes: Math.floor(boundedNumber(budgetRaw.maxOutputBytes, 'budgets.maxOutputBytes', errors, 800 * 1024 * 1024, 1_024, 2 * 1024 * 1024 * 1024)),
      maxRenderSeconds: Math.floor(boundedNumber(budgetRaw.maxRenderSeconds, 'budgets.maxRenderSeconds', errors, 300, 10, 1_800)),
    },
  };
  if (objects.length > (spec.budgets?.maxObjects ?? MAX_OBJECTS)) errors.push('scene.objects exceeds budgets.maxObjects');
  return { ok: errors.length === 0, ...(errors.length ? {} : { normalized: spec }), errors };
}
