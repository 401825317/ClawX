//go:build !darwin

package main

func directoryWriteAccess(string) error {
	return nil
}
