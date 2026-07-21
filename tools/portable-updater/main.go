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
	"time"
)

const (
	defaultDataDirName = "UClawData"
	backupDirName      = ".uclaw-update-backups"
	resultSuffix       = ".result.json"
	startupAckTimeout  = 90 * time.Second
)

var startUpdatedApp = defaultStartUpdatedApp
var stopUpdatedApp = defaultStopUpdatedApp
var awaitUpdatedAppStartup = waitForStartupAck

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
	AckPath       string `json:"ackPath"`
	PendingPath   string `json:"pendingPath"`
}

type pendingStartup struct {
	Version       int    `json:"version"`
	TargetVersion string `json:"targetVersion"`
	RootDir       string `json:"rootDir"`
	AckPath       string `json:"ackPath"`
}

type startupAck struct {
	Version       int    `json:"version"`
	Ready         bool   `json:"ready"`
	TargetVersion string `json:"targetVersion"`
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

type updater struct {
	task     updateTask
	taskPath string
	logFile  *os.File
	progress *progressReporter
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
	if task.ParentPID > 0 {
		progress.Update(progressState{
			Title:   "正在关闭旧版本",
			Detail:  "等待 UClaw 完全退出，随后开始替换文件。",
			Percent: 5,
		})
		waitForParentExit(task.ParentPID, 45*time.Second, func(format string, args ...any) {
			u.logf(format, args...)
		})
	} else {
		time.Sleep(2 * time.Second)
	}

	result := updateResult{TargetVersion: task.TargetVersion}
	backupDir, stagingDir, launchedPath, err := u.apply()
	result.BackupDir = backupDir
	result.StagingDir = stagingDir
	result.LaunchedPath = launchedPath
	if err != nil {
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
	task.Sha512 = strings.ToLower(strings.TrimSpace(task.Sha512))
	if task.DataDirName == "" {
		task.DataDirName = defaultDataDirName
	}
	if task.ZipPath == "" || task.RootDir == "" || task.LaunchPath == "" || task.AckPath == "" || task.PendingPath == "" {
		return errors.New("zipPath, rootDir, launchPath, ackPath and pendingPath are required")
	}
	if !filepath.IsAbs(task.ZipPath) || !filepath.IsAbs(task.RootDir) || !filepath.IsAbs(task.LaunchPath) || !filepath.IsAbs(task.AckPath) || !filepath.IsAbs(task.PendingPath) {
		return errors.New("zipPath, rootDir, launchPath, ackPath and pendingPath must be absolute")
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

	backupDir = filepath.Join(u.task.RootDir, backupDirName, time.Now().UTC().Format("20060102-150405"))
	u.logf("backing up current app files to %s", backupDir)
	u.progress.Update(progressState{
		Title:   "正在备份旧版本",
		Detail:  "正在保存可回滚的旧文件。",
		Percent: 64,
	})
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		_ = os.RemoveAll(stagingDir)
		return backupDir, stagingDir, "", err
	}

	replacementEntries, err := replacementEntrySet(stagingDir, u.task.DataDirName)
	if err != nil {
		_ = os.RemoveAll(stagingDir)
		return backupDir, stagingDir, "", err
	}

	moved, err := u.moveCurrentFilesToBackup(backupDir, replacementEntries)
	if err != nil {
		u.logf("backup failed; rolling back moved entries")
		_ = moveEntriesBack(backupDir, u.task.RootDir, moved)
		_ = os.RemoveAll(stagingDir)
		return backupDir, stagingDir, "", err
	}

	copied, err := copyReplacementFiles(stagingDir, u.task.RootDir, u.task.DataDirName, func(percent int, detail string) {
		u.progress.Update(progressState{
			Title:   "正在安装新版文件",
			Detail:  detail,
			Percent: clampProgressPercent(percent, 70, 92),
		})
	})
	if err != nil {
		u.logf("copy failed; rolling back replacement")
		_ = removeCopiedEntries(u.task.RootDir, copied)
		_ = moveEntriesBack(backupDir, u.task.RootDir, moved)
		_ = os.RemoveAll(stagingDir)
		return backupDir, stagingDir, "", err
	}

	launchPath := u.task.LaunchPath
	if _, err := os.Stat(launchPath); err != nil {
		u.logf("declared launch path unavailable after update: %v", err)
		launchPath = findLaunchPath(u.task.RootDir)
		if launchPath == "" {
			return backupDir, stagingDir, "", errors.New("updated app launch path was not found")
		}
	}
	_ = chmodExecutable(launchPath)
	if err := u.prepareStartupAcknowledgement(); err != nil {
		return backupDir, stagingDir, "", u.rollbackAfterStartupFailure(backupDir, launchPath, 0, moved, copied, err)
	}

	u.progress.Update(progressState{
		Title:   "正在启动新版 UClaw",
		Detail:  "更新即将完成。",
		Percent: 96,
	})
	launchedPID, err := startUpdatedApp(launchPath, u.task.RootDir)
	if err != nil {
		return backupDir, stagingDir, "", u.rollbackAfterStartupFailure(backupDir, launchPath, 0, moved, copied, err)
	}
	if err := awaitUpdatedAppStartup(u.task.AckPath, u.task.TargetVersion, startupAckTimeout); err != nil {
		return backupDir, stagingDir, "", u.rollbackAfterStartupFailure(backupDir, launchPath, launchedPID, moved, copied, err)
	}

	_ = os.Remove(u.task.AckPath)
	_ = os.Remove(u.task.PendingPath)
	_ = os.RemoveAll(stagingDir)
	cleanupOldBackups(filepath.Join(u.task.RootDir, backupDirName), backupDir, 7*24*time.Hour, u.logf)
	return backupDir, stagingDir, launchPath, nil
}

func (u *updater) prepareStartupAcknowledgement() error {
	if err := os.MkdirAll(filepath.Dir(u.task.AckPath), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(u.task.PendingPath), 0o755); err != nil {
		return err
	}
	_ = os.Remove(u.task.AckPath)

	pending := pendingStartup{
		Version:       1,
		TargetVersion: u.task.TargetVersion,
		RootDir:       u.task.RootDir,
		AckPath:       u.task.AckPath,
	}
	raw, err := json.MarshalIndent(pending, "", "  ")
	if err != nil {
		return err
	}
	temporaryPath := u.task.PendingPath + ".tmp"
	if err := os.WriteFile(temporaryPath, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, u.task.PendingPath); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	return nil
}

func waitForStartupAck(path string, targetVersion string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(path)
		if err == nil {
			var ack startupAck
			if err := json.Unmarshal(raw, &ack); err != nil {
				return fmt.Errorf("invalid portable startup acknowledgement: %w", err)
			}
			if ack.Version != 1 || !ack.Ready || ack.TargetVersion != targetVersion {
				return errors.New("portable startup acknowledgement does not match the target version")
			}
			return nil
		}
		if !os.IsNotExist(err) {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("updated UClaw did not acknowledge startup within %s", timeout)
}

func (u *updater) rollbackAfterStartupFailure(
	backupDir string,
	launchPath string,
	launchedPID int,
	moved []string,
	copied []string,
	cause error,
) error {
	u.logf("updated app startup failed; restoring previous portable version: %v", cause)
	if err := stopUpdatedApp(launchPath, u.task.RootDir, launchedPID); err != nil {
		u.logf("failed to stop the updated app before rollback: %v", err)
	}
	_ = os.Remove(u.task.AckPath)
	_ = os.Remove(u.task.PendingPath)

	rollbackErr := rollbackReplacement(backupDir, u.task.RootDir, moved, copied)
	if rollbackErr != nil {
		return combineErrors(cause, fmt.Errorf("portable rollback failed; backup remains at %s: %w", backupDir, rollbackErr))
	}

	restoredLaunchPath := u.task.LaunchPath
	if !existsFile(restoredLaunchPath) {
		restoredLaunchPath = findLaunchPath(u.task.RootDir)
	}
	if restoredLaunchPath == "" {
		return combineErrors(cause, errors.New("portable rollback succeeded but the previous launch path was not found"))
	}
	if _, err := startUpdatedApp(restoredLaunchPath, u.task.RootDir); err != nil {
		return combineErrors(cause, fmt.Errorf("portable rollback succeeded but the previous version could not restart: %w", err))
	}
	return cause
}

func rollbackReplacement(backupDir string, rootDir string, moved []string, copied []string) error {
	removeErr := removeCopiedEntries(rootDir, copied)
	restoreErr := moveEntriesBack(backupDir, rootDir, moved)
	return combineErrors(removeErr, restoreErr)
}

func combineErrors(primary error, secondary error) error {
	if primary == nil {
		return secondary
	}
	if secondary == nil {
		return primary
	}
	return fmt.Errorf("%v; %w", primary, secondary)
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
		name := strings.ReplaceAll(file.Name, "\\", "/")
		if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "../") || strings.HasPrefix(name, "../") {
			return fmt.Errorf("unsafe zip entry path: %s", file.Name)
		}
		target := filepath.Join(destClean, filepath.FromSlash(name))
		targetClean, err := filepath.Abs(target)
		if err != nil {
			return err
		}
		if targetClean != destClean && !strings.HasPrefix(targetClean, destClean+string(os.PathSeparator)) {
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
	normalized := strings.ReplaceAll(linkTarget, "\\", "/")
	parts := strings.Split(normalized, "/")
	for _, part := range parts {
		if part == ".." {
			return fmt.Errorf("unsafe symlink target in zip entry %s", file.Name)
		}
	}
	if linkTarget == "" || filepath.IsAbs(linkTarget) {
		return fmt.Errorf("unsafe symlink target in zip entry %s", file.Name)
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
		if err := retry(fmt.Sprintf("move %s", name), 18, 500*time.Millisecond, func() error {
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

func copyReplacementFiles(stagingDir string, rootDir string, dataDirName string, onProgress func(percent int, detail string)) ([]string, error) {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return nil, err
	}
	copied := make([]string, 0, len(entries))
	replacementEntries := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldSkipRootEntry(name, dataDirName) {
			continue
		}
		replacementEntries = append(replacementEntries, entry)
	}
	total := len(replacementEntries)
	if total == 0 && onProgress != nil {
		onProgress(100, "没有需要替换的文件。")
	}
	for index, entry := range replacementEntries {
		name := entry.Name()
		src := filepath.Join(stagingDir, name)
		dst := filepath.Join(rootDir, name)
		if onProgress != nil {
			onProgress(index*100/total, fmt.Sprintf("正在替换 %d/%d: %s", index+1, total, name))
		}
		if err := copyPath(src, dst); err != nil {
			return copied, err
		}
		copied = append(copied, name)
	}
	if onProgress != nil {
		onProgress(100, "新版文件已安装。")
	}
	return copied, nil
}

func copyPath(src string, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		_ = os.Remove(dst)
		return os.Symlink(target, dst)
	}
	if info.IsDir() {
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPath(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
				return err
			}
		}
		return os.Chmod(dst, info.Mode().Perm())
	}
	return copyFile(src, dst, info.Mode().Perm())
}

func copyFile(src string, dst string, perm os.FileMode) error {
	input, err := os.Open(src)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chmod(dst, perm)
}

func moveEntriesBack(backupDir string, rootDir string, entries []string) error {
	var firstErr error
	for i := len(entries) - 1; i >= 0; i-- {
		name := entries[i]
		src := filepath.Join(backupDir, name)
		dst := filepath.Join(rootDir, name)
		_ = os.RemoveAll(dst)
		if err := retry(fmt.Sprintf("restore %s", name), 18, 500*time.Millisecond, func() error {
			return os.Rename(src, dst)
		}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func removeCopiedEntries(rootDir string, entries []string) error {
	var firstErr error
	for i := len(entries) - 1; i >= 0; i-- {
		if err := os.RemoveAll(filepath.Join(rootDir, entries[i])); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func retry(label string, attempts int, delay time.Duration, fn func() error) error {
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		err = fn()
		if err == nil {
			return nil
		}
		time.Sleep(delay * time.Duration(attempt))
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
	return os.Chmod(path, info.Mode().Perm()|0o755)
}

func defaultStartUpdatedApp(launchPath string, rootDir string) (int, error) {
	if runtime.GOOS == "darwin" {
		if appBundle := findAppBundleFromLaunchPath(launchPath); appBundle != "" {
			cmd := exec.Command("/usr/bin/open", "-n", appBundle)
			cmd.Dir = rootDir
			if err := cmd.Start(); err != nil {
				return 0, err
			}
			return cmd.Process.Pid, nil
		}
	}
	cmd := exec.Command(launchPath)
	cmd.Dir = rootDir
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

func defaultStopUpdatedApp(launchPath string, rootDir string, launchedPID int) error {
	command, args, err := stopUpdatedAppCommand(runtime.GOOS, launchPath, launchedPID)
	if err != nil {
		return err
	}
	return exec.Command(command, args...).Run()
}

// Build the stop command separately so Windows PID targeting is testable cross-platform.
func stopUpdatedAppCommand(goos string, launchPath string, launchedPID int) (string, []string, error) {
	if goos == "windows" {
		if launchedPID <= 0 {
			return "", nil, errors.New("updated app pid is unavailable")
		}
		return "taskkill", []string{"/F", "/T", "/PID", fmt.Sprintf("%d", launchedPID)}, nil
	}
	if goos == "darwin" {
		match := findAppBundleFromLaunchPath(launchPath)
		if match == "" {
			match = launchPath
		}
		return "/usr/bin/pkill", []string{"-f", match}, nil
	}
	return "pkill", []string{"-f", launchPath}, nil
}

func findAppBundleFromLaunchPath(launchPath string) string {
	parts := strings.Split(filepath.Clean(launchPath), string(os.PathSeparator))
	for index := len(parts) - 1; index >= 0; index-- {
		if strings.HasSuffix(parts[index], ".app") {
			return string(os.PathSeparator) + filepath.Join(parts[:index+1]...)
		}
	}
	return ""
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
