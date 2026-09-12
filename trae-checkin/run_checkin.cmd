@echo off
setlocal
rem Trae daily check-in launcher (Windows, ASCII only to avoid codepage issues).
rem Double-click = check in once now. Also invoked by Task Scheduler for daily run.
rem Shows a Windows toast on failure (exit code != 0).
rem This tool runs from its own directory; real config.json is gitignored.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found. Install Python 3 and check "Add to PATH".
    pause
    exit /b 1
)

python trae_checkin.py --log-file "%~dp0checkin.log" %*
set "rc=%errorlevel%"

rem Show Windows notification: Info on success / Error on failure (zero deps).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify.ps1" -RC %rc%

rem Pause only on double-click (no args, launched by Explorer); scheduled task
rem passes --delay so it exits directly, otherwise pause would hang the task.
if "%~1"=="" (
    echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
)
endlocal & exit /b %rc%
