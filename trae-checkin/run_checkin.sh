#!/bin/sh
# Trae 每日签到启动器（macOS / Linux）
# 直接执行 = 立即签到一次；也可被 crontab 调用实现每天自动签到
cd "$(dirname "$0")" || exit 1
exec python3 trae_checkin.py --log-file "$PWD/checkin.log" "$@"
