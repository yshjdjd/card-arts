import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.mcp import repository as repo
from app.services.upload_service import normalize_font_mime, validate_font_bytes, UploadError


class FontFiles(unittest.TestCase):
    def test_browser_mime_variants(self):
        self.assertEqual(normalize_font_mime('font.TTF', 'application/octet-stream'), 'font/ttf')
        self.assertEqual(normalize_font_mime('font.otf', ''), 'font/otf')
        self.assertEqual(normalize_font_mime('art.png', 'image/png'), 'image/png')

    def test_invalid_font_is_rejected(self):
        for signature in (b'OTTO', b'wOF2', b'wOFF', b'\x00\x01\x00\x00'):
            validate_font_bytes('font/ttf', signature)
        with self.assertRaises(UploadError):
            validate_font_bytes('font/ttf', b'not a font')


class FontTools(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.project = SimpleNamespace(content={'settings': {}, 'decks': [{
            'id': 'd', 'name': 'deck', 'frontLayout': {'elements': [{'id': 'title', 'kind': 'text'}, {'id': 'art', 'kind': 'image'}]},
            'backLayout': {'elements': [{'id': 'back', 'kind': 'text'}]}, 'cards': []}]})
        self.project_patch = patch.object(repo, 'get_project_or_404', AsyncMock(return_value=self.project))
        self.assets_patch = patch.object(repo, 'list_assets', AsyncMock(return_value=[{'id': 'uploaded', 'name': 'MyFont.ttf'}]))
        self.commit_patch = patch.object(repo, '_commit_project', AsyncMock())
        self.project_patch.start(); self.assets_patch.start(); self.commit = self.commit_patch.start()
        self.addCleanup(self.project_patch.stop); self.addCleanup(self.assets_patch.stop); self.addCleanup(self.commit_patch.stop)

    async def test_list_and_scoped_assignment(self):
        fonts = await repo.list_fonts(None, 'p')
        self.assertIn({'key': 'asset:uploaded', 'name': 'MyFont.ttf'}, fonts)
        result = await repo.set_font(None, 'p', 'asset:uploaded', deck_id='d', side='front', element_id='title', set_default=True)
        deck = self.project.content['decks'][0]
        self.assertEqual(result['updated'], 1)
        self.assertEqual(deck['frontLayout']['elements'][0]['fontFamily'], 'asset:uploaded')
        self.assertNotIn('fontFamily', deck['backLayout']['elements'][0])
        self.assertNotIn('fontFamily', deck['frontLayout']['elements'][1])
        self.assertEqual(self.project.content['settings']['defaultFont'], 'asset:uploaded')

    async def test_unknown_font_and_missing_scope_do_not_commit(self):
        with self.assertRaises(repo.GuardError):
            await repo.set_font(None, 'p', 'invented')
        with self.assertRaises(repo.GuardError):
            await repo.set_font(None, 'p', 'sans', element_id='title')
        self.commit.assert_not_awaited()

    async def test_whole_project_changes_only_text(self):
        result = await repo.set_font(None, 'p', 'serif')
        self.assertEqual(result['updated'], 2)
        self.assertEqual(self.project.content['decks'][0]['backLayout']['elements'][0]['fontFamily'], 'serif')


if __name__ == '__main__':
    unittest.main()
