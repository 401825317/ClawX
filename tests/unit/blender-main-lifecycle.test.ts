// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Blender bridge application wiring', () => {
  it('injects only the active bridge endpoint into the Gateway child environment', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'electron/gateway/config-sync.ts'),
      'utf8',
    );

    expect(source).toContain("import { getBlenderBridgeEnvironment } from '../services/blender/bridge-server'");
    expect(source).toContain('delete inheritedEnv.CLAWX_HOST_API_ORIGIN');
    expect(source).toContain('delete inheritedEnv.CLAWX_HOST_API_TOKEN');
    expect(source).toContain('...getBlenderBridgeEnvironment()');
  });

  it('starts the bridge before Gateway auto-start and stops it in normal and emergency shutdown', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'electron/main/index.ts'),
      'utf8',
    );
    const bridgeStart = source.indexOf('await startBlenderBridgeServer()');
    const gatewayStart = source.indexOf('await gatewayManager.start()');
    const beforeQuit = source.indexOf("app.on('before-quit'");
    const bridgeStop = source.indexOf('stopBlenderBridgeServer()', beforeQuit);
    const emergencyCleanup = source.indexOf('const emergencyGatewayCleanup');
    const emergencyBridgeStop = source.indexOf('stopBlenderBridgeServer()', emergencyCleanup);

    expect(bridgeStart).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(bridgeStart);
    expect(bridgeStop).toBeGreaterThan(beforeQuit);
    expect(emergencyBridgeStop).toBeGreaterThan(emergencyCleanup);
  });
});
