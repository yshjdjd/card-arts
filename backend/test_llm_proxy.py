"""验证大模型代理：起一个假的 OpenAI 兼容服务，走 /api/v1/llm/* 打一遍。

用法：先启动后端（uvicorn app.main:app --port 8000），再运行本脚本。
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 59998
BASE = f"http://127.0.0.1:{PORT}/v1"


class FakeLLM(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 静音
        pass

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._send(200, {"data": [{"id": "fake-model-a"}, {"id": "fake-model-b"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        auth = self.headers.get("Authorization") or ""

        if self.path.startswith("/v1/chat/completions"):
            if "secret-key" not in auth:
                self._send(401, {"error": "bad key"})
                return
            self._send(200, {
                "model": body.get("model", "fake"),
                "choices": [{"message": {"role": "assistant", "content": f"收到 {len(body.get('messages', []))} 条消息"}}],
                "usage": {"total_tokens": 7},
            })
        else:
            self._send(404, {"error": "not found"})


def main() -> None:
    srv = HTTPServer(("127.0.0.1", PORT), FakeLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[0] 假模型服务已启动 {BASE}")

    import httpx

    api = "http://127.0.0.1:8000/api/v1"

    # 1. 连通性测试（正确密钥）
    r = httpx.post(f"{api}/llm/test", json={"base_url": BASE, "api_key": "secret-key", "model": "fake-model-a"}, timeout=30)
    d = r.json()
    assert r.status_code == 200 and d.get("ok"), f"探活失败：{r.status_code} {d}"
    assert "fake-model-a" in (d.get("models") or []), f"模型列表缺失：{d}"
    print(f"[1] 探活 ok：{d['message']}｜模型 {d['models']}")

    # 2. 错误密钥应被识别为不通
    r = httpx.post(f"{api}/llm/test", json={"base_url": BASE, "api_key": "wrong", "model": "fake-model-a"}, timeout=30)
    d = r.json()
    assert d.get("ok") is False, "错误密钥竟然通过了"
    print("[2] 错误密钥正确识别为不通 ✅")

    # 3. 正式对话
    r = httpx.post(f"{api}/llm/chat", json={
        "base_url": BASE,
        "api_key": "secret-key",
        "model": "fake-model-a",
        "messages": [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "你好"},
        ],
        "temperature": 0.2,
        "max_tokens": 64,
    }, timeout=30)
    d = r.json()
    assert r.status_code == 200, f"对话失败：{r.status_code} {r.text[:200]}"
    assert "2 条消息" in d.get("content", ""), f"回复内容异常：{d}"
    print(f"[3] 对话 ok：{d['content']}（model={d['model']}）")

    # 4. 模型列表
    r = httpx.post(f"{api}/llm/models", json={"base_url": BASE, "api_key": "secret-key"}, timeout=30)
    assert r.status_code == 200 and r.json().get("models"), f"拉取模型失败：{r.status_code}"
    print(f"[4] 模型列表 ok：{r.json()['models']}")

    # 5. 非法 base_url 应被拒绝
    r = httpx.post(f"{api}/llm/chat", json={"base_url": "not-a-url", "api_key": "x", "model": "m", "messages": []}, timeout=15)
    assert r.status_code == 400, f"非法地址未被拦截：{r.status_code}"
    print("[5] 非法接口地址被拦截 ✅")

    srv.shutdown()
    print("\n全部通过 ✅")


if __name__ == "__main__":
    main()
