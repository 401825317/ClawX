// @vitest-environment node

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  eventHandlerBody,
  expressionPath,
  findCalls,
  findFunctionBody,
  findNodes,
  objectProperty,
  parseTypeScriptSource,
} from './source-contract';

describe('Blender bridge application wiring', () => {
  it('injects only the active bridge endpoint into the Gateway child environment', () => {
    const source = parseTypeScriptSource('electron/gateway/config-sync.ts');
    const bridgeImports = findNodes(
      source,
      (node): node is ts.ImportDeclaration => (
        ts.isImportDeclaration(node)
        && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text === '../services/blender/bridge-server'
      ),
    );
    const importedNames = bridgeImports.flatMap((declaration) => (
      declaration.importClause?.namedBindings && ts.isNamedImports(declaration.importClause.namedBindings)
        ? declaration.importClause.namedBindings.elements.map((element) => element.name.text)
        : []
    ));
    const deletedBridgeKeys = new Set(
      findNodes(source, ts.isDeleteExpression)
        .map((node) => node.expression)
        .filter(ts.isPropertyAccessExpression)
        .filter((node) => expressionPath(node.expression) === 'inheritedEnv')
        .map((node) => node.name.text),
    );
    const bridgeEnvironmentSpreads = findNodes(
      source,
      (node): node is ts.SpreadAssignment => (
        ts.isSpreadAssignment(node)
        && ts.isCallExpression(node.expression)
        && expressionPath(node.expression.expression) === 'getBlenderBridgeEnvironment'
      ),
    );

    expect(importedNames).toContain('getBlenderBridgeEnvironment');
    expect(deletedBridgeKeys.has('CLAWX_HOST_API_ORIGIN')).toBe(true);
    expect(deletedBridgeKeys.has('CLAWX_HOST_API_TOKEN')).toBe(true);
    expect(bridgeEnvironmentSpreads).toHaveLength(1);
  });

  it('starts the bridge before Gateway auto-start and stops it in normal and emergency shutdown', () => {
    const source = parseTypeScriptSource('electron/main/app-runtime.ts');
    const initialize = findFunctionBody(source, 'initialize');
    const bridgeStart = findCalls(initialize, 'startBlenderBridgeServer')[0];
    const gatewayStart = findCalls(initialize, 'gatewayManager.start')[0];
    const beforeQuit = eventHandlerBody(source, 'app', 'before-quit');
    const fatalHandler = findCalls(source, 'createFatalHandler')[0];
    const fatalDependencies = fatalHandler?.arguments[0];

    expect(bridgeStart).toBeDefined();
    expect(gatewayStart).toBeDefined();
    expect(bridgeStart.pos).toBeLessThan(gatewayStart.pos);
    expect(findCalls(beforeQuit, 'stopBlenderBridgeServer')).toHaveLength(1);
    expect(fatalDependencies && ts.isObjectLiteralExpression(fatalDependencies)).toBe(true);

    const stopBlender = fatalDependencies && ts.isObjectLiteralExpression(fatalDependencies)
      ? objectProperty(fatalDependencies, 'stopBlender')
      : null;
    expect(stopBlender && ts.isPropertyAssignment(stopBlender)).toBe(true);
    expect(
      stopBlender && ts.isPropertyAssignment(stopBlender)
        ? findCalls(stopBlender.initializer, 'stopBlenderBridgeServer')
        : [],
    ).toHaveLength(1);
  });
});
