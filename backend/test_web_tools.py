"""网络工具回归：不请求真实外网，不依赖运行中的 API 服务器。"""
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from app.api.v1 import web


class Client:
    def __init__(self, data=None, error=None):
        self.data, self.error = data, error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        if self.error:
            raise self.error
        return httpx.Response(200, json=self.data, request=httpx.Request("GET", url, params=kwargs.get("params")))


class WebTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_does_not_hide_search_failure_with_encyclopedia(self):
        with patch.object(web, "_search_ddg", AsyncMock(side_effect=httpx.ConnectTimeout("timeout"))), \
             patch.object(web, "_search_wikipedia", AsyncMock()) as wiki:
            with self.assertRaises(HTTPException) as caught:
                await web.search(web.SearchBody(query="今天天气"))
            self.assertEqual(caught.exception.status_code, 502)
            self.assertIn("ConnectTimeout", caught.exception.detail)
            wiki.assert_not_awaited()

    async def test_missing_key_and_unknown_provider_are_explicit(self):
        with patch.dict(web.os.environ, {"WEB_SEARCH_API_KEY": ""}):
            for provider in ("tavily", "brave", "serper", "unknown"):
                with self.assertRaises(HTTPException) as caught:
                    await web.search(web.SearchBody(query="test", provider=provider))
                self.assertEqual(caught.exception.status_code, 400)

    async def test_ddg_parser_attribute_order_classes_redirect_snippet(self):
        parser = web._DDGParser()
        parser.feed("<a href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa' class='x result__a'>A <b>title</b></a>"
                    "<a href='https://example.com/a' class='result__snippet more'>A &amp; B</a>")
        self.assertEqual(parser.items[0].url, "https://example.com/a")
        self.assertEqual(parser.items[0].title, "A title")
        self.assertEqual(parser.items[0].snippet, "A & B")

    async def test_research_deduplicates_and_preserves_partial_failures(self):
        items = [web.SearchItem(title="A", url="https://a.test"), web.SearchItem(title="A2", url="https://a.test"),
                 web.SearchItem(title="B", url="https://b.test")]
        with patch.object(web, "search", AsyncMock(return_value=items)), patch.object(web, "fetch", AsyncMock(
                side_effect=[{"text": "source A", "url": "https://a.test"}, HTTPException(403, "blocked")])) as fetch:
            result = await web.research(web.ResearchBody(query="卡牌设计"))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["read_count"], 1)
        self.assertEqual(fetch.await_count, 2)
        self.assertEqual(result["sources"][1]["error"], "blocked")
        self.assertNotIn("page", result["sources"][1])

    async def test_research_empty_and_all_failed(self):
        with patch.object(web, "search", AsyncMock(return_value=[])):
            with self.assertRaises(HTTPException):
                await web.research(web.ResearchBody(query="x"))
        with patch.object(web, "search", AsyncMock(return_value=[web.SearchItem(title="x", url="https://x.test")])), \
             patch.object(web, "fetch", AsyncMock(side_effect=HTTPException(502, "timeout"))):
            result = await web.research(web.ResearchBody(query="x"))
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["read_count"], 0)


if __name__ == "__main__":
    unittest.main()
