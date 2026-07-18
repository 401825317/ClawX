import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_PATH = resolve(ROOT, 'resources/openclaw-plugins/clawx-openai-image/index.mjs');

async function loadProvider() {
  const plugin = (await import(`${pathToFileURL(PLUGIN_PATH).href}?test=${Date.now()}-${Math.random()}`)).default;
  let provider;
  plugin.register({
    registerImageGenerationProvider(value) {
      provider = value;
    },
  });
  assert.ok(provider);
  return provider;
}

async function listenCaptureServer(responseBody) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      headers: req.headers,
      method: req.method,
      path: req.url,
      body: Buffer.concat(chunks),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    }),
  };
}

function providerConfig(baseUrl) {
  return {
    models: {
      providers: {
        'clawx-openai-image': {
          apiKey: 'test-key',
          baseUrl,
        },
      },
    },
  };
}

function multipartTextFields(request) {
  const contentType = String(request.headers['content-type'] || '');
  const boundary = contentType.match(/boundary=([^;]+)/u)?.[1];
  assert.ok(boundary, 'multipart boundary is present');
  const fields = {};
  for (const part of request.body.toString('latin1').split(`--${boundary}`)) {
    const match = part.match(/Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n$/u);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

test('declares the OpenAI output formats and backgrounds that the provider forwards', async () => {
  const provider = await loadProvider();
  assert.deepEqual(provider.capabilities.output.formats, ['png', 'jpeg', 'webp']);
  assert.deepEqual(provider.capabilities.output.backgrounds, ['transparent', 'opaque', 'auto']);
  assert.equal(provider.capabilities.generate.supportsAspectRatio, true);
  assert.ok(provider.capabilities.geometry.aspectRatios.includes('9:16'));
});

test('generation forwards OpenAI image options and labels JPEG base64 output correctly', async () => {
  const upstream = await listenCaptureServer({
    data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }],
  });
  try {
    const provider = await loadProvider();
    const result = await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'grand opening poster',
      model: 'gpt-image-2',
      count: 1,
      size: '2160x3840',
      quality: 'high',
      outputFormat: 'jpeg',
      background: 'auto',
      providerOptions: {
        openai: {
          background: 'opaque',
          moderation: 'low',
          outputCompression: 61,
          user: 'uclaw-test-user',
        },
      },
    });

    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].path, '/v1/images/generations');
    assert.deepEqual(JSON.parse(upstream.requests[0].body.toString('utf8')), {
      model: 'gpt-image-2',
      prompt: 'grand opening poster',
      n: 1,
      size: '2160x3840',
      quality: 'high',
      output_format: 'jpeg',
      background: 'opaque',
      moderation: 'low',
      output_compression: 61,
      user: 'uclaw-test-user',
    });
    assert.equal(result.images[0].mimeType, 'image/jpeg');
    assert.match(result.images[0].fileName, /\.jpg$/u);
  } finally {
    await upstream.close();
  }
});

test('generation ignores non-default image model overrides', async () => {
  const upstream = await listenCaptureServer({ data: [] });
  try {
    const provider = await loadProvider();
    await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'locked model request',
      model: 'legacy-image-model',
    });

    assert.equal(upstream.requests.length, 1);
    assert.equal(JSON.parse(upstream.requests[0].body.toString('utf8')).model, 'gpt-image-2');
  } finally {
    await upstream.close();
  }
});

test('editing forwards OpenAI image options as multipart fields', async () => {
  const upstream = await listenCaptureServer({
    data: [{
      b64_json: Buffer.from('RIFFxxxxWEBP', 'ascii').toString('base64'),
      mime_type: 'image/webp',
    }],
  });
  try {
    const provider = await loadProvider();
    await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'edit the poster',
      model: 'gpt-image-2',
      count: 2,
      size: '1024x1536',
      quality: 'medium',
      outputFormat: 'webp',
      background: 'transparent',
      providerOptions: {
        openai: {
          moderation: 'auto',
          outputCompression: 72,
          user: 'uclaw-edit-user',
        },
      },
      inputImages: [{
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: 'image/png',
        fileName: 'reference.png',
      }],
    });

    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].path, '/v1/images/edits');
    assert.deepEqual(multipartTextFields(upstream.requests[0]), {
      model: 'gpt-image-2',
      prompt: 'edit the poster',
      n: '2',
      size: '1024x1536',
      quality: 'medium',
      output_format: 'webp',
      background: 'transparent',
      moderation: 'auto',
      output_compression: '72',
      user: 'uclaw-edit-user',
    });
    assert.match(upstream.requests[0].body.toString('latin1'), /name="image"; filename="reference\.png"/u);
  } finally {
    await upstream.close();
  }
});

test('uses the actual image signature when the upstream ignores the requested format', async () => {
  const upstream = await listenCaptureServer({
    data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
  });
  try {
    const provider = await loadProvider();
    const result = await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'provider format mismatch',
      model: 'gpt-image-2',
      outputFormat: 'jpeg',
    });
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.match(result.images[0].fileName, /\.png$/u);
  } finally {
    await upstream.close();
  }
});

test('uses the actual PNG signature even when upstream falsely declares JPEG', async () => {
  const upstream = await listenCaptureServer({
    data: [{
      b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
      mime_type: 'image/jpeg',
    }],
  });
  try {
    const provider = await loadProvider();
    const result = await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'lying upstream mime type',
      model: 'gpt-image-2',
      outputFormat: 'jpeg',
    });
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.match(result.images[0].fileName, /\.png$/u);
  } finally {
    await upstream.close();
  }
});

test('explicit aspect ratio wins when the model also supplies a conflicting size', async () => {
  const upstream = await listenCaptureServer({ data: [] });
  try {
    const provider = await loadProvider();
    await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'strict vertical poster',
      model: 'gpt-image-2',
      size: '1024x1536',
      aspectRatio: '9:16',
      outputFormat: 'jpeg',
    });
    assert.equal(JSON.parse(upstream.requests[0].body.toString('utf8')).size, '2160x3840');
  } finally {
    await upstream.close();
  }
});

test('keeps PNG requests backward compatible and omits unsupported compression', async () => {
  const upstream = await listenCaptureServer({ data: [] });
  try {
    const provider = await loadProvider();
    await provider.generateImage({
      cfg: providerConfig(upstream.baseUrl),
      prompt: 'legacy request',
      model: 'gpt-image-2',
      providerOptions: { openai: { outputCompression: 50 } },
    });
    assert.deepEqual(JSON.parse(upstream.requests[0].body.toString('utf8')), {
      model: 'gpt-image-2',
      prompt: 'legacy request',
      n: 1,
      size: '1024x1024',
    });
  } finally {
    await upstream.close();
  }
});
