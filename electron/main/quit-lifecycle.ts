export interface QuitLifecycleState {
  cleanupStarted: boolean;
  cleanupCompleted: boolean;
}

export type QuitLifecycleAction = 'start-cleanup' | 'cleanup-in-progress' | 'allow-quit';
export type AbortableQuitTaskResult = 'completed' | 'timeout';

export function createQuitLifecycleState(): QuitLifecycleState {
  return {
    cleanupStarted: false,
    cleanupCompleted: false,
  };
}

export function requestQuitLifecycleAction(state: QuitLifecycleState): QuitLifecycleAction {
  if (state.cleanupCompleted) {
    return 'allow-quit';
  }

  if (state.cleanupStarted) {
    return 'cleanup-in-progress';
  }

  state.cleanupStarted = true;
  return 'start-cleanup';
}

export function markQuitCleanupCompleted(state: QuitLifecycleState): void {
  state.cleanupCompleted = true;
}

export async function runAbortableQuitTask(
  task: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<AbortableQuitTaskResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taskResult: Promise<AbortableQuitTaskResult> = task(controller.signal)
    .then(() => 'completed' as const)
    .catch((error): AbortableQuitTaskResult => {
      if (controller.signal.aborted) return 'timeout';
      throw error;
    });
  const timeoutResult = new Promise<AbortableQuitTaskResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    return await Promise.race([taskResult, timeoutResult]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
