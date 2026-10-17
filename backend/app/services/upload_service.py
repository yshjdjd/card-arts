"""素材上传服务：秒传 / 分片 / 断点续传 / 完成后处理。

完整时序
--------
1. 客户端算好文件 sha256（浏览器内用 Web Crypto，见前端 uploader.ts）
2. POST /uploads/init  {project_id, filename, mime, size, sha256, chunk_size}
   ├─ 命中已有 sha256 → 直接返回 {instant: true, asset}（秒传，零流量）
   └─ 否则建会话，返回 {upload_id, chunk_size, chunk_count, received: [...] }
      received 非空即代表历史上断点，客户端只需补传缺失分片
3. PUT /uploads/{id}/chunk/{index}  重复调用幂等，服务端按 index 落盘
4. POST /uploads/{id}/complete
   ├─ 校验分片齐全 + 总 sha256 一致
   ├─ 内容寻址落盘（相同字节不重复存储）
   ├─ 图片：元数据提取 + 派生图（thumb/medium/webp）
   └─ 写 Asset 行，返回素材
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.asset import Asset, UploadSession
from app.services import image_processor
from app.services.storage import (
    cleanup_tmp,
    get_storage,
    key_for,
    save_content_addressed,
    sha256_of,
    tmp_chunk_dir,
)


class UploadError(Exception):
    pass


class SizeLimitExceeded(UploadError):
    pass


class HashMismatch(UploadError):
    pass


def _ext_of(filename: str, mime: str) -> str:
    for ext in (".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff2", ".woff", ".ttf", ".otf"):
        if filename.lower().endswith(ext):
            return ext
    return {
        "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg",
        "image/gif": ".gif", "image/svg+xml": ".svg",
        "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf",
    }.get(mime, ".bin")


def normalize_font_mime(filename: str, mime: str) -> str:
    ext = filename.rpartition(".")[2].lower()
    return {"ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2"}.get(ext, mime)


def validate_font_bytes(mime: str, data: bytes) -> None:
    if "font" in mime and data[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"wOFF", b"wOF2"):
        raise UploadError("字体文件内容无效，请上传 TTF/OTF/WOFF/WOFF2")


def _kind_of(mime: str) -> str:
    return "font" if ("font" in mime or mime in ("application/font-woff2",)) else "image"


def _now():
    return datetime.now(timezone.utc)


async def find_by_hash(session: AsyncSession, sha256: str, project_id: str) -> Asset | None:
    """秒传查表：同项目内已有相同内容的素材。"""
    res = await session.execute(
        select(Asset).where(
            Asset.sha256 == sha256,
            Asset.project_id == project_id,
            Asset.deleted_at.is_(None),
        )
    )
    return res.scalars().first()


async def init_upload(
    session: AsyncSession,
    *,
    project_id: str,
    filename: str,
    mime: str,
    size: int,
    sha256: str,
    chunk_size: int | None = None,
) -> tuple[UploadSession | None, Asset | None]:
    """返回 (会话, 命中的已有素材)。命中素材时会话为 None。"""
    s = get_settings()
    mime = normalize_font_mime(filename, mime)

    if size <= 0:
        raise UploadError("文件为空")
    if size > s.UPLOAD_MAX_SIZE:
        raise SizeLimitExceeded(f"文件超过上限 {s.UPLOAD_MAX_SIZE} 字节")
    if mime not in s.allowed_asset_types:
        raise UploadError(f"不支持的文件类型: {mime}")

    # ① 秒传
    existing = await find_by_hash(session, sha256, project_id)
    if existing is not None:
        return None, existing

    cs = chunk_size or s.UPLOAD_CHUNK_SIZE
    cs = max(256 * 1024, min(cs, 32 * 1024 * 1024))
    count = (size + cs - 1) // cs

    us = UploadSession(
        project_id=project_id,
        filename=filename,
        mime=mime,
        size=size,
        chunk_size=cs,
        chunk_count=count,
        sha256=sha256,
        received=[],
        status="pending",
    )
    session.add(us)
    await session.flush()
    tmp_chunk_dir(us.id)
    return us, None


async def save_chunk(session: AsyncSession, upload_id: str, index: int, data: bytes) -> list[int]:
    """写入一个分片，返回已收到的全部分片下标（幂等）。"""
    us = await session.get(UploadSession, upload_id)
    if us is None:
        raise UploadError("上传会话不存在")
    if us.status != "pending":
        raise UploadError(f"会话状态为 {us.status}，无法写入")

    if index < 0 or index >= us.chunk_count:
        raise UploadError("分片下标越界")
    if len(data) > us.chunk_size:
        raise UploadError("分片大小超过约定值")

    d = tmp_chunk_dir(upload_id)
    async with aiofiles.open(d / f"{index}.part", "wb") as f:
        await f.write(data)

    received = set(us.received or [])
    received.add(index)
    us.received = sorted(received)
    us.updated_at = _now()
    await session.flush()
    return us.received


async def complete_upload(
    session: AsyncSession,
    upload_id: str,
    *,
    folder_id: str | None = None,
    name: str | None = None,
) -> Asset:
    """合并分片 → 校验 → 落盘 → 派生处理 → 建素材。"""
    us = await session.get(UploadSession, upload_id)
    if us is None:
        raise UploadError("上传会话不存在")
    if us.status == "completed" and us.asset_id:
        asset = await session.get(Asset, us.asset_id)
        if asset:
            return asset

    received = set(us.received or [])
    if len(received) != us.chunk_count:
        missing = sorted(set(range(us.chunk_count)) - received)
        raise UploadError(f"分片不完整，缺失: {missing[:20]}")

    d = tmp_chunk_dir(upload_id)
    buf = bytearray()
    for i in range(us.chunk_count):
        async with aiofiles.open(d / f"{i}.part", "rb") as f:
            buf.extend(await f.read())
    data = bytes(buf)

    if len(data) != us.size:
        raise UploadError("合并后大小与声明不一致")

    digest = await asyncio.to_thread(sha256_of, data)
    if us.sha256 and digest != us.sha256:
        raise HashMismatch("文件校验失败，内容已变更")

    validate_font_bytes(us.mime, data)

    # ② 内容寻址落盘（相同字节不重复写）
    ext = _ext_of(us.filename, us.mime)
    key, _ = await save_content_addressed(data, ext)

    # ③ 元数据 + 派生图
    meta: dict = {}
    variants: dict = {}
    try:
        meta = (await image_processor.extract_meta(data)).as_dict()
    except image_processor.ImageDecodeError:
        meta = {}
    try:
        variants = await image_processor.build_variants(data, us.mime)
    except Exception:  # noqa: BLE001 派生失败不阻断上传
        variants = {}

    asset = Asset(
        project_id=us.project_id,
        folder_id=folder_id,
        name=name or us.filename,
        kind=_kind_of(us.mime),
        mime=us.mime,
        size=len(data),
        sha256=digest,
        storage_key=key,
        variants=variants,
        meta=meta,
        ref_count=1,
    )
    session.add(asset)

    us.status = "completed"
    us.asset_id = asset.id
    us.updated_at = _now()
    await session.flush()

    await cleanup_tmp(upload_id)
    return asset


async def create_from_bytes(
    session: AsyncSession,
    *,
    project_id: str,
    filename: str,
    mime: str,
    data: bytes,
    folder_id: str | None = None,
    name: str | None = None,
    dedupe: bool = True,
    extra_meta: dict | None = None,
) -> Asset:
    """小文件直通通道（<= 分片大小时前端可跳过分片流程）。

    dedupe=False 时（内置图标入库场景）即使内容已存在也会新建一条素材记录 ——
    同一个图标可以用不同名字放进不同文件夹，物理字节仍然只存一份。
    """
    mime = normalize_font_mime(filename, mime)
    validate_font_bytes(mime, data)
    digest = await asyncio.to_thread(sha256_of, data)
    if dedupe:
        hit = await find_by_hash(session, digest, project_id)
        if hit is not None:
            return hit

    ext = _ext_of(filename, mime)
    key, _ = await save_content_addressed(data, ext)

    meta: dict = {}
    variants: dict = {}
    try:
        meta = (await image_processor.extract_meta(data)).as_dict()
        variants = await image_processor.build_variants(data, mime)
    except Exception:  # noqa: BLE001  SVG / 字体无需派生图，忽略
        pass
    if extra_meta:
        meta.update(extra_meta)

    asset = Asset(
        project_id=project_id,
        folder_id=folder_id,
        name=name or filename,
        kind=_kind_of(mime),
        mime=mime,
        size=len(data),
        sha256=digest,
        storage_key=key,
        variants=variants,
        meta=meta,
    )
    session.add(asset)
    await session.flush()
    return asset


async def load_asset_bytes(key: str) -> bytes:
    return await get_storage().get(key)
