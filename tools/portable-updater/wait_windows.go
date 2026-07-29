//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	synchronize      = 0x00100000
	waitObject0      = 0x00000000
	waitTimeout      = 0x00000102
	waitFailed       = 0xFFFFFFFF
	timeoutChunkMs   = 500
	invalidHandleVal = ^uintptr(0)
	th32CSProcess    = 0x00000002
	maxExeFile       = 260
	// The app is asked to quit before the helper starts. If Electron helpers
	// still retain installation files after this grace period, they belong to
	// the update the user explicitly accepted and must be stopped before rename.
	gracefulExitWait = 15 * time.Second
	// OpenProcess reports ERROR_INVALID_PARAMETER when the target PID no
	// longer exists. syscall does not export this Win32 constant on every Go
	// release used for cross-compilation.
	errorInvalidParameter = syscall.Errno(87)
	errorNoMoreFiles      = syscall.Errno(18)
)

type processEntry32 struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [maxExeFile]uint16
}

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess         = kernel32.NewProc("OpenProcess")
	procWaitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
	procCreateToolhelp32    = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW     = kernel32.NewProc("Process32FirstW")
	procProcess32NextW      = kernel32.NewProc("Process32NextW")
)

func waitForParentExit(pid int, timeout time.Duration, logf func(string, ...any)) error {
	deadline := time.Now().Add(timeout)
	forceAfter := time.Now().Add(gracefulExitWait)
	children := make(map[int]struct{})
	forced := false
	for {
		descendants, err := snapshotDescendantPIDs(pid)
		if err != nil {
			return fmt.Errorf("failed to snapshot UClaw child processes before update: %w", err)
		}
		for _, childPID := range descendants {
			if _, known := children[childPID]; !known {
				children[childPID] = struct{}{}
				logf("observed UClaw child process %d while waiting for parent process %d", childPID, pid)
			}
		}

		parentExited, err := processHasExited(pid)
		if err != nil {
			return fmt.Errorf("cannot inspect parent process %d while waiting for exit: %w", pid, err)
		}
		allExited := parentExited
		for childPID := range children {
			exited, err := processHasExited(childPID)
			if err != nil {
				return fmt.Errorf("cannot inspect child process %d while waiting for exit: %w", childPID, err)
			}
			if exited {
				delete(children, childPID)
				logf("child process %d has exited", childPID)
				continue
			}
			allExited = false
		}
		if parentExited && allExited && len(descendants) == 0 {
			logf("parent process %d and all observed child processes have exited", pid)
			return nil
		}
		if !forced && time.Now().After(forceAfter) {
			forced = true
			pids := make([]int, 0, len(children)+1)
			pids = append(pids, pid)
			for childPID := range children {
				pids = append(pids, childPID)
			}
			logf("UClaw process tree did not exit within %s; force-stopping the original app processes before replacement", gracefulExitWait)
			forceStopWindowsProcesses(pids, logf)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting %s for parent process %d and its child processes to exit", timeout, pid)
		}
		time.Sleep(time.Duration(timeoutChunkMs) * time.Millisecond)
	}
}

// forceStopWindowsProcesses only receives the original main process and the
// descendants observed before it exited. taskkill /T covers descendants that
// still have their original parent; individual PIDs cover renderer/GPU
// processes that Windows re-parented during shutdown.
func forceStopWindowsProcesses(pids []int, logf func(string, ...any)) {
	unique := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		if pid > 0 {
			unique[pid] = struct{}{}
		}
	}
	ordered := make([]int, 0, len(unique))
	for pid := range unique {
		ordered = append(ordered, pid)
	}
	sort.Ints(ordered)
	for _, pid := range ordered {
		exited, err := processHasExited(pid)
		if err != nil {
			logf("cannot inspect original UClaw process %d before force-stop: %v", pid, err)
			continue
		}
		if exited {
			continue
		}
		output, err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F").CombinedOutput()
		if err != nil {
			logf("taskkill could not force-stop original UClaw process %d: %v (%s)", pid, err, strings.TrimSpace(string(output)))
			continue
		}
		logf("force-stopped original UClaw process %d", pid)
	}
}

func snapshotDescendantPIDs(rootPID int) ([]int, error) {
	snapshot, _, err := procCreateToolhelp32.Call(uintptr(th32CSProcess), 0)
	if snapshot == invalidHandleVal {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot failed: %w", err)
	}
	defer procCloseHandle.Call(snapshot)

	entries := make([]processEntry32, 0, 16)
	entry := processEntry32{Size: uint32(unsafe.Sizeof(processEntry32{}))}
	result, _, callErr := procProcess32FirstW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	if result == 0 {
		return nil, fmt.Errorf("Process32FirstW failed: %w", callErr)
	}
	for {
		entries = append(entries, entry)
		entry = processEntry32{Size: uint32(unsafe.Sizeof(processEntry32{}))}
		result, _, callErr = procProcess32NextW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
		if result != 0 {
			continue
		}
		if callErr == errorNoMoreFiles {
			break
		}
		return nil, fmt.Errorf("Process32NextW failed: %w", callErr)
	}

	selfPID := uint32(os.Getpid())
	known := map[uint32]struct{}{uint32(rootPID): struct{}{}}
	seen := make(map[uint32]struct{})
	for changed := true; changed; {
		changed = false
		for _, candidate := range entries {
			if candidate.ProcessID == selfPID {
				continue
			}
			if _, parentKnown := known[candidate.ParentProcessID]; !parentKnown {
				continue
			}
			if _, alreadyKnown := known[candidate.ProcessID]; alreadyKnown {
				continue
			}
			known[candidate.ProcessID] = struct{}{}
			seen[candidate.ProcessID] = struct{}{}
			changed = true
		}
	}

	pids := make([]int, 0, len(seen))
	for childPID := range seen {
		pids = append(pids, int(childPID))
	}
	sort.Ints(pids)
	return pids, nil
}

func waitForProcessExit(pid int, deadline time.Time, role string, logf func(string, ...any)) error {
	for {
		exited, err := processHasExited(pid)
		if err != nil {
			return fmt.Errorf("cannot inspect %s %d while waiting for exit: %w", role, pid, err)
		}
		if exited {
			logf("%s %d has exited", role, pid)
			return nil
		}
		if time.Until(deadline) <= 0 {
			return fmt.Errorf("timed out waiting for %s %d to exit", role, pid)
		}
		time.Sleep(time.Duration(timeoutChunkMs) * time.Millisecond)
	}
}

func processHasExited(pid int) (bool, error) {
	handle, _, err := procOpenProcess.Call(uintptr(synchronize), 0, uintptr(pid))
	if handle == 0 || handle == invalidHandleVal {
		if err == errorInvalidParameter {
			return true, nil
		}
		return false, err
	}
	defer procCloseHandle.Call(handle)

	result, _, waitErr := procWaitForSingleObject.Call(handle, 0)
	switch result {
	case waitObject0:
		return true, nil
	case waitTimeout:
		return false, nil
	case waitFailed:
		return false, waitErr
	default:
		return false, fmt.Errorf("unexpected wait result %d", result)
	}
}
