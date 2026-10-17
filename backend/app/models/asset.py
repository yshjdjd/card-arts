"""素材模型（内容寻址 + 自动去重）。

存储层用 sha256 做内容寻址：`objects/ab/cdef...`。
同一份字节只会真正落盘一次，多个 Asset 行可以指向同一个 storage_key，
因此"秒传"和"重复上传"都退化成一次哈希查表。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="image")  # image | font
    mime: Mapped[str] = mapped_column(String(80), nullable=False, default="application/octet-stream")
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 内容寻址
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)

    # 派生文件（图片处理管线产出）
    variants: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # 例：{"thumb": {"key": "...", "w": 256, "h": 358, "format": "webp"},
    #      "medium": {...}, "webp": {...}}

    # 元数据：宽高、主色、原图来源等
    meta: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    # 引用计数：同一 storage_key 被引用的次数，归零时可由清理任务回收
    ref_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class UploadSession(Base):
    """分片上传会话。用于断点续传与并发分片写入。"""

    __tablename__ = "upload_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime: Mapped[str] = mapped_column(String(80), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_size: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)

    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 已收到的分片下标，JSON 数组
    received: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )  # pending | completed | aborted | deduped

    asset_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
