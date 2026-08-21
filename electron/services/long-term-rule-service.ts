import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  LongTermRule,
  LongTermRuleCapturePayload,
  LongTermRuleCaptureResult,
  LongTermRuleContext,
  LongTermRuleCreatePayload,
  LongTermRuleDeletePayload,
  LongTermRuleListPayload,
  LongTermRuleListResult,
  LongTermRuleMutationResult,
  LongTermRuleUpdatePayload,
  LongTermRuleUndoPayload,
} from '../../shared/long-term-rules';
import { getManagedClientRuntimeConfigSnapshot } from './managed-client-config-service';
import { updateAtomicTextFile } from '../utils/atomic-text-file';
import { expandOpenClawPath, getOpenClawConfigDir } from '../utils/paths';

const STORE_VERSION = 1;
const MAX_UNDO_ENTRIES = 20;
const MAX_RULE_LENGTH = 20_000;
const AGENTS_MARKER_START = '<!-- UCLAW_LONG_TERM_RULES_START -->';
const AGENTS_MARKER_END = '<!-- UCLAW_LONG_TERM_RULES_END -->';
const STRONG_MEMORY_INTENT = /(?:记住|写死|以后一直|长期指令|长期规则|始终遵守|always remember|from now on|make this permanent|permanent rule)/iu;
const NEGATED_MEMORY_INTENT = /(?:不要记住|别记住|不用记住|取消记住|forget (?:this|that)|do not remember)/iu;
const GLOBAL_SCOPE_INTENT = /(?:全局|所有\s*(?:Agent|智能体|代理)|全部\s*(?:Agent|智能体|代理)|global|all agents)/iu;

type WorkspaceRegistration = { agentId: string; workspaceRoot: string };
type UndoEntry = { token: string; rules: LongTermRule[]; createdAt: string };
type LongTermRuleStore = {
  schemaVersion: 1;
  rules: LongTermRule[];
  workspaces: WorkspaceRegistration[];
  undo: UndoEntry[];
};
type DisabledLongTermRuleMutationResult = LongTermRuleMutationResult & { disabled: true };
type DisabledLongTermRuleCaptureResult = LongTermRuleCaptureResult & { disabled: true };

class LongTermRuleStoreError extends Error {
  readonly code: string;
  readonly failureKind: string;

  constructor(code: string, message: string, failureKind: string) {
    super(message);
    this.name = 'LongTermRuleStoreError';
    this.code = code;
    this.failureKind = failureKind;
    this.stack = `${this.name}: ${message}`;
  }
}

function safeStoreFailureKind(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid_json';
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && /^(?:EACCES|EBUSY|EEXIST|EIO|EISDIR|EMFILE|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/u.test(code)
    ? `fs_${code.toLowerCase()}`
    : 'operation_failed';
}

function emptyStore(): LongTermRuleStore {
  return { schemaVersion: STORE_VERSION, rules: [], workspaces: [], undo: [] };
}

function cleanRuleContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Rule content must be a string');
  const content = value.trim();
  if (!content || content.length > MAX_RULE_LENGTH) throw new Error('Rule content is empty or too long');
  return content;
}

function cleanAgentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
    throw new Error('Invalid Agent ID');
  }
  return value.trim();
}

function normalizedWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Workspace is required');
  const expanded = expandOpenClawPath(value.trim());
  if (!isAbsolute(expanded)) throw new Error('Workspace must resolve to an absolute path');
  return resolve(expanded);
}

function normalizedContext(input: LongTermRuleContext): WorkspaceRegistration {
  return { agentId: cleanAgentId(input.agentId), workspaceRoot: normalizedWorkspace(input.workspaceRoot) };
}

function cloneRules(rules: LongTermRule[]): LongTermRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function safeProjectedContent(content: string): string {
  return content
    .replaceAll(AGENTS_MARKER_START, '[UCLAW_LONG_TERM_RULES_START]')
    .replaceAll(AGENTS_MARKER_END, '[UCLAW_LONG_TERM_RULES_END]');
}

function renderRuleBlock(rules: LongTermRule[], agentId: string): string {
  const enabled = rules
    .filter((rule) => rule.enabled && (rule.scope === 'global' || rule.agentId === agentId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (enabled.length === 0) return '';
  const sections = enabled.map((rule) => [
    `### ${rule.scope === 'global' ? 'Global' : 'Agent'} Rule ${rule.id} (v${rule.version})`,
    '',
    safeProjectedContent(rule.content),
  ].join('\n'));
  return [
    AGENTS_MARKER_START,
    '## UClaw Long-Term Rules',
    '',
    'These rules were explicitly saved by the user. Follow every enabled rule that applies to this Agent.',
    '',
    ...sections.flatMap((section, index) => index === 0 ? [section] : ['', section]),
    AGENTS_MARKER_END,
  ].join('\n');
}

function replaceManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_MARKER_START);
  const end = existing.indexOf(AGENTS_MARKER_END);
  if (start < 0 && end < 0) {
    if (!block) return existing;
    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
    const separator = !existing
      ? ''
      : existing.endsWith(`${newline}${newline}`)
        ? ''
        : existing.endsWith(newline) ? newline : `${newline}${newline}`;
    const rendered = block.replace(/\r\n|\r|\n/gu, newline);
    return `${existing}${separator}${rendered}${newline}`;
  }
  const duplicateStart = start >= 0
    ? existing.indexOf(AGENTS_MARKER_START, start + AGENTS_MARKER_START.length)
    : -1;
  const duplicateEnd = end >= 0
    ? existing.indexOf(AGENTS_MARKER_END, end + AGENTS_MARKER_END.length)
    : -1;
  if (start < 0 || end < start || duplicateStart >= 0 || duplicateEnd >= 0) {
    throw new Error('Malformed UClaw long-term rules managed block');
  }
  const after = end + AGENTS_MARKER_END.length;
  if (!block) return `${existing.slice(0, start)}${existing.slice(after)}`;
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const rendered = block.replace(/\r\n|\r|\n/gu, newline);
  return `${existing.slice(0, start)}${rendered}${existing.slice(after)}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  let temporary = '';
  try {
    await mkdir(dirname(filePath), { recursive: true });
    temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } catch (error) {
    throw new LongTermRuleStoreError(
      'LONG_TERM_RULE_STORE_WRITE_FAILED',
      'Long-term rules store could not be written',
      safeStoreFailureKind(error),
    );
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function normalizeLoadedStore(value: unknown): LongTermRuleStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<LongTermRuleStore>;
  if (record.schemaVersion !== STORE_VERSION || !Array.isArray(record.rules) || !Array.isArray(record.workspaces) || !Array.isArray(record.undo)) {
    return null;
  }
  const rules = record.rules.filter((rule): rule is LongTermRule => (
    Boolean(rule)
    && typeof rule.id === 'string'
    && rule.id.length > 0
    && (rule.scope === 'global' || rule.scope === 'agent')
    && (rule.scope === 'global' || (typeof rule.agentId === 'string' && /^[a-zA-Z0-9_-]+$/.test(rule.agentId)))
    && typeof rule.content === 'string'
    && rule.content.trim().length > 0
    && rule.content.length <= MAX_RULE_LENGTH
    && typeof rule.enabled === 'boolean'
    && Number.isSafeInteger(rule.version)
    && rule.version > 0
    && typeof rule.createdAt === 'string'
    && Number.isFinite(Date.parse(rule.createdAt))
    && typeof rule.updatedAt === 'string'
    && Number.isFinite(Date.parse(rule.updatedAt))
  ));
  if (rules.length !== record.rules.length) return null;
  const workspaces = record.workspaces.filter((workspace): workspace is WorkspaceRegistration => (
    Boolean(workspace)
    && typeof workspace.agentId === 'string'
    && /^[a-zA-Z0-9_-]+$/.test(workspace.agentId)
    && typeof workspace.workspaceRoot === 'string'
    && isAbsolute(workspace.workspaceRoot)
  ));
  if (workspaces.length !== record.workspaces.length) return null;
  const undo = record.undo.filter((entry): entry is UndoEntry => (
    Boolean(entry)
    && typeof entry.token === 'string'
    && Array.isArray(entry.rules)
    && typeof entry.createdAt === 'string'
    && Number.isFinite(Date.parse(entry.createdAt))
  ));
  if (undo.length !== record.undo.length) return null;
  return {
    schemaVersion: STORE_VERSION,
    rules,
    workspaces,
    undo: undo.slice(-MAX_UNDO_ENTRIES),
  };
}

export class LongTermRuleService {
  private store: LongTermRuleStore | null = null;
  private queue: Promise<void> = Promise.resolve();

  private get storePath(): string {
    return join(getOpenClawConfigDir(), 'uclaw-long-term-rules.json');
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<LongTermRuleStore> {
    if (this.store) return this.store;
    try {
      const store = normalizeLoadedStore(JSON.parse(await readFile(this.storePath, 'utf8')));
      if (!store) {
        throw new LongTermRuleStoreError(
          'LONG_TERM_RULE_STORE_INVALID_FORMAT',
          'Long-term rules store could not be read',
          'invalid_format',
        );
      }
      this.store = store;
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      if (code !== 'ENOENT') {
        if (error instanceof LongTermRuleStoreError) throw error;
        throw new LongTermRuleStoreError(
          'LONG_TERM_RULE_STORE_READ_FAILED',
          'Long-term rules store could not be read',
          safeStoreFailureKind(error),
        );
      }
      this.store = emptyStore();
    }
    return this.store;
  }

  private runtimeGate(): { enabled: boolean; epoch: number } {
    const snapshot = getManagedClientRuntimeConfigSnapshot();
    const features = snapshot.config.features as typeof snapshot.config.features & {
      longTermRules?: { enabled?: unknown };
    };
    return { enabled: features.longTermRules?.enabled === true, epoch: snapshot.epoch };
  }

  private serialWhenEnabled<T>(disabled: () => T, operation: () => Promise<T>): Promise<T> {
    const requestedGate = this.runtimeGate();
    if (!requestedGate.enabled) return Promise.resolve(disabled());
    return this.serial(async () => {
      const currentGate = this.runtimeGate();
      if (!currentGate.enabled || currentGate.epoch !== requestedGate.epoch) return disabled();
      return operation();
    });
  }

  private disabledMutation(): DisabledLongTermRuleMutationResult {
    return { rules: [], disabled: true };
  }

  private disabledCapture(): DisabledLongTermRuleCaptureResult {
    return { captured: false, rules: [], disabled: true };
  }

  private async listEnabled(input?: LongTermRuleListPayload): Promise<LongTermRule[]> {
    const store = await this.load();
    if (!input) return cloneRules(store.rules);
    const context = normalizedContext(input);
    const changed = this.registerWorkspace(store, context);
    if (changed) await this.persist(store);
    return this.visibleRules(store, context);
  }

  private async createEnabled(input: LongTermRuleCreatePayload): Promise<LongTermRuleMutationResult> {
    const store = await this.load();
    const context = normalizedContext(input);
    const content = cleanRuleContent(input.content);
    if (input.scope !== 'global' && input.scope !== 'agent') throw new Error('Invalid rule scope');
    const agentId = input.scope === 'agent' ? context.agentId : undefined;
    const duplicate = store.rules.find((rule) => (
      rule.scope === input.scope && rule.agentId === agentId && rule.content === content
    ));
    this.registerWorkspace(store, context);
    if (duplicate) {
      let undoToken: string | undefined;
      if (!duplicate.enabled) {
        undoToken = this.checkpoint(store);
        duplicate.enabled = true;
        duplicate.version += 1;
        duplicate.updatedAt = new Date().toISOString();
      }
      await this.persist(store);
      await this.projectRegistered(store, input.scope === 'agent' ? context.agentId : undefined);
      return { rules: this.visibleRules(store, context), ...(undoToken ? { undoToken } : {}) };
    }
    const undoToken = this.checkpoint(store);
    const now = new Date().toISOString();
    store.rules.push({
      id: randomUUID(),
      scope: input.scope,
      ...(agentId ? { agentId } : {}),
      content,
      enabled: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.persist(store);
    await this.projectRegistered(store, input.scope === 'agent' ? context.agentId : undefined);
    return { rules: this.visibleRules(store, context), undoToken };
  }

  private async persist(store: LongTermRuleStore): Promise<void> {
    await atomicWrite(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
  }

  private registerWorkspace(store: LongTermRuleStore, context: WorkspaceRegistration): boolean {
    const exists = store.workspaces.some((entry) => (
      entry.agentId === context.agentId && entry.workspaceRoot === context.workspaceRoot
    ));
    if (exists) return false;
    store.workspaces.push(context);
    return true;
  }

  private checkpoint(store: LongTermRuleStore): string {
    const token = randomUUID();
    store.undo.push({ token, rules: cloneRules(store.rules), createdAt: new Date().toISOString() });
    store.undo = store.undo.slice(-MAX_UNDO_ENTRIES);
    return token;
  }

  private async projectWorkspace(store: LongTermRuleStore, context: WorkspaceRegistration): Promise<void> {
    try {
      if (!(await stat(context.workspaceRoot)).isDirectory()) return;
    } catch {
      return;
    }
    const agentsPath = join(context.workspaceRoot, 'AGENTS.md');
    const block = renderRuleBlock(store.rules, context.agentId);
    await updateAtomicTextFile(
      agentsPath,
      (existing) => replaceManagedBlock(existing, block),
      { createParent: false },
    );
  }

  private async projectRegistered(store: LongTermRuleStore, agentId?: string): Promise<void> {
    for (const workspace of store.workspaces) {
      if (agentId && workspace.agentId !== agentId) continue;
      await this.projectWorkspace(store, workspace);
    }
  }

  private visibleRules(store: LongTermRuleStore, context: WorkspaceRegistration): LongTermRule[] {
    return cloneRules(store.rules.filter((rule) => (
      rule.scope === 'global' || rule.agentId === context.agentId
    )));
  }

  private assertRuleCanBeManaged(rule: LongTermRule, context: WorkspaceRegistration): void {
    if (rule.scope === 'agent' && rule.agentId !== context.agentId) {
      throw new Error('Long-term rule belongs to a different Agent');
    }
  }

  list(input?: LongTermRuleListPayload): Promise<LongTermRuleListResult> {
    return this.serialWhenEnabled<LongTermRuleListResult>(
      () => ({ status: 'disabled', rules: [] }),
      async () => ({ status: 'enabled', rules: await this.listEnabled(input) }),
    );
  }

  create(input: LongTermRuleCreatePayload): Promise<LongTermRuleMutationResult> {
    return this.serialWhenEnabled<LongTermRuleMutationResult>(
      () => this.disabledMutation(),
      () => this.createEnabled(input),
    );
  }

  update(input: LongTermRuleUpdatePayload): Promise<LongTermRuleMutationResult> {
    return this.serialWhenEnabled<LongTermRuleMutationResult>(() => this.disabledMutation(), async () => {
        const store = await this.load();
        const context = normalizedContext(input);
        this.registerWorkspace(store, context);
        const rule = store.rules.find((candidate) => candidate.id === input.id);
        if (!rule) throw new Error('Long-term rule not found');
        this.assertRuleCanBeManaged(rule, context);
        const content = input.content === undefined ? rule.content : cleanRuleContent(input.content);
        const enabled = input.enabled === undefined ? rule.enabled : input.enabled;
        if (content === rule.content && enabled === rule.enabled) return { rules: this.visibleRules(store, context) };
        const undoToken = this.checkpoint(store);
        rule.content = content;
        rule.enabled = enabled;
        rule.version += 1;
        rule.updatedAt = new Date().toISOString();
        await this.persist(store);
        await this.projectRegistered(store, rule.scope === 'agent' ? rule.agentId : undefined);
        return { rules: this.visibleRules(store, context), undoToken };
    });
  }

  delete(input: LongTermRuleDeletePayload): Promise<LongTermRuleMutationResult> {
    return this.serialWhenEnabled<LongTermRuleMutationResult>(() => this.disabledMutation(), async () => {
        const store = await this.load();
        const context = normalizedContext(input);
        this.registerWorkspace(store, context);
        const index = store.rules.findIndex((rule) => rule.id === input.id);
        if (index < 0) throw new Error('Long-term rule not found');
        const removed = store.rules[index];
        this.assertRuleCanBeManaged(removed, context);
        const undoToken = this.checkpoint(store);
        store.rules.splice(index, 1);
        await this.persist(store);
        await this.projectRegistered(store, removed?.scope === 'agent' ? removed.agentId : undefined);
        return { rules: this.visibleRules(store, context), undoToken };
    });
  }

  undo(input: LongTermRuleUndoPayload): Promise<LongTermRuleMutationResult> {
    return this.serialWhenEnabled<LongTermRuleMutationResult>(() => this.disabledMutation(), async () => {
        const store = await this.load();
        const context = normalizedContext(input);
        this.registerWorkspace(store, context);
        const latest = store.undo.at(-1);
        if (!latest || latest.token !== input.undoToken) throw new Error('Undo action has expired');
        store.rules = cloneRules(latest.rules);
        store.undo.pop();
        await this.persist(store);
        await this.projectRegistered(store);
        return { rules: this.visibleRules(store, context) };
    });
  }

  capture(input: LongTermRuleCapturePayload): Promise<LongTermRuleCaptureResult> {
    const message = input.message.trim();
    return this.serialWhenEnabled<LongTermRuleCaptureResult>(() => this.disabledCapture(), async () => {
      if (!message || NEGATED_MEMORY_INTENT.test(message) || !STRONG_MEMORY_INTENT.test(message)) {
        return { captured: false, rules: await this.listEnabled(input) };
      }
      const scope = GLOBAL_SCOPE_INTENT.test(message) ? 'global' : 'agent';
      const result = await this.createEnabled({ ...input, scope, content: message });
      const contextAgentId = scope === 'agent' ? input.agentId : undefined;
      const rule = result.rules.find((candidate) => (
        candidate.scope === scope
        && candidate.agentId === contextAgentId
        && candidate.content === message
      ));
      return { ...result, captured: Boolean(rule), ...(rule ? { rule } : {}) };
    });
  }

  repair(input: LongTermRuleContext): Promise<LongTermRule[]> {
    return this.serialWhenEnabled(() => [], async () => {
        const store = await this.load();
        const context = normalizedContext(input);
        const changed = this.registerWorkspace(store, context);
        if (changed) await this.persist(store);
        await this.projectWorkspace(store, context);
        return cloneRules(store.rules);
    });
  }

  repairKnownWorkspaces(): Promise<void> {
    return this.serialWhenEnabled(() => undefined, async () => {
        const store = await this.load();
        await this.projectRegistered(store);
    });
  }

  unregisterAgent(agentId: string): Promise<void> {
    return this.serialWhenEnabled(() => undefined, async () => {
        const store = await this.load();
        const normalizedAgentId = cleanAgentId(agentId);
        const next = store.workspaces.filter((workspace) => workspace.agentId !== normalizedAgentId);
        if (next.length === store.workspaces.length) return;
        store.workspaces = next;
        await this.persist(store);
    });
  }
}

export const longTermRuleService = new LongTermRuleService();

export const __test = { renderRuleBlock, replaceManagedBlock };
