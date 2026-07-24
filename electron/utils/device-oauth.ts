/**
 * Device OAuth Manager
 *
 * Manages Device Code OAuth flows for MiniMax providers.
 *
 * The OAuth protocol implementations are fully self-contained in:
 *   - ./minimax-oauth.ts  (MiniMax Device Code + PKCE)
 *
 * This approach:
 * - Hardcodes client_id and endpoints (same as openai-codex-oauth.ts)
 * - Implements OAuth flows locally with zero openclaw dependency
 * - Survives openclaw package upgrades without breakage
 * - Works identically on macOS, Windows, and Linux
 *
 * We provide our own callbacks (openUrl/note/progress) that hook into
 * the Electron IPC system to display UI in the ClawX frontend.
 */
import { EventEmitter } from 'events';
import { BrowserWindow, shell } from 'electron';
import { logger } from './logger';
import { saveProvider, getProvider, ProviderConfig } from './secure-storage';
import { getProviderDefaultModel } from './provider-registry';
import { proxyAwareFetch } from './proxy-fetch';
import { saveOAuthTokenToOpenClaw, setOpenClawDefaultModelWithOverride } from './openclaw-auth';
import { loginMiniMaxPortalOAuth, type MiniMaxOAuthToken, type MiniMaxRegion } from './minimax-oauth';
import {
    assertProviderMutationAllowed,
    withProviderMutationLock,
} from '../services/providers/provider-mutation-lock';
import { getProviderService } from '../services/providers/provider-service';

export type OAuthProviderType = 'minimax-portal' | 'minimax-portal-cn';

// Re-export types for consumers
export type { MiniMaxRegion, MiniMaxOAuthToken };

// ─────────────────────────────────────────────────────────────
// DeviceOAuthManager
// ─────────────────────────────────────────────────────────────

class DeviceOAuthManager extends EventEmitter {
    private activeProvider: OAuthProviderType | null = null;
    private activeAccountId: string | null = null;
    private activeLabel: string | null = null;
    private active: boolean = false;
    private activeGeneration = 0;
    private mainWindow: BrowserWindow | null = null;

    private async runWithProxyAwareFetch<T>(task: () => Promise<T>): Promise<T> {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
            proxyAwareFetch(input, init)) as typeof fetch;
        try {
            return await task();
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    setWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    async startFlow(
        provider: OAuthProviderType,
        region: MiniMaxRegion = 'global',
        options?: { accountId?: string; label?: string },
    ): Promise<boolean> {
        if (this.active) {
            await this.stopFlow();
        }

        this.active = true;
        const generation = ++this.activeGeneration;
        this.emit('oauth:start', { provider, accountId: options?.accountId || provider });
        this.activeProvider = provider;
        this.activeAccountId = options?.accountId || provider;
        this.activeLabel = options?.label || null;

        try {
            if (provider === 'minimax-portal' || provider === 'minimax-portal-cn') {
                const actualRegion = provider === 'minimax-portal-cn' ? 'cn' : (region || 'global');
                await this.runMiniMaxFlow(actualRegion, provider, generation);
            } else {
                throw new Error(`Unsupported OAuth provider type: ${provider}`);
            }
            return true;
        } catch (error) {
            if (!this.active || this.activeGeneration !== generation) {
                // Flow was cancelled — not an error
                return false;
            }
            logger.error(`[DeviceOAuth] Flow error for ${provider}:`, error);
            this.emitError(error instanceof Error ? error.message : String(error));
            this.active = false;
            this.activeProvider = null;
            this.activeAccountId = null;
            this.activeLabel = null;
            return false;
        }
    }

    async stopFlow(): Promise<void> {
        this.activeGeneration += 1;
        this.active = false;
        this.activeProvider = null;
        this.activeAccountId = null;
        this.activeLabel = null;
        logger.info('[DeviceOAuth] Flow explicitly stopped');
    }

    // ─────────────────────────────────────────────────────────
    // MiniMax flow
    // ─────────────────────────────────────────────────────────

    private async runMiniMaxFlow(
        region: MiniMaxRegion | undefined,
        providerType: OAuthProviderType,
        generation: number,
    ): Promise<void> {
        const provider = this.activeProvider!;

        const token: MiniMaxOAuthToken = await this.runWithProxyAwareFetch(() => loginMiniMaxPortalOAuth({
            region,
            openUrl: async (url: string) => {
                logger.info(`[DeviceOAuth] MiniMax opening browser: ${url}`);
                // Open the authorization URL in the system browser
                shell.openExternal(url).catch((err: unknown) =>
                    logger.warn(`[DeviceOAuth] Failed to open browser:`, err)
                );
            },
            note: async (message: string, _title?: string) => {
                if (!this.active || this.activeGeneration !== generation) return;
                // The extension calls note() with a message containing
                // the user_code and verification_uri — parse them for the UI
                const { verificationUri, userCode } = this.parseNote(message);
                if (verificationUri && userCode) {
                    this.emitCode({ provider, verificationUri, userCode, expiresIn: 300 });
                } else {
                    logger.info(`[DeviceOAuth] MiniMax note: ${message}`);
                }
            },
            progress: {
                update: (msg: string) => logger.info(`[DeviceOAuth] MiniMax progress: ${msg}`),
                stop: (msg?: string) => logger.info(`[DeviceOAuth] MiniMax progress done: ${msg ?? ''}`),
            },
        }));

        if (!this.active || this.activeGeneration !== generation) return;

        await this.onSuccess(providerType, {
            access: token.access,
            refresh: token.refresh,
            expires: token.expires,
            // MiniMax returns a per-account resourceUrl as the API base URL
            resourceUrl: token.resourceUrl,
            // Revert back to anthropic-messages
            api: 'anthropic-messages',
            region,
        }, generation);
    }



    // ─────────────────────────────────────────────────────────
    // Success handler
    // ─────────────────────────────────────────────────────────

    private async onSuccess(providerType: OAuthProviderType, token: {
        access: string;
        refresh: string;
        expires: number;
        resourceUrl?: string;
        api: 'anthropic-messages' | 'openai-completions';
        region?: MiniMaxRegion;
    }, generation: number) {
        const accountId = this.activeAccountId || providerType;
        const accountLabel = this.activeLabel;
        const completed = await withProviderMutationLock(async () => {
            if (!this.active || this.activeGeneration !== generation) return false;
            const providerService = getProviderService();
            const existingAccount = await providerService.getAccount(accountId);
            assertProviderMutationAllowed(
                await providerService.getAccount('openai'),
                accountId,
                existingAccount,
                { id: accountId, vendorId: providerType },
            );

            // Persist OAuth token, runtime config, and Provider record as one local generation.
            try {
                const tokenProviderId = providerType.startsWith('minimax-portal') ? 'minimax-portal' : providerType;
                await saveOAuthTokenToOpenClaw(tokenProviderId, {
                    access: token.access,
                    refresh: token.refresh,
                    expires: token.expires,
                });
            } catch (err) {
                logger.warn(`[DeviceOAuth] Failed to save OAuth token to OpenClaw:`, err);
            }

            const defaultBaseUrl = providerType === 'minimax-portal'
                ? 'https://api.minimax.io/anthropic'
                : 'https://api.minimaxi.com/anthropic';
            let baseUrl = token.resourceUrl || defaultBaseUrl;
            if (baseUrl && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
                baseUrl = 'https://' + baseUrl;
            }
            if (providerType.startsWith('minimax-portal') && baseUrl) {
                baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
            }

            try {
                const tokenProviderId = providerType.startsWith('minimax-portal') ? 'minimax-portal' : providerType;
                await setOpenClawDefaultModelWithOverride(tokenProviderId, undefined, {
                    baseUrl,
                    api: token.api,
                    authHeader: providerType.startsWith('minimax-portal') ? true : undefined,
                    apiKeyEnv: 'minimax-oauth',
                });
            } catch (err) {
                logger.warn(`[DeviceOAuth] Failed to configure openclaw models:`, err);
            }

            const existing = await getProvider(accountId);
            const nameMap: Record<OAuthProviderType, string> = {
                'minimax-portal': 'MiniMax (Global)',
                'minimax-portal-cn': 'MiniMax (CN)',
            };
            const providerConfig: ProviderConfig = {
                id: accountId,
                name: accountLabel || nameMap[providerType as OAuthProviderType] || providerType,
                type: providerType,
                enabled: existing?.enabled ?? true,
                baseUrl,
                model: getProviderDefaultModel(providerType) || existing?.model,
                createdAt: existing?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            await saveProvider(providerConfig);

            this.active = false;
            this.activeProvider = null;
            this.activeAccountId = null;
            this.activeLabel = null;
            return true;
        });

        if (!completed) return;
        logger.info(`[DeviceOAuth] Successfully completed OAuth for ${providerType}`);

        // 4. Emit success internally so the main process can restart the Gateway
        this.emit('oauth:success', { provider: providerType, accountId });

        // 5. Emit success to frontend
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:success', { provider: providerType, accountId, success: true });
        }
    }


    // ─────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────

    /**
     * Parse user_code and verification_uri from the note message sent by
     * the OpenClaw extension's loginXxxPortalOAuth function.
     *
     * Note format (minimax-portal-auth/oauth.ts):
     *   "Open https://platform.minimax.io/oauth-authorize?user_code=dyMj_wOhpK&client=... to approve access.\n"
     *   "If prompted, enter the code dyMj_wOhpK.\n"
     *   ...
     *
     * user_code format: mixed-case alphanumeric with underscore, e.g. "dyMj_wOhpK"
     */
    private parseNote(message: string): { verificationUri?: string; userCode?: string } {
        // Primary: extract URL (everything between "Open " and " to")
        const urlMatch = message.match(/Open\s+(https?:\/\/\S+?)\s+to/i);
        const verificationUri = urlMatch?.[1];

        let userCode: string | undefined;

        // Method 1: extract user_code from URL query param (most reliable)
        if (verificationUri) {
            try {
                const parsed = new URL(verificationUri);
                const qp = parsed.searchParams.get('user_code');
                if (qp) userCode = qp;
            } catch {
                // fall through to text-based extraction
            }
        }

        // Method 2: text-based extraction — matches mixed-case alnum + underscore/hyphen codes
        if (!userCode) {
            const codeMatch = message.match(/enter.*?code\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})/i);
            if (codeMatch?.[1]) userCode = codeMatch[1].replace(/\.$/, ''); // strip trailing period
        }

        return { verificationUri, userCode };
    }

    private emitCode(data: {
        provider: string;
        verificationUri: string;
        userCode: string;
        expiresIn: number;
    }) {
        this.emit('oauth:code', data);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:code', data);
        }
    }

    private emitError(message: string) {
        this.emit('oauth:error', { message });
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('oauth:error', { message });
        }
    }
}

export const deviceOAuthManager = new DeviceOAuthManager();
