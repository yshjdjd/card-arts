"""验证「按 URL 导入图片」接口。

这是智能体唯一能自己拿到图片的通道：前端直连外链会被 CORS 拦，
所以下载必须由后端代劳。这里用一个本地假站点喂各种极端情况，不依赖外网。

运行前先启动后端：
    uvicorn app.main:app --port 8000
然后：
    python test_asset_import.py
"""
from __future__ import annotations

import io
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
from PIL import Image

BASE = "http://127.0.0.1:8000/api/v1"
PORT = 59996


def make_png(w: int = 240, h: int = 240, color: tuple[int, int, int] = (200, 40, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


PNG = make_png()
JPEG = (lambda: (lambda b: (Image.new("RGB", (80, 60), (10, 90, 200)).save(b, "JPEG"), b.getvalue())[1])(io.BytesIO()))()
# 每个路径用不同颜色的图，否则会被内容寻址去重合并（那本身是对的，但测不出各自入库）
PNG_B = make_png(200, 200, (30, 120, 60))
PNG_C = make_png(160, 160, (250, 200, 20))
PNG_D = make_png(140, 140, (90, 60, 220))


class FakeSite(BaseHTTPRequestHandler):
    """刻意包含各种不规范的响应，用来验证扩展名/魔术字节兜底。"""

    def log_message(self, *a):
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/ok.png":
            self._send(200, PNG, "image/png")
        elif p == "/photo.jpg":
            self._send(200, JPEG, "image/jpeg")
        elif p == "/noext":
            # 很多 CDN 一律返回 octet-stream 且路径没有扩展名
            self._send(200, PNG_B, "application/octet-stream")
        elif p == "/liar.txt":
            # 扩展名骗人，实际是 PNG
            self._send(200, PNG_C, "text/plain")
        elif p == "/notimage.txt":
            self._send(200, b"just some plain text " * 10, "text/plain")
        elif p == "/redirect.png":
            self.send_response(302)
            self.send_header("Location", "/final.png")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif p == "/final.png":
            self._send(200, PNG_D, "image/png")
        elif p == "/gone.png":
            self._send(404, b"nope", "text/plain")
        else:
            self._send(404, b"", "text/plain")


def main() -> int:
    srv = HTTPServer(("127.0.0.1", PORT), FakeSite)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    site = f"http://127.0.0.1:{PORT}"

    c = httpx.Client(base_url=BASE, timeout=60.0, trust_env=False)
    pid = c.post("/projects", json={"name": "导入测试", "content": {"decks": [], "documents": []}}).json()["id"]

    passed = failed = 0

    def check(cond: bool, name: str, extra: str = ""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  [OK] {name}")
        else:
            failed += 1
            print(f"  [FAIL] {name} {extra}")

    print("[1] 正常导入")
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/ok.png"})
    check(r.status_code == 201, "返回 201", f"{r.status_code} {r.text[:200]}")
    if r.status_code != 201:
        srv.shutdown()
        print(f"\n结果：{passed} 通过 / {failed} 失败")
        return 1 if failed else 0
    a = r.json()["asset"]
    check(a["kind"] == "image", "识别成图片", str(a))
    check(a["mime"] == "image/png", "mime 正确", a["mime"])
    check(a["name"] == "ok.png", "文件名取自 URL", a["name"])
    # 入库后能取回内容
    got = c.get(f"/assets/{a['id']}/content")
    check(got.status_code == 200 and got.content == PNG, "内容字节一致")

    print("[2] jpg 也能导入")
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/photo.jpg", "name": "我的图.jpg"})
    a2 = r.json()["asset"]
    check(r.status_code == 201 and a2["mime"] == "image/jpeg", "按 Content-Type 识别", a2.get("mime"))
    check(a2["name"] == "我的图.jpg", "name 参数优先", a2["name"])

    print("[3] 站点返回 octet-stream / 扩展名骗人时靠魔术字节兜底")
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/noext"})
    check(r.status_code == 201, "无扩展名 + octet-stream 也能入库", str(r.status_code))
    check(r.json()["asset"]["mime"] == "image/png", "魔术字节判定为 png", r.json()["asset"]["mime"])
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/liar.txt"})
    check(r.status_code == 201, "扩展名骗人时也能入库", str(r.status_code))

    print("[4] 重定向后仍能拿到")
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/redirect.png"})
    check(r.status_code == 201 and r.json()["asset"]["mime"] == "image/png", "跟随 302", str(r.status_code))

    print("[5] 各种失败要有明确报错，而不是留个坏素材")
    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/notimage.txt"})
    check(r.status_code == 400, "非图片被拒", str(r.status_code))
    check("不是图片" in r.text, "报错说明原因", r.text[:120])

    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/gone.png"})
    check(r.status_code == 400 and "404" in r.text, "404 被拒", r.text[:120])

    r = c.post("/assets/import-url", json={"project_id": pid, "url": "ftp://x/y.png"})
    check(r.status_code == 400, "非 http 协议被拒", str(r.status_code))

    r = c.post("/assets/import-url", json={"project_id": "不存在的", "url": f"{site}/ok.png"})
    check(r.status_code == 404, "项目不存在报 404", str(r.status_code))

    r = c.post("/assets/import-url", json={"project_id": pid, "url": f"http://127.0.0.1:1/x.png"})
    check(r.status_code == 400, "连不上时给出下载失败", str(r.status_code))

    print("[6] 导入的素材出现在素材库清单里")
    items = c.get("/assets", params={"project_id": pid, "kind": "image"}).json()["items"]
    names = sorted(x["name"] for x in items)
    check(len(items) >= 4, "清单里有导入的图", str(names))
    check(any(x["id"] == a["id"] for x in items), "能按 id 找到")

    print("[7] 同一张图重复导入走秒传，不会产生重复素材")
    before = len(c.get("/assets", params={"project_id": pid}).json()["items"])
    c.post("/assets/import-url", json={"project_id": pid, "url": f"{site}/ok.png"})
    after = len(c.get("/assets", params={"project_id": pid}).json()["items"])
    check(after == before, "内容相同则复用已有素材", f"{before} -> {after}")

    srv.shutdown()
    print(f"\n结果：{passed} 通过 / {failed} 失败")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
