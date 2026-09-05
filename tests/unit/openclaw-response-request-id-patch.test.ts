// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const patchModulePath = resolve(repoRoot, 'scripts/openclaw-response-request-id-patch.mjs');
const tempRoots = new Set<string>();

const responseLifecycleSource = [
  '\t\tconst { data: openaiStream, response } = await client.responses.create(requestParams, buildResponsesRequestOptions(options)).withResponse();',
  '\t\tawait options?.onResponse?.({',
].join('\n');

const runtimeSource = `
function buildResponsesRequestOptions() {
\treturn {};
}
function headersToRecord() {
\treturn {};
}
async function processResponsesStream() {}
async function runResponsesStreamLifecycle(params) {
\tconst { stream, model, output, options } = params;
\ttry {
\t\tconst client = params.createClient();
\t\tlet requestParams = params.buildParams();
\t\tconst nextParams = await options?.onPayload?.(requestParams, model);
\t\tif (nextParams !== void 0) requestParams = nextParams;
${responseLifecycleSource}
\t\t\tstatus: response.status,
\t\t\theaders: headersToRecord(response.headers)
\t\t}, model);
\t\tstream.push({ type: "start", partial: output });
\t\tawait processResponsesStream(openaiStream, output, stream, model);
\t\tstream.push({ type: "done", message: output });
\t\tstream.end();
\t} catch (error) {
\t\tthrow error;
\t}
}
export async function captureProviderRequestId(headerValues) {
\tconst headers = { get: (name) => headerValues[name] ?? null };
\tconst output = {};
\tawait runResponsesStreamLifecycle({
\t\tmodel: {},
\t\toptions: {},
\t\toutput,
\t\tstream: { push() {}, end() {} },
\t\tbuildParams: () => ({}),
\t\tcreateClient: () => ({
\t\t\tresponses: {
\t\t\t\tcreate: () => ({
\t\t\t\t\twithResponse: async () => ({ data: [], response: { status: 200, headers } }),
\t\t\t\t}),
\t\t\t},
\t\t}),
\t});
\treturn output.providerRequestId;
}
`;

interface RuntimeFixture {
  captureProviderRequestId: (headers: Record<string, string>) => Promise<string | undefined>;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function importPatchModule(): Promise<typeof import('../../scripts/openclaw-response-request-id-patch.mjs')> {
  const root = await createTempRoot('uclaw-response-id-module-');
  const modulePath = join(root, 'openclaw-response-request-id-patch.mjs');
  const source = (await readFile(patchModulePath, 'utf8')).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
  await writeFile(modulePath, source, 'utf8');
  return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function importFixture(source: string): Promise<RuntimeFixture> {
  const root = await createTempRoot('uclaw-response-id-fixture-');
  const fixturePath = join(root, 'runtime.mjs');
  await writeFile(fixturePath, source, 'utf8');
  return await import(`${pathToFileURL(fixturePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function writeRuntime(
  version = '2026.6.10',
  source = runtimeSource,
  fileName = 'openai-responses-shared-test.js',
): Promise<{ root: string; target: string }> {
  const root = await createTempRoot('uclaw-response-id-runtime-');
  const dist = join(root, 'dist');
  const target = join(dist, fileName);
  await mkdir(dist, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  await writeFile(target, source, 'utf8');
  return { root, target };
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe('OpenClaw 6.10 Responses request ID runtime patch', () => {
  it('persists the validated one-api request ID header and remains idempotent', async () => {
    expect(existsSync(patchModulePath)).toBe(true);
    const { rewriteResponseRequestIdPersistence } = await importPatchModule();
    const rewritten = rewriteResponseRequestIdPersistence(runtimeSource);

    expect(rewritten).toMatchObject({ replacements: 1, supported: true });
    expect(rewriteResponseRequestIdPersistence(rewritten.content)).toEqual({
      content: rewritten.content,
      replacements: 0,
      supported: true,
    });

    const runtime = await importFixture(rewritten.content);
    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': 'oneapi:req_01',
      'x-request-id': 'fallback-request',
      'request-id': 'last-request',
    })).resolves.toBe('oneapi:req_01');
    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': 'invalid/request',
      'x-request-id': 'fallback.request-02',
      'request-id': 'last-request',
    })).resolves.toBeUndefined();
  });

  it('rejects unsafe provider request ID values instead of persisting them', async () => {
    const { rewriteResponseRequestIdPersistence } = await importPatchModule();
    const rewritten = rewriteResponseRequestIdPersistence(runtimeSource);
    const runtime = await importFixture(rewritten.content);

    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': 'request with space',
      'x-request-id': 'valid-but-not-the-settled-log-id',
    })).resolves.toBeUndefined();
    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': ' leading-space',
    })).resolves.toBeUndefined();
    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': `r${'x'.repeat(64)}`,
    })).resolves.toBeUndefined();
    await expect(runtime.captureProviderRequestId({
      'x-oneapi-request-id': `r${'x'.repeat(63)}`,
    })).resolves.toBe(`r${'x'.repeat(63)}`);
    await expect(runtime.captureProviderRequestId({
      'x-request-id': 'fallback-is-not-the-settled-log-id',
    })).resolves.toBeUndefined();
  });

  it('safely upgrades the previous three-header patch layout', async () => {
    const { rewriteResponseRequestIdPersistence } = await importPatchModule();
    const legacyLines = [
      '\t\tconst providerRequestId = ["x-oneapi-request-id", "x-request-id", "request-id"]',
      '\t\t\t.map((headerName) => response.headers.get(headerName))',
      '\t\t\t.find((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value));',
      '\t\tif (providerRequestId) output.providerRequestId = providerRequestId;',
    ].join('\n');
    const legacyRuntime = runtimeSource.replace(
      responseLifecycleSource,
      responseLifecycleSource.replace(
        '\n\t\tawait options?.onResponse?.({',
        `\n${legacyLines}\n\t\tawait options?.onResponse?.({`,
      ),
    );

    const rewritten = rewriteResponseRequestIdPersistence(legacyRuntime);
    expect(rewritten).toMatchObject({ replacements: 1, supported: true });
    expect(rewritten.content).not.toContain('"x-request-id", "request-id"');
    expect(rewritten.content).toContain('response.headers.get("x-oneapi-request-id")');
    expect(rewritten.content).toContain('{0,63}');
  });

  it('removes trimming from the previous one-header patch layout', async () => {
    const { rewriteResponseRequestIdPersistence } = await importPatchModule();
    const trimmedLines = [
      '\t\tconst providerRequestId = response.headers.get("x-oneapi-request-id")?.trim();',
      '\t\tif (providerRequestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(providerRequestId)) output.providerRequestId = providerRequestId;',
    ].join('\n');
    const trimmedRuntime = runtimeSource.replace(
      responseLifecycleSource,
      responseLifecycleSource.replace(
        '\n\t\tawait options?.onResponse?.({',
        `\n${trimmedLines}\n\t\tawait options?.onResponse?.({`,
      ),
    );

    const rewritten = rewriteResponseRequestIdPersistence(trimmedRuntime);
    expect(rewritten).toMatchObject({ replacements: 1, supported: true });
    expect(rewritten.content).not.toContain('?.trim()');
  });

  it('patches exactly one supported runtime file and rejects other versions', async () => {
    const { patchOpenClawResponseRequestIdRuntime } = await importPatchModule();
    const runtime = await writeRuntime();

    await expect(patchOpenClawResponseRequestIdRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 1,
      filesScanned: 1,
    });
    await expect(readFile(runtime.target, 'utf8')).resolves.toContain(
      'output.providerRequestId = providerRequestId',
    );
    await expect(patchOpenClawResponseRequestIdRuntime(runtime.root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 1,
    });

    const unsupported = await writeRuntime('2026.6.11');
    await expect(patchOpenClawResponseRequestIdRuntime(unsupported.root)).rejects.toThrow(
      'Expected OpenClaw 2026.6.10',
    );
  });

  it('fails closed for unknown, partial, missing, and duplicate runtime layouts', async () => {
    const { patchOpenClawResponseRequestIdRuntime } = await importPatchModule();

    const unknown = await writeRuntime('2026.6.10', 'unknown runtime layout');
    await expect(patchOpenClawResponseRequestIdRuntime(unknown.root)).rejects.toThrow(
      'Unsupported OpenClaw Responses request ID layout',
    );

    const partial = await writeRuntime(
      '2026.6.10',
      `${runtimeSource}\noutput.providerRequestId = providerRequestId;`,
    );
    await expect(patchOpenClawResponseRequestIdRuntime(partial.root)).rejects.toThrow(
      'Unsupported partial OpenClaw Responses request ID patch layout',
    );

    const missing = await writeRuntime('2026.6.10', runtimeSource, 'other-runtime.js');
    await expect(patchOpenClawResponseRequestIdRuntime(missing.root)).rejects.toThrow(
      'Expected exactly one OpenClaw Responses runtime file, found 0',
    );

    const duplicate = await writeRuntime();
    await writeFile(
      join(duplicate.root, 'dist', 'openai-responses-shared-second.js'),
      runtimeSource,
      'utf8',
    );
    await expect(patchOpenClawResponseRequestIdRuntime(duplicate.root)).rejects.toThrow(
      'Expected exactly one OpenClaw Responses runtime file, found 2',
    );
  });

  it('runs during dependency installation and OpenClaw bundling', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(packageJson.devDependencies?.openclaw).toBe('2026.6.10');
    expect(packageJson.scripts.postinstall).toContain('openclaw-response-request-id-patch.mjs');
    expect(bundleScript).toContain(
      "import { patchOpenClawResponseRequestIdRuntime } from './openclaw-response-request-id-patch.mjs';",
    );
    expect(bundleScript).toContain('await patchOpenClawResponseRequestIdRuntime(OUTPUT)');
  });
});
