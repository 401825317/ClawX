package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
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
		ZipPath:    zipPath,
		RootDir:    dir,
		LaunchPath: filepath.Join(dir, "UClaw.exe"),
		Sha512:     "abc",
		Size:       3,
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
	startUpdatedApp = func(string, string) error { return nil }
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
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

func TestApplyRollsBackWhenUpdatedAppFailsToStart(t *testing.T) {
	previousStartUpdatedApp := startUpdatedApp
	startUpdatedApp = func(string, string) error { return errors.New("launch failed") }
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	zipPath := filepath.Join(dir, "update.zip")
	if err := os.MkdirAll(filepath.Join(rootDir, "UClawData"), 0o755); err != nil {
		t.Fatal(err)
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
		"new-only.txt":       "remove on rollback",
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
	}}

	if _, _, _, err := updater.apply(); err == nil || err.Error() != "launch failed" {
		t.Fatalf("expected launch failure, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClaw.exe")); err != nil || string(raw) != "old exe" {
		t.Fatalf("expected old executable restored, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "portable.flag")); err != nil || string(raw) != "old marker" {
		t.Fatalf("expected old portable marker restored, got %q err=%v", string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "new-only.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected new-only file removed during rollback, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "user data" {
		t.Fatalf("expected user data preserved, got %q err=%v", string(raw), err)
	}
}
