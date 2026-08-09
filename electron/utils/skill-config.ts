/**
 * Skill Config Utilities
 * Direct read/write access to skill configuration in ~/.openclaw/openclaw.json
 * This bypasses the Gateway RPC for faster and more reliable config updates.
 *
 * All file I/O uses async fs/promises to avoid blocking the main thread.
 */
import { readFile, writeFile, access, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import {
    getOpenClawConfigDir,
    getOpenClawDir,
    resolveOpenClawConfigPath,
} from './paths';
import { logger } from './logger';
import { cpAsyncSafe } from './plugin-install';
import { withConfigLock } from './config-mutex';

const RETIRED_PREINSTALLED_SKILL_SLUGS = ['docx', 'pdf', 'pptx', 'xlsx'] as const;

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
    source?: string;
    slug?: string;
}

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Read the current OpenClaw config
 */
async function readConfig(): Promise<OpenClawConfig> {
    const configPath = resolveOpenClawConfigPath();
    if (!(await fileExists(configPath))) {
        return {};
    }
    try {
        const raw = await readFile(configPath, 'utf-8');
        return JSON.parse(raw);
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
    await writeFile(resolveOpenClawConfigPath(), json, 'utf-8');
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
    const skillsRoot = join(getOpenClawConfigDir(), 'skills');

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

async function readPreinstalledMarker(markerPath: string): Promise<PreinstalledMarker | null> {
    if (!existsSync(markerPath)) {
        return null;
    }
    try {
        const raw = await readFile(markerPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledMarker;
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/** Remove only retired skill directories that still carry UClaw's ownership marker. */
export async function removeRetiredPreinstalledSkills(): Promise<{
    removed: number;
    removedSlugs: string[];
    removedConfigs: number;
}> {
    const skillsRoot = join(getOpenClawConfigDir(), 'skills');
    const removedSlugs: string[] = [];

    for (const slug of RETIRED_PREINSTALLED_SKILL_SLUGS) {
        const skillDir = join(skillsRoot, slug);
        const marker = await readPreinstalledMarker(join(skillDir, PREINSTALLED_MARKER_NAME));
        if (marker?.source !== 'clawx-preinstalled' || marker.slug !== slug) {
            continue;
        }

        try {
            await rm(skillDir, { recursive: true, force: true });
            removedSlugs.push(slug);
        } catch (error) {
            logger.warn(`Failed to remove retired preinstalled skill ${slug}:`, error);
        }
    }

    const removeResult = removedSlugs.length > 0
        ? await removeSkillConfigs(removedSlugs)
        : { success: true, removed: 0 };
    if (!removeResult.success) {
        logger.warn(`Failed to remove retired preinstalled skill configs: ${removeResult.error || 'unknown error'}`);
    }

    return {
        removed: removedSlugs.length,
        removedSlugs,
        removedConfigs: removeResult.removed,
    };
}
