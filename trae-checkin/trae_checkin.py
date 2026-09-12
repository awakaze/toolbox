#!/usr/bin/env python3
"""
Trae CN (TraeWork) 每日自动签到脚本
====================================

接口来源：Trae 官方论坛社区验证（api.trae.cn 签到领积分接口），每日签到可领 200 积分。

零第三方依赖（仅 Python 标准库），支持：
  - 单账号 / 多账号批量签到
  - 签到前状态查询，已签到自动跳过，签到后自动复查确认
  - 失败重试（指数退避 + 随机抖动），针对服务器限流（code 9074）做了优化
  - 每日领取请求上限（默认 10 次/天，状态查询不计入），防止账户被风控
  - 随机延迟启动，避开整点高峰期
  - 通知推送：Server酱 / Bark / Telegram / 自定义 Webhook
  - token 脱敏日志、日志文件、退出码（方便 cron / CI 判断结果）

配置方式（二选一）
------------------
1. 配置文件：复制 config.example.json 为 config.json（与脚本同目录），填入配置即可，
   适合部署在自己电脑上，配合 run_checkin.cmd / run_checkin.sh 双击或定时运行。
2. 环境变量：适合服务器 / CI。环境变量优先级高于配置文件。

环境变量（也可作为 config.json 的键）
------------------------------------
TRAE_TOKEN            单个账号的 access token（必填之一）
TRAE_TOKENS           多账号，逗号或换行分隔，支持 "名字=token" 格式，例如：
                      主号=eyJxxx,小号=eyJyyy
CHECKIN_MAX_DELAY     启动后随机延迟秒数上限（默认 0，定时任务建议设 300）
NOTIFY_ON_SUCCESS     成功时是否推送第三方通知，1/0（默认 0）。
                      成功始终弹 Windows 系统通知；第三方（Server酱/TG 等）仅失败时必推
SERVERCHAN_KEY        Server酱 Turbo 的 SendKey（可选）
BARK_URL              Bark 推送地址，如 https://api.day.app/xxxxxxxx（可选）
TG_BOT_TOKEN          Telegram Bot Token（可选，需配合 TG_CHAT_ID）
TG_CHAT_ID            Telegram Chat ID（可选）
WEBHOOK_URL           自定义 Webhook 地址，POST JSON {"title", "content"}（可选）
LOG_FILE              日志文件路径（可选，也可用 --log-file）

token 获取方式
--------------
默认自动读取本机 Trae IDE 登录态（`iCubeAuthInfo://icube.cloudide`，配合
Authorization scheme `Cloud-IDE-JWT`），无需手动配置。仅当自动读取不可用
时才需要手动配置 token：浏览器登录 https://www.trae.cn ，F12 打开开发者工具
-> Network，任意找一个发往 api.trae.cn 的请求，复制请求头 Authorization 中
`Cloud-IDE-JWT` 后面的部分。

用法
----
  python3 trae_checkin.py                 # 正常签到
  python3 trae_checkin.py --status-only   # 只查询签到状态
  python3 trae_checkin.py --retries 10    # 失败最多重试 10 次
  python3 trae_checkin.py -v              # 输出调试日志（含原始响应）

退出码：0 = 所有账号均已签到；1 = 存在失败账号；2 = 配置错误
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

API_BASE = "https://api.trae.cn/trae/api/v2/ug/checkin_credits"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# 服务端已知业务码
CODE_OK = 0
CODE_UNAUTHORIZED = 1001      # 未认证 / token 失效
CODE_PARAM_ERROR = 9004       # 参数错误
CODE_SERVER_BUSY = 9074       # 服务器繁忙 / 限流，需要重试

# 每日领取（claim）请求上限：含所有重试，跨多次运行累计；状态查询不计入。
# 超出后当天停止发起领取，防止账户被风控。
CLAIM_DAILY_LIMIT = 10
CLAIM_STATE_FILE = Path.home() / ".trae-checkin" / "claim_state.json"

log = logging.getLogger("trae-checkin")


# --------------------------------------------------------------------------- #
# 本机 Trae IDE 登录态自动解密（tc/icube 加密格式，逆向自 byteCrypto.js）
# 可选：依赖 pycryptodome，未安装时自动跳过，退回使用配置 token。
# 固定 64 字节派生数组 + 6 字节头部 + SHA-512 完整性校验。
# --------------------------------------------------------------------------- #
_TC_HEADER = b"\x74\x63\x05\x10\x00\x00"
_TC_IJ = bytes([
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
    124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
    84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
    8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
_TC_RJ = bytes([
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
    96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
    160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
    23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])
_TC_FIXED_A = bytes(a ^ b for a, b in zip(_TC_IJ, _TC_RJ))
_TC_AUTH_KEY = "iCubeAuthInfo://icube.cloudide"
_TRAE_STORAGE_CANDIDATES = (
    ("Trae CN", "User", "globalStorage", "storage.json"),
    ("TRAE SOLO CN", "User", "globalStorage", "storage.json"),
)


def _decrypt_tc_blob(b64_blob: str) -> dict:
    """解密 iCubeAuthInfo://icube.cloudide 加密登录态，返回明文 JSON 对象。"""
    from Crypto.Cipher import AES
    enc = base64.b64decode(b64_blob)
    if len(enc) < 38 or enc[:6] != _TC_HEADER:
        raise ValueError("不是 icube tc 加密格式")
    enc_key = enc[6:38]                                    # 32 字节随机密钥
    h1 = hashlib.sha512(enc_key).digest()
    h2 = hashlib.sha512(h1 + _TC_FIXED_A).digest()
    aes_key, iv = h2[:16], h2[16:32]                       # AES-128 密钥, IV
    dec = AES.new(aes_key, AES.MODE_CBC, iv).decrypt(enc[38:])
    dec = dec[:-dec[-1]]
    stored_hash, plain = dec[:64], dec[64:]
    if stored_hash != hashlib.sha512(plain).digest():
        raise ValueError("完整性校验失败，密钥或数据可能已变化")
    return json.loads(plain.decode("utf-8"))


def read_local_trae_token() -> tuple[str, str]:
    """从本机 Trae IDE 登录态解密出 (access token, userRegion)；失败时返回 ('', '')。"""
    try:
        from Crypto.Cipher import AES  # noqa: F401 - 仅探测依赖
    except ImportError:
        log.info("未安装 pycryptodome，跳过自动读取本机登录态（可 pip install pycryptodome）")
        return "", ""
    base = os.environ.get("APPDATA", "")
    for sub in _TRAE_STORAGE_CANDIDATES:
        path = Path(base).joinpath(*sub) if base else None
        if not path or not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            blob = data.get(_TC_AUTH_KEY)
            if not blob:
                continue
            auth = _decrypt_tc_blob(blob)
            token = str(auth.get("token", "")).strip()
            if token:
                region = str((auth.get("userRegion") or {}).get("region", "")).strip()
                log.info("已从本机 Trae IDE 登录态自动读取 token（%s）", sub[0])
                return token, region
        except Exception as exc:  # noqa: BLE001 - 当前候选读取失败，继续下一个
            log.warning("读取 %s 登录态失败: %s", sub[0], exc)
    return "", ""


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
@dataclass
class Account:
    name: str
    token: str
    region: str = ""  # X-User-Region，自动读取本机登录态时从 userRegion 提取

    @property
    def masked_token(self) -> str:
        t = self.token
        return f"{t[:6]}...{t[-4:]}" if len(t) > 12 else "***"


def parse_accounts() -> list[Account]:
    """从 TRAE_TOKEN / TRAE_TOKENS 解析账号列表。"""
    raw_items: list[str] = []
    single = os.environ.get("TRAE_TOKEN", "").strip()
    if single:
        raw_items.append(single)
    multi = os.environ.get("TRAE_TOKENS", "")
    for chunk in multi.replace("\n", ",").split(","):
        chunk = chunk.strip()
        if chunk:
            raw_items.append(chunk)

    accounts: list[Account] = []
    for i, item in enumerate(raw_items, 1):
        if "=" in item:
            name, token = item.split("=", 1)
            name, token = name.strip(), token.strip()
        else:
            name, token = f"账号{i}", item
        if not token:
            continue
        # 允许用户直接粘贴完整的 Authorization 头
        token_prefix = token.lower().split(" ", 1)[0]
        if token_prefix in ("bearer", "cloud-ide-jwt"):
            token = token.split(" ", 1)[1].strip()
        accounts.append(Account(name=name or f"账号{i}", token=token))
    if accounts:
        return accounts
    # 无手动配置 token 时，自动读取本机 Trae IDE 登录态（可选，依赖 pycryptodome）
    auto_token, auto_region = read_local_trae_token()
    if auto_token:
        return [Account(name="本地登录账号", token=auto_token, region=auto_region)]
    return accounts


def jwt_expiry(token: str) -> float | None:
    """若 token 是 JWT，解析 exp（秒级时间戳）；否则返回 None。不校验签名。"""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
        exp = data.get("exp")
        return float(exp) if exp else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def check_token_expiry(acc: Account, warn_days: float = 3.0) -> None:
    """已过期则抛 ApiError；即将过期仅打警告。非 JWT 静默跳过。"""
    exp = jwt_expiry(acc.token)
    if exp is None:
        log.debug("%s 的 token 不是 JWT，跳过有效期检测", acc.name)
        return
    remaining = exp - time.time()
    expire_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp))
    if remaining <= 0:
        raise ApiError(f"token 已于 {expire_at} 过期，请重新获取", retryable=False)
    if remaining < warn_days * 86400:
        log.warning("%s 的 token 将在 %.1f 天后过期（%s），请留意更新",
                    acc.name, remaining / 86400, expire_at)
    else:
        log.info("%s 的 token 有效期剩余 %.1f 天", acc.name, remaining / 86400)


def load_config(path: str | None) -> None:
    """从 JSON 配置文件加载配置到环境变量（已有环境变量优先，不覆盖）。"""
    cfg_path = Path(path) if path else Path(__file__).resolve().with_name("config.json")
    if not cfg_path.is_file():
        return
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.error("配置文件 %s 解析失败: %s", cfg_path, exc)
        return
    if not isinstance(data, dict):
        log.error("配置文件 %s 格式错误：顶层必须是 JSON 对象", cfg_path)
        return
    loaded = 0
    for key, value in data.items():
        if value is None or value == "" or key in os.environ:
            continue
        os.environ[key] = str(value)
        loaded += 1
    if loaded:
        log.info("已从 %s 加载 %d 项配置", cfg_path, loaded)


# --------------------------------------------------------------------------- #
# HTTP 与签到逻辑
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class TraeClient:
    token: str
    region: str = ""
    timeout: int = 15

    def _post(self, path: str, data: dict | None = None) -> dict:
        url = f"{API_BASE}/{path}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Cloud-IDE-JWT {self.token}",
            "User-Agent": USER_AGENT,
        }
        if self.region:
            headers["X-User-Region"] = self.region
        payload = json.dumps(data if data is not None else {}).encode()
        req = urllib.request.Request(url, data=payload, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            retryable = exc.code >= 500 or exc.code == 429
            raise ApiError(f"HTTP {exc.code}: {body[:200]}", retryable=retryable) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ApiError(f"网络错误: {exc}", retryable=True) from exc

        log.debug("POST %s 原始响应: %s", path, body[:500])
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise ApiError(f"响应不是合法 JSON: {body[:200]}", retryable=True)
        if not isinstance(data, dict):
            raise ApiError(f"响应格式异常: {body[:200]}", retryable=True)
        return data

    def status(self) -> dict:
        # 对齐官方实现：POST 统一带 req_source（Trae CN=1，SOLO Lite=2）
        return self._post("status", {"req_source": 1})

    def claim(self) -> dict:
        # 领取接口要求 req_source，否则返回 code 9004（订单参数不正确）
        return self._post("claim", {"req_source": 1})


def interpret_status(data: dict) -> tuple[bool | None, bool, str]:
    """解析状态接口返回，返回 (是否已签到, 活动是否开启, 描述信息)。"""
    code = data.get("code")
    if code == CODE_UNAUTHORIZED:
        raise ApiError("token 无效或已过期（code 1001），请重新获取", retryable=False)
    if code == CODE_PARAM_ERROR:
        raise ApiError("参数错误（code 9004），请用 -v 查看原始响应排查", retryable=False)
    if code == CODE_SERVER_BUSY:
        raise ApiError("服务器繁忙/限流（code 9074）", retryable=True)
    if code not in (CODE_OK, None):
        raise ApiError(f"状态查询返回 code={code}: {data.get('message', '')}", retryable=True)

    checked_in = data.get("checked_in")
    enable = data.get("enable")
    extras = []
    for key in ("credits", "today_credits", "total_credits", "expected_credits", "balance"):
        if key in data:
            extras.append(f"{key}={data[key]}")
    if enable is False:
        extras.append("enable=false（活动未开启）")
    return (checked_in if isinstance(checked_in, bool) else None), (enable is not False), " ".join(extras)


def interpret_claim(data: dict) -> str:
    """解析领取接口返回，失败时抛 ApiError。"""
    code = data.get("code")
    message = str(data.get("message", ""))
    if code == CODE_OK or "success" in message.lower():
        # 参考实现：积分可能位于顶层 credits 或 data.credits
        credits = (data.get("credits") or data.get("today_credits")
                   or (data.get("data") or {}).get("credits") or "")
        return f"领取成功 {('+' + str(credits) + ' 积分') if credits else ''}".strip()
    if code == CODE_UNAUTHORIZED:
        raise ApiError("token 无效或已过期（code 1001），请重新获取", retryable=False)
    if code == CODE_SERVER_BUSY:
        raise ApiError("服务器繁忙/限流（code 9074）", retryable=True)
    if "already" in message.lower() or "重复" in message:
        return "今日已领取过（服务端返回重复签到）"
    raise ApiError(f"领取失败 code={code}: {message or data}", retryable=True)


def load_claim_count() -> int:
    """读取今日已发起的 claim 请求次数（按日期滚动，跨运行累计）。"""
    today = time.strftime("%Y-%m-%d")
    try:
        data = json.loads(CLAIM_STATE_FILE.read_text(encoding="utf-8"))
        if data.get("date") == today:
            return int(data.get("claims", 0))
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        pass
    return 0


def bump_claim_count() -> int:
    """计数 +1 并持久化；返回累计值。发起请求前调用（无论请求是否成功都算一次）。"""
    count = load_claim_count() + 1
    try:
        CLAIM_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CLAIM_STATE_FILE.write_text(
            json.dumps({"date": time.strftime("%Y-%m-%d"), "claims": count}),
            encoding="utf-8",
        )
    except OSError as exc:
        log.warning("领取计数写入失败（本次运行内仍有效，不影响签到）: %s", exc)
    return count


def _claim_with_limit(client: TraeClient) -> str:
    """带每日限额的领取：每次发起 claim 前计数，超限（防风控）则当天停止。"""
    used = load_claim_count()
    if used >= CLAIM_DAILY_LIMIT:
        raise ApiError(
            f"今日 claim 请求已达上限（{used}/{CLAIM_DAILY_LIMIT} 次，防风控），当天不再发起",
            retryable=False)
    log.info("发起领取请求（今日第 %d/%d 次）", used + 1, CLAIM_DAILY_LIMIT)
    bump_claim_count()
    return interpret_claim(client.claim())


def with_retry(func, retries: int, base_delay: float, desc: str):
    """对可重试错误做指数退避 + 抖动重试。"""
    for attempt in range(1, retries + 2):  # 首次 + retries 次重试
        try:
            return func()
        except ApiError as exc:
            if not exc.retryable or attempt > retries:
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), 120) + random.uniform(0, 8)
            log.warning("%s失败（第 %d 次）: %s，%.0f 秒后重试", desc, attempt, exc, delay)
            time.sleep(delay)
    return None  # 理论不可达


# --------------------------------------------------------------------------- #
# 通知
# --------------------------------------------------------------------------- #
def _get_system_proxy() -> str:
    """读取系统代理，返回 http://host:port；未找到返回 ''。

    优先级：环境变量 > Windows 注册表（IE/系统代理设置）。
    """
    for var in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
                "HTTP_PROXY", "http_proxy"):
        val = os.environ.get(var, "").strip()
        if val:
            return val if "://" in val else f"http://{val}"
    if sys.platform == "win32":
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if not enabled:
                return ""
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
            if not server:
                return ""
            if "=" not in server:               # 形如 127.0.0.1:7890
                return f"http://{server}"
            parts = dict(p.split("=", 1) for p in server.split(";") if "=" in p)
            target = parts.get("https") or parts.get("http")
            return f"http://{target}" if target else ""
        except OSError:                          # 注册表不可读时直连
            pass
    return ""


def _http_post_form(url: str, data: dict, proxy: str = "") -> bytes:
    """POST 表单并返回响应体；proxy 非空时通过该代理发送。"""
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode(),
        method="POST",
        headers={"User-Agent": USER_AGENT},
    )
    if proxy:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        with opener.open(req, timeout=15) as resp:
            return resp.read()
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def _http_get(url: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15):
        pass


def send_notifications(title: str, content: str) -> None:
    """按环境变量配置依次尝试各通知渠道，单渠道失败不影响其他渠道。"""
    channels = []

    key = os.environ.get("SERVERCHAN_KEY", "").strip()
    if key:
        def _serverchan() -> None:
            body = _http_post_form(
                f"https://sctapi.ftqq.com/{key}.send", {"title": title, "desp": content})
            # Server酱业务失败也返回 HTTP 200，必须检查响应体 code
            result = json.loads(body.decode("utf-8", errors="replace"))
            if result.get("code") != 0:
                raise RuntimeError(f"code={result.get('code')}: {result.get('message', '')}")
        channels.append(("Server酱", _serverchan))

    bark = os.environ.get("BARK_URL", "").strip().rstrip("/")
    if bark:
        channels.append(("Bark", lambda: _http_get(
            f"{bark}/{urllib.parse.quote(title)}/{urllib.parse.quote(content)}")))

    tg_token = os.environ.get("TG_BOT_TOKEN", "").strip()
    tg_chat = os.environ.get("TG_CHAT_ID", "").strip()
    if tg_token and tg_chat:
        def _telegram() -> None:
            # 国内直连 TG 通常不通，自动读取系统代理（环境变量 / Windows 注册表）
            proxy = _get_system_proxy()
            if proxy:
                log.info("Telegram 推送使用系统代理 %s", proxy)
            body = _http_post_form(
                f"https://api.telegram.org/bot{tg_token}/sendMessage",
                {"chat_id": tg_chat, "text": f"{title}\n\n{content}"}, proxy=proxy)
            # TG 业务失败时 HTTP 也可能是 4xx（已被 urlopen 抛出），这里再校验响应体 ok 字段
            result = json.loads(body.decode("utf-8", errors="replace"))
            if not result.get("ok"):
                raise RuntimeError(f"{result.get('error_code')}: {result.get('description', '')}")
        channels.append(("Telegram", _telegram))

    webhook = os.environ.get("WEBHOOK_URL", "").strip()
    if webhook:
        def _webhook() -> None:
            req = urllib.request.Request(
                webhook,
                data=json.dumps({"title": title, "content": content}).encode(),
                method="POST",
                headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            )
            with urllib.request.urlopen(req, timeout=15):
                pass
        channels.append(("Webhook", _webhook))

    for name, sender in channels:
        try:
            sender()
            log.info("通知已推送 [%s]", name)
        except Exception as exc:  # noqa: BLE001 - 通知失败不应影响主流程
            log.warning("通知推送失败 [%s]: %s", name, exc)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
@dataclass
class AccountResult:
    account: Account
    ok: bool
    detail: str = ""
    attempts: list[str] = field(default_factory=list)


def process_account(acc: Account, args) -> AccountResult:
    client = TraeClient(token=acc.token, region=acc.region, timeout=args.timeout)
    result = AccountResult(account=acc, ok=False)
    log.info("── %s（token: %s）", acc.name, acc.masked_token)

    try:
        check_token_expiry(acc)
        status, enabled, extras = with_retry(
            lambda: interpret_status(client.status()),
            args.retries, args.base_delay, "状态查询")
        log.info("签到状态: %s %s", "已签到" if status else "未签到", extras)

        if status is True:
            result.ok = True
            result.detail = f"今日已签到，跳过 {extras}".strip()
            return result

        if enabled is False:
            # 与参考实现一致：活动未开启时直接跳过，不请求领取接口
            result.ok = True
            result.detail = f"签到活动未开启，跳过领取 {extras}".strip()
            return result

        if args.status_only:
            result.ok = True
            result.detail = f"未签到（仅查询模式，未领取）{extras}".strip()
            return result

        claim_msg = with_retry(
            lambda: _claim_with_limit(client),
            args.retries, args.base_delay, "领取积分")
        log.info("领取结果: %s", claim_msg)

        # 领取后复查状态确认
        try:
            new_status, _, new_extras = with_retry(
                lambda: interpret_status(client.status()),
                1, args.base_delay, "复查状态")
            if new_status is True:
                result.ok = True
                result.detail = f"签到成功，{claim_msg} {new_extras}".strip()
            else:
                result.detail = f"领取接口返回成功，但复查状态为未签到 {new_extras}".strip()
        except ApiError:
            # 复查失败但领取接口明确成功，按成功处理
            result.ok = True
            result.detail = f"签到成功，{claim_msg}（复查失败，请以明日状态为准）"
        return result

    except ApiError as exc:
        result.detail = f"失败: {exc}"
        log.error("%s 签到失败: %s", acc.name, exc)
        return result


def setup_logging(verbose: bool, log_file: str | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
        except OSError as exc:
            print(f"警告: 无法写入日志文件 {log_file}: {exc}", file=sys.stderr)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trae CN 每日自动签到（零依赖，直接运行）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--status-only", action="store_true",
                        help="只查询签到状态，不执行领取")
    parser.add_argument("--retries", type=int, default=None,
                        help="失败重试次数（默认 5，env: TRAE_RETRIES）")
    parser.add_argument("--base-delay", type=float, default=10.0,
                        help="重试基础间隔秒数，指数退避（默认 10）")
    parser.add_argument("--timeout", type=int, default=15,
                        help="单次请求超时秒数（默认 15）")
    parser.add_argument("--max-delay", type=int, default=None,
                        help="启动后随机延迟上限秒数（默认 0，env: CHECKIN_MAX_DELAY）")
    parser.add_argument("--delay", type=int, default=0,
                        help="启动前固定延迟秒数（任务计划触发用，开机补跑建议 120）")
    parser.add_argument("--log-file", default=None,
                        help="日志文件路径（env: LOG_FILE）")
    parser.add_argument("--config", default="",
                        help="配置文件路径（默认读取脚本同目录的 config.json）")
    parser.add_argument("--no-notify", action="store_true", help="禁用通知推送")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    # 必须先加载 config.json（写入环境变量），再解析依赖 env 的默认值，
    # 否则配置文件中的 TRAE_RETRIES / CHECKIN_MAX_DELAY / LOG_FILE 不生效
    load_config(args.config or None)
    if args.retries is None:
        args.retries = int(os.environ.get("TRAE_RETRIES", "5"))
    if args.max_delay is None:
        args.max_delay = int(os.environ.get("CHECKIN_MAX_DELAY", "0"))
    if args.log_file is None:
        args.log_file = os.environ.get("LOG_FILE", "")
    setup_logging(args.verbose, args.log_file or None)

    accounts = parse_accounts()
    if not accounts:
        log.error("未找到可用账号：本机 Trae IDE 登录态读取失败，且未通过环境变量 TRAE_TOKEN / TRAE_TOKENS 或 config.json 配置")
        log.error("token 获取方式：浏览器登录 https://www.trae.cn ，F12 -> Network -> "
                  "复制 api.trae.cn 请求头 Authorization 中 Cloud-IDE-JWT 后面的内容")
        return 2

    if args.delay > 0:
        log.info("固定延迟 %d 秒后开始签到...", args.delay)
        time.sleep(args.delay)
    if args.max_delay > 0:
        delay = random.uniform(0, args.max_delay)
        log.info("随机延迟 %.0f 秒以避开高峰期...", delay)
        time.sleep(delay)

    log.info("共 %d 个账号，开始%s", len(accounts),
             "查询状态" if args.status_only else "签到")

    results: list[AccountResult] = []
    for acc in accounts:
        results.append(process_account(acc, args))

    # 汇总
    log.info("══════════ 签到结果汇总 ══════════")
    for r in results:
        log.info("  [%s] %s - %s", "OK" if r.ok else "FAIL", r.account.name, r.detail)
    failed = [r for r in results if not r.ok]
    log.info("成功 %d / %d", len(results) - len(failed), len(results))

    # 通知
    if not args.no_notify:
        notify_on_success = os.environ.get("NOTIFY_ON_SUCCESS", "0") != "0"
        if failed or notify_on_success:
            title = "Trae 签到" + ("有失败" if failed else "成功")
            content = "\n".join(
                f"{'✅' if r.ok else '❌'} {r.account.name}: {r.detail}" for r in results)
            send_notifications(title, content)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
