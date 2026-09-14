@echo off
setlocal
rem Trae daily check-in launcher (Windows, ASCII only to avoid codepage issues).
rem This tool runs from its own directory; real config.json is gitignored.
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem Scheduled task mode (args present, e.g. "--delay 120 --scheduled"):
rem run fully in background via pythonw - no console window, no toast spam.
rem trae_checkin.py itself checks its daily record first and exits silently
rem if today is already checked in; it also shows the Windows toast when
rem needed (always on failure, once on the first success of the day).
rem ---------------------------------------------------------------------
if not "%~1"=="" goto :background

rem ---------------- manual mode (double-click, no args) ----------------
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found. Install Python 3 and check "Add to PATH".
    pause
    exit /b 1
)

python trae_checkin.py --log-file "%~dp0checkin.log" %*
set "rc=%errorlevel%"

rem Pause only when launched by Explorer double-click; running from an open
rem terminal just returns the exit code.
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
endlocal & exit /b %rc%

:background
rem Detach with pythonw so the scheduler console closes immediately and the
rem check-in keeps running without any visible window. Fall back to a
rem minimized console if pythonw is unavailable.
where pythonw >nul 2>nul
if errorlevel 1 (
    start "TraeCheckin" /min python trae_checkin.py --log-file "%~dp0checkin.log" --scheduled %*
) else (
    start "" /b pythonw trae_checkin.py --log-file "%~dp0checkin.log" --scheduled %*
)
endlocal & exit /b 0
