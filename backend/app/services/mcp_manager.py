"""MCP 客户端宿主：把外部 MCP server 的工具桥接进 CardArts 的智能体。

为什么放在后端：
  - stdio 类型的 MCP server 需要 spawn 子进程，浏览器做不到；
  - server 命令、环境变量（可能含密钥）不该下到前端。

关键坑（mcp 2.x / anyio）：stdio_client 的取消作用域绑定在「创建它的那个
asyncio task」上。FastAPI 每个请求跑在不同 task 里，若把 session 缓存下来
跨请求复用，就会报 "Attempted to exit cancel scope in a different task"
甚至挂死。因此每个 server 用一个专属长驻 task 持有连接，外部调用通过
asyncio.Queue 投递进这个 task，结果用 Future 回传。

这一版先支持 stdio（最常见），HTTP/SSE transport 可后续再加。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel

# backend/app/services/mcp_manager.py → 上两级到项目根，再进 data
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
CONFIG_PATH = DATA_DIR / "mcp_servers.json"

# 注意：function calling 的工具名必须匹配 ^[a-zA-Z0-9_-]+$（OpenAI/方舟等网关
# 都会强校验），所以命名空间不能用点，改用双下划线分隔。
PREFIX = "mcp__"


class McpServerConfig(BaseModel):
    name: str
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    enabled: bool = True


# ---------------- 纯函数（可单测，不碰网络/子进程） ----------------

def namespaced(server: str, tool: str) -> str:
    return f"{PREFIX}{server}__{tool}"


def split_namespaced(full: str) -> tuple[str, str] | None:
    if not full.startswith(PREFIX):
        return None
    rest = full[len(PREFIX):]
    server, _, tool = rest.partition("__")
    if not server or not tool:
        return None
    return server, tool


def flatten_content(result: Any) -> str:
    """把 MCP CallToolResult 拍平成给模型看的文本。"""
    parts: list[str] = []
    for item in getattr(result, "content", None) or []:
        if getattr(item, "type", None) == "text":
            parts.append(getattr(item, "text", ""))
        else:
            parts.append(json.dumps(item, ensure_ascii=False, default=str))
    body = "\n".join(p for p in parts if p)
    if getattr(result, "isError", False):
        return "❌ MCP 工具返回错误：" + (body or "（无详情）")
    return body or "(MCP 工具返回空结果)"


# ---------------- 每个 server 一个长驻连接 task ----------------

class _Connection:
    """专属 task 持有 stdio 连接；外部经队列投递调用。"""

    def __init__(self, cfg: McpServerConfig):
        self.cfg = cfg
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._ready = asyncio.Event()
        self._fail: Exception | None = None
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._serve())

    async def _serve(self) -> None:
        from mcp import ClientSession, StdioServerParameters  # 延迟导入
        from mcp.client.stdio import stdio_client

        try:
            env = {**os.environ, **(self.cfg.env or {})}
            params = StdioServerParameters(command=self.cfg.command, args=list(self.cfg.args), env=env)
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self._ready.set()
                    while True:
                        kind, payload, fut = await self._inbox.get()
                        if kind == "stop":
                            break
                        try:
                            if kind == "tools":
                                fut.set_result(await session.list_tools())
                            elif kind == "call":
                                fut.set_result(await session.call_tool(payload["tool"], payload["args"]))
                            else:
                                fut.set_exception(RuntimeError(f"未知操作 {kind}"))
                        except Exception as e:  # 回传给调用方
                            if not fut.done():
                                fut.set_exception(e)
        except Exception as e:  # 连不上：唤醒所有等待者
            self._fail = e
            self._ready.set()
            self._drain_pending(e)

    def _drain_pending(self, err: Exception) -> None:
        while True:
            try:
                _, _, fut = self._inbox.get_nowait()
                if not fut.done():
                    fut.set_exception(err)
            except asyncio.QueueEmpty:
                break

    async def _invoke(self, kind: str, payload: dict | None = None) -> Any:
        await self._ready.wait()
        if self._fail is not None:
            raise self._fail
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._inbox.put((kind, payload, fut))
        return await fut


class McpManager:
    def __init__(self) -> None:
        self._servers: list[McpServerConfig] = []
        self._conns: dict[str, _Connection] = {}
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            self._servers = [McpServerConfig(**s) for s in data.get("servers", [])]
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            self._servers = []

    def list_servers(self) -> list[McpServerConfig]:
        return list(self._servers)

    def save_servers(self, servers: list[McpServerConfig]) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps({"servers": [s.model_dump() for s in servers]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._servers = servers
        # 配置变了：丢旧连接，下次调用重建
        self._conns.clear()

    def _enabled(self) -> list[McpServerConfig]:
        return [s for s in self._servers if s.enabled and s.command.strip()]

    def _conn(self, cfg: McpServerConfig) -> _Connection:
        conn = self._conns.get(cfg.name)
        if conn is None:
            conn = _Connection(cfg)
            conn.start()
            self._conns[cfg.name] = conn
        return conn

    async def list_tools(self) -> dict[str, Any]:
        tools: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for cfg in self._enabled():
            try:
                resp = await self._conn(cfg)._invoke("tools")
            except Exception as e:  # 单个 server 失败要降级，不影响其他
                errors.append({"server": cfg.name, "error": str(e)})
                continue
            for t in resp.tools:
                tools.append({
                    "name": namespaced(cfg.name, t.name),
                    "description": getattr(t, "description", "") or "",
                    "parameters": getattr(t, "inputSchema", None) or {"type": "object", "properties": {}},
                    "server": cfg.name,
                })
        return {"tools": tools, "errors": errors}

    async def call_tool(self, namespaced_name: str, arguments: dict[str, Any]) -> str:
        routed = split_namespaced(namespaced_name)
        if not routed:
            return f"❌ 不是 MCP 工具：{namespaced_name}"
        server_name, tool = routed
        cfg = next((s for s in self._servers if s.name == server_name), None)
        if cfg is None or not cfg.enabled:
            return f"❌ MCP server「{server_name}」未配置或已停用"
        try:
            result = await self._conn(cfg)._invoke("call", {"tool": tool, "args": arguments or {}})
        except Exception as e:  # noqa: BLE001
            return f"❌ 调用 MCP 工具失败：{e}"
        return flatten_content(result)


_manager: McpManager | None = None


def get_mcp_manager() -> McpManager:
    global _manager
    if _manager is None:
        _manager = McpManager()
    return _manager
