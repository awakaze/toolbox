param(
    [int]$RC = 0
)

# Trae 签到结果系统通知：RC=0 成功（Info 图标），非 0 失败（Error 图标）
# 由 run_checkin.cmd 调用，零第三方依赖（仅 Windows 自带 PowerShell）。
# 声音跟随 Windows 通知设置的默认提示音，无需额外授权。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($RC -eq 0) {
    $icon    = [System.Drawing.SystemIcons]::Information
    $tipIcon = 'Info'
    $title   = 'Trae 自动签到完成'
    $content = "今日签到流程已完成（已签到会自动跳过），详细信息见同目录 checkin.log。"
} else {
    $icon    = [System.Drawing.SystemIcons]::Error
    $tipIcon = 'Error'
    $title   = 'Trae 自动签到失败'
    if ($RC -eq 2) {
        $content = "签到配置有误（退出码 2），本次未运行签到：" +
                   "请检查 config.json 中的 TRAE_TOKEN 是否已正确填写。"
    } else {
        $content = "自动签到失败（退出码 $RC）：" +
                   "请打开 https://www.trae.cn 检查 token 是否过期，或手动签到补上今天的积分。"
    }
}

try {
    $tip = New-Object System.Windows.Forms.NotifyIcon
    $tip.Icon = $icon
    $tip.BalloonTipIcon = $tipIcon
    $tip.BalloonTipTitle = $title
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
