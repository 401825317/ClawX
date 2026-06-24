export interface AgentProfileGenerationInput {
  roleName: string;
  responsibility: string;
  avatarId: string;
  locale?: string;
}

export interface GeneratedAgentProfile {
  roleName: string;
  personaName: string;
  responsibility: string;
  capabilities: string[];
  boundaries: string[];
  workspaceInstructions: string;
  welcomeMessage: string;
  avatarId: string;
}

export function isAgentProfileGenerationFailureText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('no available channel for model')
    || normalized.includes('all models failed')
    || normalized.includes('failed before reply')
    || normalized.includes('live session model switch requested')
    || normalized.includes('llm request failed')
    || normalized.includes('model_not_found')
    || normalized.includes('new_api_error')
    || (normalized.includes('provider') && normalized.includes('cooldown'))
    || (normalized.includes('model') && normalized.includes('503'));
}

export function normalizeAgentProfileGenerationFailureText(text: string): string {
  return text
    .replace(/^error:\s*/i, '')
    .replace(/^agent failed before reply:\s*/i, '')
    .replace(/^embedded agent failed before reply:\s*/i, '')
    .trim();
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTextArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function resolveLanguage(locale: string | undefined): string {
  const normalized = locale?.trim().toLowerCase() || '';
  if (normalized.startsWith('zh')) return 'Simplified Chinese';
  if (normalized.startsWith('ja')) return 'Japanese';
  if (normalized.startsWith('ru')) return 'Russian';
  return 'English';
}

export function buildAgentProfilePrompt(input: AgentProfileGenerationInput): string {
  const roleName = normalizeText(input.roleName);
  const responsibility = normalizeText(input.responsibility);
  const language = resolveLanguage(input.locale);

  return [
    'You are designing a product-ready persona for a UClaw desktop Agent.',
    `Output language: ${language}.`,
    '',
    'User-provided role name:',
    roleName,
    '',
    'User-provided rough responsibility:',
    responsibility,
    '',
    'Create a polished, practical Agent profile. The user may be non-professional, so expand the responsibility into concrete work areas, but do not invent unrelated domains.',
    'The welcomeMessage must be a natural first message from the Agent after it comes online. It should invite the user to rename or refine the Agent, describe what it can help with, and ask what work to start with.',
    '',
    'Return strict JSON only. Do not include Markdown fences or commentary.',
    'Schema:',
    JSON.stringify({
      personaName: 'humanlike display name plus role, concise',
      roleName: 'professional role title',
      responsibility: 'one concise paragraph',
      capabilities: ['4-6 concrete capabilities'],
      boundaries: ['2-4 boundaries or clarification rules'],
      workspaceInstructions: 'instructions this Agent should follow in its workspace',
      welcomeMessage: 'first-person opening message',
    }, null, 2),
  ].join('\n');
}

export function buildFallbackAgentProfile(input: AgentProfileGenerationInput): GeneratedAgentProfile {
  const roleName = normalizeText(input.roleName) || 'Agent';
  const responsibility = normalizeText(input.responsibility) || roleName;
  const avatarId = normalizeText(input.avatarId) || 'strategist';

  return {
    roleName,
    personaName: roleName,
    responsibility,
    capabilities: [
      `Plan and execute work related to ${roleName}`,
      'Break down requests into clear next steps',
      'Review outputs for quality and follow-up actions',
    ],
    boundaries: [
      'Ask for clarification when requirements are ambiguous',
      'Confirm before taking high-impact actions',
    ],
    workspaceInstructions: `Focus on ${responsibility}. Keep responses concrete, actionable, and aligned with the user-provided role.`,
    welcomeMessage: `I am your ${roleName} Agent. I can help with ${responsibility}. What should we work on first?`,
    avatarId,
  };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function extractFirstJsonObject(text: string): string {
  const source = stripJsonFence(text);
  const firstBrace = source.indexOf('{');
  if (firstBrace === -1) return source;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(firstBrace, index + 1);
    }
  }

  return source;
}

export function parseGeneratedAgentProfile(
  rawText: string,
  input: AgentProfileGenerationInput,
): GeneratedAgentProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractFirstJsonObject(rawText));
  } catch {
    throw new Error('The model did not return valid JSON. Please retry profile generation.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned an invalid profile shape. Please retry profile generation.');
  }

  const record = parsed as Record<string, unknown>;
  const roleName = normalizeText(record.roleName) || normalizeText(input.roleName);
  const personaName = normalizeText(record.personaName);
  const responsibility = normalizeText(record.responsibility);
  const workspaceInstructions = normalizeText(record.workspaceInstructions);
  const welcomeMessage = normalizeText(record.welcomeMessage);
  const capabilities = normalizeTextArray(record.capabilities, 6);
  const boundaries = normalizeTextArray(record.boundaries, 4);

  if (!roleName || !personaName || !responsibility || !workspaceInstructions || !welcomeMessage) {
    throw new Error('The model profile is missing required fields. Please retry profile generation.');
  }
  if (capabilities.length < 3) {
    throw new Error('The model profile needs at least three capabilities. Please retry profile generation.');
  }

  return {
    roleName,
    personaName,
    responsibility,
    capabilities,
    boundaries,
    workspaceInstructions,
    welcomeMessage,
    avatarId: normalizeText(input.avatarId) || 'strategist',
  };
}
