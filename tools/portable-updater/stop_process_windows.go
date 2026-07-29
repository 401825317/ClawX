//go:build windows

package main

import (
	"fmt"
	"time"
)

// The helper owns this newly launched process, so force-stopping its tree on
// a failed startup is safe. It avoids leaving Electron renderer/GPU children
// holding files while the previous version is restored.
func stopUpdatedAppProcessTree(pid int, timeout time.Duration, logf func(string, ...any)) error {
	descendants, err := snapshotDescendantPIDs(pid)
	if err != nil {
		return fmt.Errorf("failed to snapshot updated app child processes: %w", err)
	}

	forceStopWindowsProcesses(append([]int{pid}, descendants...), logf)

	deadline := time.Now().Add(timeout)
	if err := waitForProcessExit(pid, deadline, "updated app process", logf); err != nil {
		return err
	}
	for _, childPID := range descendants {
		if err := waitForProcessExit(childPID, deadline, "updated app child process", logf); err != nil {
			return err
		}
	}
	return nil
}
