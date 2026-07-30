import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { resolveOpenClawWorkspacePath } from '../utils/paths';

export type AcpSessionAccessContext = {
  sessionKey: string;
  generation: number;
  workspaceRoot: string;
  executionCwd: string;
};

export type AcpSessionAccessGrantListener = (
  context: AcpSessionAccessContext | null,
) => void;

async function canonicalDirectory(input: string, label: string): Promise<string> {
  const canonicalPath = await realpath(resolveOpenClawWorkspacePath(input));
  const directoryStat = await stat(canonicalPath);
  if (!directoryStat.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonicalPath;
}

function isInside(child: string, parent: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function sameContext(
  left: AcpSessionAccessContext | null,
  right: AcpSessionAccessContext | null,
): boolean {
  if (!left || !right) return left === right;
  return left?.sessionKey === right?.sessionKey
    && left?.generation === right?.generation
    && left?.workspaceRoot === right?.workspaceRoot
    && left?.executionCwd === right?.executionCwd;
}

export class AcpSessionAccessRegistry {
  private activeGrant: AcpSessionAccessContext | null = null;
  private readonly grantListeners = new Set<AcpSessionAccessGrantListener>();

  private replaceGrant(context: AcpSessionAccessContext | null): void {
    const next = context ? { ...context } : null;
    if (sameContext(this.activeGrant, next)) return;
    this.activeGrant = next;

    // Authorization changes must complete even if a revocation observer fails.
    for (const listener of Array.from(this.grantListeners)) {
      try {
        listener(next ? { ...next } : null);
      } catch {
        // Observers are cleanup hooks and cannot own the grant lifecycle.
      }
    }
  }

  async prepareGrant(input: AcpSessionAccessContext): Promise<AcpSessionAccessContext> {
    const workspaceRoot = await canonicalDirectory(input.workspaceRoot, 'ACP workspace root');
    const executionCwd = await canonicalDirectory(input.executionCwd, 'ACP execution cwd');
    if (!isInside(executionCwd, workspaceRoot)) {
      throw new Error('ACP execution cwd must be inside the workspace root');
    }
    return { ...input, workspaceRoot, executionCwd };
  }

  snapshot(): AcpSessionAccessContext | null {
    return this.activeGrant ? { ...this.activeGrant } : null;
  }

  commitGrant(context: AcpSessionAccessContext): void {
    this.replaceGrant(context);
  }

  restore(snapshot: AcpSessionAccessContext | null): void {
    this.replaceGrant(snapshot);
  }

  get(sessionKey: string, generation: number): AcpSessionAccessContext | null {
    if (this.activeGrant?.sessionKey !== sessionKey || this.activeGrant.generation !== generation) return null;
    return { ...this.activeGrant };
  }

  /** Observe committed grant changes for revocable Main-owned resources. */
  subscribe(listener: AcpSessionAccessGrantListener): () => void {
    this.grantListeners.add(listener);
    return () => {
      this.grantListeners.delete(listener);
    };
  }
}
