@echo off
setlocal
rem Trae 每日签到启动器（Windows）
rem 双击 = 立即签到一次；也可被"任务计划程序"调用实现每天自动签到。
rem 含"开机补签失败弹窗"：签到失败（退出码非 0）时弹出 Windows 气泡通知 + 系统提示音。
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

rem 签到失败时弹出 Windows 桌面气泡通知 + 系统提示音（零依赖，仅用自带的 PowerShell）
if not "%rc%"=="0" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify_fail.ps1" -RC %rc%
)

rem 仅双击运行时暂停，方便查看结果；被计划任务调用时直接退出
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
endlocal & exit /b %rc%
