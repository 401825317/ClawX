/**
 * Dynamic imports for openclaw plugin-sdk subpath exports.
 *
 * openclaw is NOT in the asar's node_modules — it lives at resources/openclaw/
 * (extraResources).  Static `import ... from 'openclaw/plugin-sdk/...'` would
 * produce a runtime require() that fails inside the asar.
 *
 * Instead, we create a require context from the openclaw directory itself.
 * Node.js package self-referencing allows a package to require its own exports
 * by name, so `openclawRequire('openclaw/plugin-sdk/discord')` resolves via the
 * exports map in openclaw's package.json.
 *
 * In dev mode (pnpm), the resolved path is in the pnpm virtual store where
 * self-referencing also works.  The projectRequire fallback covers edge cases.
 *
 * openclaw 2026.4.5 removed the per-channel plugin-sdk subpath exports
 * (discord, telegram-surface, slack, whatsapp-shared).  The functions now live
 * in the extension bundles (dist/extensions/<channel>/api.js) which pull in
 * heavy optional dependencies (grammy, @buape/carbon, @slack/web-api …).
 *
 * Since ClawX only uses the lightweight normalize / directory helpers, we load
 * these from the extension API files directly.  If the optional dependency is
 * missing (common in dev without full install), we fall back to no-op stubs so
 * the app can still start — the target picker will simply be empty for that
 * channel.
 */
import { createRequire } from 'module';
import { join } from 'node:path';
import { getOpenClawDir, getOpenClawResolvedDir } from './paths';

function createOpenClawRequires() {
  const openClawResolvedPath = getOpenClawResolvedDir();
  const openClawPath = getOpenClawDir();
  return {
    openClawSdkRequire: createRequire(join(openClawResolvedPath, 'package.json')),
    projectSdkRequire: createRequire(join(openClawPath, 'package.json')),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireOpenClawSdk(subpath: string): Record<string, unknown> {
  const { openClawSdkRequire, projectSdkRequire } = createOpenClawRequires();
  try {
    return openClawSdkRequire(subpath);
  } catch {
    return projectSdkRequire(subpath);
  }
}

/**
 * Load an openclaw extension API module by relative path under the openclaw
 * dist directory.  Falls back to no-op stubs when the optional dependency
 * tree is incomplete.
 */
function requireExtensionApi(relativePath: string): Record<string, unknown> | null {
  const { openClawSdkRequire, projectSdkRequire } = createOpenClawRequires();
  try {
    // Require relative to the openclaw dist directory.
    return openClawSdkRequire(relativePath);
  } catch {
    try {
      return projectSdkRequire(relativePath);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Generic no-op stubs used when channel SDK is unavailable.
// ---------------------------------------------------------------------------

const noopAsyncList = async (..._args: unknown[]): Promise<unknown[]> => [];
const noopNormalize = (_target: string): string | undefined => undefined;

// ---------------------------------------------------------------------------
// Legacy plugin-sdk subpath imports (openclaw <2026.4.5)
// ---------------------------------------------------------------------------

function tryLegacySdkImport(subpath: string): Record<string, unknown> | null {
  try {
    return requireOpenClawSdk(subpath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel SDK loaders — try legacy plugin-sdk first, then extension api, then stubs
// ---------------------------------------------------------------------------

type ChannelSdk<T> = T;

interface DiscordSdk {
  listDiscordDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listDiscordDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeDiscordMessagingTarget: (target: string) => string | undefined;
}

interface TelegramSdk {
  listTelegramDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listTelegramDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeTelegramMessagingTarget: (target: string) => string | undefined;
}

interface SlackSdk {
  listSlackDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listSlackDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeSlackMessagingTarget: (target: string) => string | undefined;
}

interface WhatsappSdk {
  normalizeWhatsAppMessagingTarget: (target: string) => string | undefined;
}

function loadChannelSdk<T>(
  legacySubpath: string,
  extensionRelPath: string,
  fallback: T,
  keys: (keyof T)[],
): ChannelSdk<T> {
  // 1. Try legacy plugin-sdk subpath (openclaw <4.5)
  const legacy = tryLegacySdkImport(legacySubpath);
  if (legacy && keys.every((k) => typeof legacy[k as string] === 'function')) {
    return legacy as unknown as T;
  }

  // 2. Try extension API file (openclaw >=4.5)
  const ext = requireExtensionApi(extensionRelPath);
  if (ext && keys.every((k) => typeof ext[k as string] === 'function')) {
    return ext as unknown as T;
  }

  // 3. Fallback to no-op stubs
  return fallback;
}

let discordSdk: DiscordSdk | null = null;
let telegramSdk: TelegramSdk | null = null;
let slackSdk: SlackSdk | null = null;
let whatsappSdk: WhatsappSdk | null = null;

function getDiscordSdk(): DiscordSdk {
  return discordSdk ??= loadChannelSdk<DiscordSdk>(
    'openclaw/plugin-sdk/discord', './dist/extensions/discord/api.js',
    { listDiscordDirectoryGroupsFromConfig: noopAsyncList, listDiscordDirectoryPeersFromConfig: noopAsyncList, normalizeDiscordMessagingTarget: noopNormalize },
    ['listDiscordDirectoryGroupsFromConfig', 'listDiscordDirectoryPeersFromConfig', 'normalizeDiscordMessagingTarget'],
  );
}

function getTelegramSdk(): TelegramSdk {
  return telegramSdk ??= loadChannelSdk<TelegramSdk>(
    'openclaw/plugin-sdk/telegram-surface', './dist/extensions/telegram/api.js',
    { listTelegramDirectoryGroupsFromConfig: noopAsyncList, listTelegramDirectoryPeersFromConfig: noopAsyncList, normalizeTelegramMessagingTarget: noopNormalize },
    ['listTelegramDirectoryGroupsFromConfig', 'listTelegramDirectoryPeersFromConfig', 'normalizeTelegramMessagingTarget'],
  );
}

function getSlackSdk(): SlackSdk {
  return slackSdk ??= loadChannelSdk<SlackSdk>(
    'openclaw/plugin-sdk/slack', './dist/extensions/slack/api.js',
    { listSlackDirectoryGroupsFromConfig: noopAsyncList, listSlackDirectoryPeersFromConfig: noopAsyncList, normalizeSlackMessagingTarget: noopNormalize },
    ['listSlackDirectoryGroupsFromConfig', 'listSlackDirectoryPeersFromConfig', 'normalizeSlackMessagingTarget'],
  );
}

function getWhatsappSdk(): WhatsappSdk {
  return whatsappSdk ??= loadChannelSdk<WhatsappSdk>(
    'openclaw/plugin-sdk/whatsapp-shared', './dist/extensions/whatsapp/api.js',
    { normalizeWhatsAppMessagingTarget: noopNormalize }, ['normalizeWhatsAppMessagingTarget'],
  );
}

// ---------------------------------------------------------------------------
// Public re-exports — identical API surface as before.
// ---------------------------------------------------------------------------

export const listDiscordDirectoryGroupsFromConfig: DiscordSdk['listDiscordDirectoryGroupsFromConfig'] = (...args) => getDiscordSdk().listDiscordDirectoryGroupsFromConfig(...args);
export const listDiscordDirectoryPeersFromConfig: DiscordSdk['listDiscordDirectoryPeersFromConfig'] = (...args) => getDiscordSdk().listDiscordDirectoryPeersFromConfig(...args);
export const normalizeDiscordMessagingTarget: DiscordSdk['normalizeDiscordMessagingTarget'] = (target) => getDiscordSdk().normalizeDiscordMessagingTarget(target);
export const listTelegramDirectoryGroupsFromConfig: TelegramSdk['listTelegramDirectoryGroupsFromConfig'] = (...args) => getTelegramSdk().listTelegramDirectoryGroupsFromConfig(...args);
export const listTelegramDirectoryPeersFromConfig: TelegramSdk['listTelegramDirectoryPeersFromConfig'] = (...args) => getTelegramSdk().listTelegramDirectoryPeersFromConfig(...args);
export const normalizeTelegramMessagingTarget: TelegramSdk['normalizeTelegramMessagingTarget'] = (target) => getTelegramSdk().normalizeTelegramMessagingTarget(target);
export const listSlackDirectoryGroupsFromConfig: SlackSdk['listSlackDirectoryGroupsFromConfig'] = (...args) => getSlackSdk().listSlackDirectoryGroupsFromConfig(...args);
export const listSlackDirectoryPeersFromConfig: SlackSdk['listSlackDirectoryPeersFromConfig'] = (...args) => getSlackSdk().listSlackDirectoryPeersFromConfig(...args);
export const normalizeSlackMessagingTarget: SlackSdk['normalizeSlackMessagingTarget'] = (target) => getSlackSdk().normalizeSlackMessagingTarget(target);
export const normalizeWhatsAppMessagingTarget: WhatsappSdk['normalizeWhatsAppMessagingTarget'] = (target) => getWhatsappSdk().normalizeWhatsAppMessagingTarget(target);
