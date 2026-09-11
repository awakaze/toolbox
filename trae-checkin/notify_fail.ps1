param(
    [int]$RC = 1
)

# Trae 签到失败时的 Windows 桌面气泡通知 + 系统提示音
# 由 run_checkin.cmd 在退出码非 0 时调用，零第三方依赖（仅 Windows 自带 PowerShell）。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($RC -eq 2) {
    $content = "签到配置有误（退出码 2），本次未运行签到：" +
               "请检查 config.json 中的 TRAE_TOKEN 是否已正确填写。"
} else {
    $content = "自动签到失败（退出码 $RC）：" +
               "请打开 https://www.trae.cn 检查 token 是否过期，或手动签到补上今天的积分。"
}

try {
    $tip = New-Object System.Windows.Forms.NotifyIcon
    $tip.Icon = [System.Drawing.SystemIcons]::Error
    $tip.BalloonTipIcon = 'Error'
    $tip.BalloonTipTitle = 'Trae 自动签到失败'
    $tip.BalloonTipText  = $content
    $tip.Visible  = $true
    $tip.ShowBalloonTip(15000)

    # 停留一段时间让气泡可读，然后释放托盘图标
    Start-Sleep -Seconds 15
    $tip.Visible = $false
    $tip.Dispose()
} catch {
    # 弹窗失败静默处理，不影响主流程
}

# 系统提示音（两短一长，提示需处理）
if ($RC -ne 0) {
    try {
        [Console]::Beep(880, 300)
        Start-Sleep -Milliseconds 200
        [Console]::Beep(880, 300)
        Start-Sleep -Milliseconds 200
        [Console]::Beep(588, 500)
    } catch {
        # 无解音设备时忽略
    }
}