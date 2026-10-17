"""大模型代理：把 OpenAI 兼容请求转发到厂商 endpoint。

存在的意义有两点：
  1. 绕开浏览器跨域限制——多数国产厂商不允许前端直连；
  2. 密钥只在本机后端流转，不写进项目文档、不同步到任何远端。

后端本身不保存任何 api_key，每次请求由前端带回。
"""
from __future__ import annotations

import json
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.http_client import async_client

router = APIRouter(prefix="/llm", tags=["llm"])

TIMEOUT = 120.0


class Msg(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    base_url: str = Field(..., description="形如 https://api.deepseek.com/v1")
    api_key: str = ""
    model: str
    messages: list[Msg]
    temperature: float | None = 0.3
    max_tokens: int | None = 2048
    # OpenAI o 系列的长度字段（与 max_tokens 二选一）
    max_completion_tokens: int | None = None
    stream: bool = False
    # 厂商特有的思考/推理参数（enable_thinking / reasoning_effort / thinking:{...} 等），原样透传
    extra: dict | None = None


class ProbeBody(BaseModel):
    base_url: str
    api_key: str = ""
    model: str = ""


def _endpoint(base_url: str) -> str:
    b = (base_url or "").strip().rstrip("/")
    if not b:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "base_url 为空")
    if not re.match(r"^https?://", b):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "base_url 必须以 http(s):// 开头")
    return f"{b}/chat/completions"


def _headers(api_key: str, stream: bool = False) -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if stream:
        h["Accept"] = "text/event-stream"
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def _sse_event(obj: dict) -> bytes:
    """把一段内容包成 OpenAI 流式响应的形状，方便前端复用同一套解析。"""
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


async def _iter_upstream(url: str, payload: dict, api_key: str):
    """把上游 SSE 原样透传；出错时改成一条 error 事件，避免前端卡死等不到结束。"""
    try:
        async with async_client(url, TIMEOUT) as cli:
            async with cli.stream(
                "POST", url, json=payload, headers=_headers(api_key, stream=True)
            ) as r:
                if r.status_code != 200:
                    body_text = (await r.aread())[:400]
                    try:
                        detail = body_text.decode("utf-8", "ignore")
                    except Exception:  # noqa: BLE001
                        detail = ""
                    yield _sse_event({"error": f"模型服务返回 {r.status_code}：{detail}"})
                    yield b"data: [DONE]\n\n"
                    return
                async for chunk in r.aiter_bytes():
                    yield chunk
    except httpx.HTTPError as e:
        yield _sse_event({"error": f"无法连接到模型服务：{e}"})
        yield b"data: [DONE]\n\n"


def _no_temperature(model: str) -> bool:
    """这些模型不接受 temperature：o 系列传了直接 400，DeepSeek 思考模式传了不生效。"""
    m = model.strip()
    return bool(re.match(r"^o\d", m, re.I) or re.match(r"deepseek-reasoner|deepseek-v\d", m, re.I))


def _payload_of(body: ChatBody) -> dict:
    """组装上游请求体。

    o 系列不认 temperature，且长度字段叫 max_completion_tokens；
    思考参数各家字段不同，由前端算好后塞进 extra 原样透传。
    """
    payload: dict = {
        "model": body.model,
        "messages": [m.model_dump() for m in body.messages],
        "stream": body.stream,
    }
    if re.match(r"^o\d", body.model.strip(), re.I):
        payload["max_completion_tokens"] = body.max_completion_tokens or body.max_tokens
    else:
        payload["max_tokens"] = body.max_tokens
        if not _no_temperature(body.model):
            payload["temperature"] = body.temperature
    if body.extra:
        payload.update(body.extra)
    return payload


@router.post("/chat")
async def chat(body: ChatBody):
    payload = _payload_of(body)
    url = _endpoint(body.base_url)

    # 流式：原样透传上游 SSE，让前端能逐字渲染（否则长回复会「卡住」很久才出字）
    if body.stream:
        return StreamingResponse(
            _iter_upstream(url, payload, body.api_key),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    try:
        async with async_client(body.base_url, TIMEOUT) as cli:
            r = await cli.post(url, json=payload, headers=_headers(body.api_key))
    except httpx.HTTPError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"无法连接到模型服务：{e}") from e

    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"模型服务返回 {r.status_code}：{r.text[:400]}")

    try:
        data = r.json()
    except json.JSONDecodeError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "模型服务返回的不是 JSON") from e

    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content") or ""
    # DeepSeek 叫 reasoning_content，Anthropic 系叫 reasoning
    reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
    return {
        "content": content,
        "reasoning": reasoning,
        "model": data.get("model", body.model),
        "usage": data.get("usage"),
        # length 表示被 max_tokens 掐断；前端据此提示用户调大，而不是让用户莫名其妙看到半截话
        "finish_reason": choice.get("finish_reason") or "",
    }


@router.post("/test")
async def test(body: ProbeBody):
    """探活：发一条极短消息，顺带尝试列出可用模型。"""
    t0 = time.time()
    payload = {
        "model": body.model or "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 16,
        "stream": False,
    }
    try:
        async with async_client(body.base_url, 30.0) as cli:
            r = await cli.post(_endpoint(body.base_url), json=payload, headers=_headers(body.api_key))
    except httpx.HTTPError as e:
        return {"ok": False, "message": f"无法连接：{e}", "models": []}

    if r.status_code != 200:
        return {"ok": False, "message": f"模型服务返回 {r.status_code}：{r.text[:300]}", "models": []}

    text = ""
    try:
        text = (r.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
    except Exception:  # noqa: BLE001
        text = ""

    models: list[str] = []
    try:
        async with async_client(body.base_url, 20.0) as cli:
            mr = await cli.get(f"{body.base_url.strip().rstrip('/')}/models", headers=_headers(body.api_key))
        if mr.status_code == 200:
            models = [m.get("id") for m in (mr.json().get("data") or []) if m.get("id")]
    except Exception:  # noqa: BLE001
        models = []

    ms = int((time.time() - t0) * 1000)
    return {"ok": True, "message": f"连通正常（{ms}ms）{(text or '')[:40]}", "models": models}


@router.post("/models")
async def models(body: ProbeBody):
    try:
        async with async_client(body.base_url, 30.0) as cli:
            r = await cli.get(f"{body.base_url.strip().rstrip('/')}/models", headers=_headers(body.api_key))
    except httpx.HTTPError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"无法连接：{e}") from e
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"返回 {r.status_code}：{r.text[:300]}")
    try:
        ids = [m.get("id") for m in (r.json().get("data") or []) if m.get("id")]
    except json.JSONDecodeError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "返回的不是 JSON") from e
    return {"models": ids}
