"""项目模型。

关键设计：本地优先模式下，浏览器 IndexedDB 是唯一真相源。
服务端不把 Project 拆成 decks/cards/fields 若干表，而是把整个项目存成
一份**版本化 JSON 文档**（content），只把列表/搜索需要的字段提升为列。

这样做的好处：
  1. 同步只需对比 revision，不需要做逐表 diff，冲突处理简单可靠；
  2. 前端 schema 演进时后端零改动（客户端数据模型升级不用改服务端）；
  3. 完整备份/恢复就是一次文档读写，天然支持版本快照。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="未命名项目")
    owner_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    # 完整项目文档：{ decks: [...], documents: [...], settings: {...} }
    content: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    # 同步用：每次成功提交 +1，客户端用 base_revision 判定快进或冲突
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 提升为列的统计信息，供列表页与搜索使用（由服务层在写入时重算）
    deck_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    card_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    document_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def touch(self) -> None:
        self.updated_at = _now()
