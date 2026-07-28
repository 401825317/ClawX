package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
		TargetVersion: "0.5.0",
		ReadyPath:     filepath.Join(dir, "ready.json"),
		Sha512:        "abc",
		Size:          3,
	}

	err := validateTask(&task)
	if err == nil || err.Error() != "rootDir is missing portable.flag" {
		t.Fatalf("expected portable.flag error, got %v", err)
	}
}

func TestCreateBackupDirUsesUniqueAttemptPaths(t *testing.T) {
	rootDir := t.TempDir()
	updater := updater{task: updateTask{RootDir: rootDir}}
	first, err := updater.createBackupDir()
	if err != nil {
		t.Fatal(err)
	}
	second, err := updater.createBackupDir()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("backup attempts reused %s", first)
	}
	for _, path := range []string{first, second} {
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			t.Fatalf("backup path %s was not created as a directory: %v", path, err)
		}
	}
}

func TestSameReleaseVersionAcceptsTagAndBuildMetadataForms(t *testing.T) {
	if !sameReleaseVersion("1.0.5", "v1.0.5") {
		t.Fatal("expected package and tag version forms to match")
	}
	if !sameReleaseVersion("1.0.5+build.12", "1.0.5") {
		t.Fatal("expected SemVer build metadata to be ignored")
	}
	if sameReleaseVersion("1.0.5-beta.1", "1.0.5") {
		t.Fatal("expected prerelease and stable versions to differ")
	}
}

func TestExtractZipRejectsUnsafePathBeforePlatformExtraction(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "unsafe.zip")
	output, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(output)
	entry, err := writer.Create("../outside.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("unsafe")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}

	err = extractZip(zipPath, filepath.Join(dir, "staging"), nil)
	if err == nil || err.Error() != "unsafe zip entry path: ../outside.txt" {
		t.Fatalf("expected unsafe path rejection, got %v", err)
	}
}

func TestExtractZipPreservesMacOSAppMetadata(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS-specific ditto extraction")
	}

	dir := t.TempDir()
	sourceRoot := filepath.Join(dir, "source")
	sourceExecutable := filepath.Join(sourceRoot, "UClaw.app", "Contents", "MacOS", "UClaw")
	if err := os.MkdirAll(filepath.Dir(sourceExecutable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceExecutable, []byte("uclaw"), 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("/usr/bin/xattr", "-w", "com.example.uclaw", "preserved", sourceExecutable).CombinedOutput(); err != nil {
		t.Fatalf("set macOS test metadata: %v (%s)", err, output)
	}

	zipPath := filepath.Join(dir, "update.zip")
	if output, err := exec.Command("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", sourceRoot, zipPath).CombinedOutput(); err != nil {
		t.Fatalf("create macOS test archive: %v (%s)", err, output)
	}
	destRoot := filepath.Join(dir, "staging")
	if err := extractZip(zipPath, destRoot, nil); err != nil {
		t.Fatal(err)
	}

	destExecutable := filepath.Join(destRoot, "UClaw.app", "Contents", "MacOS", "UClaw")
	output, err := exec.Command("/usr/bin/xattr", "-p", "com.example.uclaw", destExecutable).CombinedOutput()
	if err != nil {
		t.Fatalf("read restored macOS metadata: %v (%s)", err, output)
	}
	if string(output) != "preserved\n" {
		t.Fatalf("unexpected restored macOS metadata: %q", output)
	}
}

func TestApplyReplacesPackageEntriesAndPreservesUserFiles(t *testing.T) {
	if testing.Short() {
		t.Skip("integration-style filesystem test")
	}
	previousStartUpdatedApp := startUpdatedApp
	startUpdatedApp = func(_ string, _ string, readyPath string) (*exec.Cmd, error) {
		cmd := exec.Command(os.Args[0], "-test.run=TestPortableUpdaterReadyHelper")
		cmd.Env = append(
			os.Environ(),
			"UCLAW_PORTABLE_UPDATER_TEST_READY_HELPER=1",
			"UCLAW_PORTABLE_UPDATE_READY_PATH="+readyPath,
		)
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return cmd, nil
	}
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
		ReadyPath:     filepath.Join(dir, "ready.json"),
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

func TestPortableUpdaterReadyHelper(t *testing.T) {
	if os.Getenv("UCLAW_PORTABLE_UPDATER_TEST_READY_HELPER") != "1" {
		return
	}
	readyPath := os.Getenv("UCLAW_PORTABLE_UPDATE_READY_PATH")
	if readyPath == "" {
		t.Fatal("missing ready path")
	}
	marker := fmt.Sprintf(`{"version":"0.5.0","pid":%d,"readyAt":"2026-07-28T00:00:00Z"}`, os.Getpid())
	if err := os.WriteFile(readyPath, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	// Keep the child alive past startupReadyGrace so the updater can distinguish
	// a ready app from one that immediately exits.
	time.Sleep(2 * time.Second)
}
