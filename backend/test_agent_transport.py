"""Offline regression tests; no model credentials or running server required."""
import unittest
from unittest.mock import patch

import httpx

from app.api.v1.llm import ChatBody, _iter_upstream, _payload_of


class Response:
    status_code = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def aiter_bytes(self):
        # Preserve SSE multiline event boundaries and fragmented UTF-8 bytes.
        for part in [b'data: {"choices":\r\n', 'data: [{"delta":{"content":"你好"}}]}\r\n\r\n'.encode(), b'data: [DONE]\n\n']:
            yield part


class Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def stream(self, *args, **kwargs):
        return Response()


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_preserves_raw_event_bytes(self):
        with patch('app.api.v1.llm.async_client', return_value=Client()):
            chunks = [part async for part in _iter_upstream('https://example.invalid', {}, '')]
        self.assertEqual(b''.join(chunks), b'data: {"choices":\r\n' + 'data: [{"delta":{"content":"你好"}}]}\r\n\r\n'.encode() + b'data: [DONE]\n\n')

    async def test_network_failure_becomes_explicit_error_event(self):
        class Broken(Client):
            async def __aenter__(self):
                raise httpx.ReadTimeout('upstream stalled')
        with patch('app.api.v1.llm.async_client', return_value=Broken()):
            body = b''.join([part async for part in _iter_upstream('https://example.invalid', {}, '')]).decode()
        self.assertIn('"error"', body)
        self.assertIn('upstream stalled', body)

    def test_completion_limit_is_forwarded_for_reasoning_model(self):
        body = ChatBody(base_url='https://example.invalid', model='o4-mini', messages=[], max_completion_tokens=8192)
        payload = _payload_of(body)
        self.assertEqual(payload['max_completion_tokens'], 8192)
        self.assertNotIn('temperature', payload)


if __name__ == '__main__':
    unittest.main()
