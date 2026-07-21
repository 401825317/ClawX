//go:build windows

package main

import (
	"fmt"
	"syscall"
	"time"
)

const (
	synchronize                         = 0x00100000
	waitObject0                         = 0x00000000
	waitTimeout                         = 0x00000102
	waitFailed                          = 0xFFFFFFFF
	timeoutChunkMs                      = 500
	invalidHandleVal                    = ^uintptr(0)
	errorInvalidParameter syscall.Errno = 87
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess         = kernel32.NewProc("OpenProcess")
	procWaitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
)

func waitForParentExit(pid int, timeout time.Duration, logf func(string, ...any)) error {
	handle, _, err := procOpenProcess.Call(uintptr(synchronize), 0, uintptr(pid))
	if handle == 0 || handle == invalidHandleVal {
		if errno, ok := err.(syscall.Errno); ok && errno == errorInvalidParameter {
			logf("parent process %d has already exited", pid)
			return nil
		}
		return fmt.Errorf("cannot verify that parent process %d exited: %w", pid, err)
	}
	defer procCloseHandle.Call(handle)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, _, _ := procWaitForSingleObject.Call(handle, timeoutChunkMs)
		switch result {
		case waitObject0:
			logf("parent process %d has exited", pid)
			return nil
		case waitTimeout:
			continue
		case waitFailed:
			return fmt.Errorf("failed waiting for parent process %d", pid)
		default:
			return fmt.Errorf("unexpected wait result %d for parent process %d", result, pid)
		}
	}
	return fmt.Errorf("timed out waiting for parent process %d after %s", pid, timeout)
}
