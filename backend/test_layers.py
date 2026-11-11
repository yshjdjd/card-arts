import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.mcp.layers import apply_layers
from app.mcp import repository as repo


def fixture():
    return [{'id': 'bg'}, {'id': 'a', 'groupId': 'g'}, {'id': 'b', 'groupId': 'g'}, {'id': 'art'}]


class Layers(unittest.TestCase):
    def test_order_and_groups(self):
        original = fixture()
        ids = lambda rows: [e['id'] for e in rows]
        self.assertEqual(ids(apply_layers(original, 'front', ['a'])), ['bg', 'art', 'a', 'b'])
        self.assertEqual(ids(apply_layers(original, 'down', ['a'])), ['a', 'b', 'bg', 'art'])
        self.assertEqual(ids(apply_layers(original, 'above', ['bg'], target='art')), ['a', 'b', 'art', 'bg'])
        self.assertEqual(ids(original), ['bg', 'a', 'b', 'art'])

    def test_validation_and_locks(self):
        original = fixture()
        original[1]['locked'] = True
        for op, ids, kwargs in [('front', ['a'], {}), ('hide', ['missing'], {}), ('order', [], {'order': ['bg', 'bg']}), ('above', ['bg'], {'target': 'missing'})]:
            with self.assertRaises(ValueError):
                apply_layers(original, op, ids, **kwargs)
        changed = apply_layers(original, 'unlock', ['a'])
        self.assertFalse(changed[1]['locked'])
        hidden = apply_layers(changed, 'hide', ['a'])
        self.assertTrue(hidden[2]['hidden'])


class RepositoryLayers(unittest.IsolatedAsyncioTestCase):
    async def test_mcp_tools_registered(self):
        from app.mcp.server import build_server
        tools = await build_server().list_tools()
        names = {tool.name for tool in tools}
        self.assertIn('list_layers', names)
        self.assertIn('manage_layers', names)

    async def test_scope_revision_and_commit(self):
        p = SimpleNamespace(revision=5, content={'decks': [{'id': 'd', 'frontLayout': {'elements': fixture()}, 'backLayout': {'elements': [{'id': 'back'}]}}]})
        with patch.object(repo, 'get_project_or_404', AsyncMock(return_value=p)), patch.object(repo, '_commit_project', AsyncMock()) as commit:
            listing = await repo.list_layers(None, 'p', 'd', 'front')
            self.assertEqual(listing['layers'][0]['id'], 'art')
            with self.assertRaises(repo.GuardError):
                await repo.manage_layers(None, 'p', 'd', 'front', 'front', ['a'], expected_revision=4)
            with self.assertRaises(repo.GuardError):
                await repo.manage_layers(None, 'p', 'd', 'both', 'hide', ['a'])
            commit.assert_not_awaited()
            await repo.manage_layers(None, 'p', 'd', 'front', 'front', ['a'], expected_revision=5)
            commit.assert_awaited_once()
            self.assertEqual(p.content['decks'][0]['frontLayout']['elements'][-1]['id'], 'b')
            self.assertEqual(p.content['decks'][0]['backLayout']['elements'], [{'id': 'back'}])


if __name__ == '__main__':
    unittest.main()
