/**
 * Bundled OpenClaw skills that UClaw keeps in community/non-managed builds.
 *
 * Keep this list in sync with electron/shared/skills/bundled-allowlist.ts.
 */
export const UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS = [
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
];

export const UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET = new Set(
  UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS,
);
