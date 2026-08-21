import type { PathLike } from 'node:fs';
import { win32 } from 'node:path';

/** Give Windows SQLite the extended path form that node:fs normally applies internally. */
export function toSqlitePath<T extends PathLike>(
  input: T,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== 'win32' || typeof input !== 'string') return input;
  if (input === ':memory:' || input.slice(0, 5).toLowerCase() === 'file:') return input;
  if (!win32.isAbsolute(input)) return input;
  return win32.toNamespacedPath(input) as T;
}
