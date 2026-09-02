//go:build darwin

package main

import (
	"fmt"
	"os"
	"syscall"
)

const writeAccess = 2
const executeAccess = 1

func directoryWriteAccess(path string) error {
	if err := syscall.Access(path, writeAccess|executeAccess); err != nil {
		return err
	}

	// `access(2)` only answers whether the effective permissions appear to
	// allow a write.  It can still report success for a root process on a
	// read-only mount, and it does not account for every ACL/volume policy.
	// The updater is about to create/rename/remove entries in this directory,
	// so perform the same kind of non-destructive mutation now.  CreateTemp
	// uses O_EXCL and a random name, avoiding an existing user file; always
	// remove the probe before returning so this check leaves no durable state.
	probe, err := os.CreateTemp(path, ".uclaw-write-probe-")
	if err != nil {
		return err
	}
	probePath := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(probePath)
	if closeErr != nil {
		if removeErr != nil {
			return fmt.Errorf("close write probe: %w (remove probe: %v)", closeErr, removeErr)
		}
		return closeErr
	}
	if removeErr != nil {
		return fmt.Errorf("remove write probe: %w", removeErr)
	}
	return nil
}
