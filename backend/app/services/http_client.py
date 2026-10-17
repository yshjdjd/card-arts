"""统一的出站 HTTP 客户端。

为什么要单独封装：httpx 默认 `trust_env=True`，会读取系统 HTTP_PROXY。
公司网络里这没问题，但会把 **本机地址**（Ollama 的 localhost:11434、自建网关、
测试用的假服务）也送进代理，直接 connection refused。

这里的策略：
  * 本机 / 内网 —— 强制直连，无视任何代理；
  * 外网 —— 跟随代理（CARDARTS_HTTP_PROXY > HTTPS_PROXY > HTTP_PROXY），没有就直连。
"""
from __future__ import annotations

import os
import re

import httpx

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1", "0.0.0.0")


def outbound_proxy() -> str | None:
    for k in ("CARDARTS_HTTP_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        v = (os.getenv(k) or "").strip()
        if v:
            return v
    return None


def is_local(url: str) -> bool:
    m = re.match(r"^https?://(\[[^\]]+\]|[^/:]+)", url or "")
    host = (m.group(1) if m else "").lower().strip("[]")
    if host in LOCAL_HOSTS:
        return True
    if re.match(r"^10\.", host) or re.match(r"^192\.168\.", host):
        return True
    m2 = re.match(r"^172\.(\d+)\.", host)
    return bool(m2 and 16 <= int(m2.group(1)) <= 31)


def async_client(url: str = "", timeout: float = 30.0, **kw) -> httpx.AsyncClient:
    """按目标地址创建的 AsyncClient（本机一律绕开代理）。"""
    if url and is_local(url):
        return httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False, **kw)
    return httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        proxy=outbound_proxy(),
        trust_env=False,
        **kw,
    )
