package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCleanRootPreservesWindowsDriveRoot(t *testing.T) {
	if got := cleanRoot(""); got != "" {
		t.Fatalf("expected empty root to stay empty, got %q", got)
	}
	if got := cleanRoot(`relative\UClaw`); got != "" {
		t.Fatalf("must reject relative roots, got %q", got)
	}
	if got := cleanRoot(`E:\`); got != `E:\` {
		t.Fatalf("expected drive root to stay absolute, got %q", got)
	}
	if got := cleanRoot(`"D:\UClaw\"`); got != `D:\UClaw` {
		t.Fatalf("expected trailing separator to be trimmed, got %q", got)
	}
}

func TestInferRootFromUpdaterLogSupportsArbitraryDriveLetters(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "portable-updater.log")
	if err := os.WriteFile(filePath, []byte("portable update started: version=2.0.14 root=Q:\\Apps\\UClaw zip=Q:\\tmp\\update.zip\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := inferRootFromFile(filePath); got != `Q:\Apps\UClaw` {
		t.Fatalf("unexpected root: %q", got)
	}
}

func TestInferRootFromJsonStyleLogSupportsArbitraryDriveLetters(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "portable-updater.log")
	if err := os.WriteFile(filePath, []byte(`{"rootDir":"Z:\\Work\\UClaw","launchPath":"Z:\\Work\\UClaw\\UClaw.exe"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := inferRootFromFile(filePath); normalizeComparablePath(got) != normalizeComparablePath(`Z:\Work\UClaw`) {
		t.Fatalf("unexpected root: %q", got)
	}
}

func TestPathWithinNormalizesWindowsTraversal(t *testing.T) {
	root := `Q:\Apps\UClaw`
	if !pathWithin(`Q:\Apps\UClaw\resources\..\UClaw.exe`, root) {
		t.Fatal("expected normalized child path to stay under the root")
	}
	if pathWithin(`Q:\Apps\UClaw\..\Other\UClaw.exe`, root) {
		t.Fatal("must reject a path that escapes the selected root")
	}
	if !pathWithin(`Q:\UClaw\UClaw.exe`, `Q:\`) {
		t.Fatal("expected a drive-root parent to contain its child")
	}
}

func TestSelectRootPrefersPortableCandidateWithoutSorting(t *testing.T) {
	rootDir := t.TempDir()
	installedRoot := filepath.Join(rootDir, "installed")
	portableRoot := filepath.Join(rootDir, "portable")
	for _, root := range []string{installedRoot, portableRoot} {
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "UClaw.exe"), []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(portableRoot, "portable.flag"), []byte("portable"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := selectRoot([]string{installedRoot, portableRoot}); got != portableRoot {
		t.Fatalf("expected portable root to win, got %q", got)
	}
}

func TestApplySafeRepairsSkipsNonPortableRoot(t *testing.T) {
	r := report{
		SelectedRoot:   `E:\Installed\UClaw`,
		AppPath:        `E:\Installed\UClaw\UClaw.exe`,
		processTargets: []processInfo{{Name: "UClaw.exe", PID: 100}},
	}
	applySafeRepairs(&r)
	if len(r.Actions) != 1 || !strings.Contains(r.Actions[0], "非便携版") {
		t.Fatalf("expected non-portable repair to be skipped, got %#v", r.Actions)
	}
	if r.RestartAttempted {
		t.Fatal("non-portable repair must not restart the app")
	}
}

func TestKillUClawProcessesTreatsAlreadyGoneChildrenAsSuccess(t *testing.T) {
	exitErr := runPortableRepairTestProcess(t, 128)
	killed, err := killUClawProcessesWith([]processInfo{
		{Name: "UClaw.exe", PID: 100},
		{Name: "node.exe", PID: 101},
	}, func(pid int) error {
		return exitErr
	})
	if err != nil {
		t.Fatalf("expected an already-gone process to be treated as success, got %v", err)
	}
	if killed != 2 {
		t.Fatalf("expected both processes to count as stopped, got %d", killed)
	}
}

func TestKillUClawProcessesKeepsUnexpectedErrors(t *testing.T) {
	exitErr := runPortableRepairTestProcess(t, 127)
	killed, err := killUClawProcessesWith([]processInfo{
		{Name: "UClaw.exe", PID: 100},
	}, func(pid int) error {
		return exitErr
	})
	if err == nil {
		t.Fatal("expected an unexpected taskkill exit code to remain an error")
	}
	if killed != 0 {
		t.Fatalf("unexpected taskkill failure must not count as stopped, got %d", killed)
	}
}

func runPortableRepairTestProcess(t *testing.T, exitCode int) error {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestPortableRepairExitCodeHelper")
	cmd.Env = append(os.Environ(), "PORTABLE_REPAIR_TEST_EXIT_CODE="+strconv.Itoa(exitCode))
	err := cmd.Run()
	if err == nil {
		t.Fatalf("expected helper process to exit with code %d", exitCode)
	}
	return err
}

func TestPortableRepairExitCodeHelper(t *testing.T) {
	raw := os.Getenv("PORTABLE_REPAIR_TEST_EXIT_CODE")
	if raw == "" {
		return
	}
	exitCode, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("invalid test exit code: %v", err)
	}
	os.Exit(exitCode)
}

func TestSanitizedReportPreservesPathsAndRedactsSecrets(t *testing.T) {
	home := filepath.Join(t.TempDir(), "User")
	t.Setenv("USERPROFILE", home)
	original := report{
		RuntimeDir:     filepath.Join(home, "AppData", "Local", runtimeDirName),
		CandidateRoots: []string{filepath.Join(home, "Desktop", "UClaw")},
		SelectedRoot:   filepath.Join(home, "Desktop", "UClaw"),
		AppPath:        filepath.Join(home, "Desktop", "UClaw", "UClaw.exe"),
		LogEvidence:    []logEvidence{{File: filepath.Join(home, "AppData", "Local", runtimeDirName, "logs", "clawx.log"), Signals: []string{"slow-gateway-startup"}}},
		Errors:         []string{"token=abc123 path=" + filepath.Join(home, "secret")},
	}
	safe := sanitizedReport(original)
	if !strings.Contains(safe.AppPath, home) || !strings.Contains(safe.LogEvidence[0].File, home) || !strings.Contains(safe.Errors[0], filepath.Join(home, "secret")) {
		t.Fatalf("expected diagnostic paths to be preserved, got %#v", safe)
	}
	if strings.Contains(safe.Errors[0], "abc123") {
		t.Fatalf("expected secret redaction, got %#v", safe)
	}
	safe.CandidateRoots[0] = "mutated"
	safe.LogEvidence[0].Signals[0] = "mutated"
	if original.CandidateRoots[0] == "mutated" || original.LogEvidence[0].Signals[0] == "mutated" {
		t.Fatalf("sanitization should copy diagnostic slices without mutating original: original=%#v safe=%#v", original, safe)
	}
}

func TestShouldRepairModes(t *testing.T) {
	confirmed := false
	confirm := func() bool {
		confirmed = true
		return true
	}
	if !shouldRepair(nil, confirm) || !confirmed {
		t.Fatal("expected default mode to ask for repair confirmation")
	}
	if shouldRepair([]string{"--diagnose"}, confirm) {
		t.Fatal("diagnose mode must not repair")
	}
	if shouldRepair([]string{"--repair", "--diagnose"}, confirm) {
		t.Fatal("diagnose mode must win when both flags are present")
	}
	if !shouldRepair([]string{"--repair"}, nil) {
		t.Fatal("explicit repair mode should repair without prompting")
	}
}

func TestRelevantProcessRequiresInstallRoot(t *testing.T) {
	root := `E:\UClaw`
	if !isRelevantProcess(processInfo{Name: "UClaw.exe", PID: 100, Executable: `E:\UClaw\UClaw.exe`}, root) {
		t.Fatal("expected UClaw.exe under selected root to be relevant")
	}
	if isRelevantProcess(processInfo{Name: "UClaw.exe", PID: 101, Executable: `D:\UClaw\UClaw.exe`}, root) {
		t.Fatal("must not treat a same-name app under another root as relevant")
	}
	if isRelevantProcess(processInfo{Name: "node.exe", PID: 102, Executable: `E:\UClaw\resources\bin\node.exe`, Command: `node unrelated.js`}, root) {
		t.Fatal("must not treat generic bundled node.exe as relevant")
	}
	if !isRelevantProcess(processInfo{Name: "node.exe", PID: 103, Executable: `E:\UClaw\resources\bin\node.exe`, Command: `node resources\openclaw\openclaw.mjs gateway`}, root) {
		t.Fatal("expected bundled OpenClaw/Gateway node process to be relevant")
	}
}

func TestResolveRuntimeDirUsesLocalAppData(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("path separator assertion is for non-Windows CI")
	}
	localAppData := filepath.Join(t.TempDir(), "Local")
	t.Setenv("LOCALAPPDATA", localAppData)
	if got := resolveRuntimeDir(); got != filepath.Join(localAppData, runtimeDirName) {
		t.Fatalf("unexpected runtime dir: %q", got)
	}
}

func TestResolveRuntimeDirHonorsExplicitRuntimePath(t *testing.T) {
	explicit := filepath.Join(t.TempDir(), runtimeDirName)
	t.Setenv("CLAWX_RUNTIME_CACHE_DIR", explicit)
	t.Setenv("CLAWX_RUNTIME_CACHE_ROOT", "")
	t.Setenv("CLAWX_PORTABLE_RUNTIME_ROOT", "")
	if got := resolveRuntimeDir(); got != filepath.Clean(explicit) {
		t.Fatalf("unexpected explicit runtime dir: %q", got)
	}
}
