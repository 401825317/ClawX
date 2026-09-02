// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wrapper = readFileSync(
  resolve(process.cwd(), 'resources/cli/posix/openclaw'),
  'utf8',
);

describe('OpenClaw POSIX wrapper', () => {
  it('derives the macOS executable from the containing app bundle', () => {
    expect(wrapper).toContain('APP_BUNDLE_NAME="$(basename "$APP_BUNDLE_DIR")"');
    expect(wrapper).toContain('APP_EXECUTABLE="${APP_BUNDLE_NAME%.*}"');
    expect(wrapper).toContain('APP_EXECUTABLE="UClaw"');
    expect(wrapper).toContain('ELECTRON="$CONTENTS_DIR/MacOS/$APP_EXECUTABLE"');
    expect(wrapper).not.toContain('$CONTENTS_DIR/MacOS/ClawX');
  });

  it('uses the current UClaw product identity', () => {
    expect(wrapper).toContain('managed by UClaw');
    expect(wrapper).toContain('OPENCLAW_EMBEDDED_IN="UClaw"');
    expect(wrapper).not.toContain('ClawX');
  });
});
