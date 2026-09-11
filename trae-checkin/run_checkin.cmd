@echo off
setlocal
rem Trae 每日签到启动器（Windows）
rem 双击 = 立即签到一次；也可被"任务计划程序"调用实现每天自动签到。
rem 含"开机补签失败弹窗"：签到失败（退出码非 0）时弹出 Windows 气泡通知（系统默认提示音）。
rem 本工具在该目录运行，真实配置 config.json 不会被提交到 git（见 .gitignore）。
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3 并勾选 "Add to PATH"
    pause
    exit /b 1
)

python trae_checkin.py --log-file "%~dp0checkin.log" %*
set "rc=%errorlevel%"

rem 弹出 Windows 系统通知：成功 Info / 失败 Error（声音跟随系统通知设置，零依赖）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify.ps1" -RC %rc%

rem 仅双击运行时暂停（无参数且由 Explorer 启动）；计划任务带 --delay 参数，直接退出，
rem 否则 %cmdcmdline% 包含脚本名会误触发 pause，把任务挂起直到超时被杀
if "%~1"=="" (
    echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
)
endlocal & exit /b %rc%
