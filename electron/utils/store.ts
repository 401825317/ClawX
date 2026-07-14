/**
 * Persistent Storage
 * Electron-store wrapper for application settings
 */

import { randomBytes } from 'crypto';
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSupportedLanguage } from '../../shared/language';
import { withElectronStoreProcessOptions } from './electron-store-options';
import {
  isJunFeiAIManagedDistribution,
  JUNFEIAI_AUTH_ACCOUNT_ID,
  JUNFEIAI_PROVIDER_ID,
} from './junfeiai-distribution';
import { parseJsonWithBom } from './json';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsStoreInstance: any = null;

/**
 * Generate a random token for gateway authentication
 */
function generateToken(): string {
  return `clawx-${randomBytes(16).toString('hex')}`;
}

/**
 * Application settings schema
 */
export interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';
  language: string;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;
  machineId: string;
  hasReportedInstall: boolean;
  setupComplete: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyHttpServer: string;
  proxyHttpsServer: string;
  proxyAllServer: string;
  proxyBypassRules: string;

  // Update
  updateChannel: 'stable' | 'beta' | 'dev';
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
  skippedVersions: string[];

  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;

  // Presets
  selectedBundles: string[];
  enabledSkills: string[];
  disabledSkills: string[];
}

/**
 * Default settings
 */
function getSystemLocale(): string {
  const preferredLanguages = typeof app.getPreferredSystemLanguages === 'function'
    ? app.getPreferredSystemLanguages()
    : [];
  return preferredLanguages[0]
    || (typeof app.getLocale === 'function' ? app.getLocale() : '')
    || Intl.DateTimeFormat().resolvedOptions().locale
    || 'en';
}

function createDefaultSettings(): AppSettings {
  return {
    // General
    theme: 'system',
    language: resolveSupportedLanguage(getSystemLocale()),
    startMinimized: false,
    launchAtStartup: false,
    telemetryEnabled: true,
    machineId: '',
    hasReportedInstall: false,
    setupComplete: false,

    // Gateway
    gatewayAutoStart: true,
    gatewayPort: 18789,
    gatewayToken: generateToken(),
    proxyEnabled: false,
    proxyServer: '',
    proxyHttpServer: '',
    proxyHttpsServer: '',
    proxyAllServer: '',
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1',

    // Update
    updateChannel: 'stable',
    autoCheckUpdate: true,
    autoDownloadUpdate: false,
    skippedVersions: [],

    // UI State
    sidebarCollapsed: false,
    devModeUnlocked: false,

    // Presets
    selectedBundles: ['productivity', 'developer'],
    enabledSkills: [],
    disabledSkills: [],
  };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = parseJsonWithBom<unknown>(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasEntries(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasUsableManagedLegacySecrets(
  providers: Record<string, unknown>,
  activation: Record<string, unknown>,
): boolean {
  const secrets = asRecord(providers.providerSecrets);
  const auth = asRecord(secrets?.[JUNFEIAI_AUTH_ACCOUNT_ID]);
  const relay = asRecord(secrets?.[JUNFEIAI_PROVIDER_ID]);
  const now = Date.now();
  const authExpiresAt = typeof auth?.expiresAt === 'number' ? auth.expiresAt : 0;
  const relayExpiresAt = typeof relay?.expiresAt === 'number' ? relay.expiresAt : 0;
  const hasFreshAccessToken = auth?.type === 'oauth'
    && typeof auth.accessToken === 'string'
    && auth.accessToken.trim().length > 0
    && (authExpiresAt <= 0 || authExpiresAt > now);
  const hasRefreshToken = auth?.type === 'oauth'
    && typeof auth.refreshToken === 'string'
    && auth.refreshToken.trim().length > 0;
  const hasRelayToken = relay?.type === 'api_key'
    && typeof relay.apiKey === 'string'
    && relay.apiKey.trim().length > 0
    && (relayExpiresAt <= 0 || relayExpiresAt > now);
  const authUserId = typeof auth?.subject === 'string' ? auth.subject.trim() : '';
  const authEmail = typeof auth?.email === 'string' ? auth.email.trim().toLowerCase() : '';
  const relayOwnerUserId = typeof relay?.ownerUserId === 'string' ? relay.ownerUserId.trim() : '';
  const relayOwnerEmail = typeof relay?.ownerEmail === 'string' ? relay.ownerEmail.trim().toLowerCase() : '';
  const relayOwnerUsername = typeof relay?.ownerUsername === 'string' ? relay.ownerUsername.trim() : '';
  const activationUserId = typeof activation.userId === 'string' ? activation.userId.trim() : '';
  const relayOwnerMatchesAuth = relayOwnerUserId
    ? Boolean(authUserId && relayOwnerUserId === authUserId)
    : relayOwnerEmail
      ? Boolean(authEmail && relayOwnerEmail === authEmail)
      : relayOwnerUsername
        ? false
        : false;
  const activationMatchesAuth = !activationUserId || Boolean(authUserId && activationUserId === authUserId);

  return (hasFreshAccessToken || hasRefreshToken)
    && hasRelayToken
    && relayOwnerMatchesAuth
    && activationMatchesAuth;
}

function shouldMigrateLegacySetupComplete(storeDir: string): boolean {
  const settings = readJsonObject(join(storeDir, 'settings.json'));
  if (!settings || typeof settings.setupComplete === 'boolean') {
    return false;
  }

  const activation = readJsonObject(join(storeDir, 'clawx-device-activation.json'));
  const providers = readJsonObject(join(storeDir, 'clawx-providers.json'));
  if (isJunFeiAIManagedDistribution()) {
    return Boolean(
      activation?.activated === true
      && activation.onboardingCompleted === true
      && providers
      && hasUsableManagedLegacySecrets(providers, activation),
    );
  }

  if (activation?.activated === true && activation.onboardingCompleted === true) {
    return true;
  }

  return Boolean(
    providers
    && (
      hasEntries(providers.providerSecretsV2)
      || hasEntries(providers.providerSecrets)
      || hasEntries(providers.apiKeys)
    )
  );
}

/**
 * Get the settings store instance (lazy initialization)
 */
async function getSettingsStore() {
  if (!settingsStoreInstance) {
    const Store = (await import('electron-store')).default;
    const options = withElectronStoreProcessOptions({
      name: 'settings',
      deserialize: parseJsonWithBom,
      defaults: createDefaultSettings(),
    });
    const storeDir = options.cwd || app.getPath('userData');
    const migrateLegacySetupComplete = shouldMigrateLegacySetupComplete(storeDir);
    settingsStoreInstance = new Store<AppSettings>(options);
    if (migrateLegacySetupComplete) {
      settingsStoreInstance.set('setupComplete', true);
    }
  }
  return settingsStoreInstance;
}

/**
 * Get a setting value
 */
export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const store = await getSettingsStore();
  return store.get(key);
}

/**
 * Set a setting value
 */
export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): Promise<void> {
  const store = await getSettingsStore();
  store.set(key, value);
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();
  return store.store;
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(): Promise<void> {
  const store = await getSettingsStore();
  store.clear();
}

/**
 * Export settings to JSON
 */
export async function exportSettings(): Promise<string> {
  const store = await getSettingsStore();
  return JSON.stringify(store.store, null, 2);
}

/**
 * Import settings from JSON
 */
export async function importSettings(json: string): Promise<void> {
  try {
    const settings = JSON.parse(json);
    const store = await getSettingsStore();
    store.set(settings);
  } catch {
    throw new Error('Invalid settings JSON');
  }
}
