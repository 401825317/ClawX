//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestFormatLiveObservedChildrenExplainsResidualPID(t *testing.T) {
	detail := formatLiveObservedChildren(map[int]observedChildProcess{
		999_999_999: {
			pid:               999_999_999,
			observedImageName: "original-child.exe",
		},
	})

	if !strings.Contains(detail, "pid=999999999") {
		t.Fatalf("expected residual PID in diagnostic, got %q", detail)
	}
	if !strings.Contains(detail, "image=") {
		t.Fatalf("expected residual image detail, got %q", detail)
	}
	if strings.Contains(detail, `\`) || strings.Contains(detail, `:/`) {
		t.Fatalf("diagnostic must report only the image name, not a full path: %q", detail)
	}
}

func TestFormatLiveObservedChildrenExplainsParentOnlyTimeout(t *testing.T) {
	if got := formatLiveObservedChildren(nil); got != "none (parent process is still running)" {
		t.Fatalf("unexpected parent-only diagnostic: %q", got)
	}
}
