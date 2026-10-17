"""项目版本快照（不可变）。

本地优先架构下，版本快照是主要的数据安全网：
用户误操作后可以从任意快照整体回滚（项目 + 素材 + 文件夹）。
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


class ProjectVersion(Base):
    __tablename__ = "project_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    # 三份快照：结构、素材元数据、文件夹树
    project_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    asset_snapshots: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    folder_snapshots: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    base_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
