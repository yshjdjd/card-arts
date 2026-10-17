"""对象存储抽象：内容寻址 + 本地/S3 双后端。

设计要点
--------
* 写入接口是 `put_bytes(data)`，返回 storage_key = sha256 分片路径。
  相同字节永远得到相同 key，天然去重，秒传只需查 key 是否存在。
* 对外只暴露 bytes 级接口，图片处理、元数据提取在其上层完成，
  这样换存储后端时上层逻辑完全不动。
"""
from __future__ import annotations

import hashlib
import shutil
from abc import ABC, abstractmethod
from pathlib import Path

import aiofiles
from aiofiles import os as aio_os

from app.core.config import get_settings


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def key_for(digest: str, ext: str = "") -> str:
    """把哈希转成 `ab/cd/abcdef...` 形式，避免单目录文件过多。"""
    if ext and not ext.startswith("."):
        ext = "." + ext
    return f"{digest[:2]}/{digest[2:4]}/{digest}{ext}"


class StorageBackend(ABC):
    @abstractmethod
    async def exists(self, key: str) -> bool: ...

    @abstractmethod
    async def put(self, key: str, data: bytes, content_type: str = "") -> None: ...

    @abstractmethod
    async def get(self, key: str) -> bytes: ...

    @abstractmethod
    async def delete(self, key: str) -> None: ...

    @abstractmethod
    async def url(self, key: str, expires: int = 3600) -> str: ...


class LocalStorage(StorageBackend):
    """本地文件系统实现。key 直接映射为相对路径。"""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.root / key

    async def exists(self, key: str) -> bool:
        return await aio_os.path.exists(self._path(key))

    async def put(self, key: str, data: bytes, content_type: str = "") -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # 已存在则跳过写入（去重的关键：不重复落盘）
        if p.exists():
            return
        async with aiofiles.open(p, "wb") as f:
            await f.write(data)

    async def get(self, key: str) -> bytes:
        async with aiofiles.open(self._path(key), "rb") as f:
            return await f.read()

    async def delete(self, key: str) -> None:
        try:
            await aio_os.remove(self._path(key))
        except OSError:
            pass

    async def url(self, key: str, expires: int = 3600) -> str:
        # 本地模式由 API 直接吐字节，这里返回可拼接的相对地址
        return f"/api/v1/objects/{key}"


class S3Storage(StorageBackend):
    """S3 / MinIO 兼容实现（需要 boto3，未安装时导入会提示）。"""

    def __init__(self) -> None:
        try:
            import boto3  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("使用 S3 存储需要安装 boto3: pip install boto3") from exc

        s = get_settings()
        self.bucket = s.S3_BUCKET or "card_arts"
        self.client = boto3.client(
            "s3",
            endpoint_url=s.S3_ENDPOINT,
            aws_access_key_id=s.S3_ACCESS_KEY,
            aws_secret_access_key=s.S3_SECRET_KEY,
            region_name=s.S3_REGION,
        )

    async def exists(self, key: str) -> bool:
        import asyncio  # noqa: PLC0415

        def _head():
            try:
                self.client.head_object(Bucket=self.bucket, Key=key)
                return True
            except Exception:
                return False

        return await asyncio.to_thread(_head)

    async def put(self, key: str, data: bytes, content_type: str = "") -> None:
        import asyncio  # noqa: PLC0415

        def _put():
            self.client.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentType=content_type or "application/octet-stream"
            )

        await asyncio.to_thread(_put)

    async def get(self, key: str) -> bytes:
        import asyncio  # noqa: PLC0415

        def _get():
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

        return await asyncio.to_thread(_get)

    async def delete(self, key: str) -> None:
        import asyncio  # noqa: PLC0415

        await asyncio.to_thread(lambda: self.client.delete_object(Bucket=self.bucket, Key=key))

    async def url(self, key: str, expires: int = 3600) -> str:
        import asyncio  # noqa: PLC0415

        return await asyncio.to_thread(
            lambda: self.client.generate_presigned_url(
                "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires
            )
        )


_storage: StorageBackend | None = None


def get_storage() -> StorageBackend:
    global _storage
    if _storage is None:
        s = get_settings()
        if s.STORAGE_BACKEND == "s3":
            _storage = S3Storage()
        else:
            _storage = LocalStorage(s.STORAGE_LOCAL_ROOT)
    return _storage


async def save_content_addressed(data: bytes, ext: str = "") -> tuple[str, str]:
    """写入并返回 (storage_key, sha256)。已存在则跳过落盘。"""
    digest = sha256_of(data)
    key = key_for(digest, ext)
    await get_storage().put(key, data)
    return key, digest


def tmp_chunk_dir(upload_id: str) -> Path:
    p = get_settings().UPLOAD_TMP_ROOT / upload_id
    p.mkdir(parents=True, exist_ok=True)
    return p


async def cleanup_tmp(upload_id: str) -> None:
    """删除分片临时目录。"""
    p = get_settings().UPLOAD_TMP_ROOT / upload_id
    if p.exists():
        shutil.rmtree(p, ignore_errors=True)
