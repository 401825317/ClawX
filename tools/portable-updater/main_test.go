package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeZipForTest(t *testing.T, path string, files map[string]string) (size int64, hash string) {
	t.Helper()
	output, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(output)
	for name, content := range files {
		fileWriter, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fileWriter.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(raw)
	return int64(len(raw)), hex.EncodeToString(sum[:])
}

func TestValidateTaskRequiresPortableRootMarker(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "update.zip")
	if err := os.WriteFile(zipPath, []byte("zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	task := updateTask{
		ZipPath:     zipPath,
		RootDir:     dir,
		LaunchPath:  filepath.Join(dir, "UClaw.exe"),
		Sha512:      "abc",
		Size:        3,
		AckPath:     filepath.Join(dir, "updates", "acks", "startup.json"),
		PendingPath: filepath.Join(dir, "updates", "pending-startup.json"),
	}

	err := validateTask(&task)
	if err == nil || err.Error() != "rootDir is missing portable.flag" {
		t.Fatalf("expected portable.flag error, got %v", err)
	}
}

func TestApplyReplacesPackageEntriesAndPreservesUserFiles(t *testing.T) {
	if testing.Short() {
		t.Skip("integration-style filesystem test")
	}
	previousStartUpdatedApp := startUpdatedApp
	previousAwaitUpdatedAppStartup := awaitUpdatedAppStartup
	startUpdatedApp = func(string, string) (int, error) { return 101, nil }
	awaitUpdatedAppStartup = func(string, string, time.Duration) error { return nil }
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
		awaitUpdatedAppStartup = previousAwaitUpdatedAppStartup
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	zipPath := filepath.Join(dir, "update.zip")
	taskPath := filepath.Join(dir, "task.json")
	for _, path := range []string{
		filepath.Join(rootDir, "resources", "old"),
		filepath.Join(rootDir, "UClawData"),
	} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootDir, "portable.flag"), []byte("old marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "UClaw.exe"), []byte("old exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "user-notes.txt"), []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "UClawData", "account.json"), []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}

	size, hash := writeZipForTest(t, zipPath, map[string]string{
		"portable.flag":      "new marker",
		"UClaw.exe":          "new exe",
		"resources/app.asar": "new app",
		"UClawData/.keep":    "",
	})
	task := updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    filepath.Join(rootDir, "UClaw.exe"),
		TargetVersion: "0.5.0",
		Sha512:        hash,
		Size:          size,
		StagingDir:    filepath.Join(dir, "staging"),
		AckPath:       filepath.Join(dir, "updates", "acks", "startup.json"),
		PendingPath:   filepath.Join(dir, "updates", "pending-startup.json"),
	}
	updater := updater{task: task, taskPath: taskPath}

	backupDir, _, _, err := updater.apply()
	if err != nil {
		t.Fatal(err)
	}

	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClaw.exe")); err != nil || string(raw) != "new exe" {
		t.Fatalf("expected updated exe, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "user-notes.txt")); err != nil || string(raw) != "keep me" {
		t.Fatalf("expected user file preserved, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "user data" {
		t.Fatalf("expected data preserved, got %q err=%v", string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(backupDir, "user-notes.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected unrelated user file not to be moved to backup, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(backupDir, "UClaw.exe")); err != nil || string(raw) != "old exe" {
		t.Fatalf("expected old exe backup, got %q err=%v", string(raw), err)
	}
}

func TestApplyRestoresPreviousVersionWhenStartupIsNotAcknowledged(t *testing.T) {
	if testing.Short() {
		t.Skip("integration-style filesystem test")
	}
	previousStartUpdatedApp := startUpdatedApp
	previousStopUpdatedApp := stopUpdatedApp
	previousAwaitUpdatedAppStartup := awaitUpdatedAppStartup
	startCalls := 0
	startUpdatedApp = func(string, string) (int, error) {
		startCalls++
		return 200 + startCalls, nil
	}
	stoppedPID := 0
	stopUpdatedApp = func(_ string, _ string, pid int) error {
		stoppedPID = pid
		return nil
	}
	awaitUpdatedAppStartup = func(string, string, time.Duration) error {
		return errors.New("startup acknowledgement timed out")
	}
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
		stopUpdatedApp = previousStopUpdatedApp
		awaitUpdatedAppStartup = previousAwaitUpdatedAppStartup
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	zipPath := filepath.Join(dir, "update.zip")
	for _, path := range []string{
		rootDir,
		filepath.Join(rootDir, "UClawData"),
	} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootDir, "portable.flag"), []byte("old marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "UClaw.exe"), []byte("old exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "UClawData", "account.json"), []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}

	size, hash := writeZipForTest(t, zipPath, map[string]string{
		"portable.flag":      "new marker",
		"UClaw.exe":          "new exe",
		"resources/app.asar": "new app",
	})
	updater := updater{task: updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    filepath.Join(rootDir, "UClaw.exe"),
		TargetVersion: "0.5.0",
		Sha512:        hash,
		Size:          size,
		StagingDir:    filepath.Join(dir, "staging"),
		AckPath:       filepath.Join(dir, "updates", "acks", "startup.json"),
		PendingPath:   filepath.Join(dir, "updates", "pending-startup.json"),
	}}

	if _, _, _, err := updater.apply(); err == nil || !strings.Contains(err.Error(), "startup acknowledgement timed out") {
		t.Fatalf("expected startup acknowledgement failure, got %v", err)
	}
	if startCalls != 2 {
		t.Fatalf("expected new launch and restored launch, got %d", startCalls)
	}
	if stoppedPID != 201 {
		t.Fatalf("expected rollback to stop the newly launched pid 201, got %d", stoppedPID)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClaw.exe")); err != nil || string(raw) != "old exe" {
		t.Fatalf("expected previous executable restored, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "user data" {
		t.Fatalf("expected portable user data preserved, got %q err=%v", string(raw), err)
	}
}

func TestStopUpdatedAppCommandUsesWindowsPID(t *testing.T) {
	command, args, err := stopUpdatedAppCommand("windows", `D:\\UClaw\\UClaw.exe`, 321)
	if err != nil {
		t.Fatal(err)
	}
	if command != "taskkill" {
		t.Fatalf("expected taskkill command, got %q", command)
	}
	expectedArgs := []string{"/F", "/T", "/PID", "321"}
	if strings.Join(args, " ") != strings.Join(expectedArgs, " ") {
		t.Fatalf("expected %v, got %v", expectedArgs, args)
	}

	if _, _, err := stopUpdatedAppCommand("windows", `D:\\UClaw\\UClaw.exe`, 0); err == nil {
		t.Fatal("expected missing pid to fail closed")
	}
}
