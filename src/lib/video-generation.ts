import { hostApiFetch } from '@/lib/host-api';
import {
  JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS,
  JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS,
} from '../../shared/junfeiai-endpoints';

export interface VideoGenerationModelConfig {
  primary: string | null;
  fallbacks: string[];
  timeoutMs: number | null;
}

export interface VideoGenerationAgentAuthRow {
  id: string;
  name: string;
  isDefault: boolean;
  provider: string | null;
  configured: boolean;
}

export interface VideoGenerationModelOption {
  id: string;
  label: string;
  description: string;
  verified: boolean;
  modes: string[];
}

export interface OpenAiVideoRelayConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  providerKey?: string;
  apiKeyConfigured: boolean;
  inheritedFromManagedAccount?: boolean;
  modelOptions: VideoGenerationModelOption[];
}

export interface VideoGenerationSettingsSnapshot {
  config: VideoGenerationModelConfig;
  autoProviderFallback: boolean;
  defaultAgentId: string;
  agents: VideoGenerationAgentAuthRow[];
  openAiRelay: OpenAiVideoRelayConfig;
}

export interface VideoGenerationProviderRow {
  id: string;
  label: string;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  selected: boolean;
  models: string[];
}

export interface VideoGenerationTestResult {
  success: boolean;
  agentId: string;
  command: string;
  durationMs: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
}

export async function fetchVideoGenerationSettings(): Promise<VideoGenerationSettingsSnapshot> {
  const response = await hostApiFetch<{ success: boolean } & VideoGenerationSettingsSnapshot>(
    '/api/media/video-generation',
  );
  if (response.success === false) {
    throw new Error('Failed to load video generation settings');
  }
  return response;
}

export async function clearVideoGenerationSettings(): Promise<VideoGenerationSettingsSnapshot> {
  return saveVideoGenerationSettings({ openAiRelayEnabled: false });
}

export async function saveVideoGenerationSettings(payload: {
  primary?: string | null;
  fallbacks?: string[];
  openAiRelayEnabled?: boolean;
  openAiRelayBaseUrl?: string | null;
  openAiRelayModel?: string | null;
  openAiRelayApiKey?: string;
}): Promise<VideoGenerationSettingsSnapshot> {
  const response = await hostApiFetch<{ success: boolean } & VideoGenerationSettingsSnapshot>(
    '/api/media/video-generation',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (response.success === false) {
    throw new Error('Failed to save video generation settings');
  }
  return response;
}

export async function fetchVideoGenerationProviders(): Promise<VideoGenerationProviderRow[]> {
  const response = await hostApiFetch<{ success: boolean; providers: VideoGenerationProviderRow[] }>(
    '/api/media/video-generation/providers',
  );
  if (response.success === false) {
    throw new Error('Failed to list video generation providers');
  }
  return response.providers ?? [];
}

const VIDEO_GEN_CLIENT_TEST_TIMEOUT_MS =
  JUNFEIAI_VIDEO_GENERATION_TIMEOUT_MS + JUNFEIAI_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS;

export async function runVideoGenerationTest(payload: {
  agentId?: string;
  prompt?: string;
  model?: string;
}): Promise<VideoGenerationTestResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Video generation test timed out. Try again or lower the timeout in settings.'));
    }, VIDEO_GEN_CLIENT_TEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      hostApiFetch<VideoGenerationTestResult>('/api/media/video-generation/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
