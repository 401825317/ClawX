import type { GatewayManager } from '../../gateway/manager';
import { blenderJobService } from '../blender';
import { desktopRunCoordinator } from '../computer';
import { ensureDefaultHostCapabilities } from './host-capability-defaults';
import { hostCapabilityRegistry } from './host-capability-registry';
import { getImageGenerationSettingsSnapshot } from '../../utils/openclaw-image-generation';
import { getVideoGenerationSettingsSnapshot } from '../../utils/openclaw-video-generation';

export type RuntimeCapabilityAvailability = 'available' | 'unavailable' | 'degraded' | 'not_implemented' | 'unknown';
export type RuntimeCapabilityKind = 'tool' | 'skill' | 'media' | 'desktop' | 'blender' | 'host_task';

export type RuntimeCapabilityEntry = {
  id: string;
  kind: RuntimeCapabilityKind;
  label: string;
  availability: RuntimeCapabilityAvailability;
  sideEffect: 'none' | 'local_artifact' | 'remote_generation' | 'external_action';
  requiresApproval: boolean;
  description?: string;
  reason?: string;
  source: 'openclaw' | 'uclaw-host';
};

export type RuntimeCapabilityCatalog = {
  schema: 'uclaw.runtime-capabilities/v1';
  sessionKey?: string;
  checkedAt: number;
  capabilities: RuntimeCapabilityEntry[];
};

type RuntimeRecord = Record<string, unknown>;

function asRecord(value: unknown): RuntimeRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RuntimeRecord
    : null;
}

function text(value: unknown, maximum = 600): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function configuredPrimary(value: unknown): boolean {
  const record = asRecord(value);
  const config = asRecord(record?.config) ?? record;
  return Boolean(text(config?.primary));
}

export function normalizeReportedCapability(
  value: unknown,
  name: string,
): Pick<RuntimeCapabilityEntry, 'availability' | 'reason'> {
  const record = asRecord(value);
  const capabilities = Array.isArray(record?.capabilities) ? record.capabilities : [];
  const capability = capabilities
    .map(asRecord)
    .find((candidate) => text(candidate?.name) === name);
  if (!capability) return { availability: 'unknown', reason: `Host did not report ${name}.` };
  const status = text(capability.status)?.toLowerCase().replace(/_/gu, '-');
  const availability: RuntimeCapabilityAvailability = status === 'available'
    ? 'available'
    : status === 'unavailable'
      ? 'unavailable'
      : status === 'degraded'
        ? 'degraded'
        : status === 'not-implemented'
          ? 'not_implemented'
          : 'unknown';
  return {
    availability,
    reason: text(capability.reason),
  };
}

function uniqueCapabilities(entries: RuntimeCapabilityEntry[]): RuntimeCapabilityEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Extracts the actual session tool descriptors returned by tools.effective. */
export function extractEffectiveToolEntries(value: unknown): RuntimeCapabilityEntry[] {
  const entries: RuntimeCapabilityEntry[] = [];
  const visited = new Set<object>();

  const visit = (candidate: unknown, depth = 0): void => {
    if (depth > 6 || candidate == null) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = asRecord(candidate);
    if (!record || visited.has(record)) return;
    visited.add(record);

    const name = text(record.name) ?? text(record.toolName) ?? text(record.id);
    const description = text(record.description) ?? text(record.summary);
    const looksLikeTool = Boolean(name && (
      'parameters' in record
      || 'inputSchema' in record
      || 'toolName' in record
      || 'description' in record
    ));
    if (looksLikeTool && name) {
      entries.push({
        id: `tool:${name}`,
        kind: 'tool',
        label: name,
        availability: record.enabled === false ? 'unavailable' : 'available',
        sideEffect: 'none',
        requiresApproval: false,
        description,
        reason: record.enabled === false ? 'OpenClaw reported this tool as disabled.' : undefined,
        source: 'openclaw',
      });
    }
    for (const key of ['tools', 'entries', 'items', 'groups', 'catalog', 'effectiveTools']) {
      visit(record[key], depth + 1);
    }
  };

  visit(value);
  return uniqueCapabilities(entries);
}

/** Normalizes skills.list without treating a disk-only skill as executable. */
export function normalizeRuntimeSkillEntries(value: unknown): RuntimeCapabilityEntry[] {
  if (!Array.isArray(value)) return [];
  return uniqueCapabilities(value.flatMap((candidate) => {
    const record = asRecord(candidate);
    const id = text(record?.id) ?? text(record?.slug) ?? text(record?.name);
    if (!id) return [];
    const enabled = record?.enabled !== false && record?.available !== false;
    return [{
      id: `skill:${id}`,
      kind: 'skill' as const,
      label: text(record?.name) ?? id,
      availability: enabled ? 'available' as const : 'unavailable' as const,
      sideEffect: 'none' as const,
      requiresApproval: false,
      description: text(record?.description),
      reason: enabled ? undefined : 'OpenClaw reported this skill as disabled or unavailable.',
      source: 'openclaw' as const,
    }];
  }));
}

async function probe<T>(operation: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function hostCapability(id: string, label: string, availability: RuntimeCapabilityAvailability, options: {
  sideEffect: RuntimeCapabilityEntry['sideEffect'];
  requiresApproval?: boolean;
  description?: string;
  reason?: string;
}): RuntimeCapabilityEntry {
  return {
    id,
    kind: id.startsWith('desktop:') ? 'desktop' : id.startsWith('blender:') ? 'blender' : id.startsWith('media:') ? 'media' : 'host_task',
    label,
    availability,
    sideEffect: options.sideEffect,
    requiresApproval: options.requiresApproval === true,
    description: options.description,
    reason: options.reason,
    source: 'uclaw-host',
  };
}

export async function buildRuntimeCapabilityCatalog(params: {
  gatewayManager: GatewayManager;
  sessionKey?: string;
}): Promise<RuntimeCapabilityCatalog> {
  ensureDefaultHostCapabilities();
  const sessionKey = params.sessionKey?.trim() || undefined;
  const [tools, skills, image, video, desktop, blender, hostTasks] = await Promise.all([
    sessionKey
      ? probe(() => params.gatewayManager.rpc('tools.effective', { sessionKey }, 5_000))
      : Promise.resolve({ error: 'A sessionKey is required to inspect the effective OpenClaw tool set.' }),
    probe(() => params.gatewayManager.rpc('skills.list', undefined, 5_000)),
    probe(() => getImageGenerationSettingsSnapshot()),
    probe(() => getVideoGenerationSettingsSnapshot()),
    probe(() => desktopRunCoordinator.getCapabilities()),
    probe(() => blenderJobService.capabilities()),
    probe(() => hostCapabilityRegistry.list()),
  ]);
  const desktopObservation = desktop.value
    ? normalizeReportedCapability(desktop.value, 'desktop.capture')
    : { availability: 'unknown' as const, reason: desktop.error };
  const desktopAction = desktop.value
    ? normalizeReportedCapability(desktop.value, 'desktop.actions')
    : { availability: 'unknown' as const, reason: desktop.error };
  const blenderAvailability: RuntimeCapabilityAvailability = blender.value
    ? (blender.value.available ? 'available' : 'unavailable')
    : 'unknown';

  const capabilities: RuntimeCapabilityEntry[] = [
    ...(tools.value ? extractEffectiveToolEntries(tools.value) : [hostCapability(
      'tool-catalog:effective',
      'OpenClaw session tools',
      'unknown',
      { sideEffect: 'none', reason: tools.error },
    )]),
    ...(skills.value ? normalizeRuntimeSkillEntries(skills.value) : [hostCapability(
      'skill-catalog:runtime',
      'OpenClaw runtime skills',
      'unknown',
      { sideEffect: 'none', reason: skills.error },
    )]),
    hostCapability(
      'media:image.generate',
      'Image generation',
      image.value ? (configuredPrimary(image.value) ? 'available' : 'unavailable') : 'unknown',
      {
        sideEffect: 'remote_generation',
        description: 'Generate or edit images through the configured OpenClaw image runtime.',
        reason: image.error ?? (configuredPrimary(image.value) ? undefined : 'No primary image generation model is configured.'),
      },
    ),
    hostCapability(
      'media:video.generate',
      'Video generation',
      video.value ? (configuredPrimary(video.value) ? 'available' : 'unavailable') : 'unknown',
      {
        sideEffect: 'remote_generation',
        description: 'Generate a single video through the configured OpenClaw video runtime.',
        reason: video.error ?? (configuredPrimary(video.value) ? undefined : 'No primary video generation model is configured.'),
      },
    ),
    hostCapability(
      'desktop:observe',
      'Desktop observation',
      desktopObservation.availability,
      { sideEffect: 'none', description: 'Observe a desktop app with a fresh screenshot and accessibility snapshot.', reason: desktopObservation.reason },
    ),
    hostCapability(
      'desktop:action',
      'Desktop actions',
      desktopAction.availability,
      {
        sideEffect: 'external_action',
        requiresApproval: true,
        description: 'Desktop actions require explicit local approval and a native action driver.',
        reason: desktopAction.reason,
      },
    ),
    hostCapability(
      'blender:scene',
      'Blender scene generation',
      blenderAvailability,
      {
        sideEffect: 'local_artifact',
        description: 'Create and validate a Blender scene through the UClaw host runtime.',
        reason: blender.error ?? (blender.value?.available ? undefined : 'Blender executable or trusted runner is unavailable.'),
      },
    ),
    ...(hostTasks.value ?? []).map((capability) => hostCapability(
      `host-task:${capability.kind}`,
      capability.label,
      capability.availability,
      {
        sideEffect: capability.sideEffect,
        requiresApproval: capability.requiresApproval,
        description: capability.description,
        reason: capability.reason,
      },
    )),
    ...(hostTasks.error ? [hostCapability(
      'host-task:catalog',
      'Recoverable host tasks',
      'unknown',
      { sideEffect: 'none', reason: hostTasks.error },
    )] : []),
  ];

  return {
    schema: 'uclaw.runtime-capabilities/v1',
    sessionKey,
    checkedAt: Date.now(),
    capabilities: uniqueCapabilities(capabilities),
  };
}
