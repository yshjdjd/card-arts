"""项目 CRUD 与同步 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.services import sync_service

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectOut(BaseModel):
    id: str
    name: str
    revision: int
    deck_count: int
    card_count: int
    document_count: int
    updated_at: str

    @classmethod
    def of(cls, p) -> "ProjectOut":
        return cls(
            id=p.id,
            name=p.name,
            revision=p.revision,
            deck_count=p.deck_count,
            card_count=p.card_count,
            document_count=p.document_count,
            updated_at=p.updated_at.isoformat(),
        )


def _full(p) -> dict:
    return {
        **ProjectOut.of(p).model_dump(),
        "content": p.content,
        "content_hash": p.content_hash,
        "created_at": p.created_at.isoformat(),
    }


class CreateIn(BaseModel):
    name: str = Field(default="未命名项目", max_length=200)
    content: dict = Field(default_factory=dict)


class PushIn(BaseModel):
    base_revision: int
    content: dict
    name: str | None = None
    force: bool = False


class VersionIn(BaseModel):
    name: str
    project_snapshot: dict
    asset_snapshots: list = Field(default_factory=list)
    folder_snapshots: list = Field(default_factory=list)


@router.get("")
async def list_projects(session: AsyncSession = Depends(get_session)):
    rows = await sync_service.list_projects(session)
    return {"items": [ProjectOut.of(p).model_dump() for p in rows]}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_project(body: CreateIn, session: AsyncSession = Depends(get_session)):
    p = await sync_service.create_project(session, name=body.name, content=body.content)
    await session.commit()
    return _full(p)


@router.get("/{project_id}")
async def get_project(project_id: str, session: AsyncSession = Depends(get_session)):
    p = await sync_service.get_project(session, project_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    return _full(p)


@router.put("/{project_id}/sync")
async def push_project(project_id: str, body: PushIn, session: AsyncSession = Depends(get_session)):
    """本地 → 服务端。revision 不匹配返回 409 并附带服务端最新内容。"""
    try:
        p = await sync_service.push(
            session,
            project_id,
            base_revision=body.base_revision,
            content=body.content,
            name=body.name,
            force=body.force,
        )
    except sync_service.SyncConflict as exc:
        await session.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "服务端已有更新的版本",
                "server_revision": exc.server.revision,
                "server_content": exc.server.content,
                "server_updated_at": exc.server.updated_at.isoformat(),
            },
        )
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    await session.commit()
    return _full(p)


@router.get("/{project_id}/pull")
async def pull_project(
    project_id: str,
    since_revision: int | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """服务端 → 本地。since_revision 与服务端一致返回 304 语义的 null。"""
    try:
        p = await sync_service.pull(session, project_id, since_revision=since_revision)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if p is None:
        return {"updated": False}
    return {"updated": True, **_full(p)}


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: str, session: AsyncSession = Depends(get_session)):
    try:
        await sync_service.soft_delete(session, project_id)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    await session.commit()


# ---------------- 版本 ----------------


@router.get("/{project_id}/versions")
async def versions(project_id: str, session: AsyncSession = Depends(get_session)):
    rows = await sync_service.list_versions(session, project_id)
    return {
        "items": [
            {
                "id": v.id,
                "name": v.name,
                "base_revision": v.base_revision,
                "size_bytes": v.size_bytes,
                "created_at": v.created_at.isoformat(),
            }
            for v in rows
        ]
    }


@router.post("/{project_id}/versions", status_code=status.HTTP_201_CREATED)
async def save_version(project_id: str, body: VersionIn, session: AsyncSession = Depends(get_session)):
    try:
        v = await sync_service.save_version(
            session,
            project_id,
            name=body.name,
            project_snapshot=body.project_snapshot,
            asset_snapshots=body.asset_snapshots,
            folder_snapshots=body.folder_snapshots,
        )
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    await session.commit()
    return {
        "id": v.id,
        "name": v.name,
        "base_revision": v.base_revision,
        "created_at": v.created_at.isoformat(),
    }


@router.post("/{project_id}/versions/{version_id}/restore")
async def restore(project_id: str, version_id: str, session: AsyncSession = Depends(get_session)):
    try:
        p = await sync_service.restore_version(session, project_id, version_id)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目或版本不存在")
    await session.commit()
    return _full(p)
