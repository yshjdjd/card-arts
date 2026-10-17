"""验证联网接口 /api/v1/web/*：起一个假网站测抓取，再试一次真实搜索。

用法：先启动后端（uvicorn app.main:app --port 8000），再运行本脚本。
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx

SITE_PORT = 59997
API = "http://127.0.0.1:8000/api/v1/web"

PAGE = """<!DOCTYPE html>
<html><head><title>测试页面 - 卡牌尺寸</title>
<script>var junk = "不应该出现在正文里";</script>
<style>body { color: red }</style>
</head>
<body>
<nav class="nav">首页 关于 联系</nav>
<div class="content">
  <article>
    <h1>标准卡牌尺寸</h1>
    <p>扑克牌是 63.5 x 88.9 毫米，在 300 DPI 下等于 750 x 1050 像素。</p>
    <p>塔罗牌通常更大，为 69.9 x 120.7 毫米。</p>
    <ul><li>桥牌 57.2 x 88.9</li><li>欧式 59 x 92</li></ul>
  </article>
</div>
<footer>版权所有</footer>
</body></html>
"""


class FakeSite(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/plain.txt":
            body = b"colA,colB\n1,2\n3,4\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
        else:
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    srv = HTTPServer(("127.0.0.1", SITE_PORT), FakeSite)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[0] 假网站已启动 http://127.0.0.1:{SITE_PORT}/")

    ok_n = 0
    fail_n = 0

    def check(cond: bool, name: str, extra: str = "") -> None:
        nonlocal ok_n, fail_n
        if cond:
            ok_n += 1
            print(f"  [OK] {name}")
        else:
            fail_n += 1
            print(f"  [FAIL] {name} {extra}")

    # trust_env=False：环境里可能配了 HTTP_PROXY，会把 127.0.0.1 也送去代理
    with httpx.Client(timeout=40.0, trust_env=False) as cli:
        # 1. 抓 HTML
        r = cli.post(f"{API}/fetch", json={"url": f"http://127.0.0.1:{SITE_PORT}/page.html"})
        check(r.status_code == 200, "fetch 返回 200", r.text[:200])
        d = r.json()
        check("卡牌尺寸" in d.get("title", ""), "抽出标题", d.get("title"))
        check("750 x 1050" in d.get("text", ""), "正文含关键数据")
        check("塔罗牌" in d.get("text", ""), "正文含第二段")
        check("不应该出现在正文里" not in d.get("text", ""), "script 内容被剔除")
        check("版权所有" not in d.get("text", ""), "footer 噪声被剔除")
        check(d.get("chars", 0) > 50, "返回字符数")

        # 2. 抓非 HTML（CSV 原样返回）
        r = cli.post(f"{API}/fetch", json={"url": f"http://127.0.0.1:{SITE_PORT}/plain.txt"})
        d = r.json()
        check(r.status_code == 200 and "colA,colB" in d.get("text", ""), "CSV 原样返回")

        # 3. 非法 url 被拦
        r = cli.post(f"{API}/fetch", json={"url": "ftp://x/y"})
        check(r.status_code == 400, "非 http(s) 被拦截")

        # 4. 搜索（需要外网，不通则跳过）
        r = cli.post(f"{API}/search", json={"query": "poker card size mm", "max_results": 5})
        if r.status_code == 200:
            items = r.json()
            check(isinstance(items, list), "search 返回列表")
            if items:
                check(all(i.get("url", "").startswith("http") for i in items), "搜索结果都带 http 链接")
                print(f"       示例：{items[0].get('title', '')[:50]} -> {items[0].get('url', '')[:60]}")
            else:
                print("       （本次没搜到结果，可能是外网不通或 DDG 改版）")
        else:
            print(f"  [SKIP] 搜索不可用（{r.status_code}），多半是无外网：{r.text[:120]}")

        # 5. 空 query 被拦
        r = cli.post(f"{API}/search", json={"query": "   "})
        check(r.status_code == 400, "空 query 被拦截", str(r.status_code))

    srv.shutdown()
    print(f"\n通过 {ok_n} / 失败 {fail_n}")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
