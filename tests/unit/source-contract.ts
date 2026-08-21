import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

export function parseTypeScriptSource(relativePath: string): ts.SourceFile {
  const absolutePath = resolve(process.cwd(), relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

export function findNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

export function expressionPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expressionPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : null;
  }
  if (ts.isCallExpression(expression)) {
    const callee = expressionPath(expression.expression);
    return callee ? `${callee}()` : null;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return expressionPath(expression.expression);
  }
  return null;
}

export function findCalls(root: ts.Node, path: string): ts.CallExpression[] {
  return findNodes(
    root,
    (node): node is ts.CallExpression => (
      ts.isCallExpression(node) && expressionPath(node.expression) === path
    ),
  );
}

export function findFunctionBody(source: ts.SourceFile, name: string): ts.Block {
  const declaration = findNodes(
    source,
    (node): node is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(node) && node.name?.text === name && Boolean(node.body)
    ),
  )[0];
  if (!declaration?.body) throw new Error(`Function ${name} was not found in ${source.fileName}`);
  return declaration.body;
}

export function findAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T | null {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

export function functionBody(expression: ts.Expression | undefined): ts.ConciseBody | null {
  return expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
    ? expression.body
    : null;
}

export function eventHandlerBody(
  root: ts.Node,
  emitter: string,
  eventName: string,
): ts.ConciseBody {
  const registration = findCalls(root, `${emitter}.on`).find((call) => {
    const event = call.arguments[0];
    return event && ts.isStringLiteralLike(event) && event.text === eventName;
  });
  const body = functionBody(registration?.arguments[1]);
  if (!body) throw new Error(`${emitter}.on('${eventName}') handler was not found`);
  return body;
}

export function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | null {
  return object.properties.find((property) => propertyName(property) === name) ?? null;
}
