"""CardArts API 入口。

启动：
    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.v1 import api_router
from app.core.config import get_settings
from app.db.session import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title=s.APP_NAME,
        version="0.1.0",
        description="CardArts 本地优先卡牌设计工具的后端：项目同步 / 素材上传 / MCP 智能体",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)

    # 内置图标库静态挂载（game-icons.net, CC BY 3.0）
    # 前端 <img src="/game-icons/{author}/{name}.svg"> 即可渲染
    if s.ICON_DIR.exists():
        app.mount(
            s.ICON_URL_PREFIX,
            StaticFiles(directory=str(s.ICON_DIR), check_dir=False),
            name="game-icons",
        )

    @app.get("/")
    async def root():
        return {
            "name": s.APP_NAME,
            "docs": "/docs",
            "api": s.API_PREFIX,
            "storage": s.STORAGE_BACKEND,
            "icons": s.ICON_URL_PREFIX,
        }

    return app


app = create_app()
