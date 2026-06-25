type CancelScheduledWork = () => void;

export function scheduleAfterNavigationFrame(
  callback: () => void,
  delayMs = 0,
): CancelScheduledWork {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let cancelled = false;
  let frameId: number | null = null;
  let timerId: number | null = null;

  const scheduleTimer = () => {
    timerId = window.setTimeout(() => {
      timerId = null;
      if (!cancelled) {
        callback();
      }
    }, delayMs);
  };

  if (typeof window.requestAnimationFrame === 'function') {
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      scheduleTimer();
    });
  } else {
    scheduleTimer();
  }

  return () => {
    cancelled = true;
    if (frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timerId != null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

export function scheduleIdleWork(
  callback: () => void,
  timeoutMs = 1_500,
): CancelScheduledWork {
  if (typeof window === 'undefined') {
    return () => {};
  }

  if (typeof window.requestIdleCallback !== 'function') {
    return scheduleAfterNavigationFrame(callback, timeoutMs);
  }

  let cancelled = false;
  const idleId = window.requestIdleCallback(() => {
    if (!cancelled) {
      callback();
    }
  }, { timeout: timeoutMs });

  return () => {
    cancelled = true;
    window.cancelIdleCallback(idleId);
  };
}
