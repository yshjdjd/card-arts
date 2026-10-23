"""MCP 工具桥接接口。

GET  /llm/mcp/tools   列出所有外部 MCP server 提供的工具（已加命名空间）
POST /llm/mcp/call    调用一个带 mcp. 前缀的工具
GET  /llm/mcp/servers 读取已配置的 server 列表
PUT  /llm/mcp/servers 覆写 server 列表（保存后会重连）
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.services.mcp_manager import McpServerConfig, get_mcp_manager

router = APIRouter(prefix="/llm/mcp", tags=["llm-mcp"])


class CallBody(BaseModel):
    tool: str
    arguments: dict = {}


@router.get("/tools")
async def list_tools():
    return await get_mcp_manager().list_tools()


@router.post("/call")
async def call_tool(body: CallBody):
    content = await get_mcp_manager().call_tool(body.tool, body.arguments)
    return {"content": content}


@router.get("/servers")
async def list_servers():
    return {"servers": [s.model_dump() for s in get_mcp_manager().list_servers()]}


class ServersBody(BaseModel):
    servers: list[McpServerConfig]


@router.put("/servers")
async def save_servers(body: ServersBody):
    get_mcp_manager().save_servers(body.servers)
    return {"ok": True, "count": len(body.servers)}
