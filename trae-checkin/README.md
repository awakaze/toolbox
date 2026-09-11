# Trae 每日自动签到

自动完成 Trae CN（TraeWork）每日签到领取积分（每天 150~200 积分），纯 Python 标准库为主。

## 功能特性

- **自动读取本机登录态**：默认从本机已登录的 Trae IDE 直接解密读取 token，无需手动复制（可选装 `pycryptodome`；未装则退回手动配置）
- **先查后签**：先查询签到状态，已签到自动跳过；领取后自动复查确认到账
- **限流重试**：针对高峰期服务器限流（code 9074）自动指数退避重试
- **防风控限额**：每日领取请求最多 10 次（状态查询不计入），跨多次运行累计，超限自动停止
- **随机延迟**：可配置启动后随机延迟 0~N 分钟，避开整点脚本高峰
- **多账号**：支持批量签到，按账号逐个处理、汇总结果
- **通知推送**：失败时推送 Server酱（微信）/ Bark（iOS）/ Telegram / 自定义 Webhook；TG 自动使用系统代理
- **Windows 系统通知**：成功/失败都弹系统气泡通知（Windows 默认提示音，零依赖，仅用自带的 PowerShell）
- **token 有效期检测**：JWT 格式的 token 自动显示剩余天数，临期预警、过期明确报错
- **安全**：日志中 token 脱敏，请求头与官方客户端行为一致（仅 `Cloud-IDE-JWT` 认证头 + `X-User-Region`）

## 快速开始（本机部署）

### 1. 获取 token

**默认自动读取**：脚本优先从本机**已登录的 Trae IDE** 解密出账号 token（读取
`iCubeAuthInfo://icube.cloudide` 登录态，配合 `Cloud-IDE-JWT` 认证头），本机登录过 Trae 即可直接跑，无需手动复制。

> 自动读取依赖 `pycryptodome`（可选）。已装则自动启用；未装也能跑，只是需要手动配置 token：
> `pip install pycryptodome`

**手动配置（可选）**：浏览器登录 [trae.cn](https://www.trae.cn) → `F12` → **Network**，
找发往 `api.trae.cn` 的请求，复制请求头 `Authorization` 中 `Cloud-IDE-JWT ` 后面的部分。

### 2. 填写配置

复制 [config.example.json](config.example.json) 为 `config.json`（与脚本同目录）即可，`TRAE_TOKEN` 留空也能自动读取本机登录态：

```json
{
  "TRAE_TOKEN": "",
  "CHECKIN_MAX_DELAY": "600"
}
```

> 若需手动指定 token，填入 `TRAE_TOKEN`。`config.json` 含 token，已被本目录 `.gitignore` 忽略，**不会提交到 git**；
> 仓库内只保留模板 `config.example.json`。云服务器上无法读取本机登录态，需填 token。

### 3. 运行

**Windows**：双击 `run_checkin.cmd`，窗口会显示结果后暂停

**macOS / Linux**：

```bash
./run_checkin.sh
```

日志自动写入同目录的 `checkin.log`。

### 4. 设置每天自动签到

**Windows**（任务计划程序，无需管理员权限，每天 08:00）：

```bat
schtasks /create /tn "TraeCheckin" /tr "\"C:\你的路径\run_checkin.cmd\"" /sc daily /st 08:00
```

**macOS / Linux**（crontab，`crontab -e` 添加）：

```
0 8 * * * /你的路径/run_checkin.sh
```

> 建议避开整点，服务器高峰期容易限流（9074），脚本会自动重试。

## 配置项说明

配置文件 `config.json` 与环境变量通用（环境变量优先），全部键：

| 键 | 必填 | 说明 |
|---|---|---|
| `TRAE_TOKEN` | 选填 | 手动指定单账号 token；留空则自动读取本机 Trae 登录态 |
| `TRAE_TOKENS` | 选填 | 多账号，逗号分隔，支持命名：`主号=token1,小号=token2` |
| `CHECKIN_MAX_DELAY` | 否 | 启动随机延迟上限秒数（默认 0，定时任务建议 600） |
| `TRAE_RETRIES` | 否 | 失败重试次数（默认 5） |
| `NOTIFY_ON_SUCCESS` | 否 | 签到成功是否推送**第三方**通知，`1`/`0`（默认 0；成功始终有 Windows 系统通知，第三方仅失败时必推） |
| `SERVERCHAN_KEY` | 否 | [Server酱](https://sct.ftqq.com/) SendKey，推送到微信 |
| `BARK_URL` | 否 | Bark 推送地址，如 `https://api.day.app/你的key` |
| `TG_BOT_TOKEN` | 否 | Telegram Bot Token（需配合 `TG_CHAT_ID`）；推送自动读取系统代理（环境变量 `HTTPS_PROXY` 优先，其次 Windows 系统代理设置），无代理时直连 |
| `TG_CHAT_ID` | 否 | Telegram Chat ID |
| `WEBHOOK_URL` | 否 | 自定义 Webhook，POST JSON `{"title","content"}` |
| `LOG_FILE` | 否 | 日志文件路径 |

## 命令行用法

```bash
python3 trae_checkin.py                  # 正常签到
python3 trae_checkin.py --status-only    # 只查状态，不领取
python3 trae_checkin.py --retries 10     # 失败最多重试 10 次
python3 trae_checkin.py --max-delay 600  # 随机延迟 0~10 分钟后开始
python3 trae_checkin.py --delay 120      # 固定延迟 2 分钟后开始（计划任务触发用）
python3 trae_checkin.py --no-notify      # 本次不推送通知
python3 trae_checkin.py -v               # 调试日志（含接口原始响应）
python3 trae_checkin.py --config /path/to/config.json  # 指定配置文件
```

退出码：`0` 全部成功 / `1` 存在失败 / `2` 配置错误。

## 常见问题

**Q：提示 token 无效或已过期（code 1001）？**
token 有有效期，过期后按上文步骤重新获取一次，更新到 `config.json` 即可。

**Q：提示服务器繁忙（code 9074）？**
高峰期限流，属正常现象。脚本会自动重试；也可把定时任务改到凌晨等低峰时段。

**Q：提示参数错误（code 9004）？**
用 `-v` 参数运行查看接口原始响应，确认 token 是否完整复制（注意不要带上多余空格或换行）。

**Q：签到显示成功但没收到通知？**
检查通知渠道配置是否完整（如 Telegram 需要同时配 `TG_BOT_TOKEN` 和 `TG_CHAT_ID`，国内网络需系统代理在线，TG 推送会自动读取）。

## 文件结构

```
.
├── trae_checkin.py        # 签到脚本（核心，零依赖）
├── config.example.json    # 配置模板（复制为 config.json 使用，config.json 已 gitignore）
├── run_checkin.cmd        # Windows 启动器（双击运行）
├── notify.ps1             # Windows 系统通知（成功 Info / 失败 Error，系统默认提示音，零依赖）
├── run_checkin.sh         # macOS / Linux 启动器
├── TraeCheckin.xml        # Windows 任务计划导入文件（每天 08:00 + 开机补签，触发后延迟 2 分钟）
└── .gitignore             # 忽略 config.json / checkin.log 等本地数据
```

## Windows 定时任务（推荐）

用任务计划程序实现每天自动签到，内置**四层本地容错**，覆盖电脑没开机、签到被中断、程序卡死等情况：

1. 解压到固定目录（如 `C:\trae-checkin\`），配好 `config.json`
2. 编辑 `TraeCheckin.xml`，把 `<Command>` 里的路径改成实际的 `run_checkin.cmd` 完整路径
3. 导入任务（cmd 或 PowerShell，无需管理员）：

```bat
schtasks /create /tn "TraeCheckin" /xml "C:\trae-checkin\TraeCheckin.xml"
```

4. 打开"任务计划程序"找到 `TraeCheckin`，右键"运行"测试一次，检查 `checkin.log`

### 容错机制说明

| 场景 | 保障 |
|---|---|
| 到点没开机 | `StartWhenAvailable`：下次开机登录自动补跑 |
| 08:00 跑到一半断电/关机 | `LogonTrigger`：当天再次开机登录 2 分钟后自动补签（幂等，已签自动跳过） |
| 程序卡死/异常退出 | `RestartOnFailure`：5 分钟后自动重启，最多 3 次 |
| 请求被限流（9074） | 脚本指数退避重试（默认 5 次），重试耗尽才判失败 |

所有触发都带 2 分钟延迟（等网络就绪），且受每日 claim 10 次限额保护，多次触发不会造成风控风险。
签到失败（含重试耗尽）时统一走 `run_checkin.cmd` 的失败通知：系统通知（Error）+ 第三方推送（Server酱/TG 等，TG 自动走系统代理）。

> 本地方案的边界：如果**当天整天**电脑都没开机且没有再次开机补跑的机会，本地无法兜底——
> 签到积分通常当日有效，次日需手动补签或保持开机习惯。

## 免责声明

仅供个人学习使用，签到接口来自 Trae 官方 API。请遵守服务条款，风险自负。
