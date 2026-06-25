//go:build windows

package main

import (
	"syscall"
	"time"
)

const (
	synchronize      = 0x00100000
	waitObject0      = 0x00000000
	waitTimeout      = 0x00000102
	waitFailed       = 0xFFFFFFFF
	timeoutChunkMs   = 500
	invalidHandleVal = ^uintptr(0)
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess        = kernel32.NewProc("OpenProcess")
	procWaitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle        = kernel32.NewProc("CloseHandle")
)

func waitForParentExit(pid int, timeout time.Duration, logf func(string, ...any)) {
	handle, _, err := procOpenProcess.Call(uintptr(synchronize), 0, uintptr(pid))
	if handle == 0 || handle == invalidHandleVal {
		logf("parent process %d is not open (%v); continuing", pid, err)
		return
	}
	defer procCloseHandle.Call(handle)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, _, _ := procWaitForSingleObject.Call(handle, timeoutChunkMs)
		switch result {
		case waitObject0:
			logf("parent process %d has exited", pid)
			return
		case waitTimeout:
			continue
		case waitFailed:
			logf("failed waiting for parent process %d; continuing", pid)
			return
		default:
			logf("unexpected wait result %d for parent process %d; continuing", result, pid)
			return
		}
	}
	logf("timed out waiting for parent process %d; continuing", pid)
}
