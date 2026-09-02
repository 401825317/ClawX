//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// validateParentPID prevents a tampered task file from making the helper wait
// on an unrelated process.  On Unix the updater never force-kills the parent,
// but an arbitrary live PID could still stall an update for the full timeout.
// A parent that has already exited is safe: the normal wait path will observe
// ESRCH and continue with replacement.
func validateParentPID(pid int, _ string) error {
	if pid <= 1 {
		return fmt.Errorf("parentPid must be greater than 1 (got %d)", pid)
	}
	if pid == os.Getpid() {
		return errors.New("parentPid must not identify the updater helper itself")
	}
	if err := syscall.Kill(pid, 0); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("cannot validate parent process %d: %w", pid, err)
	}
	observedParent := os.Getppid()
	if observedParent > 1 && pid != observedParent {
		return fmt.Errorf("parentPid %d is not the helper's parent process %d", pid, observedParent)
	}
	return nil
}
