// @vitest-environment node

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { expressionPath, findCalls, findFunctionBody, findNodes, parseTypeScriptSource } from './source-contract';

function importedNames(source: ts.SourceFile, moduleName: string): string[] {
  return findNodes(
    source,
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === moduleName,
  ).flatMap((declaration) => {
    const bindings = declaration.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => element.name.text)
      : [];
  });
}

describe('Gateway async prelaunch maintenance wiring', () => {
  it('uses only the async cache and async directory signatures for startup cleanups', () => {
    const source = parseTypeScriptSource('electron/gateway/config-sync.ts');

    expect(importedNames(source, './async-prelaunch-maintenance-cache')).toEqual(
      expect.arrayContaining([
        'directoryChildrenSignatureAsync',
        'directoryTreeSignatureAsync',
        'runCachedPrelaunchMaintenanceTaskAsync',
        'scheduleCachedPrelaunchMaintenanceTaskAsync',
      ]),
    );
    expect(importedNames(source, './prelaunch-maintenance-cache')).not.toEqual(
      expect.arrayContaining([
        'directoryChildrenSignature',
        'runCachedPrelaunchMaintenanceTask',
      ]),
    );
    expect(importedNames(source, './prelaunch-liveness')).not.toContain(
      'runPrelaunchBlockingPhase',
    );
  });

  it('keeps required cleanup measured and defers non-blocking audits', () => {
    const source = parseTypeScriptSource('electron/gateway/config-sync.ts');
    const prelaunch = findFunctionBody(source, 'syncGatewayConfigBeforeLaunch');
    const deferredMaintenance = findFunctionBody(source, 'schedulePostLaunchMaintenance');
    const runtimeCacheKey = findFunctionBody(source, 'buildRuntimeDepsCleanupCacheKey');
    const deepRuntimeCacheKey = findFunctionBody(source, 'buildRuntimeDepsDeepAuditCacheKey');
    const asyncCacheTasks = findCalls(prelaunch, 'runCachedPrelaunchMaintenanceTaskAsync')
      .map((call) => call.arguments[0])
      .filter(ts.isStringLiteral)
      .map((argument) => argument.text);
    const deferredTasks = findCalls(deferredMaintenance, 'scheduleDeferredMaintenance')
      .map((call) => call.arguments[1])
      .filter(ts.isStringLiteral)
      .map((argument) => argument.text);
    const measuredPhases = findCalls(prelaunch, 'measureAsync')
      .map((call) => call.arguments[1])
      .filter(ts.isStringLiteral)
      .map((argument) => argument.text);

    expect(asyncCacheTasks).toEqual(
      expect.arrayContaining(['runtime-deps-cleanup', 'plugin-maintenance']),
    );
    expect(deferredTasks).toEqual(expect.arrayContaining([
      'skills-symlink-cleanup',
      'plugin-install-artifact-cleanup',
      'runtime-deps-deep-audit',
    ]));
    expect(measuredPhases).toEqual(
      expect.arrayContaining(['runtimeDepsCleanupMs', 'pluginMaintenanceMs']),
    );
    expect(findCalls(prelaunch, 'runCachedPrelaunchMaintenanceTask')).toHaveLength(0);
    expect(findCalls(prelaunch, 'runPrelaunchBlockingPhase')).toHaveLength(0);
    expect(findCalls(runtimeCacheKey, 'directoryChildrenSignatureAsync')).toHaveLength(1);
    expect(findCalls(deepRuntimeCacheKey, 'directoryTreeSignatureAsync')).toHaveLength(1);
  });

  it('contains no synchronous filesystem or blocking-wait API in the cleanup module', () => {
    const source = parseTypeScriptSource('electron/gateway/skills-symlink-cleanup.ts');
    const forbiddenCalls = findNodes(source, ts.isCallExpression)
      .map((call) => expressionPath(call.expression))
      .filter((name) =>
        /(?:Sync$|Atomics\.wait$)/.test(name)
        || name === 'existsSync',
      );

    expect(forbiddenCalls).toEqual([]);
    expect(importedNames(source, 'node:fs/promises')).toEqual(
      expect.arrayContaining(['lstat', 'readdir', 'readlink', 'realpath', 'rm', 'unlink']),
    );
  });
});
