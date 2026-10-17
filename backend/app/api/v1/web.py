"""联网能力：搜索 + 抓网页正文。

给项目内智能体用——前端受同源策略限制抓不到任意站点，所以由本机后端代跑。
设计上刻意保持"零额外依赖"：httpx 发请求，正则抽正文，避免引入
readability / bs4 这类体积不小的库。

搜索通道：
  * duckduckgo —— 默认，免 key，抓 https://html.duckduckgo.com/html/ 解析
  * tavily / brave / serper —— 带 api_key 时可用，结果更结构化、更稳
密钥可在请求体里带（前端配置），也可用环境变量 WEB_SEARCH_API_KEY 兜底。
"""
from __future__ import annotations

import html as html_lib
import os
import re

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.http_client import async_client

router = APIRouter(prefix="/web", tags=["web"])

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

FETCH_TIMEOUT = 25.0
SEARCH_TIMEOUT = 20.0
MAX_CHARS = 24000


class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    provider: str = "duckduckgo"
    api_key: str = ""
    max_results: int = Field(8, ge=1, le=20)
    lang: str = "zh"


class FetchBody(BaseModel):
    url: str
    max_chars: int = Field(MAX_CHARS, ge=500, le=120000)
    """news / article / markdown —— 目前统一按"去噪正文"处理"""
    mode: str = "article"


class SearchItem(BaseModel):
    title: str
    url: str
    snippet: str = ""
    source: str = ""


def _strip_tags(s: str) -> str:
    s = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", s)
    s = re.sub(r"(?is)<br\s*/?>", "\n", s)
    s = re.sub(r"(?is)</(p|div|li|tr|h[1-6]|section|article)\s*>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", "", s)
    s = html_lib.unescape(s)
    s = re.sub(r"[ \t\u00a0]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _blocks(s: str, max_chars: int) -> str:
    """去掉导航/页脚这类噪声行，再截断。"""
    lines = [ln.strip() for ln in s.split("\n")]
    keep: list[str] = []
    for ln in lines:
        if not ln:
            if keep and keep[-1] != "":
                keep.append("")
            continue
        if len(ln) < 2 and not ln.isalnum():
            continue
        keep.append(ln)
    out = "\n".join(keep).strip()
    if len(out) > max_chars:
        out = out[:max_chars] + "\n…（已截断）"
    return out


def _first(pattern: str, text: str, default: str = "") -> str:
    m = re.search(pattern, text, re.S | re.I)
    return m.group(1).strip() if m else default


# ---------------------------------------------------------------- 搜索


async def _search_ddg(q: str, n: int, lang: str) -> list[SearchItem]:
    region = "cn-zh" if lang.startswith("zh") else "us-en"
    url = "https://html.duckduckgo.com/html/"
    data = {"q": q, "kl": region}
    async with async_client(url, SEARCH_TIMEOUT) as cli:
        r = await cli.post(url, data=data, headers={"User-Agent": UA})
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"DuckDuckGo 返回 {r.status_code}")

    doc = r.text
    items: list[SearchItem] = []
    # 每条结果大致是 <a class="result__a" href="...">标题</a> ... <a class="result__snippet">摘要</a>
    for m in re.finditer(
        r'(?is)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'(?:<a[^>]*class="result__snippet"[^>]*>(.*?)</a>)?',
        doc,
    ):
        href, title, snip = m.group(1), m.group(2), m.group(3) or ""
        href = html_lib.unescape(href)
        # DDG 有时包一层 /l/?uddg=<真实地址>
        mu = re.search(r"uddg=([^&]+)", href)
        if mu:
            from urllib.parse import unquote

            href = unquote(mu.group(1))
        if not href.startswith("http"):
            continue
        items.append(
            SearchItem(
                title=_strip_tags(title),
                url=href,
                snippet=_strip_tags(snip),
                source="duckduckgo",
            )
        )
        if len(items) >= n:
            break
    return items


async def _search_tavily(q: str, n: int, key: str) -> list[SearchItem]:
    async with async_client("https://api.tavily.com", SEARCH_TIMEOUT) as cli:
        r = await cli.post(
            "https://api.tavily.com/search",
            json={"api_key": key, "query": q, "max_results": n, "search_depth": "basic"},
        )
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Tavily 返回 {r.status_code}：{r.text[:200]}")
    data = r.json()
    return [
        SearchItem(
            title=x.get("title", ""),
            url=x.get("url", ""),
            snippet=x.get("content", "")[:600],
            source="tavily",
        )
        for x in (data.get("results") or [])[:n]
    ]


async def _search_brave(q: str, n: int, key: str) -> list[SearchItem]:
    async with async_client("https://api.search.brave.com", SEARCH_TIMEOUT) as cli:
        r = await cli.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": q, "count": n},
            headers={"X-Subscription-Token": key, "Accept": "application/json"},
        )
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Brave 返回 {r.status_code}：{r.text[:200]}")
    data = r.json()
    out: list[SearchItem] = []
    for x in (data.get("web", {}).get("results") or [])[:n]:
        out.append(
            SearchItem(
                title=_strip_tags(x.get("title", "")),
                url=x.get("url", ""),
                snippet=_strip_tags(x.get("description", "")),
                source="brave",
            )
        )
    return out


async def _search_serper(q: str, n: int, key: str) -> list[SearchItem]:
    async with async_client("https://google.serper.dev", SEARCH_TIMEOUT) as cli:
        r = await cli.post(
            "https://google.serper.dev/search",
            json={"q": q, "num": n},
            headers={"X-API-KEY": key, "Content-Type": "application/json"},
        )
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Serper 返回 {r.status_code}：{r.text[:200]}")
    data = r.json()
    return [
        SearchItem(
            title=x.get("title", ""),
            url=x.get("link", ""),
            snippet=x.get("snippet", ""),
            source="serper",
        )
        for x in (data.get("organic") or [])[:n]
    ]


async def _search_wikipedia(q: str, n: int, lang: str) -> list[SearchItem]:
    """维基百科检索：免 key、结构化 JSON，适合查术语 / 桌游资料。"""
    host = "zh.wikipedia.org" if lang.startswith("zh") else "en.wikipedia.org"
    api = f"https://{host}/w/api.php"
    async with async_client(api, SEARCH_TIMEOUT) as cli:
        r = await cli.get(
            api,
            params={
                "action": "query", "list": "search", "srsearch": q,
                "format": "json", "srlimit": n, "utf8": 1,
            },
            headers={"User-Agent": UA},
        )
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"维基百科返回 {r.status_code}")
    data = r.json()
    out: list[SearchItem] = []
    for x in (data.get("query", {}).get("search") or [])[:n]:
        title = x.get("title", "")
        out.append(
            SearchItem(
                title=title,
                url=f"https://{host}/wiki/{title.replace(' ', '_')}",
                snippet=_strip_tags(x.get("snippet", "")),
                source="wikipedia",
            )
        )
    return out


@router.post("/search", response_model=list[SearchItem])
async def search(body: SearchBody):
    q = body.query.strip()
    if not q:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "query 不能为空")
    n = body.max_results
    key = body.api_key or os.getenv("WEB_SEARCH_API_KEY", "")
    p = (body.provider or "duckduckgo").lower()

    try:
        if p == "tavily":
            return await _search_tavily(q, n, key)
        if p == "brave":
            return await _search_brave(q, n, key)
        if p == "serper":
            return await _search_serper(q, n, key)
        if p == "wikipedia":
            return await _search_wikipedia(q, n, body.lang)
        if p in ("auto", ""):
            # 先试通用搜索，一条都没有再退回维基百科
            try:
                items = await _search_ddg(q, n, body.lang)
                if items:
                    return items
            except Exception:  # noqa: BLE001
                pass
            return await _search_wikipedia(q, n, body.lang)
        return await _search_ddg(q, n, body.lang)
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"搜索服务不可达：{e}") from e


# ---------------------------------------------------------------- 抓网页


@router.post("/fetch")
async def fetch(body: FetchBody):
    url = body.url.strip()
    if not re.match(r"^https?://", url):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "url 必须以 http(s):// 开头")

    try:
        async with async_client(url, FETCH_TIMEOUT) as cli:
            r = await cli.get(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    except httpx.HTTPError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"无法打开该地址：{e}") from e

    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"目标返回 {r.status_code}")

    ctype = (r.headers.get("content-type") or "").lower()
    raw = r.text

    if "html" in ctype or raw.lstrip()[:200].lower().find("<html") >= 0 or "<body" in raw[:4000].lower():
        title = _first(r"(?is)<title[^>]*>(.*?)</title>", raw)
        body_html = _first(r"(?is)<body[^>]*>(.*?)</body>", raw, raw)
        # 优先取正文容器，退化到整个 body
        for pat, min_len in (
            (r"(?is)<article\b[^>]*>(.*?)</article>", 80),
            (r"(?is)<main\b[^>]*>(.*?)</main>", 80),
            (r'(?is)<div[^>]*(?:id|class)="[^"]*(?:content|article|post|markdown)[^"]*"[^>]*>(.*?)</div>', 200),
        ):
            m = re.search(pat, body_html)
            if m and len(m.group(1)) > min_len:
                body_html = m.group(1)
                break
        text = _blocks(_strip_tags(body_html), body.max_chars)
        return {
            "url": str(r.url),
            "title": html_lib.unescape(title)[:200],
            "content_type": ctype.split(";")[0],
            "text": text,
            "chars": len(text),
        }

    # 非 HTML：JSON / 纯文本 / CSV 之类直接回原文
    text = raw[: body.max_chars]
    return {
        "url": str(r.url),
        "title": "",
        "content_type": ctype.split(";")[0] or "text/plain",
        "text": text,
        "chars": len(text),
    }
