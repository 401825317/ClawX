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
		ZipPath:       zipPath,
		RootDir:       dir,
		LaunchPath:    filepath.Join(dir, "UClaw.exe"),
		TargetVersion: "1.0.2",
		Sha512:        "abc",
		Size:          3,
		AckPath:       filepath.Join(dir, "updates", "acks", "startup.json"),
		PendingPath:   filepath.Join(dir, "updates", "pending-startup.json"),
	}

	err := validateTask(&task)
	if err == nil || err.Error() != "rootDir is missing portable.flag" {
		t.Fatalf("expected portable.flag error, got %v", err)
	}
}

func TestVerifyZipRejectsSizeAndSha512Mismatch(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "update.zip")
	size, hash := writeZipForTest(t, zipPath, map[string]string{
		"portable.flag": "marker",
		"UClaw.exe":     "binary",
	})

	if err := verifyZip(zipPath, size+1, hash); err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch, got %v", err)
	}
	invalidHash := strings.Repeat("0", 128)
	if err := verifyZip(zipPath, size, invalidHash); err == nil || !strings.Contains(err.Error(), "sha512 mismatch") {
		t.Fatalf("expected sha512 mismatch, got %v", err)
	}
	if err := verifyZip(zipPath, size, hash); err != nil {
		t.Fatalf("expected matching update package, got %v", err)
	}
}

func TestExtractZipRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "unsafe.zip")
	writeZipForTest(t, zipPath, map[string]string{
		"../outside.txt": "must not escape",
	})
	destination := filepath.Join(dir, "staging")
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}

	err := extractZip(zipPath, destination, nil)
	if err == nil || (!strings.Contains(err.Error(), "unsafe zip entry") && !strings.Contains(err.Error(), "escapes staging")) {
		t.Fatalf("expected unsafe zip path rejection, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "outside.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected no file outside staging, got %v", err)
	}
}

func TestApplyRestartsPreviousVersionWhenArchiveCannotBeExtracted(t *testing.T) {
	previousStartUpdatedApp := startUpdatedApp
	startCalls := 0
	startedPath := ""
	startUpdatedApp = func(path string, _ string) (int, error) {
		startCalls++
		startedPath = path
		return 101, nil
	}
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	dataDir := filepath.Join(rootDir, "UClawData")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	launchPath := filepath.Join(rootDir, "UClaw.exe")
	if err := os.WriteFile(launchPath, []byte("old exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "account.json"), []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}

	invalidArchive := []byte("not a zip archive")
	zipPath := filepath.Join(dir, "invalid-update.zip")
	if err := os.WriteFile(zipPath, invalidArchive, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(invalidArchive)
	stagingDir := filepath.Join(dir, "staging")
	updater := updater{task: updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    launchPath,
		TargetVersion: "1.0.2",
		Sha512:        hex.EncodeToString(sum[:]),
		Size:          int64(len(invalidArchive)),
		StagingDir:    stagingDir,
		AckPath:       filepath.Join(dir, "updates", "acks", "startup.json"),
		PendingPath:   filepath.Join(dir, "updates", "pending-startup.json"),
	}}

	_, returnedStagingDir, _, err := updater.apply()
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "zip") {
		t.Fatalf("expected invalid archive failure, got %v", err)
	}
	if returnedStagingDir != stagingDir {
		t.Fatalf("expected staging path %s, got %s", stagingDir, returnedStagingDir)
	}
	if startCalls != 1 || startedPath != launchPath {
		t.Fatalf("expected previous app restart at %s, calls=%d path=%s", launchPath, startCalls, startedPath)
	}
	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("expected failed staging directory cleanup, got %v", err)
	}
	if raw, err := os.ReadFile(launchPath); err != nil || string(raw) != "old exe" {
		t.Fatalf("expected previous executable unchanged, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(dataDir, "account.json")); err != nil || string(raw) != "user data" {
		t.Fatalf("expected portable user data unchanged, got %q err=%v", string(raw), err)
	}
}

func TestApplyReplacesPackageEntriesAndPreservesUserFiles(t *testing.T) {
	if testing.Short() {
		t.Skip("integration-style filesystem test")
	}
	previousStartUpdatedApp := startUpdatedApp
	previousAwaitUpdatedAppStartup := awaitUpdatedAppStartup
	startUpdatedApp = func(string, string) (int, error) { return 101, nil }
	awaitUpdatedAppStartup = func(string, string, string, time.Duration) error { return nil }
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
	awaitUpdatedAppStartup = func(string, string, string, time.Duration) error {
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

func TestWaitForParentExitFailsClosedOnTimeout(t *testing.T) {
	err := waitForParentExit(os.Getpid(), 10*time.Millisecond, func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "timed out waiting for parent process") {
		t.Fatalf("expected parent wait timeout, got %v", err)
	}
}

func TestWaitForStartupAckRequiresMatchingRootAndPID(t *testing.T) {
	dir := t.TempDir()
	ackPath := filepath.Join(dir, "startup.json")
	if err := os.WriteFile(ackPath, []byte(`{
  "version": 1,
  "ready": true,
  "targetVersion": "1.0.2",
  "rootDir": "other-root",
  "pid": 321
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	err := waitForStartupAck(ackPath, "1.0.2", dir, time.Second)
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected mismatched acknowledgement error, got %v", err)
	}
}

func TestCopyReplacementFilesTracksPartiallyWrittenEntry(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	rootDir := filepath.Join(dir, "root")
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(rootDir, "broken"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "broken"), []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}

	copied, err := copyReplacementFiles(stagingDir, rootDir, defaultDataDirName, nil)
	if err == nil {
		t.Fatal("expected copy failure when the destination is a directory")
	}
	if len(copied) != 1 || copied[0] != "broken" {
		t.Fatalf("expected failed entry to be tracked for rollback, got %v", copied)
	}
	if err := removeCopiedEntries(rootDir, copied); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "broken")); !os.IsNotExist(err) {
		t.Fatalf("expected partial destination removed, got %v", err)
	}
}

func TestShouldSkipPortableDataDirectoryCaseInsensitively(t *testing.T) {
	for _, name := range []string{"UClawData", "uclawdata", "UCLAWDATA"} {
		if !shouldSkipRootEntry(name, defaultDataDirName) {
			t.Fatalf("expected %s to be protected", name)
		}
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
