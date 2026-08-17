package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
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
		TargetVersion: "0.5.1",
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
}

func TestReplacementProgressWeightsBytesAndFileCount(t *testing.T) {
	percent := replacementProgressPercent(50, 100, 75, 100)
	if percent != 67 {
		t.Fatalf("expected weighted progress 67, got %d", percent)
	}
	if percent := replacementProgressPercent(0, 0, 0, 0); percent != 100 {
		t.Fatalf("expected empty replacement to be complete, got %d", percent)
	}
}

func TestCopyReplacementFilesReportsNestedProgress(t *testing.T) {
	previousFastMove := tryFastMoveReplacement
	previousInterval := replacementProgressEmitInterval
	tryFastMoveReplacement = func(string, string) (bool, error) {
		return false, nil
	}
	replacementProgressEmitInterval = 0
	t.Cleanup(func() {
		tryFastMoveReplacement = previousFastMove
		replacementProgressEmitInterval = previousInterval
	})

	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	rootDir := filepath.Join(dir, "portable")
	for _, path := range []string{
		filepath.Join(stagingDir, "resources", "openclaw"),
		filepath.Join(stagingDir, "UClawData"),
		filepath.Join(rootDir, "UClawData"),
	} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(stagingDir, "resources", "app.asar"):                 strings.Repeat("a", 1024*1024+17),
		filepath.Join(stagingDir, "resources", "openclaw", "package.json"): "new runtime",
		filepath.Join(stagingDir, "portable.flag"):                         "portable",
		filepath.Join(stagingDir, "UClawData", ".keep"):                    "",
		filepath.Join(rootDir, "UClawData", "account.json"):                "preserve me",
	}
	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	progress := make([]replacementCopyProgress, 0, 16)
	copied, err := copyReplacementFiles(stagingDir, rootDir, "UClawData", func(snapshot replacementCopyProgress) {
		progress = append(progress, snapshot)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(copied) != 2 {
		t.Fatalf("expected two copied top-level entries, got %v", copied)
	}
	if len(progress) < 4 {
		t.Fatalf("expected internal copy progress, got %d updates", len(progress))
	}
	final := progress[len(progress)-1]
	if final.Percent != 100 || final.CompletedFiles != final.TotalFiles || final.CompletedBytes != final.TotalBytes {
		t.Fatalf("expected complete final progress, got %+v", final)
	}
	foundNestedProgress := false
	for _, snapshot := range progress {
		if snapshot.CurrentEntry == "resources" && snapshot.CompletedBytes > 0 && snapshot.CompletedBytes < snapshot.TotalBytes {
			foundNestedProgress = true
			break
		}
	}
	if !foundNestedProgress {
		t.Fatalf("expected byte-level progress while resources was being copied: %+v", progress)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "resources", "openclaw", "package.json")); err != nil || string(raw) != "new runtime" {
		t.Fatalf("expected nested runtime file, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "preserve me" {
		t.Fatalf("expected user data preserved, got %q err=%v", string(raw), err)
	}
}

func TestCopyReplacementFilesUsesFastMove(t *testing.T) {
	previousFastMove := tryFastMoveReplacement
	tryFastMoveReplacement = func(src string, dst string) (bool, error) {
		if err := os.Rename(src, dst); err != nil {
			return false, err
		}
		return true, nil
	}
	t.Cleanup(func() {
		tryFastMoveReplacement = previousFastMove
	})

	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	rootDir := filepath.Join(dir, "portable")
	if err := os.MkdirAll(filepath.Join(stagingDir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "resources", "app.asar"), []byte("new app"), 0o600); err != nil {
		t.Fatal(err)
	}

	var final replacementCopyProgress
	if _, err := copyReplacementFiles(stagingDir, rootDir, "UClawData", func(snapshot replacementCopyProgress) {
		final = snapshot
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stagingDir, "resources")); !os.IsNotExist(err) {
		t.Fatalf("expected staging resources to be moved, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "resources", "app.asar")); err != nil || string(raw) != "new app" {
		t.Fatalf("expected moved app.asar, got %q err=%v", string(raw), err)
	}
	if final.Percent != 100 || final.CompletedFiles != 1 || final.CompletedBytes != int64(len("new app")) {
		t.Fatalf("expected fast move to report complete progress, got %+v", final)
	}
}

func TestWaitForUpdatedAppReadyAcceptsMatchingLiveProcess(t *testing.T) {
	readyPath := filepath.Join(t.TempDir(), "ready.json")
	cmd := exec.Command(os.Args[0], "-test.run=TestPortableUpdaterProcessHelper")
	cmd.Env = append(
		os.Environ(),
		"UCLAW_PORTABLE_UPDATER_TEST_PROCESS_HELPER=ready",
		"UCLAW_PORTABLE_UPDATE_READY_PATH="+readyPath,
		"UCLAW_PORTABLE_UPDATE_TARGET_VERSION=0.5.1",
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	if err := waitForUpdatedAppReady(readyPath, "0.5.1", cmd, 5*time.Second); err != nil {
		t.Fatalf("expected matching live process to become ready, got %v", err)
	}
}

func TestWaitForUpdatedAppReadyRejectsImmediateExit(t *testing.T) {
	readyPath := filepath.Join(t.TempDir(), "ready.json")
	cmd := exec.Command(os.Args[0], "-test.run=TestPortableUpdaterProcessHelper")
	cmd.Env = append(os.Environ(), "UCLAW_PORTABLE_UPDATER_TEST_PROCESS_HELPER=exit")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	err := waitForUpdatedAppReady(readyPath, "0.5.1", cmd, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "exited before it became ready") {
		t.Fatalf("expected immediate-exit failure, got %v", err)
	}
}

func TestPortableUpdaterProcessHelper(t *testing.T) {
	mode := os.Getenv("UCLAW_PORTABLE_UPDATER_TEST_PROCESS_HELPER")
	if mode == "" {
		return
	}
	if mode == "exit" {
		return
	}
	readyPath := os.Getenv("UCLAW_PORTABLE_UPDATE_READY_PATH")
	version := os.Getenv("UCLAW_PORTABLE_UPDATE_TARGET_VERSION")
	marker := fmt.Sprintf(`{"version":%q,"pid":%d,"readyAt":"2026-07-29T00:00:00Z"}`, version, os.Getpid())
	if err := os.WriteFile(readyPath, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
}

func TestApplyReplacesPackageEntriesAndPreservesUserFiles(t *testing.T) {
	if testing.Short() {
		t.Skip("integration-style filesystem test")
	}
	previousStartUpdatedApp := startUpdatedApp
	startUpdatedApp = func(_ string, _ string, readyPath string) (*exec.Cmd, error) {
		cmd := exec.Command(os.Args[0], "-test.run=TestPortableUpdaterProcessHelper")
		cmd.Env = append(
			os.Environ(),
			"UCLAW_PORTABLE_UPDATER_TEST_PROCESS_HELPER=ready",
			"UCLAW_PORTABLE_UPDATE_READY_PATH="+readyPath,
			"UCLAW_PORTABLE_UPDATE_TARGET_VERSION=0.5.0",
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
	if err := os.WriteFile(filepath.Join(rootDir, "resources", "old", "ffmpeg.exe"), []byte("legacy ffmpeg"), 0o755); err != nil {
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
	if _, err := os.Stat(filepath.Join(rootDir, "resources", "old", "ffmpeg.exe")); !os.IsNotExist(err) {
		t.Fatalf("expected legacy FFmpeg removed with the old resources directory, got %v", err)
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
	previousFastMove := tryFastMoveReplacement
	startUpdatedApp = func(string, string, string) (*exec.Cmd, error) {
		return nil, errors.New("launch failed")
	}
	tryFastMoveReplacement = func(src string, dst string) (bool, error) {
		if err := os.Rename(src, dst); err != nil {
			return false, err
		}
		return true, nil
	}
	t.Cleanup(func() {
		startUpdatedApp = previousStartUpdatedApp
		tryFastMoveReplacement = previousFastMove
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	zipPath := filepath.Join(dir, "update.zip")
	for _, path := range []string{
		filepath.Join(rootDir, "resources", "bin"),
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
	if err := os.WriteFile(filepath.Join(rootDir, "resources", "bin", "ffmpeg.exe"), []byte("legacy ffmpeg"), 0o755); err != nil {
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
		ReadyPath:     filepath.Join(dir, "ready.json"),
	}}

	if _, _, _, err := updater.apply(); err == nil || !strings.Contains(err.Error(), "launch failed") {
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
	if raw, err := os.ReadFile(filepath.Join(rootDir, "resources", "bin", "ffmpeg.exe")); err != nil || string(raw) != "legacy ffmpeg" {
		t.Fatalf("expected legacy FFmpeg restored with the previous resources directory, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "user data" {
		t.Fatalf("expected user data preserved, got %q err=%v", string(raw), err)
	}
}
