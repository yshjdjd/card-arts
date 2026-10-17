"""项目同步服务：基于 revision 的乐观并发。

本地优先模型下的同步规则
------------------------
* 浏览器 IndexedDB 是真相源，离线可写；联网后把整份 project 文档推给服务端。
* 服务端只认 revision：
    - base_revision == server.revision  → 快进提交，revision + 1
    - base_revision <  server.revision  → 409 冲突，带回服务端最新版本
      由客户端决定合并策略（本项目默认：以本地为准并要求用户确认，
      或由前端做字段级合并后再提交）
* 不尝试在服务端做细粒度 JSON 合并——那是 CRDT/OT 的领域，
  对于一个以单人编辑为主的创作工具，整文档 + 版本号 + 快照回滚
  是性价比最高且行为可预测的方案。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.version import ProjectVersion


class SyncConflict(Exception):
    def __init__(self, server: Project) -> None:
        super().__init__("revision 冲突")
        self.server = server


def _hash(content: dict) -> str:
    raw = json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _stats(content: dict) -> tuple[int, int, int]:
    decks = content.get("decks") or []
    card_count = sum(len(d.get("cards") or []) for d in decks)
    return len(decks), card_count, len(content.get("documents") or [])


def _now():
    return datetime.now(timezone.utc)


async def list_projects(session: AsyncSession, *, include_deleted: bool = False) -> list[Project]:
    q = select(Project)
    if not include_deleted:
        q = q.where(Project.deleted_at.is_(None))
    q = q.order_by(Project.updated_at.desc())
    return list((await session.execute(q)).scalars().all())


async def get_project(session: AsyncSession, project_id: str) -> Project | None:
    p = await session.get(Project, project_id)
    if p is None or p.deleted_at is not None:
        return None
    return p


async def create_project(session: AsyncSession, *, name: str, content: dict, owner_id: str | None = None) -> Project:
    decks, cards, docs = _stats(content)
    p = Project(
        name=name,
        owner_id=owner_id,
        content=content,
        content_hash=_hash(content),
        deck_count=decks,
        card_count=cards,
        document_count=docs,
    )
    session.add(p)
    await session.flush()
    return p


async def push(
    session: AsyncSession,
    project_id: str,
    *,
    base_revision: int,
    content: dict,
    name: str | None = None,
    force: bool = False,
) -> Project:
    """提交本地改动。冲突时抛 SyncConflict。"""
    p = await get_project(session, project_id)
    if p is None:
        raise KeyError("项目不存在")

    if not force and base_revision != p.revision:
        raise SyncConflict(p)

    p.content = content
    p.content_hash = _hash(content)
    if name:
        p.name = name
    p.deck_count, p.card_count, p.document_count = _stats(content)
    p.revision += 1
    p.updated_at = _now()
    await session.flush()
    return p


async def pull(session: AsyncSession, project_id: str, *, since_revision: int | None = None):
    """拉取服务端版本。since_revision 与服务端一致时返回 None（无更新）。"""
    p = await get_project(session, project_id)
    if p is None:
        return None
    if since_revision is not None and since_revision >= p.revision:
        return None
    return p


async def soft_delete(session: AsyncSession, project_id: str) -> None:
    p = await get_project(session, project_id)
    if p is None:
        raise KeyError("项目不存在")
    p.deleted_at = _now()
    await session.flush()


async def save_version(
    session: AsyncSession,
    project_id: str,
    *,
    name: str,
    project_snapshot: dict,
    asset_snapshots: list | None = None,
    folder_snapshots: list | None = None,
) -> ProjectVersion:
    p = await get_project(session, project_id)
    if p is None:
        raise KeyError("项目不存在")
    v = ProjectVersion(
        project_id=project_id,
        name=name,
        project_snapshot=project_snapshot,
        asset_snapshots=asset_snapshots or [],
        folder_snapshots=folder_snapshots or [],
        base_revision=p.revision,
        size_bytes=len(json.dumps(project_snapshot, ensure_ascii=False)),
    )
    session.add(v)
    await session.flush()
    return v


async def list_versions(session: AsyncSession, project_id: str) -> list[ProjectVersion]:
    q = (
        select(ProjectVersion)
        .where(ProjectVersion.project_id == project_id)
        .order_by(ProjectVersion.created_at.desc())
    )
    return list((await session.execute(q)).scalars().all())


async def restore_version(session: AsyncSession, project_id: str, version_id: str) -> Project:
    """用快照整体替换当前项目内容，并把 revision 推进一步。"""
    v = await session.get(ProjectVersion, version_id)
    if v is None or v.project_id != project_id:
        raise KeyError("版本不存在")
    p = await get_project(session, project_id)
    if p is None:
        raise KeyError("项目不存在")

    p.content = v.project_snapshot
    p.content_hash = _hash(v.project_snapshot)
    p.deck_count, p.card_count, p.document_count = _stats(v.project_snapshot)
    p.revision += 1
    p.updated_at = _now()
    await session.flush()
    return p
