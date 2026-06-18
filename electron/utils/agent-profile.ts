import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { expandPath, getOpenClawConfigDir } from './paths';
import * as logger from './logger';

const PROFILE_FILE_NAME = 'uclaw-agent-profiles.json';
const WORKSPACE_PROFILE_FILE = 'UCLAW_AGENT_PROFILE.md';
const AGENTS_MARKER_START = '<!-- UCLAW_AGENT_PROFILE_START -->';
const AGENTS_MARKER_END = '<!-- UCLAW_AGENT_PROFILE_END -->';

export interface AgentProfile {
  agentId?: string;
  roleName: string;
  personaName: string;
  responsibility: string;
  capabilities: string[];
  boundaries: string[];
  workspaceInstructions: string;
  welcomeMessage: string;
  avatarId: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentProfileInput = Partial<AgentProfile> & {
  roleName?: string;
  personaName?: string;
  responsibility?: string;
  avatarId?: string;
};

function getProfileStorePath(): string {
  return join(getOpenClawConfigDir(), PROFILE_FILE_NAME);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  const text = normalizeText(value);
  if (!text) return fallback;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeProfile(
  agentId: string,
  input: unknown,
  existing?: AgentProfile | null,
): AgentProfile | null {
  const record = asRecord(input);
  if (!record) return null;

  const now = new Date().toISOString();
  const roleName = normalizeText(record.roleName, existing?.roleName || 'Agent');
  const personaName = normalizeText(record.personaName, existing?.personaName || roleName);
  const responsibility = normalizeText(record.responsibility, existing?.responsibility || roleName);
  const avatarId = normalizeText(record.avatarId, existing?.avatarId || 'strategist');
  const capabilities = normalizeTextArray(record.capabilities);
  const boundaries = normalizeTextArray(record.boundaries);

  return {
    agentId,
    roleName,
    personaName,
    responsibility,
    capabilities: capabilities.length > 0 ? capabilities : existing?.capabilities ?? [],
    boundaries: boundaries.length > 0 ? boundaries : existing?.boundaries ?? [],
    workspaceInstructions: normalizeText(record.workspaceInstructions, existing?.workspaceInstructions || responsibility),
    welcomeMessage: normalizeText(record.welcomeMessage, existing?.welcomeMessage || ''),
    avatarId,
    createdAt: normalizeTimestamp(record.createdAt, existing?.createdAt || now),
    updatedAt: now,
  };
}

export async function readAgentProfiles(): Promise<Record<string, AgentProfile>> {
  try {
    const raw = await readFile(getProfileStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const root = asRecord(parsed);
    if (!root) return {};

    const profiles: Record<string, AgentProfile> = {};
    for (const [agentId, value] of Object.entries(root)) {
      const normalized = normalizeProfile(agentId, value);
      if (normalized) profiles[agentId] = normalized;
    }
    return profiles;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code === 'ENOENT') return {};
    logger.warn('Failed to read UClaw agent profiles', { error: String(error) });
    return {};
  }
}

async function writeAgentProfiles(profiles: Record<string, AgentProfile>): Promise<void> {
  const storePath = getProfileStorePath();
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(profiles, null, 2), 'utf8');
}

export async function upsertAgentProfile(
  agentId: string,
  input: AgentProfileInput,
): Promise<AgentProfile> {
  const profiles = await readAgentProfiles();
  const normalized = normalizeProfile(agentId, input, profiles[agentId]);
  if (!normalized) {
    throw new Error('Invalid agent profile');
  }
  profiles[agentId] = normalized;
  await writeAgentProfiles(profiles);
  return normalized;
}

export async function deleteAgentProfile(agentId: string): Promise<void> {
  const profiles = await readAgentProfiles();
  if (!profiles[agentId]) return;
  delete profiles[agentId];
  await writeAgentProfiles(profiles);
}

function renderProfileMarkdown(profile: AgentProfile): string {
  const capabilities = profile.capabilities.length > 0
    ? profile.capabilities.map((item) => `- ${item}`).join('\n')
    : '- Follow the primary responsibility with clear, useful execution.';
  const boundaries = profile.boundaries.length > 0
    ? profile.boundaries.map((item) => `- ${item}`).join('\n')
    : '- Ask for missing business context when the task depends on it.';

  return [
    '# UClaw Agent Profile',
    '',
    'This file is generated by UClaw for this local Agent workspace.',
    '',
    '## Identity',
    '',
    `- Display name: ${profile.personaName}`,
    `- Role: ${profile.roleName}`,
    '',
    '## Primary Responsibility',
    '',
    profile.responsibility,
    '',
    '## Capabilities',
    '',
    capabilities,
    '',
    '## Boundaries',
    '',
    boundaries,
    '',
    '## Workspace Instructions',
    '',
    profile.workspaceInstructions,
    '',
    '## Opening Message',
    '',
    profile.welcomeMessage,
    '',
  ].join('\n');
}

function renderAgentsMarkerBlock(profile: AgentProfile): string {
  return [
    AGENTS_MARKER_START,
    '## UClaw Agent Persona',
    '',
    `This workspace belongs to the UClaw Agent "${profile.personaName}" (${profile.roleName}).`,
    `Read and follow \`${WORKSPACE_PROFILE_FILE}\` before responding in this workspace.`,
    'Keep replies aligned with the Agent responsibility, capabilities, boundaries, and workspace instructions in that profile file.',
    AGENTS_MARKER_END,
  ].join('\n');
}

function upsertMarkedBlock(existing: string, block: string): string {
  const pattern = new RegExp(
    `${AGENTS_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${AGENTS_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }
  const prefix = existing.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${block}\n`;
}

export async function writeAgentProfileWorkspaceFiles(
  agent: { id: string; workspace?: string },
  profile: AgentProfile,
): Promise<void> {
  const workspace = expandPath(agent.workspace || `~/.openclaw/workspace-${agent.id}`);
  await mkdir(workspace, { recursive: true });

  await writeFile(join(workspace, WORKSPACE_PROFILE_FILE), renderProfileMarkdown(profile), 'utf8');

  const agentsPath = join(workspace, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readFile(agentsPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    if (code !== 'ENOENT') throw error;
  }

  await writeFile(agentsPath, upsertMarkedBlock(existing, renderAgentsMarkerBlock(profile)), 'utf8');
}
