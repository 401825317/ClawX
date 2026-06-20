'use strict';

require('./gateway-child-process-patch.cjs');

(async function () {
  var entry = process.env.CLAWX_OPENCLAW_ENTRY;
  if (!entry) {
    throw new Error('CLAWX_OPENCLAW_ENTRY is required to launch OpenClaw Gateway');
  }
  process.argv[1] = entry;
  var pathToFileURL = require('node:url').pathToFileURL;
  await import(pathToFileURL(entry).href);
})().catch(function (error) {
  var message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  process.stderr.write('[clawx-gateway-wrapper] ' + message + '\n');
  process.exit(1);
});
