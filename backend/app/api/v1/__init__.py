"""API v1 汇总路由。"""
from fastapi import APIRouter

from app.api.v1 import assets, icons, llm, mcp, projects, uploads, web
from app.core.config import get_settings

api_router = APIRouter(prefix=get_settings().API_PREFIX)
api_router.include_router(projects.router)
api_router.include_router(uploads.router)
api_router.include_router(assets.router)
api_router.include_router(icons.router)
api_router.include_router(llm.router)
api_router.include_router(mcp.router)
api_router.include_router(web.router)


@api_router.get("/health", tags=["system"])
async def health():
    return {"status": "ok", "service": "card_arts-api"}
