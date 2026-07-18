import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  patchInstalledOpenClawTextProviderFailoverRuntime,
  patchOpenClawTextProviderFailoverContent,
  readOpenClawTextProviderFailoverConfig,
} from './openclaw-text-provider-failover-patch.mjs';

const config = readOpenClawTextProviderFailoverConfig();
assert.equal(config.primaryProvider, 'openai');
assert.equal(config.fallbackProvider, 'deepseek');
assert.equal(config.fallbackModel, 'deepseek-v4-pro');
assert.equal(config.fallbackApiProtocol, 'openai-completions');

const candidateFixture = `function resolveFallbackCandidatesUncached(params) {
\tconst resolvedPrimary = normalizeCandidateRef(params.provider, params.model);
\tconst { candidates, addExplicitCandidate } = createModelCandidateCollector();
\taddExplicitCandidate(normalizeCandidateRef(resolvedPrimary.provider, resolvedPrimary.model));
\tconst modelFallbacks = params.fallbacksOverride !== void 0 ? params.fallbacksOverride : resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
\treturn candidates;
}
async function runWithModelFallbackInternal(params) {
\tconst candidate = { provider: params.provider, model: params.model };
\tconst isPrimary = true;
\tconst attempts = [];
\t\tconst attemptRun = await runFallbackAttempt({
\t\t\trun: params.run,
\t\t\t...candidate,
\t\t\tattempts,
\t\t\toptions: {
\t\t\t\tisFinalFallbackAttempt: true
\t\t\t},
\t\t});
}`;
const candidatePatched = patchOpenClawTextProviderFailoverContent(candidateFixture, 'model-fallback.js', config);
assert.deepEqual(candidatePatched.categories, ['candidate-chain']);
assert.match(candidatePatched.content, /UCLAW_TEXT_PROVIDER_FAILOVER_VERSION = 2/);
assert.match(candidatePatched.content, /return candidates;\n\t}\n\tconst modelFallbacks/);
assert.match(candidatePatched.content, /createUclawTextProviderFailoverTestRun/);

const sessionFixture = `const FALLBACK_SELECTION_STATE_KEYS = ["providerOverride"];
async function run() {
\tconst persistFallbackCandidateSelection = async (provider, model, candidateRun) => {
\t\tif (!params.sessionKey || !params.activeSessionStore || preserveUserFacingSessionState || provider === effectiveRun.provider && model === effectiveRun.model) return;
\t};
}`;
const sessionPatched = patchOpenClawTextProviderFailoverContent(sessionFixture, 'reply-usage-state.js', config);
assert.deepEqual(sessionPatched.categories, ['session-persistence']);
assert.match(sessionPatched.content, /if \(shouldKeepUclawTextProviderFallbackEphemeral\(effectiveRun, provider, model\)\) return;/);

const firstPatch = patchInstalledOpenClawTextProviderFailoverRuntime(process.cwd(), {
  logger: { log() {} },
});
assert.equal(firstPatch.categoryCounts['candidate-chain'], 1);
assert.equal(firstPatch.categoryCounts['session-persistence'], 1);

const secondPatch = patchInstalledOpenClawTextProviderFailoverRuntime(process.cwd(), {
  logger: { log() {} },
});
assert.equal(secondPatch.patchedFiles, 0, 'the text Provider failover patch must be idempotent');

const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const distFiles = readdirSync(distDir).filter((file) => file.endsWith('.js'));
const readDistFileWith = (marker) => {
  const file = distFiles.find((entry) => readFileSync(join(distDir, entry), 'utf8').includes(marker));
  assert.ok(file, `expected an OpenClaw runtime file containing ${marker}`);
  return { file, content: readFileSync(join(distDir, file), 'utf8') };
};

const candidateRuntime = readDistFileWith('UCLAW_TEXT_PROVIDER_FAILOVER_VERSION = 2');
const sessionRuntime = readDistFileWith('UCLAW_TEXT_PROVIDER_FAILOVER_SESSION_VERSION = 1');
const transportRuntime = readDistFileWith('function createOpenAICompletionsTransportStreamFn()');
assert.doesNotMatch(candidateRuntime.content, /UCLAW_OPENAI_RESPONSES_COMPATIBLE_FALLBACK/);
assert.doesNotMatch(sessionRuntime.content, /providerOverride = UCLAW_TEXT_PROVIDER_FAILOVER/);
assert.match(sessionRuntime.content, /if \(shouldKeepUclawTextProviderFallbackEphemeral\(effectiveRun, provider, model\)\) return;/);
assert.match(transportRuntime.content, /client\.chat\.completions\.create\(/);
for (const file of distFiles) {
  const content = readFileSync(join(distDir, file), 'utf8');
  assert.doesNotMatch(content, /UCLAW_OPENAI_RESPONSES_(?:TRANSPORT_)?COMPATIBLE_FALLBACK/);
}

const fallbackModule = await import(`${pathToFileURL(join(distDir, candidateRuntime.file)).href}?uclaw-test=${Date.now()}`);
const runWithModelFallback = fallbackModule.o;
assert.equal(typeof runWithModelFallback, 'function');
const classifierRuntime = readDistFileWith('function classifyEmbeddedAgentRunResultForModelFallback');
const classifierModule = await import(`${pathToFileURL(join(distDir, classifierRuntime.file)).href}?uclaw-test=${Date.now()}`);
const classifyEmbeddedAgentRunResultForModelFallback = classifierModule.t;
assert.equal(typeof classifyEmbeddedAgentRunResultForModelFallback, 'function');

const runtimeConfig = {
  agents: {
    defaults: {
      model: {
        primary: `${config.primaryProvider}/smart-latest`,
        fallbacks: [],
      },
    },
  },
  models: {
    providers: {
      [config.primaryProvider]: {
        baseUrl: 'https://relay.example.invalid/v1',
        api: 'openai-responses',
        models: [{ id: 'smart-latest', name: 'smart-latest' }],
      },
      [config.fallbackProvider]: {
        baseUrl: 'https://relay.example.invalid/v1',
        api: config.fallbackApiProtocol,
        models: [{ id: config.fallbackModel, name: config.fallbackModel }],
      },
    },
  },
};

const failedPrimaryCalls = [];
const fallbackResult = await runWithModelFallback({
  cfg: runtimeConfig,
  provider: config.primaryProvider,
  model: 'smart-latest',
  fallbacksOverride: [],
  skipAuthProfileRuntime: true,
  sessionId: 'simulated-provider-failure',
  run: async (provider, model) => {
    failedPrimaryCalls.push(`${provider}/${model}`);
    if (provider === config.primaryProvider) {
      const error = new Error('simulated OpenAI provider failure');
      error.status = 500;
      throw error;
    }
    return { provider, model, protocol: runtimeConfig.models.providers[provider].api };
  },
});
assert.deepEqual(failedPrimaryCalls, [
  `${config.primaryProvider}/smart-latest`,
  `${config.fallbackProvider}/${config.fallbackModel}`,
]);
assert.equal(fallbackResult.provider, config.fallbackProvider);
assert.equal(fallbackResult.model, config.fallbackModel);
assert.equal(fallbackResult.result.protocol, 'openai-completions');

const nextCallAttempts = [];
const nextResult = await runWithModelFallback({
  cfg: runtimeConfig,
  provider: config.primaryProvider,
  model: 'smart-latest',
  fallbacksOverride: [],
  skipAuthProfileRuntime: true,
  sessionId: 'simulated-provider-failure',
  run: async (provider, model) => {
    nextCallAttempts.push(`${provider}/${model}`);
    return { provider, model };
  },
});
assert.deepEqual(nextCallAttempts, [`${config.primaryProvider}/smart-latest`]);
assert.equal(nextResult.provider, config.primaryProvider);

process.env.CLAWX_TEXT_FAILOVER_TEST_ALLOWED = '1';
process.env.CLAWX_TEXT_FAILOVER_TEST_MODE = 'fail-primary-once';
try {
  const injectedAttempts = [];
  const injectedResult = await runWithModelFallback({
    cfg: runtimeConfig,
    provider: config.primaryProvider,
    model: 'smart-latest',
    fallbacksOverride: [],
    skipAuthProfileRuntime: true,
    sessionId: 'real-page-one-time-failure',
    run: async (provider, model) => {
      injectedAttempts.push(`${provider}/${model}`);
      return { provider, model, protocol: runtimeConfig.models.providers[provider].api };
    },
  });
  assert.deepEqual(injectedAttempts, [`${config.fallbackProvider}/${config.fallbackModel}`]);
  assert.equal(injectedResult.provider, config.fallbackProvider);
  assert.equal(injectedResult.result.protocol, 'openai-completions');

  const postInjectionAttempts = [];
  const postInjectionResult = await runWithModelFallback({
    cfg: runtimeConfig,
    provider: config.primaryProvider,
    model: 'smart-latest',
    fallbacksOverride: [],
    skipAuthProfileRuntime: true,
    sessionId: 'real-page-one-time-failure',
    run: async (provider, model) => {
      postInjectionAttempts.push(`${provider}/${model}`);
      return { provider, model };
    },
  });
  assert.deepEqual(postInjectionAttempts, [`${config.primaryProvider}/smart-latest`]);
  assert.equal(postInjectionResult.provider, config.primaryProvider);
} finally {
  delete process.env.CLAWX_TEXT_FAILOVER_TEST_ALLOWED;
  delete process.env.CLAWX_TEXT_FAILOVER_TEST_MODE;
}

const visibleOutputAttempts = [];
const visibleOutputResult = await runWithModelFallback({
  cfg: runtimeConfig,
  provider: config.primaryProvider,
  model: 'smart-latest',
  fallbacksOverride: [],
  skipAuthProfileRuntime: true,
  sessionId: 'simulated-visible-output',
  classifyResult: ({ provider, model, result }) => classifyEmbeddedAgentRunResultForModelFallback({
    provider,
    model,
    result,
  }),
  run: async (provider) => {
    visibleOutputAttempts.push(provider);
    return {
      payloads: [{ text: 'visible partial answer' }],
      meta: {
        finalAssistantVisibleText: 'visible partial answer',
        error: { kind: 'incomplete_turn', fallbackSafe: true },
      },
    };
  },
});
assert.deepEqual(visibleOutputAttempts, [config.primaryProvider]);
assert.equal(visibleOutputResult.provider, config.primaryProvider);

const sideEffectAttempts = [];
await runWithModelFallback({
  cfg: runtimeConfig,
  provider: config.primaryProvider,
  model: 'smart-latest',
  fallbacksOverride: [],
  skipAuthProfileRuntime: true,
  sessionId: 'simulated-side-effect',
  classifyResult: ({ provider, model, result }) => classifyEmbeddedAgentRunResultForModelFallback({
    provider,
    model,
    result,
    hasDirectlySentBlockReply: true,
  }),
  run: async (provider) => {
    sideEffectAttempts.push(provider);
    return {
      payloads: [{ isError: true, text: 'provider stopped after a delivered tool action' }],
      meta: { error: { kind: 'incomplete_turn', fallbackSafe: true } },
    };
  },
});
assert.deepEqual(sideEffectAttempts, [config.primaryProvider]);

const abortAttempts = [];
await assert.rejects(
  runWithModelFallback({
    cfg: runtimeConfig,
    provider: config.primaryProvider,
    model: 'smart-latest',
    fallbacksOverride: [],
    skipAuthProfileRuntime: true,
    sessionId: 'simulated-user-abort',
    run: async (provider) => {
      abortAttempts.push(provider);
      const error = new Error('simulated user cancellation');
      error.name = 'AbortError';
      throw error;
    },
  }),
  /simulated user cancellation/,
);
assert.deepEqual(abortAttempts, [config.primaryProvider]);

process.env.CLAWX_MANAGED_PROVIDER = '0';
try {
  const communityFallbackModule = await import(
    `${pathToFileURL(join(distDir, candidateRuntime.file)).href}?uclaw-community-test=${Date.now()}`
  );
  const communityAttempts = [];
  await assert.rejects(
    communityFallbackModule.o({
      cfg: runtimeConfig,
      provider: config.primaryProvider,
      model: 'smart-latest',
      fallbacksOverride: [],
      skipAuthProfileRuntime: true,
      sessionId: 'simulated-community-provider-failure',
      run: async (provider) => {
        communityAttempts.push(provider);
        const error = new Error('simulated community OpenAI provider failure');
        error.status = 500;
        throw error;
      },
    }),
    /simulated community OpenAI provider failure/,
  );
  assert.deepEqual(communityAttempts, [config.primaryProvider]);
} finally {
  delete process.env.CLAWX_MANAGED_PROVIDER;
}

console.log('openclaw text Provider failover patch tests passed');
