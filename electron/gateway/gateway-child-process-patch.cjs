'use strict';

(function () {
  function valueReferencesElectronExecPath(value, execPath) {
    if (!execPath) return false;
    if (typeof value === 'string') return value.indexOf(execPath) !== -1;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (valueReferencesElectronExecPath(value[i], execPath)) return true;
      }
    }
    return false;
  }

  function ensureElectronRunAsNodeForChildProcess(method, args) {
    var shouldPatch = false;
    try {
      shouldPatch = method === 'fork'
        || valueReferencesElectronExecPath(args[0], process.execPath)
        || valueReferencesElectronExecPath(args[1], process.execPath);
    } catch (e) {
      shouldPatch = false;
    }
    if (!shouldPatch) return args;

    var optIdx = -1;
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'function') break;
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        optIdx = i;
        break;
      }
    }

    var opts = optIdx >= 0 ? Object.assign({}, args[optIdx]) : {};
    var hasExplicitEnv = Object.prototype.hasOwnProperty.call(opts, 'env');
    var baseEnv = hasExplicitEnv && opts.env && typeof opts.env === 'object'
      ? opts.env
      : process.env;
    opts.env = Object.assign({}, baseEnv, { ELECTRON_RUN_AS_NODE: '1' });

    if (optIdx >= 0) {
      args[optIdx] = opts;
      return args;
    }

    if (typeof args[args.length - 1] === 'function') {
      args.splice(args.length - 1, 0, opts);
    } else {
      args.push(opts);
    }
    return args;
  }

  try {
    var cp = require('node:child_process');
    if (!cp.__clawxElectronRunAsNodePatched) {
      cp.__clawxElectronRunAsNodePatched = true;
      var methods = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'];
      methods.forEach(function (method) {
        var original = cp[method];
        if (typeof original !== 'function') return;
        cp[method] = function () {
          var args = Array.prototype.slice.call(arguments);
          ensureElectronRunAsNodeForChildProcess(method, args);
          if (process.platform === 'win32') {
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
          }
          return original.apply(this, args);
        };
      });
      try {
        var moduleApi = require('node:module');
        if (typeof moduleApi.syncBuiltinESMExports === 'function') {
          moduleApi.syncBuiltinESMExports();
        }
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
})();
