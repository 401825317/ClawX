//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const processQueryLimitedInformation = 0x1000

var procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")

func validateParentPID(pid int, launchPath string) error {
	if pid <= 1 {
		return fmt.Errorf("parentPid must be greater than 1 (got %d)", pid)
	}
	if pid == os.Getpid() {
		return errors.New("parentPid must not identify the updater helper itself")
	}

	// If the original process already exited, there is no process to stop and
	// the update may proceed. This also handles the short race where Electron
	// quits before the detached helper starts.
	exited, err := processHasExited(pid)
	if err != nil {
		return fmt.Errorf("cannot validate parent process %d: %w", pid, err)
	}
	if exited {
		return nil
	}

	observedParent := os.Getppid()
	if observedParent > 1 && pid != observedParent {
		return fmt.Errorf("parentPid %d is not the helper's parent process %d", pid, observedParent)
	}
	if strings.TrimSpace(launchPath) == "" {
		return errors.New("launchPath is required to validate a live parent process")
	}

	actualPath, err := processImagePath(pid)
	if err != nil {
		return fmt.Errorf("cannot inspect parent process %d image: %w", pid, err)
	}
	if !sameWindowsPath(actualPath, launchPath) {
		return fmt.Errorf("parent process %d image %q does not match launchPath %q", pid, actualPath, launchPath)
	}
	return nil
}

func processImagePath(pid int) (string, error) {
	handle, _, openErr := procOpenProcess.Call(uintptr(processQueryLimitedInformation), 0, uintptr(pid))
	if handle == 0 || handle == invalidHandleVal {
		if openErr == errorInvalidParameter {
			return "", os.ErrProcessDone
		}
		return "", openErr
	}
	defer procCloseHandle.Call(handle)

	// MAX_PATH is not a hard limit when long-path support is enabled. Start
	// with a generous buffer and retry with a larger one if Windows reports
	// that the path was truncated.
	for capacity := uint32(1024); capacity <= 32768; capacity *= 2 {
		buffer := make([]uint16, capacity)
		length := capacity
		result, _, callErr := procQueryFullProcessImageNameW.Call(
			handle,
			0,
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(unsafe.Pointer(&length)),
		)
		if result != 0 {
			return syscall.UTF16ToString(buffer[:length]), nil
		}
		if callErr != syscall.Errno(122) { // ERROR_INSUFFICIENT_BUFFER
			return "", callErr
		}
	}
	return "", errors.New("parent process image path exceeds supported length")
}

func sameWindowsPath(left string, right string) bool {
	clean := func(value string) string {
		value = strings.TrimSpace(strings.ReplaceAll(value, "/", "\\"))
		value = strings.TrimPrefix(value, `\\?\`)
		return strings.ToLower(filepath.Clean(value))
	}
	return clean(left) == clean(right)
}
