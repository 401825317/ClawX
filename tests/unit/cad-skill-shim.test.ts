// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CAD skill contract', () => {
  it('publishes the same strict CAD contract from the shim and active plugin', () => {
    const shim = readFileSync(resolve(process.cwd(), 'resources/openclaw-skill-shims/cad-editor/SKILL.md'), 'utf8');
    const pluginSkill = readFileSync(resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/skills/cad-editor/SKILL.md'), 'utf8');

    expect(pluginSkill).toBe(shim);
    expect(shim).toContain('必须调用 `create_dxf_file`');
    expect(shim).toContain('不得冒充 CAD 图纸或替代 DXF');
    expect(shim).toContain('DXF 是必交付物');
    expect(shim).toContain('不得创建伪造的 `.dwg`');
    expect(shim).toContain('verification.status=passed');
    expect(shim).toContain('BOUNDARY');
    expect(shim).toContain('WALLS');
    expect(shim).toContain('DOORS');
    expect(shim).toContain('WINDOWS');
    expect(shim).toContain('STAIRS');
    expect(shim).toContain('DIMENSIONS');
    expect(shim).toContain('ANNOTATIONS');
    expect(shim).toContain('uv run --with ezdxf python');
    expect(shim).toContain('禁止使用裸 `python` 或 `pip`');
    expect(shim).toContain('MEDIA:<absolute-path-to-file.dxf>');
  });
});
