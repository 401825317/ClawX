import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const read = (name, fallback) => {
    const prefix = `--${name}=`;
    return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  };
  return {
    configPath: path.resolve(read('config', path.join(process.env.USERPROFILE ?? '', '.openclaw/openclaw.json'))),
    authDbPath: path.resolve(read('auth-db', path.join(process.env.USERPROFILE ?? '', '.openclaw/agents/main/agent/openclaw-agent.sqlite'))),
    input: read('input', 'hi'),
  };
}

function readApiKey(authDbPath) {
  const database = new DatabaseSync(authDbPath, { readOnly: true });
  try {
    const row = database.prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?').get('primary');
    const store = JSON.parse(row?.store_json ?? '{}');
    const profile = store.profiles?.['openai:default'];
    if (profile?.type !== 'api_key' || typeof profile.key !== 'string' || !profile.key) {
      throw new Error('openai:default API key profile is unavailable');
    }
    return profile.key;
  } finally {
    database.close();
  }
}

export function consumeSseText(state, text, elapsedMs) {
  state.buffer += text;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      state.eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = typeof payload.type === 'string' ? payload.type : state.eventName;
    state.eventTypes.add(type || 'unknown');
    state.firstEventMs ??= elapsedMs;
    if ((type === 'response.created' || type === 'response.completed')
      && typeof payload.response?.model === 'string'
      && /^[a-zA-Z0-9._:/-]{1,160}$/u.test(payload.response.model)) {
      state.responseModel = payload.response.model;
    }
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta.length > 0) {
      state.firstTextMs ??= elapsedMs;
    }
    if (type === 'response.completed') state.completedMs ??= elapsedMs;
  }
}

export async function probeResponses(options) {
  const config = JSON.parse(await readFile(options.configPath, 'utf8'));
  const provider = config.models?.providers?.openai;
  if (!provider?.baseUrl) throw new Error('OpenAI provider baseUrl is unavailable');
  const primary = config.agents?.defaults?.model?.primary ?? 'openai/smart-latest';
  const model = primary.includes('/') ? primary.slice(primary.indexOf('/') + 1) : primary;
  const key = readApiKey(options.authDbPath);
  const requestId = randomUUID();
  const requestBody = JSON.stringify({ model, input: options.input, stream: true });
  const startedAt = performance.now();
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      ...provider.headers,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-client-request-id': requestId,
    },
    body: requestBody,
  });
  const headersMs = performance.now() - startedAt;
  const state = {
    buffer: '',
    eventName: '',
    eventTypes: new Set(),
    firstByteMs: null,
    firstEventMs: null,
    firstTextMs: null,
    completedMs: null,
  };
  let responseBytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body ?? []) {
    const elapsedMs = performance.now() - startedAt;
    state.firstByteMs ??= elapsedMs;
    responseBytes += chunk.byteLength;
    consumeSseText(state, decoder.decode(chunk, { stream: true }), elapsedMs);
    if (state.completedMs != null) break;
  }

  return {
    requestId,
    status: response.status,
    ok: response.ok,
    model,
    responseModel: state.responseModel ?? null,
    requestBytes: Buffer.byteLength(requestBody),
    responseBytes,
    headersMs: Math.round(headersMs),
    firstByteMs: state.firstByteMs == null ? null : Math.round(state.firstByteMs),
    firstEventMs: state.firstEventMs == null ? null : Math.round(state.firstEventMs),
    firstTextMs: state.firstTextMs == null ? null : Math.round(state.firstTextMs),
    completedMs: state.completedMs == null ? null : Math.round(state.completedMs),
    eventTypes: [...state.eventTypes],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  const result = await probeResponses(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
