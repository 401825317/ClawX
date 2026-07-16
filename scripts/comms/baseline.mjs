import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const CURRENT_FILE = path.join(ROOT, 'artifacts/comms/current-metrics.json');
const BASELINE_DIR = path.join(ROOT, 'scripts/comms/baseline');
const BASELINE_FILE = path.join(BASELINE_DIR, 'metrics.baseline.json');

async function main() {
  const raw = await readFile(CURRENT_FILE, 'utf8');
  const current = JSON.parse(raw);

  await mkdir(BASELINE_DIR, { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(current, null, 2));
  console.log(`Updated comms baseline: ${BASELINE_FILE}`);
}

main().catch((error) => {
  console.error('[comms:baseline] failed:', error);
  process.exitCode = 1;
});
