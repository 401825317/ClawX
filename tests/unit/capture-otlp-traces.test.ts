import { describe, expect, it } from 'vitest';
import {
  decodeOtlpTraceRequest,
  encodeOtlpTraceRequestForTest,
} from '../../scripts/diagnostics/capture-otlp-traces.mjs';

describe('OTLP trace capture', () => {
  it('decodes trace identity, timing, and bounded attributes', () => {
    const payload = encodeOtlpTraceRequestForTest({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'openclaw-gateway' } },
            { key: 'process.command_args', value: { arrayValue: { values: [{ stringValue: '--token' }, { stringValue: 'secret' }] } } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'openclaw', version: '2026.6.10' },
          spans: [{
            traceId: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
            spanId: Buffer.from('0011223344556677', 'hex'),
            parentSpanId: Buffer.from('8899aabbccddeeff', 'hex'),
            name: 'openclaw.model.call',
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '1750000000',
            attributes: [
              { key: 'openclaw.model_call.time_to_first_byte_ms', value: { intValue: 321 } },
              { key: 'openclaw.model', value: { stringValue: 'smart-latest' } },
            ],
          }],
        }],
      }],
    });

    expect(decodeOtlpTraceRequest(payload)).toEqual([expect.objectContaining({
      traceId: '00112233445566778899aabbccddeeff',
      spanId: '0011223344556677',
      parentSpanId: '8899aabbccddeeff',
      name: 'openclaw.model.call',
      durationMs: 750,
      resource: { 'service.name': 'openclaw-gateway' },
      scope: { name: 'openclaw', version: '2026.6.10' },
      attributes: {
        'openclaw.model_call.time_to_first_byte_ms': 321,
        'openclaw.model': 'smart-latest',
      },
    })]);
  });
});
