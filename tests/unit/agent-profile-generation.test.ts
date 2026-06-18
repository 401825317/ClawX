import { describe, expect, it } from 'vitest';
import {
  buildAgentProfilePrompt,
  isAgentProfileGenerationFailureText,
  normalizeAgentProfileGenerationFailureText,
  parseGeneratedAgentProfile,
} from '@electron/utils/agent-profile-generation';

describe('agent profile generation helpers', () => {
  it('parses fenced model JSON into a generated profile', () => {
    const profile = parseGeneratedAgentProfile(
      [
        '```json',
        JSON.stringify({
          personaName: 'Mira · Marketing Expert',
          roleName: 'Marketing Expert',
          responsibility: 'Own marketing content and campaign analysis.',
          capabilities: ['Plan campaigns', 'Write copy', 'Review metrics'],
          boundaries: ['Ask before changing brand voice'],
          workspaceInstructions: 'Focus on business outcomes and concrete next steps.',
          welcomeMessage: 'I am your marketing expert and I just came online.',
        }),
        '```',
      ].join('\n'),
      {
        roleName: '营销专家',
        responsibility: '帮我做营销',
        avatarId: 'strategist',
        locale: 'zh',
      },
    );

    expect(profile.avatarId).toBe('strategist');
    expect(profile.personaName).toBe('Mira · Marketing Expert');
    expect(profile.capabilities).toHaveLength(3);
  });

  it('asks the model for strict JSON in the requested output language', () => {
    const prompt = buildAgentProfilePrompt({
      roleName: '客服',
      responsibility: '处理用户问题',
      avatarId: 'support',
      locale: 'zh-CN',
    });

    expect(prompt).toContain('Output language: Simplified Chinese');
    expect(prompt).toContain('Return strict JSON only');
    expect(prompt).toContain('处理用户问题');
  });

  it('detects gateway model failures before JSON parsing', () => {
    const text = 'Embedded agent failed before reply: 503 No available channel for model qwen-latest under group default';

    expect(isAgentProfileGenerationFailureText(text)).toBe(true);
    expect(normalizeAgentProfileGenerationFailureText(text)).toBe(
      '503 No available channel for model qwen-latest under group default',
    );
  });
});
