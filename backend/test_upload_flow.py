"""端到端验证上传链路：初始化 -> 分片 -> 合并 -> 秒传 -> 断点续传 -> 裁切。

运行前先启动后端：
    uvicorn app.main:app --port 8000
然后：
    python test_upload_flow.py
"""
from __future__ import annotations

import hashlib
import io
import json
import sys

import httpx
from PIL import Image

BASE = "http://127.0.0.1:8000/api/v1"


def make_png(w: int = 1200, h: int = 1600) -> bytes:
    """生成一张带随机噪点的 PNG，保证压缩后仍有 1MB+，以便触发多分片。"""
    import random

    rnd = random.Random(42)
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(0, w, 2):  # 隔点填充，速度足够快
            c = (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255))
            px[x, y] = c
            if x + 1 < w:
                px[x + 1, y] = c
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=60)

    # 0. 建项目
    pid = c.post("/projects", json={"name": "上传测试", "content": {"decks": [], "documents": []}}).json()["id"]
    print(f"[0] 项目 {pid}")

    data = make_png()
    sha = hashlib.sha256(data).hexdigest()
    print(f"[1] 测试文件 {len(data)} 字节, sha256={sha[:16]}...")

    # 2. init（故意用很小的分片，验证多分片路径）
    r = c.post("/uploads/init", json={
        "project_id": pid, "filename": "card-art.png", "mime": "image/png",
        "size": len(data), "sha256": sha, "chunk_size": 64 * 1024,
    }).json()
    assert r["instant"] is False, r
    up_id, cs, cnt = r["upload_id"], r["chunk_size"], r["chunk_count"]
    print(f"[2] 会话 {up_id[:8]} 分片数={cnt} 每片={cs}")

    # 3. 先只传一半，模拟中断
    half = cnt // 2
    for i in range(half):
        c.put(f"/uploads/{up_id}/chunk/{i}", content=data[i * cs:(i + 1) * cs])
    st = c.get(f"/uploads/{up_id}/status").json()
    print(f"[3] 中断后已收 {len(st['received'])}/{cnt}，缺失 {len(st['missing'])}")

    # 4. 断点续传：只补缺失分片
    for i in st["missing"]:
        c.put(f"/uploads/{up_id}/chunk/{i}", content=data[i * cs:(i + 1) * cs] if (i + 1) * cs <= len(data) else data[i * cs:])
    print("[4] 补传完成")

    # 5. 合并
    res = c.post(f"/uploads/{up_id}/complete").json()
    asset = res["asset"]
    print(f"[5] 素材 {asset['id'][:8]} 尺寸={asset['meta'].get('width')}x{asset['meta'].get('height')} "
          f"主色={asset['meta'].get('dominant_color')} 派生图={list(asset['variants'].keys())}")

    # 6. 秒传：同样内容再 init 一次
    r2 = c.post("/uploads/init", json={
        "project_id": pid, "filename": "card-art-copy.png", "mime": "image/png",
        "size": len(data), "sha256": sha,
    }).json()
    assert r2["instant"] is True, r2
    print(f"[6] 秒传命中 -> asset {r2['asset']['id'][:8]}（零流量）")

    # 7. 派生图可访问
    tv = c.get(f"/assets/{asset['id']}/variant/thumb")
    print(f"[7] 缩略图 HTTP {tv.status_code}, {len(tv.content)} 字节")

    # 8. 服务端裁切（标准卡牌）
    cr = c.post(f"/assets/{asset['id']}/crop",
                json={"mode": "card", "preset": "poker", "name": "card-art-poker.webp"}).json()
    meta = cr["asset"]["meta"]
    print(f"[8] 裁切产出 {cr['asset']['name']} -> {meta.get('width')}x{meta.get('height')}")

    # 9. 同步：快进 + 冲突
    p = c.get(f"/projects/{pid}").json()
    push = c.put(f"/projects/{pid}/sync", json={
        "base_revision": p["revision"],
        "content": {"decks": [{"id": "d1", "name": "主牌组", "fields": [], "cards": []}], "documents": []},
    }).json()
    print(f"[9] 同步成功 revision={push['revision']} deck_count={push['deck_count']}")

    bad = c.put(f"/projects/{pid}/sync", json={"base_revision": 0, "content": {"decks": []}})
    print(f"[10] 旧 revision 提交 -> HTTP {bad.status_code}（应为 409 冲突）")
    assert bad.status_code == 409

    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
