//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

func waitForParentExit(pid int, timeout time.Duration, logf func(string, ...any)) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			logf("parent process %d has exited", pid)
			return nil
		}
		if errors.Is(err, syscall.EPERM) || err == nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		return fmt.Errorf("cannot verify that parent process %d exited: %w", pid, err)
	}
	return fmt.Errorf("timed out waiting for parent process %d after %s", pid, timeout)
}

func init() {
	_ = os.ErrProcessDone
}
