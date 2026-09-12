//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

const (
	messageBoxOK           = 0x00000000
	messageBoxYesNo        = 0x00000004
	messageBoxIconInfo     = 0x00000040
	messageBoxIconQuestion = 0x00000020
	messageBoxDefaultNo    = 0x00000100
	messageBoxResultYes    = 6
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
)

func confirmSafeRepair() bool {
	result, _, _ := procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("将生成诊断报告。\n\n是否同时执行安全修复？\n\n安全修复只会结束当前 UClaw 目录下的残留进程、隔离更新临时目录，并尝试重新启动 UClaw；不会删除 UClawData、会话、SQLite、配置或凭据。"))),
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("UClaw 修复小助手"))),
		uintptr(messageBoxYesNo|messageBoxIconQuestion|messageBoxDefaultNo),
	)
	return result == messageBoxResultYes
}

func showFinalMessage(title string, body string) {
	_, _, _ = procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(body))),
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(title))),
		uintptr(messageBoxOK|messageBoxIconInfo),
	)
}
