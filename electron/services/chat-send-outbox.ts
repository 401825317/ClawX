import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import {
  CHAT_SEND_OUTBOX_SCHEMA_VERSION,
  type ChatSendOutboxAttachment,
  type ChatSendOutboxItem,
  type ChatSendOutboxListResult,
  type ChatSendOutboxRejectedItem,
} from '../../shared/chat-send-outbox';
import { getOpenClawConfigDir } from '../utils/paths';

const OUTBOX_ENVELOPE_SCHEMA = 'uclaw.chat-send-outbox.encrypted/v1';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 7 * DEFAULT_TTL_MS;
const MAX_GLOBAL_ITEMS = 100;
const MAX_SESSION_ITEMS = 20;
const MAX_PROMPT_BYTES = 64 * 1_024;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_METADATA_BYTES = 32 * 1_024;
const MAX_STRING_LENGTH = 2_048;
const DISPATCHED_ATTACHMENT_LEASE_MS = 24 * 60 * 60 * 1_000;
const MAX_RELEASED_ATTACHMENT_LEASES = 500;

type ReleasedAttachmentLease = {
  stagedPath: string;
  deleteAfter: number;
};

type PersistedOutbox = {
  version: typeof CHAT_SEND_OUTBOX_SCHEMA_VERSION;
  items: ChatSendOutboxItem[];
  releasedAttachments?: ReleasedAttachmentLease[];
};

type EncryptedEnvelope = {
  schema: typeof OUTBOX_ENVELOPE_SCHEMA;
  ciphertext: string;
};

export type ChatSendOutboxEncryption = {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
};

export type ChatSendOutboxOptions = {
  rootDir?: string;
  approvedAttachmentRoots?: string[];
  ownedStagingRoots?: string[];
  encryption?: ChatSendOutboxEncryption;
  now?: () => number;
};

function defaultEncryption(): ChatSendOutboxEncryption {
  return {
    isAvailable: () => {
      try {
        return Boolean(safeStorage?.isEncryptionAvailable?.());
      } catch {
        return false;
      }
    },
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizedString(value: unknown, field: string, maximum = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (utf8Bytes(normalized) > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function optionalString(value: unknown, maximum = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim();
  if (utf8Bytes(normalized) > maximum) throw new Error('Optional outbox field is too long');
  return normalized;
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeAttachment(value: ChatSendOutboxAttachment): ChatSendOutboxAttachment {
  const fileSize = Number(value?.fileSize);
  if (!Number.isFinite(fileSize) || fileSize < 0) throw new Error('Attachment fileSize is invalid');
  const stagedPath = normalizedString(value?.stagedPath, 'attachment.stagedPath', 4_096);
  if (/^(?:https?|data|blob):/iu.test(stagedPath)) throw new Error('Attachment staging URLs cannot be persisted');
  return {
    fileName: normalizedString(value?.fileName, 'attachment.fileName', 512),
    mimeType: normalizedString(value?.mimeType, 'attachment.mimeType', 256),
    fileSize: Math.floor(fileSize),
    stagedPath,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Main-owned encrypted persistence for accepted renderer send intents. */
export class ChatSendOutboxService {
  private readonly items = new Map<string, ChatSendOutboxItem>();
  private readonly releasedAttachments = new Map<string, number>();
  private readonly rootDir: string;
  private readonly approvedAttachmentRoots: string[];
  private readonly ownedStagingRoots: string[];
  private readonly encryption: ChatSendOutboxEncryption;
  private readonly now: () => number;
  private initialized?: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ChatSendOutboxOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(getOpenClawConfigDir(), 'uclaw-runtime', 'chat-send-outbox');
    this.approvedAttachmentRoots = (options.approvedAttachmentRoots ?? [
      path.join(getOpenClawConfigDir(), 'media'),
    ]).map((root) => path.resolve(root));
    this.ownedStagingRoots = (options.ownedStagingRoots ?? [
      path.join(getOpenClawConfigDir(), 'media', 'outbound'),
    ]).map((root) => path.resolve(root));
    this.encryption = options.encryption ?? defaultEncryption();
    this.now = options.now ?? Date.now;
  }

  /** Validate and idempotently retain one accepted send intent. */
  async enqueue(input: ChatSendOutboxItem): Promise<{ item: ChatSendOutboxItem; durable: boolean; idempotent: boolean }> {
    return this.withMutation(async () => {
      const item = this.normalizeItem(input);
      const existing = this.items.get(item.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error('Outbox idempotency key was reused with a different request');
        }
        return { item: clone(existing), durable: this.canPersist(), idempotent: true };
      }
      if (this.items.size >= MAX_GLOBAL_ITEMS) throw new Error('Global chat outbox limit reached');
      const sessionCount = [...this.items.values()].filter((candidate) => candidate.sessionKey === item.sessionKey).length;
      if (sessionCount >= MAX_SESSION_ITEMS) throw new Error('Session chat outbox limit reached');
      this.items.set(item.id, item);
      try {
        await this.persist();
      } catch (error) {
        this.items.delete(item.id);
        throw error;
      }
      return { item: clone(item), durable: this.canPersist(), idempotent: false };
    });
  }

  /** Return recoverable items and remove expired or invalid attachment entries. */
  async list(sessionKey?: string): Promise<ChatSendOutboxListResult> {
    return this.withMutation(async () => {
      const rejected: ChatSendOutboxRejectedItem[] = [];
      const items: ChatSendOutboxItem[] = [];
      let changed = await this.cleanupReleasedAttachments();
      for (const [id, item] of this.items) {
        if (sessionKey && item.sessionKey !== sessionKey) continue;
        const rejection = await this.recoveryRejection(item);
        if (rejection) {
          rejected.push({ ...clone(item), error: rejection });
          this.releaseOwnedAttachments(item, 0);
          this.items.delete(id);
          changed = true;
          continue;
        }
        items.push(clone(item));
      }
      if (changed) {
        await this.cleanupReleasedAttachments();
        await this.persist();
      }
      items.sort((left, right) => left.acceptedAt - right.acceptedAt);
      rejected.sort((left, right) => left.acceptedAt - right.acceptedAt);
      return { durable: this.canPersist(), items, rejected };
    });
  }

  /** Acknowledge a successfully accepted Gateway send. */
  async acknowledge(id: string): Promise<boolean> {
    return this.remove(id, DISPATCHED_ATTACHMENT_LEASE_MS);
  }

  /** Cancel one pending intent before dispatch. */
  async cancel(id: string): Promise<boolean> {
    return this.remove(id, 0);
  }

  /** Remove every pending intent owned by a deleted session. */
  async cancelSession(sessionKey: string): Promise<number> {
    return this.withMutation(async () => {
      let removed = 0;
      for (const [id, item] of this.items) {
        if (item.sessionKey !== sessionKey) continue;
        this.releaseOwnedAttachments(item, 0);
        this.items.delete(id);
        removed += 1;
      }
      if (removed > 0) {
        await this.cleanupReleasedAttachments();
        await this.persist();
      }
      return removed;
    });
  }

  private async remove(id: string, attachmentLeaseMs: number): Promise<boolean> {
    return this.withMutation(async () => {
      const item = this.items.get(id);
      if (!item) return false;
      this.releaseOwnedAttachments(item, attachmentLeaseMs);
      this.items.delete(id);
      await this.cleanupReleasedAttachments();
      await this.persist();
      return true;
    });
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    const previous = this.mutationTail;
    let release = () => {};
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
  }

  private canPersist(): boolean {
    try {
      return this.encryption.isAvailable();
    } catch {
      return false;
    }
  }

  private normalizeItem(input: ChatSendOutboxItem): ChatSendOutboxItem {
    const now = this.now();
    if (input?.version !== CHAT_SEND_OUTBOX_SCHEMA_VERSION) throw new Error('Unsupported outbox item version');
    const acceptedAt = Number(input?.acceptedAt);
    const requestedExpiry = Number(input?.expiresAt);
    if (!Number.isFinite(acceptedAt) || acceptedAt <= 0) throw new Error('acceptedAt is invalid');
    if (acceptedAt > now + 5 * 60_000) throw new Error('acceptedAt is too far in the future');
    const expiresAt = Number.isFinite(requestedExpiry)
      ? Math.min(Math.floor(requestedExpiry), acceptedAt + MAX_TTL_MS)
      : acceptedAt + DEFAULT_TTL_MS;
    if (expiresAt <= now) throw new Error('Outbox item is already expired');
    const text = typeof input?.text === 'string' ? input.text : '';
    if (utf8Bytes(text) > MAX_PROMPT_BYTES) throw new Error('Outbox prompt is too large');
    const attachments = (Array.isArray(input?.attachments) ? input.attachments : []).map(normalizeAttachment);
    const referenceImages = (Array.isArray(input?.referenceImages) ? input.referenceImages : []).map(normalizeAttachment);
    if (attachments.length + referenceImages.length > MAX_ATTACHMENTS) throw new Error('Outbox attachment limit reached');
    if (utf8Bytes(JSON.stringify([...attachments, ...referenceImages])) > MAX_ATTACHMENT_METADATA_BYTES) {
      throw new Error('Outbox attachment metadata is too large');
    }
    const mode = input?.mode === 'image' || input?.mode === 'video' ? input.mode : 'chat';
    const id = normalizedString(input?.id, 'id');
    const idempotencyKey = normalizedString(input?.idempotencyKey, 'idempotencyKey');
    if (id !== idempotencyKey) throw new Error('Outbox id must equal its idempotency key');
    const imageOptions = input?.imageOptions ? {
      model: optionalString(input.imageOptions.model, 256),
      size: normalizedString(input.imageOptions.size, 'imageOptions.size', 128),
      quality: normalizedString(input.imageOptions.quality, 'imageOptions.quality', 64),
    } : undefined;
    const videoDuration = Number(input?.videoOptions?.durationSeconds);
    const videoOptions = input?.videoOptions ? {
      model: optionalString(input.videoOptions.model, 256),
      size: normalizedString(input.videoOptions.size, 'videoOptions.size', 128),
      durationSeconds: Number.isFinite(videoDuration)
        ? Math.max(1, Math.min(600, Math.floor(videoDuration)))
        : 1,
    } : undefined;
    return {
      version: CHAT_SEND_OUTBOX_SCHEMA_VERSION,
      id,
      sessionKey: normalizedString(input?.sessionKey, 'sessionKey'),
      turnId: normalizedString(input?.turnId, 'turnId'),
      idempotencyKey,
      userMessageId: normalizedString(input?.userMessageId, 'userMessageId'),
      acceptedAt: Math.floor(acceptedAt),
      expiresAt,
      text,
      targetAgentId: optionalString(input?.targetAgentId),
      mode,
      imageOptions,
      videoOptions,
      thinkingLevel: optionalString(input?.thinkingLevel, 256),
      attachments,
      referenceImages,
    };
  }

  private async recoveryRejection(item: ChatSendOutboxItem): Promise<string | null> {
    if (item.expiresAt <= this.now()) return 'Queued send expired before it could be restored.';
    const approvedRealRoots = await Promise.all(this.approvedAttachmentRoots.map(async (root) => (
      fs.realpath(root).catch(() => root)
    )));
    for (const attachment of [...item.attachments, ...item.referenceImages]) {
      const absolutePath = path.resolve(attachment.stagedPath);
      if (!this.approvedAttachmentRoots.some((root) => isPathInside(absolutePath, root))) {
        return `Queued attachment is outside an approved staging directory: ${attachment.fileName}`;
      }
      try {
        const realPath = await fs.realpath(absolutePath);
        if (!approvedRealRoots.some((root) => isPathInside(realPath, root))) {
          return `Queued attachment resolves outside an approved staging directory: ${attachment.fileName}`;
        }
        const stat = await fs.stat(realPath);
        if (!stat.isFile() || stat.size <= 0) return `Queued attachment is unavailable: ${attachment.fileName}`;
      } catch {
        return `Queued attachment is unavailable: ${attachment.fileName}`;
      }
    }
    return null;
  }

  private async load(): Promise<void> {
    if (!this.canPersist()) return;
    const target = this.storagePath();
    try {
      const envelope = JSON.parse(await fs.readFile(target, 'utf8')) as EncryptedEnvelope;
      if (envelope?.schema !== OUTBOX_ENVELOPE_SCHEMA || typeof envelope.ciphertext !== 'string') {
        throw new Error('Unsupported chat outbox envelope');
      }
      const plaintext = this.encryption.decrypt(Buffer.from(envelope.ciphertext, 'base64'));
      const stored = JSON.parse(plaintext) as PersistedOutbox;
      if (stored?.version !== CHAT_SEND_OUTBOX_SCHEMA_VERSION || !Array.isArray(stored.items)) {
        throw new Error('Unsupported chat outbox payload');
      }
      for (const candidate of stored.items.slice(0, MAX_GLOBAL_ITEMS)) {
        try {
          const item = this.normalizeItem(candidate);
          this.items.set(item.id, item);
        } catch {
          // Invalid entries are isolated without discarding valid siblings.
        }
      }
      for (const lease of (stored.releasedAttachments ?? []).slice(0, MAX_RELEASED_ATTACHMENT_LEASES)) {
        if (typeof lease?.stagedPath !== 'string' || !Number.isFinite(lease.deleteAfter)) continue;
        this.releasedAttachments.set(path.resolve(lease.stagedPath), Math.floor(lease.deleteAfter));
      }
      const cleaned = await this.cleanupReleasedAttachments();
      if (cleaned) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      await this.quarantineCorruptFile(target);
    }
  }

  private async persist(): Promise<void> {
    if (!this.canPersist()) return;
    await fs.mkdir(this.rootDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const payload: PersistedOutbox = {
      version: CHAT_SEND_OUTBOX_SCHEMA_VERSION,
      items: [...this.items.values()],
      releasedAttachments: [...this.releasedAttachments.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(-MAX_RELEASED_ATTACHMENT_LEASES)
        .map(([stagedPath, deleteAfter]) => ({ stagedPath, deleteAfter })),
    };
    const ciphertext = this.encryption.encrypt(JSON.stringify(payload));
    const envelope: EncryptedEnvelope = {
      schema: OUTBOX_ENVELOPE_SCHEMA,
      ciphertext: ciphertext.toString('base64'),
    };
    const target = this.storagePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: PRIVATE_FILE_MODE });
    await fs.rename(temporary, target);
    await fs.chmod(target, PRIVATE_FILE_MODE).catch(() => undefined);
  }

  private storagePath(): string {
    return path.join(this.rootDir, 'outbox.enc.json');
  }

  private async quarantineCorruptFile(target: string): Promise<void> {
    const quarantine = `${target}.corrupt-${this.now()}-${randomUUID()}`;
    await fs.rename(target, quarantine).catch(() => undefined);
  }

  private releaseOwnedAttachments(item: ChatSendOutboxItem, delayMs: number): void {
    const deleteAfter = this.now() + Math.max(0, delayMs);
    for (const attachment of item.attachments) {
      const stagedPath = path.resolve(attachment.stagedPath);
      if (!this.ownedStagingRoots.some((root) => isPathInside(stagedPath, root))) continue;
      const existing = this.releasedAttachments.get(stagedPath) ?? 0;
      this.releasedAttachments.set(stagedPath, Math.max(existing, deleteAfter));
    }
  }

  private async cleanupReleasedAttachments(): Promise<boolean> {
    const now = this.now();
    const ownedRealRoots = await Promise.all(this.ownedStagingRoots.map(async (root) => (
      fs.realpath(root).catch(() => root)
    )));
    let changed = false;
    for (const [stagedPath, deleteAfter] of this.releasedAttachments) {
      if (deleteAfter > now) continue;
      try {
        const realPath = await fs.realpath(stagedPath);
        if (ownedRealRoots.some((root) => isPathInside(realPath, root))) {
          const stat = await fs.stat(realPath);
          if (stat.isFile()) await fs.unlink(stagedPath);
        }
      } catch {
        // Missing files already satisfy cleanup.
      }
      this.releasedAttachments.delete(stagedPath);
      changed = true;
    }
    return changed;
  }
}

export const chatSendOutboxService = new ChatSendOutboxService();
