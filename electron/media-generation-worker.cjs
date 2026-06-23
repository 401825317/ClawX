'use strict';

(async function () {
  var entry = process.env.CLAWX_MEDIA_GENERATION_WORKER_ENTRY;
  if (!entry) {
    throw new Error('CLAWX_MEDIA_GENERATION_WORKER_ENTRY is required');
  }
  process.argv[1] = entry;
  var pathToFileURL = require('node:url').pathToFileURL;
  await import(pathToFileURL(entry).href);
})().catch(function (error) {
  var message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  process.stderr.write('[clawx-media-generation-worker] ' + message + '\n');
  process.exit(1);
});
