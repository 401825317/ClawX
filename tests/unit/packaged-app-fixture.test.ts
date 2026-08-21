// @vitest-environment node

import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { waitForCdp } from '../packaged-e2e/fixtures/packaged-app';

const REDACTED_PATH = '[path-redacted]';

function exitedChild(exitCode: number): ChildProcess {
  return {
    exitCode,
    signalCode: null,
  } as ChildProcess;
}

describe('packaged app startup diagnostics', () => {
  it('includes only a bounded, credential-safe and path-safe output tail on early exit', async () => {
    const bearer = 'bearer-secret-value';
    const cookie = 'session=cookie-secret-value';
    const password = 'password-secret-value';
    const apiKey = 'plain-api-key-secret-value';
    const jsonAuthorization = 'json-authorization-secret-value';
    const jsonCookie = 'json-cookie-secret-value';
    const providerToken = 'sk-provider-secret-12345678';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature12345678';
    const oldLines = Array.from({ length: 30 }, (_, index) => `old-startup-line-${index}-${'x'.repeat(80)}`);
    const output = {
      stdout: [
        `${oldLines.join('\n')}\n`,
        `Authorization: Bearer ${bearer}\n`,
        `Cookie: ${cookie}\n`,
        `provider api_key=${apiKey}\n`,
        `json={"headers":{"authorization":"${jsonAuthorization}","cookie":"${jsonCookie}"}}\n`,
        'config=C:\\Users\\Alice\\AppData\\Roaming\\UClaw\\openclaw.json\n',
        'bootstrap_dynamic_import_failed\n',
      ],
      stderr: [
        "Error: Cannot find module 'ms'\n",
        'Require stack:\n',
        "- 'F:\\Portable UClaw\\resources\\app.asar\\dist-electron\\main\\index.js'\n",
        `password=${password} token=${providerToken}\n`,
        `Proxy-Authorization: Basic ${bearer}\n`,
        `request=https://alice:url-password@example.test/v1?access_token=${apiKey}&home=/home/Bob/private.json#private\n`,
        `jwt=${jwt}\n`,
        'at \\\\fileserver\\private-share\\index.js:4:2\n',
        'at /home/alice/private/index.mjs:3:1 code=MODULE_NOT_FOUND\n',
      ],
    };

    const error = await waitForCdp(
      'http://127.0.0.1:9',
      exitedChild(1),
      output,
      25,
    ).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;

    expect(message).toContain('exit=1, signal=none');
    expect(message).toContain('[stdout tail]');
    expect(message).toContain('[stderr tail]');
    expect(message).toContain('bootstrap_dynamic_import_failed');
    expect(message).toContain("Cannot find module 'ms'");
    expect(message).toContain('MODULE_NOT_FOUND');
    expect(message).toContain(REDACTED_PATH);
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('old-startup-line-0');
    expect(message.length).toBeLessThan(4_500);

    for (const secret of [
      bearer,
      cookie,
      password,
      apiKey,
      jsonAuthorization,
      jsonCookie,
      providerToken,
      jwt,
      'Alice',
      'Portable UClaw',
      'fileserver',
      'private-share',
      '/home/alice',
      '/home/Bob',
      'url-password',
      '#private',
    ]) {
      expect(message).not.toContain(secret);
    }
  });
});
