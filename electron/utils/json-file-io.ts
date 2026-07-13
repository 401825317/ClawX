import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseJsonWithBom } from './json';

const DEFAULT_JSON_READ_RETRY_DELAYS_MS = [25, 75, 150] as const;

export type JsonFileDocument<T> = {
  raw: string;
  data: T;
};

export type JsonFileReadRetryOptions = {
  retryDelaysMs?: readonly number[];
};

export class JsonFileReadError extends Error {
  readonly attempts: number;
  readonly filePath: string;

  constructor(filePath: string, attempts: number, cause: unknown) {
    super(`Unable to parse JSON file after ${attempts} attempt(s): ${filePath}`);
    this.name = 'JsonFileReadError';
    this.attempts = attempts;
    this.filePath = filePath;
    this.cause = cause;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read and parse a JSON document, retrying only transient parse failures.
 * Missing files remain distinct from malformed files so callers never write a
 * replacement config from an empty fallback after a failed parse.
 */
export async function readJsonDocumentWithRetry<T>(
  filePath: string,
  options: JsonFileReadRetryOptions = {},
): Promise<JsonFileDocument<T> | null> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_JSON_READ_RETRY_DELAYS_MS;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const raw = await readFile(filePath, 'utf8');
      return { raw, data: parseJsonWithBom<T>(raw) };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      if (!isJsonParseError(error) || attempt === retryDelaysMs.length) {
        throw new JsonFileReadError(filePath, attempt + 1, error);
      }
      await wait(retryDelaysMs[attempt]);
    }
  }

  throw new JsonFileReadError(filePath, retryDelaysMs.length + 1, new Error('unreachable'));
}

/** Read a JSON value while discarding its original serialized form. */
export async function readJsonFileWithRetry<T>(
  filePath: string,
  options: JsonFileReadRetryOptions = {},
): Promise<T | null> {
  return (await readJsonDocumentWithRetry<T>(filePath, options))?.data ?? null;
}

async function resolveAtomicTargetPath(filePath: string): Promise<string> {
  try {
    // Preserve a user-managed symlink by replacing its resolved target.
    return await realpath(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return filePath;
    }
    throw error;
  }
}

async function resolveTargetMode(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (isNotFoundError(error)) {
      return 0o600;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms and is best effort.
  }
}

/**
 * Replace a file only after its complete content has been flushed to a sibling
 * temporary file. Readers therefore observe either the previous JSON or the
 * completed replacement, never a truncated write in progress.
 */
export async function writeTextFileAtomically(filePath: string, content: string): Promise<void> {
  const targetPath = await resolveAtomicTargetPath(filePath);
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });

  const mode = await resolveTargetMode(targetPath);
  const tempPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serialize JSON with the same atomic replacement guarantee as text files. */
export async function writeJsonFileAtomically(filePath: string, data: unknown): Promise<void> {
  await writeTextFileAtomically(filePath, JSON.stringify(data, null, 2));
}
