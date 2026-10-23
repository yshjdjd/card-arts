"""内置图标库 API（game-icons.net, CC BY 3.0）。

三块能力：
  1. 检索 / 预览：GET /icons、GET /icons/{id}/svg?color=... 支持按颜色预览
  2. 加入自建素材库：POST /icons/import  —— 可指定目标文件夹 + 自定义名称（重命名）
  3. 批量加入：POST /icons/import-batch —— 支持名称模板，如 "{name}-图标"
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.assets import _asset_out
from app.core.config import get_settings
from app.db.session import get_session
from app.services import icon_catalog, upload_service

router = APIRouter(prefix="/icons", tags=["icons"])

_FILL_RE = re.compile(r'\sfill="(?!none)[^"]*"', re.I)
_STROKE_RE = re.compile(r'\sstroke="(?!none)[^"]*"', re.I)
# 保留 stroke="none"（某些图标局部不描边），其余 stroke 属性（含 currentColor、具体色值）一律剥掉
_STROKE_ALL_RE = re.compile(r'\sstroke="(?!none)[^"]*"', re.I)
_SVG_OPEN_RE = re.compile(r"<svg\b", re.I)
_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def bake_color(svg_text: str, color: str | None, size: int | None = None) -> str:
    """把颜色烘进 SVG（图标默认纯黑，着色后才能当彩色素材用）。

    兼容两类图标：
      - fill 风格（game-icons.net）：路径自带 fill="#..."，剥掉后在根 <svg> 上加 fill。
      - stroke 风格（lucide / heroicons）：根 <svg> 用 stroke="currentColor" fill="none"，
        剥掉所有 stroke 属性后在根 <svg> 上加 stroke；fill="none" 保留。
    """
    t = svg_text
    if color:
        # 判定风格：只要原文件里出现 stroke="currentColor" 或 stroke-width，就按 stroke 图标处理
        is_stroke_style = bool(
            re.search(r'stroke="currentColor"', t, re.I)
            or re.search(r'\sstroke-width\s*=', t, re.I)
        )
        if is_stroke_style:
            # 剥掉所有非 none 的 stroke（含 currentColor 和显式色值），统一改成根上的 stroke="{color}"
            t = _STROKE_ALL_RE.sub("", t)
            t = _SVG_OPEN_RE.sub(f'<svg stroke="{color}"', t, count=1)
        else:
            # fill 风格：剥掉路径上的 fill，根 <svg> 加 fill
            t = _FILL_RE.sub("", t)
            t = _STROKE_RE.sub("", t)
            t = t.replace("currentColor", color)
            t = _SVG_OPEN_RE.sub(f'<svg fill="{color}"', t, count=1)
    if size:
        t = re.sub(r'\swidth="[^"]*"', "", t, count=1)
        t = re.sub(r'\sheight="[^"]*"', "", t, count=1)
        t = _SVG_OPEN_RE.sub(f'<svg width="{size}" height="{size}"', t, count=1)
    return t


def _ensure_svg(name: str, fallback: str) -> str:
    n = (name or "").strip() or fallback
    return n if n.lower().endswith(".svg") else f"{n}.svg"


# ---------------- 检索 ----------------


@router.get("/stats")
async def stats():
    return icon_catalog.stats()


@router.get("/authors")
async def list_authors():
    return {"items": icon_catalog.authors()}


@router.get("")
async def search(
    q: str = "",
    limit: int = Query(get_settings().ICON_DEFAULT_PAGE_SIZE, ge=1, le=500),
    offset: int = Query(0, ge=0),
    author: str | None = None,
    color: str | None = None,
):
    """检索图标。`color` 只影响返回 url 里的着色参数，用于网格预览。"""
    items, total = icon_catalog.search(q, limit, author=author, offset=offset)
    if color and _COLOR_RE.match(color):
        for it in items:
            it["url"] = f"/api/v1/icons/{it['id']}/svg?color={color.lstrip('#')}"
    return {"items": items, "total": total, "offset": offset, "limit": limit}


# ---------------- 预览 ----------------


@router.get("/{icon_id:path}/svg")
async def icon_svg(
    icon_id: str,
    color: str | None = None,
    size: int | None = Query(None, ge=8, le=1024),
):
    """单图标预览（可着色）。返回 image/svg+xml，前端直接 <img src> 即可。"""
    try:
        raw = icon_catalog.read_svg(icon_id)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "图标不存在")

    if color:
        c = color if color.startswith("#") else f"#{color}"
        if not _COLOR_RE.match(c):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "颜色格式应为 #RRGGBB")
        color = c

    text = raw.decode("utf-8", errors="ignore")
    return Response(content=bake_color(text, color, size), media_type="image/svg+xml")


@router.get("/{icon_id:path}")
async def icon_detail(icon_id: str):
    it = icon_catalog.get(icon_id)
    if it is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "图标不存在")
    return it


# ---------------- 加入自建素材库 ----------------


class ImportIn(BaseModel):
    project_id: str
    icon_id: str
    """自定义名称，可不含扩展名（自动补 .svg）。留空则用图标原名。"""
    name: str | None = None
    folder_id: str | None = None
    color: str | None = None
    """重名策略：rename 自动加后缀 / skip 跳过 / replace 覆盖同名素材"""
    on_conflict: Literal["rename", "skip", "replace"] = "rename"


async def _import_one(
    session: AsyncSession,
    *,
    project_id: str,
    icon_id: str,
    name: str | None,
    folder_id: str | None,
    color: str | None,
    on_conflict: str,
) -> dict:
    from sqlalchemy import select

    from app.models.asset import Asset

    try:
        raw = icon_catalog.read_svg(icon_id)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"图标不存在: {icon_id}")

    base = icon_catalog.get(icon_id) or {}
    default_name = (base.get("name") or icon_id.rpartition("/")[2] or "icon").replace("/", "-")
    want = _ensure_svg(name, default_name)

    # 重名处理
    existing = (
        await session.execute(
            select(Asset).where(
                Asset.project_id == project_id,
                Asset.folder_id == folder_id,
                Asset.name == want,
                Asset.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    if existing is not None:
        if on_conflict == "skip":
            return {"status": "skipped", "asset": _asset_out(existing), "name": want}
        if on_conflict == "replace":
            existing.deleted_at = datetime.now(timezone.utc)
            await session.flush()
        else:  # rename
            stem = want[: -len(".svg")] if want.lower().endswith(".svg") else want
            i = 2
            while True:
                cand = f"{stem}-{i}.svg"
                dup = (
                    await session.execute(
                        select(Asset).where(
                            Asset.project_id == project_id,
                            Asset.folder_id == folder_id,
                            Asset.name == cand,
                            Asset.deleted_at.is_(None),
                        )
                    )
                ).scalars().first()
                if dup is None:
                    want = cand
                    break
                i += 1

    data = raw
    if color:
        c = color if color.startswith("#") else f"#{color}"
        if not _COLOR_RE.match(c):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "颜色格式应为 #RRGGBB")
        data = bake_color(raw.decode("utf-8", errors="ignore"), c).encode("utf-8")

    asset = await upload_service.create_from_bytes(
        session,
        project_id=project_id,
        filename=want,
        mime="image/svg+xml",
        data=data,
        folder_id=folder_id,
        name=want,
        dedupe=False,  # 同一图标可多次入库，名字不同即独立素材
        extra_meta={
            "icon_id": icon_id,
            "icon_author": base.get("author", ""),
            "icon_color": color,
            "source": "game-icons",
        },
    )
    await session.flush()
    return {"status": "created", "asset": _asset_out(asset), "name": want}


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_icon(body: ImportIn, session: AsyncSession = Depends(get_session)):
    """把内置图标加入自建素材库，并可重命名、指定文件夹、着色。"""
    r = await _import_one(
        session,
        project_id=body.project_id,
        icon_id=body.icon_id,
        name=body.name,
        folder_id=body.folder_id,
        color=body.color,
        on_conflict=body.on_conflict,
    )
    await session.commit()
    return r


class BatchIn(BaseModel):
    project_id: str
    icon_ids: list[str] = Field(..., min_length=1, max_length=200)
    folder_id: str | None = None
    """名称模板，支持 {name} / {author} / {index}；不含 .svg 会自动补"""
    name_template: str = "{name}"
    color: str | None = None
    on_conflict: Literal["rename", "skip", "replace"] = "rename"


@router.post("/import-batch", status_code=status.HTTP_201_CREATED)
async def import_batch(body: BatchIn, session: AsyncSession = Depends(get_session)):
    """批量把内置图标加入某个文件夹。"""
    results = []
    for i, icon_id in enumerate(body.icon_ids, start=1):
        meta = icon_catalog.get(icon_id) or {}
        nm = body.name_template.format(
            name=meta.get("name") or icon_id.rpartition("/")[2] or "icon",
            author=meta.get("author", ""),
            index=i,
        )
        try:
            r = await _import_one(
                session,
                project_id=body.project_id,
                icon_id=icon_id,
                name=nm,
                folder_id=body.folder_id,
                color=body.color,
                on_conflict=body.on_conflict,
            )
        except HTTPException as exc:
            r = {"status": "failed", "icon_id": icon_id, "error": exc.detail}
        results.append({"icon_id": icon_id, **r})
    await session.commit()
    ok = sum(1 for r in results if r.get("status") == "created")
    return {"created": ok, "total": len(results), "items": results}
