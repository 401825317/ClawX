import { describe, expect, it } from 'vitest';
import {
  buildAgentProfilePrompt,
  buildFallbackAgentProfile,
  isAgentProfileGenerationFailureText,
  normalizeAgentProfileGenerationFailureText,
  parseGeneratedAgentProfile,
} from '@electron/utils/agent-profile-generation';

const input = {
  roleName: 'Product Manager',
  responsibility: 'Plan and deliver a desktop collaboration product',
  avatarId: 'strategist',
  locale: 'zh-CN',
};

describe('agent profile generation utilities', () => {
  it('builds a strict localized JSON prompt from the user input', () => {
    const prompt = buildAgentProfilePrompt(input);

    expect(prompt).toContain('Output language: Simplified Chinese.');
    expect(prompt).toContain(input.roleName);
    expect(prompt).toContain(input.responsibility);
    expect(prompt).toContain('Return strict JSON only');
  });

  it('parses the first complete JSON object from a fenced model response', () => {
    const profile = parseGeneratedAgentProfile([
      '```json',
      JSON.stringify({
        personaName: 'Lin - Product Lead',
        roleName: 'Product Lead',
        responsibility: 'Own product planning and delivery.',
        capabilities: ['Roadmap planning', 'Requirement analysis', 'Delivery coordination'],
        boundaries: ['Confirm material scope changes'],
        workspaceInstructions: 'Keep decisions concrete and traceable.',
        welcomeMessage: 'I am ready to plan the next product milestone.',
      }),
      '```',
    ].join('\n'), input);

    expect(profile).toEqual({
      personaName: 'Lin - Product Lead',
      roleName: 'Product Lead',
      responsibility: 'Own product planning and delivery.',
      capabilities: ['Roadmap planning', 'Requirement analysis', 'Delivery coordination'],
      boundaries: ['Confirm material scope changes'],
      workspaceInstructions: 'Keep decisions concrete and traceable.',
      welcomeMessage: 'I am ready to plan the next product milestone.',
      avatarId: 'strategist',
    });
  });

  it('rejects malformed or incomplete model profiles', () => {
    expect(() => parseGeneratedAgentProfile('not json', input)).toThrow('valid JSON');
    expect(() => parseGeneratedAgentProfile(JSON.stringify({
      personaName: 'Lin',
      roleName: 'Product Lead',
      responsibility: 'Plan products',
      capabilities: ['Only one'],
      workspaceInstructions: 'Plan carefully',
      welcomeMessage: 'Hello',
    }), input)).toThrow('at least three capabilities');
  });

  it('builds a deterministic local fallback when history repeatedly times out', () => {
    expect(buildFallbackAgentProfile(input)).toEqual({
      roleName: input.roleName,
      personaName: input.roleName,
      responsibility: input.responsibility,
      capabilities: [
        `Plan and execute work related to ${input.roleName}`,
        'Break down requests into clear next steps',
        'Review outputs for quality and follow-up actions',
      ],
      boundaries: [
        'Ask for clarification when requirements are ambiguous',
        'Confirm before taking high-impact actions',
      ],
      workspaceInstructions: `Focus on ${input.responsibility}. Keep responses concrete, actionable, and aligned with the user-provided role.`,
      welcomeMessage: `I am your ${input.roleName} Agent. I can help with ${input.responsibility}. What should we work on first?`,
      avatarId: input.avatarId,
    });
  });

  it('recognizes and normalizes provider failures', () => {
    expect(isAgentProfileGenerationFailureText('All models failed before reply')).toBe(true);
    expect(normalizeAgentProfileGenerationFailureText('Agent failed before reply: model unavailable'))
      .toBe('model unavailable');
  });
});
