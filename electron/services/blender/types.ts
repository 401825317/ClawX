export const BLENDER_SCENE_SCHEMA = 'uclaw.blender.scene/v1' as const;

export type BlenderPrimitive = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'text';
export type BlenderRenderEngine = 'BLENDER_EEVEE_NEXT' | 'CYCLES';

export type BlenderAssetRef = {
  id: string;
  path: string;
  sha256?: string;
  mediaType?: 'image' | 'model';
  license?: string;
  sourceUrl?: string;
};

export type BlenderTransform = {
  location?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
};

export type BlenderMaterial = {
  id: string;
  name?: string;
  baseColor?: [number, number, number, number];
  metallic?: number;
  roughness?: number;
  emissionColor?: [number, number, number, number];
  emissionStrength?: number;
  textureAssetId?: string;
};

export type BlenderSceneObject = {
  id: string;
  name?: string;
  primitive: BlenderPrimitive;
  transform?: BlenderTransform;
  dimensions?: [number, number, number];
  materialId?: string;
  text?: string;
  bevelDepth?: number;
};

export type BlenderLight = {
  id: string;
  type: 'AREA' | 'POINT' | 'SUN' | 'SPOT';
  transform?: BlenderTransform;
  energy?: number;
  color?: [number, number, number, number];
  size?: number;
};

export type BlenderCamera = {
  id: string;
  transform?: BlenderTransform;
  lensMm?: number;
};

export type BlenderAnimationTrack = {
  objectId: string;
  property: 'location' | 'rotation' | 'scale';
  keyframes: Array<{
    frame: number;
    value: [number, number, number];
  }>;
};

export type BlenderSceneSpec = {
  schema: typeof BLENDER_SCENE_SCHEMA;
  title: string;
  seed?: number;
  units?: 'METERS' | 'CENTIMETERS' | 'MILLIMETERS';
  project?: {
    frameStart?: number;
    frameEnd?: number;
    fps?: number;
  };
  assets?: BlenderAssetRef[];
  materials?: BlenderMaterial[];
  objects: BlenderSceneObject[];
  lights?: BlenderLight[];
  cameras?: BlenderCamera[];
  activeCameraId?: string;
  world?: {
    color?: [number, number, number, number];
    strength?: number;
  };
  animation?: BlenderAnimationTrack[];
  render?: {
    engine?: BlenderRenderEngine;
    width?: number;
    height?: number;
    samples?: number;
    transparent?: boolean;
  };
  deliverables?: {
    blend?: boolean;
    glb?: boolean;
    heroImage?: boolean;
    turntable?: boolean;
  };
  budgets?: {
    maxObjects?: number;
    maxTriangles?: number;
    maxTextureBytes?: number;
    maxOutputBytes?: number;
    maxRenderSeconds?: number;
  };
};

export type BlenderSceneSpecValidation = {
  ok: boolean;
  normalized?: BlenderSceneSpec;
  errors: string[];
};

export type BlenderArtifactRole = 'model3d.source' | 'model3d.portable' | 'render.hero' | 'render.turntable' | 'manifest';

export type BlenderArtifact = {
  id: string;
  role: BlenderArtifactRole;
  title: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type BlenderVerification = {
  id: string;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  kind: 'command.exit' | 'scene.structure' | 'scene.asset_resolution' | 'scene.budget' | 'model.gltf' | 'render.visual' | 'media.metadata' | 'artifact.integrity';
  required: boolean;
  severity: 'info' | 'warning' | 'blocking';
  title: string;
  detail: string;
  artifactId?: string;
  evidence?: string;
};

export type BlenderJobStage = 'queued' | 'staging_assets' | 'building_scene' | 'rendering' | 'exporting' | 'validating' | 'recovering';
export type BlenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export type BlenderJobSnapshot = {
  version: 1;
  jobId: string;
  clientRequestId: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  cwd?: string;
  title: string;
  status: BlenderJobStatus;
  stage: BlenderJobStage;
  revision: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  recoverable?: boolean;
  jobDir: string;
  sceneSpec: BlenderSceneSpec;
  artifacts: BlenderArtifact[];
  verifications: BlenderVerification[];
  progress?: { completed: number; total: number; message: string };
};

export type BlenderJobRequest = {
  clientRequestId: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  cwd?: string;
  scene?: unknown;
  sceneSpec?: unknown;
  prompt?: string;
};

export type BlenderRepairPatch =
  | { op: 'replace_object'; objectId: string; object: BlenderSceneObject }
  | { op: 'replace_material'; materialId: string; material: BlenderMaterial }
  | { op: 'replace_lights'; lights: BlenderLight[] }
  | { op: 'replace_camera'; cameraId: string; camera: BlenderCamera }
  | { op: 'replace_render'; render: NonNullable<BlenderSceneSpec['render']> };
