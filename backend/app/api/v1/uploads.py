"""素材上传 API：秒传 / 分片 / 断点续传。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_session
from app.models.asset import Asset
from app.services import upload_service
from app.services.upload_service import HashMismatch, SizeLimitExceeded, UploadError

router = APIRouter(prefix="/uploads", tags=["uploads"])


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


class InitIn(BaseModel):
    project_id: str
    filename: str
    mime: str
    size: int
    sha256: str
    chunk_size: int | None = None
    folder_id: str | None = None


@router.post("/init")
async def init_upload(body: InitIn, session: AsyncSession = Depends(get_session)):
    """初始化上传。命中哈希时返回 instant=True（秒传）。"""
    try:
        us, hit = await upload_service.init_upload(
            session,
            project_id=body.project_id,
            filename=body.filename,
            mime=body.mime,
            size=body.size,
            sha256=body.sha256,
            chunk_size=body.chunk_size,
        )
    except SizeLimitExceeded as exc:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(exc))
    except UploadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await session.commit()

    if hit is not None:
        return {"instant": True, "asset": _asset_out(hit)}

    return {
        "instant": False,
        "upload_id": us.id,
        "chunk_size": us.chunk_size,
        "chunk_count": us.chunk_count,
        "received": us.received,
        "expire_hours": get_settings().UPLOAD_SESSION_TTL_HOURS,
    }


@router.get("/{upload_id}/status")
async def upload_status(upload_id: str, session: AsyncSession = Depends(get_session)):
    """查询已收到分片 —— 断点续传靠它确定该补传哪些。"""
    from app.models.asset import UploadSession

    us = await session.get(UploadSession, upload_id)
    if us is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "上传会话不存在")
    return {
        "upload_id": us.id,
        "status": us.status,
        "chunk_size": us.chunk_size,
        "chunk_count": us.chunk_count,
        "received": us.received,
        "missing": sorted(set(range(us.chunk_count)) - set(us.received or [])),
    }


@router.put("/{upload_id}/chunk/{index}")
async def put_chunk(
    upload_id: str,
    index: int,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """写入单个分片（幂等，可重复调用）。"""
    data = await request.body()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片内容为空")
    try:
        received = await upload_service.save_chunk(session, upload_id, index, data)
    except UploadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await session.commit()
    return {"index": index, "received": received}


class CompleteIn(BaseModel):
    folder_id: str | None = None
    name: str | None = None


@router.post("/{upload_id}/complete")
async def complete(
    upload_id: str,
    body: CompleteIn | None = None,
    session: AsyncSession = Depends(get_session),
):
    """合并分片、校验哈希、生成派生图并建素材。请求体可省略。"""
    body = body or CompleteIn()
    try:
        asset = await upload_service.complete_upload(
            session, upload_id, folder_id=body.folder_id, name=body.name
        )
    except HashMismatch as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    except UploadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await session.commit()
    return {"asset": _asset_out(asset)}


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def abort(upload_id: str, session: AsyncSession = Depends(get_session)):
    from app.models.asset import UploadSession
    from app.services.storage import cleanup_tmp

    us = await session.get(UploadSession, upload_id)
    if us is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "上传会话不存在")
    us.status = "aborted"
    await session.flush()
    await cleanup_tmp(upload_id)
    await session.commit()


@router.post("/direct")
async def direct_upload(
    project_id: str = Form(...),
    folder_id: str | None = Form(None),
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    """小文件直通通道（前端判断 size <= chunk_size 时可用，少两次往返）。"""
    data = await file.read()
    try:
        asset = await upload_service.create_from_bytes(
            session,
            project_id=project_id,
            filename=file.filename or "unnamed",
            mime=file.content_type or "application/octet-stream",
            data=data,
            folder_id=folder_id,
        )
    except UploadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    await session.commit()
    return {"asset": _asset_out(asset)}
