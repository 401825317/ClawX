/**
 * ClawHub Service
 * Maintains marketplace-provider compatibility and managed skill uninstall/open helpers.
 */
import fs from 'fs';
import path from 'path';
import { shell } from 'electron';
import { getOpenClawConfigDir, ensureDir } from '../utils/paths';
import { removeSkillConfig } from '../utils/skill-config';
import { UCLAW_MARKETPLACE_DEFAULT_PROVIDER } from '../../shared/junfeiai-endpoints';

export interface MarketplaceSearchParams {
    query?: string;
    limit?: number;
    locale?: string;
    cursor?: string;
    sort?: string;
    dir?: string;
    force?: boolean;
    provider?: string;
}

export interface MarketplaceInstallParams {
    slug: string;
    version?: string;
    force?: boolean;
    provider?: string;
}

export interface MarketplaceUninstallParams {
    slug: string;
}

export interface MarketplaceSkillResult {
    slug: string;
    name: string;
    description: string;
    version: string;
    provider?: string;
    source?: string;
    sourceUrl?: string;
    iconUrl?: string;
    category?: string;
    author?: string;
    downloads?: number;
    stars?: number;
    keywords?: string[];
}

export interface MarketplaceSearchResult {
    results: MarketplaceSkillResult[];
    total?: number;
    loaded?: number;
    totalKnown?: boolean;
    catalogTotal?: number;
    catalogTotalKnown?: boolean;
    source?: string;
    query?: string;
    sort?: string;
    dir?: string;
    hasMore?: boolean;
    nextCursor?: string;
}

export type MarketplaceSearchProviderResult = MarketplaceSkillResult[] | MarketplaceSearchResult;

export type ClawHubSearchParams = MarketplaceSearchParams;
export type ClawHubInstallParams = MarketplaceInstallParams;
export type ClawHubUninstallParams = MarketplaceUninstallParams;
export type ClawHubSkillResult = MarketplaceSkillResult;

export interface ClawHubInstalledSkillResult {
    slug: string;
    version: string;
    source?: string;
    baseDir?: string;
}

export interface MarketplaceProvider {
    id?: string;
    getCapability(): Promise<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }>;
    search(params: MarketplaceSearchParams): Promise<MarketplaceSearchProviderResult>;
    install(params: MarketplaceInstallParams): Promise<void>;
}

const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function normalizeMarketplaceSlug(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Marketplace install requires a skill slug');
    }
    const slug = value.trim();
    if (!slug || slug === 'undefined' || slug === 'null' || !VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug)) {
        throw new Error('Marketplace install requires a valid skill slug');
    }
    return slug;
}

function normalizeMarketplaceProvider(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const provider = value.trim().toLowerCase();
    return provider || undefined;
}

function normalizeMarketplaceSearchResult(
    value: MarketplaceSearchProviderResult,
    params: MarketplaceSearchParams,
): MarketplaceSearchResult {
    if (Array.isArray(value)) {
        return {
            results: value,
            loaded: value.length,
            total: value.length,
            totalKnown: true,
            query: params.query || '',
            hasMore: false,
        };
    }

    const results = Array.isArray(value.results) ? value.results : [];
    return {
        ...value,
        results,
        loaded: typeof value.loaded === 'number' ? value.loaded : results.length,
    };
}

export class ClawHubService {
    private workDir: string;
    private marketplaceProviders: MarketplaceProvider[] = [];

    constructor() {
        this.workDir = getOpenClawConfigDir();
        ensureDir(this.workDir);
    }

    setMarketplaceProvider(provider: MarketplaceProvider): void {
        this.marketplaceProviders = [provider];
    }

    setMarketplaceProviders(providers: MarketplaceProvider[]): void {
        this.marketplaceProviders = [...providers];
    }

    async getMarketplaceCapability(): Promise<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }> {
        if (this.marketplaceProviders.length > 0) {
            const capabilities = await Promise.allSettled(this.marketplaceProviders.map((provider) => provider.getCapability()));
            const available = capabilities
                .filter((result): result is PromiseFulfilledResult<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }> => result.status === 'fulfilled')
                .map((result) => result.value);
            const searchable = available.filter((capability) => capability.canSearch);
            const installable = available.filter((capability) => capability.canInstall);
            if (available.length > 1) {
                return {
                    mode: 'multi-marketplace',
                    canSearch: searchable.length > 0,
                    canInstall: installable.length > 0,
                    reason: searchable.length > 0 ? undefined : 'marketplace-disabled',
                };
            }
            if (available.length === 1) {
                return available[0];
            }
        }
        return {
            mode: 'local-only',
            canSearch: false,
            canInstall: false,
            reason: 'marketplace-disabled',
        };
    }

    /**
     * Search for skills via an extension-provided marketplace.
     */
    async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
        const provider = this.resolveMarketplaceProvider(params.provider);
        if (provider) {
            const result = await provider.search(params);
            return normalizeMarketplaceSearchResult(result, params);
        }
        throw new Error('Marketplace search is disabled');
    }

    /**
     * Explore marketplace skills via the registered marketplace provider.
     */
    async explore(params: { limit?: number } = {}): Promise<MarketplaceSkillResult[]> {
        const provider = this.resolveMarketplaceProvider();
        if (provider) {
            const result = await provider.search({ query: '', limit: params.limit });
            return normalizeMarketplaceSearchResult(result, { query: '', limit: params.limit }).results;
        }
        throw new Error('Marketplace search is disabled');
    }

    /**
     * Install a skill through an extension-provided marketplace.
     */
    async install(params: MarketplaceInstallParams): Promise<void> {
        const slug = normalizeMarketplaceSlug(params.slug);
        const provider = this.resolveMarketplaceProvider(params.provider);
        if (provider) {
            return provider.install({ ...params, slug });
        }
        throw new Error('Marketplace install is disabled');
    }

    private resolveMarketplaceProvider(providerId?: string): MarketplaceProvider | null {
        if (this.marketplaceProviders.length === 0) return null;
        if (providerId) {
            const normalizedProviderId = providerId.trim().toLowerCase();
            const provider = this.marketplaceProviders.find((candidate) => candidate.id?.trim().toLowerCase() === normalizedProviderId);
            if (!provider) {
                throw new Error(`Marketplace provider "${providerId}" is not available`);
            }
            return provider;
        }
        return this.marketplaceProviders.find((candidate) => candidate.id === UCLAW_MARKETPLACE_DEFAULT_PROVIDER)
            ?? this.marketplaceProviders[0];
    }

    /**
     * Uninstall a managed skill and remove its stored config.
     */
    async uninstall(params: ClawHubUninstallParams): Promise<void> {
        const fsPromises = fs.promises;
        const slug = normalizeMarketplaceSlug(params.slug);
        const skillsRoot = path.resolve(this.workDir, 'skills');
        const skillDir = path.resolve(skillsRoot, slug);
        if (path.dirname(skillDir) !== skillsRoot) {
            throw new Error('Invalid marketplace skill path');
        }
        const preinstalledMarker = path.join(skillDir, '.clawx-preinstalled.json');
        const originPath = path.join(skillDir, '.clawhub', 'origin.json');

        if (fs.existsSync(preinstalledMarker)) {
            throw new Error('Preinstalled skills cannot be uninstalled');
        }

        if (!fs.existsSync(originPath)) {
            throw new Error('Only user-installed marketplace skills can be uninstalled');
        }

        try {
            const origin = JSON.parse(await fsPromises.readFile(originPath, 'utf8')) as { provider?: unknown };
            const provider = normalizeMarketplaceProvider(origin.provider) || 'clawhub';
            if (provider !== 'clawhub' && provider !== 'skillhub') {
                throw new Error('Only user-installed marketplace skills can be uninstalled');
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'Only user-installed marketplace skills can be uninstalled') {
                throw error;
            }
            throw new Error('Marketplace skill origin metadata is invalid', { cause: error });
        }

        if (fs.existsSync(skillDir)) {
            console.log(`Deleting skill directory: ${skillDir}`);
            await fsPromises.rm(skillDir, { recursive: true, force: true });
        }

        const lockFile = path.join(this.workDir, '.clawhub', 'lock.json');
        if (fs.existsSync(lockFile)) {
            try {
                const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as {
                    skills?: Record<string, unknown>;
                };
                if (lockData.skills && lockData.skills[slug]) {
                    console.log(`Removing ${slug} from lock.json`);
                    delete lockData.skills[slug];
                    await fsPromises.writeFile(lockFile, JSON.stringify(lockData, null, 2));
                }
            } catch (err) {
                console.error('Failed to update ClawHub lock file:', err);
            }
        }

        await removeSkillConfig(slug);
    }

    /**
     * List installed managed skills from the filesystem.
     */
    async listInstalled(): Promise<ClawHubInstalledSkillResult[]> {
        const skillsRoot = path.join(this.workDir, 'skills');
        if (!fs.existsSync(skillsRoot)) {
            return [];
        }

        try {
            const entries = await fs.promises.readdir(skillsRoot, { withFileTypes: true });
            const items = await Promise.all(entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry): Promise<ClawHubInstalledSkillResult | null> => {
                    const skillDir = path.join(skillsRoot, entry.name);
                    const manifestPath = path.join(skillDir, 'SKILL.md');
                    if (!fs.existsSync(manifestPath)) return null;

                    let version = 'unknown';
                    const manifestJsonPath = path.join(skillDir, 'manifest.json');
                    if (fs.existsSync(manifestJsonPath)) {
                        try {
                            const manifestJson = JSON.parse(await fs.promises.readFile(manifestJsonPath, 'utf8')) as { version?: string };
                            version = manifestJson.version?.trim() || version;
                        } catch {
                            // Ignore malformed manifest.json
                        }
                    }

                    const originJsonPath = path.join(skillDir, '.clawhub', 'origin.json');
                    if (fs.existsSync(originJsonPath)) {
                        try {
                            const originJson = JSON.parse(await fs.promises.readFile(originJsonPath, 'utf8')) as { installedVersion?: string };
                            version = originJson.installedVersion?.trim() || version;
                        } catch {
                            // Ignore malformed origin.json
                        }
                    }

                    return {
                        slug: entry.name,
                        version,
                        source: 'openclaw-managed',
                        baseDir: skillDir,
                    };
                }));
            return items.filter((item): item is ClawHubInstalledSkillResult => item !== null);
        } catch (error) {
            console.error('ClawHub list error:', error);
            return [];
        }
    }

    private extractFrontmatterName(skillManifestPath: string): string | null {
        try {
            const raw = fs.readFileSync(skillManifestPath, 'utf8');
            const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) return null;
            const body = frontmatterMatch[1];
            const nameMatch = body.match(/^\s*name\s*:\s*["']?([^"'\n]+)["']?\s*$/m);
            if (!nameMatch) return null;
            const name = nameMatch[1].trim();
            return name || null;
        } catch {
            return null;
        }
    }

    private resolveSkillDirByManifestName(candidates: string[]): string | null {
        const skillsRoot = path.join(this.workDir, 'skills');
        if (!fs.existsSync(skillsRoot)) return null;

        const wanted = new Set(
            candidates
                .map((v) => v.trim().toLowerCase())
                .filter((v) => v.length > 0),
        );
        if (wanted.size === 0) return null;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(skillsRoot, entry.name);
            const skillManifestPath = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillManifestPath)) continue;

            const frontmatterName = this.extractFrontmatterName(skillManifestPath);
            if (!frontmatterName) continue;
            if (wanted.has(frontmatterName.toLowerCase())) {
                return skillDir;
            }
        }
        return null;
    }

    private resolveSkillDir(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): string | null {
        const candidates = [skillKeyOrSlug, fallbackSlug]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map(v => v.trim());
        const uniqueCandidates = [...new Set(candidates)];
        if (preferredBaseDir && preferredBaseDir.trim() && fs.existsSync(preferredBaseDir.trim())) {
            return preferredBaseDir.trim();
        }
        const directSkillDir = uniqueCandidates
            .map((id) => path.join(this.workDir, 'skills', id))
            .find((dir) => fs.existsSync(dir));
        return directSkillDir || this.resolveSkillDirByManifestName(uniqueCandidates);
    }

    async openSkillReadme(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);

        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
        let targetFile = '';

        if (skillDir) {
            for (const file of possibleFiles) {
                const filePath = path.join(skillDir, file);
                if (fs.existsSync(filePath)) {
                    targetFile = filePath;
                    break;
                }
            }
        }

        if (!targetFile) {
            if (skillDir) {
                targetFile = skillDir;
            } else {
                throw new Error('Skill directory not found');
            }
        }

        try {
            await shell.openPath(targetFile);
            return true;
        } catch (error) {
            console.error('Failed to open skill readme:', error);
            throw error;
        }
    }

    async openSkillPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
        if (!skillDir) {
            throw new Error('Skill directory not found');
        }
        const openResult = await shell.openPath(skillDir);
        if (openResult) {
            throw new Error(openResult);
        }
        return true;
    }
}
