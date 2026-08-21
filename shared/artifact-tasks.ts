export type ArtifactTaskKind = 'presentation' | 'document' | 'spreadsheet' | 'webpage' | 'cad' | 'ecommerce-main-image';
export type ArtifactTaskIntent = 'create' | 'modify';
export type ArtifactTaskMode = 'fast' | 'refined';

/**
 * Runtime kill switches are delivered with the managed client configuration.
 * They are kept in the task policy so every Main-process consumer observes
 * the same decision for a prepared artifact turn.
 */
export type ArtifactRuntimeFeatureFlags = {
  artifacts: boolean;
  htmlPreview: boolean;
  longTermRules: boolean;
};

export type ArtifactTaskPreparePayload = {
  sessionKey: string;
  agentId: string;
  workspaceRoot: string;
  message: string;
  hasHistory: boolean;
  kindHint?: ArtifactTaskKind;
};

export type ArtifactTaskPrepareResult = {
  artifactTask: boolean;
  effectiveSessionKey: string;
  createSession: boolean;
  kind?: ArtifactTaskKind;
  intent?: ArtifactTaskIntent;
  mode?: ArtifactTaskMode;
  policyVersion?: string;
};

export type ArtifactWebpageValidationPayload = {
  workspaceRoot: string;
  filePath: string;
};

export type ArtifactWebpageValidationResult = {
  ok: boolean;
  /** A tokenized loopback URL for the in-app browser. */
  browserUrl?: string;
} & Record<string, unknown>;

export type ArtifactRuntimePolicy = {
  schemaVersion: 1;
  sessionKey: string;
  workspaceRoot: string;
  kind: ArtifactTaskKind;
  intent: ArtifactTaskIntent;
  mode: ArtifactTaskMode;
  skillId: string;
  promptContract: string;
  modelAlias: string;
  thinkingLevel: 'minimal' | 'high';
  fastMode: boolean;
  maxRepairs: number;
  allowNetwork: boolean;
  allowImageGeneration: boolean;
  runtimeFeatures: ArtifactRuntimeFeatureFlags;
  targetFile?: string;
  preparedAt: string;
  expiresAt: string;
};
