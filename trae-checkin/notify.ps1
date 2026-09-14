param(
    [int]$RC = 0
)

# Trae check-in result notification: RC=0 success (Info), non-zero failure (Error).
# Called by run_checkin.cmd. ASCII-only to avoid codepage/encoding issues.
# Uses Windows built-in PowerShell only, zero third-party dependencies.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($RC -eq 0) {
    $icon    = [System.Drawing.SystemIcons]::Information
    $tipIcon = 'Info'
    $title   = 'Trae auto check-in done'
    $content = 'Daily check-in flow completed (already-checked-in is skipped). See checkin.log / checkin_history.jsonl next to the script for details.'
} else {
    $icon    = [System.Drawing.SystemIcons]::Error
    $tipIcon = 'Error'
    $title   = 'Trae auto check-in failed'
    if ($RC -eq 2) {
        $content = 'Check-in configuration error (exit code 2). No sign-in ran this time. Please check TRAE_TOKEN in config.json.'
    } else {
        $content = "Auto check-in failed (exit code $RC). Please open https://www.trae.cn, verify the token is not expired, or check in manually today."
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

    Start-Sleep -Seconds 15
    $tip.Visible = $false
    $tip.Dispose()
} catch {
    # Notification failure is silent; never block the main flow.
}