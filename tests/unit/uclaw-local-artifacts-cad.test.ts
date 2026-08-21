// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cadModulePath = '../../resources/openclaw-plugins/uclaw-local-artifacts/cad-dxf.mjs';
const pluginModulePath = '../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs';

describe('uclaw-local-artifacts CAD delivery', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('writes a real multi-floor DXF and validates editable structure from disk', async () => {
    const cad = await import(cadModulePath);
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-cad-'));
    tempRoots.push(root);
    const filePath = path.join(root, 'villa.dxf');

    const result = await cad.writeValidatedDxf(filePath, {
      title: 'Three-floor villa',
      unit: 'm',
      width: 12,
      depth: 15,
      floors: 3,
    });

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toMatch(/\n0\nEOF\n$/u);
    expect(content).toContain('9\n$ACADVER\n1\nAC1009\n');
    expect(content).toContain('0\nPOLYLINE\n8\nBOUNDARY\n');
    expect(content).toContain('0\nVERTEX\n8\nBOUNDARY\n');
    expect(content).toContain('0\nSEQEND\n8\nBOUNDARY\n');
    expect(content).not.toContain('LWPOLYLINE');
    expect(result.verification).toMatchObject({
      ok: true,
      status: 'passed',
      kind: 'cad.structure',
      engine: 'uclaw-dxf-js/v1',
    });
    expect(result.verification.evidence).toMatchObject({
      editableFormat: 'DXF',
      pythonRuntime: 'not-required',
      unit: 'm',
      width: 12,
      depth: 15,
      floorCount: 3,
      boundaryCount: 3,
      dimensionCount: 6,
    });
    expect(result.verification.evidence.layers).toEqual(expect.arrayContaining([
      'BOUNDARY', 'WALLS', 'DOORS', 'WINDOWS', 'STAIRS', 'DIMENSIONS', 'ANNOTATIONS',
    ]));
    expect(result.verification.evidence.entityTypes).toMatchObject({
      LINE: expect.any(Number),
      POLYLINE: expect.any(Number),
      ARC: expect.any(Number),
      TEXT: expect.any(Number),
      DIMENSION: 6,
    });
  });

  it('blocks a CAD file whose window entities were removed after generation', async () => {
    const cad = await import(cadModulePath);
    const generated = cad.createDxfContent({ unit: 'mm', width: 10000, depth: 8000, floors: 1 });
    const damaged = generated.content.replaceAll('8\nWINDOWS\n', '8\nWALLS\n');

    const verification = cad.validateDxfContent(damaged, generated.plan);

    expect(verification.ok).toBe(false);
    expect(verification.status).toBe('blocked');
    expect(verification.issues).toContain('required layer has no entity: WINDOWS');
    expect(verification.issues).toContain('WINDOWS coverage is incomplete (0/4)');
  });

  it('rejects malformed or contradictory DXF structure instead of trusting layer counts', async () => {
    const cad = await import(cadModulePath);
    const generated = cad.createDxfContent({ unit: 'm', width: 12, depth: 15, floors: 1 });
    const wrongUnit = generated.content.replace(
      '9\n$INSUNITS\n70\n6\n',
      '9\n$INSUNITS\n70\n4\n',
    );
    const outsideWindows = generated.content.replace(
      /0\nLINE\n8\nWINDOWS\n10\n[^\n]+\n20\n[^\n]+\n30\n0\n11\n[^\n]+\n21\n[^\n]+\n31\n0\n/gu,
      '0\nLINE\n8\nWINDOWS\n10\n999\n20\n999\n30\n0\n11\n1000\n21\n1000\n31\n0\n',
    );

    expect(cad.validateDxfContent(`${generated.content}garbage`, generated.plan).issues)
      .toContain('DXF group-code/value pairs are incomplete');
    expect(cad.validateDxfContent(wrongUnit, generated.plan).issues)
      .toContain('DXF $INSUNITS does not match m');
    expect(cad.validateDxfContent(outsideWindows, generated.plan).issues)
      .toContain('WINDOWS geometry is outside every floor boundary');
  });

  it('supports the declared dimension-free DXF mode without weakening other structure checks', async () => {
    const cad = await import(cadModulePath);
    const generated = cad.createDxfContent({
      unit: 'm', width: 12, depth: 15, floors: 1, includeDimensions: false,
    });

    const verification = cad.validateDxfContent(generated.content, generated.plan);

    expect(verification).toMatchObject({ ok: true, status: 'passed' });
    expect(verification.evidence.dimensionCount).toBe(0);
    expect(verification.evidence.layers).toContain('DIMENSIONS');
  });

  it('rejects binary or structurally incomplete content instead of accepting a preview image as CAD', async () => {
    const cad = await import(cadModulePath);
    const pngHeader = '\u0089PNG\r\n\u001a\n\u0000not-a-dxf';
    const verification = cad.validateDxfContent(pngHeader, { width: 12, depth: 15, floors: 1 });

    expect(verification).toMatchObject({ ok: false, status: 'blocked' });
    expect(verification.issues).toEqual(expect.arrayContaining([
      'DXF EOF marker is missing',
      'required DXF section is missing: HEADER',
      'required DXF section is missing: ENTITIES',
    ]));
  });

  it('exposes create_dxf_file as the mandatory CAD route and returns the verified DXF artifact', async () => {
    const plugin = await import(pluginModulePath);
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-cad-tool-'));
    tempRoots.push(root);
    const tool = plugin.__test.createTools().find((candidate: { name: string }) => candidate.name === 'create_dxf_file');

    expect(tool).toBeDefined();
    expect(tool.description).toContain('mandatory');
    expect(tool.promptSnippet).toContain('Never use image_generate');
    const result = await tool.execute(
      'cad-call-1',
      { title: 'Editable layout', unit: 'm', width: 10, depth: 18, floors: 2 },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      kind: 'cad',
      editableFormat: 'DXF',
      schema: 'uclaw.cad.floor-plan/v1',
      plan: { unit: 'm', width: 10, depth: 18, floors: 2 },
      verification: { ok: true, status: 'passed' },
    });
    expect(result.details.filePath).toMatch(/\.dxf$/u);
    expect(existsSync(result.details.filePath)).toBe(true);
  });

  it('returns a stable recoverable error instead of silently changing invalid CAD dimensions', async () => {
    const plugin = await import(pluginModulePath);
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-cad-invalid-'));
    tempRoots.push(root);
    const tool = plugin.__test.createTools().find((candidate: { name: string }) => candidate.name === 'create_dxf_file');

    const result = await tool.execute(
      'cad-call-invalid',
      { unit: 'm', width: -12, depth: 15, floors: 1, filename: 'invalid' },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        status: 'error',
        code: 'cad_invalid_parameters',
        kind: 'cad',
        recoverable: true,
        restartGateway: false,
        stage: 'input',
        field: 'width',
        verification: { ok: false, status: 'blocked', kind: 'cad.structure' },
      },
    });
    expect(result.details).not.toHaveProperty('media');
    expect(existsSync(path.join(root, 'outputs', 'invalid.dxf'))).toBe(false);
  });

  it('returns the same structured error contract when output path preparation fails', async () => {
    const plugin = await import(pluginModulePath);
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-cad-output-error-'));
    tempRoots.push(root);
    const tool = plugin.__test.createTools().find((candidate: { name: string }) => candidate.name === 'create_dxf_file');

    const result = await tool.execute(
      'cad-call-output-error',
      { unit: 'm', width: 12, depth: 15, floors: 1, outputDir: '../outside' },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        status: 'error',
        code: 'cad_output_path_failed',
        kind: 'cad',
        recoverable: true,
        restartGateway: false,
        verification: { ok: false, status: 'blocked', kind: 'cad.structure' },
      },
    });
    expect(result.details).not.toHaveProperty('media');
  });

  it('never overwrites an existing DXF path during validated publication', async () => {
    const cad = await import(cadModulePath);
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-cad-no-clobber-'));
    tempRoots.push(root);
    const filePath = path.join(root, 'existing.dxf');
    writeFileSync(filePath, 'existing-content', 'utf8');

    await expect(cad.writeValidatedDxf(filePath, {
      unit: 'm', width: 12, depth: 15, floors: 1,
    })).rejects.toMatchObject({
      code: 'cad_output_exists',
      recoverable: true,
      restartGateway: false,
    });
    expect(readFileSync(filePath, 'utf8')).toBe('existing-content');
  });
});
