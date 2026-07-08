'use strict';

(function () {
  var _f = globalThis.fetch;
  function writeDiagnostic(label, payload) {
    try {
      process.stderr.write('[diagnostic] ' + label + ' ' + JSON.stringify(payload) + '\n');
    } catch (_) {
      // Ignore logging failures from the Gateway preload path.
    }
  }

  if (typeof _f !== 'function') {
    writeDiagnostic('gateway.fetch.preload.ready', {
      fetchAvailable: false,
      patched: false,
      reason: 'missing-fetch',
    });
    return;
  }
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;
  writeDiagnostic('gateway.fetch.preload.ready', {
    fetchAvailable: true,
    patched: true,
  });

  var MODEL_ENDPOINT_RE = /\/(?:v\d+\/)?(?:chat\/completions|responses|messages|completions)$/i;
  var MAX_RESPONSE_SAMPLE_BYTES = 96 * 1024;

  function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeJsonParse(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function getUrlString(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
    return '';
  }

  function parseUrl(rawUrl) {
    try {
      return new URL(rawUrl);
    } catch (_) {
      return null;
    }
  }

  function isModelEndpoint(rawUrl) {
    var parsed = parseUrl(rawUrl);
    if (!parsed) return false;
    return MODEL_ENDPOINT_RE.test(parsed.pathname);
  }

  function endpointLabel(rawUrl) {
    var parsed = parseUrl(rawUrl);
    if (!parsed) return 'unknown';
    return parsed.hostname + parsed.pathname;
  }

  function bodyFromInit(init) {
    if (!init || init.body == null) return null;
    if (typeof init.body === 'string') return init.body;
    if (Buffer.isBuffer(init.body)) return init.body.toString('utf8');
    if (init.body instanceof URLSearchParams) return init.body.toString();
    return null;
  }

  function readRequestBody(input, init) {
    var fromInit = bodyFromInit(init);
    if (fromInit != null) return Promise.resolve(fromInit);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        return input.clone().text();
      } catch (_) {
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(null);
  }

  function toolName(tool) {
    if (!isRecord(tool)) return null;
    if (typeof tool.name === 'string') return tool.name;
    if (isRecord(tool.function) && typeof tool.function.name === 'string') {
      return tool.function.name;
    }
    if (typeof tool.type === 'string') return tool.type;
    return null;
  }

  function summarizeToolChoice(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (!isRecord(value)) return typeof value;
    if (typeof value.type === 'string') {
      if (isRecord(value.function) && typeof value.function.name === 'string') {
        return value.type + ':' + value.function.name;
      }
      if (typeof value.name === 'string') return value.type + ':' + value.name;
      return value.type;
    }
    return Object.keys(value).sort().join(',');
  }

  function summarizeInput(inputValue) {
    if (Array.isArray(inputValue)) {
      return {
        inputKind: 'array',
        inputItems: inputValue.length,
      };
    }
    if (typeof inputValue === 'string') {
      return {
        inputKind: 'string',
        inputChars: Array.from(inputValue).length,
      };
    }
    if (inputValue == null) {
      return {
        inputKind: null,
      };
    }
    return {
      inputKind: typeof inputValue,
    };
  }

  function summarizeModelRequest(rawUrl, bodyText) {
    var body = safeJsonParse(bodyText);
    if (!isRecord(body)) {
      return {
        endpoint: endpointLabel(rawUrl),
        parseableJson: false,
      };
    }

    var tools = Array.isArray(body.tools) ? body.tools : [];
    var messages = Array.isArray(body.messages) ? body.messages : [];
    var inputSummary = summarizeInput(body.input);
    var instructions = typeof body.instructions === 'string' ? body.instructions : '';
    var system = typeof body.system === 'string' ? body.system : '';
    var toolNames = tools.map(toolName).filter(Boolean);

    return {
      endpoint: endpointLabel(rawUrl),
      parseableJson: true,
      model: typeof body.model === 'string' ? body.model : null,
      apiShape: parseUrl(rawUrl)?.pathname.split('/').filter(Boolean).slice(-2).join('/') || 'unknown',
      stream: body.stream === true,
      messagesCount: messages.length,
      inputKind: inputSummary.inputKind,
      inputItems: inputSummary.inputItems,
      inputChars: inputSummary.inputChars,
      instructionsChars: Array.from(instructions).length,
      systemChars: Array.from(system).length,
      toolsCount: tools.length,
      toolNames: toolNames.slice(0, 30),
      toolNamesTruncated: toolNames.length > 30,
      toolChoice: summarizeToolChoice(body.tool_choice ?? body.toolChoice),
      responseFormat: body.response_format ? true : undefined,
      maxOutputTokens: body.max_output_tokens ?? body.max_tokens ?? undefined,
      topLevelKeys: Object.keys(body).sort(),
    };
  }

  function decodeChunk(value) {
    if (!value) return '';
    try {
      return Buffer.from(value).toString('utf8');
    } catch (_) {
      return '';
    }
  }

  async function readResponseSample(response) {
    if (!response || !response.body || typeof response.body.getReader !== 'function') {
      return '';
    }
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (total < MAX_RESPONSE_SAMPLE_BYTES) {
        var next = await reader.read();
        if (next.done) break;
        var text = decodeChunk(next.value);
        if (!text) continue;
        chunks.push(text);
        total += Buffer.byteLength(text);
      }
    } catch (_) {
      // The original response remains untouched; this is only best-effort diagnostics.
    } finally {
      try {
        await reader.cancel();
      } catch (_) {
        // Ignore clone-reader cancellation failures.
      }
    }
    return chunks.join('');
  }

  function countArray(value) {
    return Array.isArray(value) ? value.length : 0;
  }

  function summarizeJsonResponse(value) {
    if (!isRecord(value)) return {};
    var choices = Array.isArray(value.choices) ? value.choices : [];
    var output = Array.isArray(value.output) ? value.output : [];
    var content = output.flatMap(function (item) {
      return Array.isArray(item && item.content) ? item.content : [];
    });
    var outputTypes = output
      .map(function (item) { return isRecord(item) && typeof item.type === 'string' ? item.type : null; })
      .filter(Boolean);
    var contentTypes = content
      .map(function (item) { return isRecord(item) && typeof item.type === 'string' ? item.type : null; })
      .filter(Boolean);
    var choiceToolCalls = choices.reduce(function (sum, choice) {
      var message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
      return sum + countArray(message.tool_calls ?? message.toolCalls);
    }, 0);
    return {
      responseId: typeof value.id === 'string' ? value.id : undefined,
      choicesCount: choices.length,
      outputCount: output.length,
      outputTypes: outputTypes.slice(0, 20),
      contentTypes: contentTypes.slice(0, 20),
      choiceToolCalls,
      responseFunctionCalls: outputTypes.filter(function (type) { return type === 'function_call'; }).length,
      finishReasons: choices
        .map(function (choice) { return isRecord(choice) ? choice.finish_reason : null; })
        .filter(Boolean),
    };
  }

  function summarizeModelResponse(response, sampleText, elapsedMs) {
    var parsed = safeJsonParse(sampleText);
    var jsonSummary = summarizeJsonResponse(parsed);
    return Object.assign({
      status: response.status,
      ok: response.ok,
      elapsedMs,
      contentType: response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-type')
        : null,
      sampleBytes: Buffer.byteLength(sampleText || ''),
      sampleTruncated: Buffer.byteLength(sampleText || '') >= MAX_RESPONSE_SAMPLE_BYTES,
      hasToolCallsText: /"tool_calls"|"toolCalls"|tool_calls|toolCalls/.test(sampleText || ''),
      hasFunctionCallText: /"function_call"|function_call|response\.output_item\.added|function_call_arguments/.test(sampleText || ''),
      hasToolUseText: /"tool_use"|tool_use/.test(sampleText || ''),
    }, jsonSummary);
  }

  globalThis.fetch = function clawxFetch(input, init) {
    var url = getUrlString(input);
    var requestStartedAt = Date.now();
    var requestId = 'mf-' + requestStartedAt.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var shouldInspectModelFetch = isModelEndpoint(url);

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      delete flat['x-openrouter-title'];
      delete flat['X-OpenRouter-Title'];
      flat['HTTP-Referer'] = 'https://claw-x.com';
      flat['X-OpenRouter-Title'] = 'UClaw';
      init.headers = flat;
    }

    if (shouldInspectModelFetch) {
      readRequestBody(input, init).then(function (bodyText) {
        writeDiagnostic('model.fetch.request', Object.assign({
          requestId,
        }, summarizeModelRequest(url, bodyText)));
      }).catch(function (error) {
        writeDiagnostic('model.fetch.request.failed', {
          requestId,
          endpoint: endpointLabel(url),
          error: String(error && error.message ? error.message : error),
        });
      });
    }

    var responsePromise = _f.call(globalThis, input, init);
    if (!shouldInspectModelFetch || !responsePromise || typeof responsePromise.then !== 'function') {
      return responsePromise;
    }

    return responsePromise.then(function (response) {
      try {
        var responseClone = response.clone();
        readResponseSample(responseClone).then(function (sampleText) {
          writeDiagnostic('model.fetch.response', Object.assign({
            requestId,
            endpoint: endpointLabel(url),
          }, summarizeModelResponse(response, sampleText, Date.now() - requestStartedAt)));
        }).catch(function (error) {
          writeDiagnostic('model.fetch.response.failed', {
            requestId,
            endpoint: endpointLabel(url),
            status: response.status,
            elapsedMs: Date.now() - requestStartedAt,
            error: String(error && error.message ? error.message : error),
          });
        });
      } catch (error) {
        writeDiagnostic('model.fetch.response.failed', {
          requestId,
          endpoint: endpointLabel(url),
          elapsedMs: Date.now() - requestStartedAt,
          error: String(error && error.message ? error.message : error),
        });
      }
      return response;
    });
  };
})();

require('./gateway-child-process-patch.cjs');
