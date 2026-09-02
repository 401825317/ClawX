package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

func TestValidateParentPIDRejectsInvalidAndSelfProcessIDs(t *testing.T) {
	for _, pid := range []int{-1, 0, 1} {
		if err := validateParentPID(pid, ""); err == nil {
			t.Fatalf("expected parent PID %d to be rejected", pid)
		}
	}
	if err := validateParentPID(os.Getpid(), ""); err == nil {
		t.Fatal("expected the updater helper's own PID to be rejected")
	}
}

// newTaskForWorkspacePathTests creates a complete portable root using only
// temporary files. The macOS branch includes the required UClaw.app bundle so
// the same task-path checks run on both host platforms.
func newTaskForWorkspacePathTests(t *testing.T) (updateTask, string) {
	t.Helper()
	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	if err := os.MkdirAll(filepath.Join(rootDir, defaultDataDirName), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "portable.flag"), []byte("portable\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var launchPath string
	if runtime.GOOS == "darwin" {
		launchPath = filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw")
		if err := os.MkdirAll(filepath.Dir(launchPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(launchPath, []byte("executable"), 0o755); err != nil {
			t.Fatal(err)
		}
	} else {
		launchPath = filepath.Join(rootDir, "UClaw.exe")
		if err := os.WriteFile(launchPath, []byte("executable"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	zipPath := filepath.Join(dir, "update.zip")
	size, hash := writeZipForTest(t, zipPath, map[string]string{
		"portable.flag": "portable\n",
	})
	return updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   defaultDataDirName,
		LaunchPath:    launchPath,
		TargetVersion: "2.0.4",
		Sha512:        hash,
		Size:          size,
		StagingDir:    filepath.Join(dir, "staging"),
		ReadyPath:     filepath.Join(dir, "ready", "update.ready.json"),
		LogPath:       filepath.Join(dir, "logs", "update.log"),
	}, dir
}

func TestValidateTaskRejectsWorkspacePathsThatOverlapRoot(t *testing.T) {
	baseTask, dir := newTaskForWorkspacePathTests(t)
	cases := []struct {
		name  string
		field string
		path  string
	}{
		{name: "staging equals root", field: "stagingDir", path: baseTask.RootDir},
		{name: "staging inside data", field: "stagingDir", path: filepath.Join(baseTask.RootDir, defaultDataDirName, "staging")},
		{name: "staging is root ancestor", field: "stagingDir", path: dir},
		{name: "ready inside root", field: "readyPath", path: filepath.Join(baseTask.RootDir, "ready.json")},
		{name: "log inside root", field: "logPath", path: filepath.Join(baseTask.RootDir, "logs", "update.log")},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			task := baseTask
			switch testCase.field {
			case "stagingDir":
				task.StagingDir = testCase.path
			case "readyPath":
				task.ReadyPath = testCase.path
			case "logPath":
				task.LogPath = testCase.path
			}
			err := validateTask(&task)
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(testCase.field)) {
				t.Fatalf("expected %s containment error, got %v", testCase.field, err)
			}
			if !strings.Contains(strings.ToLower(err.Error()), "outside rootdir") {
				t.Fatalf("expected root containment detail, got %v", err)
			}
		})
	}
}

func TestValidateTaskAcceptsExternalWorkspacePaths(t *testing.T) {
	task, dir := newTaskForWorkspacePathTests(t)
	task.StagingDir = filepath.Join(dir, "external-staging")
	task.ReadyPath = filepath.Join(dir, "external-ready", "update.ready.json")
	task.LogPath = filepath.Join(dir, "external-logs", "update.log")
	if err := validateTask(&task); err != nil {
		t.Fatalf("expected external temporary paths to be accepted, got %v", err)
	}
	if task.StagingDir != filepath.Clean(task.StagingDir) || task.ReadyPath != filepath.Clean(task.ReadyPath) || task.LogPath != filepath.Clean(task.LogPath) {
		t.Fatalf("expected task paths to be normalized: %+v", task)
	}
}

func TestValidateTaskAtPathBindsWorkspaceToTrustedUpdatesDirs(t *testing.T) {
	task, dir := newTaskForWorkspacePathTests(t)
	runtimeRoot := filepath.Join(dir, "runtime", "UClawRuntime")
	updatesRoot := filepath.Join(runtimeRoot, updatesDirName)
	tasksDir := filepath.Join(updatesRoot, tasksDirName)
	if err := os.MkdirAll(tasksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(updatesRoot, "UClaw-2.0.4-win-x64-usb.zip")
	if err := os.MkdirAll(updatesRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(task.ZipPath, zipPath); err != nil {
		t.Fatal(err)
	}
	task.ZipPath = zipPath
	stamp := "2026-09-02T12-00-00-000Z"
	taskPath := filepath.Join(tasksDir, taskFilePrefix+stamp+taskFileSuffix)
	task.StagingDir = filepath.Join(updatesRoot, stagingDirName, stamp)
	task.ReadyPath = filepath.Join(updatesRoot, readyDirName, taskFilePrefix+stamp+".ready.json")
	task.LogPath = filepath.Join(runtimeRoot, logsDirName, "portable-updater-"+stamp+".log")
	if raw, marshalErr := json.Marshal(task); marshalErr != nil {
		t.Fatal(marshalErr)
	} else if writeErr := os.WriteFile(taskPath, raw, 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	if err := validateTaskAtPath(&task, taskPath); err != nil {
		t.Fatalf("expected trusted runtime update paths to pass, got %v", err)
	}

	for _, field := range []struct {
		name  string
		value *string
	}{
		{name: "stagingDir", value: &task.StagingDir},
		{name: "readyPath", value: &task.ReadyPath},
		{name: "logPath", value: &task.LogPath},
	} {
		original := *field.value
		*field.value = filepath.Join(dir, "attacker", filepath.Base(original))
		err := validateTaskAtPath(&task, taskPath)
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(field.name)) {
			t.Fatalf("expected %s outside trusted workspace to be rejected, got %v", field.name, err)
		}
		*field.value = original
	}
}

func TestRunDoesNotWriteResultWhenTaskCannotBeRead(t *testing.T) {
	dir := t.TempDir()
	updatesRoot := filepath.Join(dir, updatesDirName)
	tasksDir := filepath.Join(updatesRoot, tasksDirName)
	if err := os.MkdirAll(tasksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stamp := "unreadable"
	taskPath := filepath.Join(tasksDir, taskFilePrefix+stamp+taskFileSuffix)
	if err := os.WriteFile(taskPath, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run(taskPath); code == 0 {
		t.Fatal("expected malformed task to fail")
	}
	if _, err := os.Stat(taskPath + resultSuffix); !os.IsNotExist(err) {
		t.Fatalf("malformed task unexpectedly created a result file: %v", err)
	}
}

func TestValidateTaskFilePathRejectsSymlinkAndUnexpectedLocations(t *testing.T) {
	dir := t.TempDir()
	validTasks := filepath.Join(dir, updatesDirName, tasksDirName)
	if err := os.MkdirAll(validTasks, 0o755); err != nil {
		t.Fatal(err)
	}
	validTask := filepath.Join(validTasks, taskFilePrefix+"attempt"+taskFileSuffix)
	if err := os.WriteFile(validTask, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateTaskFilePath(validTask); err != nil {
		t.Fatalf("expected canonical task path to pass, got %v", err)
	}
	for _, invalid := range []string{
		filepath.Join(dir, "task.json"),
		filepath.Join(dir, updatesDirName, "portable-update-attempt.json"),
		filepath.Join(dir, "cache", tasksDirName, "portable-update-attempt.json"),
	} {
		if err := validateTaskFilePath(invalid); err == nil {
			t.Fatalf("expected non-canonical task path %s to be rejected", invalid)
		}
	}
}

func TestInspectPathComponentsRejectsExistingTargetWithSymlinkAncestor(t *testing.T) {
	dir := t.TempDir()
	realDir := filepath.Join(dir, "real")
	if err := os.MkdirAll(filepath.Join(realDir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(dir, "link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		// Creating symlinks may require elevated privileges on Windows. The
		// production check is still covered on Unix/macOS CI; skip where the
		// filesystem policy disallows creating the fixture.
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	target := filepath.Join(linkDir, "nested", "existing.txt")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := inspectPathComponents(target, "test path"); err == nil || !strings.Contains(strings.ToLower(err.Error()), "symlink") {
		t.Fatalf("expected existing target with symlink ancestor to be rejected, got %v", err)
	}
}

func TestInspectPathComponentsRejectsUntrustedSymlinkAboveMissingRoot(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias")
	if err := os.Symlink(outside, alias); err != nil {
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	// The trusted root and target do not exist yet. The walker must still
	// reject the user-controlled alias before any caller can MkdirAll through
	// it and redirect staging or logs outside the update workspace.
	trustedRoot := filepath.Join(alias, "missing-root")
	target := filepath.Join(trustedRoot, "attempt", "ready.json")
	if err := inspectPathComponentsWithin(target, trustedRoot, "missing-root path"); err == nil || !strings.Contains(strings.ToLower(err.Error()), "symlink") {
		t.Fatalf("expected untrusted symlink above missing root to be rejected, got %v", err)
	}
}

func TestInspectPathComponentsAllowsDarwinSystemAliasAboveMissingRoot(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS-only filesystem alias test")
	}
	// /var is an Apple-managed alias to /private/var. Keep the fixture wholly
	// nonexistent so the test cannot mutate a system directory.
	trustedRoot := filepath.Join(string(filepath.Separator), "var", "uclaw-test-missing-root")
	target := filepath.Join(trustedRoot, "attempt", "ready.json")
	if err := inspectPathComponentsWithin(target, trustedRoot, "darwin alias path"); err != nil {
		t.Fatalf("expected /var alias above missing root to be accepted, got %v", err)
	}
}

func TestRunRejectsTamperedWorkspaceBeforeLogOrStagingMutation(t *testing.T) {
	task, dir := newTaskForWorkspacePathTests(t)
	// Point staging at the installation itself. Before the validation gate this
	// would be passed to RemoveAll and erase the portable root.
	task.StagingDir = task.RootDir
	task.LogPath = filepath.Join(task.RootDir, "attacker", "update.log")
	taskPath := filepath.Join(dir, "task.json")
	raw, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(taskPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(task.RootDir, "portable.flag")
	markerBefore, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	if code := run(taskPath); code == 0 {
		t.Fatal("expected tampered task to fail validation")
	}
	markerAfter, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatalf("portable root was removed before validation: %v", err)
	}
	if string(markerAfter) != string(markerBefore) {
		t.Fatalf("portable marker changed during rejected task: before=%q after=%q", markerBefore, markerAfter)
	}
	if _, err := os.Stat(filepath.Join(task.RootDir, "attacker")); !os.IsNotExist(err) {
		t.Fatalf("invalid log path created files before validation: %v", err)
	}
}

func TestMacPortableTopLevelCaseFoldCollisionRejected(t *testing.T) {
	err := validateMacTopLevelCaseCollisions([]string{"UClawData", "uclawdata"})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "case") {
		t.Fatalf("expected case-fold collision error, got %v", err)
	}
	if err := validateMacTopLevelCaseCollisions([]string{"portable.flag", "UClawData", "UClaw.app", "resources"}); err != nil {
		t.Fatalf("expected canonical macOS portable names to pass, got %v", err)
	}
}

func TestValidateMacPortableZipRejectsReservedCaseVariant(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "case-variant.zip")
	_, _ = writeZipForTest(t, zipPath, map[string]string{
		"portable.flag":                  "portable\n",
		"UClawData/.keep":                "",
		"UClaw.app/Contents/MacOS/UClaw": "new executable",
		"uclawdata/overlap.txt":          "must be rejected",
	})
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	err = validateMacPortableZipEntries(reader.File, defaultDataDirName)
	_ = reader.Close()
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "case") {
		t.Fatalf("expected reserved-name case collision rejection, got %v", err)
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

func TestCreateBackupDirRejectsSymlinkedBackupRoot(t *testing.T) {
	rootDir := t.TempDir()
	externalDir := t.TempDir()
	linkPath := filepath.Join(rootDir, backupDirName)
	if err := os.Symlink(externalDir, linkPath); err != nil {
		// Symlink creation can be disabled by Windows policy. The production
		// guard is exercised on Unix/macOS CI; skip rather than weakening the
		// test for environments that cannot create the fixture.
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	u := updater{task: updateTask{RootDir: rootDir}}
	if backup, err := u.createBackupDir(); err == nil {
		t.Fatalf("expected symlinked backup root to be rejected, created %s", backup)
	}
	entries, err := os.ReadDir(externalDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("rejected backup path unexpectedly mutated external directory: %v", entries)
	}
}

func TestCreateBackupDirRejectsNonDirectoryBackupRoot(t *testing.T) {
	rootDir := t.TempDir()
	backupPath := filepath.Join(rootDir, backupDirName)
	if err := os.WriteFile(backupPath, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	u := updater{task: updateTask{RootDir: rootDir}}
	if backup, err := u.createBackupDir(); err == nil {
		t.Fatalf("expected non-directory backup root to be rejected, created %s", backup)
	}
}

func TestRollbackRejectsUnsafeEntryNames(t *testing.T) {
	rootDir := t.TempDir()
	backupDir, err := os.MkdirTemp(filepath.Join(rootDir, backupDirName), "attempt-")
	if err != nil {
		if err := os.MkdirAll(filepath.Join(rootDir, backupDirName), 0o755); err != nil {
			t.Fatal(err)
		}
		backupDir, err = os.MkdirTemp(filepath.Join(rootDir, backupDirName), "attempt-")
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"..", "nested/file", filepath.Join("nested", "file"), ""} {
		if err := moveEntriesBack(backupDir, rootDir, []string{name}); err == nil {
			t.Fatalf("expected unsafe rollback entry %q to be rejected", name)
		}
	}
}

func TestExistsFileRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink fixture unavailable: %v", err)
	}
	if existsFile(link) {
		t.Fatal("existsFile accepted a symlink")
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
