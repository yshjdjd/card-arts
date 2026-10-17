"""全局配置。所有值均可通过环境变量或 backend/.env 覆盖。"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/
ROOT_DIR = BASE_DIR.parent                      # card_arts/  —— 整个项目的工作目录根


def _data_root() -> Path:
    """数据根目录：默认放在工作目录根的 data/ 下，可用 CARDARTS_DATA_DIR 覆盖。

    之所以不放在 backend/data/，是为了让「数据库 + 素材 + 版本」与前端、文档
    处在同一层，备份 / git 归档 / 迁移时只需打包一个目录。
    """
    env = os.environ.get("CARDARTS_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return ROOT_DIR / "data"


DATA_DIR = _data_root()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- 应用 ----
    APP_NAME: str = "CardArts API"
    API_PREFIX: str = "/api/v1"
    DEBUG: bool = False

    # ---- 数据库 ----
    # 本地优先场景下默认 SQLite；生产可换成 postgresql+psycopg://...
    DATABASE_URL: str = f"sqlite+aiosqlite:///{DATA_DIR / 'card_arts.db'}"

    # ---- 对象存储 ----
    # local | s3
    STORAGE_BACKEND: str = "local"
    STORAGE_LOCAL_ROOT: Path = DATA_DIR / "objects"
    S3_ENDPOINT: str | None = None
    S3_BUCKET: str | None = None
    S3_ACCESS_KEY: str | None = None
    S3_SECRET_KEY: str | None = None
    S3_REGION: str = "us-east-1"

    # ---- 上传 ----
    UPLOAD_CHUNK_SIZE: int = 4 * 1024 * 1024  # 4 MiB
    UPLOAD_MAX_SIZE: int = 2 * 1024 * 1024 * 1024  # 单文件 2 GiB
    UPLOAD_TMP_ROOT: Path = DATA_DIR / "uploads"
    UPLOAD_SESSION_TTL_HOURS: int = 24

    # 允许上传的素材类型
    ASSET_IMAGE_TYPES: tuple[str, ...] = ("image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml")
    ASSET_FONT_TYPES: tuple[str, ...] = ("font/woff2", "font/woff", "font/ttf", "font/otf", "application/font-woff2")

    # ---- 内置图标库（game-icons.net, CC BY 3.0）----
    # 目录结构：{ICON_DIR}/{author}/{name}.svg
    ICON_DIR: Path = DATA_DIR / "game-icons"
    ICON_CATALOG: Path = DATA_DIR / "game-icons" / "catalog.json"
    # 浏览器访问前缀（main.py 里做静态挂载）
    ICON_URL_PREFIX: str = "/game-icons"
    ICON_DEFAULT_PAGE_SIZE: int = 60

    # ---- 图片处理 ----
    IMAGE_THUMB_WIDTH: int = 256
    IMAGE_MEDIUM_WIDTH: int = 1024
    IMAGE_WEBP_QUALITY: int = 88
    IMAGE_MAX_PIXELS: int = 4096  # 单边上限，与 TTS 卡片表要求一致

    # ---- MCP ----
    MCP_ENABLED: bool = True
    MCP_TRANSPORT: str = "stdio"  # stdio | sse | streamable-http
    MCP_HOST: str = "127.0.0.1"
    MCP_PORT: int = 8765

    # ---- CORS ----
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def allowed_asset_types(self) -> tuple[str, ...]:
        return self.ASSET_IMAGE_TYPES + self.ASSET_FONT_TYPES

    def ensure_dirs(self) -> None:
        for p in (self.STORAGE_LOCAL_ROOT, self.UPLOAD_TMP_ROOT):
            p.mkdir(parents=True, exist_ok=True)
        if self.DATABASE_URL.startswith("sqlite"):
            db_path = self.DATABASE_URL.split("///", 1)[-1]
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s


def _env_override() -> None:  # 便于测试时清理缓存
    get_settings.cache_clear()


os.environ.setdefault("PYTHONIOENCODING", "utf-8")
