//go:build windows

package main

import "os/exec"

func configureUpdatedAppProcessGroup(_ *exec.Cmd) {}
