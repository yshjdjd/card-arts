"""MCP 工具共用的仓储层。

所有工具都面向"项目文档"（project.content 这份 JSON）做读写，
而不是面向 decks/cards 表 —— 因为服务端不拆表。
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import attributes
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.project import Project
from app.models.version import ProjectVersion
from app.services import sync_service


def new_id() -> str:
    return str(uuid.uuid4())


class NotFound(Exception):
    pass


class GuardError(Exception):
    """护栏拒绝：内置字段、图标 id 编造、破坏性操作未备份等。"""


# ---------------------------------------------------------------- 项目


async def get_project_or_404(session: AsyncSession, project_id: str) -> Project:
    p = await sync_service.get_project(session, project_id)
    if p is None:
        raise NotFound(f"项目不存在: {project_id}")
    return p


def flag_modified(obj, key: str) -> None:
    attributes.flag_modified(obj, key)


async def _commit_project(session: AsyncSession, p: Project) -> None:
    """提交项目改动。

    注意：SQLAlchemy 默认**不追踪** JSON 列的原地修改
    （`p.content["decks"].append(...)` 这类写法不会被检测到），
    必须显式 flag_modified，否则改动静默丢失。
    """
    flag_modified(p, "content")
    p.deck_count, p.card_count, p.document_count = sync_service._stats(p.content)
    p.revision += 1
    await session.flush()


def _decks(p: Project) -> list[dict]:
    return list(p.content.get("decks") or [])


# ---------------------------------------------------------------- 牌组


def find_deck(p: Project, deck_id: str) -> dict:
    for d in _decks(p):
        if d.get("id") == deck_id:
            return d
    raise NotFound(f"牌组不存在: {deck_id}")


async def list_decks(session: AsyncSession, project_id: str) -> list[dict]:
    p = await get_project_or_404(session, project_id)
    return [
        {
            "id": d.get("id"),
            "name": d.get("name"),
            "card_count": len(d.get("cards") or []),
            "field_count": len(d.get("fields") or []),
            "has_front": bool(d.get("frontLayout")),
            "has_back": bool(d.get("backLayout")),
        }
        for d in _decks(p)
    ]


async def create_deck(session: AsyncSession, project_id: str, name: str) -> dict:
    p = await get_project_or_404(session, project_id)
    deck = {
        "id": new_id(),
        "name": name,
        "fields": [
            {"id": "name", "name": "名称", "type": "text"},
            {"id": "count", "name": "数量", "type": "number"},
        ],
        "cards": [],
        "frontLayout": None,
        "backLayout": None,
    }
    p.content.setdefault("decks", []).append(deck)
    await _commit_project(session, p)
    return deck


async def rename_deck(session: AsyncSession, project_id: str, deck_id: str, name: str) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    d["name"] = name
    await _commit_project(session, p)
    return d


async def delete_deck(session: AsyncSession, project_id: str, deck_id: str) -> None:
    p = await get_project_or_404(session, project_id)
    decks = _decks(p)
    if len(decks) <= 1:
        raise GuardError("项目必须至少保留一个牌组")
    p.content["decks"] = [d for d in decks if d.get("id") != deck_id]
    await _commit_project(session, p)


# ---------------------------------------------------------------- 卡牌


async def list_cards(
    session: AsyncSession, project_id: str, deck_id: str, *, offset: int = 0, limit: int = 50
) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    cards = d.get("cards") or []
    return {
        "total": len(cards),
        "offset": offset,
        "limit": limit,
        "items": cards[offset:offset + limit],
    }


async def create_card(session: AsyncSession, project_id: str, deck_id: str, values: dict) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    card = {"id": new_id(), "values": values}
    d.setdefault("cards", []).append(card)
    await _commit_project(session, p)
    return card


async def update_card(
    session: AsyncSession, project_id: str, deck_id: str, card_id: str, values: dict, *, merge: bool = True
) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    for c in d.get("cards") or []:
        if c.get("id") == card_id:
            if merge:
                c.setdefault("values", {}).update(values)
            else:
                c["values"] = values
            await _commit_project(session, p)
            return c
    raise NotFound(f"卡牌不存在: {card_id}")


async def delete_card(session: AsyncSession, project_id: str, deck_id: str, card_id: str) -> None:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    before = len(d.get("cards") or [])
    d["cards"] = [c for c in (d.get("cards") or []) if c.get("id") != card_id]
    if len(d["cards"]) == before:
        raise NotFound(f"卡牌不存在: {card_id}")
    await _commit_project(session, p)


# ---------------------------------------------------------------- 字段

BUILTIN_FIELDS = {"name", "count"}


async def get_fields(session: AsyncSession, project_id: str, deck_id: str) -> list[dict]:
    p = await get_project_or_404(session, project_id)
    return find_deck(p, deck_id).get("fields") or []


async def create_field(
    session: AsyncSession, project_id: str, deck_id: str, *, name: str, type_: str, options: list | None = None
) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    fields = d.setdefault("fields", [])
    fid = _slug(name)
    if any(f.get("id") == fid for f in fields):
        raise GuardError(f"字段已存在: {fid}")
    f: dict[str, Any] = {"id": fid, "name": name, "type": type_}
    if options:
        f["options"] = options
    fields.append(f)
    await _commit_project(session, p)
    return f


def _slug(name: str) -> str:
    """中文字段名转稳定 id；与前端保持一致。"""
    import hashlib
    import re

    ascii_id = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return ascii_id or ("f-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8])


async def delete_field(session: AsyncSession, project_id: str, deck_id: str, field_id: str) -> None:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    if field_id in BUILTIN_FIELDS:
        raise GuardError("内置字段不能删除")
    before = len(d.get("fields") or [])
    d["fields"] = [f for f in (d.get("fields") or []) if f.get("id") != field_id]
    if len(d["fields"]) == before:
        raise NotFound(f"字段不存在: {field_id}")
    await _commit_project(session, p)


# ---------------------------------------------------------------- 版式


async def get_layout(session: AsyncSession, project_id: str, deck_id: str, side: str) -> dict:
    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    key = "frontLayout" if side == "front" else "backLayout"
    lay = d.get(key)
    if not lay:
        raise NotFound(f"{side} 版式为空")
    return lay


async def patch_layout(
    session: AsyncSession, project_id: str, deck_id: str, side: str, *, find: str, replace: str
) -> dict:
    """精确搜索替换式局部编辑。

    原项目的护栏：整份版式 JSON 很长，让模型重写容易丢字段，
    所以只允许"找到唯一一处字符串 → 替换"，找不到或不唯一就报错。
    """
    import json

    p = await get_project_or_404(session, project_id)
    d = find_deck(p, deck_id)
    key = "frontLayout" if side == "front" else "backLayout"
    raw = json.dumps(d.get(key) or {}, ensure_ascii=False, separators=(",", ":"))
    count = raw.count(find)
    if count == 0:
        raise GuardError("未找到目标片段，请先用 get_layout 读取精确内容")
    if count > 1:
        raise GuardError(f"目标片段出现 {count} 次，请提供更长的上下文使其唯一")
    new_raw = raw.replace(find, replace)
    try:
        d[key] = json.loads(new_raw)
    except json.JSONDecodeError as exc:
        raise GuardError(f"替换后不是合法 JSON: {exc}")
    await _commit_project(session, p)
    return d[key]


# ---------------------------------------------------------------- 文档


async def list_documents(session: AsyncSession, project_id: str) -> list[dict]:
    p = await get_project_or_404(session, project_id)
    return [
        {"id": x.get("id"), "title": x.get("title"), "updated_at": x.get("updatedAt")}
        for x in (p.content.get("documents") or [])
    ]


async def update_document(session: AsyncSession, project_id: str, doc_id: str, *, find: str, replace: str) -> dict:
    p = await get_project_or_404(session, project_id)
    docs = p.content.get("documents") or []
    for x in docs:
        if x.get("id") == doc_id:
            content = x.get("content") or ""
            if content.count(find) != 1:
                raise GuardError(f"目标片段出现 {content.count(find)} 次，必须唯一")
            x["content"] = content.replace(find, replace)
            await _commit_project(session, p)
            return x
    raise NotFound(f"文档不存在: {doc_id}")


# ---------------------------------------------------------------- 素材与版本


async def list_assets(session: AsyncSession, project_id: str, kind: str | None = None) -> list[dict]:
    q = select(Asset).where(Asset.project_id == project_id, Asset.deleted_at.is_(None))
    if kind:
        q = q.where(Asset.kind == kind)
    rows = (await session.execute(q.order_by(Asset.created_at.desc()))).scalars().all()
    return [
        {
            "id": a.id, "name": a.name, "kind": a.kind, "mime": a.mime,
            "size": a.size, "sha256": a.sha256[:12],
            "width": (a.meta or {}).get("width"), "height": (a.meta or {}).get("height"),
        }
        for a in rows
    ]


async def find_asset_usage(session: AsyncSession, project_id: str, asset_id: str) -> dict:
    """反向查找：哪些卡牌字段 / 版式固定图片引用了该素材。"""
    p = await get_project_or_404(session, project_id)
    hits: list[dict] = []
    if (p.content.get("settings") or {}).get("defaultFont") == "asset:" + asset_id:
        hits.append({"where": "project_default_font"})
    for d in _decks(p):
        for c in d.get("cards") or []:
            for k, v in (c.get("values") or {}).items():
                if v == asset_id:
                    hits.append({"where": "card_value", "deck": d.get("name"), "card": c.get("id"), "field": k})
        for key in ("frontLayout", "backLayout"):
            for el in (d.get(key) or {}).get("elements") or []:
                if el.get("assetId") == asset_id or el.get("value") == asset_id or el.get("fontFamily") == "asset:" + asset_id:
                    hits.append({"where": "layout_element", "deck": d.get("name"), "side": key, "element": el.get("name")})
    return {"asset_id": asset_id, "references": hits, "count": len(hits)}


async def create_version(session: AsyncSession, project_id: str, name: str) -> ProjectVersion:
    p = await get_project_or_404(session, project_id)
    assets = await list_assets(session, project_id)
    return await sync_service.save_version(
        session, project_id, name=name,
        project_snapshot=p.content, asset_snapshots=assets, folder_snapshots=[],
    )


async def list_fonts(session: AsyncSession, project_id: str) -> list[dict]:
    await get_project_or_404(session, project_id)
    builtins = [{"key": k, "name": n} for k, n in [("sans", "无衬线（默认）"), ("serif", "衬线"), ("mono", "等宽"), ("rounded", "圆体"), ("black", "黑体加粗")]]
    return builtins + [{"key": "asset:" + a["id"], "name": a["name"]} for a in await list_assets(session, project_id, kind="font")]


async def set_font(session: AsyncSession, project_id: str, font: str, *, deck_id: str | None = None,
                   side: str = "both", element_id: str | None = None, set_default: bool = False) -> dict:
    choices = await list_fonts(session, project_id)
    matches = [f for f in choices if f["key"] == font] or [f for f in choices if f["name"] == font]
    if len(matches) != 1:
        raise GuardError("字体不存在或名称不唯一，请先 list_fonts 并使用精确 key")
    if side not in ("front", "back", "both"):
        raise GuardError("side 必须是 front/back/both")
    if element_id and (not deck_id or side == "both"):
        raise GuardError("指定元素时必须提供 deck_id 和 front/back")
    p = await get_project_or_404(session, project_id)
    decks = [find_deck(p, deck_id)] if deck_id else _decks(p)
    targets = []
    for deck in decks:
        for key in ("frontLayout", "backLayout"):
            if side != "both" and key != side + "Layout":
                continue
            for el in (deck.get(key) or {}).get("elements") or []:
                if el.get("kind") == "text" and (not element_id or el.get("id") == element_id):
                    targets.append(el)
    if element_id and len(targets) != 1:
        raise GuardError("目标元素不存在或不是文字")
    for el in targets:
        el["fontFamily"] = matches[0]["key"]
    if set_default:
        p.content.setdefault("settings", {})["defaultFont"] = matches[0]["key"]
    await _commit_project(session, p)
    return {"font": matches[0], "updated": len(targets), "default_updated": set_default}
