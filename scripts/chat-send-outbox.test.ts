import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHAT_SEND_OUTBOX_SCHEMA_VERSION, type ChatSendOutboxItem } from '../shared/chat-send-outbox';
import {
  ChatSendOutboxService,
  type ChatSendOutboxEncryption,
} from '../electron/services/chat-send-outbox';

const encryption: ChatSendOutboxEncryption = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').map((byte) => byte ^ 0xa5),
  decrypt: (ciphertext) => Buffer.from(ciphertext).map((byte) => byte ^ 0xa5).toString('utf8'),
};

async function fixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uclaw-chat-outbox-'));
  const mediaRoot = path.join(rootDir, 'media');
  await fs.mkdir(mediaRoot, { recursive: true });
  const stagedPath = path.join(mediaRoot, 'input.png');
  await fs.writeFile(stagedPath, Buffer.from('image'));
  return { rootDir, mediaRoot, stagedPath };
}

function item(stagedPath: string, overrides: Partial<ChatSendOutboxItem> = {}): ChatSendOutboxItem {
  const acceptedAt = 1_700_000_000_000;
  return {
    version: CHAT_SEND_OUTBOX_SCHEMA_VERSION,
    id: 'intent-1',
    sessionKey: 'agent:main:outbox-test',
    turnId: 'turn:outbox-test',
    idempotencyKey: 'intent-1',
    userMessageId: 'user:outbox-test',
    acceptedAt,
    expiresAt: acceptedAt + 60_000,
    text: 'Sensitive queued prompt',
    mode: 'image',
    imageOptions: { size: '1024x1024', quality: 'high' },
    attachments: [{
      fileName: 'input.png',
      mimeType: 'image/png',
      fileSize: 5,
      stagedPath,
    }],
    referenceImages: [],
    ...overrides,
  };
}

test('encrypted chat outbox survives restart without storing prompt plaintext', async () => {
  const files = await fixture();
  const options = {
    rootDir: path.join(files.rootDir, 'outbox'),
    approvedAttachmentRoots: [files.mediaRoot],
    encryption,
    now: () => 1_700_000_001_000,
  };
  try {
    const first = new ChatSendOutboxService(options);
    const queued = item(files.stagedPath);
    const result = await first.enqueue(queued);
    assert.equal(result.durable, true);

    const raw = await fs.readFile(path.join(options.rootDir, 'outbox.enc.json'), 'utf8');
    assert.equal(raw.includes(queued.text), false);

    const restored = await new ChatSendOutboxService(options).list();
    assert.deepEqual(restored.items, [result.item]);
    assert.deepEqual(restored.rejected, []);
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('chat outbox falls back to memory without writing plaintext when encryption is unavailable', async () => {
  const files = await fixture();
  const rootDir = path.join(files.rootDir, 'outbox');
  const service = new ChatSendOutboxService({
    rootDir,
    approvedAttachmentRoots: [files.mediaRoot],
    encryption: { ...encryption, isAvailable: () => false },
    now: () => 1_700_000_001_000,
  });
  try {
    const result = await service.enqueue(item(files.stagedPath));
    assert.equal(result.durable, false);
    assert.equal((await service.list()).items.length, 1);
    await assert.rejects(fs.stat(path.join(rootDir, 'outbox.enc.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('chat outbox rolls back Main memory when encrypted persistence fails', async () => {
  const files = await fixture();
  const service = new ChatSendOutboxService({
    rootDir: path.join(files.rootDir, 'outbox'),
    approvedAttachmentRoots: [files.mediaRoot],
    encryption: {
      ...encryption,
      encrypt: () => { throw new Error('fixture encryption failure'); },
    },
    now: () => 1_700_000_001_000,
  });
  try {
    await assert.rejects(service.enqueue(item(files.stagedPath)), /fixture encryption failure/u);
    assert.deepEqual((await service.list()).items, []);
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('chat outbox rejects idempotency conflicts and enforces the per-session cap', async () => {
  const files = await fixture();
  const service = new ChatSendOutboxService({
    rootDir: path.join(files.rootDir, 'outbox'),
    approvedAttachmentRoots: [files.mediaRoot],
    encryption,
    now: () => 1_700_000_001_000,
  });
  try {
    const original = item(files.stagedPath);
    assert.equal((await service.enqueue(original)).idempotent, false);
    assert.equal((await service.enqueue(original)).idempotent, true);
    await assert.rejects(service.enqueue({ ...original, text: 'Different prompt' }), /different request/u);

    for (let index = 2; index <= 20; index += 1) {
      await service.enqueue(item(files.stagedPath, {
        id: `intent-${index}`,
        idempotencyKey: `intent-${index}`,
        turnId: `turn:${index}`,
        userMessageId: `user:${index}`,
      }));
    }
    await assert.rejects(service.enqueue(item(files.stagedPath, {
      id: 'intent-21',
      idempotencyKey: 'intent-21',
      turnId: 'turn:21',
      userMessageId: 'user:21',
    })), /Session chat outbox limit/u);
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('recovery removes expired, missing, and escaped attachments with explicit errors', async () => {
  const files = await fixture();
  let now = 1_700_000_001_000;
  const service = new ChatSendOutboxService({
    rootDir: path.join(files.rootDir, 'outbox'),
    approvedAttachmentRoots: [files.mediaRoot],
    encryption,
    now: () => now,
  });
  try {
    await service.enqueue(item(files.stagedPath));
    await fs.rm(files.stagedPath);
    const missing = await service.list();
    assert.equal(missing.items.length, 0);
    assert.match(missing.rejected[0].error, /unavailable/u);

    const outsidePath = path.join(files.rootDir, 'outside.txt');
    await fs.writeFile(outsidePath, 'outside');
    await service.enqueue(item(outsidePath, {
      id: 'intent-outside',
      idempotencyKey: 'intent-outside',
      turnId: 'turn:outside',
      userMessageId: 'user:outside',
      attachments: [{ fileName: 'outside.txt', mimeType: 'text/plain', fileSize: 7, stagedPath: outsidePath }],
    }));
    const escaped = await service.list();
    assert.match(escaped.rejected[0].error, /outside an approved/u);

    const replacement = path.join(files.mediaRoot, 'replacement.png');
    await fs.writeFile(replacement, 'replacement');
    await service.enqueue(item(replacement, {
      id: 'intent-expired',
      idempotencyKey: 'intent-expired',
      turnId: 'turn:expired',
      userMessageId: 'user:expired',
      attachments: [{ fileName: 'replacement.png', mimeType: 'image/png', fileSize: 11, stagedPath: replacement }],
    }));
    now = 1_700_000_100_000;
    const expired = await service.list();
    assert.match(expired.rejected[0].error, /expired/u);
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('corrupt encrypted outbox is quarantined without blocking a clean start', async () => {
  const files = await fixture();
  const rootDir = path.join(files.rootDir, 'outbox');
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, 'outbox.enc.json'), '{broken');
  try {
    const service = new ChatSendOutboxService({
      rootDir,
      approvedAttachmentRoots: [files.mediaRoot],
      encryption,
      now: () => 1_700_000_001_000,
    });
    assert.deepEqual((await service.list()).items, []);
    const names = await fs.readdir(rootDir);
    assert.equal(names.some((name) => name.startsWith('outbox.enc.json.corrupt-')), true);
  } finally {
    await fs.rm(files.rootDir, { recursive: true, force: true });
  }
});

test('dispatched attachments use a durable cleanup lease while cancelled attachments are removed immediately', async () => {
  const dispatched = await fixture();
  let now = 1_700_000_001_000;
  const options = {
    rootDir: path.join(dispatched.rootDir, 'outbox'),
    approvedAttachmentRoots: [dispatched.mediaRoot],
    ownedStagingRoots: [dispatched.mediaRoot],
    encryption,
    now: () => now,
  };
  try {
    const service = new ChatSendOutboxService(options);
    await service.enqueue(item(dispatched.stagedPath));
    assert.equal(await service.acknowledge('intent-1'), true);
    assert.equal((await fs.stat(dispatched.stagedPath)).isFile(), true);

    now += 24 * 60 * 60 * 1_000 + 1;
    await new ChatSendOutboxService(options).list();
    await assert.rejects(fs.stat(dispatched.stagedPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(dispatched.rootDir, { recursive: true, force: true });
  }

  const cancelled = await fixture();
  try {
    const service = new ChatSendOutboxService({
      rootDir: path.join(cancelled.rootDir, 'outbox'),
      approvedAttachmentRoots: [cancelled.mediaRoot],
      ownedStagingRoots: [cancelled.mediaRoot],
      encryption,
      now: () => 1_700_000_001_000,
    });
    await service.enqueue(item(cancelled.stagedPath));
    assert.equal(await service.cancel('intent-1'), true);
    await assert.rejects(fs.stat(cancelled.stagedPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(cancelled.rootDir, { recursive: true, force: true });
  }
});
