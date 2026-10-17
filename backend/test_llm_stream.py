"""验证大模型代理的流式透传 POST /api/v1/llm/chat。

流式存在的意义：不放流的话，用户在界面上会盯着空白等十几秒才一次性出字（"卡住"）。
本脚本起一个假的 OpenAI 兼容端点，分别测：

  1. stream=true  → 后端原样透传上游 SSE，边收边转发（而不是等全部收完）
  2. stream=false → 仍走聚合，返回 {"content": "..."}
  3. 上游报错      → 通过一条 error 事件告知前端并正常收尾，绝不挂起

用法：先启动后端（uvicorn app.main:app --port 8000），再运行本脚本。
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx

UPSTREAM_PORT = 59998
API = "http://127.0.0.1:8000/api/v1/llm"

CHUNKS = ["你", "好", "，", "这", "是", "流", "式"]
FULL = "".join(CHUNKS)
THINKING = "先想清楚再回答"


class FakeUpstream(BaseHTTPRequestHandler):
    """假模型服务：按 stream 标志决定返回 SSE 还是整段 JSON。"""

    mode = "stream"  # stream | error
    seen: dict | None = None  # 记下最近一次收到的请求体，用来断言参数透传

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0)
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            payload = {}
        FakeUpstream.seen = payload

        if FakeUpstream.mode == "error":
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            out = json.dumps({"error": "boom"}).encode()
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if payload.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            # 第一段立刻发出，然后**故意卡住** STALL 秒再发剩下的。
            # 若后端"收完再发"，首包必然晚于 STALL；边收边转发则首包几乎立刻到达。
            # 这样区分度足够大，不会被网络抖动掩盖。
            STALL = 1.5
            for i, c in enumerate(CHUNKS):
                evt = {"choices": [{"delta": {"content": c}}]}
                # finish_reason 只在最后一片出现（真实厂商就是这么发的）
                if i == len(CHUNKS) - 1:
                    evt["choices"][0]["finish_reason"] = "stop"
                self.wfile.write(f"data: {json.dumps(evt, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(STALL if i == 0 else 0.02)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        out = json.dumps(
            {
                "choices": [
                    {
                        # reasoning_content 与 content 同级（DeepSeek 就是这么给的）
                        "message": {"content": FULL, "reasoning_content": THINKING},
                        "finish_reason": "stop",
                    }
                ],
                "model": "fake",
            },
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main() -> int:
    srv = HTTPServer(("127.0.0.1", UPSTREAM_PORT), FakeUpstream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{UPSTREAM_PORT}/v1"
    print(f"[0] 假模型服务已启动 {base}")

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
        FakeUpstream.mode = "stream"
        body = {
            "base_url": base,
            "api_key": "sk-test",
            "model": "fake",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        }
        # 预热：后端冷启动（首次导入模块/建连）的开销不该算进流式延迟
        cli.post(f"{API}/chat", json={**body, "stream": False})
        t0 = time.time()
        with cli.stream("POST", f"{API}/chat", json=body) as r:
            check(r.status_code == 200, "流式返回 200", str(r.status_code))
            check("text/event-stream" in r.headers.get("content-type", ""), "响应是 SSE",
                  r.headers.get("content-type", ""))
            got = ""
            reason = ""
            first_at = None
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    j = json.loads(data)
                except json.JSONDecodeError:
                    continue
                ch = (j.get("choices") or [{}])[0]
                d = ch.get("delta", {}).get("content")
                if d:
                    if first_at is None:
                        first_at = time.time() - t0
                    got += d
                if ch.get("finish_reason"):
                    reason = ch["finish_reason"]
            check(got == FULL, "逐段拼接还原全文", got)
            check(reason == "stop", "流式也能拿到 finish_reason", reason)
            # 上游第一段之后故意卡 1.5s：收完再发的话首包必然 >1.5s，边收边转发则远早于此
            check(first_at is not None and first_at < 1.0, "首个分片很快到达（边收边转发）",
                  f"首包 {first_at:.3f}s")

        # 2. 非流式仍然聚合（并带回 finish_reason，前端据此提示"被 max_tokens 截断"）
        body2 = {**body, "stream": False}
        r = cli.post(f"{API}/chat", json=body2)
        check(r.status_code == 200, "非流式返回 200", r.text[:160])
        check(r.json().get("content") == FULL, "非流式聚合出全文", r.text[:160])
        check(r.json().get("finish_reason") == "stop", "非流式带回 finish_reason",
              str(r.json().get("finish_reason")))

        # 3. 上游报错：流式也要能正常收尾
        FakeUpstream.mode = "error"
        with cli.stream("POST", f"{API}/chat", json=body) as r:
            text = "".join(r.iter_lines())
        check("[DONE]" in text, "上游报错时仍以 [DONE] 收尾", text[:160])
        check("500" in text or "boom" in text, "错误信息透传给前端", text[:160])

        # 4. 空 base_url 被拦
        r = cli.post(f"{API}/chat", json={**body, "base_url": ""})
        check(r.status_code == 400, "空 base_url 被拦截", str(r.status_code))

        # 5. 思考参数：各家字段名不同，前端算好后塞进 extra，后端原样并进请求体
        FakeUpstream.mode = "stream"  # 第 3 步切成了 error，这里切回来
        FakeUpstream.seen = None
        cli.post(f"{API}/chat", json={
            **body, "stream": False, "extra": {"enable_thinking": True},
        })
        check(FakeUpstream.seen.get("enable_thinking") is True,
              "extra 里的思考参数透传给上游", str(FakeUpstream.seen))

        FakeUpstream.seen = None
        cli.post(f"{API}/chat", json={
            **body, "stream": False, "extra": {"thinking": {"type": "enabled"}},
        })
        check((FakeUpstream.seen.get("thinking") or {}).get("type") == "enabled",
              "thinking:{type} 也能透传", str(FakeUpstream.seen))

        # 6. o 系列：长度字段改名，且不发 temperature（传了会 400）
        FakeUpstream.seen = None
        cli.post(f"{API}/chat", json={
            **body, "stream": False, "model": "o4-mini", "max_completion_tokens": 999,
        })
        p = FakeUpstream.seen or {}
        check(p.get("max_completion_tokens") == 999, "o 系列改用 max_completion_tokens", str(p))
        check("temperature" not in p, "o 系列不发 temperature", str(p))
        check("max_tokens" not in p, "o 系列不发 max_tokens", str(p))

        FakeUpstream.seen = None
        cli.post(f"{API}/chat", json={**body, "stream": False, "model": "deepseek-reasoner"})
        p = FakeUpstream.seen or {}
        check("temperature" not in p, "DeepSeek 思考模式也不发 temperature（传了不生效）", str(p))
        check("max_tokens" in p, "DeepSeek 仍用 max_tokens", str(p))

        # 7. 思考过程要单独回传，好让前端折叠展示
        r = cli.post(f"{API}/chat", json={**body, "stream": False})
        check(r.json().get("reasoning") == THINKING, "非流式带回 reasoning_content",
              str(r.json().get("reasoning")))

    srv.shutdown()
    print(f"\n通过 {ok_n} / 失败 {fail_n}")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
