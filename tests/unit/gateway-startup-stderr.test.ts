import { describe, expect, it } from 'vitest';
import {
  classifyGatewayStderrMessage,
  classifyGatewayStdoutMessage,
} from '../../electron/gateway/startup-stderr';

describe('classifyGatewayStderrMessage', () => {
  it('keeps model fetch diagnostics at info level', () => {
    expect(classifyGatewayStderrMessage('[diagnostic] model.fetch.request {"requestId":"mf-1","toolsCount":3}')).toEqual({
      level: 'info',
      normalized: '[diagnostic] model.fetch.request {"requestId":"mf-1","toolsCount":3}',
    });
  });

  it('keeps gateway fetch preload readiness diagnostics at info level', () => {
    expect(classifyGatewayStderrMessage('[diagnostic] gateway.fetch.preload.ready {"fetchAvailable":true,"patched":true}')).toEqual({
      level: 'info',
      normalized: '[diagnostic] gateway.fetch.preload.ready {"fetchAvailable":true,"patched":true}',
    });
  });
});

describe('classifyGatewayStdoutMessage', () => {
  it('keeps OpenClaw model transport lines at info level', () => {
    expect(classifyGatewayStdoutMessage('[provider-transport-fetch] [model-fetch] start provider=lingzhiwuxian')).toEqual({
      level: 'info',
      normalized: '[provider-transport-fetch] [model-fetch] start provider=lingzhiwuxian',
    });
  });

  it('downgrades generic Gateway stdout lines to debug', () => {
    expect(classifyGatewayStdoutMessage('[gateway] gateway ready')).toEqual({
      level: 'debug',
      normalized: '[gateway] gateway ready',
    });
  });
});
