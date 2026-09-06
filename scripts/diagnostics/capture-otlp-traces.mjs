import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const TRACE_SCHEMA = String.raw`
syntax = "proto3";

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message Status { string message = 2; int32 code = 3; }

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  Status status = 15;
  fixed32 flags = 16;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`;

const root = protobuf.parse(TRACE_SCHEMA).root;
const ExportTraceServiceRequest = root.lookupType('ExportTraceServiceRequest');
const SAFE_RESOURCE_ATTRIBUTE_KEYS = new Set([
  'host.arch',
  'process.pid',
  'process.executable.name',
  'process.runtime.name',
  'process.runtime.version',
  'service.name',
]);

function longToBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof value.toString === 'function') return BigInt(value.toString());
  return 0n;
}

function bytesToHex(value) {
  if (!value) return '';
  return Buffer.from(value).toString('hex');
}

function decodeAnyValue(value) {
  if (!value) return null;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'boolValue')) return value.boolValue;
  if (Object.hasOwn(value, 'intValue')) return Number(value.intValue.toString());
  if (Object.hasOwn(value, 'doubleValue')) return value.doubleValue;
  if (Object.hasOwn(value, 'bytesValue')) return Buffer.from(value.bytesValue).toString('base64');
  if (Object.hasOwn(value, 'arrayValue')) return (value.arrayValue.values ?? []).map(decodeAnyValue);
  if (Object.hasOwn(value, 'kvlistValue')) return decodeAttributes(value.kvlistValue.values);
  return null;
}

function decodeAttributes(entries = [], allowedKeys) {
  return Object.fromEntries(entries
    .filter((entry) => !allowedKeys || allowedKeys.has(entry.key))
    .map((entry) => [entry.key, decodeAnyValue(entry.value)]));
}

export function decodeOtlpTraceRequest(payload) {
  const request = ExportTraceServiceRequest.decode(payload);
  const spans = [];
  for (const resourceSpans of request.resourceSpans ?? []) {
    const resource = decodeAttributes(resourceSpans.resource?.attributes, SAFE_RESOURCE_ATTRIBUTE_KEYS);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scope = {
        name: scopeSpans.scope?.name ?? '',
        version: scopeSpans.scope?.version ?? '',
      };
      for (const span of scopeSpans.spans ?? []) {
        const startTimeUnixNano = longToBigInt(span.startTimeUnixNano);
        const endTimeUnixNano = longToBigInt(span.endTimeUnixNano);
        spans.push({
          traceId: bytesToHex(span.traceId),
          spanId: bytesToHex(span.spanId),
          parentSpanId: bytesToHex(span.parentSpanId),
          name: span.name ?? '',
          kind: span.kind ?? 0,
          startTimeUnixNano: startTimeUnixNano.toString(),
          endTimeUnixNano: endTimeUnixNano.toString(),
          durationMs: Number(endTimeUnixNano - startTimeUnixNano) / 1_000_000,
          status: {
            code: span.status?.code ?? 0,
            message: span.status?.message ?? '',
          },
          resource,
          scope,
          attributes: decodeAttributes(span.attributes),
        });
      }
    }
  }
  return spans;
}

export function encodeOtlpTraceRequestForTest(value) {
  const message = ExportTraceServiceRequest.fromObject(value);
  return ExportTraceServiceRequest.encode(message).finish();
}

function parseOptions(argv) {
  const read = (name, fallback) => {
    const prefix = `--${name}=`;
    return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  };
  return {
    host: read('host', '127.0.0.1'),
    port: Number(read('port', '4318')),
    output: path.resolve(read('output', '.codex/diagnostics/otel-spans.jsonl')),
  };
}

export async function startOtlpTraceCapture(options) {
  await mkdir(path.dirname(options.output), { recursive: true });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/traces') {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      totalBytes += chunk.length;
      if (totalBytes > 8 * 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }

    try {
      const receivedAt = new Date().toISOString();
      const spans = decodeOtlpTraceRequest(Buffer.concat(chunks));
      if (spans.length > 0) {
        const lines = spans.map((span) => JSON.stringify({ receivedAt, ...span })).join('\n');
        await appendFile(options.output, `${lines}\n`, 'utf8');
      }
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  const server = await startOtlpTraceCapture(options);
  const address = server.address();
  process.stdout.write(`[otel-capture] listening on http://${address.address}:${address.port}/v1/traces\n`);
  process.stdout.write(`[otel-capture] writing spans to ${options.output}\n`);
}
