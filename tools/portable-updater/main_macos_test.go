package main

import (
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// requireMacPortableTest keeps these cases in the normal Go test binary so a
// Windows verification run reports the platform-specific coverage explicitly.
func requireMacPortableTest(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("macOS-only portable updater integration test")
	}
	if _, err := os.Stat("/usr/bin/ditto"); err != nil {
		t.Skipf("macOS ditto is unavailable: %v", err)
	}
}

func writeMacFixtureFile(t *testing.T, path string, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode.Perm()); err != nil {
		t.Fatal(err)
	}
}

func writeMacFixtureApp(t *testing.T, appDir string, arch string, version string, executable string, executableMode os.FileMode) {
	t.Helper()
	writeMacFixtureFile(t, filepath.Join(appDir, "Contents", "Info.plist"),
		fmt.Sprintf("<?xml version=\"1.0\"?><plist><dict><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>", version), 0o644)
	writeMacFixtureFile(t, filepath.Join(appDir, "Contents", "MacOS", "UClaw"), executable, executableMode)
	writeMacFixtureFile(t, filepath.Join(appDir, "Contents", "Resources", "uclaw-build.json"),
		fmt.Sprintf(`{"appVersion":%q,"platform":"darwin","arch":%q}`, version, arch), 0o644)
	writeMacFixtureFile(t, filepath.Join(appDir, "Contents", "Resources", "resources", "updater", "darwin-"+arch, "uclaw-portable-updater"), "portable updater", 0o755)
}

func writeMacPortableFixture(t *testing.T, rootDir string, arch string, version string, executable string, executableMode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(rootDir, "UClawData", "updates"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(rootDir, "portable.flag"), "UClaw USB portable mode\n", 0o644)
	writeMacFixtureApp(t, filepath.Join(rootDir, "UClaw.app"), arch, version, executable, executableMode)
}

func writeMacDittoZipForTest(t *testing.T, sourceDir string, zipPath string) (size int64, hash string) {
	t.Helper()
	command := exec.Command("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", ".", zipPath)
	command.Dir = sourceDir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("ditto failed creating macOS fixture ZIP: %v (%s)", err, strings.TrimSpace(string(output)))
	}
	info, err := os.Stat(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hashState := sha512.New()
	if _, err := file.WriteTo(hashState); err != nil {
		t.Fatal(err)
	}
	return info.Size(), hex.EncodeToString(hashState.Sum(nil))
}

func macReadyStartStub(t *testing.T, expectedVersion string, expectedRoot string, started **os.Process) func(string, string, string) (*exec.Cmd, error) {
	t.Helper()
	return func(launchPath string, rootDir string, readyPath string) (*exec.Cmd, error) {
		if !strings.HasSuffix(filepath.ToSlash(launchPath), "/UClaw.app/Contents/MacOS/UClaw") {
			t.Errorf("expected macOS app launch path, got %s", launchPath)
		}
		if rootDir != expectedRoot {
			t.Errorf("expected launch root %s, got %s", expectedRoot, rootDir)
		}
		command := exec.Command(os.Args[0], "-test.run=TestPortableUpdaterProcessHelper")
		command.Dir = rootDir
		command.Env = append(
			os.Environ(),
			"UCLAW_PORTABLE_UPDATER_TEST_PROCESS_HELPER=ready",
			"UCLAW_PORTABLE_UPDATE_READY_PATH="+readyPath,
			"UCLAW_PORTABLE_UPDATE_TARGET_VERSION="+expectedVersion,
		)
		if err := command.Start(); err != nil {
			return nil, err
		}
		*started = command.Process
		return command, nil
	}
}

func TestMacDittoAppBundleZipUpgradePreservesUserData(t *testing.T) {
	requireMacPortableTest(t)
	for _, fixtureArch := range []string{"x64", "arm64"} {
		arch := fixtureArch
		t.Run(arch, func(t *testing.T) {
			testMacDittoAppBundleZipUpgradePreservesUserData(t, arch)
		})
	}
}

func testMacDittoAppBundleZipUpgradePreservesUserData(t *testing.T, arch string) {
	previousStart := startUpdatedApp
	previousFastMove := tryFastMoveReplacement
	var started *os.Process
	t.Cleanup(func() {
		startUpdatedApp = previousStart
		tryFastMoveReplacement = previousFastMove
		if started != nil {
			_ = started.Kill()
		}
	})

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	sourceDir := filepath.Join(dir, "zip-source")
	zipPath := filepath.Join(dir, "UClaw-2.0.4-mac-"+arch+"-usb.zip")
	readyPath := filepath.Join(dir, "ready.json")
	writeMacPortableFixture(t, rootDir, arch, "2.0.3", "old executable", 0o555)
	writeMacFixtureFile(t, filepath.Join(rootDir, "UClawData", "account.json"), "keep account", 0o600)
	if err := os.MkdirAll(filepath.Join(sourceDir, "UClawData", "updates"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(sourceDir, "portable.flag"), "UClaw USB portable mode\n", 0o644)
	writeMacFixtureFile(t, filepath.Join(sourceDir, "UClawData", "updates", ".keep"), "", 0o600)
	writeMacFixtureApp(t, filepath.Join(sourceDir, "UClaw.app"), arch, "2.0.4", "new executable", 0o755)
	// Simulate a signed app bundle containing read-only descendants; ditto should
	// preserve the bundle tree without requiring runtime chmod.
	if err := os.Chmod(filepath.Join(sourceDir, "UClaw.app", "Contents", "Resources"), 0o555); err != nil {
		t.Fatal(err)
	}
	size, hash := writeMacDittoZipForTest(t, sourceDir, zipPath)

	startUpdatedApp = macReadyStartStub(t, "2.0.4", rootDir, &started)
	tryFastMoveReplacement = func(string, string) (bool, error) {
		return false, nil
	}
	task := updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw"),
		TargetVersion: "2.0.4",
		Sha512:        hash,
		Size:          size,
		StagingDir:    filepath.Join(dir, "staging"),
		ReadyPath:     readyPath,
	}

	updater := updater{task: task, taskPath: filepath.Join(dir, "task.json")}
	backupDir, _, launchPath, err := updater.apply()
	if err != nil {
		t.Fatal(err)
	}
	if launchPath != task.LaunchPath {
		t.Fatalf("expected app launch path %s, got %s", task.LaunchPath, launchPath)
	}
	if backupDir == "" {
		t.Fatal("expected a backup directory for a successful app update")
	}
	if raw, err := os.ReadFile(task.LaunchPath); err != nil || string(raw) != "new executable" {
		t.Fatalf("expected new app executable, got %q err=%v", string(raw), err)
	}
	info, err := os.Stat(task.LaunchPath)
	if err != nil {
		t.Fatalf("expected updated app executable to exist: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("expected ditto to preserve executable mode, got mode=%v", info.Mode().Perm())
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "keep account" {
		t.Fatalf("expected user data preserved, got %q err=%v", string(raw), err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClaw.app", "Contents", "Resources", "uclaw-build.json")); err != nil || !strings.Contains(string(raw), `"2.0.4"`) {
		t.Fatalf("expected updated build identity, got %q err=%v", string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "UClaw.app", "Contents", "Resources", "resources", "updater", "darwin-"+arch, "uclaw-portable-updater")); err != nil {
		t.Fatalf("expected architecture-specific updater helper, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(backupDir, "UClaw.app", "Contents", "MacOS", "UClaw")); err != nil || string(raw) != "old executable" {
		t.Fatalf("expected old app bundle in backup, got %q err=%v", string(raw), err)
	}
}

func TestMacDittoAppBundleZipRollbackRestoresReadOnlyPreviousApp(t *testing.T) {
	requireMacPortableTest(t)
	for _, fixtureArch := range []string{"x64", "arm64"} {
		arch := fixtureArch
		t.Run(arch, func(t *testing.T) {
			testMacDittoAppBundleZipRollbackRestoresReadOnlyPreviousApp(t, arch)
		})
	}
}

func testMacDittoAppBundleZipRollbackRestoresReadOnlyPreviousApp(t *testing.T, arch string) {
	previousStart := startUpdatedApp
	previousFastMove := tryFastMoveReplacement
	t.Cleanup(func() {
		startUpdatedApp = previousStart
		tryFastMoveReplacement = previousFastMove
	})
	startUpdatedApp = func(string, string, string) (*exec.Cmd, error) {
		return nil, errors.New("simulated macOS startup failure")
	}
	tryFastMoveReplacement = func(string, string) (bool, error) {
		return false, nil
	}

	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	sourceDir := filepath.Join(dir, "zip-source")
	zipPath := filepath.Join(dir, "UClaw-2.0.4-mac-"+arch+"-usb.zip")
	writeMacPortableFixture(t, rootDir, arch, "2.0.3", "old executable", 0o555)
	oldExecutablePath := filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw")
	oldExecutableInfo, err := os.Stat(oldExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(rootDir, "UClawData", "account.json"), "keep account", 0o600)
	if err := os.MkdirAll(filepath.Join(sourceDir, "UClawData", "updates"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(sourceDir, "portable.flag"), "UClaw USB portable mode\n", 0o644)
	writeMacFixtureFile(t, filepath.Join(sourceDir, "UClawData", "updates", ".keep"), "", 0o600)
	writeMacFixtureApp(t, filepath.Join(sourceDir, "UClaw.app"), arch, "2.0.4", "new executable", 0o755)
	// The replacement bundle can contain read-only descendants; rollback must
	// move the top-level tree aside instead of recursively deleting in place.
	if err := os.Chmod(filepath.Join(sourceDir, "UClaw.app", "Contents", "Resources"), 0o555); err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(sourceDir, "new-only.txt"), "remove after rollback", 0o600)
	size, hash := writeMacDittoZipForTest(t, sourceDir, zipPath)
	task := updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw"),
		TargetVersion: "2.0.4",
		Sha512:        hash,
		Size:          size,
		StagingDir:    filepath.Join(dir, "staging"),
		ReadyPath:     filepath.Join(dir, "ready.json"),
	}

	updater := updater{task: task, taskPath: filepath.Join(dir, "task.json")}
	backupDir, _, _, err := updater.apply()
	if err == nil || !strings.Contains(err.Error(), "simulated macOS startup failure") {
		t.Fatalf("expected startup failure, got %v", err)
	}
	if backupDir == "" {
		t.Fatal("expected rollback backup directory")
	}
	if raw, err := os.ReadFile(task.LaunchPath); err != nil || string(raw) != "old executable" {
		t.Fatalf("expected old app executable restored, got %q err=%v", string(raw), err)
	}
	restoredExecutableInfo, err := os.Stat(oldExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	if restoredExecutableInfo.Mode().Perm() != oldExecutableInfo.Mode().Perm() {
		t.Fatalf("expected read-only executable mode %o restored, got %o", oldExecutableInfo.Mode().Perm(), restoredExecutableInfo.Mode().Perm())
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClaw.app", "Contents", "Resources", "uclaw-build.json")); err != nil || !strings.Contains(string(raw), `"2.0.3"`) {
		t.Fatalf("expected old app identity restored, got %q err=%v", string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "new-only.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected new-only file removed on rollback, got %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(rootDir, "UClawData", "account.json")); err != nil || string(raw) != "keep account" {
		t.Fatalf("expected user data preserved after rollback, got %q err=%v", string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(backupDir, "UClaw.app")); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to move the previous app back out of the backup, got %v", err)
	}
}

func TestMacReadOnlyPortableRootRejectedBeforeUpdate(t *testing.T) {
	requireMacPortableTest(t)
	for _, fixtureArch := range []string{"x64", "arm64"} {
		arch := fixtureArch
		t.Run(arch, func(t *testing.T) {
			testMacReadOnlyPortableRootRejectedBeforeUpdate(t, arch)
		})
	}
}

func testMacReadOnlyPortableRootRejectedBeforeUpdate(t *testing.T, arch string) {
	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	if err := os.MkdirAll(filepath.Join(rootDir, "UClawData", "updates"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeMacFixtureFile(t, filepath.Join(rootDir, "portable.flag"), "portable\n", 0o644)
	writeMacFixtureApp(t, filepath.Join(rootDir, "UClaw.app"), arch, "2.0.3", "old executable", 0o755)
	zipPath := filepath.Join(dir, "update.zip")
	size, hash := writeZipForTest(t, zipPath, map[string]string{
		"portable.flag":                  "portable\n",
		"UClaw.app/Contents/MacOS/UClaw": "new executable",
	})
	task := updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   "UClawData",
		LaunchPath:    filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw"),
		TargetVersion: "2.0.4",
		Sha512:        hash,
		Size:          size,
		ReadyPath:     filepath.Join(dir, "ready.json"),
	}

	originalMode := os.FileMode(0o755)
	if err := os.Chmod(rootDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(rootDir, originalMode) })
	probe := filepath.Join(rootDir, ".write-probe")
	if err := os.WriteFile(probe, []byte("probe"), 0o600); err == nil {
		_ = os.Remove(probe)
		t.Skip("filesystem permits writes to a 0555 directory; read-only preflight cannot be asserted")
	}

	err := validateTask(&task)
	if err == nil {
		t.Fatal("expected read-only portable root to be rejected")
	}
	lower := strings.ToLower(err.Error())
	if !strings.Contains(lower, "writ") && !strings.Contains(lower, "read-only") && !strings.Contains(lower, "permission") {
		t.Fatalf("expected a read-only/writable validation error, got %v", err)
	}
}

func TestMacReadOnlyExecutableDoesNotNeedChmod(t *testing.T) {
	requireMacPortableTest(t)
	path := filepath.Join(t.TempDir(), "UClaw.app", "Contents", "MacOS", "UClaw")
	writeMacFixtureFile(t, path, "executable", 0o555)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := chmodExecutable(path); err != nil {
		t.Fatalf("expected already-executable read-only app binary to be accepted, got %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if before.Mode().Perm() != after.Mode().Perm() {
		t.Fatalf("chmodExecutable changed read-only app mode from %o to %o", before.Mode().Perm(), after.Mode().Perm())
	}
}

func TestMacReadOnlyDataDirectoryRejectedBeforeUpdate(t *testing.T) {
	requireMacPortableTest(t)
	for _, fixtureArch := range []string{"x64", "arm64"} {
		arch := fixtureArch
		t.Run(arch, func(t *testing.T) {
			testMacReadOnlyDataDirectoryRejectedBeforeUpdate(t, arch)
		})
	}
}

func TestMacDirectoryWriteAccessLeavesNoProbeFile(t *testing.T) {
	requireMacPortableTest(t)
	dir := filepath.Join(t.TempDir(), "writable")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := directoryWriteAccess(dir); err != nil {
		t.Fatalf("expected writable directory probe to pass: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".uclaw-write-probe-") {
			t.Fatalf("write probe was not cleaned up: %s", entry.Name())
		}
	}
}

func testMacReadOnlyDataDirectoryRejectedBeforeUpdate(t *testing.T, arch string) {
	dir := t.TempDir()
	rootDir := filepath.Join(dir, "portable")
	writeMacPortableFixture(t, rootDir, arch, "2.0.3", "old executable", 0o755)
	zipPath := filepath.Join(dir, "update.zip")
	if err := os.WriteFile(zipPath, []byte("zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	task := updateTask{
		ZipPath:       zipPath,
		RootDir:       rootDir,
		DataDirName:   defaultDataDirName,
		LaunchPath:    filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", "UClaw"),
		TargetVersion: "2.0.4",
		Sha512:        "abc",
		Size:          3,
		ReadyPath:     filepath.Join(dir, "ready.json"),
	}
	dataDir := filepath.Join(rootDir, defaultDataDirName)
	if err := os.Chmod(dataDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dataDir, 0o755) })
	if err := validateTask(&task); err == nil || !strings.Contains(strings.ToLower(err.Error()), "writ") {
		t.Fatalf("expected read-only UClawData rejection, got %v", err)
	}
}
