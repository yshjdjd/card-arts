"""game-icons 内置图标库检索。

图标来自 game-icons.net（CC BY 3.0），目录结构：

    data/game-icons/{author}/{name}.svg
    data/game-icons/catalog.json   -> [{"id","name","author"}, ...]  # id = "{author}/{name}"

catalog.json 缺失时会自动扫描目录重建，因此只要把 svg 拷进目录即可工作。
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from app.core.config import get_settings


def catalog_path() -> Path:
    return get_settings().ICON_CATALOG


def icon_root() -> Path:
    return get_settings().ICON_DIR


def _scan_dir() -> list[dict]:
    """无 catalog.json 时回退：直接扫目录。"""
    root = icon_root()
    if not root.exists():
        return []
    out: list[dict] = []
    for svg in root.rglob("*.svg"):
        rel = svg.relative_to(root).with_suffix("").as_posix()
        author, _, name = rel.rpartition("/")
        out.append({"id": rel, "name": name or rel, "author": author or ""})
    out.sort(key=lambda x: x["id"])
    return out


@lru_cache(maxsize=1)
def _load() -> tuple[dict, ...]:
    p = catalog_path()
    data: list[dict] | None = None
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = None
    if not data:
        data = _scan_dir()
    for it in data:
        it.setdefault("author", it.get("id", "").split("/")[0] if it.get("id") else "")
        it.setdefault("name", it.get("id", "").rpartition("/")[2])
    return tuple(data)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", (s or "").lower())


def icon_url(icon_id: str) -> str:
    return f"{get_settings().ICON_URL_PREFIX}/{icon_id}.svg"


def _out(it: dict) -> dict:
    iid = it.get("id", "")
    return {
        "id": iid,
        "name": it.get("name", ""),
        "author": it.get("author", ""),
        "url": icon_url(iid),
    }


def search(
    query: str = "",
    limit: int = 60,
    *,
    author: str | None = None,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """模糊检索。返回 (本页结果, 命中总数)，便于前端做分页 / 虚拟滚动。"""
    rows = _load()
    if not rows:
        return [], 0

    q = _norm(query)
    a = _norm(author or "")
    matched: list[tuple[int, dict]] = []

    for it in rows:
        name, auth = it.get("name", ""), it.get("author", "")
        if a and a not in _norm(auth):
            continue
        if q:
            nn, na = _norm(name), _norm(auth)
            if q in nn:
                rank = 0 if nn.startswith(q) else (1 if nn == q else 2)
            elif q in na:
                rank = 3
            else:
                continue
        else:
            rank = 4
        matched.append((rank, it))

    matched.sort(key=lambda x: (x[0], x[1]["id"]))
    total = len(matched)
    page = matched[offset: offset + max(1, limit)]
    return [_out(it) for _, it in page], total


def authors() -> list[dict]:
    counts: dict[str, int] = {}
    for it in _load():
        a = it.get("author", "")
        counts[a] = counts.get(a, 0) + 1
    return [{"author": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]


def get(icon_id: str) -> dict | None:
    if not icon_id or "/" not in icon_id or ".." in icon_id:
        return None
    for it in _load():
        if it.get("id") == icon_id:
            return _out(it)
    return None


def read_svg(icon_id: str) -> bytes:
    """读取图标源文件字节，用于「加入自建素材库」。"""
    if get(icon_id) is None:
        raise FileNotFoundError(icon_id)
    p = icon_root() / f"{icon_id}.svg"
    if not p.exists():
        raise FileNotFoundError(icon_id)
    return p.read_bytes()


def stats() -> dict:
    rows = _load()
    return {
        "loaded": bool(rows),
        "count": len(rows),
        "url_prefix": get_settings().ICON_URL_PREFIX,
        "license": "game-icons.net — CC BY 3.0",
    }
