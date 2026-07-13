import {
  isManagedOpenAiChatMigrated,
  migrateManagedChatToOpenAi,
} from '../providers/openai-chat-migration';
import { ensureManagedOpenAiImageRelay } from '../../utils/openclaw-image-generation';
import { ensureManagedOpenAiVideoRelay } from '../../utils/openclaw-video-generation';

export type ManagedRuntimeBootstrapResult = {
  ready: boolean;
  migratedNow: boolean;
  blockedReason?: 'personal_openai_account' | 'personal_openai_runtime';
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

function managedOpenAiConflictReason(
  error: unknown,
): ManagedRuntimeBootstrapResult['blockedReason'] | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('managed_openai_account_conflict')) {
    return 'personal_openai_account';
  }
  if (message.includes('managed_openai_runtime_conflict')) {
    return 'personal_openai_runtime';
  }
  return null;
}

export async function ensureJunFeiAIManagedRuntimeBootstrap(
  dependencies: ManagedRuntimeBootstrapDependencies = defaultDependencies,
): Promise<ManagedRuntimeBootstrapResult> {
  let migrated = await dependencies.isMigrated();
  let migratedNow = false;

  if (!migrated) {
    try {
      await dependencies.migrate();
    } catch (error) {
      const blockedReason = managedOpenAiConflictReason(error);
      if (blockedReason) {
        return { ready: false, migratedNow: false, blockedReason };
      }
      throw error;
    }
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
