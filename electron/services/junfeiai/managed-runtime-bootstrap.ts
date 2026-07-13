import {
  isManagedOpenAiChatMigrated,
  migrateManagedChatToOpenAi,
} from '../providers/openai-chat-migration';
import { ensureManagedOpenAiImageRelay } from '../../utils/openclaw-image-generation';
import { ensureManagedOpenAiVideoRelay } from '../../utils/openclaw-video-generation';

export type ManagedRuntimeBootstrapResult = {
  ready: boolean;
  migratedNow: boolean;
};

export type ManagedRuntimeBootstrapDependencies = {
  isMigrated: () => Promise<boolean>;
  migrate: () => Promise<unknown>;
  ensureImage: () => Promise<void>;
  ensureVideo: () => Promise<void>;
};

const defaultDependencies: ManagedRuntimeBootstrapDependencies = {
  isMigrated: isManagedOpenAiChatMigrated,
  migrate: migrateManagedChatToOpenAi,
  ensureImage: () => ensureManagedOpenAiImageRelay({ preserveExisting: true }),
  ensureVideo: () => ensureManagedOpenAiVideoRelay({ preserveExisting: true }),
};

export async function ensureJunFeiAIManagedRuntimeBootstrap(
  dependencies: ManagedRuntimeBootstrapDependencies = defaultDependencies,
): Promise<ManagedRuntimeBootstrapResult> {
  let migrated = await dependencies.isMigrated();
  let migratedNow = false;

  if (!migrated) {
    await dependencies.migrate();
    migrated = await dependencies.isMigrated();
    migratedNow = migrated;
  }

  if (!migrated) {
    throw new Error('managed_openai_runtime_bootstrap_incomplete: migration did not become active');
  }

  await dependencies.ensureImage();
  await dependencies.ensureVideo();
  return { ready: true, migratedNow };
}
