"""CardArts MCP Server。

相对原项目的升级
----------------
原实现：浏览器内置一个 OpenAI 兼容客户端，把 40 个工具塞进一次
Chat Completions 请求里，工具只能被这一个应用使用。

新实现：把同样的能力做成标准 **MCP Server**，于是
  * 任何 MCP 客户端（Claude Desktop / Cursor / 自建 Web 前端）都能驱动项目；
  * 用 **Resources** 承载大块只读上下文（项目概览、牌组版式），
    替代"读一次就吃掉几万 token"的 get_* 工具；
  * 用 **Prompts** 固化编辑工作流（先读后写、破坏性操作先备份）；
  * 工具按 read / write / destructive 三级标注，destructive 需要显式确认令牌。

启动：
    python -m app.mcp.server               # stdio（默认，给桌面客户端用）
    MCP_TRANSPORT=sse python -m app.mcp.server
    MCP_TRANSPORT=streamable-http python -m app.mcp.server
"""
from __future__ import annotations

import asyncio
import json
import os

from mcp.server.mcpserver import MCPServer

from app.core.config import get_settings
from app.db.session import session_scope
from app.mcp import repository as repo

SERVER_NAME = "card_arts"

SYSTEM_GUIDANCE = """你是 CardArts 的桌游创作智能体。

核心规则（必须遵守）：
1. 编辑前必须先读取相关项目，绝不能凭空编造内容。
2. 不能删除内置字段（name / count），不能编造 game-icons 图标 id —— 需要图标先调用 search_icons。
3. 破坏性或多步骤编辑前，先调用 create_version 创建临时版本；
   智能体创建的临时版本统一使用中文前缀「智能体备份」。
4. 用户检查结果期间应保留临时版本，绝不能静默删除备份；
   只有用户明确确认结果可接受后才能清理。
5. 仅为同一种卡牌做小幅视觉差异时应留在同一牌组；
   只有类型差异明显才新建牌组。
6. 富文本与版式编辑使用「精确搜索替换」（find/replace），
   且目标片段必须在原文中唯一，否则先读取更长的上下文。
7. 使用用户的语言回答。
"""


def build_server() -> MCPServer:
    mcp = MCPServer(name=SERVER_NAME, instructions=SYSTEM_GUIDANCE, version="0.1.0")

    # ------------------------------------------------------------ 只读工具

    @mcp.tool(
        name="list_projects",
        description="列出可访问的项目（id、名称、牌组数、卡牌数、更新时间）",
    )
    async def list_projects() -> str:
        async with session_scope() as s:
            from app.services import sync_service

            rows = await sync_service.list_projects(s)
            return json.dumps(
                [
                    {
                        "id": p.id, "name": p.name, "revision": p.revision,
                        "deck_count": p.deck_count, "card_count": p.card_count,
                        "updated_at": p.updated_at.isoformat(),
                    }
                    for p in rows
                ],
                ensure_ascii=False,
            )

    @mcp.tool(name="list_decks", description="列出指定项目的牌组及卡牌数量")
    async def list_decks(project_id: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.list_decks(s, project_id), ensure_ascii=False)

    @mcp.tool(name="list_cards", description="分页列出指定牌组中的卡牌")
    async def list_cards(project_id: str, deck_id: str, offset: int = 0, limit: int = 50) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.list_cards(s, project_id, deck_id, offset=offset, limit=min(limit, 200)),
                ensure_ascii=False,
            )

    @mcp.tool(name="get_fields", description="读取牌组的字段定义（名称、类型、允许值）")
    async def get_fields(project_id: str, deck_id: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.get_fields(s, project_id, deck_id), ensure_ascii=False)

    @mcp.tool(name="get_layout", description="读取牌组正面或背面版式的完整定义")
    async def get_layout(project_id: str, deck_id: str, side: str = "front") -> str:
        async with session_scope() as s:
            return json.dumps(await repo.get_layout(s, project_id, deck_id, side), ensure_ascii=False)

    @mcp.tool(name="list_documents", description="列出项目文档及更新时间")
    async def list_documents(project_id: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.list_documents(s, project_id), ensure_ascii=False)

    @mcp.tool(name="list_assets", description="列出项目素材（图片/字体）的元数据")
    async def list_assets(project_id: str, kind: str | None = None) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.list_assets(s, project_id, kind), ensure_ascii=False)

    @mcp.tool(name="find_asset_usage", description="查找引用指定素材的卡牌字段与版式元素（删除素材前必查）")
    async def find_asset_usage(project_id: str, asset_id: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.find_asset_usage(s, project_id, asset_id), ensure_ascii=False)

    @mcp.tool(name="search_icons", description="按名称或作者搜索 game-icons 图标，返回可直接使用的 id")
    async def search_icons(query: str, limit: int = 20) -> str:
        from app.services.icon_catalog import search

        return json.dumps(search(query, limit=min(limit, 100)), ensure_ascii=False)

    @mcp.tool(name="list_fonts", description="列出系统字体与项目上传的字体，返回可用于 set_font 的 key")
    async def list_fonts(project_id: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.list_fonts(s, project_id), ensure_ascii=False)

    @mcp.tool(name="set_font", description="设定文字字体。font 必须来自 list_fonts；不提供 deck_id 时作用于整个项目，element_id 需同时指定 deck_id 和 side")
    async def set_font(project_id: str, font: str, deck_id: str | None = None, side: str = "both", element_id: str | None = None, set_default: bool = False) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.set_font(s, project_id, font, deck_id=deck_id, side=side, element_id=element_id, set_default=set_default), ensure_ascii=False)

    @mcp.tool(name="get_layout_help", description="读取版式格式说明：元素类型、字段绑定与显示条件的写法")
    async def get_layout_help() -> str:
        return LAYOUT_HELP

    # ------------------------------------------------------------ 写入工具

    @mcp.tool(name="create_deck", description="创建带有默认字段（名称/数量）的新牌组")
    async def create_deck(project_id: str, name: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.create_deck(s, project_id, name), ensure_ascii=False)

    @mcp.tool(name="rename_deck", description="修改指定牌组的名称")
    async def rename_deck(project_id: str, deck_id: str, name: str) -> str:
        async with session_scope() as s:
            return json.dumps(await repo.rename_deck(s, project_id, deck_id, name), ensure_ascii=False)

    @mcp.tool(name="create_card", description="在指定牌组中创建一张卡牌，values 的键必须是已定义的字段 id")
    async def create_card(project_id: str, deck_id: str, values: str) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.create_card(s, project_id, deck_id, json.loads(values)), ensure_ascii=False
            )

    @mcp.tool(name="update_card", description="更新指定卡牌的字段值（merge=true 时按字段合并）")
    async def update_card(project_id: str, deck_id: str, card_id: str, values: str, merge: bool = True) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.update_card(s, project_id, deck_id, card_id, json.loads(values), merge=merge),
                ensure_ascii=False,
            )

    @mcp.tool(
        name="create_field",
        description="在牌组末尾创建一个共享字段。type 取 text/number/image/select/color/boolean 之一",
    )
    async def create_field(project_id: str, deck_id: str, name: str, type_: str, options: str | None = None) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.create_field(
                    s, project_id, deck_id, name=name, type_=type_,
                    options=json.loads(options) if options else None,
                ),
                ensure_ascii=False,
            )

    @mcp.tool(name="patch_layout", description="通过精确搜索替换局部编辑牌组正面或背面版式")
    async def patch_layout(project_id: str, deck_id: str, side: str, find: str, replace: str) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.patch_layout(s, project_id, deck_id, side, find=find, replace=replace),
                ensure_ascii=False,
            )

    @mcp.tool(name="update_document", description="通过精确搜索替换局部编辑项目文档内容")
    async def update_document(project_id: str, doc_id: str, find: str, replace: str) -> str:
        async with session_scope() as s:
            return json.dumps(
                await repo.update_document(s, project_id, doc_id, find=find, replace=replace),
                ensure_ascii=False,
            )

    @mcp.tool(name="create_version", description="创建包含项目和全部素材的不可变版本（破坏性操作前务必先调用）")
    async def create_version(project_id: str, name: str = "智能体备份") -> str:
        async with session_scope() as s:
            v = await repo.create_version(s, project_id, name)
            return json.dumps(
                {"id": v.id, "name": v.name, "base_revision": v.base_revision}, ensure_ascii=False
            )

    # ------------------------------------------------------------ 破坏性工具

    @mcp.tool(
        name="delete_card",
        description="[破坏性] 从指定牌组中永久删除一张卡牌。需先 create_version，并传入 confirm=true",
    )
    async def delete_card(project_id: str, deck_id: str, card_id: str, confirm: bool = False) -> str:
        if not confirm:
            return json.dumps({"error": "需要 confirm=true 且建议先 create_version"}, ensure_ascii=False)
        async with session_scope() as s:
            await repo.delete_card(s, project_id, deck_id, card_id)
            return json.dumps({"ok": True, "deleted": card_id})

    @mcp.tool(
        name="delete_deck",
        description="[破坏性] 删除指定牌组及其中全部卡牌。项目至少保留一个牌组。需 confirm=true",
    )
    async def delete_deck(project_id: str, deck_id: str, confirm: bool = False) -> str:
        if not confirm:
            return json.dumps({"error": "需要 confirm=true 且建议先 create_version"}, ensure_ascii=False)
        async with session_scope() as s:
            await repo.delete_deck(s, project_id, deck_id)
            return json.dumps({"ok": True, "deleted": deck_id})

    @mcp.tool(name="delete_field", description="[破坏性] 从牌组及其中所有卡牌删除一个共享字段。内置字段不可删")
    async def delete_field(project_id: str, deck_id: str, field_id: str, confirm: bool = False) -> str:
        if not confirm:
            return json.dumps({"error": "需要 confirm=true 且建议先 create_version"}, ensure_ascii=False)
        async with session_scope() as s:
            await repo.delete_field(s, project_id, deck_id, field_id)
            return json.dumps({"ok": True, "deleted": field_id})

    # ------------------------------------------------------------ Resources

    @mcp.resource("cardarts://projects", description="项目索引（id / 名称 / 统计 / revision）")
    async def projects_resource() -> str:
        async with session_scope() as s:
            from app.services import sync_service

            rows = await sync_service.list_projects(s)
            return json.dumps(
                [{"id": p.id, "name": p.name, "revision": p.revision,
                  "decks": p.deck_count, "cards": p.card_count} for p in rows],
                ensure_ascii=False,
            )

    @mcp.resource("cardarts://project/{project_id}/overview", description="单个项目的结构概览（不含完整版式）")
    async def project_overview(project_id: str) -> str:
        async with session_scope() as s:
            p = await repo.get_project_or_404(s, project_id)
            decks = [
                {
                    "id": d.get("id"), "name": d.get("name"),
                    "cards": len(d.get("cards") or []),
                    "fields": [f.get("id") for f in (d.get("fields") or [])],
                    "front_elements": len((d.get("frontLayout") or {}).get("elements") or []),
                    "back_elements": len((d.get("backLayout") or {}).get("elements") or []),
                }
                for d in (p.content.get("decks") or [])
            ]
            return json.dumps(
                {"id": p.id, "name": p.name, "revision": p.revision, "decks": decks,
                 "documents": [x.get("title") for x in (p.content.get("documents") or [])]},
                ensure_ascii=False,
            )

    # ------------------------------------------------------------ Prompts

    @mcp.prompt(name="new_game", description="从零设计一个新游戏的主题、核心循环与胜利条件")
    async def new_game_prompt(theme: str = "") -> str:
        return (
            f"请帮我设计一个{('以「' + theme + '」为主题的') if theme else ''}桌面卡牌游戏：\n"
            "1. 先给出主题、核心循环与胜利条件；\n"
            "2. 设计 8-12 张入门卡牌（名称、费用、类型、描述）；\n"
            "3. 用 create_deck / create_field / create_card 落库，落库前先 create_version；\n"
            "4. 起草一份基础规则文档。\n"
            "每一步都用中文简要说明你的决定。"
        )

    @mcp.prompt(name="safe_edit", description="破坏性编辑的标准流程：备份 -> 编辑 -> 等待确认")
    async def safe_edit_prompt(target: str) -> str:
        return (
            f"我要对 {target} 做一次破坏性修改。请按以下顺序执行：\n"
            "1. create_version 创建名为「智能体备份」的临时版本；\n"
            "2. 读取目标当前内容，确认改动范围；\n"
            "3. 执行修改；\n"
            "4. 报告改动摘要，并保留临时版本等我确认，不要删除备份。"
        )

    return mcp


LAYOUT_HELP = """## 版式格式

版式（Layout）描述一张卡面的绘制方式：

{
  "id": "...", "name": "默认正面",
  "width": 750, "height": 1050,
  "backgroundColor": "#efe1c5", "borderColor": "#2c2630",
  "borderWidth": 8, "borderRadius": 16,
  "elements": [ ... ]
}

### 元素类型（6 种）
- text：文本。可绑定 fieldId，或用 text 写固定内容
- image：图片。绑定 fieldId 或用 assetId 指定素材
- icon：game-icons 图标。icon id 必须来自 search_icons，不能编造
- rectangle / ellipse / line：形状

### 字段绑定
元素属性支持 `{字段id}` 模板，渲染时替换为该卡牌的字段值。
例："fill": "{titleBackgroundColor}"

### 显示条件
"displayCondition": {
  "type": "group", "operator": "all",
  "conditions": [
    {"type": "comparison", "fieldId": "showCostBadge",
     "operator": "equals", "value": true}
  ]
}
运算符：equals / gt / gte / lt / lte / contains / isEmpty

### 编辑方式
必须用 patch_layout 的 find/replace 精确替换，find 在序列化后的版式中必须唯一。
"""

mcp_server = build_server()


def main() -> None:
    s = get_settings()
    transport = (os.getenv("MCP_TRANSPORT") or s.MCP_TRANSPORT).lower()
    if transport == "sse":
        asyncio.run(mcp_server.run_sse_async(host=s.MCP_HOST, port=s.MCP_PORT))
    elif transport in ("streamable-http", "http"):
        asyncio.run(mcp_server.run_streamable_http_async(host=s.MCP_HOST, port=s.MCP_PORT))
    else:
        asyncio.run(mcp_server.run_stdio_async())


if __name__ == "__main__":
    main()
