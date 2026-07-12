const { join, resolve } = require('node:path');

module.exports = join(resolve(__dirname, '..'), 'build', 'dev-electron', 'UClaw.app', 'Contents', 'MacOS', 'Electron');
