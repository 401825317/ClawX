@echo off
setlocal
chcp 65001 >nul 2>&1

set "UCLAW_NODE=%~dp0resources\bin\node.exe"
set "UCLAW_TEMP_SCRIPT=%TEMP%\UClaw-SelfCheck-%RANDOM%-%RANDOM%.mjs"

echo UClaw Windows USB Self-Check
echo ============================

if not exist "%UCLAW_NODE%" (
  echo [FAIL] Bundled Node runtime is missing:
  echo        %UCLAW_NODE%
  echo.
  echo This USB package is incomplete or the file was removed by security software.
  echo Please send this screen to UClaw support.
  pause
  exit /b 2
)

"%UCLAW_NODE%" -e "const fs=require('fs');const source=fs.readFileSync(process.argv[1],'utf8');const marker='//__UCLAW_SELF_CHECK_PAYLOAD__';const index=source.lastIndexOf(marker);if(index<0)process.exit(2);fs.writeFileSync(process.argv[2],source.slice(index+marker.length).replace(/^\r?\n/,''),'utf8')" "%~f0" "%UCLAW_TEMP_SCRIPT%"
if errorlevel 1 goto extract_failed
if not exist "%UCLAW_TEMP_SCRIPT%" goto extract_failed

"%UCLAW_NODE%" "%UCLAW_TEMP_SCRIPT%" --root "%~dp0." --start-app %*
set "UCLAW_EXIT=%ERRORLEVEL%"
del /q "%UCLAW_TEMP_SCRIPT%" >nul 2>&1

echo.
if "%UCLAW_EXIT%"=="0" (
  echo Self-check completed successfully.
) else if "%UCLAW_EXIT%"=="1" (
  echo Self-check completed with warnings. Send the report to UClaw support.
) else (
  echo Self-check found blocking problems. Send the report to UClaw support.
)
echo Reports are saved under UClawData\diagnostics.
pause
endlocal & exit /b %UCLAW_EXIT%

:extract_failed
del /q "%UCLAW_TEMP_SCRIPT%" >nul 2>&1
echo [FAIL] The embedded self-check program could not be extracted.
echo Please download a complete UClaw self-check command.
pause
endlocal & exit /b 2
