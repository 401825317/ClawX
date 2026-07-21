export const EXTRA_BUNDLED_PACKAGES = [
  '@whiskeysockets/baileys',
  'jszip',

  // Built-in channel/runtime extension deps that are not always pulled in by the
  // OpenClaw package's own transitive dependency graph, but are required in
  // packaged builds when dist/extensions/<channel>/*.js resolves bare imports
  // from resources/openclaw/node_modules.
  '@larksuiteoapi/node-sdk',
  '@grammyjs/runner',
  '@grammyjs/transformer-throttler',
  'grammy',
  '@buape/carbon',
  '@tencent-connect/qqbot-connector',
  'mpg123-decoder',
  'silk-wasm',

  // The built-in acpx extension resolves the npm "acpx" runtime from the
  // bundled OpenClaw context in packaged builds. Package it explicitly so
  // the packaged runtime has acpx@0.5.3 available even when extension
  // node_modules are flattened or skipped by electron-builder.
  'acpx',

  // OpenClaw's built-in browser extension resolves playwright-core at runtime.
  // Package it explicitly because it is not always present in openclaw's own
  // transitive dependency graph from the app bundle context.
  'playwright-core',

  // OpenClaw's built-in canvas extension lazy-loads its A2UI renderer.
  // The published core package does not hoist these workspace dependencies.
  '@a2ui/lit',
  '@lit/context',
  'lit',

  // Electron main process QR login flows resolve these files from the
  // bundled OpenClaw runtime context in packaged builds.
  'qrcode-terminal',
];

/** Subset required by the Electron main process (verified after bundle + afterPack). */
export const ELECTRON_MAIN_RUNTIME_PACKAGES = [
  '@whiskeysockets/baileys',
  'qrcode-terminal',
];

/** OpenClaw 2026.7.1-2 runtime packages that must survive bundle cleanup. */
export const OPENCLAW_REQUIRED_RUNTIME_PACKAGES = [
  '@openclaw/ai',
  '@agentclientprotocol/sdk',
  '@silvia-odwyer/photon-node',
  '@a2ui/lit',
  '@lit/context',
  'lit',
];

/** Runtime entry points and native payloads required by the bundled OpenClaw. */
export const OPENCLAW_REQUIRED_RUNTIME_FILES = [
  '@openclaw/ai/dist/index.mjs',
  '@agentclientprotocol/sdk/dist/acp.js',
  '@silvia-odwyer/photon-node/photon_rs.js',
  '@silvia-odwyer/photon-node/photon_rs_bg.wasm',
];
