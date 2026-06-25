//go:build windows

package main

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	progressWindowClass = "UClawPortableUpdaterProgressWindow"
	progressWindowTitle = "UClaw 更新"

	cwUseDefault = 0x80000000

	wsOverlapped  = 0x00000000
	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsVisible     = 0x10000000

	colorWindow = 5

	wmCreate  = 0x0001
	wmDestroy = 0x0002
	wmPaint   = 0x000F
	wmClose   = 0x0010
	wmUser    = 0x0400

	dtLeft        = 0x00000000
	dtCenter      = 0x00000001
	dtWordBreak   = 0x00000010
	dtSingleLine  = 0x00000020
	dtVCenter     = 0x00000004
	dtEndEllipsis = 0x00008000

	swShow = 5
)

const wmProgressUpdate = wmUser + 1
const wmProgressClose = wmUser + 2

type point struct {
	X int32
	Y int32
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type paintStruct struct {
	Hdc         uintptr
	Erase       int32
	Paint       rect
	Restore     int32
	IncUpdate   int32
	RgbReserved [32]byte
}

type rect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type progressReporter struct {
	mu     sync.RWMutex
	state  progressState
	hwnd   uintptr
	ready  chan struct{}
	closed chan struct{}
}

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")
	kernel = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procShowWindow       = user32.NewProc("ShowWindow")
	procUpdateWindow     = user32.NewProc("UpdateWindow")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procPostMessageW     = user32.NewProc("PostMessageW")
	procInvalidateRect   = user32.NewProc("InvalidateRect")
	procBeginPaint       = user32.NewProc("BeginPaint")
	procEndPaint         = user32.NewProc("EndPaint")
	procFillRect         = user32.NewProc("FillRect")
	procGetClientRect    = user32.NewProc("GetClientRect")
	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	procDeleteObject     = gdi32.NewProc("DeleteObject")
	procSetBkMode        = gdi32.NewProc("SetBkMode")
	procSetTextColor     = gdi32.NewProc("SetTextColor")
	procDrawTextW        = user32.NewProc("DrawTextW")
	procGetModuleHandleW = kernel.NewProc("GetModuleHandleW")
	procLoadCursorW      = user32.NewProc("LoadCursorW")

	progressWindow  *progressReporter
	progressWndProc = syscall.NewCallback(progressWindowProc)
)

func newProgressReporter() *progressReporter {
	reporter := &progressReporter{
		state: progressState{
			Title:   "正在准备更新",
			Detail:  "请不要关闭此窗口。",
			Percent: 1,
		},
		ready:  make(chan struct{}),
		closed: make(chan struct{}),
	}
	progressWindow = reporter
	go reporter.run()

	select {
	case <-reporter.ready:
	case <-time.After(1500 * time.Millisecond):
	}

	return reporter
}

func (p *progressReporter) Update(state progressState) {
	if p == nil {
		return
	}
	if state.Percent < 0 {
		state.Percent = 0
	}
	if state.Percent > 100 {
		state.Percent = 100
	}
	p.mu.Lock()
	if strings.TrimSpace(state.Title) == "" {
		state.Title = p.state.Title
	}
	if strings.TrimSpace(state.Detail) == "" {
		state.Detail = p.state.Detail
	}
	p.state = state
	hwnd := p.hwnd
	p.mu.Unlock()

	if hwnd != 0 {
		procPostMessageW.Call(hwnd, wmProgressUpdate, 0, 0)
	}
}

func (p *progressReporter) Fail(title string, detail string) {
	if p == nil {
		return
	}
	p.Update(progressState{Title: title, Detail: detail, Percent: 100, Error: true})
	time.Sleep(2500 * time.Millisecond)
}

func (p *progressReporter) Close() {
	if p == nil {
		return
	}
	p.mu.RLock()
	hwnd := p.hwnd
	p.mu.RUnlock()
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, wmProgressClose, 0, 0)
		select {
		case <-p.closed:
		case <-time.After(1200 * time.Millisecond):
		}
	}
}

func (p *progressReporter) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(p.closed)

	instance, _, _ := procGetModuleHandleW.Call(0)
	className, _ := syscall.UTF16PtrFromString(progressWindowClass)
	title, _ := syscall.UTF16PtrFromString(progressWindowTitle)
	cursor, _, _ := procLoadCursorW.Call(0, uintptr(32512))

	wc := wndClassEx{
		Size:       uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:    progressWndProc,
		Instance:   instance,
		Cursor:     cursor,
		Background: colorWindow + 1,
		ClassName:  className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox|wsVisible,
		cwUseDefault,
		cwUseDefault,
		460,
		210,
		0,
		0,
		instance,
		0,
	)
	if hwnd == 0 {
		close(p.ready)
		return
	}

	p.mu.Lock()
	p.hwnd = hwnd
	p.mu.Unlock()
	close(p.ready)

	procShowWindow.Call(hwnd, swShow)
	procUpdateWindow.Call(hwnd)

	var message msg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(ret) <= 0 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func progressWindowProc(hwnd uintptr, message uint32, wParam uintptr, lParam uintptr) uintptr {
	switch message {
	case wmCreate:
		return 0
	case wmProgressUpdate:
		invalidateWindow(hwnd)
		return 0
	case wmPaint:
		paintProgressWindow(hwnd)
		return 0
	case wmProgressClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	case wmClose:
		return 0
	default:
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return ret
	}
}

func invalidateWindow(hwnd uintptr) {
	// Passing nil rect and erase=true asks Windows to repaint the whole small window.
	procInvalidateRect.Call(hwnd, 0, 1)
}

func paintProgressWindow(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

	var client rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	fill(hdc, client, rgb(245, 247, 250))

	state := progressState{Title: "正在更新", Detail: "请不要关闭此窗口。", Percent: 1}
	if progressWindow != nil {
		progressWindow.mu.RLock()
		state = progressWindow.state
		progressWindow.mu.RUnlock()
	}

	procSetBkMode.Call(hdc, 1)
	procSetTextColor.Call(hdc, rgb(18, 24, 38))
	drawText(hdc, state.Title, rect{Left: 28, Top: 24, Right: 432, Bottom: 54}, dtLeft|dtSingleLine|dtEndEllipsis)

	procSetTextColor.Call(hdc, rgb(86, 96, 116))
	drawText(hdc, state.Detail, rect{Left: 28, Top: 58, Right: 432, Bottom: 98}, dtLeft|dtWordBreak|dtEndEllipsis)

	barOuter := rect{Left: 28, Top: 112, Right: 432, Bottom: 134}
	fill(hdc, barOuter, rgb(226, 232, 240))
	width := int32((int(barOuter.Right-barOuter.Left) * state.Percent) / 100)
	if width < 0 {
		width = 0
	}
	fillColor := rgb(37, 99, 235)
	if state.Error {
		fillColor = rgb(220, 38, 38)
	}
	if width > 0 {
		fill(hdc, rect{Left: barOuter.Left, Top: barOuter.Top, Right: barOuter.Left + width, Bottom: barOuter.Bottom}, fillColor)
	}

	procSetTextColor.Call(hdc, rgb(51, 65, 85))
	drawText(
		hdc,
		fmt.Sprintf("%d%%", state.Percent),
		rect{Left: 28, Top: 144, Right: 432, Bottom: 168},
		dtCenter|dtSingleLine|dtVCenter,
	)
}

func fill(hdc uintptr, area rect, color uintptr) {
	brush, _, _ := procCreateSolidBrush.Call(color)
	if brush == 0 {
		return
	}
	defer procDeleteObject.Call(brush)
	procFillRect.Call(hdc, uintptr(unsafe.Pointer(&area)), brush)
}

func drawText(hdc uintptr, text string, area rect, format uint32) {
	wide, _ := syscall.UTF16PtrFromString(text)
	procDrawTextW.Call(
		hdc,
		uintptr(unsafe.Pointer(wide)),
		^uintptr(0),
		uintptr(unsafe.Pointer(&area)),
		uintptr(format),
	)
}

func rgb(red int, green int, blue int) uintptr {
	return uintptr(red | green<<8 | blue<<16)
}
