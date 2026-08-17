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
	task     updateTask
	taskPath string
	logFile  *os.File
	progress *progressReporter
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
	task, err := readTask(taskPath)
	progress := newProgressReporter()
	defer progress.Close()

	u := &updater{task: task, taskPath: taskPath, progress: progress}
	if task.LogPath != "" {
		if logFile, openErr := openLog(task.LogPath); openErr == nil {
			u.logFile = logFile
			defer logFile.Close()
		}
	}

	if err != nil {
		u.logf("failed to read task: %v", err)
		progress.Fail("更新失败", err.Error())
		u.writeResult(updateResult{Success: false, Error: err.Error()})
		return 1
	}
	if err := validateTask(&task); err != nil {
		u.logf("invalid task: %v", err)
		progress.Fail("更新失败", err.Error())
		u.writeResult(updateResult{Success: false, Error: err.Error(), TargetVersion: task.TargetVersion})
		return 1
	}
	u.task = task

	u.logf("portable update started: version=%s root=%s zip=%s", task.TargetVersion, task.RootDir, task.ZipPath)
	progress.Update(progressState{
		Title:   "正在准备更新",
		Detail:  "请不要关闭此窗口，更新完成后会自动重启 UClaw。",
		Percent: 2,
	})
	result := updateResult{TargetVersion: task.TargetVersion}
	if task.ParentPID > 0 {
		progress.Update(progressState{
			Title:   "正在关闭旧版本",
			Detail:  "等待 UClaw 完全退出，随后开始替换文件。",
			Percent: 5,
		})
		if err := waitForParentExit(task.ParentPID, 45*time.Second, func(format string, args ...any) {
			u.logf(format, args...)
		}); err != nil {
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

func validateTask(task *updateTask) error {
	task.ZipPath = strings.TrimSpace(task.ZipPath)
	task.RootDir = strings.TrimSpace(task.RootDir)
	task.DataDirName = strings.TrimSpace(task.DataDirName)
	task.LaunchPath = strings.TrimSpace(task.LaunchPath)
	task.TargetVersion = strings.TrimSpace(task.TargetVersion)
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
	if task.DataDirName == "." || task.DataDirName == ".." || strings.ContainsAny(task.DataDirName, `/\`) {
		return errors.New("dataDirName must be a single directory name")
	}
	if task.Size <= 0 {
		return errors.New("size must be positive")
	}
	if task.Sha512 == "" {
		return errors.New("sha512 is required")
	}
	if _, err := os.Stat(task.ZipPath); err != nil {
		return fmt.Errorf("zip does not exist: %w", err)
	}
	if info, err := os.Stat(task.RootDir); err != nil || !info.IsDir() {
		if err != nil {
			return fmt.Errorf("rootDir is not available: %w", err)
		}
		return errors.New("rootDir is not a directory")
	}
	if _, err := os.Stat(filepath.Join(task.RootDir, "portable.flag")); err != nil {
		return errors.New("rootDir is missing portable.flag")
	}
	if rel, err := filepath.Rel(task.RootDir, task.LaunchPath); err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return errors.New("launchPath must be inside rootDir")
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
	result.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		u.logf("failed to marshal result: %v", err)
		return
	}
	if err := os.WriteFile(u.taskPath+resultSuffix, append(raw, '\n'), 0o600); err != nil {
		u.logf("failed to write result: %v", err)
	}
}

func (u *updater) apply() (backupDir string, stagingDir string, launchedPath string, err error) {
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
		_ = os.RemoveAll(stagingDir)
		return "", stagingDir, "", err
	}
	u.progress.Update(progressState{
		Title:   "正在检查新版文件",
		Detail:  "正在确认更新包内容。",
		Percent: 60,
	})
	if err := u.validateStaging(stagingDir); err != nil {
		_ = os.RemoveAll(stagingDir)
		return "", stagingDir, "", err
	}

	backupDir, err = u.createBackupDir()
	if err != nil {
		_ = os.RemoveAll(stagingDir)
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
		_ = os.RemoveAll(stagingDir)
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
	if _, err := os.Stat(launchPath); err != nil {
		u.logf("declared launch path unavailable after update: %v", err)
		launchPath = findLaunchPath(u.task.RootDir)
		if launchPath == "" {
			return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, errors.New("updated app launch path was not found"))
		}
	}
	if err := chmodExecutable(launchPath); err != nil {
		return u.rollbackAfterFailure(backupDir, stagingDir, copied, moved, fmt.Errorf("failed to make updated app executable: %w", err))
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

	if err := os.RemoveAll(stagingDir); err != nil {
		u.logf("failed to remove staging directory after successful update: %v", err)
	}
	cleanupOldBackups(filepath.Join(u.task.RootDir, backupDirName), backupDir, 7*24*time.Hour, u.logf)
	return backupDir, stagingDir, launchPath, nil
}

// createBackupDir must not reuse a previous attempt's second-level timestamp.
// Users can retry immediately after a failed update, and sharing a backup
// directory would make a later rollback ambiguous.
func (u *updater) createBackupDir() (string, error) {
	backupsRoot := filepath.Join(u.task.RootDir, backupDirName)
	if err := os.MkdirAll(backupsRoot, 0o755); err != nil {
		return "", err
	}
	return os.MkdirTemp(backupsRoot, time.Now().UTC().Format("20060102-150405")+"-")
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
	if err := os.RemoveAll(stagingDir); err != nil {
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

func (u *updater) prepareStagingDir() (string, error) {
	if u.task.StagingDir != "" {
		if err := os.RemoveAll(u.task.StagingDir); err != nil {
			return "", err
		}
		if err := os.MkdirAll(u.task.StagingDir, 0o755); err != nil {
			return "", err
		}
		return u.task.StagingDir, nil
	}
	base := filepath.Dir(u.task.ZipPath)
	return os.MkdirTemp(base, "uclaw-update-staging-")
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
	if _, err := os.Stat(filepath.Join(stagingDir, "portable.flag")); err != nil {
		return errors.New("update package is missing portable.flag")
	}
	relLaunch, err := filepath.Rel(u.task.RootDir, u.task.LaunchPath)
	if err == nil && relLaunch != "." && !strings.HasPrefix(relLaunch, "..") && !filepath.IsAbs(relLaunch) {
		if _, err := os.Stat(filepath.Join(stagingDir, relLaunch)); err == nil {
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
		replacements[name] = struct{}{}
	}
	return replacements, nil
}

func (u *updater) moveCurrentFilesToBackup(backupDir string, replacementEntries map[string]struct{}) ([]string, error) {
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
		if _, shouldReplace := replacementEntries[name]; !shouldReplace {
			u.logf("leaving root entry unchanged because it is not in the update package: %s", name)
			continue
		}
		src := filepath.Join(u.task.RootDir, name)
		dst := filepath.Join(backupDir, name)
		if err := retry(fmt.Sprintf("move %s", name), moveRetryAttempts, moveRetryDelay, func() error {
			return os.Rename(src, dst)
		}); err != nil {
			return moved, err
		}
		moved = append(moved, name)
	}
	return moved, nil
}

func shouldSkipRootEntry(name string, dataDirName string) bool {
	return name == dataDirName || name == backupDirName
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

func moveEntriesBack(backupDir string, rootDir string, entries []string) error {
	var rollbackErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		src := filepath.Join(backupDir, name)
		dst := filepath.Join(rootDir, name)
		if err := retry(fmt.Sprintf("restore %s", name), rollbackAttempts, moveRetryDelay, func() error {
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
	var rollbackErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		if err := retry(fmt.Sprintf("remove replacement %s", name), rollbackAttempts, moveRetryDelay, func() error {
			return os.RemoveAll(filepath.Join(rootDir, name))
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
	matches, _ := filepath.Glob(filepath.Join(rootDir, "*.app", "Contents", "MacOS", "*"))
	for _, match := range matches {
		if existsFile(match) {
			return match
		}
	}
	return ""
}

func existsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func chmodExecutable(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
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
	chmodErr := os.Chmod(path, expected)
	if chmodErr == nil {
		return nil
	}
	info, statErr := os.Stat(path)
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
		if path == keep {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			logf("failed to remove old backup %s: %v", path, err)
		}
	}
}
