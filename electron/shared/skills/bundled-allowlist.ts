/**
 * Bundled OpenClaw skills that UClaw keeps enabled in community builds.
 *
 * Keep this list limited to broadly useful, low-configuration skills. Account,
 * device, OS-specific, or destructive integrations should remain opt-in from
 * the Skills page.
 */
export const UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS = [
  'browser-automation',
  'diagram-maker',
  'healthcheck',
  'meme-maker',
  'session-logs',
  'skill-creator',
  'spike',
  'summarize',
  'taskflow',
  'taskflow-inbox-triage',
  'video-frames',
  'weather',
] as const;

export const UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET = new Set<string>(
  UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS,
);
