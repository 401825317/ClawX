//go:build !windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

func stopUpdatedAppProcessTree(pid int, timeout time.Duration, logf func(string, ...any)) error {
	// Updated app processes are launched in their own process group. Killing the
	// group prevents Electron helpers from keeping the replacement files alive
	// while the previous app is restored.
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		logf("failed to stop updated app process group %d: %v; falling back to the main process", pid, err)
		if fallbackErr := syscall.Kill(pid, syscall.SIGKILL); fallbackErr != nil && !errors.Is(fallbackErr, syscall.ESRCH) {
			return fmt.Errorf("failed to stop updated app process %d: %w", pid, fallbackErr)
		}
	}
	return waitForParentExit(pid, timeout, logf, "")
}
