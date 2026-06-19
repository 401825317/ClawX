import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension manifest', () => {
  it('enables both marketplace providers so SkillHub remains the default catalog', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'clawx-extensions.json'), 'utf-8')) as {
      extensions?: {
        main?: string[];
      };
    };

    expect(manifest.extensions?.main).toContain('builtin/clawhub-marketplace');
    expect(manifest.extensions?.main).toContain('builtin/skillhub-marketplace');
  });
});
