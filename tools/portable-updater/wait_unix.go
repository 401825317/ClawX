//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
	"time"
)

func waitForParentExit(pid int, timeout time.Duration, logf func(string, ...any)) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			logf("parent process %d has exited", pid)
			return
		}
		if errors.Is(err, syscall.EPERM) || err == nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		logf("parent process check returned %v; continuing", err)
		return
	}
	logf("timed out waiting for parent process %d; continuing", pid)
}

func init() {
	_ = os.ErrProcessDone
}
