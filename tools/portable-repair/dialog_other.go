//go:build !windows

package main

func confirmSafeRepair() bool {
	return false
}

func showFinalMessage(_ string, _ string) {}
