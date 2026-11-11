"""CardArts API 入口。

启动：
    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1 import api_router
from app.core.config import ROOT_DIR, get_settings
from app.db.session import init_db
from app.core.desktop_auth import DesktopAuth

# 前端构建产物：存在则由后端一并托管（单容器 / 同域部署，前端用相对路径 /api/v1 即可）
WEB_DIST_DIR = ROOT_DIR / "frontend" / "dist"


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
    app.add_middleware(DesktopAuth)

    # 内置图标库静态挂载（game-icons.net, CC BY 3.0）
    # 前端 <img src="/game-icons/{author}/{name}.svg"> 即可渲染
    if s.ICON_DIR.exists():
        app.mount(
            s.ICON_URL_PREFIX,
            StaticFiles(directory=str(s.ICON_DIR), check_dir=False),
            name="game-icons",
        )

    # ---- 前端单页应用托管（可选）----
    # 只有在 frontend/dist 存在时才接管根路径：本地开发走 vite dev server，不受影响。
    # 挂载顺序很关键：api_router 与 /game-icons 均已注册在前，因此本段只兜住剩余的页面路由。
    web_enabled = (WEB_DIST_DIR / "index.html").exists()

    if web_enabled:
        assets_dir = WEB_DIST_DIR / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="web-assets")

        @app.get("/", include_in_schema=False)
        async def index_page():
            return FileResponse(WEB_DIST_DIR / "index.html")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_fallback(full_path: str):
            # 真实存在的静态文件（favicon、worker、静态图等）直接返回
            if full_path:
                candidate = (WEB_DIST_DIR / full_path).resolve()
                try:
                    candidate.relative_to(WEB_DIST_DIR.resolve())
                except ValueError:  # 防目录穿越
                    candidate = None
                if candidate and candidate.is_file():
                    return FileResponse(candidate)
            # 其余一律交给前端路由
            return FileResponse(WEB_DIST_DIR / "index.html")
    else:
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
