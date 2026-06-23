/**
 * Skill Config Utilities
 * Direct read/write access to skill configuration in ~/.openclaw/openclaw.json
 * This bypasses the Gateway RPC for faster and more reliable config updates.
 *
 * All file I/O uses async fs/promises to avoid blocking the main thread.
 */
import { readFile, writeFile, access, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import { getOpenClawConfigPath, getOpenClawDir, getOpenClawResolvedDir, getOpenClawSkillsDir } from './paths';
import { logger } from './logger';
import { cpAsyncSafe } from './plugin-install';
import { withConfigLock } from './config-mutex';
import { isJunFeiAIManagedDistribution } from './junfeiai-distribution';
import { parseJsonWithBom } from './json';
import {
    UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS,
    UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET,
} from '../shared/skills/bundled-allowlist';

const BUNDLED_OPENCLAW_SKILL_ALLOWLIST = UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILL_SET;

export interface SkillConfigUpdates {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
}

type SkillEntry = SkillConfigUpdates;

interface OpenClawConfig {
    skills?: {
        entries?: Record<string, SkillEntry>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface PreinstalledMarker {
    source: 'clawx-preinstalled';
    slug: string;
    version: string;
    installedAt: string;
}

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Read the current OpenClaw config
 */
async function readConfig(): Promise<OpenClawConfig> {
    const configPath = getOpenClawConfigPath();
    if (!(await fileExists(configPath))) {
        return {};
    }
    try {
        const raw = await readFile(configPath, 'utf-8');
        return parseJsonWithBom<OpenClawConfig>(raw);
    } catch (err) {
        console.error('Failed to read openclaw config:', err);
        return {};
    }
}

/**
 * Write the OpenClaw config
 */
async function writeConfig(config: OpenClawConfig): Promise<void> {
    const json = JSON.stringify(config, null, 2);
    await writeFile(getOpenClawConfigPath(), json, 'utf-8');
}

/**
 * Get skill config
 */
export async function getSkillConfig(skillKey: string): Promise<SkillEntry | undefined> {
    const config = await readConfig();
    return config.skills?.entries?.[skillKey];
}

/**
 * Update skill config (apiKey and env)
 */
function isEmptySkillEntry(entry: SkillEntry | undefined): boolean {
    if (!entry) return true;
    const hasEnabled = typeof entry.enabled === 'boolean';
    const hasApiKey = typeof entry.apiKey === 'string' && entry.apiKey.trim().length > 0;
    const hasEnv = !!entry.env && Object.keys(entry.env).length > 0;
    return !hasEnabled && !hasApiKey && !hasEnv;
}

async function applySkillConfigUpdates(
    config: OpenClawConfig,
    updates: Array<{ skillKey: string; remove?: boolean } & SkillConfigUpdates>,
): Promise<void> {
    if (!config.skills) {
        config.skills = {};
    }
    if (!config.skills.entries) {
        config.skills.entries = {};
    }

    for (const update of updates) {
        const skillKey = update.skillKey.trim();
        if (!skillKey) continue;

        if (update.remove) {
            delete config.skills.entries[skillKey];
            continue;
        }

        const entry = config.skills.entries[skillKey] || {};

        if (update.enabled !== undefined) {
            entry.enabled = update.enabled;
        }

        if (update.apiKey !== undefined) {
            const trimmed = update.apiKey.trim();
            if (trimmed) {
                entry.apiKey = trimmed;
            } else {
                delete entry.apiKey;
            }
        }

        if (update.env !== undefined) {
            const newEnv: Record<string, string> = {};

            for (const [key, value] of Object.entries(update.env)) {
                const trimmedKey = key.trim();
                if (!trimmedKey) continue;

                const trimmedVal = value.trim();
                if (trimmedVal) {
                    newEnv[trimmedKey] = trimmedVal;
                }
            }

            if (Object.keys(newEnv).length > 0) {
                entry.env = newEnv;
            } else {
                delete entry.env;
            }
        }

        if (isEmptySkillEntry(entry)) {
            delete config.skills.entries[skillKey];
        } else {
            config.skills.entries[skillKey] = entry;
        }
    }

    if (config.skills.entries && Object.keys(config.skills.entries).length === 0) {
        delete config.skills.entries;
    }
    if (config.skills && Object.keys(config.skills).length === 0) {
        delete config.skills;
    }
}

export async function updateSkillConfig(
    skillKey: string,
    updates: SkillConfigUpdates,
): Promise<{ success: boolean; error?: string }> {
    return updateSkillConfigs([{ skillKey, ...updates }]);
}

export async function updateSkillConfigs(
    updates: Array<{ skillKey: string } & SkillConfigUpdates>,
): Promise<{ success: boolean; error?: string }> {
    try {
        return await withConfigLock(async () => {
            const config = await readConfig();
            await applySkillConfigUpdates(config, updates);
            await writeConfig(config);
            return { success: true };
        });
    } catch (err) {
        console.error('Failed to update skill config:', err);
        return { success: false, error: String(err) };
    }
}

export async function removeSkillConfig(skillKey: string): Promise<{ success: boolean; error?: string }> {
    return removeSkillConfigs([skillKey]);
}

export async function removeSkillConfigs(skillKeys: string[]): Promise<{ success: boolean; removed: number; error?: string }> {
    try {
        return await withConfigLock(async () => {
            const config = await readConfig();
            const existingEntries = config.skills?.entries || {};
            const normalizedSkillKeys = skillKeys
                .map((skillKey) => skillKey.trim())
                .filter(Boolean);
            const removed = normalizedSkillKeys.filter((skillKey) => Object.prototype.hasOwnProperty.call(existingEntries, skillKey)).length;

            if (removed === 0) {
                return { success: true, removed: 0 };
            }

            await applySkillConfigUpdates(
                config,
                normalizedSkillKeys.map((skillKey) => ({ skillKey, remove: true })),
            );
            await writeConfig(config);

            return { success: true, removed };
        });
    } catch (err) {
        console.error('Failed to remove skill configs:', err);
        return { success: false, removed: 0, error: String(err) };
    }
}

/**
 * Get all skill configs (for syncing to frontend)
 */
export async function getAllSkillConfigs(): Promise<Record<string, SkillEntry>> {
    const config = await readConfig();
    return config.skills?.entries || {};
}

function getDisallowedBundledOpenClawSkillSlugs(bundledSkillSlugs: string[]): string[] {
    if (isJunFeiAIManagedDistribution()) {
        return [];
    }
    return bundledSkillSlugs.filter((slug) => !BUNDLED_OPENCLAW_SKILL_ALLOWLIST.has(slug));
}

export async function trimBundledOpenClawSkills(options?: { bundledSkillsRoot?: string }): Promise<{ removed: number; removedSlugs: string[]; kept: string[] }> {
    const bundledSkillsRoot = options?.bundledSkillsRoot || join(getOpenClawResolvedDir(), 'skills');
    if (isJunFeiAIManagedDistribution()) {
        return { removed: 0, removedSlugs: [], kept: ['*'] };
    }
    if (!existsSync(bundledSkillsRoot)) {
        return { removed: 0, removedSlugs: [], kept: [...UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS] };
    }

    try {
        const entries = await readdir(bundledSkillsRoot, { withFileTypes: true });
        const disallowed = getDisallowedBundledOpenClawSkillSlugs(
            entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name),
        );

        let removed = 0;
        const removedSlugs: string[] = [];
        for (const slug of disallowed) {
            const skillDir = join(bundledSkillsRoot, slug);
            if (!existsSync(join(skillDir, 'SKILL.md'))) {
                continue;
            }
            await rm(skillDir, { recursive: true, force: true });
            removed += 1;
            removedSlugs.push(slug);
        }

        return { removed, removedSlugs, kept: [...UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS] };
    } catch (error) {
        logger.warn('Failed to trim bundled OpenClaw skills:', error);
        return { removed: 0, removedSlugs: [], kept: [...UCLAW_DEFAULT_BUNDLED_OPENCLAW_SKILLS] };
    }
}

export async function trimBundledOpenClawSkillsAndConfigs(
    options?: { bundledSkillsRoot?: string },
): Promise<{ removed: number; removedSlugs: string[]; removedConfigs: number; kept: string[] }> {
    const trimResult = await trimBundledOpenClawSkills(options);
    const removeResult = trimResult.removedSlugs.length > 0
        ? await removeSkillConfigs(trimResult.removedSlugs)
        : { success: true, removed: 0 };

    if (!removeResult.success) {
        logger.warn(`Failed to prune stale bundled skill configs: ${removeResult.error || 'unknown error'}`);
    }

    return {
        ...trimResult,
        removedConfigs: removeResult.removed,
    };
}

/**
 * Built-in skills bundled with ClawX that should be pre-deployed to
 * ~/.openclaw/skills/ on first launch.  These come from the openclaw package's
 * extensions directory and are available in both dev and packaged builds.
 */
const BUILTIN_SKILLS = [] as const;

/**
 * Ensure built-in skills are deployed to ~/.openclaw/skills/<slug>/.
 * Skips any skill that already has a SKILL.md present (idempotent).
 * Runs at app startup; all errors are logged and swallowed so they never
 * block the normal startup flow.
 */
export async function ensureBuiltinSkillsInstalled(): Promise<void> {
    const skillsRoot = getOpenClawSkillsDir();

    for (const { slug, sourceExtension } of BUILTIN_SKILLS) {
        const targetDir = join(skillsRoot, slug);
        const targetManifest = join(targetDir, 'SKILL.md');

        if (existsSync(targetManifest)) {
            continue; // already installed
        }

        const openclawDir = getOpenClawDir();
        const sourceDir = join(openclawDir, 'extensions', sourceExtension, 'skills', slug);

        if (!existsSync(join(sourceDir, 'SKILL.md'))) {
            logger.warn(`Built-in skill source not found, skipping: ${sourceDir}`);
            continue;
        }

        try {
            await mkdir(targetDir, { recursive: true });
            await cpAsyncSafe(sourceDir, targetDir);
            logger.info(`Installed built-in skill: ${slug} -> ${targetDir}`);
        } catch (error) {
            logger.warn(`Failed to install built-in skill ${slug}:`, error);
        }
    }
}

const PREINSTALLED_MARKER_NAME = '.clawx-preinstalled.json';

async function tryReadMarker(markerPath: string): Promise<PreinstalledMarker | null> {
    if (!existsSync(markerPath)) {
        return null;
    }
    try {
        const raw = await readFile(markerPath, 'utf-8');
        const parsed = parseJsonWithBom<PreinstalledMarker>(raw);
        if (!parsed?.slug || !parsed?.version) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Remove legacy ClawX-owned preinstalled skills from ~/.openclaw/skills.
 * These are identified exclusively by the `.clawx-preinstalled.json` marker.
 * OpenClaw bundled skills are not touched here because they live under the
 * OpenClaw package tree, not the managed skills directory.
 */
export async function removeClawXPreinstalledSkillsAndConfigs(): Promise<{
    removed: number;
    removedSlugs: string[];
    removedConfigs: number;
}> {
    return removeClawXPreinstalledSkillsAndConfigsWithOptions();
}

export async function removeClawXPreinstalledSkillsAndConfigsWithOptions(options?: {
    skillsRoot?: string;
}): Promise<{
    removed: number;
    removedSlugs: string[];
    removedConfigs: number;
}> {
    const targetRoot = options?.skillsRoot || getOpenClawSkillsDir();
    if (!existsSync(targetRoot)) {
        return { removed: 0, removedSlugs: [], removedConfigs: 0 };
    }

    const entries = await readdir(targetRoot, { withFileTypes: true });
    const removedSlugs: string[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(targetRoot, entry.name);
        const marker = await tryReadMarker(join(skillDir, PREINSTALLED_MARKER_NAME));
        if (!marker) continue;

        try {
            await rm(skillDir, { recursive: true, force: true });
            removedSlugs.push(entry.name);
        } catch (error) {
            logger.warn(`Failed to remove legacy ClawX preinstalled skill ${entry.name}:`, error);
        }
    }

    const removeResult = removedSlugs.length > 0
        ? await removeSkillConfigs(removedSlugs)
        : { success: true, removed: 0 };

    if (!removeResult.success) {
        logger.warn(`Failed to prune legacy ClawX preinstalled skill configs: ${removeResult.error || 'unknown error'}`);
    }

    return {
        removed: removedSlugs.length,
        removedSlugs,
        removedConfigs: removeResult.removed,
    };
}
