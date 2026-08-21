// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Chat long-term rule undo result handling', () => {
  it('does not report success when Main returns a disabled mutation result', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/Chat/index.tsx'), 'utf8');
    const undoStart = source.indexOf('void hostApi.longTermRules.undo({');
    const undoEnd = source.indexOf('.catch(() => toast.error', undoStart);
    const undoHandler = source.slice(undoStart, undoEnd);

    expect(undoStart).toBeGreaterThan(-1);
    expect(undoHandler).toContain('if (result.disabled === true)');
    expect(undoHandler).toContain("toast.error(t('longTermRules.undoFailed'))");
    expect(undoHandler.indexOf('result.disabled === true')).toBeLessThan(
      undoHandler.indexOf("toast.success(t('longTermRules.undone'))"),
    );
    expect(undoHandler).not.toContain(".then(() => toast.success(t('longTermRules.undone')))");
  });
});
