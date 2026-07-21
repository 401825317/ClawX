@echo off
setlocal

if /i "%1"=="update" (
    echo openclaw is managed by UClaw ^(bundled version^).
    echo.
    echo To update openclaw, update UClaw:
    echo   Open UClaw ^> Settings ^> Check for Updates
    echo   Or download the latest version from https://claw-x.com
    exit /b 0
)

rem Switch console to UTF-8 so Unicode box-drawing and CJK text render correctly
rem on non-English Windows (e.g. Chinese CP936). Save the previous codepage to restore later.
for /f "tokens=2 delims=:." %%a in ('chcp') do set /a "_CP=%%a" 2>nul
chcp 65001 >nul 2>&1

set OPENCLAW_EMBEDDED_IN=UClaw
set "NODE_EXE=%~dp0..\bin\node.exe"
set "OPENCLAW_ENTRY=%~dp0..\openclaw\openclaw.mjs"
set "ELECTRON_EXE=%~dp0..\..\UClaw.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\..\ClawX.exe"

set "_USE_BUNDLED_NODE=0"
if exist "%NODE_EXE%" (
    "%NODE_EXE%" -e "const [maj,min,patch]=process.versions.node.split('.').map(Number);const ok=(maj===22&&(min>22||min===22&&patch>=3))||(maj===24&&(min>15||min===15&&patch>=0))||(maj===25&&(min>9||min===9&&patch>=0));process.exit(ok?0:1)" >nul 2>&1
    if not errorlevel 1 set "_USE_BUNDLED_NODE=1"
)

if "%_USE_BUNDLED_NODE%"=="1" (
    "%NODE_EXE%" "%OPENCLAW_ENTRY%" %*
) else (
    set ELECTRON_RUN_AS_NODE=1
    "%ELECTRON_EXE%" "%OPENCLAW_ENTRY%" %*
)
set _EXIT=%ERRORLEVEL%

if defined _CP chcp %_CP% >nul 2>&1

endlocal & exit /b %_EXIT%
