#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'scripts', 'windows-support', 'UClaw-SelfCheck.template.cmd');
const PAYLOAD_PATH = path.join(ROOT, 'scripts', 'windows-support', 'UClaw-SelfCheck.mjs');
const PAYLOAD_MARKER = '//__UCLAW_SELF_CHECK_PAYLOAD__';

function toCrLf(value) {
  return value.replace(/\r?\n/g, '\r\n');
}

export function buildWindowsSelfCheck(outputPath) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8').trimEnd();
  const payload = fs.readFileSync(PAYLOAD_PATH, 'utf8').trimStart();
  const output = `${toCrLf(template)}\r\n${PAYLOAD_MARKER}\r\n${toCrLf(payload)}`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  return outputPath;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
  if (!outputArg) {
    console.error('Usage: node scripts/build-windows-self-check.mjs --output=<UClaw-SelfCheck.cmd>');
    process.exit(1);
  }
  const outputPath = path.resolve(outputArg);
  buildWindowsSelfCheck(outputPath);
  console.log(`[build-windows-self-check] Created ${outputPath}`);
}
