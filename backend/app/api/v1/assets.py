"""素材与文件夹 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.asset import Asset, UploadSession
from app.models.asset_folder import AssetFolder
from app.models.project import Project
from app.services import image_processor, upload_service
from app.services.storage import get_storage

router = APIRouter(prefix="/assets", tags=["assets"])


def _asset_out(a: Asset) -> dict:
    return {
        "id": a.id,
        "project_id": a.project_id,
        "folder_id": a.folder_id,
        "name": a.name,
        "kind": a.kind,
        "mime": a.mime,
        "size": a.size,
        "sha256": a.sha256,
        "variants": a.variants,
        "meta": a.meta,
        "created_at": a.created_at.isoformat(),
        "url": f"/api/v1/assets/{a.id}/content",
        "thumb_url": f"/api/v1/assets/{a.id}/variant/thumb" if "thumb" in (a.variants or {}) else None,
    }


@router.get("")
async def list_assets(
    project_id: str,
    folder_id: str | None = None,
    kind: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    q = select(Asset).where(Asset.project_id == project_id, Asset.deleted_at.is_(None))
    if folder_id is not None:
        q = q.where(Asset.folder_id == folder_id)
    if kind:
        q = q.where(Asset.kind == kind)
    rows = (await session.execute(q.order_by(Asset.created_at.desc()))).scalars().all()
    return {"items": [_asset_out(a) for a in rows]}


@router.get("/{asset_id}")
async def get_asset(asset_id: str, session: AsyncSession = Depends(get_session)):
    a = await session.get(Asset, asset_id)
    if a is None or a.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    return _asset_out(a)


@router.get("/{asset_id}/content")
async def asset_content(asset_id: str, session: AsyncSession = Depends(get_session)):
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    data = await upload_service.load_asset_bytes(a.storage_key)
    return Response(content=data, media_type=a.mime)


@router.get("/{asset_id}/variant/{name}")
async def asset_variant(asset_id: str, name: str, session: AsyncSession = Depends(get_session)):
    """取派生图：thumb / medium / webp。"""
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    v = (a.variants or {}).get(name)
    if not v:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有 {name} 派生图")
    data = await get_storage().get(v["key"])
    return Response(content=data, media_type=v.get("mime", "image/webp"))


class RenameIn(BaseModel):
    name: str


@router.patch("/{asset_id}")
async def rename_asset(asset_id: str, body: RenameIn, session: AsyncSession = Depends(get_session)):
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    a.name = body.name
    await session.commit()
    return _asset_out(a)


class MoveIn(BaseModel):
    folder_id: str | None = None


@router.post("/{asset_id}/move")
async def move_asset(asset_id: str, body: MoveIn, session: AsyncSession = Depends(get_session)):
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    a.folder_id = body.folder_id
    await session.commit()
    return _asset_out(a)


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(asset_id: str, session: AsyncSession = Depends(get_session)):
    """软删除。引用计数归零的物理文件由清理任务回收。"""
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    from datetime import datetime, timezone

    a.deleted_at = datetime.now(timezone.utc)
    await session.commit()


class CropIn(BaseModel):
    mode: str = "original"  # original | card | custom
    preset: str = "poker"
    width: int | None = None
    height: int | None = None
    focus_x: float = 0.5
    focus_y: float = 0.5
    zoom: float = 1.0
    name: str | None = None


@router.post("/{asset_id}/crop")
async def crop_asset(asset_id: str, body: CropIn, session: AsyncSession = Depends(get_session)):
    """服务端裁切：产出新素材，原图保持不变（与原项目行为一致）。"""
    a = await session.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在")
    if a.kind != "image":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只有图片可以裁切")

    data = await upload_service.load_asset_bytes(a.storage_key)
    spec = image_processor.CropSpec(
        mode=body.mode,
        preset=body.preset,
        width=body.width,
        height=body.height,
        focus_x=body.focus_x,
        focus_y=body.focus_y,
        zoom=body.zoom,
    )
    try:
        blob, mime = await image_processor.crop(data, spec)
    except image_processor.ImageDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    new_name = body.name or f"{a.name.rsplit('.', 1)[0]}-crop.webp"
    created = await upload_service.create_from_bytes(
        session,
        project_id=a.project_id,
        filename=new_name,
        mime=mime,
        data=blob,
        folder_id=a.folder_id,
    )
    await session.commit()
    return {"asset": _asset_out(created)}


# ---------------- 从 URL 导入 ----------------

# 超过这个体积就不拉了，避免有人拿接口当下载器
IMPORT_MAX_BYTES = 12 * 1024 * 1024
IMPORT_MIME_OK = {
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif",
}


class ImportUrlIn(BaseModel):
    url: str
    name: str | None = None
    project_id: str
    folder_id: str | None = None


@router.post("/import-url", status_code=status.HTTP_201_CREATED)
async def import_asset_from_url(
    body: ImportUrlIn,
    session: AsyncSession = Depends(get_session),
):
    """把一张网上的图片拉下来存进素材库。

    智能体没有浏览器环境，直接在前端 fetch 外链会被 CORS 拦掉，
    所以下载这一步必须放在后端做。
    """
    url = (body.url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "url 必须是 http(s) 链接")
    if not (await session.get(Project, body.project_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    try:
        data, mime = await _download_image(url)
    except _DownloadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    filename = (body.name or "").strip() or _name_from_url(url)
    mime = _mime_of(filename, mime, data)
    if not mime:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "链接返回的不是图片")

    created = await upload_service.create_from_bytes(
        session,
        project_id=body.project_id,
        filename=filename,
        mime=mime,
        data=data,
        folder_id=body.folder_id,
    )
    await session.commit()
    return {"asset": _asset_out(created)}


class _DownloadError(Exception):
    pass


async def _download_image(url: str) -> tuple[bytes, str]:
    import httpx  # 局部导入：只有真的用到时才付出导入成本

    # 本机后端不该被沙箱代理劫持（本地联调时 HTTP_PROXY 常指向 127.0.0.1）
    async with httpx.AsyncClient(
        timeout=25.0, follow_redirects=True, max_redirects=5, trust_env=False,
        headers={"User-Agent": "CardArts/1.0 asset-importer"},
    ) as cli:
        try:
            r = await cli.get(url)
        except httpx.HTTPError as exc:
            raise _DownloadError(f"下载失败：{exc}") from exc
        if r.status_code >= 400:
            raise _DownloadError(f"下载失败：HTTP {r.status_code}")
        clen = r.headers.get("Content-Length")
        if clen and clen.isdigit() and int(clen) > IMPORT_MAX_BYTES:
            raise _DownloadError("图片太大（超过 12MB）")
        data = r.content
        if len(data) > IMPORT_MAX_BYTES:
            raise _DownloadError("图片太大（超过 12MB）")
        if not data:
            raise _DownloadError("下载到的是空文件")
        mime = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        return data, mime


_EXT_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "gif": "image/gif", "svg": "image/svg+xml",
    "avif": "image/avif", "bmp": "image/bmp",
}


def _mime_of(filename: str, mime: str, data: bytes) -> str:
    """Content-Type 常常不可信（很多站点一律返回 octet-stream），
    所以先看协议头，不行再看扩展名，最后看魔术字节。"""
    m = (mime or "").lower()
    if m in IMPORT_MIME_OK or m == "image/bmp":
        return m
    ext = filename.rpartition(".")[2].lower()
    if ext in _EXT_MIME:
        return _EXT_MIME[ext]
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "image/png"
    if data[:3] == b"\xff\xd8\xff": return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif"
    if data[:5] == b"<?xml" or b"<svg" in data[:512]: return "image/svg+xml"
    if data[4:8] == b"ftyp" and data[8:12] == b"avis": return "image/avif"
    return ""


def _name_from_url(url: str) -> str:
    import re
    import time as _t
    from urllib.parse import unquote, urlparse

    path = urlparse(url).path
    base = unquote(path.rsplit("/", 1)[-1] or "")
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)[:80]
    if not base or "." not in base:
        return f"imported-{int(_t.time())}.png"
    return base


# ---------------- 文件夹 ----------------


class FolderIn(BaseModel):
    name: str
    parent_id: str | None = None


@router.get("/folders/list")
async def list_folders(project_id: str, session: AsyncSession = Depends(get_session)):
    q = select(AssetFolder).where(
        AssetFolder.project_id == project_id, AssetFolder.deleted_at.is_(None)
    )
    rows = (await session.execute(q.order_by(AssetFolder.created_at))).scalars().all()
    return {
        "items": [
            {"id": f.id, "name": f.name, "parent_id": f.parent_id, "created_at": f.created_at.isoformat()}
            for f in rows
        ]
    }


@router.post("/folders", status_code=status.HTTP_201_CREATED)
async def create_folder(body: FolderIn, project_id: str, session: AsyncSession = Depends(get_session)):
    f = AssetFolder(project_id=project_id, name=body.name, parent_id=body.parent_id)
    session.add(f)
    await session.commit()
    return {"id": f.id, "name": f.name, "parent_id": f.parent_id}


@router.patch("/folders/{folder_id}")
async def rename_folder(folder_id: str, body: FolderIn, session: AsyncSession = Depends(get_session)):
    f = await session.get(AssetFolder, folder_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件夹不存在")
    f.name = body.name
    await session.commit()
    return {"id": f.id, "name": f.name}


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: str, session: AsyncSession = Depends(get_session)):
    """删除文件夹会连带删除其下素材（与原项目一致，前端需二次确认）。"""
    from datetime import datetime, timezone

    f = await session.get(AssetFolder, folder_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件夹不存在")
    now = datetime.now(timezone.utc)
    f.deleted_at = now
    rows = (await session.execute(select(Asset).where(Asset.folder_id == folder_id))).scalars().all()
    for a in rows:
        a.deleted_at = now
    await session.commit()
