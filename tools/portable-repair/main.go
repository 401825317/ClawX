// UClawRepair is a dependency-free Windows helper for diagnosing and safely
// recovering a portable UClaw installation when the main app does not open.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	runtimeDirName              = "UClawRuntime"
	updateTaskPrefix            = "portable-update-"
	updateTaskSuffix            = ".json"
	logFilePrefix               = "clawx-"
	maxReadBytes                = 512 * 1024
	maxLogFiles                 = 12
	maxLogTailBytes             = 256 * 1024
	repairReportFileName        = "UClawRepair-report.json"
	startupProbeWait            = 8 * time.Second
	startupProbeInterval        = 250 * time.Millisecond
	taskkillAlreadyGoneExitCode = 128
)

type updateTask struct {
	RootDir       string `json:"rootDir"`
	LaunchPath    string `json:"launchPath"`
	TargetVersion string `json:"targetVersion"`
	ZipPath       string `json:"zipPath"`
	LogPath       string `json:"logPath"`
	StagingDir    string `json:"stagingDir"`
	ReadyPath     string `json:"readyPath"`
}

type finding struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type logEvidence struct {
	File    string   `json:"file"`
	Signals []string `json:"signals"`
}

type processInfo struct {
	Name       string `json:"Name"`
	PID        int    `json:"ProcessId"`
	ParentPID  int    `json:"ParentProcessId"`
	Executable string `json:"ExecutablePath"`
	Command    string `json:"CommandLine"`
}

type report struct {
	SchemaVersion    int           `json:"schemaVersion"`
	CapturedAt       string        `json:"capturedAt"`
	Platform         string        `json:"platform"`
	Architecture     string        `json:"architecture"`
	RuntimeDir       string        `json:"runtimeDir"`
	CandidateRoots   []string      `json:"candidateRoots,omitempty"`
	SelectedRoot     string        `json:"selectedRoot,omitempty"`
	AppPath          string        `json:"appPath,omitempty"`
	AppVersion       string        `json:"appVersion,omitempty"`
	Portable         bool          `json:"portable"`
	Processes        []string      `json:"processes,omitempty"`
	Ports            []int         `json:"ports,omitempty"`
	UpdateTasks      []string      `json:"updateTasks,omitempty"`
	UpdateLogs       []string      `json:"updateLogs,omitempty"`
	AppLogs          []string      `json:"appLogs,omitempty"`
	LogEvidence      []logEvidence `json:"logEvidence,omitempty"`
	Findings         []finding     `json:"findings,omitempty"`
	Actions          []string      `json:"actions,omitempty"`
	Errors           []string      `json:"errors,omitempty"`
	RestartAttempted bool          `json:"restartAttempted"`
	Restarted        bool          `json:"restarted"`

	processTargets []processInfo
}

var (
	rootPattern          = regexp.MustCompile(`(?im)\broot(?:Dir)?["']?\s*[:=]\s*["']?([A-Za-z]:[\\/][^\r\n"']+)`)
	logFieldPattern      = regexp.MustCompile(`(?i)\s+(?:zip|zipPath|launchPath|targetVersion|sha512|size|stagingDir|readyPath|logPath|parentPid|dataDirName)\s*[:=]`)
	bearerPattern        = regexp.MustCompile(`(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]+`)
	secretPattern        = regexp.MustCompile(`(?i)((?:"|')?(?:api[_-]?key|access[_-]?key|[a-z0-9_-]*token|password|passwd|secret|authorization|cookie|credential|private[_-]?key|client[_-]?secret|signature)(?:"|')?\s*(?::|=|\s)\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)`)
	urlCredentialPattern = regexp.MustCompile(`(?i)(\bhttps?://)[^/@\s]+@`)
)

func main() {
	if runtime.GOOS != "windows" {
		writeConsole("UClawRepair is intended for Windows portable installations.")
		os.Exit(2)
	}

	args := os.Args[1:]
	doRepair := shouldRepair(args, confirmSafeRepair)
	reportPath := argValue(args, "--report")
	if reportPath == "" {
		reportPath = filepath.Join(os.TempDir(), repairReportFileName)
	}

	rep := collectReport()
	if doRepair {
		applySafeRepairs(&rep)
	}
	if err := writeReport(reportPath, rep); err != nil {
		rep.Errors = append(rep.Errors, "failed to write report: "+err.Error())
	}

	result := summary(rep, doRepair, reportPath)
	writeConsole(result)
	showFinalMessage("UClaw 修复小助手", result)
}

func collectReport() report {
	r := report{
		SchemaVersion: 1,
		CapturedAt:    time.Now().UTC().Format(time.RFC3339),
		Platform:      runtime.GOOS,
		Architecture:  runtime.GOARCH,
		RuntimeDir:    resolveRuntimeDir(),
		Ports:         []int{18789, 62872},
	}

	if executable, err := os.Executable(); err == nil {
		if root := findRootNear(filepath.Dir(executable)); root != "" {
			r.CandidateRoots = appendUnique(r.CandidateRoots, root)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		if root := findRootNear(cwd); root != "" {
			r.CandidateRoots = appendUnique(r.CandidateRoots, root)
		}
	}

	tasksDir := filepath.Join(r.RuntimeDir, "updates", "tasks")
	r.UpdateTasks = collectFiles(tasksDir, func(name string) bool {
		return strings.HasPrefix(name, updateTaskPrefix) && strings.HasSuffix(name, updateTaskSuffix)
	}, maxLogFiles)

	for _, taskPath := range r.UpdateTasks {
		task, err := readTask(taskPath)
		if err != nil {
			appendFindingUnique(&r.Findings, finding{"invalid-update-task", "warning", "发现无法读取的更新任务文件"})
			continue
		}
		if root := cleanRoot(task.RootDir); root != "" {
			r.CandidateRoots = appendUnique(r.CandidateRoots, root)
		}
		if pathWithin(task.LogPath, r.RuntimeDir) {
			if root := inferRootFromFile(task.LogPath); root != "" {
				r.CandidateRoots = appendUnique(r.CandidateRoots, root)
			}
		}
		if task.StagingDir != "" && pathWithin(task.StagingDir, r.RuntimeDir) && pathExists(task.StagingDir) {
			appendFindingUnique(&r.Findings, finding{"update-staging-residue", "warning", "发现未清理的更新临时目录"})
		}
	}

	r.UpdateLogs = collectFiles(filepath.Join(r.RuntimeDir, "logs"), func(name string) bool {
		return strings.HasPrefix(name, "portable-updater-") && strings.HasSuffix(name, ".log")
	}, maxLogFiles)
	r.AppLogs = collectFiles(filepath.Join(r.RuntimeDir, "logs"), func(name string) bool {
		return strings.HasPrefix(name, logFilePrefix) && strings.HasSuffix(name, ".log")
	}, maxLogFiles)

	for _, root := range inferRootsFromLogs(append(append([]string{}, r.UpdateLogs...), r.AppLogs...)) {
		r.CandidateRoots = appendUnique(r.CandidateRoots, root)
	}
	r.SelectedRoot = selectRoot(r.CandidateRoots)
	sort.Strings(r.CandidateRoots)
	if r.SelectedRoot != "" {
		r.Portable = pathExists(filepath.Join(r.SelectedRoot, "portable.flag"))
		r.AppPath = findAppPath(r.SelectedRoot)
		r.AppVersion = readAppVersion(r.AppPath)
		if !r.Portable {
			appendFindingUnique(&r.Findings, finding{"not-portable", "info", "找到 UClaw，但它不是便携版目录；本次仅保留诊断结果"})
		}
	} else {
		appendFindingUnique(&r.Findings, finding{"app-not-found", "error", "未能自动找到 UClaw.exe 和 portable.flag"})
	}

	r.processTargets = findProcesses(r.SelectedRoot)
	for _, process := range r.processTargets {
		r.Processes = append(r.Processes, fmt.Sprintf("%s:%d", process.Name, process.PID))
	}
	if len(r.processTargets) > 0 {
		appendFindingUnique(&r.Findings, finding{"stale-process", "warning", "发现 UClaw 相关进程，可能阻止窗口重新打开"})
	}

	inspectLogs(&r)
	return r
}

func applySafeRepairs(r *report) {
	if !r.Portable {
		if r.SelectedRoot != "" {
			r.Actions = append(r.Actions, "检测到非便携版目录，未执行进程清理、更新目录隔离或重启")
		} else {
			r.Actions = append(r.Actions, "未找到可确认的便携版目录，未执行修复")
		}
		return
	}

	if len(r.processTargets) > 0 {
		killed, err := killUClawProcesses(r.processTargets)
		if killed > 0 {
			r.Actions = append(r.Actions, fmt.Sprintf("已结束 %d 个残留的 UClaw/Gateway 进程", killed))
		}
		if err != nil {
			r.Errors = append(r.Errors, "结束残留进程失败："+err.Error())
		}
	}

	updatesRoot := filepath.Join(r.RuntimeDir, "updates")
	for _, name := range []string{"staging", "ready"} {
		target := filepath.Join(updatesRoot, name)
		if isDirectory(target) {
			backup := target + ".repair-" + time.Now().Format("20060102-150405")
			if err := os.Rename(target, backup); err == nil {
				r.Actions = append(r.Actions, "已隔离更新临时目录："+filepath.Base(backup))
			} else {
				r.Errors = append(r.Errors, "隔离更新临时目录失败："+err.Error())
			}
		}
	}

	if r.SelectedRoot != "" && r.AppPath != "" {
		r.RestartAttempted = true
		cmd := exec.Command(r.AppPath)
		cmd.Dir = r.SelectedRoot
		if err := cmd.Start(); err != nil {
			r.Errors = append(r.Errors, "重新启动 UClaw 失败："+err.Error())
		} else {
			r.Actions = append(r.Actions, "已尝试重新启动 UClaw")
			r.Restarted = waitForProcessAlive(cmd.Process.Pid, startupProbeWait)
			if !r.Restarted {
				r.Errors = append(r.Errors, "UClaw 进程已启动但在限定时间内未保持运行")
			}
			_ = cmd.Process.Release()
		}
	}
}

func inspectLogs(r *report) {
	for _, file := range append(r.UpdateLogs, r.AppLogs...) {
		text := readTail(file, maxLogTailBytes)
		lower := strings.ToLower(text)
		var signals []string
		if strings.Contains(lower, "sqlite database is unstable") {
			signals = append(signals, "unstable-sqlite")
			appendFindingUnique(&r.Findings, finding{"unstable-sqlite", "warning", "日志显示 runtime SQLite 数据库不稳定；本版本仅采集并保留数据，不自动删除"})
		}
		if strings.Contains(lower, "slow managed gateway startup") || strings.Contains(lower, "spawntoreadyms") {
			signals = append(signals, "slow-gateway-startup")
			appendFindingUnique(&r.Findings, finding{"slow-gateway-startup", "warning", "日志显示 Gateway 启动较慢，可能造成双击后长时间无界面"})
		}
		if strings.Contains(lower, "context overflow") {
			signals = append(signals, "context-overflow")
			appendFindingUnique(&r.Findings, finding{"context-overflow", "info", "日志包含上下文超限，这是会话问题，不是主程序启动失败"})
		}
		if len(signals) > 0 {
			r.LogEvidence = append(r.LogEvidence, logEvidence{File: file, Signals: signals})
		}
	}
}

func inferRootFromFile(filePath string) string {
	if filePath == "" {
		return ""
	}
	text := readTail(filePath, maxReadBytes)
	match := rootPattern.FindStringSubmatch(text)
	if len(match) == 2 {
		return cleanRoot(trimLogFieldSuffix(match[1]))
	}
	return ""
}

func inferRootsFromLogs(files []string) []string {
	var roots []string
	for _, file := range files {
		roots = appendUnique(roots, inferRootFromFile(file))
	}
	return roots
}

func readTask(filePath string) (updateTask, error) {
	var task updateTask
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return task, err
	}
	err = json.Unmarshal(raw, &task)
	return task, err
}

func collectFiles(dir string, keep func(string) bool, limit int) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type item struct {
		path string
		time time.Time
	}
	var items []item
	for _, entry := range entries {
		if entry.IsDir() || !keep(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(dir, entry.Name()), info.ModTime()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].time.After(items[j].time) })
	if len(items) > limit {
		items = items[:limit]
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.path)
	}
	return out
}

func isUClawRoot(root string) bool {
	return root != "" && findAppPath(root) != ""
}

func selectRoot(roots []string) string {
	var fallback string
	for _, root := range roots {
		if !isUClawRoot(root) {
			continue
		}
		if fallback == "" {
			fallback = root
		}
		if pathExists(filepath.Join(root, "portable.flag")) {
			return root
		}
	}
	return fallback
}

func findAppPath(root string) string {
	for _, name := range []string{"UClaw.exe", "ClawX.exe"} {
		candidate := filepath.Join(root, name)
		if isFile(candidate) {
			return candidate
		}
	}
	return ""
}

func readAppVersion(appPath string) string {
	if appPath == "" {
		return ""
	}
	// Portable builds expose a build identity beside the executable or under
	// resources. Avoid parsing the PE resource table in this dependency-free v1.
	for _, file := range []string{
		filepath.Join(filepath.Dir(appPath), "uclaw-usb-build.json"),
		filepath.Join(filepath.Dir(appPath), "resources", "uclaw-build.json"),
	} {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var identity struct {
			AppVersion string `json:"appVersion"`
		}
		if json.Unmarshal(raw, &identity) == nil && identity.AppVersion != "" {
			return identity.AppVersion
		}
	}
	return ""
}

func findProcesses(root string) []processInfo {
	if runtime.GOOS != "windows" || root == "" {
		return nil
	}
	command := `$items=@(Get-CimInstance -ClassName Win32_Process | Where-Object { @('UClaw.exe','ClawX.exe','openclaw.exe','openclaw-gateway.exe','node.exe') -contains $_.Name } | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine); $items | ConvertTo-Json -Compress`
	out, err := exec.Command(
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		command,
	).Output()
	if err != nil {
		return nil
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" || raw == "null" {
		return nil
	}
	var processes []processInfo
	if strings.HasPrefix(raw, "[") {
		if json.Unmarshal([]byte(raw), &processes) != nil {
			return nil
		}
	} else {
		var process processInfo
		if json.Unmarshal([]byte(raw), &process) != nil {
			return nil
		}
		processes = []processInfo{process}
	}
	filtered := make([]processInfo, 0, len(processes))
	for _, process := range processes {
		if isRelevantProcess(process, root) {
			filtered = append(filtered, process)
		}
	}
	return filtered
}

func killUClawProcesses(processes []processInfo) (int, error) {
	return killUClawProcessesWith(processes, func(pid int) error {
		cmd := exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F")
		return cmd.Run()
	})
}

func killUClawProcessesWith(processes []processInfo, runTaskkill func(pid int) error) (int, error) {
	killed := 0
	var firstErr error
	for _, process := range processes {
		if process.PID <= 0 {
			continue
		}
		if err := runTaskkill(process.PID); err != nil {
			// taskkill /T can terminate a child while killing its parent. A
			// subsequent taskkill for that child returns 128 even though the
			// process tree has already been stopped successfully.
			if isTaskkillAlreadyGone(err) {
				killed++
				continue
			}
			if firstErr == nil {
				firstErr = fmt.Errorf("%s(%d): %w", process.Name, process.PID, err)
			}
			continue
		}
		killed++
	}
	return killed, firstErr
}

func isTaskkillAlreadyGone(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) &&
		exitErr.ProcessState != nil &&
		exitErr.ProcessState.ExitCode() == taskkillAlreadyGoneExitCode
}

func writeReport(filePath string, r report) error {
	if strings.TrimSpace(filePath) == "" {
		return errors.New("report path is empty")
	}
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	safe := sanitizedReport(r)
	raw, err := json.MarshalIndent(safe, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, append(raw, '\n'), 0o600)
}

func readTail(filePath string, maxBytes int) string {
	file, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return ""
	}
	start := info.Size() - int64(maxBytes)
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	raw, err := io.ReadAll(io.LimitReader(file, int64(maxBytes)))
	if err != nil {
		return ""
	}
	return string(raw)
}

func cleanRoot(root string) string {
	root = strings.TrimSpace(strings.Trim(root, `"`))
	if root == "" {
		return ""
	}
	if !isAbsolutePath(root) {
		return ""
	}
	if len(root) == 3 && root[1] == ':' && (root[2] == '\\' || root[2] == '/') {
		return root[:2] + `\`
	}
	trimmed := strings.TrimRight(root, `\/`)
	if trimmed == "" && strings.HasPrefix(root, "/") {
		return string(filepath.Separator)
	}
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

func isAbsolutePath(value string) bool {
	if value == "" {
		return false
	}
	if filepath.IsAbs(value) {
		return true
	}
	if len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' {
		return value[2] == '\\' || value[2] == '/'
	}
	return strings.HasPrefix(value, `\\`) || strings.HasPrefix(value, "//")
}

func trimLogFieldSuffix(value string) string {
	location := logFieldPattern.FindStringIndex(value)
	if location == nil {
		return value
	}
	return value[:location[0]]
}

func sanitizedReport(r report) report {
	r.RuntimeDir = redactUserPath(r.RuntimeDir)
	r.CandidateRoots = redactPaths(r.CandidateRoots)
	r.SelectedRoot = redactUserPath(r.SelectedRoot)
	r.AppPath = redactUserPath(r.AppPath)
	r.UpdateTasks = redactPaths(r.UpdateTasks)
	r.UpdateLogs = redactPaths(r.UpdateLogs)
	r.AppLogs = redactPaths(r.AppLogs)
	evidence := make([]logEvidence, 0, len(r.LogEvidence))
	for _, item := range r.LogEvidence {
		evidence = append(evidence, logEvidence{
			File:    redactUserPath(item.File),
			Signals: append([]string(nil), item.Signals...),
		})
	}
	r.LogEvidence = evidence
	r.Findings = redactFindings(r.Findings)
	r.Actions = redactStrings(r.Actions)
	r.Errors = redactStrings(r.Errors)
	r.processTargets = nil
	return r
}

func redactFindings(findings []finding) []finding {
	out := make([]finding, 0, len(findings))
	for _, item := range findings {
		out = append(out, finding{
			Code:     redactText(item.Code),
			Severity: redactText(item.Severity),
			Message:  redactText(item.Message),
		})
	}
	return out
}

func redactPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, redactUserPath(path))
	}
	return out
}

func redactUserPath(value string) string {
	profile := strings.TrimSpace(os.Getenv("USERPROFILE"))
	if profile == "" {
		if home, err := os.UserHomeDir(); err == nil {
			profile = home
		}
	}
	for _, candidate := range []string{
		profile,
		strings.ReplaceAll(profile, `\`, `/`),
		strings.ReplaceAll(profile, `/`, `\`),
	} {
		if candidate == "" {
			continue
		}
		value = replaceInsensitive(value, candidate, "%USERPROFILE%")
	}
	return value
}

func redactText(value string) string {
	text := redactUserPath(value)
	text = bearerPattern.ReplaceAllString(text, `${1}[REDACTED]`)
	text = secretPattern.ReplaceAllString(text, `${1}[REDACTED]`)
	text = urlCredentialPattern.ReplaceAllString(text, `${1}[REDACTED]@`)
	return text
}

func redactStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, redactText(value))
	}
	return out
}

func replaceInsensitive(value string, old string, replacement string) string {
	if old == "" {
		return value
	}
	pattern, err := regexp.Compile(`(?i)` + regexp.QuoteMeta(old))
	if err != nil {
		return value
	}
	return pattern.ReplaceAllString(value, replacement)
}

func pathExists(filePath string) bool {
	_, err := os.Stat(filePath)
	return err == nil
}

func isFile(filePath string) bool {
	info, err := os.Stat(filePath)
	return err == nil && !info.IsDir()
}

func isDirectory(filePath string) bool {
	info, err := os.Lstat(filePath)
	return err == nil && info.IsDir()
}

func appendUnique(values []string, value string) []string {
	value = cleanRoot(value)
	if value == "" {
		return values
	}
	for _, existing := range values {
		if strings.EqualFold(existing, value) {
			return values
		}
	}
	return append(values, value)
}

func appendFindingUnique(findings *[]finding, candidate finding) {
	for _, existing := range *findings {
		if existing.Code == candidate.Code {
			return
		}
	}
	*findings = append(*findings, candidate)
}

func hasArg(args []string, name string) bool {
	for _, arg := range args {
		if arg == name {
			return true
		}
	}
	return false
}

func shouldRepair(args []string, confirm func() bool) bool {
	if hasArg(args, "--diagnose") {
		return false
	}
	if hasArg(args, "--repair") {
		return true
	}
	if confirm == nil {
		return false
	}
	return confirm()
}

func argValue(args []string, name string) string {
	for index, arg := range args {
		if arg == name && index+1 < len(args) {
			return args[index+1]
		}
		prefix := name + "="
		if strings.HasPrefix(arg, prefix) {
			return strings.TrimPrefix(arg, prefix)
		}
	}
	return ""
}

func summary(r report, repaired bool, reportPath string) string {
	safe := sanitizedReport(r)
	var builder strings.Builder
	builder.WriteString("UClaw 修复小助手\n")
	if safe.SelectedRoot != "" {
		builder.WriteString("安装目录: " + safe.SelectedRoot + "\n")
	} else {
		builder.WriteString("安装目录: 未找到\n")
	}
	builder.WriteString("发现问题: " + strconv.Itoa(len(safe.Findings)) + "\n")
	if repaired {
		builder.WriteString("修复动作: " + strconv.Itoa(len(safe.Actions)) + "\n")
	}
	builder.WriteString("诊断报告: " + redactUserPath(reportPath) + "\n")
	if len(safe.Errors) > 0 {
		builder.WriteString("部分动作失败，请把诊断报告发给技术支持。\n")
	} else if repaired && safe.Restarted {
		builder.WriteString("已尝试重新启动 UClaw。\n")
	} else {
		builder.WriteString("诊断完成；未修改用户会话或 SQLite 数据。\n")
	}
	return builder.String()
}

func writeConsole(message string) {
	fmt.Fprint(os.Stdout, message)
}

func findRootNear(start string) string {
	current := filepath.Clean(start)
	for depth := 0; depth < 4; depth++ {
		if isUClawRoot(current) {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return ""
}

func resolveRuntimeDir() string {
	for _, name := range []string{"CLAWX_RUNTIME_CACHE_DIR", "CLAWX_RUNTIME_CACHE_ROOT", "CLAWX_PORTABLE_RUNTIME_ROOT"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return filepath.Clean(value)
		}
	}

	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if base == "" {
		if cacheDir, err := os.UserCacheDir(); err == nil {
			base = cacheDir
		}
	}
	if base == "" {
		base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(base, runtimeDirName)
}

func pathWithin(child string, parent string) bool {
	child = normalizeComparablePath(child)
	parent = normalizeComparablePath(parent)
	if child == "" || parent == "" {
		return false
	}
	if child == parent {
		return true
	}
	if strings.HasSuffix(parent, "/") {
		return strings.HasPrefix(child, parent)
	}
	return strings.HasPrefix(child, parent+"/")
}

func normalizeComparablePath(value string) string {
	value = strings.TrimSpace(strings.Trim(value, `"`))
	value = strings.ReplaceAll(value, `\`, `/`)
	if value == "" {
		return ""
	}
	value = pathpkg.Clean(value)
	if len(value) == 2 && value[1] == ':' {
		value += "/"
	}
	return strings.ToLower(value)
}

func isRelevantProcess(process processInfo, root string) bool {
	if process.PID <= 0 || !pathWithin(process.Executable, root) {
		return false
	}
	name := strings.ToLower(strings.TrimSpace(process.Name))
	switch name {
	case "uclaw.exe", "clawx.exe", "openclaw.exe", "openclaw-gateway.exe":
		return true
	case "node.exe":
		command := strings.ToLower(process.Command)
		return strings.Contains(command, "openclaw") || strings.Contains(command, "gateway")
	default:
		return false
	}
}

func waitForProcessAlive(pid int, timeout time.Duration) bool {
	if pid <= 0 {
		return false
	}
	if runtime.GOOS != "windows" {
		return true
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if windowsProcessAlive(pid) {
			return true
		}
		time.Sleep(startupProbeInterval)
	}
	return windowsProcessAlive(pid)
}

func windowsProcessAlive(pid int) bool {
	output, err := exec.Command(
		"tasklist.exe",
		"/FI",
		"PID eq "+strconv.Itoa(pid),
		"/FO",
		"CSV",
		"/NH",
	).Output()
	if err != nil {
		return false
	}
	needle := `"` + strconv.Itoa(pid) + `"`
	for _, line := range strings.Split(string(output), "\n") {
		if strings.Contains(line, needle) {
			return true
		}
	}
	return false
}
