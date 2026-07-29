//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// The restarted app gets its own process group so a failed readiness check can
// stop Electron's main, renderer, GPU, and helper processes before rollback.
func configureUpdatedAppProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
