package main

import (
	"archive/zip"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	defaultDataDirName = "UClawData"
	backupDirName      = ".uclaw-update-backups"
	resultSuffix       = ".result.json"
	updatesDirName     = "updates"
	tasksDirName       = "tasks"
	stagingDirName     = "staging"
	readyDirName       = "ready"
	logsDirName        = "logs"
	taskFilePrefix     = "portable-update-"
	taskFileSuffix     = ".json"
	// Antivirus and Explorer can retain a directory handle for tens of seconds
	// after Electron exits. Keep the update and rollback windows symmetric so a
	// recoverable lock never turns into a half-applied installation.
	moveRetryAttempts = 30
	rollbackAttempts  = 30
	moveRetryDelay    = 500 * time.Millisecond
	startupReadyWait  = 45 * time.Second
	startupReadyGrace = time.Second
	copyHeartbeat     = time.Second
	copyLogInterval   = 5 * time.Second
	copyBufferSize    = 1024 * 1024
	maxCopyWorkers    = 4
)

var (
	startUpdatedApp                 = defaultStartUpdatedApp
	tryFastMoveReplacement          = defaultTryFastMoveReplacement
	replacementProgressEmitInterval = 200 * time.Millisecond
	replacementCopyBufferPool       = sync.Pool{
		New: func() any {
			return make([]byte, copyBufferSize)
		},
	}
)

type updateTask struct {
	ZipPath       string `json:"zipPath"`
	RootDir       string `json:"rootDir"`
	DataDirName   string `json:"dataDirName"`
	LaunchPath    string `json:"launchPath"`
	TargetVersion string `json:"targetVersion"`
	Sha512        string `json:"sha512"`
	Size          int64  `json:"size"`
	ParentPID     int    `json:"parentPid"`
	LogPath       string `json:"logPath"`
	StagingDir    string `json:"stagingDir"`
	ReadyPath     string `json:"readyPath"`
}

type updateResult struct {
	Success       bool   `json:"success"`
	Error         string `json:"error,omitempty"`
	BackupDir     string `json:"backupDir,omitempty"`
	StagingDir    string `json:"stagingDir,omitempty"`
	LaunchedPath  string `json:"launchedPath,omitempty"`
	TargetVersion string `json:"targetVersion,omitempty"`
	FinishedAt    string `json:"finishedAt"`
}

type updateFailure struct {
	cause              error
	restartPreviousApp bool
}

func (e *updateFailure) Error() string {
	return e.cause.Error()
}

func (e *updateFailure) Unwrap() error {
	return e.cause
}

type updater struct {
	task      updateTask
	taskPath  string
	workspace *taskWorkspace
	logFile   *os.File
	progress  *progressReporter
}

type replacementCopyProgress struct {
	Percent        int
	CurrentEntry   string
	CompletedFiles int64
	TotalFiles     int64
	CompletedBytes int64
	TotalBytes     int64
}

type replacementDirectory struct {
	dst  string
	perm os.FileMode
}

type replacementFile struct {
	src  string
	dst  string
	perm os.FileMode
	size int64
}

type replacementSymlink struct {
	dst    string
	target string
}

type replacementCopyPlan struct {
	directories []replacementDirectory
	files       []replacementFile
	symlinks    []replacementSymlink
	totalFiles  int64
	totalBytes  int64
}

type replacementWork struct {
	name string
	src  string
	dst  string
	plan replacementCopyPlan
}

func main() {
	taskPath := flag.String("task", "", "path to a portable update task JSON file")
	flag.Parse()

	if strings.TrimSpace(*taskPath) == "" {
		_, _ = fmt.Fprintln(os.Stderr, "missing --task")
		os.Exit(2)
	}

	code := run(*taskPath)
	os.Exit(code)
}

func run(taskPath string) int {
	progress := newProgressReporter()
	defer progress.Close()

	normalizedTaskPath, pathErr := normalizeAbsoluteTaskPath(taskPath)
	u := &updater{taskPath: normalizedTaskPath, progress: progress}
	if pathErr != nil {
		u.logf("invalid task path: %v", pathErr)
		progress.Fail("更新失败", pathErr.Error())
		return 1
	}
	if err := validateTaskFilePath(normalizedTaskPath); err != nil {
		u.logf("invalid task path: %v", err)
		progress.Fail("更新失败", err.Error())
		return 1
	}

	task, err := readTask(normalizedTaskPath)

	if err != nil {
		u.logf("failed to read task: %v", err)
		progress.Fail("更新失败", err.Error())
		// Do not write taskPath+.result.json when the task could not be read.
		// At this point there is no trusted task payload to establish the
		// update workspace, and a caller-controlled path must not become an
		// arbitrary write primitive.
		return 1
	}
	if err := validateTaskAtPath(&task, normalizedTaskPath); err != nil {
		u.logf("invalid task: %v", err)
		progress.Fail("更新失败", err.Error())
		u.writeResult(updateResult{Success: false, Error: err.Error(), TargetVersion: task.TargetVersion})
		return 1
	}
	u.task = task
	if workspace, workspaceErr := resolveTaskWorkspace(normalizedTaskPath); workspaceErr == nil {
		u.workspace = &workspace
	} else {
		// validateTaskAtPath already resolved this successfully. Keep the guard
		// explicit so a future change cannot accidentally run without the
		// trusted workspace context.
		u.logf("failed to retain update workspace: %v", workspaceErr)
		progress.Fail("更新失败", workspaceErr.Error())
		return 1
	}
	// Do not open a caller-supplied log path until every task field has passed
	// validation. A tampered task must not be able to create directories or
	// append to an arbitrary file before we reject it.
	if task.LogPath != "" {
		if logFile, openErr := openLog(task.LogPath); openErr == nil {
			u.logFile = logFile
			defer logFile.Close()
		} else {
			u.logf("failed to open update log: %v", openErr)
		}
	}

	u.logf("portable update started: version=%s root=%s zip=%s", task.TargetVersion, task.RootDir, task.ZipPath)
	progress.Update(progressState{
		Title:   "正在准备更新",
		Detail:  "请不要关闭此窗口，更新完成后会自动重启 UClaw。",
		Percent: 2,
	})
	result := updateResult{TargetVersion: task.TargetVersion}
	if task.ParentPID > 0 {
		if err := validateParentPID(task.ParentPID, task.LaunchPath); err != nil {
			err = fmt.Errorf("refusing to wait for parent process: %w", err)
			u.logf("portable update aborted before waiting for parent: %v", err)
			progress.Fail("更新失败", err.Error())
			result.Success = false
			result.Error = err.Error()
			u.writeResult(result)
			return 1
		}
		progress.Update(progressState{
			Title:   "正在关闭旧版本",
			Detail:  "等待 UClaw 完全退出，随后开始替换文件。",
			Percent: 5,
		})
		if err := waitForParentExit(task.ParentPID, 45*time.Second, func(format string, args ...any) {
			u.logf(format, args...)
		}, task.LaunchPath); err != nil {
			err = fmt.Errorf("old UClaw did not exit; update was not started: %w", err)
			u.logf("portable update aborted before file replacement: %v", err)
			progress.Fail("更新失败", err.Error())
			result.Success = false
			result.Error = err.Error()
			u.writeResult(result)
			return 1
		}
	} else {
		time.Sleep(2 * time.Second)
	}

	backupDir, stagingDir, launchedPath, err := u.apply()
	result.BackupDir = backupDir
	result.StagingDir = stagingDir
	result.LaunchedPath = launchedPath
	if err != nil {
		if shouldRestartPreviousApp(err) {
			if previousPath, restartErr := u.restartPreviousApp(); restartErr != nil {
				err = fmt.Errorf("%w; previous UClaw could not be restarted: %v", err, restartErr)
				u.logf("failed to restart previous UClaw after update failure: %v", restartErr)
			} else {
				u.logf("previous UClaw restarted after update failure: %s", previousPath)
			}
		}
		result.Success = false
		result.Error = err.Error()
		u.logf("portable update failed: %v", err)
		progress.Fail("更新失败", err.Error())
		u.writeResult(result)
		return 1
	}

	result.Success = true
	u.logf("portable update completed; launched %s", launchedPath)
	progress.Update(progressState{
		Title:   "更新完成",
		Detail:  "新版 UClaw 已启动。",
		Percent: 100,
	})
	u.writeResult(result)
	time.Sleep(900 * time.Millisecond)
	return 0
}

func readTask(path string) (updateTask, error) {
	var task updateTask
	raw, err := os.ReadFile(path)
	if err != nil {
		return task, err
	}
	if err := json.Unmarshal(raw, &task); err != nil {
		return task, err
	}
	return task, nil
}

// validateTaskFilePath establishes the trust anchor used by all paths in a
// task. Electron writes tasks as direct children of an updates/tasks
// directory; accepting a symlink or an arbitrary filename here would let a
// caller choose a different workspace and then smuggle destructive paths in
// the JSON payload.
func validateTaskFilePath(path string) error {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return err
	}
	name := filepath.Base(normalized)
	if !strings.HasPrefix(name, taskFilePrefix) || !strings.HasSuffix(name, taskFileSuffix) {
		return fmt.Errorf("task file must be named %s*.json", taskFilePrefix)
	}
	tasksDir := filepath.Dir(normalized)
	if !taskPathNamesEqual(filepath.Base(tasksDir), tasksDirName) {
		return fmt.Errorf("task file must be inside %s directory", tasksDirName)
	}
	updatesRoot := filepath.Dir(tasksDir)
	if !taskPathNamesEqual(filepath.Base(updatesRoot), updatesDirName) {
		return fmt.Errorf("task file must be inside an %s workspace", updatesDirName)
	}
	if err := validateNoSymlinkComponents(updatesRoot, normalized, "task path"); err != nil {
		return err
	}
	info, err := os.Lstat(normalized)
	if err != nil {
		return fmt.Errorf("task file is not available: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("task file must be a regular file")
	}
	return nil
}

type taskWorkspace struct {
	taskPath    string
	updatesRoot string
	tasksDir    string
	stagingRoot string
	readyRoot   string
	logsRoot    string
	stamp       string
}

func resolveTaskWorkspace(taskPath string) (taskWorkspace, error) {
	normalized, err := normalizeAbsoluteTaskPath(taskPath)
	if err != nil {
		return taskWorkspace{}, err
	}
	if err := validateTaskFilePath(normalized); err != nil {
		return taskWorkspace{}, err
	}
	tasksDir := filepath.Dir(normalized)
	updatesRoot := filepath.Dir(tasksDir)
	runtimeRoot := filepath.Dir(updatesRoot)
	name := filepath.Base(normalized)
	stamp := strings.TrimSuffix(strings.TrimPrefix(name, taskFilePrefix), taskFileSuffix)
	if stamp == "" {
		return taskWorkspace{}, errors.New("task file has an empty update attempt id")
	}
	return taskWorkspace{
		taskPath:    normalized,
		updatesRoot: updatesRoot,
		tasksDir:    tasksDir,
		stagingRoot: filepath.Join(updatesRoot, stagingDirName),
		readyRoot:   filepath.Join(updatesRoot, readyDirName),
		logsRoot:    filepath.Join(runtimeRoot, logsDirName),
		stamp:       stamp,
	}, nil
}

// validateTaskAtPath applies the regular task checks and then binds all
// mutable workspace paths to the updates directory that contains the task.
// Keeping this separate from validateTask preserves small in-process unit
// helpers while making the external helper entry point fail closed.
func validateTaskAtPath(task *updateTask, taskPath string) error {
	if err := validateTask(task); err != nil {
		return err
	}
	workspace, err := resolveTaskWorkspace(taskPath)
	if err != nil {
		return err
	}
	if taskPathsOverlap(workspace.updatesRoot, task.RootDir) {
		return errors.New("update workspace must be outside rootDir")
	}
	if err := validateNoSymlinkComponents(workspace.updatesRoot, workspace.updatesRoot, "update workspace"); err != nil {
		return err
	}
	if err := validateTrustedZipPath(task.ZipPath, workspace); err != nil {
		return err
	}
	if task.StagingDir == "" {
		task.StagingDir = filepath.Join(workspace.stagingRoot, workspace.stamp)
	}
	if err := validateTrustedWorkspacePath(task.StagingDir, workspace.stagingRoot, "stagingDir", taskPathStaging, workspace.stamp); err != nil {
		return err
	}
	if err := validateTrustedWorkspacePath(task.ReadyPath, workspace.readyRoot, "readyPath", taskPathMarker, taskFilePrefix+workspace.stamp+".ready.json"); err != nil {
		return err
	}
	if task.LogPath != "" {
		if err := validateTrustedWorkspacePath(task.LogPath, workspace.logsRoot, "logPath", taskPathLog, "portable-updater-"+workspace.stamp+".log"); err != nil {
			return err
		}
	}
	return nil
}

func validateTrustedZipPath(path string, workspace taskWorkspace) error {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return fmt.Errorf("zipPath is invalid: %w", err)
	}
	if !taskPathsEqual(filepath.Dir(normalized), workspace.updatesRoot) {
		return errors.New("zipPath must be a direct file in the update workspace")
	}
	if err := validateNoSymlinkComponents(workspace.updatesRoot, normalized, "zipPath"); err != nil {
		return err
	}
	info, err := os.Lstat(normalized)
	if err != nil {
		return fmt.Errorf("zipPath is not available: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("zipPath must be a regular file")
	}
	return nil
}

func validateTrustedWorkspacePath(path string, trustedRoot string, label string, kind taskPathKind, expectedBase string) error {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return fmt.Errorf("%s is invalid: %w", label, err)
	}
	root, err := normalizeAbsoluteTaskPath(trustedRoot)
	if err != nil {
		return fmt.Errorf("trusted %s root is invalid: %w", label, err)
	}
	if !taskPathNamesEqual(filepath.Base(normalized), expectedBase) {
		return fmt.Errorf("%s must use the current update attempt name", label)
	}
	if !taskPathNamesEqual(filepath.Dir(normalized), filepath.Clean(root)) {
		return fmt.Errorf("%s must be inside the trusted update workspace", label)
	}
	if err := validateNoSymlinkComponents(root, normalized, label); err != nil {
		return err
	}
	if info, statErr := os.Lstat(normalized); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s must not be a symlink", label)
		}
		if kind == taskPathStaging {
			if !info.IsDir() {
				return fmt.Errorf("%s must be a directory when it already exists", label)
			}
		} else if info.IsDir() {
			return fmt.Errorf("%s must be a file path", label)
		}
	} else if !os.IsNotExist(statErr) {
		return fmt.Errorf("%s cannot be inspected: %w", label, statErr)
	}
	return nil
}

// validateNoSymlinkComponents rejects symlinks in every existing component
// between the filesystem root and target. It also checks the nearest existing
// ancestor when target (or its trusted root) has not been created yet, which
// lets callers safely validate paths before MkdirAll.
func validateNoSymlinkComponents(trustedRoot string, target string, label string) error {
	root, err := normalizeAbsoluteTaskPath(trustedRoot)
	if err != nil {
		return fmt.Errorf("%s trusted root is invalid: %w", label, err)
	}
	path, err := normalizeAbsoluteTaskPath(target)
	if err != nil {
		return fmt.Errorf("%s is invalid: %w", label, err)
	}
	if !taskPathContains(normalizeTaskPathForComparison(root), normalizeTaskPathForComparison(path)) && !taskPathsEqual(root, path) {
		return fmt.Errorf("%s is outside its trusted root", label)
	}
	if err := inspectPathComponentsWithin(path, root, label); err != nil {
		return err
	}
	return nil
}

func inspectPathComponents(path string, label string) error {
	return inspectPathComponentsWithin(path, "", label)
}

// inspectPathComponentsWithin checks every component from trustedRoot through
// target.  A bounded walk is important on macOS, where system paths such as
// /var are symlinks by design; callers should reject links in the task/update
// workspace itself without rejecting an OS-managed ancestor above it.
func inspectPathComponentsWithin(path string, trustedRoot string, label string) error {
	normalizedPath, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return fmt.Errorf("%s is invalid: %w", label, err)
	}
	base := normalizedPath
	if strings.TrimSpace(trustedRoot) != "" {
		base, err = normalizeAbsoluteTaskPath(trustedRoot)
		if err != nil {
			return fmt.Errorf("%s trusted root is invalid: %w", label, err)
		}
		if !taskPathContains(normalizeTaskPathForComparison(base), normalizeTaskPathForComparison(normalizedPath)) && !taskPathsEqual(base, normalizedPath) {
			return fmt.Errorf("%s is outside its trusted root", label)
		}
	} else {
		// With no explicit boundary, retain the historical helper semantics and
		// inspect from the filesystem/volume root.
		volume := filepath.VolumeName(normalizedPath)
		if volume != "" {
			base = filepath.Join(volume, string(filepath.Separator))
		} else {
			base = string(filepath.Separator)
		}
	}

	// Find the nearest existing ancestor of the trusted root. Components above
	// this anchor are outside the caller-controlled workspace and are not
	// treated as part of the update path. This matters on macOS, where /var is
	// a deliberate symlink to /private/var.
	anchor := base
	var missingBase []string
	for {
		info, statErr := os.Lstat(anchor)
		if statErr == nil {
			isSymlink := info.Mode()&os.ModeSymlink != 0
			if isSymlink {
				// A symlink is unsafe when it is the trusted root itself. If the
				// trusted root has not been created yet, however, this can be an
				// OS-managed alias above the caller-controlled workspace (notably
				// macOS /var -> /private/var). Only a narrowly allow-listed system
				// alias is accepted; an arbitrary link (for example /tmp/link ->
				// another volume) would otherwise let a missing update workspace be
				// redirected outside the caller's intended path.
				if len(missingBase) == 0 || taskPathsEqual(anchor, base) {
					return fmt.Errorf("%s contains a symlink: %s", label, anchor)
				}
				resolvedInfo, resolveErr := os.Stat(anchor)
				if resolveErr != nil {
					return fmt.Errorf("%s cannot inspect symlink ancestor %s: %w", label, anchor, resolveErr)
				}
				if !resolvedInfo.IsDir() {
					return fmt.Errorf("%s has a non-directory trusted root ancestor: %s", label, anchor)
				}
				resolvedAnchor, resolveErr := filepath.EvalSymlinks(anchor)
				if resolveErr != nil {
					return fmt.Errorf("%s cannot resolve symlink ancestor %s: %w", label, anchor, resolveErr)
				}
				resolvedAnchor, resolveErr = normalizeAbsoluteTaskPath(resolvedAnchor)
				if resolveErr != nil || !isAllowedSystemPathAlias(anchor, resolvedAnchor) {
					return fmt.Errorf("%s contains an untrusted symlink: %s", label, anchor)
				}
			} else if !info.IsDir() {
				return fmt.Errorf("%s has a non-directory trusted root ancestor: %s", label, anchor)
			}
			break
		}
		if !os.IsNotExist(statErr) {
			return fmt.Errorf("%s cannot be inspected: %w", label, statErr)
		}
		parent := filepath.Dir(anchor)
		if parent == anchor {
			return fmt.Errorf("%s has no inspectable filesystem root", label)
		}
		missingBase = append(missingBase, filepath.Base(anchor))
		anchor = parent
	}

	// Walk from the nearest existing anchor down through the trusted root and
	// finally to the target. Unlike the former early-break implementation this
	// checks an existing target's *entire* ancestor chain, so a middle symlink
	// or junction cannot bypass validation.
	components := make([]string, 0, len(missingBase)+8)
	for index := len(missingBase) - 1; index >= 0; index-- {
		components = append(components, missingBase[index])
	}
	relTarget, relErr := filepath.Rel(base, normalizedPath)
	if relErr != nil || filepath.IsAbs(relTarget) || relTarget == ".." || strings.HasPrefix(relTarget, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s is outside its trusted root", label)
	}
	if relTarget != "." && relTarget != "" {
		components = append(components, strings.Split(relTarget, string(filepath.Separator))...)
	}

	current := anchor
	for index, component := range components {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, statErr := os.Lstat(current)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				// Once a component is absent, descendants cannot currently be
				// traversed. They will be revalidated after creation by callers
				// that perform MkdirAll/RemoveAll.
				return nil
			}
			return fmt.Errorf("%s cannot be inspected: %w", label, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s contains a symlink: %s", label, current)
		}
		if index < len(components)-1 && !info.IsDir() {
			return fmt.Errorf("%s has a non-directory parent: %s", label, current)
		}
	}
	return nil
}

// isAllowedSystemPathAlias identifies the small set of aliases Apple ships at
// the filesystem root. These aliases may occur above a not-yet-created runtime
// workspace (for example /var/folders/...); arbitrary user-created symlinks
// must remain rejected because they can redirect update writes to another
// volume or installation.
func isAllowedSystemPathAlias(aliasPath string, resolvedPath string) bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	aliasPath = filepath.Clean(aliasPath)
	resolvedPath = filepath.Clean(resolvedPath)
	for _, alias := range []string{"/var", "/tmp", "/etc"} {
		expected := filepath.Join("/private", strings.TrimPrefix(alias, string(filepath.Separator)))
		if taskPathsEqual(aliasPath, alias) && taskPathsEqual(resolvedPath, expected) {
			return true
		}
	}
	return false
}

func validateTask(task *updateTask) error {
	task.ZipPath = strings.TrimSpace(task.ZipPath)
	task.RootDir = strings.TrimSpace(task.RootDir)
	task.DataDirName = strings.TrimSpace(task.DataDirName)
	task.LaunchPath = strings.TrimSpace(task.LaunchPath)
	task.TargetVersion = strings.TrimSpace(task.TargetVersion)
	task.LogPath = strings.TrimSpace(task.LogPath)
	task.StagingDir = strings.TrimSpace(task.StagingDir)
	task.ReadyPath = strings.TrimSpace(task.ReadyPath)
	task.Sha512 = strings.ToLower(strings.TrimSpace(task.Sha512))
	if task.DataDirName == "" {
		task.DataDirName = defaultDataDirName
	}
	if task.ZipPath == "" || task.RootDir == "" || task.LaunchPath == "" || task.TargetVersion == "" || task.ReadyPath == "" {
		return errors.New("zipPath, rootDir, launchPath, targetVersion and readyPath are required")
	}
	if !filepath.IsAbs(task.ZipPath) || !filepath.IsAbs(task.RootDir) || !filepath.IsAbs(task.LaunchPath) {
		return errors.New("zipPath, rootDir and launchPath must be absolute")
	}
	if !filepath.IsAbs(task.ReadyPath) {
		return errors.New("readyPath must be absolute")
	}
	if task.StagingDir != "" && !filepath.IsAbs(task.StagingDir) {
		return errors.New("stagingDir must be absolute")
	}
	if task.LogPath != "" && !filepath.IsAbs(task.LogPath) {
		return errors.New("logPath must be absolute")
	}
	// Keep the paths used for all subsequent filesystem operations stable and
	// free of lexical `..` components. Symlink-aware containment checks below
	// still use the original filesystem identity, so this normalization does
	// not turn an escape into an in-root path by string manipulation.
	for _, pathField := range []struct {
		name  string
		value *string
	}{
		{name: "zipPath", value: &task.ZipPath},
		{name: "rootDir", value: &task.RootDir},
		{name: "launchPath", value: &task.LaunchPath},
		{name: "readyPath", value: &task.ReadyPath},
		{name: "stagingDir", value: &task.StagingDir},
		{name: "logPath", value: &task.LogPath},
	} {
		value := *pathField.value
		if value == "" {
			continue
		}
		normalized, normalizeErr := normalizeAbsoluteTaskPath(value)
		if normalizeErr != nil {
			return fmt.Errorf("%s is invalid: %w", pathField.name, normalizeErr)
		}
		*pathField.value = normalized
	}
	if task.DataDirName == "." || task.DataDirName == ".." || strings.ContainsAny(task.DataDirName, `/\`) {
		return errors.New("dataDirName must be a single directory name")
	}
	if task.Size <= 0 {
		return errors.New("size must be positive")
	}
	if task.ParentPID < 0 {
		return errors.New("parentPid must be zero or a positive process id")
	}
	if task.Sha512 == "" {
		return errors.New("sha512 is required")
	}
	zipInfo, zipErr := os.Lstat(task.ZipPath)
	if zipErr != nil {
		return fmt.Errorf("zip does not exist: %w", zipErr)
	}
	if zipInfo.Mode()&os.ModeSymlink != 0 || !zipInfo.Mode().IsRegular() {
		return errors.New("zip must be a regular file")
	}
	rootInfo, rootErr := os.Lstat(task.RootDir)
	if rootErr != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		if rootErr != nil {
			return fmt.Errorf("rootDir is not available: %w", rootErr)
		}
		return errors.New("rootDir must be a real directory")
	}
	if runtime.GOOS == "darwin" {
		// A macOS portable ZIP has a strict top-level contract. Do not infer
		// portability from a lone app bundle or create missing state beside an
		// installed /Applications app.
		if task.DataDirName != defaultDataDirName {
			return fmt.Errorf("dataDirName must be %s on macOS", defaultDataDirName)
		}
		if err := validateMacPortableDirectory(task.RootDir, "rootDir"); err != nil {
			return err
		}
		dataPath := filepath.Join(task.RootDir, task.DataDirName)
		dataInfo, dataErr := os.Lstat(dataPath)
		if dataErr != nil || dataInfo.Mode()&os.ModeSymlink != 0 || !dataInfo.IsDir() {
			return errors.New("rootDir is missing UClawData directory")
		}
		appPath := filepath.Join(task.RootDir, "UClaw.app")
		appInfo, appErr := os.Lstat(appPath)
		if appErr != nil || appInfo.Mode()&os.ModeSymlink != 0 || !appInfo.IsDir() {
			return errors.New("rootDir is missing UClaw.app bundle")
		}
		for _, candidate := range []struct {
			path  string
			label string
			info  os.FileInfo
		}{
			{path: task.RootDir, label: "rootDir"},
			{path: dataPath, label: defaultDataDirName, info: dataInfo},
			{path: appPath, label: "UClaw.app bundle", info: appInfo},
		} {
			if err := validateWritableDirectory(candidate.path, candidate.label, candidate.info); err != nil {
				return err
			}
		}
		if rel, relErr := filepath.Rel(appPath, task.LaunchPath); relErr != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return errors.New("launchPath must be inside UClaw.app")
		}
	} else {
		flagInfo, flagErr := os.Lstat(filepath.Join(task.RootDir, "portable.flag"))
		if flagErr != nil {
			return errors.New("rootDir is missing portable.flag")
		}
		if flagInfo.Mode()&os.ModeSymlink != 0 || !flagInfo.Mode().IsRegular() {
			return errors.New("rootDir portable.flag must be a file")
		}
	}
	if rel, err := filepath.Rel(task.RootDir, task.LaunchPath); err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return errors.New("launchPath must be inside rootDir")
	}
	if err := validateTaskWorkspacePaths(task); err != nil {
		return err
	}
	return nil
}

// normalizeAbsoluteTaskPath returns a stable lexical path for a task field.
// It deliberately does not resolve symlinks: the caller still needs the
// original path for filesystem operations, while the safety checks below
// resolve both the lexical and filesystem identities independently.
func normalizeAbsoluteTaskPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("path is empty")
	}
	if !filepath.IsAbs(value) {
		return "", errors.New("path must be absolute")
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(abs)
	if clean == "." || clean == string(filepath.Separator) {
		return clean, nil
	}
	return clean, nil
}

type taskPathKind uint8

const (
	taskPathStaging taskPathKind = iota
	taskPathMarker
	taskPathLog
)

// validateTaskWorkspacePaths protects every path that the helper may create,
// remove, or append to. The update root is never a valid workspace for these
// paths: a modified task must not be able to make RemoveAll(stagingDir) erase
// the installation, nor make the readiness marker/log alias user files.
//
// Both lexical and symlink-resolved identities are compared. The lexical
// comparison blocks paths such as rootDir/link-out/marker even when the link
// points elsewhere; the resolved comparison blocks an external symlink that
// points back into rootDir. Missing paths are resolved through their nearest
// existing ancestor so validation also covers paths that will be created later.
func validateTaskWorkspacePaths(task *updateTask) error {
	if task == nil {
		return errors.New("task is nil")
	}
	rootDir := task.RootDir
	if rootDir == "" {
		return errors.New("rootDir is required before workspace validation")
	}
	// The downloaded archive's parent is the only workspace the helper should
	// mutate.  Keeping this anchor in the generic validator protects direct
	// in-process callers as well as the canonical task-file path used by run().
	workspaceRoot, workspaceErr := normalizeAbsoluteTaskPath(filepath.Dir(task.ZipPath))
	if workspaceErr != nil {
		return fmt.Errorf("update workspace is invalid: %w", workspaceErr)
	}
	// The archive parent may legitimately be an ancestor of RootDir (for
	// example, a legacy fixture keeps `portable/` beside `update.zip`).  We do
	// not mutate that parent itself; each concrete staging/marker/log path is
	// checked below for both positive workspace containment and RootDir overlap.

	if task.StagingDir != "" {
		if err := validateTaskWorkspacePathInRoot(task.StagingDir, "stagingDir", rootDir, workspaceRoot, taskPathStaging, false); err != nil {
			return err
		}
	} else {
		// The default staging directory is created beside the downloaded ZIP.
		// Validate that parent before MkdirTemp so a ZIP hidden inside RootDir
		// cannot turn the implicit staging location into an in-place delete.
		stagingParent := filepath.Dir(task.ZipPath)
		if err := validateTaskWorkspacePathInRoot(stagingParent, "stagingDir parent", rootDir, workspaceRoot, taskPathStaging, true); err != nil {
			return err
		}
	}
	if err := validateTaskWorkspacePathInRoot(task.ReadyPath, "readyPath", rootDir, workspaceRoot, taskPathMarker, false); err != nil {
		return err
	}
	if task.LogPath != "" {
		logRoot := workspaceRoot
		if taskPathNamesEqual(filepath.Base(workspaceRoot), updatesDirName) {
			logRoot = filepath.Join(filepath.Dir(workspaceRoot), logsDirName)
		}
		if err := validateTaskWorkspacePathInRoot(task.LogPath, "logPath", rootDir, logRoot, taskPathLog, false); err != nil {
			return err
		}
	}
	return nil
}

// validateTaskWorkspacePathInRoot combines the installation containment check
// with a second, positive containment check against the archive/update
// workspace.  A task cannot choose an unrelated absolute directory merely
// because it is outside RootDir; all mutable paths must remain under the ZIP's
// parent.  allowRoot is used only for the implicit staging parent, which is
// never passed to RemoveAll itself (MkdirTemp creates a child there).
func validateTaskWorkspacePathInRoot(path string, label string, rootDir string, workspaceRoot string, kind taskPathKind, allowRoot bool) error {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return fmt.Errorf("%s is invalid: %w", label, err)
	}
	workspaceNormalized, err := normalizeAbsoluteTaskPath(workspaceRoot)
	if err != nil {
		return fmt.Errorf("update workspace is invalid: %w", err)
	}
	if err := validateTaskWorkspacePath(normalized, label, rootDir, kind); err != nil {
		return err
	}
	if !taskPathContains(workspaceNormalized, normalized) {
		return fmt.Errorf("%s must be inside the update workspace", label)
	}
	if !allowRoot && taskPathsEqual(workspaceNormalized, normalized) {
		return fmt.Errorf("%s must be below the update workspace", label)
	}
	if err := inspectPathComponentsWithin(normalized, workspaceNormalized, label); err != nil {
		return err
	}
	return nil
}

func validateTaskWorkspacePath(path string, label string, rootDir string, kind taskPathKind) error {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return fmt.Errorf("%s is invalid: %w", label, err)
	}
	rootNormalized, err := normalizeAbsoluteTaskPath(rootDir)
	if err != nil {
		return fmt.Errorf("rootDir is invalid: %w", err)
	}

	// Compare the lexical paths first, then compare symlink-resolved paths.
	// Checking both directions catches a candidate that is inside rootDir and a
	// candidate that is an ancestor of rootDir (the latter would let RemoveAll
	// delete the installation when used as stagingDir).
	if taskPathsOverlap(normalized, rootNormalized) {
		return fmt.Errorf("%s must be outside rootDir", label)
	}
	resolvedPath, resolveErr := canonicalTaskPath(normalized)
	if resolveErr != nil {
		return fmt.Errorf("%s cannot be resolved safely: %w", label, resolveErr)
	}
	resolvedRoot, resolveErr := canonicalTaskPath(rootNormalized)
	if resolveErr != nil {
		return fmt.Errorf("rootDir cannot be resolved safely: %w", resolveErr)
	}
	if taskPathsOverlap(resolvedPath, resolvedRoot) ||
		taskPathsOverlap(normalized, resolvedRoot) ||
		taskPathsOverlap(resolvedPath, rootNormalized) {
		return fmt.Errorf("%s must be outside rootDir", label)
	}

	// Never remove a caller-supplied file/symlink as staging, and never follow
	// a symlink when preparing the marker or opening the log. A missing target
	// is fine; its parent is checked by canonicalTaskPath above.
	if info, statErr := os.Lstat(normalized); statErr == nil {
		switch kind {
		case taskPathStaging:
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s must not be a symlink", label)
			}
			if !info.IsDir() {
				return fmt.Errorf("%s must be a directory when it already exists", label)
			}
		case taskPathMarker, taskPathLog:
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s must not be a symlink", label)
			}
			if info.IsDir() {
				return fmt.Errorf("%s must be a file path", label)
			}
		}
	} else if !os.IsNotExist(statErr) {
		return fmt.Errorf("%s cannot be inspected: %w", label, statErr)
	}
	return nil
}

// canonicalTaskPath resolves an existing path, or the nearest existing
// ancestor plus the unresolved suffix when the final path does not exist.
// This catches symlink escapes without requiring the updater to create any
// directory during validation.
func canonicalTaskPath(path string) (string, error) {
	normalized, err := normalizeAbsoluteTaskPath(path)
	if err != nil {
		return "", err
	}
	current := normalized
	var suffix []string
	for {
		if _, statErr := os.Lstat(current); statErr == nil {
			resolved, evalErr := filepath.EvalSymlinks(current)
			if evalErr != nil {
				return "", evalErr
			}
			resolved, evalErr = normalizeAbsoluteTaskPath(resolved)
			if evalErr != nil {
				return "", evalErr
			}
			for index := len(suffix) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, suffix[index])
			}
			return filepath.Clean(resolved), nil
		} else if !os.IsNotExist(statErr) {
			return "", statErr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return current, nil
		}
		suffix = append(suffix, filepath.Base(current))
		current = parent
	}
}

func taskPathsOverlap(left string, right string) bool {
	left = normalizeTaskPathForComparison(left)
	right = normalizeTaskPathForComparison(right)
	return taskPathContains(left, right) || taskPathContains(right, left)
}

func taskPathContains(base string, candidate string) bool {
	relative, err := filepath.Rel(base, candidate)
	if err != nil {
		return false
	}
	if relative == "." || relative == "" {
		return true
	}
	if filepath.IsAbs(relative) || relative == ".." {
		return false
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func normalizeTaskPathForComparison(path string) string {
	path = filepath.Clean(path)
	// Windows is case-insensitive, and the default macOS volume is commonly
	// case-insensitive as well. Treating Darwin conservatively here prevents a
	// case-only alias from bypassing the containment guard on APFS/HFS+.
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.ToLower(path)
	}
	return path
}

func taskPathNamesEqual(left string, right string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func taskPathsEqual(left string, right string) bool {
	return normalizeTaskPathForComparison(left) == normalizeTaskPathForComparison(right)
}

func validateWritableDirectory(path string, label string, info os.FileInfo) error {
	if info == nil {
		var err error
		info, err = os.Stat(path)
		if err != nil {
			return fmt.Errorf("%s is not available: %w", label, err)
		}
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", label)
	}
	if info.Mode().Perm()&0o222 == 0 || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s is not writable", label)
	}
	if err := directoryWriteAccess(path); err != nil {
		return fmt.Errorf("%s is not writable: %w", label, err)
	}
	return nil
}

// validateMacPortableDirectory validates the on-disk top-level contract using
// directory entry names rather than Stat(path). APFS/HFS+ can resolve a path
// case-insensitively, so Stat alone would accept Portable.flag or uclawdata and
// let a later replacement alias the wrong entry.
func validateMacPortableDirectory(rootDir string, label string) error {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		return fmt.Errorf("%s cannot be read: %w", label, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if err := validateMacTopLevelCaseCollisions(names); err != nil {
		return fmt.Errorf("%s has unsafe top-level entries: %w", label, err)
	}
	if err := validateMacRequiredEntry(entries, "portable.flag", false, label); err != nil {
		return err
	}
	if err := validateMacRequiredEntry(entries, defaultDataDirName, true, label); err != nil {
		return err
	}
	if err := validateMacRequiredEntry(entries, "UClaw.app", true, label); err != nil {
		return err
	}
	return nil
}

func validateMacRequiredEntry(entries []os.DirEntry, name string, wantDir bool, label string) error {
	var found os.DirEntry
	for _, entry := range entries {
		if entry.Name() == name {
			found = entry
			break
		}
	}
	if found == nil {
		if wantDir {
			return fmt.Errorf("%s is missing %s directory", label, name)
		}
		return fmt.Errorf("%s is missing %s", label, name)
	}
	if found.Type()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s %s must not be a symlink", label, name)
	}
	info, err := found.Info()
	if err != nil {
		return fmt.Errorf("cannot inspect %s %s: %w", label, name, err)
	}
	if wantDir {
		if !info.IsDir() {
			return fmt.Errorf("%s %s must be a directory", label, name)
		}
		return nil
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return fmt.Errorf("%s %s must be a regular file", label, name)
	}
	return nil
}

// validateMacTopLevelCaseCollisions rejects names that would alias on the
// default case-insensitive macOS filesystems. It also rejects case variants of
// the reserved portable names even when no exact spelling is present.
func validateMacTopLevelCaseCollisions(names []string) error {
	reserved := []string{"portable.flag", defaultDataDirName, "UClaw.app", backupDirName}
	for index, name := range names {
		for _, expected := range reserved {
			if name != expected && strings.EqualFold(name, expected) {
				return fmt.Errorf("entry %q is a case variant of reserved name %q", name, expected)
			}
		}
		for previous := 0; previous < index; previous++ {
			if names[previous] != name && strings.EqualFold(names[previous], name) {
				return fmt.Errorf("entries %q and %q collide by case", names[previous], name)
			}
		}
	}
	return nil
}

type macZipTopLevelEntry struct {
	hasDirectEntry  bool
	directIsDir     bool
	directSymlink   bool
	hasNestedEntry  bool
	duplicateDirect bool
}

// Validate the archive before invoking ditto. On a case-insensitive volume,
// ditto may collapse two case variants during extraction, making a post-copy
// check too late to protect UClawData or the app bundle.
func validateMacPortableZipEntries(files []*zip.File, dataDirName string) error {
	if dataDirName != defaultDataDirName {
		return fmt.Errorf("macOS portable data directory must be %s", defaultDataDirName)
	}
	entries := make(map[string]macZipTopLevelEntry)
	names := make([]string, 0, len(files))
	allPaths := make(map[string]struct{}, len(files))
	for _, file := range files {
		normalized, err := normalizedZipEntryPath(file.Name)
		if err != nil {
			return err
		}
		pathKey := strings.ToLower(normalized)
		if _, duplicate := allPaths[pathKey]; duplicate {
			return fmt.Errorf("update archive contains duplicate or case-variant entry %q", file.Name)
		}
		allPaths[pathKey] = struct{}{}
		topLevel := normalized
		nested := false
		if separator := strings.IndexByte(normalized, '/'); separator >= 0 {
			topLevel = normalized[:separator]
			nested = true
		}
		if _, exists := entries[topLevel]; !exists {
			names = append(names, topLevel)
		}
		entry := entries[topLevel]
		if nested {
			entry.hasNestedEntry = true
		} else {
			if entry.hasDirectEntry {
				entry.duplicateDirect = true
			}
			entry.hasDirectEntry = true
			entry.directIsDir = file.FileInfo().IsDir()
			entry.directSymlink = file.Mode()&os.ModeSymlink != 0
		}
		entries[topLevel] = entry
	}
	if err := validateMacTopLevelCaseCollisions(names); err != nil {
		return fmt.Errorf("update archive has unsafe top-level entries: %w", err)
	}
	for _, required := range []struct {
		name string
		dir  bool
	}{
		{name: "portable.flag"},
		{name: defaultDataDirName, dir: true},
		{name: "UClaw.app", dir: true},
	} {
		entry, ok := entries[required.name]
		if !ok {
			if required.dir {
				return fmt.Errorf("update archive is missing %s directory", required.name)
			}
			return fmt.Errorf("update archive is missing %s", required.name)
		}
		if entry.directSymlink {
			return fmt.Errorf("update archive %s must not be a symlink", required.name)
		}
		if entry.duplicateDirect {
			return fmt.Errorf("update archive %s appears more than once", required.name)
		}
		if required.dir {
			if entry.hasDirectEntry && !entry.directIsDir {
				return fmt.Errorf("update archive %s has a file/directory collision", required.name)
			}
			if !entry.directIsDir && !entry.hasNestedEntry {
				return fmt.Errorf("update archive %s must be a directory", required.name)
			}
			continue
		}
		if !entry.hasDirectEntry || entry.directIsDir || entry.hasNestedEntry {
			return fmt.Errorf("update archive %s must be a regular file", required.name)
		}
	}
	return nil
}

func openLog(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

func (u *updater) logf(format string, args ...any) {
	line := fmt.Sprintf("%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
	if u.logFile != nil {
		_, _ = u.logFile.WriteString(line)
	}
	_, _ = os.Stderr.WriteString(line)
}

func (u *updater) writeResult(result updateResult) {
	if err := validateTaskResultPath(u.taskPath); err != nil {
		u.logf("refusing to write update result: %v", err)
		return
	}
	result.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		u.logf("failed to marshal result: %v", err)
		return
	}
	resultPath := u.taskPath + resultSuffix
	if err := os.WriteFile(resultPath, append(raw, '\n'), 0o600); err != nil {
		u.logf("failed to write result: %v", err)
	}
}

func validateTaskResultPath(taskPath string) error {
	normalized, err := normalizeAbsoluteTaskPath(taskPath)
	if err != nil {
		return err
	}
	if err := validateTaskFilePath(normalized); err != nil {
		return err
	}
	resultPath := normalized + resultSuffix
	if err := validateNoSymlinkComponents(filepath.Dir(normalized), resultPath, "task result path"); err != nil {
		return err
	}
	if info, statErr := os.Lstat(resultPath); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("task result path must be a regular file")
		}
	} else if !os.IsNotExist(statErr) {
		return fmt.Errorf("task result path cannot be inspected: %w", statErr)
	}
	return nil
}

func (u *updater) apply() (backupDir string, stagingDir string, launchedPath string, err error) {
	// `run` validates before calling apply, but keep the destructive operation
	// safe for in-process callers and tests as well. In particular, this must
	// happen before prepareStagingDir can invoke RemoveAll on a task path.
	if err := u.validateForApply(); err != nil {
		return "", "", "", err
	}
	if u.task.ParentPID > 0 {
		if err := validateParentPID(u.task.ParentPID, u.task.LaunchPath); err != nil {
			return "", "", "", fmt.Errorf("refusing to use parent process: %w", err)
		}
	}
	u.progress.Update(progressState{
		Title:   "正在校验更新包",
		Detail:  "正在检查文件完整性。",
		Percent: 8,
	})
	if err := verifyZip(u.task.ZipPath, u.task.Size, u.task.Sha512); err != nil {
		return "", "", "", err
	}

	u.progress.Update(progressState{
		Title:   "正在准备更新文件",
		Detail:  "正在创建临时目录。",
		Percent: 18,
	})
	stagingDir, err = u.prepareStagingDir()
	if err != nil {
		return "", "", "", err
	}
	u.logf("extracting update zip to %s", stagingDir)
	if err := extractZip(u.task.ZipPath, stagingDir, func(percent int, detail string) {
		u.progress.Update(progressState{
			Title:   "正在解压更新包",
			Detail:  detail,
			Percent: clampProgressPercent(percent, 20, 58),
		})
	}); err != nil {
		_ = removeStagingDir(stagingDir)
		return "", stagingDir, "", err
	}
	u.progress.Update(progressState{
		Title:   "正在检查新版文件",
		Detail:  "正在确认更新包内容。",
		Percent: 60,
	})
	if err := u.validateStaging(stagingDir); err != nil {
		_ = removeStagingDir(stagingDir)
		return "", stagingDir, "", err
	}
	if runtime.GOOS == "darwin" {
		if err := validateMacReplacementCaseMatches(stagingDir, u.task.RootDir, u.task.DataDirName); err != nil {
			_ = removeStagingDir(stagingDir)
			return "", stagingDir, "", err
		}
	}

	backupDir, err = u.createBackupDir()
	if err != nil {
		_ = removeStagingDir(stagingDir)
		return "", stagingDir, "", err
	}
	u.logf("backing up current app files to %s", backupDir)
	u.progress.Update(progressState{
		Title:   "正在备份旧版本",
		Detail:  "正在保存可回滚的旧文件。",
		Percent: 64,
	})
	replacementEntries, err := replacementEntrySet(stagingDir, u.task.DataDirName)
	if err != nil {
		_ = removeStagingDir(stagingDir)
		return backupDir, stagingDir, "", err
	}

	moved, err := u.moveCurrentFilesToBackup(backupDir, replacementEntries)
	if err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, nil, moved, err)
	}

	lastCopyLog := time.Time{}
	copied, err := copyReplacementFiles(stagingDir, u.task.RootDir, u.task.DataDirName, func(copyProgress replacementCopyProgress) {
		u.progress.Update(progressState{
			Title:   "正在安装新版文件",
			Detail:  formatReplacementProgressDetail(copyProgress),
			Percent: clampProgressPercent(copyProgress.Percent, 70, 92),
		})
		now := time.Now()
		if lastCopyLog.IsZero() || now.Sub(lastCopyLog) >= copyLogInterval || copyProgress.Percent >= 100 {
			u.logf(
				"install progress: entry=%s files=%d/%d bytes=%d/%d percent=%d",
				copyProgress.CurrentEntry,
				copyProgress.CompletedFiles,
				copyProgress.TotalFiles,
				copyProgress.CompletedBytes,
				copyProgress.TotalBytes,
				copyProgress.Percent,
			)
			lastCopyLog = now
		}
	})
	if err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, err)
	}

	launchPath := u.task.LaunchPath
	if info, statErr := os.Lstat(launchPath); statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		u.logf("declared launch path unavailable after update: %v", statErr)
		launchPath = findLaunchPath(u.task.RootDir)
		if launchPath == "" {
			return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, errors.New("updated app launch path was not found"))
		}
	}
	if err := chmodExecutable(launchPath); err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, fmt.Errorf("failed to make updated app executable: %w", err))
	}
	if u.workspace != nil {
		if err := validateTrustedWorkspacePath(
			u.task.ReadyPath,
			u.workspace.readyRoot,
			"readyPath",
			taskPathMarker,
			taskFilePrefix+u.workspace.stamp+".ready.json",
		); err != nil {
			return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, err)
		}
	}
	if err := prepareReadyMarker(u.task.ReadyPath); err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, fmt.Errorf("failed to prepare startup verification: %w", err))
	}

	u.progress.Update(progressState{
		Title:   "正在启动新版 UClaw",
		Detail:  "更新即将完成。",
		Percent: 96,
	})
	startedApp, err := startUpdatedApp(launchPath, u.task.RootDir, u.task.ReadyPath)
	if err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, err)
	}
	if err := waitForUpdatedAppReady(u.task.ReadyPath, u.task.TargetVersion, startedApp, startupReadyWait); err != nil {
		u.logf("updated app did not become ready: %v", err)
		if stopErr := stopUpdatedApp(startedApp, u.logf); stopErr != nil {
			return backupDir, stagingDir, "", &updateFailure{
				cause:              fmt.Errorf("updated app failed startup: %w; automatic rollback was skipped because the new app could not be stopped: %v; backup remains at %s", err, stopErr, backupDir),
				restartPreviousApp: false,
			}
		}
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, fmt.Errorf("updated app failed startup verification: %w", err))
	}

	if err := removeStagingDir(stagingDir); err != nil {
		u.logf("failed to remove staging directory after successful update: %v", err)
	}
	cleanupOldBackups(filepath.Join(u.task.RootDir, backupDirName), backupDir, 7*24*time.Hour, u.logf)
	return backupDir, stagingDir, launchPath, nil
}

// validateForApply preserves the small, legacy in-process test fixtures that
// construct an updater without a task file, while ensuring any real task-file
// invocation uses the same workspace binding as run().  The helper's public
// entry point is run(), but keeping this guard here prevents a future caller
// from accidentally reaching RemoveAll/copy operations with an untrusted
// canonical task path.
func (u *updater) validateForApply() error {
	if u == nil {
		return errors.New("updater is nil")
	}
	if u.workspace != nil {
		return validateTaskAtPath(&u.task, u.taskPath)
	}
	if strings.TrimSpace(u.taskPath) != "" {
		normalized, normalizeErr := normalizeAbsoluteTaskPath(u.taskPath)
		if normalizeErr == nil && taskPathLooksCanonical(normalized) {
			if err := validateTaskFilePath(normalized); err != nil {
				return err
			}
			workspace, err := resolveTaskWorkspace(normalized)
			if err != nil {
				return err
			}
			u.taskPath = normalized
			u.workspace = &workspace
			return validateTaskAtPath(&u.task, normalized)
		}
	}
	return validateTask(&u.task)
}

func taskPathLooksCanonical(path string) bool {
	path = filepath.Clean(path)
	name := filepath.Base(path)
	if !strings.HasPrefix(name, taskFilePrefix) || !strings.HasSuffix(name, taskFileSuffix) {
		return false
	}
	tasksDir := filepath.Dir(path)
	updatesRoot := filepath.Dir(tasksDir)
	return taskPathNamesEqual(filepath.Base(tasksDir), tasksDirName) &&
		taskPathNamesEqual(filepath.Base(updatesRoot), updatesDirName)
}

// createBackupDir must not reuse a previous attempt's second-level timestamp.
// Users can retry immediately after a failed update, and sharing a backup
// directory would make a later rollback ambiguous.
func (u *updater) createBackupDir() (string, error) {
	if u == nil {
		return "", errors.New("updater is nil")
	}
	rootDir, err := normalizeAbsoluteTaskPath(u.task.RootDir)
	if err != nil {
		return "", fmt.Errorf("rootDir is invalid: %w", err)
	}
	rootInfo, err := os.Lstat(rootDir)
	if err != nil {
		return "", fmt.Errorf("rootDir cannot be inspected: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return "", errors.New("rootDir must be a real directory")
	}
	backupsRoot := filepath.Join(rootDir, backupDirName)
	// The backup directory is destructive-update state. Never let a stale or
	// tampered symlink redirect it outside the installation root. The bounded
	// component walk starts at rootDir, so normal macOS aliases above the
	// portable root (for example /var -> /private/var) remain harmless.
	if err := validateNoSymlinkComponents(rootDir, backupsRoot, "backup directory"); err != nil {
		return "", err
	}
	if info, statErr := os.Lstat(backupsRoot); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", errors.New("backup directory must be a real directory")
		}
	} else if !os.IsNotExist(statErr) {
		return "", fmt.Errorf("backup directory cannot be inspected: %w", statErr)
	} else {
		// rootDir is already present, so a single-level Mkdir avoids MkdirAll
		// following a directory symlink inserted between validation and create.
		if mkdirErr := os.Mkdir(backupsRoot, 0o755); mkdirErr != nil && !os.IsExist(mkdirErr) {
			return "", mkdirErr
		}
		info, statErr := os.Lstat(backupsRoot)
		if statErr != nil {
			return "", fmt.Errorf("backup directory could not be created: %w", statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", errors.New("backup directory must be a real directory")
		}
	}
	// Re-check immediately before creating a unique child to catch a symlink
	// swap that happened while Mkdir ran.
	if err := validateNoSymlinkComponents(rootDir, backupsRoot, "backup directory"); err != nil {
		return "", err
	}
	backupDir, err := os.MkdirTemp(backupsRoot, time.Now().UTC().Format("20060102-150405")+"-")
	if err != nil {
		return "", err
	}
	// Bind the returned directory to the root we just validated.  If an
	// attacker swapped the backup parent during MkdirTemp, do not proceed with
	// a directory that resolves outside the installation.  Leave the unknown
	// directory in place rather than recursively deleting an untrusted path.
	if err := validateReplacementRoots(backupDir, rootDir); err != nil {
		return "", fmt.Errorf("backup directory changed during creation: %w", err)
	}
	return backupDir, nil
}

func (u *updater) rollbackAfterFailure(backupDir string, stagingDir string, copied []string, moved []string, cause error) (string, string, string, error) {
	u.logf("update step failed; restoring the previous version: %v", cause)
	if rollbackErr := rollbackReplacement(backupDir, u.task.RootDir, copied, moved); rollbackErr != nil {
		u.logf("automatic rollback failed; preserving backup at %s: %v", backupDir, rollbackErr)
		return backupDir, stagingDir, "", &updateFailure{
			cause:              fmt.Errorf("%w; automatic rollback failed: %v; do not delete the backup at %s", cause, rollbackErr, backupDir),
			restartPreviousApp: false,
		}
	}
	if err := removeStagingDir(stagingDir); err != nil {
		u.logf("failed to remove staging directory after rollback: %v", err)
	}
	return backupDir, stagingDir, "", &updateFailure{
		cause:              fmt.Errorf("%w; previous version restored", cause),
		restartPreviousApp: true,
	}
}

func shouldRestartPreviousApp(err error) bool {
	var failure *updateFailure
	if errors.As(err, &failure) {
		return failure.restartPreviousApp
	}
	return true
}

func clampProgressPercent(value int, min int, max int) int {
	if max <= min {
		return min
	}
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return min + ((max - min) * value / 100)
}

func verifyZip(path string, expectedSize int64, expectedSha512 string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() != expectedSize {
		return fmt.Errorf("zip size mismatch: expected %d, got %d", expectedSize, info.Size())
	}

	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	hash := sha512.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expectedSha512) {
		return errors.New("zip sha512 mismatch")
	}
	return nil
}

// removeStagingDir cleans up an extracted update tree. macOS app bundles may
// legitimately contain read-only descendants (ditto preserves those modes),
// so make only this disposable staging tree writable before removing it. The
// installed app bundle is never passed through this helper.
func removeStagingDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if runtime.GOOS != "darwin" {
		return os.RemoveAll(path)
	}
	// Walk the tree first so read-only descendants do not prevent RemoveAll on
	// macOS, but keep a missing staging directory idempotent.
	if info, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("staging path must be a real directory: %s", path)
	}
	writableErr := filepath.Walk(path, func(currentPath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return filepath.SkipDir
			}
			return walkErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if info.IsDir() {
			return os.Chmod(currentPath, info.Mode().Perm()|0o700)
		}
		return nil
	})
	removeErr := os.RemoveAll(path)
	if os.IsNotExist(removeErr) {
		removeErr = nil
	}
	if removeErr != nil {
		if writableErr != nil {
			return errors.Join(writableErr, removeErr)
		}
		return removeErr
	}
	return nil
}

func (u *updater) prepareStagingDir() (string, error) {
	if u.task.StagingDir != "" {
		if u.workspace != nil {
			if err := validateTrustedWorkspacePath(u.task.StagingDir, u.workspace.stagingRoot, "stagingDir", taskPathStaging, u.workspace.stamp); err != nil {
				return "", err
			}
		} else if err := validateTaskWorkspacePath(u.task.StagingDir, "stagingDir", u.task.RootDir, taskPathStaging); err != nil {
			return "", err
		}
		if err := removeStagingDir(u.task.StagingDir); err != nil {
			return "", err
		}
		if err := os.MkdirAll(u.task.StagingDir, 0o755); err != nil {
			return "", err
		}
		return u.task.StagingDir, nil
	}
	base := filepath.Dir(u.task.ZipPath)
	if u.workspace != nil {
		base = u.workspace.stagingRoot
		if err := validateNoSymlinkComponents(u.workspace.updatesRoot, base, "stagingDir parent"); err != nil {
			return "", err
		}
	} else if err := validateTaskWorkspacePath(base, "stagingDir parent", u.task.RootDir, taskPathStaging); err != nil {
		return "", err
	}
	stagingDir, err := os.MkdirTemp(base, "uclaw-update-staging-")
	if err != nil {
		return "", err
	}
	if u.workspace != nil {
		if err := validateNoSymlinkComponents(u.workspace.stagingRoot, stagingDir, "stagingDir"); err != nil {
			_ = removeStagingDir(stagingDir)
			return "", err
		}
	} else if err := validateTaskWorkspacePath(stagingDir, "stagingDir", u.task.RootDir, taskPathStaging); err != nil {
		_ = removeStagingDir(stagingDir)
		return "", err
	}
	return stagingDir, nil
}

func extractZip(zipPath string, destDir string, onProgress func(percent int, detail string)) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer reader.Close()
	if err := validateZipEntries(reader.File); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		if err := validateMacPortableZipEntries(reader.File, defaultDataDirName); err != nil {
			return err
		}
	}

	// macOS app bundles carry code-signing and other metadata in extended
	// attributes. The USB archive is created with ditto, so use it for both
	// extraction and .app copying instead of silently dropping that metadata.
	if runtime.GOOS == "darwin" {
		return extractMacZipWithDitto(zipPath, destDir, onProgress)
	}

	destClean, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	totalEntries := len(reader.File)
	if totalEntries == 0 && onProgress != nil {
		onProgress(100, "更新包为空。")
	}
	for index, file := range reader.File {
		if onProgress != nil {
			current := index + 1
			onProgress(current*100/totalEntries, fmt.Sprintf("正在解压 %d/%d", current, totalEntries))
		}
		name, err := normalizedZipEntryPath(file.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(destClean, filepath.FromSlash(name))
		targetClean, err := filepath.Abs(target)
		if err != nil {
			return err
		}
		if targetClean == destClean || !strings.HasPrefix(targetClean, destClean+string(os.PathSeparator)) {
			return fmt.Errorf("zip entry escapes staging directory: %s", file.Name)
		}

		mode := file.Mode()
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(targetClean, dirPerm(mode)); err != nil {
				return err
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(targetClean), 0o755); err != nil {
			return err
		}

		if mode&os.ModeSymlink != 0 {
			if err := extractSymlink(file, targetClean); err != nil {
				return err
			}
			continue
		}

		if err := extractRegularFile(file, targetClean, filePerm(mode)); err != nil {
			return err
		}
	}
	if onProgress != nil {
		onProgress(100, "解压完成。")
	}
	return nil
}

func validateZipEntries(files []*zip.File) error {
	for _, file := range files {
		if _, err := normalizedZipEntryPath(file.Name); err != nil {
			return err
		}
		if file.Mode()&os.ModeSymlink == 0 {
			continue
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		raw, readErr := io.ReadAll(src)
		closeErr := src.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if err := validateZipSymlinkTarget(string(raw), file.Name); err != nil {
			return err
		}
	}
	return nil
}

func normalizedZipEntryPath(rawName string) (string, error) {
	name := strings.ReplaceAll(rawName, "\\", "/")
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(name)))
	if name == "" || strings.HasPrefix(name, "/") || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("unsafe zip entry path: %s", rawName)
	}
	portablePath := filepath.FromSlash(clean)
	if filepath.IsAbs(portablePath) || filepath.VolumeName(portablePath) != "" {
		return "", fmt.Errorf("unsafe zip entry path: %s", rawName)
	}
	return clean, nil
}

func validateZipSymlinkTarget(linkTarget string, entryName string) error {
	normalized := strings.ReplaceAll(linkTarget, "\\", "/")
	parts := strings.Split(normalized, "/")
	for _, part := range parts {
		if part == ".." {
			return fmt.Errorf("unsafe symlink target in zip entry %s", entryName)
		}
	}
	if linkTarget == "" || filepath.IsAbs(linkTarget) || filepath.VolumeName(linkTarget) != "" {
		return fmt.Errorf("unsafe symlink target in zip entry %s", entryName)
	}
	return nil
}

func extractMacZipWithDitto(zipPath string, destDir string, onProgress func(percent int, detail string)) error {
	if onProgress != nil {
		onProgress(5, "正在保留 macOS 应用签名和权限。")
	}
	output, err := exec.Command("/usr/bin/ditto", "-x", "-k", zipPath, destDir).CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to extract macOS update archive with ditto: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	if onProgress != nil {
		onProgress(100, "解压完成。")
	}
	return nil
}

func dirPerm(mode os.FileMode) os.FileMode {
	perm := mode.Perm()
	if perm == 0 {
		return 0o755
	}
	return perm
}

func filePerm(mode os.FileMode) os.FileMode {
	perm := mode.Perm()
	if perm == 0 {
		return 0o644
	}
	return perm
}

func extractRegularFile(file *zip.File, target string, perm os.FileMode) error {
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func extractSymlink(file *zip.File, target string) error {
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	raw, err := io.ReadAll(src)
	if err != nil {
		return err
	}
	linkTarget := string(raw)
	if err := validateZipSymlinkTarget(linkTarget, file.Name); err != nil {
		return err
	}
	_ = os.Remove(target)
	return os.Symlink(linkTarget, target)
}

func (u *updater) validateStaging(stagingDir string) error {
	if runtime.GOOS == "darwin" {
		if err := validateMacPortableDirectory(stagingDir, "update package"); err != nil {
			return err
		}
	}
	flagPath := filepath.Join(stagingDir, "portable.flag")
	if flagInfo, err := os.Lstat(flagPath); err != nil {
		return errors.New("update package is missing portable.flag")
	} else if flagInfo.Mode()&os.ModeSymlink != 0 || !flagInfo.Mode().IsRegular() {
		return errors.New("update package portable.flag must be a regular file")
	}
	relLaunch, err := filepath.Rel(u.task.RootDir, u.task.LaunchPath)
	if err == nil && relLaunch != "." && !strings.HasPrefix(relLaunch, "..") && !filepath.IsAbs(relLaunch) {
		if info, statErr := os.Lstat(filepath.Join(stagingDir, relLaunch)); statErr == nil && info.Mode()&os.ModeSymlink == 0 && info.Mode().IsRegular() {
			return nil
		}
	}
	if fallback := findLaunchPath(stagingDir); fallback != "" {
		return nil
	}
	return errors.New("update package is missing the UClaw executable")
}

func replacementEntrySet(stagingDir string, dataDirName string) (map[string]struct{}, error) {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return nil, err
	}
	replacements := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldSkipRootEntry(name, dataDirName) {
			continue
		}
		replacements[replacementEntryKey(name)] = struct{}{}
	}
	return replacements, nil
}

func (u *updater) moveCurrentFilesToBackup(backupDir string, replacementEntries map[string]struct{}) ([]string, error) {
	if err := validateReplacementRoots(backupDir, u.task.RootDir); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(u.task.RootDir)
	if err != nil {
		return nil, err
	}
	moved := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldSkipRootEntry(name, u.task.DataDirName) {
			continue
		}
		if _, shouldReplace := replacementEntries[replacementEntryKey(name)]; !shouldReplace {
			u.logf("leaving root entry unchanged because it is not in the update package: %s", name)
			continue
		}
		if err := validateRollbackEntryName(name); err != nil {
			return moved, err
		}
		src := filepath.Join(u.task.RootDir, name)
		dst := filepath.Join(backupDir, name)
		if err := retry(fmt.Sprintf("move %s", name), moveRetryAttempts, moveRetryDelay, func() error {
			if err := validateReplacementRoots(backupDir, u.task.RootDir); err != nil {
				return err
			}
			return os.Rename(src, dst)
		}); err != nil {
			return moved, err
		}
		moved = append(moved, name)
	}
	return moved, nil
}

func shouldSkipRootEntry(name string, dataDirName string) bool {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return strings.EqualFold(name, dataDirName) || strings.EqualFold(name, backupDirName)
	}
	return name == dataDirName || name == backupDirName
}

func replacementEntryKey(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(name)
	}
	return name
}

// On a case-sensitive APFS volume, lower-casing every replacement key would
// make an archive entry such as `resources` move an unrelated existing
// `Resources` tree. On a case-insensitive volume, leaving that alias in place
// is equally unsafe because rollback would lack the exact backup entry. Reject
// cross-tree case variants and keep Darwin replacement identity exact.
func validateMacReplacementCaseMatches(stagingDir string, rootDir string, dataDirName string) error {
	stagingEntries, err := os.ReadDir(stagingDir)
	if err != nil {
		return err
	}
	rootEntries, err := os.ReadDir(rootDir)
	if err != nil {
		return err
	}
	rootByFoldedName := make(map[string]string, len(rootEntries))
	for _, entry := range rootEntries {
		if shouldSkipRootEntry(entry.Name(), dataDirName) {
			continue
		}
		key := strings.ToLower(entry.Name())
		if previous, exists := rootByFoldedName[key]; exists && previous != entry.Name() {
			return fmt.Errorf("root entries %q and %q collide by case", previous, entry.Name())
		}
		rootByFoldedName[key] = entry.Name()
	}
	for _, entry := range stagingEntries {
		if shouldSkipRootEntry(entry.Name(), dataDirName) {
			continue
		}
		if existing, exists := rootByFoldedName[strings.ToLower(entry.Name())]; exists && existing != entry.Name() {
			return fmt.Errorf("update entry %q differs in case from existing root entry %q", entry.Name(), existing)
		}
	}
	return nil
}

type replacementProgressTracker struct {
	mu             sync.Mutex
	totalFiles     int64
	totalBytes     int64
	completedFiles int64
	completedBytes int64
	currentEntry   string
	lastEmit       time.Time
	onProgress     func(replacementCopyProgress)
}

func newReplacementProgressTracker(
	totalFiles int64,
	totalBytes int64,
	onProgress func(replacementCopyProgress),
) *replacementProgressTracker {
	return &replacementProgressTracker{
		totalFiles: totalFiles,
		totalBytes: totalBytes,
		onProgress: onProgress,
	}
}

func progressBasisPoints(completed int64, total int64) int64 {
	if total <= 0 {
		return -1
	}
	if completed <= 0 {
		return 0
	}
	if completed >= total {
		return 10_000
	}
	return completed * 10_000 / total
}

func replacementProgressPercent(completedFiles int64, totalFiles int64, completedBytes int64, totalBytes int64) int {
	fileProgress := progressBasisPoints(completedFiles, totalFiles)
	byteProgress := progressBasisPoints(completedBytes, totalBytes)
	var combined int64
	switch {
	case fileProgress >= 0 && byteProgress >= 0:
		// Bytes represent transfer volume while file count captures the real
		// filesystem overhead of tens of thousands of small runtime files.
		combined = (byteProgress*7 + fileProgress*3) / 10
	case byteProgress >= 0:
		combined = byteProgress
	case fileProgress >= 0:
		combined = fileProgress
	default:
		return 100
	}
	return int(combined / 100)
}

func (t *replacementProgressTracker) snapshotLocked() replacementCopyProgress {
	return replacementCopyProgress{
		Percent: replacementProgressPercent(
			t.completedFiles,
			t.totalFiles,
			t.completedBytes,
			t.totalBytes,
		),
		CurrentEntry:   t.currentEntry,
		CompletedFiles: t.completedFiles,
		TotalFiles:     t.totalFiles,
		CompletedBytes: t.completedBytes,
		TotalBytes:     t.totalBytes,
	}
}

func (t *replacementProgressTracker) emitLocked(force bool) {
	if t.onProgress == nil {
		return
	}
	now := time.Now()
	if !force && !t.lastEmit.IsZero() && now.Sub(t.lastEmit) < replacementProgressEmitInterval {
		return
	}
	t.lastEmit = now
	t.onProgress(t.snapshotLocked())
}

func (t *replacementProgressTracker) setCurrentEntry(name string) {
	t.mu.Lock()
	t.currentEntry = name
	t.emitLocked(true)
	t.mu.Unlock()
}

func (t *replacementProgressTracker) addBytes(count int64) {
	if count <= 0 {
		return
	}
	t.mu.Lock()
	t.completedBytes += count
	if t.completedBytes > t.totalBytes {
		t.completedBytes = t.totalBytes
	}
	t.emitLocked(false)
	t.mu.Unlock()
}

func (t *replacementProgressTracker) completeFile() {
	t.mu.Lock()
	t.completedFiles++
	if t.completedFiles > t.totalFiles {
		t.completedFiles = t.totalFiles
	}
	t.emitLocked(false)
	t.mu.Unlock()
}

func (t *replacementProgressTracker) completeMovedEntry(files int64, bytes int64) {
	t.mu.Lock()
	t.completedFiles += files
	t.completedBytes += bytes
	if t.completedFiles > t.totalFiles {
		t.completedFiles = t.totalFiles
	}
	if t.completedBytes > t.totalBytes {
		t.completedBytes = t.totalBytes
	}
	t.emitLocked(true)
	t.mu.Unlock()
}

func (t *replacementProgressTracker) finish() {
	t.mu.Lock()
	t.completedFiles = t.totalFiles
	t.completedBytes = t.totalBytes
	t.emitLocked(true)
	t.mu.Unlock()
}

func (t *replacementProgressTracker) startHeartbeat() func() {
	if t.onProgress == nil {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(copyHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				t.mu.Lock()
				t.emitLocked(true)
				t.mu.Unlock()
			case <-stop:
				return
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

func formatByteCount(value int64) string {
	const kib = 1024
	const mib = 1024 * kib
	if value < mib {
		return fmt.Sprintf("%.1f KiB", float64(value)/float64(kib))
	}
	return fmt.Sprintf("%.1f MiB", float64(value)/float64(mib))
}

func formatReplacementProgressDetail(progress replacementCopyProgress) string {
	entry := progress.CurrentEntry
	if entry == "" {
		entry = "新版文件"
	}
	if progress.TotalBytes <= 0 {
		return fmt.Sprintf("%s：%d/%d 个文件", entry, progress.CompletedFiles, progress.TotalFiles)
	}
	return fmt.Sprintf(
		"%s：%d/%d 个文件，%s/%s",
		entry,
		progress.CompletedFiles,
		progress.TotalFiles,
		formatByteCount(progress.CompletedBytes),
		formatByteCount(progress.TotalBytes),
	)
}

func appendReplacementPlan(plan *replacementCopyPlan, src string, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		plan.symlinks = append(plan.symlinks, replacementSymlink{dst: dst, target: target})
		plan.totalFiles++
		return nil
	}
	if info.IsDir() {
		plan.directories = append(plan.directories, replacementDirectory{dst: dst, perm: info.Mode().Perm()})
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := appendReplacementPlan(
				plan,
				filepath.Join(src, entry.Name()),
				filepath.Join(dst, entry.Name()),
			); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported update entry type: %s", src)
	}
	plan.files = append(plan.files, replacementFile{
		src:  src,
		dst:  dst,
		perm: info.Mode().Perm(),
		size: info.Size(),
	})
	plan.totalFiles++
	plan.totalBytes += info.Size()
	return nil
}

func buildReplacementWork(stagingDir string, rootDir string, dataDirName string) ([]replacementWork, int64, int64, error) {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return nil, 0, 0, err
	}
	work := make([]replacementWork, 0, len(entries))
	var totalFiles int64
	var totalBytes int64
	for _, entry := range entries {
		name := entry.Name()
		if shouldSkipRootEntry(name, dataDirName) {
			continue
		}
		src := filepath.Join(stagingDir, name)
		dst := filepath.Join(rootDir, name)
		plan := replacementCopyPlan{}
		if err := appendReplacementPlan(&plan, src, dst); err != nil {
			return nil, 0, 0, err
		}
		work = append(work, replacementWork{name: name, src: src, dst: dst, plan: plan})
		totalFiles += plan.totalFiles
		totalBytes += plan.totalBytes
	}
	return work, totalFiles, totalBytes, nil
}

func defaultTryFastMoveReplacement(src string, dst string) (bool, error) {
	if runtime.GOOS != "windows" {
		return false, nil
	}
	srcVolume := filepath.VolumeName(src)
	dstVolume := filepath.VolumeName(dst)
	if srcVolume == "" || dstVolume == "" || !strings.EqualFold(srcVolume, dstVolume) {
		return false, nil
	}
	if err := os.Rename(src, dst); err != nil {
		// Antivirus can briefly retain a handle even on the same volume. The
		// normal copy path remains a safe fallback because dst is still absent.
		return false, nil
	}
	return true, nil
}

func copyWorkerCount(fileCount int) int {
	if fileCount <= 1 {
		return fileCount
	}
	workers := runtime.GOMAXPROCS(0)
	if workers > maxCopyWorkers {
		workers = maxCopyWorkers
	}
	if workers < 2 {
		workers = 2
	}
	if workers > fileCount {
		workers = fileCount
	}
	return workers
}

func copyReplacementFile(file replacementFile, tracker *replacementProgressTracker) error {
	input, err := os.Open(file.src)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(file.dst), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(file.dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, file.perm)
	if err != nil {
		return err
	}
	buffer := replacementCopyBufferPool.Get().([]byte)
	writer := &replacementProgressWriter{writer: output, tracker: tracker}
	_, copyErr := io.CopyBuffer(writer, input, buffer)
	replacementCopyBufferPool.Put(buffer)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := preserveFileMode(file.dst, file.perm); err != nil {
		return err
	}
	tracker.completeFile()
	return nil
}

type replacementProgressWriter struct {
	writer  io.Writer
	tracker *replacementProgressTracker
}

func (w *replacementProgressWriter) Write(data []byte) (int, error) {
	written, err := w.writer.Write(data)
	if written > 0 {
		w.tracker.addBytes(int64(written))
	}
	return written, err
}

func copyReplacementRegularFiles(files []replacementFile, tracker *replacementProgressTracker) error {
	workers := copyWorkerCount(len(files))
	if workers == 0 {
		return nil
	}
	var wg sync.WaitGroup
	var taskMu sync.Mutex
	nextTask := 0
	var firstErr error
	worker := func() {
		defer wg.Done()
		for {
			taskMu.Lock()
			if firstErr != nil || nextTask >= len(files) {
				taskMu.Unlock()
				return
			}
			file := files[nextTask]
			nextTask++
			taskMu.Unlock()

			if err := copyReplacementFile(file, tracker); err != nil {
				taskMu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("copy %s: %w", file.dst, err)
				}
				taskMu.Unlock()
				return
			}
		}
	}
	wg.Add(workers)
	for index := 0; index < workers; index++ {
		go worker()
	}
	wg.Wait()
	return firstErr
}

func executeReplacementCopyPlan(plan replacementCopyPlan, tracker *replacementProgressTracker) error {
	for _, directory := range plan.directories {
		if err := os.MkdirAll(directory.dst, 0o755); err != nil {
			return err
		}
	}
	if err := copyReplacementRegularFiles(plan.files, tracker); err != nil {
		return err
	}
	for _, symlink := range plan.symlinks {
		if err := os.Remove(symlink.dst); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Symlink(symlink.target, symlink.dst); err != nil {
			return err
		}
		tracker.completeFile()
	}
	for index := len(plan.directories) - 1; index >= 0; index-- {
		directory := plan.directories[index]
		if err := preserveFileMode(directory.dst, directory.perm); err != nil {
			return err
		}
	}
	return nil
}

func copyReplacementFiles(
	stagingDir string,
	rootDir string,
	dataDirName string,
	onProgress func(replacementCopyProgress),
) ([]string, error) {
	work, totalFiles, totalBytes, err := buildReplacementWork(stagingDir, rootDir, dataDirName)
	if err != nil {
		return nil, err
	}
	tracker := newReplacementProgressTracker(totalFiles, totalBytes, onProgress)
	stopHeartbeat := tracker.startHeartbeat()
	defer stopHeartbeat()
	if len(work) == 0 {
		tracker.finish()
		return []string{}, nil
	}

	copied := make([]string, 0, len(work))
	for _, item := range work {
		tracker.setCurrentEntry(item.name)
		// Record before installation. A failed parallel copy can leave a partial
		// top-level tree that rollback must remove before restoring the backup.
		copied = append(copied, item.name)
		moved, err := tryFastMoveReplacement(item.src, item.dst)
		if err != nil {
			return copied, err
		}
		if moved {
			tracker.completeMovedEntry(item.plan.totalFiles, item.plan.totalBytes)
			continue
		}
		if runtime.GOOS == "darwin" && strings.HasSuffix(strings.ToLower(item.src), ".app") {
			if err := copyMacAppBundleWithDitto(item.src, item.dst); err != nil {
				return copied, err
			}
			tracker.completeMovedEntry(item.plan.totalFiles, item.plan.totalBytes)
			continue
		}
		if err := executeReplacementCopyPlan(item.plan, tracker); err != nil {
			return copied, err
		}
	}
	tracker.finish()
	return copied, nil
}

func copyMacAppBundleWithDitto(src string, dst string) error {
	output, err := exec.Command("/usr/bin/ditto", src, dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to copy macOS app bundle with ditto: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// validateReplacementRoots re-establishes the filesystem trust boundary just
// before a rollback or backup move.  The initial task validation happens well
// before the destructive phase; checking again here prevents a directory (or
// its backup parent) swapped to a symlink in the meantime from redirecting a
// Rename/RemoveAll outside the installation.
func validateReplacementRoots(backupDir string, rootDir string) error {
	root, err := normalizeAbsoluteTaskPath(rootDir)
	if err != nil {
		return fmt.Errorf("rootDir is invalid: %w", err)
	}
	backup, err := normalizeAbsoluteTaskPath(backupDir)
	if err != nil {
		return fmt.Errorf("backupDir is invalid: %w", err)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("rootDir cannot be inspected: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return errors.New("rootDir must be a real directory")
	}
	backupsRoot := filepath.Join(root, backupDirName)
	if !taskPathsEqual(filepath.Dir(backup), backupsRoot) {
		return errors.New("backupDir must be a direct child of the backup directory")
	}
	if err := validateNoSymlinkComponents(root, backupsRoot, "backup directory"); err != nil {
		return err
	}
	backupInfo, err := os.Lstat(backup)
	if err != nil {
		return fmt.Errorf("backupDir cannot be inspected: %w", err)
	}
	if backupInfo.Mode()&os.ModeSymlink != 0 || !backupInfo.IsDir() {
		return errors.New("backupDir must be a real directory")
	}
	if err := validateNoSymlinkComponents(backupsRoot, backup, "backupDir"); err != nil {
		return err
	}
	return nil
}

func validateRollbackEntryName(name string) error {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name ||
		filepath.IsAbs(name) || filepath.VolumeName(name) != "" || strings.ContainsAny(name, `/\\`) {
		return fmt.Errorf("unsafe rollback entry name: %q", name)
	}
	return nil
}

func moveEntriesBack(backupDir string, rootDir string, entries []string) error {
	if err := validateReplacementRoots(backupDir, rootDir); err != nil {
		return err
	}
	var rollbackErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		if err := validateRollbackEntryName(name); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		src := filepath.Join(backupDir, name)
		dst := filepath.Join(rootDir, name)
		if err := retry(fmt.Sprintf("restore %s", name), rollbackAttempts, moveRetryDelay, func() error {
			if err := validateReplacementRoots(backupDir, rootDir); err != nil {
				return err
			}
			if err := os.RemoveAll(dst); err != nil {
				return err
			}
			return os.Rename(src, dst)
		}); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
		}
	}
	return rollbackErr
}

func removeCopiedEntries(rootDir string, entries []string) error {
	if runtime.GOOS == "darwin" {
		return removeCopiedEntriesMac(rootDir, entries)
	}
	root, err := normalizeAbsoluteTaskPath(rootDir)
	if err != nil {
		return fmt.Errorf("rootDir is invalid: %w", err)
	}
	if info, statErr := os.Lstat(root); statErr != nil {
		return fmt.Errorf("rootDir cannot be inspected: %w", statErr)
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("rootDir must be a real directory")
	}
	var rollbackErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		if err := validateRollbackEntryName(name); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		if err := retry(fmt.Sprintf("remove replacement %s", name), rollbackAttempts, moveRetryDelay, func() error {
			if info, statErr := os.Lstat(root); statErr != nil {
				return statErr
			} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return errors.New("rootDir is no longer a real directory")
			}
			return os.RemoveAll(filepath.Join(root, name))
		}); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
		}
	}
	return rollbackErr
}

// macOS app bundles can contain read-only descendants preserved by ditto. A
// recursive RemoveAll then fails while the old bundle is still parked in the
// backup. Rename the whole top-level replacement into a quarantine directory
// first (only the writable root parent is needed), restore the backup, and
// clean the quarantine best-effort.
func removeCopiedEntriesMac(rootDir string, entries []string) error {
	root, err := normalizeAbsoluteTaskPath(rootDir)
	if err != nil {
		return fmt.Errorf("rootDir is invalid: %w", err)
	}
	if info, statErr := os.Lstat(root); statErr != nil {
		return fmt.Errorf("rootDir cannot be inspected: %w", statErr)
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("rootDir must be a real directory")
	}
	quarantineDir, err := os.MkdirTemp(root, ".uclaw-rollback-")
	if err != nil {
		return fmt.Errorf("create rollback quarantine: %w", err)
	}
	if err := validateNoSymlinkComponents(root, quarantineDir, "rollback quarantine"); err != nil {
		return err
	}
	defer func() { _ = removeStagingDir(quarantineDir) }()
	var rollbackErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		if err := validateRollbackEntryName(name); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		src := filepath.Join(root, name)
		dst := filepath.Join(quarantineDir, name)
		if err := retry(fmt.Sprintf("quarantine replacement %s", name), rollbackAttempts, moveRetryDelay, func() error {
			if info, statErr := os.Lstat(root); statErr != nil {
				return statErr
			} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return errors.New("rootDir is no longer a real directory")
			}
			if _, statErr := os.Lstat(src); os.IsNotExist(statErr) {
				return nil
			} else if statErr != nil {
				return statErr
			}
			return os.Rename(src, dst)
		}); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
		}
	}
	return rollbackErr
}

func rollbackReplacement(backupDir string, rootDir string, copied []string, moved []string) error {
	var rollbackErr error
	if err := removeCopiedEntries(rootDir, copied); err != nil {
		rollbackErr = errors.Join(rollbackErr, err)
	}
	if err := moveEntriesBack(backupDir, rootDir, moved); err != nil {
		rollbackErr = errors.Join(rollbackErr, err)
	}
	return rollbackErr
}

func retry(label string, attempts int, delay time.Duration, fn func() error) error {
	if attempts < 1 {
		return fmt.Errorf("%s failed: retry attempts must be positive", label)
	}
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		err = fn()
		if err == nil {
			return nil
		}
		if attempt < attempts {
			backoff := delay * time.Duration(attempt)
			if backoff > 3*time.Second {
				backoff = 3 * time.Second
			}
			time.Sleep(backoff)
		}
	}
	return fmt.Errorf("%s failed after %d attempts: %w", label, attempts, err)
}

func findLaunchPath(rootDir string) string {
	if runtime.GOOS == "windows" {
		candidates := []string{
			filepath.Join(rootDir, "UClaw.exe"),
			filepath.Join(rootDir, "ClawX.exe"),
		}
		for _, candidate := range candidates {
			if existsFile(candidate) {
				return candidate
			}
		}
		return ""
	}
	if runtime.GOOS == "darwin" {
		// The macOS portable contract has one canonical bundle. Never glob
		// sibling `.app` directories: a malformed archive or stale installation
		// could then launch an unrelated app and falsely satisfy startup
		// verification.
		for _, executable := range []string{"UClaw", "ClawX"} {
			match := filepath.Join(rootDir, "UClaw.app", "Contents", "MacOS", executable)
			if existsFile(match) {
				return match
			}
		}
		return ""
	}
	// Keep the historical non-macOS fallback for platforms that use a generic
	// app bundle layout; macOS is intentionally handled by the strict branch.
	matches, _ := filepath.Glob(filepath.Join(rootDir, "*.app", "Contents", "MacOS", "*"))
	for _, match := range matches {
		if existsFile(match) {
			return match
		}
	}
	return ""
}

func existsFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink == 0 && info.Mode().IsRegular()
}

func chmodExecutable(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("updated app executable is not a regular file: %s", path)
	}
	// macOS app bundles (especially apps launched directly from a DMG) may be
	// mounted read-only. `ditto` and the ZIP already carry the executable bit,
	// so never mutate the bundle at runtime; only validate that it is runnable.
	if runtime.GOOS == "darwin" {
		if info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("updated app executable is not executable: %s", path)
		}
		return nil
	}
	if info.Mode().Perm()&0o111 != 0 {
		return nil
	}
	return preserveFileMode(path, info.Mode().Perm()|0o755)
}

// Removable macOS volumes can expose fixed permissions and reject chmod even
// when the copied file already has every requested permission. Preserve that
// usable mode instead of needlessly rolling back a valid USB update.
func preserveFileMode(path string, expected os.FileMode) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	if info, statErr := os.Lstat(path); statErr != nil {
		return statErr
	} else if info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
		return fmt.Errorf("cannot preserve mode on an unsupported entry: %s", path)
	}
	chmodErr := os.Chmod(path, expected)
	if chmodErr == nil {
		return nil
	}
	info, statErr := os.Lstat(path)
	if statErr == nil && info.Mode().Perm()&expected.Perm() == expected.Perm() {
		return nil
	}
	return chmodErr
}

func prepareReadyMarker(readyPath string) error {
	if readyPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(readyPath), 0o700); err != nil {
		return err
	}
	if err := os.Remove(readyPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

type startupReadyMarker struct {
	Version string `json:"version"`
	PID     int    `json:"pid"`
	ReadyAt string `json:"readyAt"`
}

func waitForUpdatedAppReady(readyPath string, targetVersion string, cmd *exec.Cmd, timeout time.Duration) error {
	if readyPath == "" {
		return errors.New("updated app startup verification path is missing")
	}
	if cmd == nil || cmd.Process == nil {
		return errors.New("updated app did not provide a process handle")
	}

	exitCh := make(chan error, 1)
	go func() {
		exitCh <- cmd.Wait()
	}()

	deadline := time.Now().Add(timeout)
	for {
		if raw, err := os.ReadFile(readyPath); err == nil {
			var marker startupReadyMarker
			if err := json.Unmarshal(raw, &marker); err != nil {
				return fmt.Errorf("updated app wrote an invalid startup marker: %w", err)
			}
			if !sameReleaseVersion(marker.Version, targetVersion) {
				return fmt.Errorf("updated app reported version %q, expected %q", marker.Version, targetVersion)
			}
			if marker.PID != cmd.Process.Pid {
				return fmt.Errorf("updated app startup marker PID %d does not match launched PID %d", marker.PID, cmd.Process.Pid)
			}
			if marker.ReadyAt == "" {
				return errors.New("updated app wrote an incomplete startup marker")
			}
			select {
			case exitErr := <-exitCh:
				if exitErr != nil {
					return fmt.Errorf("updated app exited immediately after it became ready: %w", exitErr)
				}
				return errors.New("updated app exited immediately after it became ready")
			case <-time.After(startupReadyGrace):
				return nil
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("failed to read updated app startup marker: %w", err)
		}

		select {
		case exitErr := <-exitCh:
			if exitErr != nil {
				return fmt.Errorf("updated app exited before it became ready: %w", exitErr)
			}
			return errors.New("updated app exited before it became ready")
		default:
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("updated app did not become ready within %s", timeout)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// Release metadata may use a git tag form (v1.0.5) while Electron reports the
// package form (1.0.5). Build metadata has no SemVer precedence either, so it
// must not cause a healthy newly launched app to be rolled back.
func sameReleaseVersion(left string, right string) bool {
	normalize := func(value string) string {
		value = strings.TrimSpace(value)
		if len(value) > 1 && (value[0] == 'v' || value[0] == 'V') {
			value = value[1:]
		}
		if plus := strings.IndexByte(value, '+'); plus >= 0 {
			value = value[:plus]
		}
		return value
	}
	return normalize(left) == normalize(right)
}

func stopUpdatedApp(cmd *exec.Cmd, logf func(string, ...any)) error {
	if cmd == nil || cmd.Process == nil {
		return errors.New("updated app process handle is unavailable")
	}
	pid := cmd.Process.Pid
	if err := stopUpdatedAppProcessTree(pid, 15*time.Second, logf); err != nil {
		return fmt.Errorf("updated app process %d did not exit after startup failure: %w", pid, err)
	}
	return nil
}

func (u *updater) restartPreviousApp() (string, error) {
	launchPath := u.task.LaunchPath
	if !existsFile(launchPath) {
		launchPath = findLaunchPath(u.task.RootDir)
		if launchPath == "" {
			return "", errors.New("previous UClaw launch path was not found")
		}
	}
	if err := chmodExecutable(launchPath); err != nil {
		return "", err
	}
	if _, err := startUpdatedApp(launchPath, u.task.RootDir, ""); err != nil {
		return "", err
	}
	return launchPath, nil
}

func defaultStartUpdatedApp(launchPath string, rootDir string, readyPath string) (*exec.Cmd, error) {
	cmd := exec.Command(launchPath)
	cmd.Dir = rootDir
	configureUpdatedAppProcessGroup(cmd)
	if readyPath != "" {
		cmd.Env = append(os.Environ(), "UCLAW_PORTABLE_UPDATE_READY_PATH="+readyPath)
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

func cleanupOldBackups(backupsRoot string, keep string, maxAge time.Duration, logf func(string, ...any)) {
	backupsRoot, err := validateBackupCleanupRoot(backupsRoot)
	if err != nil {
		if logf != nil {
			logf("refusing to clean old backups: %v", err)
		}
		return
	}
	keepPath := ""
	if strings.TrimSpace(keep) != "" {
		keepPath, err = normalizeAbsoluteTaskPath(keep)
		if err != nil || !taskPathsEqual(filepath.Dir(keepPath), backupsRoot) {
			if logf != nil {
				logf("refusing to clean old backups: keep path is outside backup directory")
			}
			return
		}
		if info, statErr := os.Lstat(keepPath); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				if logf != nil {
					logf("refusing to clean old backups: keep path is not a real directory")
				}
				return
			}
		} else if !os.IsNotExist(statErr) {
			if logf != nil {
				logf("refusing to clean old backups: keep path cannot be inspected: %v", statErr)
			}
			return
		}
	}
	entries, err := os.ReadDir(backupsRoot)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(backupsRoot, entry.Name())
		if err := validateRollbackEntryName(entry.Name()); err != nil {
			if logf != nil {
				logf("refusing to clean backup entry %q: %v", entry.Name(), err)
			}
			continue
		}
		if taskPathsEqual(path, keepPath) {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.ModTime().After(cutoff) {
			continue
		}
		// Re-check the parent immediately before the destructive operation. If
		// it was replaced with a link, leave every backup untouched.
		if _, rootErr := validateBackupCleanupRoot(backupsRoot); rootErr != nil {
			if logf != nil {
				logf("stopped cleaning old backups after root changed: %v", rootErr)
			}
			return
		}
		if current, currentErr := os.Lstat(path); currentErr != nil || current.Mode()&os.ModeSymlink != 0 || !current.IsDir() {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			if logf != nil {
				logf("failed to remove old backup %s: %v", path, err)
			}
		}
	}
}

// validateBackupCleanupRoot verifies that a cleanup operation is still bound
// to a real installation root.  Cleanup runs after a successful update and is
// best-effort; on any ambiguity it must leave old backups in place rather than
// risk recursively deleting a directory selected through a symlink.
func validateBackupCleanupRoot(backupsRoot string) (string, error) {
	normalized, err := normalizeAbsoluteTaskPath(backupsRoot)
	if err != nil {
		return "", err
	}
	if !taskPathNamesEqual(filepath.Base(normalized), backupDirName) {
		return "", errors.New("backup directory has an unexpected name")
	}
	root := filepath.Dir(normalized)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return "", errors.New("backup directory parent must be a real directory")
	}
	if err := validateNoSymlinkComponents(root, normalized, "backup directory"); err != nil {
		return "", err
	}
	info, err := os.Lstat(normalized)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("backup directory must be a real directory")
	}
	return normalized, nil
}
